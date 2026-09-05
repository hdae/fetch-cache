import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  fetchHfFile,
  fetchHfFiles,
  hfResolveUrl,
  isCommitSha,
  prefetchHfFile,
  resolveHfRevision,
} from "./mod.ts";
import { listKeys } from "../mod.ts";
import { mockFetch } from "../testing/mock_fetch.ts";

// 名前空間は内部固定 1 個（cache 層と共通 — DECIDED: docs/decisions/0006 §3）。
const CACHE_NAME = "fetch-cache";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const MOVED = "89abcdef0123456789abcdef0123456789abcdef";
const REPO = "owner/name";
const BYTES = new Uint8Array([10, 20, 30, 40]);
const BYTES_2 = new Uint8Array([50, 60]);
const sha256HexOf = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
// BYTES の SHA-256（テスト起動時に一度だけ計算。ネットワークには出ない）。
const BYTES_SHA256 = await sha256HexOf(BYTES);
const BYTES_2_SHA256 = await sha256HexOf(BYTES_2);

/** cache 層の直列化形式（ゴールデン）。sha256 指定時の既定キーの実体を凍結する。 */
const keyUrl = (...elements: (string | number | boolean)[]): string =>
  "https://fetch-cache.invalid/v1/" +
  elements.map((element) => encodeURIComponent(JSON.stringify(element))).join(
    "/",
  );

/** sha256 指定時の既定キー ["hf", kind, repo, path, sha256] の直列化 URL。 */
const contentKeyUrl = (path: string, sha256: string): string =>
  keyUrl("hf", "model", REPO, path, sha256);

Deno.test("hfResolveUrl: kind ごとのパス接頭辞と revision/path を組み立てる", () => {
  assertEquals(
    hfResolveUrl({ repo: REPO, path: "model.onnx" }),
    "https://huggingface.co/owner/name/resolve/main/model.onnx",
  );
  assertEquals(
    hfResolveUrl({
      repo: REPO,
      kind: "dataset",
      revision: SHA,
      path: "a/b.bin",
    }),
    `https://huggingface.co/datasets/owner/name/resolve/${SHA}/a/b.bin`,
  );
  assertEquals(
    hfResolveUrl({
      repo: REPO,
      kind: "space",
      revision: "v1.0",
      path: "app.py",
    }),
    "https://huggingface.co/spaces/owner/name/resolve/v1.0/app.py",
  );
  assertEquals(
    hfResolveUrl({ repo: REPO, hubUrl: "https://mirror.example", path: "x" }),
    "https://mirror.example/owner/name/resolve/main/x",
  );
});

Deno.test("hfResolveUrl: revision は丸ごと・path はセグメント毎に percent-encode される", () => {
  // slash 入り ref（refs/pr/1 等）は %2F 必須（未エンコードだと HF は 404 を返す）。
  assertEquals(
    hfResolveUrl({ repo: REPO, revision: "refs/pr/1", path: "model.onnx" }),
    "https://huggingface.co/owner/name/resolve/refs%2Fpr%2F1/model.onnx",
  );
  // path の `/` は構造として保持、`#`/空白は %xx 化（fragment 落ちで別ファイルを取らない）。
  assertEquals(
    hfResolveUrl({ repo: REPO, path: "sub dir/a#b.bin" }),
    "https://huggingface.co/owner/name/resolve/main/sub%20dir/a%23b.bin",
  );
});

Deno.test("hfResolveUrl / resolveHfRevision: hubUrl の末尾スラッシュは吸収される", async () => {
  // 生連結だと `https://mirror.example/` の自然な指定が `//owner/...` になり、404 や
  // （sha256 無しの）別 URL キー重複保存を生む。
  assertEquals(
    hfResolveUrl({ repo: REPO, hubUrl: "https://mirror.example/", path: "x" }),
    "https://mirror.example/owner/name/resolve/main/x",
  );
  const { fetch, calls } = mockFetch(() => Response.json({ sha: SHA }));
  await resolveHfRevision({ repo: REPO, hubUrl: "https://mirror.example//" }, {
    fetch,
  });
  assertEquals(calls, [
    "https://mirror.example/api/models/owner/name/revision/main",
  ]);
});

Deno.test("isCommitSha: 40桁小文字 hex のみ true", () => {
  assertEquals(isCommitSha(SHA), true);
  assertEquals(isCommitSha("main"), false);
  assertEquals(isCommitSha(SHA.slice(0, 7)), false); // 短縮 SHA は可変扱い。
  assertEquals(isCommitSha(SHA.toUpperCase()), false);
  assertEquals(isCommitSha(`${SHA}0`), false);
});

Deno.test("resolveHfRevision: 可変 ref を API の sha へ解決する", async () => {
  const { fetch, calls } = mockFetch(() => Response.json({ sha: SHA }));
  const resolved = await resolveHfRevision({ repo: REPO }, { fetch });
  assertEquals(resolved, SHA);
  assertEquals(calls, [
    "https://huggingface.co/api/models/owner/name/revision/main",
  ]);
});

Deno.test("resolveHfRevision: kind で API セグメントが変わる", async () => {
  const { fetch, calls } = mockFetch(() => Response.json({ sha: SHA }));
  await resolveHfRevision({ repo: REPO, kind: "dataset", revision: "dev" }, {
    fetch,
  });
  assertEquals(calls, [
    "https://huggingface.co/api/datasets/owner/name/revision/dev",
  ]);
});

Deno.test("resolveHfRevision: slash 入り ref は encode されて API に渡る", async () => {
  const { fetch, calls } = mockFetch(() => Response.json({ sha: SHA }));
  await resolveHfRevision({ repo: REPO, revision: "refs/pr/1" }, { fetch });
  assertEquals(calls, [
    "https://huggingface.co/api/models/owner/name/revision/refs%2Fpr%2F1",
  ]);
});

