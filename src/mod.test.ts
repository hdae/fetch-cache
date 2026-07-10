import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CacheErrorContext,
  clearCache,
  evictUrl,
  fetchBytes,
  listCachedUrls,
} from "./mod.ts";
import {
  chunkedResponse,
  mockFetch,
  uniqueCacheName,
} from "./testing/mock_fetch.ts";

/** cache I/O 失敗を注入する CacheStorage ラッパ（overrides で指定した操作だけ差し替える）。 */
const failingCacheStorage = (overrides: Partial<Cache>): CacheStorage => ({
  open: async (cacheName) => {
    const real = await caches.open(cacheName);
    return {
      match: (request) => real.match(request),
      put: (request, response) => real.put(request, response),
      delete: (request) => real.delete(request),
      ...overrides,
    };
  },
  has: (cacheName) => caches.has(cacheName),
  delete: (cacheName) => caches.delete(cacheName),
  keys: () => caches.keys(),
  match: (request, options) => caches.match(request, options),
});

const URL_A = "https://example.com/assets/a.bin";
const BYTES_A = new Uint8Array([1, 2, 3, 4, 5]);

// 現行 Deno は Cache.keys() 未実装（put/match/delete のみ）。listCachedUrls のテストを
// 実行時サポートで分岐する（実装側 supportsKeys と同じ feature-detect）。
const probeName = uniqueCacheName();
const probeCache = await caches.open(probeName);
const runtimeHasCacheKeys =
  typeof (probeCache as Partial<{ keys: () => Promise<readonly Request[]> }>)
    .keys === "function";
await caches.delete(probeName); // probe の名前空間を残さない。

