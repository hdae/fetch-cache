import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { clearCache, evictUrl, fetchBytes, listCachedUrls } from "./mod.ts";
import {
  chunkedResponse,
  mockFetch,
  uniqueCacheName,
} from "./testing/mock_fetch.ts";

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
