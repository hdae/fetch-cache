import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { fetchBytes, prefetchUrl, type RetryContext } from "./mod.ts";
import {
  fetchHfFile,
  fetchHfFiles,
  prefetchHfFile,
  resolveHfRevision,
} from "./hf/mod.ts";
import { mockFetch } from "./testing/mock_fetch.ts";

// 名前空間は内部固定 1 個（cache 層と共通 — DECIDED: docs/decisions/0006 §3）。
const CACHE_NAME = "fetch-cache";

const URL_A = "https://example.com/assets/a.bin";
const URL_B = "https://example.com/assets/b.bin";
const BYTES_A = new Uint8Array([1, 2, 3, 4, 5]);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "owner/name";

// MUST: 実時間で待たない。Retry-After: 0 か baseDelayMs: 0 を使う（待機規則そのものを見る
// テストだけが 1ms 単位の実待機を許す）。
const RATE_LIMITED = { status: 429, statusText: "Too Many Requests" } as const;

/** 最初の `times` 回だけ失敗ステータスを返し、以後 BYTES_A を返すハンドラ。 */
const failThenBytes = (
  times: number,
  status: number,
  headers?: HeadersInit,
): () => Response => {
  let remaining = times;
  return () => {
    if (remaining > 0) {
      remaining -= 1;
      return new Response("rate limited", {
        status,
        statusText: status === 429
          ? "Too Many Requests"
          : "Service Unavailable",
        headers,
      });
    }
    return new Response(BYTES_A);
  };
};