Deno.test("fetchBytes: ミスで fetch 1回、2回目はキャッシュヒットで fetch 0回", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    const first = await fetchBytes(URL_A, { cacheName, fetch });
    assertEquals(first, BYTES_A);
    assertEquals(calls, [URL_A]);

    const second = await fetchBytes(URL_A, { cacheName, fetch });
    assertEquals(second, BYTES_A);
    assertEquals(calls.length, 1); // ヒット時は network に出ない。
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: cache:false は Cache API を触らず毎回 fetch する", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    await fetchBytes(URL_A, { cacheName, cache: false, fetch });
    await fetchBytes(URL_A, { cacheName, cache: false, fetch });
    assertEquals(calls.length, 2);

    // cache:false ではキャッシュに書き込まれない。
    const cache = await caches.open(cacheName);
    assertEquals(await cache.match(URL_A), undefined);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: 破損キャッシュは evict して network から取り直す（self-heal）", async () => {
  const cacheName = uniqueCacheName();
  const corrupt = new Uint8Array([9, 9, 9]);
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const validate = (bytes: Uint8Array) => {
    if (bytes.length !== BYTES_A.length) throw new Error("破損");
  };
  try {
    // 破損エントリを直接キャッシュへ仕込む。
    const cache = await caches.open(cacheName);
    await cache.put(URL_A, new Response(corrupt));

    const healed = await fetchBytes(URL_A, { cacheName, validate, fetch });
    assertEquals(healed, BYTES_A);
    assertEquals(calls.length, 1); // evict → network 1回。

    // 取り直した正常物がキャッシュされている（再呼び出しで fetch 0回）。
    await fetchBytes(URL_A, { cacheName, validate, fetch });
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: network 取得物の validate 失敗は throw し、キャッシュしない", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    await assertRejects(
      () =>
        fetchBytes(URL_A, {
          cacheName,
          fetch,
          validate: () => {
            throw new Error("常に不正");
          },
        }),
      Error,
      "常に不正",
    );
    assertEquals(calls.length, 1);

    const cache = await caches.open(cacheName);
    assertEquals(await cache.match(URL_A), undefined); // 不正物は保存されない。
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: onProgress はチャンク毎に loaded を累積し、content-length があれば total を持つ", async () => {
  const cacheName = uniqueCacheName();
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
  const { fetch } = mockFetch(() =>
    chunkedResponse(chunks, { "content-length": "7" })
  );
  const events: { loaded: number; total?: number }[] = [];
  try {
    const bytes = await fetchBytes(URL_A, {
      cacheName,
      fetch,
      onProgress: (progress) => events.push(progress),
    });
    assertEquals(bytes, new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
    assertEquals(events, [{ loaded: 3, total: 7 }, { loaded: 7, total: 7 }]);

    // キャッシュヒット時は onProgress が呼ばれない。
    events.length = 0;
    await fetchBytes(URL_A, {
      cacheName,
      fetch,
      onProgress: (progress) => events.push(progress),
    });
    assertEquals(events, []);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: content-length が無ければ total は undefined", async () => {
  const cacheName = uniqueCacheName();
  const { fetch } = mockFetch(() =>
    chunkedResponse([new Uint8Array([1, 2, 3])])
  );
  const events: { loaded: number; total?: number }[] = [];
  try {
    await fetchBytes(URL_A, {
      cacheName,
      fetch,
      onProgress: (progress) => events.push(progress),
    });
    assertEquals(events, [{ loaded: 3, total: undefined }]);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: HTTP エラーは status 入りメッセージで throw する", async () => {
  const cacheName = uniqueCacheName();
  const { fetch } = mockFetch(() =>
    new Response("missing", { status: 404, statusText: "Not Found" })
  );
  try {
    const error = await assertRejects(
      () => fetchBytes(URL_A, { cacheName, fetch }),
      Error,
    );
    assertStringIncludes(error.message, "fetch-cache: HTTP 404 Not Found");
    assertStringIncludes(error.message, URL_A);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: 同一 URL の並行呼び出しはデデュープされない（現仕様の凍結）", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    // NOTE: single-flight は未導入（docs/limitations.md）。両者が miss を観測して
    // それぞれ fetch する（二重ダウンロード）。put は last-writer-wins で内容同一のため
    // 整合性は保たれる。
    const [first, second] = await Promise.all([
      fetchBytes(URL_A, { cacheName, fetch }),
      fetchBytes(URL_A, { cacheName, fetch }),
    ]);
    assertEquals(first, BYTES_A);
    assertEquals(second, BYTES_A);
    assertEquals(calls.length, 2);

    // 収束後は正常な 1 エントリでヒットする。
    await fetchBytes(URL_A, { cacheName, fetch });
    assertEquals(calls.length, 2);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: body が null の応答は arrayBuffer フォールバックで空 bytes・onProgress 1回", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(null));
  const events: { loaded: number; total?: number }[] = [];
  try {
    const bytes = await fetchBytes(URL_A, {
      cacheName,
      fetch,
      onProgress: (progress) => events.push(progress),
    });
    assertEquals(bytes, new Uint8Array(0));
    assertEquals(events, [{ loaded: 0, total: undefined }]);

    // 空エントリとしてキャッシュされ、2 回目はヒットする。
    const second = await fetchBytes(URL_A, { cacheName, fetch });
    assertEquals(second, new Uint8Array(0));
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: self-heal の再取得も validate 失敗なら throw し、エントリは残らない", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const validate = () => {
    throw new Error("常に不正");
  };
  try {
    const cache = await caches.open(cacheName);
    await cache.put(URL_A, new Response(new Uint8Array([9])));

    await assertRejects(
      () => fetchBytes(URL_A, { cacheName, validate, fetch }),
      Error,
      "常に不正",
    );
    // evict → network 1 回 → validate 失敗で終端（無限ループしない）。
    assertEquals(calls.length, 1);
    // 破損エントリは evict 済みで、不正な取得物も put されない。
    assertEquals(await cache.match(URL_A), undefined);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: async validate の reject も拾い、resolve は通す", async () => {
  const cacheName = uniqueCacheName();
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  try {
    await assertRejects(
      () =>
        fetchBytes(URL_A, {
          cacheName,
          fetch,
          validate: () => Promise.reject(new Error("async 不正")),
        }),
      Error,
      "async 不正",
    );

    const bytes = await fetchBytes(URL_A, {
      cacheName,
      fetch,
      validate: () => Promise.resolve(),
    });
    assertEquals(bytes, BYTES_A);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: fetch の transport 例外は握りつぶさず伝播する", async () => {
  const cacheName = uniqueCacheName();
  const { fetch } = mockFetch(() =>
    Promise.reject(new Error("connection refused"))
  );
  try {
    await assertRejects(
      () => fetchBytes(URL_A, { cacheName, fetch }),
      Error,
      "connection refused",
    );
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes / evictUrl: URL オブジェクト入力は文字列と同じキーになる", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    const bytes = await fetchBytes(new URL(URL_A), { cacheName, fetch });
    assertEquals(bytes, BYTES_A);

    // 文字列入力で同一キーにヒットする（URL→href の正規化が一致）。
    await fetchBytes(URL_A, { cacheName, fetch });
    assertEquals(calls.length, 1);

    assertEquals(await evictUrl(new URL(URL_A), { cacheName }), true);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: 正常キャッシュヒットは validate 通過で network に出ない", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const validate = (bytes: Uint8Array) => {
    if (bytes.length !== BYTES_A.length) throw new Error("破損");
  };
  try {
    await fetchBytes(URL_A, { cacheName, validate, fetch });
    const second = await fetchBytes(URL_A, { cacheName, validate, fetch });
    assertEquals(second, BYTES_A);
    assertEquals(calls.length, 1); // ヒット + validate 通過 → network 0 回。
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: HTTP エラー時は body を cancel して接続リソースを解放する", async () => {
  const cacheName = uniqueCacheName();
  let response: Response | undefined;
  const { fetch } = mockFetch(() => {
    response = new Response("missing", {
      status: 404,
      statusText: "Not Found",
    });
    return response;
  });
  try {
    await assertRejects(() => fetchBytes(URL_A, { cacheName, fetch }), Error);
    assertEquals(response?.bodyUsed, true); // cancel 済み＝disturbed。
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: cache.put 失敗は成功したダウンロードを巻き添えにせず通知する", async () => {
  const cacheName = uniqueCacheName();
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  const notified: CacheErrorContext[] = [];
  try {
    const bytes = await fetchBytes(URL_A, {
      cacheName,
      fetch,
      caches: failingCacheStorage({
        put: () => Promise.reject(new Error("quota exceeded")),
      }),
      onCacheError: (context) => notified.push(context),
    });
    assertEquals(bytes, BYTES_A); // ダウンロード結果は失われない。
    assertEquals(notified.length, 1);
    assertEquals(notified[0].op, "put");
    assertEquals(notified[0].url, URL_A);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: cache 読出し失敗は miss として network へ縮退し通知する", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const notified: CacheErrorContext[] = [];
  try {
    const bytes = await fetchBytes(URL_A, {
      cacheName,
      fetch,
      caches: failingCacheStorage({
        match: () => Promise.reject(new Error("storage broken")),
      }),
      onCacheError: (context) => notified.push(context),
    });
    assertEquals(bytes, BYTES_A);
    assertEquals(calls.length, 1); // network へ縮退して取得。
    assertEquals(notified.map((context) => context.op), ["match"]); // put は成功。
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: caches.open 失敗はキャッシュ無しの素の fetch へ縮退する", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const notified: CacheErrorContext[] = [];
  const brokenCaches: CacheStorage = {
    open: () => Promise.reject(new Error("open failed")),
    has: (name) => caches.has(name),
    delete: (name) => caches.delete(name),
    keys: () => caches.keys(),
    match: (request, options) => caches.match(request, options),
  };
  const bytes = await fetchBytes(URL_A, {
    cacheName,
    fetch,
    caches: brokenCaches,
    onCacheError: (context) => notified.push(context),
  });
  assertEquals(bytes, BYTES_A);
  assertEquals(calls.length, 1);
  assertEquals(notified.map((context) => context.op), ["open"]); // open は 1 回だけ試行。
});

Deno.test("fetchBytes: self-heal 中の evict 失敗でも再取得は続行し通知する", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const notified: CacheErrorContext[] = [];
  const validate = (bytes: Uint8Array) => {
    if (bytes.length !== BYTES_A.length) throw new Error("破損");
  };
  try {
    const cache = await caches.open(cacheName);
    await cache.put(URL_A, new Response(new Uint8Array([9])));

    const bytes = await fetchBytes(URL_A, {
      cacheName,
      validate,
      fetch,
      caches: failingCacheStorage({
        delete: () => Promise.reject(new Error("delete failed")),
      }),
      onCacheError: (context) => notified.push(context),
    });
    assertEquals(bytes, BYTES_A); // 破損ヒット → evict 失敗 → それでも network から取り直す。
    assertEquals(calls.length, 1);
    assertEquals(notified.map((context) => context.op), ["delete"]);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("evictUrl: エントリがあれば削除して true、無ければ false", async () => {
  const cacheName = uniqueCacheName();
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  try {
    assertEquals(await evictUrl(URL_A, { cacheName }), false); // 未キャッシュ。
    await fetchBytes(URL_A, { cacheName, fetch });
    assertEquals(await evictUrl(URL_A, { cacheName }), true);

    const cache = await caches.open(cacheName);
    assertEquals(await cache.match(URL_A), undefined);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("clearCache: 名前空間ごと削除して true、既に無ければ false", async () => {
  const cacheName = uniqueCacheName();
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  await fetchBytes(URL_A, { cacheName, fetch });
  assertEquals(await clearCache(cacheName), true);
  assertEquals(await clearCache(cacheName), false);
});

Deno.test({
  name:
    "listCachedUrls: keys() 未実装ランタイム（現行 Deno）では fail loud に throw する",
  ignore: runtimeHasCacheKeys,
  fn: async () => {
    const cacheName = uniqueCacheName();
    const { fetch } = mockFetch(() => new Response(BYTES_A));
    try {
      await fetchBytes(URL_A, { cacheName, fetch });
      const error = await assertRejects(() => listCachedUrls(cacheName), Error);
      assertStringIncludes(error.message, "keys()");
    } finally {
      await caches.delete(cacheName);
    }
  },
});

Deno.test({
  name:
    "listCachedUrls: キャッシュ済み URL の一覧を返す（keys() 実装ランタイムのみ）",
  ignore: !runtimeHasCacheKeys,
  fn: async () => {
    const cacheName = uniqueCacheName();
    const { fetch } = mockFetch(() => new Response(BYTES_A));
    try {
      assertEquals(await listCachedUrls(cacheName), []);
      await fetchBytes(URL_A, { cacheName, fetch });
      assertEquals(await listCachedUrls(cacheName), [URL_A]);
    } finally {
      await caches.delete(cacheName);
    }
  },
});