Deno.test("resolveHfRevision: SHA passthrough はネットワークに出ない", async () => {
  const { fetch, calls } = mockFetch(() => Response.json({ sha: "unused" }));
  const resolved = await resolveHfRevision({ repo: REPO, revision: SHA }, {
    fetch,
  });
  assertEquals(resolved, SHA);
  assertEquals(calls.length, 0);
});

Deno.test("resolveHfRevision: 応答に sha が無ければ throw する", async () => {
  const { fetch } = mockFetch(() => Response.json({ siblings: [] }));
  const error = await assertRejects(
    () => resolveHfRevision({ repo: REPO }, { fetch }),
    Error,
  );
  assertStringIncludes(error.message, "sha が無い");
});

Deno.test("resolveHfRevision: HTTP エラーは status 入りメッセージで throw する", async () => {
  const { fetch } = mockFetch(() =>
    new Response("missing", { status: 404, statusText: "Not Found" })
  );
  const error = await assertRejects(
    () => resolveHfRevision({ repo: REPO }, { fetch }),
    Error,
  );
  assertStringIncludes(error.message, "fetch-cache: HTTP 404 Not Found");
  assertStringIncludes(error.message, "/api/models/owner/name/revision/main");
});

Deno.test("resolveHfRevision: HTTP エラー時は body を cancel して接続リソースを解放する", async () => {
  let response: Response | undefined;
  const { fetch } = mockFetch(() => {
    response = new Response("x", {
      status: 500,
      statusText: "Internal Server Error",
    });
    return response;
  });
  await assertRejects(
    () => resolveHfRevision({ repo: REPO }, { fetch }),
    Error,
  );
  assertEquals(response?.bodyUsed, true); // cancel 済み＝disturbed。
});