Deno.test("再試行: 429 + Retry-After は既定で 1 回待って取り直し、結果はキャッシュされる", async () => {
  const { fetch, calls } = mockFetch(
    failThenBytes(1, 429, { "retry-after": "0" }),
  );
  const seen: RetryContext[] = [];
  try {
    // retry を渡していない = 既定で有効であることも同時に凍結する。
    const bytes = await fetchBytes(URL_A, {
      fetch,
      onRetry: (c) => seen.push(c),
    });
    assertEquals(bytes, BYTES_A);
    assertEquals(calls.length, 2);
    assertEquals(seen, [{
      url: URL_A,
      status: 429,
      attempt: 1,
      delayMs: 0,
      retryAfter: "0",
    }]);
    // 再試行の末に成功した取得は通常どおり格納される（2 回目は network に出ない）。
    assertEquals(await fetchBytes(URL_A, { fetch }), BYTES_A);
    assertEquals(calls.length, 2);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: Retry-After が無ければ baseDelayMs から始まる待機で取り直す（503 も対象）", async () => {
  const { fetch, calls } = mockFetch(failThenBytes(1, 503));
  const seen: RetryContext[] = [];
  try {
    const bytes = await fetchBytes(URL_A, {
      fetch,
      retry: { baseDelayMs: 0 },
      onRetry: (c) => seen.push(c),
    });
    assertEquals(bytes, BYTES_A);
    assertEquals(calls.length, 2);
    assertEquals(seen.length, 1);
    assertEquals(seen[0].status, 503);
    assertEquals(seen[0].delayMs, 0);
    assertEquals(seen[0].retryAfter, undefined); // ヘッダが無ければ undefined。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: Retry-After が無いときの待機は 2 倍ずつ伸びる", async () => {
  // 待機規則そのものの凍結。実待機は 1 + 2 + 4 = 7ms（テストの所要時間は増やさない）。
  const { fetch } = mockFetch(failThenBytes(3, 429));
  const seen: RetryContext[] = [];
  try {
    await fetchBytes(URL_A, {
      fetch,
      retry: { baseDelayMs: 1 },
      onRetry: (c) => seen.push(c),
    });
    assertEquals(seen.map((c) => c.delayMs), [1, 2, 4]);
    assertEquals(seen.map((c) => c.attempt), [1, 2, 3]);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: HTTP-date 形式の Retry-After は現在時刻との差（過去なら 0）で待つ", async () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  const { fetch, calls } = mockFetch(
    failThenBytes(1, 429, { "retry-after": past }),
  );
  const seen: RetryContext[] = [];
  try {
    const bytes = await fetchBytes(URL_A, {
      fetch,
      onRetry: (c) => seen.push(c),
    });
    assertEquals(bytes, BYTES_A);
    assertEquals(calls.length, 2);
    assertEquals(seen[0].delayMs, 0);
    assertEquals(seen[0].retryAfter, past);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: 解釈できない Retry-After は「指示なし」扱いで baseDelayMs に落ちる", async () => {
  const { fetch, calls } = mockFetch(
    failThenBytes(1, 429, { "retry-after": "soon" }),
  );
  const seen: RetryContext[] = [];
  try {
    await fetchBytes(URL_A, {
      fetch,
      retry: { baseDelayMs: 0 },
      onRetry: (c) => seen.push(c),
    });
    assertEquals(calls.length, 2); // 書式ミスで取得を落とさない。
    assertEquals(seen[0].delayMs, 0);
    assertEquals(seen[0].retryAfter, "soon"); // 生ヘッダはそのまま通知する。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: maxDelayMs は Retry-After の指示も上限で切る", async () => {
  const { fetch, calls } = mockFetch(
    failThenBytes(1, 429, { "retry-after": "3600" }),
  );
  const seen: RetryContext[] = [];
  try {
    const bytes = await fetchBytes(URL_A, {
      fetch,
      retry: { maxDelayMs: 0 },
      onRetry: (c) => seen.push(c),
    });
    assertEquals(bytes, BYTES_A);
    assertEquals(calls.length, 2);
    assertEquals(seen[0].delayMs, 0);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: 使い切ったら従来の文言で throw し、キャッシュも残さない", async () => {
  const { fetch, calls } = mockFetch(() =>
    new Response("rate limited", {
      ...RATE_LIMITED,
      headers: { "retry-after": "0" },
    })
  );
  try {
    const error = await assertRejects(
      () => fetchBytes(URL_A, { fetch, retry: { maxRetries: 2 } }),
      Error,
    );
    assertEquals(calls.length, 3); // 初回 + 再試行 2 回。
    // 先頭部分は従来どおり（下流の判別を壊さない）。回数は末尾にだけ足す。
    assertEquals(
      error.message.startsWith(
        `fetch-cache: HTTP 429 Too Many Requests (${URL_A})`,
      ),
      true,
    );
    assertStringIncludes(error.message, "（再試行 2 回の後）");
    const cache = await caches.open(CACHE_NAME);
    assertEquals(await cache.match(URL_A), undefined);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: 対象外ステータスと retry:false は 1 回目でそのまま throw する", async () => {
  const notFound = mockFetch(() =>
    new Response("missing", { status: 404, statusText: "Not Found" })
  );
  const limited = mockFetch(() => new Response("rate limited", RATE_LIMITED));
  try {
    const error = await assertRejects(
      () => fetchBytes(URL_A, { fetch: notFound.fetch }),
      Error,
    );
    assertEquals(notFound.calls.length, 1);
    assertStringIncludes(error.message, "fetch-cache: HTTP 404 Not Found");
    assertEquals(error.message.includes("再試行"), false); // 0 回なら文言は従来のまま。

    const optedOut = await assertRejects(
      () => fetchBytes(URL_A, { fetch: limited.fetch, retry: false }),
      Error,
    );
    assertEquals(limited.calls.length, 1);
    assertStringIncludes(optedOut.message, "fetch-cache: HTTP 429");
    assertEquals(optedOut.message.includes("再試行"), false);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: setTimeout の上限を超える Retry-After は待たずに応答を返す（再試行しない）", async () => {
  // 2592000 秒 = 30 日 > 2**31-1 ms（約 24.8 日）。待てないので再試行に意味が無い経路。
  const { fetch, calls } = mockFetch(() =>
    new Response("rate limited", {
      ...RATE_LIMITED,
      headers: { "retry-after": "2592000" },
    })
  );
  const seen: RetryContext[] = [];
  try {
    const error = await assertRejects(
      () => fetchBytes(URL_A, { fetch, onRetry: (c) => seen.push(c) }),
      Error,
    );
    assertEquals(calls.length, 1); // 即時発火で打ち直さない（待ったことにできないため）。
    assertEquals(seen, []); // 再試行していないので通知も無い。
    assertStringIncludes(error.message, "fetch-cache: HTTP 429");
    assertEquals(error.message.includes("再試行"), false); // 回数にも数えない。

    // 対照: maxDelayMs で待機を切れば、同じ応答でも従来どおり再試行する（判定は上限適用後）。
    const capped = mockFetch(
      failThenBytes(1, 429, { "retry-after": "2592000" }),
    );
    assertEquals(
      await fetchBytes(URL_B, {
        fetch: capped.fetch,
        retry: { maxDelayMs: 0 },
        onRetry: (c) => seen.push(c),
      }),
      BYTES_A,
    );
    assertEquals(capped.calls.length, 2);
    assertEquals(seen.length, 1);
    assertEquals(seen[0].delayMs, 0);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: GET / HEAD 以外は再試行しない（cache:false の POST は打ち直さない）", async () => {
  const { fetch, calls } = mockFetch(() =>
    new Response("rate limited", {
      ...RATE_LIMITED,
      headers: { "retry-after": "0" },
    })
  );
  const seen: RetryContext[] = [];
  try {
    const error = await assertRejects(
      () =>
        fetchBytes(URL_A, {
          fetch,
          cache: false, // 非 GET が通るのはこの経路だけ（DECIDED: docs/decisions/0002）。
          init: { method: "POST", body: "payload" },
          onRetry: (c) => seen.push(c),
        }),
      Error,
    );
    // 副作用のある要求を打ち直さない = 429 でも 1 回きり。
    assertEquals(calls.length, 1);
    assertEquals(seen, []);
    assertStringIncludes(error.message, "fetch-cache: HTTP 429");
    assertEquals(error.message.includes("再試行"), false);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: 待機中の abort は timer を消して signal.reason で reject する", async () => {
  const controller = new AbortController();
  const reason = new Error("呼び出し側からの中断");
  const { fetch, calls } = mockFetch(() =>
    new Response("rate limited", {
      ...RATE_LIMITED,
      headers: { "retry-after": "3600" }, // 実時間で待てば 1 時間。
    })
  );
  // onRetry は待機の**前**に呼ばれるので、そこで同期に abort すると「既に aborted」の別分岐に
  // なる。macrotask へ逃がして「待機中の abort」を踏ませる。
  const promise = fetchBytes(URL_A, {
    fetch,
    init: { signal: controller.signal },
    onRetry: () => {
      setTimeout(() => controller.abort(reason), 0);
    },
  });
  // deadline: 中断が効かなければハングする経路なので、必ず有限時間で赤くする。
  let deadline: ReturnType<typeof setTimeout> | undefined = undefined;
  const timeout = new Promise<never>((_, reject) => {
    deadline = setTimeout(
      () => reject(new Error("待機が中断されなかった（実時間で待っている）")),
      2_000,
    );
  });
  try {
    const error = await Promise.race([
      promise.then(
        () => {
          throw new Error("abort したのに resolve した");
        },
        (thrown: unknown) => thrown,
      ),
      timeout,
    ]);
    assertStrictEquals(error, reason); // signal.reason がそのまま出る。
    assertEquals(calls.length, 1); // 待機を抜けた先の再取得には進まない。
  } finally {
    clearTimeout(deadline);
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: 既に aborted の signal では待たずに reject する", async () => {
  const controller = new AbortController();
  const reason = new Error("開始前に中断");
  const { fetch } = mockFetch(() =>
    new Response("rate limited", {
      ...RATE_LIMITED,
      headers: { "retry-after": "3600" },
    })
  );
  try {
    const error = await assertRejects(
      () =>
        fetchBytes(URL_A, {
          fetch,
          init: { signal: controller.signal },
          onRetry: () => controller.abort(reason), // 待機に入る直前に中断される。
        }),
      Error,
    );
    assertStrictEquals(error, reason);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: onRetry の throw は取得を巻き添えにしない（隔離+警告）", async () => {
  const { fetch, calls } = mockFetch(
    failThenBytes(1, 429, { "retry-after": "0" }),
  );
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(String(args[0]));
  };
  try {
    const bytes = await fetchBytes(URL_A, {
      fetch,
      onRetry: () => {
        throw new Error("リスナー事故");
      },
    });
    assertEquals(bytes, BYTES_A);
    assertEquals(calls.length, 2);
    assertEquals(warns.some((w) => w.includes("onRetry")), true);
  } finally {
    console.warn = origWarn;
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: prefetchUrl 経路も同じ 1 本を通る", async () => {
  const { fetch, calls } = mockFetch(
    failThenBytes(1, 429, { "retry-after": "0" }),
  );
  const seen: RetryContext[] = [];
  try {
    assertEquals(
      await prefetchUrl(URL_A, { fetch, onRetry: (c) => seen.push(c) }),
      true,
    );
    assertEquals(calls.length, 2);
    assertEquals(seen.length, 1);
    const cache = await caches.open(CACHE_NAME);
    assertExists(await cache.match(URL_A));
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: resolveHfRevision 経路も同じ 1 本を通る", async () => {
  let first = true;
  const { fetch, calls } = mockFetch(() => {
    if (first) {
      first = false;
      return new Response("rate limited", {
        ...RATE_LIMITED,
        headers: { "retry-after": "0" },
      });
    }
    return Response.json({ sha: SHA });
  });
  const seen: RetryContext[] = [];
  const resolved = await resolveHfRevision({ repo: REPO }, {
    fetch,
    onRetry: (c) => seen.push(c),
  });
  assertEquals(resolved, SHA);
  assertEquals(calls.length, 2);
  assertEquals(seen.length, 1);
  assertStringIncludes(seen[0].url, "/api/models/owner/name/revision/main");
});

Deno.test("再試行: HF 層の retry / onRetry は revision 解決とファイル取得の両方へ届く", async () => {
  const limited = new Set<string>();
  const { fetch, calls } = mockFetch((url) => {
    // URL ごとに 1 回だけ 429 を返す（解決 API とファイル取得の両方を再試行させる）。
    if (!limited.has(url)) {
      limited.add(url);
      return new Response("rate limited", {
        ...RATE_LIMITED,
        headers: { "retry-after": "0" },
      });
    }
    return url.includes("/api/")
      ? Response.json({ sha: SHA })
      : new Response(BYTES_A);
  });
  const seen: RetryContext[] = [];
  try {
    const bytes = await fetchHfFile({ repo: REPO }, "a.bin", {
      fetch,
      onRetry: (c) => seen.push(c),
    });
    assertEquals(bytes, BYTES_A);
    assertEquals(calls.length, 4); // 解決 2（429 → 200）+ 取得 2（429 → 200）。
    assertEquals(seen.map((c) => c.url), [
      "https://huggingface.co/api/models/owner/name/revision/main",
      `https://huggingface.co/owner/name/resolve/${SHA}/a.bin`,
    ]);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: prefetchHfFile 経路にも retry / onRetry が透過する", async () => {
  const { fetch, calls } = mockFetch(
    failThenBytes(1, 429, { "retry-after": "0" }),
  );
  const seen: RetryContext[] = [];
  try {
    const result = await prefetchHfFile(
      { repo: REPO, revision: SHA },
      "a.bin",
      { fetch, onRetry: (c) => seen.push(c) },
    );
    assertEquals(result.fetched, true);
    assertEquals(calls.length, 2);
    assertEquals(seen.length, 1);
    assertEquals(seen[0].url, result.url);
    // 再試行の末に温めたエントリは通常どおり成立する（打ち切られた 429 は残さない）。
    const cache = await caches.open(CACHE_NAME);
    assertExists(await cache.match(result.url));
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: fetchHfFiles 経路にも retry / onRetry が透過する（ファイル毎に効く）", async () => {
  const limited = new Set<string>();
  const { fetch, calls } = mockFetch((url) => {
    // URL ごとに 1 回だけ 429（並列取得する両ファイルが各自で再試行する）。
    if (!limited.has(url)) {
      limited.add(url);
      return new Response("rate limited", {
        ...RATE_LIMITED,
        headers: { "retry-after": "0" },
      });
    }
    return new Response(BYTES_A);
  });
  const seen: RetryContext[] = [];
  try {
    const files = await fetchHfFiles(
      { repo: REPO, revision: SHA },
      { a: "a.bin", b: "b.bin" },
      { fetch, onRetry: (c) => seen.push(c) },
    );
    assertEquals(files.a, BYTES_A);
    assertEquals(files.b, BYTES_A);
    assertEquals(calls.length, 4); // 2 ファイル × (429 → 200)。
    assertEquals(seen.length, 2);
    // 取得できたぶんは格納済み = 2 回目は network に出ない。
    await fetchHfFiles({ repo: REPO, revision: SHA }, { a: "a.bin" }, {
      fetch,
    });
    assertEquals(calls.length, 4);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: statuses を差し替えると対象が入れ替わる（既定の 429 は外れる）", async () => {
  let first = true;
  const teapot = mockFetch(() => {
    if (first) {
      first = false;
      return new Response("teapot", {
        status: 418,
        statusText: "I'm a teapot",
        headers: { "retry-after": "0" },
      });
    }
    return new Response(BYTES_A);
  });
  const limited = mockFetch(() => new Response("rate limited", RATE_LIMITED));
  const seen: RetryContext[] = [];
  try {
    const bytes = await fetchBytes(URL_A, {
      fetch: teapot.fetch,
      retry: { statuses: [418] },
      onRetry: (c) => seen.push(c),
    });
    assertEquals(bytes, BYTES_A);
    assertEquals(teapot.calls.length, 2);
    assertEquals(seen.map((c) => c.status), [418]);

    // 差し替えは置換であって追加ではない — 既定の 429 は 1 回目でそのまま throw する。
    const error = await assertRejects(
      () =>
        fetchBytes(URL_B, {
          fetch: limited.fetch,
          retry: { statuses: [418] },
        }),
      Error,
    );
    assertEquals(limited.calls.length, 1);
    assertStringIncludes(error.message, "fetch-cache: HTTP 429");
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("再試行: HF 層の retry:false は解決 API の 429 も即 throw にする", async () => {
  const { fetch, calls } = mockFetch(() =>
    new Response("rate limited", RATE_LIMITED)
  );
  try {
    const error = await assertRejects(
      () => fetchHfFile({ repo: REPO }, "a.bin", { fetch, retry: false }),
      Error,
    );
    assertEquals(calls.length, 1);
    assertStringIncludes(error.message, "fetch-cache: HTTP 429");
  } finally {
    await caches.delete(CACHE_NAME);
  }
});
