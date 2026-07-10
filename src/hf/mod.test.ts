import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  fetchHfFile,
  fetchHfFiles,
  hfResolveUrl,
  isCommitSha,
  resolveHfRevision,
} from "./mod.ts";
import { mockFetch, uniqueCacheName } from "../testing/mock_fetch.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "owner/name";
const BYTES = new Uint8Array([10, 20, 30, 40]);
// BYTES の SHA-256（テスト起動時に一度だけ計算。ネットワークには出ない）。
const BYTES_SHA256 = Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", BYTES)),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");

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
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch((url) =>
    url.includes("/api/") ? Response.json({ sha: SHA }) : new Response(BYTES)
  );
  try {
    const bytes = await fetchHfFile({ repo: REPO }, "a.bin", {
      cacheName,
      fetch,
    });
    assertEquals(bytes, BYTES);
    assertEquals(calls, [
      "https://huggingface.co/api/models/owner/name/revision/main",
      `https://huggingface.co/owner/name/resolve/${SHA}/a.bin`,
    ]);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchHfFile: init は revision 解決とファイル取得の両方へ渡る", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls, inits } = mockFetch((url) =>
    url.includes("/api/") ? Response.json({ sha: SHA }) : new Response(BYTES)
  );
  try {
    await fetchHfFile({ repo: REPO }, "a.bin", {
      cacheName,
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
    await caches.delete(cacheName);
  }
});

Deno.test("fetchHfFile: ファイル取得の 404 は fail-loud に伝播する", async () => {
  const cacheName = uniqueCacheName();
  const { fetch } = mockFetch((url) =>
    url.includes("/api/")
      ? Response.json({ sha: SHA })
      : new Response("missing", { status: 404, statusText: "Not Found" })
  );
  try {
    const error = await assertRejects(
      () => fetchHfFile({ repo: REPO }, "missing.bin", { cacheName, fetch }),
      Error,
    );
    assertStringIncludes(error.message, "HTTP 404");
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchHfFile: 破損キャッシュは sha256 validate で evict され再取得される（self-heal）", async () => {
  const cacheName = uniqueCacheName();
  const url = `https://huggingface.co/owner/name/resolve/${SHA}/model.onnx`;
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  try {
    // 壊れたバイト列を SHA 固定 URL のキーへ直接仕込む（fault injection）。
    const cache = await caches.open(cacheName);
    await cache.put(url, new Response(new Uint8Array([9, 9])));

    const bytes = await fetchHfFile(
      { repo: REPO, revision: SHA },
      { path: "model.onnx", sha256: BYTES_SHA256 },
      { cacheName, fetch },
    );
    assertEquals(bytes, BYTES);
    assertEquals(calls.length, 1); // evict → network 1 回。

    // キャッシュは正しい内容に置換済み（再呼び出しで network 0 回）。
    await fetchHfFile(
      { repo: REPO, revision: SHA },
      { path: "model.onnx", sha256: BYTES_SHA256 },
      { cacheName, fetch },
    );
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchHfFile: sha256 一致で取得・キャッシュされる", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(BYTES));
  try {
    const bytes = await fetchHfFile(
      { repo: REPO, revision: SHA },
      { path: "model.onnx", sha256: BYTES_SHA256 },
      { cacheName, fetch },
    );
    assertEquals(bytes, BYTES);
    assertEquals(calls, [
      `https://huggingface.co/owner/name/resolve/${SHA}/model.onnx`,
    ]);

    // 2回目はキャッシュヒット（SHA 固定 URL なので解決リクエストも出ない）。
    await fetchHfFile(
      { repo: REPO, revision: SHA },
      { path: "model.onnx", sha256: BYTES_SHA256 },
      { cacheName, fetch },
    );
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchHfFile: sha256 不一致は throw し、キャッシュしない", async () => {
  const cacheName = uniqueCacheName();
  const { fetch } = mockFetch(() => new Response(BYTES));
  const wrongSha = "0".repeat(64);
  try {
    const error = await assertRejects(
      () =>
        fetchHfFile(
          { repo: REPO, revision: SHA },
          { path: "model.onnx", sha256: wrongSha },
          { cacheName, fetch },
        ),
      Error,
    );
    assertStringIncludes(error.message, "SHA-256 不一致");

    const cache = await caches.open(cacheName);
    assertEquals(
      await cache.match(
        `https://huggingface.co/owner/name/resolve/${SHA}/model.onnx`,
      ),
      undefined,
    );
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchHfFile: expectedBytes 不一致は throw する", async () => {
  const cacheName = uniqueCacheName();
  const { fetch } = mockFetch(() => new Response(BYTES));
  try {
    const error = await assertRejects(
      () =>
        fetchHfFile(
          { repo: REPO, revision: SHA },
          { path: "model.onnx", expectedBytes: BYTES.length + 1 },
          { cacheName, fetch },
        ),
      Error,
    );
    assertStringIncludes(error.message, "バイト数不一致");
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchHfFiles: revision API は 1 回だけ・並列結果が名前にマップされる", async () => {
  const cacheName = uniqueCacheName();
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
      { cacheName, fetch },
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
    await caches.delete(cacheName);
  }
});

Deno.test("fetchHfFiles: 1 ファイルの失敗で全体が reject し、成功分のキャッシュは残る", async () => {
  const cacheName = uniqueCacheName();
  const bytesA = new Uint8Array([1, 1, 1]);
  const urlA = `https://huggingface.co/owner/name/resolve/${SHA}/a.bin`;
  // b の 404 は「a がキャッシュ済み」になるまで遅延させ、全体 reject 時点の
  // キャッシュ状態を決定的にする（Promise.all は成功分の put を取り消さない）。
  const awaitACached = async (): Promise<void> => {
    const cache = await caches.open(cacheName);
    while ((await cache.match(urlA)) === undefined) {
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
          { cacheName, fetch },
        ),
      Error,
    );
    assertStringIncludes(error.message, "HTTP 404");

    // 成功済み a のキャッシュ副作用は取り消されない＝リトライは即ヒット（README 記載の仕様）。
    const callsBefore = calls.length;
    const again = await fetchHfFile({ repo: REPO, revision: SHA }, "a.bin", {
      cacheName,
      fetch,
    });
    assertEquals(again, bytesA);
    assertEquals(calls.length, callsBefore); // network 0 回。
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchHfFiles: onProgress に path が付く", async () => {
  const cacheName = uniqueCacheName();
  const { fetch } = mockFetch((url) =>
    url.includes("/api/") ? Response.json({ sha: SHA }) : new Response(BYTES)
  );
  const paths = new Set<string>();
  try {
    await fetchHfFiles(
      { repo: REPO },
      { a: "a.bin", b: "b.bin" },
      {
        cacheName,
        fetch,
        onProgress: (progress) => paths.add(progress.path),
      },
    );
    assertEquals(paths, new Set(["a.bin", "b.bin"]));
  } finally {
    await caches.delete(cacheName);
  }
});