Deno.test("fetchHfFile: 可変 ref は解決 1 回 → SHA 固定 URL で取得する", async () => {
  const { fetch, calls } = mockFetch((url) =>
    url.includes("/api/") ? Response.json({ sha: SHA }) : new Response(BYTES)
  );
  try {
    const bytes = await fetchHfFile({ repo: REPO }, "a.bin", { fetch });
    assertEquals(bytes, BYTES);
    assertEquals(calls, [
      "https://huggingface.co/api/models/owner/name/revision/main",
      `https://huggingface.co/owner/name/resolve/${SHA}/a.bin`,
    ]);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: sha256 無しの既定キーは SHA 固定 resolve URL（従来どおり）", async () => {
  const url = `https://huggingface.co/owner/name/resolve/${SHA}/a.bin`;
  const { fetch } = mockFetch(() => new Response(BYTES));
  try {
    await fetchHfFile({ repo: REPO, revision: SHA }, "a.bin", { fetch });
    const cache = await caches.open(CACHE_NAME);
    assertExists(await cache.match(url)); // 鮮度シグナルが無い以上 revision 入りキーに倒す。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: init は revision 解決とファイル取得の両方へ渡る", async () => {
  const { fetch, calls, inits } = mockFetch((url) =>
    url.includes("/api/") ? Response.json({ sha: SHA }) : new Response(BYTES)
  );
  try {
    await fetchHfFile({ repo: REPO }, "a.bin", {
      fetch,
      init: { headers: { authorization: "Bearer hf_token" } },
    });
    assertEquals(calls.length, 2); // 解決 1 + 取得 1。
    for (const init of inits) {
      assertEquals(
        new Headers(init?.headers).get("authorization"),
        "Bearer hf_token",
      );
    }
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: ファイル取得の 404 は fail-loud に伝播する", async () => {
  const { fetch } = mockFetch((url) =>
    url.includes("/api/")
      ? Response.json({ sha: SHA })
      : new Response("missing", { status: 404, statusText: "Not Found" })
  );
  try {
    const error = await assertRejects(
      () => fetchHfFile({ repo: REPO }, "missing.bin", { fetch }),
      Error,
    );
    assertStringIncludes(error.message, "HTTP 404");
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: sha256 一致で取得され、既定キーは内容キー（revision 非依存）になる", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  try {
    const bytes = await fetchHfFile(
      { repo: REPO, revision: SHA },
      { path: "model.onnx", sha256: BYTES_SHA256 },
      { fetch },
    );
    assertEquals(bytes, BYTES);
    assertEquals(calls, [
      `https://huggingface.co/owner/name/resolve/${SHA}/model.onnx`,
    ]);

    // 格納は内容キー ["hf", kind, repo, path, sha256] 側（resolve URL 側ではない）。
    const cache = await caches.open(CACHE_NAME);
    assertExists(await cache.match(contentKeyUrl("model.onnx", BYTES_SHA256)));
    assertEquals(
      await cache.match(
        `https://huggingface.co/owner/name/resolve/${SHA}/model.onnx`,
      ),
      undefined,
    );

    // 2回目はキャッシュヒット（SHA 固定 URL なので解決リクエストも出ない）。
    await fetchHfFile(
      { repo: REPO, revision: SHA },
      { path: "model.onnx", sha256: BYTES_SHA256 },
      { fetch },
    );
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: revision が動いてもバイト不変なら内容キーでヒットする（再ダウンロードしない）", async () => {
  // README 更新だけで revision が動くケース: sha256 が同じ = 同じ内容キー = ヒット。
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  const spec = { path: "model.onnx", sha256: BYTES_SHA256 };
  try {
    await fetchHfFile({ repo: REPO, revision: SHA }, spec, { fetch });
    assertEquals(calls.length, 1);

    const again = await fetchHfFile({ repo: REPO, revision: MOVED }, spec, {
      fetch,
    });
    assertEquals(again, BYTES);
    assertEquals(calls.length, 1); // 別 revision の URL でも network に出ない。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: revision 切り替えで内容が違えば別エントリとして共存する（ピンポンしない）", async () => {
  const urlOf = (revision: string) =>
    `https://huggingface.co/owner/name/resolve/${revision}/model.onnx`;
  const { fetch, calls } = mockFetch((url) =>
    new Response(url === urlOf(SHA) ? BYTES : BYTES_2)
  );
  try {
    const specA = { path: "model.onnx", sha256: BYTES_SHA256 };
    const specB = { path: "model.onnx", sha256: BYTES_2_SHA256 };
    await fetchHfFile({ repo: REPO, revision: SHA }, specA, { fetch });
    await fetchHfFile({ repo: REPO, revision: MOVED }, specB, { fetch });
    assertEquals(calls.length, 2); // 内容が違うので取得は 2 回。

    // 行き来してもヒットのまま（内容毎にエントリが共存 = 既定キーに sha256 が入るため）。
    assertEquals(
      await fetchHfFile({ repo: REPO, revision: SHA }, specA, { fetch }),
      BYTES,
    );
    assertEquals(
      await fetchHfFile({ repo: REPO, revision: MOVED }, specB, { fetch }),
      BYTES_2,
    );
    assertEquals(calls.length, 2);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: hubUrl はキーに含まれない（ミラー跨ぎで同一内容がヒットする）", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  const spec = { path: "model.onnx", sha256: BYTES_SHA256 };
  try {
    await fetchHfFile(
      { repo: REPO, revision: SHA, hubUrl: "https://mirror.example" },
      spec,
      { fetch },
    );
    assertEquals(calls, [
      `https://mirror.example/${REPO}/resolve/${SHA}/model.onnx`,
    ]);

    // 本家 hub からの読み出しでも同一の内容キー = ヒット（content-addressed の意図どおり
    // ミラーを跨いで共有する — ADR 0006 §4）。
    assertEquals(
      await fetchHfFile({ repo: REPO, revision: SHA }, spec, { fetch }),
      BYTES,
    );
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: kind はキーに含まれる（model と dataset は同一 repo/path/sha256 でも別エントリ）", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  const spec = { path: "model.onnx", sha256: BYTES_SHA256 };
  try {
    await fetchHfFile({ repo: REPO, revision: SHA, kind: "dataset" }, spec, {
      fetch,
    });
    const cache = await caches.open(CACHE_NAME);
    assertExists(
      await cache.match(
        keyUrl("hf", "dataset", REPO, "model.onnx", BYTES_SHA256),
      ),
    );

    // kind 違いは衝突しない = 別エントリとして network に出る（contentKeyUrl ヘルパは
    // "model" 固定なので、kind を落とす実装退行はこの対で検出する）。
    await fetchHfFile({ repo: REPO, revision: SHA }, spec, { fetch });
    assertEquals(calls.length, 2);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: 破損キャッシュは sha256 で検知され再取得される（self-heal）", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  try {
    // 壊れたバイト列を内容キーへ直接仕込む（fault injection。記録ヘッダ無し = 実ハッシュ突合）。
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      contentKeyUrl("model.onnx", BYTES_SHA256),
      new Response(new Uint8Array([9, 9])),
    );

    const bytes = await fetchHfFile(
      { repo: REPO, revision: SHA },
      { path: "model.onnx", sha256: BYTES_SHA256 },
      { fetch },
    );
    assertEquals(bytes, BYTES);
    assertEquals(calls.length, 1); // evict → network 1 回。

    // キャッシュは正しい内容に置換済み（再呼び出しで network 0 回）。
    await fetchHfFile(
      { repo: REPO, revision: SHA },
      { path: "model.onnx", sha256: BYTES_SHA256 },
      { fetch },
    );
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: sha256 不一致は throw し、キャッシュしない", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES));
  const wrongSha = "0".repeat(64);
  try {
    const error = await assertRejects(
      () =>
        fetchHfFile(
          { repo: REPO, revision: SHA },
          { path: "model.onnx", sha256: wrongSha },
          { fetch },
        ),
      Error,
    );
    assertStringIncludes(error.message, "SHA-256 不一致");

    const cache = await caches.open(CACHE_NAME);
    assertEquals(
      await cache.match(contentKeyUrl("model.onnx", wrongSha)),
      undefined,
    );
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: expectedBytes 不一致は throw する", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES));
  try {
    const error = await assertRejects(
      () =>
        fetchHfFile(
          { repo: REPO, revision: SHA },
          { path: "model.onnx", expectedBytes: BYTES.length + 1 },
          { fetch },
        ),
      Error,
    );
    assertStringIncludes(error.message, "バイト数不一致");
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFiles: revision API は 1 回だけ・並列結果が名前にマップされる", async () => {
  const bytesA = new Uint8Array([1, 1, 1]);
  const bytesB = new Uint8Array([2, 2]);
  const { fetch, calls } = mockFetch((url) => {
    if (url === "https://huggingface.co/api/models/owner/name/revision/main") {
      return Response.json({ sha: SHA });
    }
    if (url.endsWith("/a.bin")) return new Response(bytesA);
    if (url.endsWith("/sub/b.bin")) return new Response(bytesB);
    return new Response("missing", { status: 404, statusText: "Not Found" });
  });
  try {
    const files = await fetchHfFiles(
      { repo: REPO }, // revision 省略 = "main"（可変 ref → 解決が走る）。
      { a: "a.bin", b: { path: "sub/b.bin", expectedBytes: 2 } },
      { fetch },
    );
    assertEquals(files.a, bytesA);
    assertEquals(files.b, bytesB);

    const apiCalls = calls.filter((url) => url.includes("/api/"));
    assertEquals(apiCalls.length, 1); // 解決は 1 回だけ。
    assertEquals(calls.length, 3); // 解決 1 + ファイル 2。
    assertEquals(
      calls.filter((url) => url.includes(`/resolve/${SHA}/`)).length,
      2, // 取得は解決済み SHA 固定 URL で行われる。
    );
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFiles: 1 ファイルの失敗で全体が reject し、成功分のキャッシュは残る", async () => {
  const bytesA = new Uint8Array([1, 1, 1]);
  const urlA = `https://huggingface.co/owner/name/resolve/${SHA}/a.bin`;
  // b の 404 は「a がキャッシュ済み」になるまで遅延させ、全体 reject 時点の
  // キャッシュ状態を決定的にする（Promise.all は成功分の put を取り消さない）。
  const awaitACached = async (): Promise<void> => {
    const cache = await caches.open(CACHE_NAME);
    // MUST: 同期待ちポーリングには deadline を置く — 固定名前空間は全テストで共有される
    // ため、並列実行で他ファイルの caches.delete が割り込むと期限なしループは「赤」では
    // なく無限ハングになる（ADR 0008。正常時の実測待ちは 1 ループ程度なので 2 秒で十分）。
    const deadline = performance.now() + 2000;
    while ((await cache.match(urlA)) === undefined) {
      if (performance.now() > deadline) {
        throw new Error(
          "a.bin が期限内にキャッシュされない（逐次実行の前提が崩れている — --parallel 実行の疑い）",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  const { fetch, calls } = mockFetch(async (url) => {
    if (url.includes("/api/")) return Response.json({ sha: SHA });
    if (url.endsWith("/a.bin")) return new Response(bytesA);
    await awaitACached();
    return new Response("missing", { status: 404, statusText: "Not Found" });
  });
  try {
    const error = await assertRejects(
      () =>
        fetchHfFiles(
          { repo: REPO },
          { a: "a.bin", b: "missing.bin" },
          { fetch },
        ),
      Error,
    );
    assertStringIncludes(error.message, "HTTP 404");

    // 成功済み a のキャッシュ副作用は取り消されない＝リトライは即ヒット（README 記載の仕様）。
    const callsBefore = calls.length;
    const again = await fetchHfFile({ repo: REPO, revision: SHA }, "a.bin", {
      fetch,
    });
    assertEquals(again, bytesA);
    assertEquals(calls.length, callsBefore); // network 0 回。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: decode は利用形を返し、cache は保存形 raw のまま（sha256 は raw に照合）", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  const spec = {
    path: "dict.gz",
    sha256: BYTES_SHA256, // 保存形 raw のハッシュ（Hub の LFS メタデータ相当）。
    decode: (raw: Uint8Array) => new Uint8Array([raw.length]),
  };
  try {
    const first = await fetchHfFile({ repo: REPO, revision: SHA }, spec, {
      fetch,
    });
    assertEquals(first, new Uint8Array([4])); // 戻り値は decode 適用後の利用形。

    // cache に入るのは sha256 の照合対象と同じ保存形 raw（内容キー側）。
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(
      contentKeyUrl("dict.gz", BYTES_SHA256),
    );
    assertExists(cachedResponse);
    assertEquals(new Uint8Array(await cachedResponse.arrayBuffer()), BYTES);

    // ヒット側も sha256（raw）→ decode の同じ経路で network 0 回。
    const second = await fetchHfFile({ repo: REPO, revision: SHA }, spec, {
      fetch,
    });
    assertEquals(second, new Uint8Array([4]));
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: カスタム validate は保存形 raw を受け、throw は不正扱いでキャッシュしない", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES));
  const seen: Uint8Array[] = [];
  try {
    const bytes = await fetchHfFile(
      { repo: REPO, revision: SHA },
      {
        path: "a.bin",
        validate: (raw) => {
          seen.push(raw.slice());
        },
        decode: (raw) => new Uint8Array([raw.length]),
      },
      { fetch },
    );
    assertEquals(bytes, new Uint8Array([4]));
    assertEquals(seen, [BYTES]); // decode 前の raw を受ける。

    await assertRejects(
      () =>
        fetchHfFile(
          { repo: REPO, revision: SHA },
          {
            path: "b.bin",
            validate: () => {
              throw new Error("magic 不一致");
            },
          },
          { fetch },
        ),
      Error,
      "magic 不一致",
    );
    const cache = await caches.open(CACHE_NAME);
    assertEquals(
      await cache.match(
        `https://huggingface.co/owner/name/resolve/${SHA}/b.bin`,
      ),
      undefined, // 不正物は保存されない（cache 層の契約が HF 層でも生きる）。
    );
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: built-in 検証（expectedBytes）が落ちたらカスタム validate は走らない", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES));
  let customCalled = false;
  try {
    const error = await assertRejects(
      () =>
        fetchHfFile(
          { repo: REPO, revision: SHA },
          {
            path: "a.bin",
            expectedBytes: BYTES.length + 1,
            validate: () => {
              customCalled = true;
            },
          },
          { fetch },
        ),
      Error,
    );
    assertStringIncludes(error.message, "バイト数不一致");
    assertEquals(customCalled, false); // 安価な built-in が先に落ちる（合成順の凍結）。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFiles: decode はファイル毎に独立して適用される", async () => {
  const dictBytes = new Uint8Array([5, 5, 5]);
  const metaBytes = new Uint8Array([7, 7]);
  const { fetch } = mockFetch((url) => {
    if (url.includes("/api/")) return Response.json({ sha: SHA });
    if (url.endsWith("/dict.gz")) return new Response(dictBytes);
    if (url.endsWith("/meta.json")) return new Response(metaBytes);
    return new Response("missing", { status: 404, statusText: "Not Found" });
  });
  try {
    const files = await fetchHfFiles(
      { repo: REPO },
      {
        dict: {
          path: "dict.gz",
          decode: (raw) => new Uint8Array([raw.length]),
        },
        meta: "meta.json",
      },
      { fetch },
    );
    assertEquals(files.dict, new Uint8Array([3])); // decode 指定ファイルだけ利用形。
    assertEquals(files.meta, metaBytes); // 指定なしは raw のまま（従来互換）。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFiles: onProgress に path が付く", async () => {
  const { fetch } = mockFetch((url) =>
    url.includes("/api/") ? Response.json({ sha: SHA }) : new Response(BYTES)
  );
  const paths = new Set<string>();
  try {
    await fetchHfFiles(
      { repo: REPO },
      { a: "a.bin", b: "b.bin" },
      {
        fetch,
        onProgress: (progress) => paths.add(progress.path),
      },
    );
    assertEquals(paths, new Set(["a.bin", "b.bin"]));
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

// --- 記録ハッシュ（既定 = ローカル格納を信頼）と recheck ---

/**
 * `crypto.subtle.digest` を差し替えて「何回・何が渡ったか」を観測する。既定 trust の
 * 「ヒットでは再ハッシュしない」は外形からは見えないため、ここで凍結する。
 */
const spyDigest = (): {
  args: unknown[];
  restore: () => void;
} => {
  const original = crypto.subtle.digest;
  const args: unknown[] = [];
  const patched: typeof crypto.subtle.digest = (algorithm, data) => {
    args.push(data);
    return original.call(crypto.subtle, algorithm, data);
  };
  crypto.subtle.digest = patched;
  return {
    args,
    restore: () => {
      crypto.subtle.digest = original;
    },
  };
};

Deno.test("sha256 検証: digest には validate が受け取った view がそのまま渡る（コピーしない）", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES));
  const seenByValidate: Uint8Array[] = [];
  const digest = spyDigest();
  try {
    await fetchHfFile(
      { repo: REPO, revision: SHA },
      {
        path: "model.onnx",
        sha256: BYTES_SHA256,
        // built-in（sha256）と同じ raw を受け取るカスタム validate で、実体の同一性を観測する。
        validate: (bytes) => {
          seenByValidate.push(bytes);
        },
      },
      { fetch },
    );
    assertEquals(digest.args.length, 1);
    // コピーしていれば別インスタンスになる（tight view はそのまま渡すのが仕様）。
    assertEquals(digest.args[0] === seenByValidate[0], true);
  } finally {
    digest.restore();
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("既定: 記録一致のヒットでは再ハッシュしない（ハッシュは保存時の 1 回だけ）", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  const spec = { path: "model.onnx", sha256: BYTES_SHA256 };
  const digest = spyDigest();
  try {
    await fetchHfFile({ repo: REPO, revision: SHA }, spec, { fetch });
    await fetchHfFile({ repo: REPO, revision: SHA }, spec, { fetch });
    assertEquals(calls.length, 1); // 2 回目はキャッシュヒット。
    assertEquals(digest.args.length, 1); // ローカル格納を信頼（DECIDED: docs/decisions/0006 §2）。
  } finally {
    digest.restore();
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("recheck: true ならヒット時に実バイトを再ハッシュして突合する（opt-out）", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  const spec = { path: "model.onnx", sha256: BYTES_SHA256 };
  const digest = spyDigest();
  try {
    await fetchHfFile({ repo: REPO, revision: SHA }, spec, { fetch });
    await fetchHfFile({ repo: REPO, revision: SHA }, spec, {
      fetch,
      recheck: true,
    });
    assertEquals(calls.length, 1);
    assertEquals(digest.args.length, 2); // 保存時 1 + recheck ヒット 1。
  } finally {
    digest.restore();
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("recheck: sha256 の無いファイルには影響しない（単独指定 throw を HF 層が回避する）", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES));
  try {
    // cache 層は recheck 単独指定を throw で弾くが、HF 層は sha256 の無い spec には
    // recheck を渡さないので普通に取得できる。
    const bytes = await fetchHfFile({ repo: REPO, revision: SHA }, "a.bin", {
      fetch,
      recheck: true,
    });
    assertEquals(bytes, BYTES);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("HfFileSpec.expectedBytes は受信バッファの確保ヒントとして cache 層へ流れる", async () => {
  // 同一インスタンスを 2 回 enqueue し、間で書き換える。事前確保経路なら読み取り時に
  // 即コピーされるので内容が保たれる（cache 層のテストと同じ観測手法）。
  let controller!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(c) {
      controller = c;
    },
  });
  const { fetch } = mockFetch(() => new Response(stream)); // content-length なし。
  const reused = new Uint8Array([1, 2, 3]);
  const firstChunk = Promise.withResolvers<void>();
  try {
    const promise = fetchHfFile(
      { repo: REPO, revision: SHA },
      { path: "model.onnx", expectedBytes: 6 },
      { fetch, onProgress: () => firstChunk.resolve() },
    );
    controller.enqueue(reused);
    await firstChunk.promise;
    reused.set([4, 5, 6]);
    controller.enqueue(reused);
    controller.close();
    assertEquals(await promise, new Uint8Array([1, 2, 3, 4, 5, 6]));
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("HfFileSpec.into は cache 層へ流れ、network もキャッシュヒットも器の prefix view を返す", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  const into = new Uint8Array(new ArrayBuffer(16)).fill(0xff);
  const spec = {
    path: "model.onnx",
    sha256: BYTES_SHA256,
    expectedBytes: BYTES.length,
    into,
  };
  try {
    const fromNetwork = await fetchHfFile({ repo: REPO, revision: SHA }, spec, {
      fetch,
    });
    assertStrictEquals(fromNetwork.buffer, into.buffer);
    assertEquals(fromNetwork, BYTES);
    assertEquals(into[BYTES.length], 0xff, "実長の外へ書いている");
    assertEquals(calls.length, 1);

    into.fill(0);
    const fromCache = await fetchHfFile({ repo: REPO, revision: SHA }, spec, {
      fetch,
    });
    assertStrictEquals(fromCache.buffer, into.buffer);
    assertEquals(fromCache, BYTES);
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

// --- prefetchHfFile（streaming prefetch + 通過中 sha256 検証） ---

Deno.test("prefetchHfFile: 可変 ref を解決 1 回 → SHA 固定 URL で温め、以後の取得はヒットする", async () => {
  const { fetch, calls } = mockFetch((url) =>
    url.includes("/api/")
      ? new Response(JSON.stringify({ sha: SHA }))
      : new Response(BYTES)
  );
  try {
    assertEquals(
      await prefetchHfFile({ repo: REPO }, "model.onnx", { fetch }),
      {
        fetched: true,
        revision: SHA,
        url: `https://huggingface.co/${REPO}/resolve/${SHA}/model.onnx`,
      },
    );
    assertEquals(calls, [
      `https://huggingface.co/api/models/${REPO}/revision/main`,
      `https://huggingface.co/${REPO}/resolve/${SHA}/model.onnx`,
    ]);

    // 温めたエントリは SHA 固定 URL のヒットになる（revision 解決の 1 回だけ増える）。
    assertEquals(
      await fetchHfFile({ repo: REPO, revision: SHA }, "model.onnx", { fetch }),
      BYTES,
    );
    assertEquals(calls.length, 2);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchHfFile: 戻り値の revision / url が温めたエントリを指し、渡し回せば upstream が動いてもヒットする", async () => {
  // 温めた後に upstream が動くリポジトリ（可変 ref のまま読むと別 SHA を引く状況）。
  let head = SHA;
  const { fetch, calls } = mockFetch((url) =>
    url.includes("/api/")
      ? new Response(JSON.stringify({ sha: head }))
      : new Response(BYTES)
  );
  try {
    const result = await prefetchHfFile({ repo: REPO }, "model.onnx", {
      fetch,
    });
    // 可変 ref を渡しても、どの SHA を温めたかが戻り値で分かる。
    assertEquals(result.revision, SHA);
    // sha256 無しでは url が温めたエントリのキャッシュキーそのもの。
    const cache = await caches.open(CACHE_NAME);
    assertExists(await cache.match(result.url));

    head = MOVED;
    const warmed = calls.length;
    // 戻り値の revision を渡し回せば、upstream が動いてもヒットのまま（network に出ない）。
    assertEquals(
      await fetchHfFile(
        { repo: REPO, revision: result.revision },
        "model.onnx",
        { fetch },
      ),
      BYTES,
    );
    assertEquals(calls.length, warmed);

    // 対比: 可変 ref のまま読むと動いた先の SHA を引き、温めたエントリは丸ごとミスする
    // （sha256 が無い = revision 入りキーの宿命。内容キーにしたければ sha256 を渡す）。
    await fetchHfFile({ repo: REPO }, "model.onnx", { fetch });
    assertEquals(calls.length, warmed + 2); // revision 解決 + ファイル取得。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchHfFile: spec.sha256 で内容キーに温まり、読み出しと無ハッシュで噛み合う", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  const spec = { path: "model.onnx", sha256: BYTES_SHA256 };
  const digest = spyDigest();
  try {
    assertEquals(
      await prefetchHfFile({ repo: REPO, revision: SHA }, spec, { fetch }),
      {
        fetched: true,
        revision: SHA,
        url: `https://huggingface.co/${REPO}/resolve/${SHA}/model.onnx`,
      },
    );
    // prefetch 側は純 TS の逐次ハッシュ（native の一括 digest は使わない）。
    assertEquals(digest.args.length, 0);
    // 格納は fetchHfFile と同じ既定キー式 = 内容キー側（噛み合わせが構造的に保証される）。
    const cache = await caches.open(CACHE_NAME);
    assertExists(await cache.match(contentKeyUrl("model.onnx", BYTES_SHA256)));

    assertEquals(
      await fetchHfFile({ repo: REPO, revision: SHA }, spec, { fetch }),
      BYTES,
    );
    assertEquals(calls.length, 1); // ヒット。
    assertEquals(digest.args.length, 0); // 記録一致 = 再ハッシュしない（温める→読むの全経路で 0 回）。

    // revision が動いても内容キーなのでヒットのまま。
    assertEquals(
      await fetchHfFile({ repo: REPO, revision: MOVED }, spec, { fetch }),
      BYTES,
    );
    assertEquals(calls.length, 1);
  } finally {
    digest.restore();
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchHfFile: sha256 不一致は throw し、エントリを残さない", async () => {
  const wrong = "a".repeat(64);
  const { fetch } = mockFetch(() => new Response(BYTES));
  try {
    const error = await assertRejects(
      () =>
        prefetchHfFile(
          { repo: REPO, revision: SHA },
          { path: "model.onnx", sha256: wrong },
          { fetch },
        ),
      Error,
    );
    assertStringIncludes(error.message, "SHA-256 不一致");
    assertStringIncludes(error.message, BYTES_SHA256);

    const cache = await caches.open(CACHE_NAME);
    assertEquals(
      await cache.match(contentKeyUrl("model.onnx", wrong)),
      undefined,
    );
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchHfFile: 既にエントリがあれば network に出ず false を返す", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  try {
    await fetchHfFile({ repo: REPO, revision: SHA }, "model.onnx", { fetch });
    assertEquals(calls.length, 1);
    assertEquals(
      await prefetchHfFile({ repo: REPO, revision: SHA }, "model.onnx", {
        fetch,
      }),
      {
        fetched: false,
        revision: SHA,
        url: `https://huggingface.co/${REPO}/resolve/${SHA}/model.onnx`,
      },
    );
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

// --- sha256 の形式ガード（全入口の正規化点 toSpec） ---

Deno.test("fetchHfFile: 形式不正の sha256 は network に出る前に fail loud", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  const error = await assertRejects(
    () =>
      fetchHfFile(
        { repo: REPO, revision: SHA },
        // 大文字 hex は sha256 hex の出力（常に小文字）と必ず食い違う = 成立し得ない申告。
        { path: "model.onnx", sha256: BYTES_SHA256.toUpperCase() },
        { fetch },
      ),
    Error,
  );
  assertStringIncludes(error.message, "64 桁の小文字 hex");
  assertStringIncludes(error.message, "model.onnx");
  // 全量ダウンロードしてから落とすと呼び出し毎に帯域を捨てることになる。
  assertEquals(calls.length, 0);
});

Deno.test("prefetchHfFile: 形式不正の sha256 は network に出る前に fail loud", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  const error = await assertRejects(
    () =>
      prefetchHfFile(
        { repo: REPO, revision: SHA },
        { path: "model.onnx", sha256: BYTES_SHA256.toUpperCase() },
        { fetch },
      ),
    Error,
  );
  assertStringIncludes(error.message, "64 桁の小文字 hex");
  assertStringIncludes(error.message, "model.onnx");
  assertEquals(calls.length, 0);
});

Deno.test("fetchHfFile / prefetchHfFile: 形式不正の sha256 は可変 ref の解決 API にも出ない", async () => {
  // 固定 SHA だと解決が元々走らず順序の欠陥を検出できない — 可変 ref が唯一の判別点。
  const { fetch, calls } = mockFetch(() => Response.json({ sha: SHA }));
  await assertRejects(
    () =>
      fetchHfFile({ repo: REPO }, { path: "a.bin", sha256: "xyz" }, { fetch }),
    Error,
    "64 桁の小文字 hex",
  );
  await assertRejects(
    () =>
      prefetchHfFile({ repo: REPO }, { path: "a.bin", sha256: "xyz" }, {
        fetch,
      }),
    Error,
    "64 桁の小文字 hex",
  );
  assertEquals(calls.length, 0); // spec 検査が解決より先（fail loud は network 0 回で）。
});

Deno.test("fetchHfFiles: 1 つでも形式不正の spec があれば解決にも兄弟ファイル取得にも出ない", async () => {
  const { fetch, calls } = mockFetch((url) =>
    url.includes("/api/") ? Response.json({ sha: SHA }) : new Response(BYTES)
  );
  await assertRejects(
    () =>
      fetchHfFiles(
        { repo: REPO },
        { good: "a.bin", bad: { path: "b.bin", sha256: "not-hex" } },
        { fetch },
      ),
    Error,
    "64 桁の小文字 hex",
  );
  assertEquals(calls.length, 0); // 正常な兄弟ファイル（good）の取得も始まらない。
});

Deno.test("fetchHfFile / fetchHfFiles: into の容量を超える expectedBytes は可変 ref の解決 API にも出ない", async () => {
  // 固定 SHA だと解決が元々走らず順序の欠陥を検出できない — 可変 ref が唯一の判別点。
  const { fetch, calls } = mockFetch((url) =>
    url.includes("/api/") ? Response.json({ sha: SHA }) : new Response(BYTES)
  );
  const into = new Uint8Array(new ArrayBuffer(2)).fill(0xff);
  const error = await assertRejects(
    () =>
      fetchHfFile(
        { repo: REPO },
        { path: "model.onnx", expectedBytes: BYTES.length, into },
        { fetch },
      ),
    Error,
  );
  assertStringIncludes(error.message, "into の容量 2 バイト");
  assertStringIncludes(error.message, `expectedBytes ${BYTES.length} バイト`);
  assertStringIncludes(error.message, "model.onnx");

  await assertRejects(
    () =>
      fetchHfFiles(
        { repo: REPO },
        {
          good: "a.bin",
          bad: { path: "b.bin", expectedBytes: BYTES.length, into },
        },
        { fetch },
      ),
    Error,
    "into の容量 2 バイト",
  );
  // 解決 API にも、正常な兄弟ファイル（good）の取得にも出ない。
  assertEquals(calls.length, 0);
  assertEquals(
    into,
    new Uint8Array(new ArrayBuffer(2)).fill(0xff),
    "落ちた申告で器を書き換えている",
  );
});

Deno.test("prefetchHfFile: spec.into は見ない（器は無傷のまま温まる）", async () => {
  // prefetch はバイト列を手元に持たない（streaming put）ので into は使えない。型としては
  // 同じ HfFileSpec が通るため、誤って転送すると器に何が書かれるか未定義のまま緑になる。
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  const into = new Uint8Array(new ArrayBuffer(16)).fill(0xff);
  const spec = { path: "model.onnx", sha256: BYTES_SHA256, into };
  try {
    const result = await prefetchHfFile({ repo: REPO, revision: SHA }, spec, {
      fetch,
    });
    assertEquals(result.fetched, true);
    assertEquals(
      into,
      new Uint8Array(new ArrayBuffer(16)).fill(0xff),
      "prefetch が器を書き換えている",
    );

    // 対照: 同じ spec でも fetchHfFile 側では器へ流れる（無視するのは prefetch だけ）。
    const bytes = await fetchHfFile({ repo: REPO, revision: SHA }, spec, {
      fetch,
    });
    assertStrictEquals(bytes.buffer, into.buffer);
    assertEquals(bytes.byteOffset, 0);
    assertEquals(bytes, BYTES);
    assertEquals(calls.length, 1); // 温めたエントリへのヒット。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchHfFile: onProgress には path が付き、init は解決と取得の両方へ渡る", async () => {
  const { fetch, calls, inits } = mockFetch((url) =>
    url.includes("/api/")
      ? new Response(JSON.stringify({ sha: SHA }))
      : new Response(BYTES)
  );
  const init = { headers: { authorization: "Bearer token" } };
  const events: { path: string; loaded: number }[] = [];
  try {
    await prefetchHfFile({ repo: REPO }, "model.onnx", {
      fetch,
      init,
      onProgress: ({ path, loaded }) => events.push({ path, loaded }),
    });
    assertEquals(events, [{ path: "model.onnx", loaded: BYTES.length }]);
    assertEquals(calls.length, 2);
    assertEquals(inits[0], init);
    assertEquals(inits[1], init);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

// --- HF 層の受信バイト上限（expectedBytes を超えた時点で打ち切る — ADR 0011） ---

/**
 * 要求されたぶんだけ 1 チャンク供給する Response（highWaterMark 0 = 先読みしない）。
 * 供給数のカウンタで「受信が途中で打ち切られたか」を観測する。
 */
const lazyChunks = (
  chunks: readonly Uint8Array<ArrayBuffer>[],
): { response: Response; supplied: () => number } => {
  let index = 0;
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
  }, { highWaterMark: 0 });
  return { response: new Response(stream), supplied: () => index };
};

const FOUR = (): Uint8Array<ArrayBuffer> => new Uint8Array([9, 9, 9, 9]);

Deno.test("fetchHfFile: 受信が expectedBytes を超えたら残りを読まずに throw し、キャッシュしない", async () => {
  let supplied = (): number => 0;
  const { fetch, calls } = mockFetch(() => {
    const lazy = lazyChunks([FOUR(), FOUR(), FOUR()]);
    supplied = lazy.supplied;
    return lazy.response;
  });
  const spec = { path: "model.onnx", expectedBytes: 6 };
  try {
    const error = await assertRejects(
      () => fetchHfFile({ repo: REPO, revision: SHA }, spec, { fetch }),
      Error,
    );
    // 全量後の厳密一致（バイト数不一致）ではなく、超過時点での打ち切りとして落ちる。
    assertStringIncludes(error.message, "受信が申告 6 バイトを超えた");
    assertStringIncludes(error.message, "8 バイト以上");
    assertEquals(supplied(), 2); // 3 チャンク目は要求されない。

    // 不正物はキャッシュしない = 同じ呼び出しは再び network に出る。
    await assertRejects(
      () => fetchHfFile({ repo: REPO, revision: SHA }, spec, { fetch }),
      Error,
    );
    assertEquals(calls.length, 2);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchHfFile: 受信が expectedBytes を超えたら throw し、エントリを成立させない", async () => {
  const { fetch } = mockFetch(() =>
    lazyChunks([FOUR(), FOUR(), FOUR()]).response
  );
  try {
    const error = await assertRejects(
      () =>
        prefetchHfFile(
          { repo: REPO, revision: SHA },
          { path: "model.onnx", sha256: BYTES_SHA256, expectedBytes: 6 },
          { fetch },
        ),
      Error,
    );
    assertStringIncludes(error.message, "受信が申告 6 バイトを超えた");
    // 取得内容の不正であって cache I/O の失敗ではない（汎用文言に化けさせない）。
    assertEquals(error.message.includes("キャッシュ書込みに失敗"), false);
    assertEquals(await listKeys(["hf"]), []);
    const cache = await caches.open(CACHE_NAME);
    assertEquals(
      await cache.match(contentKeyUrl("model.onnx", BYTES_SHA256)),
      undefined,
    );
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile / prefetchHfFile: ちょうど expectedBytes ぶんなら成功する", async () => {
  const { fetch } = mockFetch(() =>
    lazyChunks([FOUR(), FOUR(), FOUR()]).response
  );
  const spec = { path: "model.onnx", expectedBytes: 12 };
  try {
    const bytes = await fetchHfFile({ repo: REPO, revision: SHA }, spec, {
      fetch,
    });
    assertEquals(bytes.length, 12);
    await caches.delete(CACHE_NAME);
    const result = await prefetchHfFile({ repo: REPO, revision: SHA }, spec, {
      fetch,
    });
    assertEquals(result.fetched, true);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchHfFile: expectedBytes に足りない受信は従来どおり全量後の不一致で落ちる", async () => {
  let supplied = (): number => 0;
  const { fetch } = mockFetch(() => {
    const lazy = lazyChunks([FOUR()]);
    supplied = lazy.supplied;
    return lazy.response;
  });
  try {
    const error = await assertRejects(
      () =>
        fetchHfFile(
          { repo: REPO, revision: SHA },
          { path: "model.onnx", expectedBytes: 8 },
          { fetch },
        ),
      Error,
    );
    // 上限は「超過」だけを見る。不足は打ち切る理由が無いので検証（validate）の担当のまま。
    assertStringIncludes(error.message, "バイト数不一致: 4 != 8");
    assertEquals(supplied(), 1); // 最後まで読み切っている。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});
