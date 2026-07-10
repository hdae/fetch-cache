import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  type CacheErrorContext,
  clearCache,
  decodeGzip,
  evictUrl,
  fetchBytes,
  listCachedUrls,
} from "./mod.ts";
import {
  chunkedResponse,
  mockFetch,
  uniqueCacheName,
} from "./testing/mock_fetch.ts";

// Cache.keys() の型は Deno のバージョンで揺れる（2.8: 型に無し / 2.9+: 必須メソッド）。
// 両対応のため wrapper は keys を必須で持ち（2.8 では余剰プロパティとして無害）、実体が
// あれば委譲・無ければ reject する。実装側 mod.ts の feature-detect と同じ橋渡しキャスト。
type CacheKeysFn = (
  request?: RequestInfo | URL,
  options?: CacheQueryOptions,
) => Promise<readonly Request[]>;

/** cache I/O 失敗を注入する CacheStorage ラッパ（overrides で指定した操作だけ差し替える）。 */
const failingCacheStorage = (overrides: Partial<Cache>): CacheStorage => ({
  open: async (cacheName) => {
    const real = await caches.open(cacheName);
    // 変数経由で返す（オブジェクトリテラル直返しだと 2.8 の Cache 型に無い keys が
    // 余剰プロパティ検査で弾かれるため）。
    const wrapper = {
      match: (request: RequestInfo | URL, options?: CacheQueryOptions) =>
        real.match(request, options),
      put: (request: RequestInfo | URL, response: Response) =>
        real.put(request, response),
      delete: (request: RequestInfo | URL, options?: CacheQueryOptions) =>
        real.delete(request, options),
      keys: (request?: RequestInfo | URL, options?: CacheQueryOptions) => {
        const keysImpl = (real as Partial<{ keys: CacheKeysFn }>).keys;
        return keysImpl === undefined
          ? Promise.reject(new Error("Cache.keys() 未実装ランタイム"))
          : keysImpl.call(real, request, options);
      },
      ...overrides,
    };
    return wrapper;
  },
  has: (cacheName) => caches.has(cacheName),
  delete: (cacheName) => caches.delete(cacheName),
  keys: () => caches.keys(),
  match: (request, options) => caches.match(request, options),
});

const URL_A = "https://example.com/assets/a.bin";
const BYTES_A = new Uint8Array([1, 2, 3, 4, 5]);

/** decodeGzip テスト用の gzip 圧縮（CompressionStream = Web 標準）。 */
const gzipBytes = async (
  bytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> => {
  const stream = new Blob([new Uint8Array(bytes)]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

// Cache.keys() の実装有無はランタイム依存（Deno 2.9 で実装）。listCachedUrls のテストを
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

Deno.test("single-flight: 同一 URL の並行呼び出しは 1 フライトに合流し fetch は 1 回", async () => {
  const cacheName = uniqueCacheName();
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    return new Response(BYTES_A);
  });
  try {
    const first = fetchBytes(URL_A, { cacheName, fetch });
    const second = fetchBytes(URL_A, { cacheName, fetch });
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assertEquals(a, BYTES_A);
    assertEquals(b, BYTES_A);
    assertEquals(calls.length, 1);

    // 収束後は正常な 1 エントリでヒットする（フライトは閉じている）。
    await fetchBytes(URL_A, { cacheName, fetch });
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("single-flight: decode は合流後に各呼び出しが自分のものを適用する", async () => {
  const cacheName = uniqueCacheName();
  const original = new Uint8Array([10, 20, 30, 40]);
  const compressed = await gzipBytes(original);
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    return new Response(compressed);
  });
  try {
    // 先行呼び出しは decode あり、合流者は decode なし。合流者には保存形 raw が渡る。
    const withDecode = fetchBytes(URL_A, {
      cacheName,
      fetch,
      decode: decodeGzip,
    });
    const withoutDecode = fetchBytes(URL_A, { cacheName, fetch });
    gate.resolve();
    const [decoded, raw] = await Promise.all([withDecode, withoutDecode]);
    assertEquals(decoded, original);
    assertEquals(raw, compressed);
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("single-flight: 合流者の validate 失敗はその呼び出しだけ throw する", async () => {
  const cacheName = uniqueCacheName();
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    return new Response(BYTES_A);
  });
  try {
    const leader = fetchBytes(URL_A, { cacheName, fetch });
    const strictJoiner = fetchBytes(URL_A, {
      cacheName,
      fetch,
      validate: () => {
        throw new Error("joiner だけの検証失敗");
      },
    });
    gate.resolve();
    assertEquals(await leader, BYTES_A);
    await assertRejects(() => strictJoiner, Error, "joiner だけの検証失敗");
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("single-flight: 取得失敗は合流全員へ伝播するが、失敗は記憶されず次の呼び出しで再取得する", async () => {
  const cacheName = uniqueCacheName();
  const gate = Promise.withResolvers<void>();
  let attempt = 0;
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    attempt++;
    return attempt === 1
      ? new Response("down", { status: 503, statusText: "Service Unavailable" })
      : new Response(BYTES_A);
  });
  try {
    const first = fetchBytes(URL_A, { cacheName, fetch });
    const second = fetchBytes(URL_A, { cacheName, fetch });
    gate.resolve();
    await assertRejects(() => first, Error, "HTTP 503");
    await assertRejects(() => second, Error, "HTTP 503");
    assertEquals(calls.length, 1);

    // フライトは閉じているので、次の呼び出しは新規に取得して成功する。
    assertEquals(await fetchBytes(URL_A, { cacheName, fetch }), BYTES_A);
    assertEquals(calls.length, 2);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("single-flight: onProgress は合流者へも fan-out される", async () => {
  const cacheName = uniqueCacheName();
  const gate = Promise.withResolvers<void>();
  const { fetch } = mockFetch(async () => {
    await gate.promise;
    return chunkedResponse([
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4, 5]),
    ]);
  });
  const leaderProgress: number[] = [];
  const joinerProgress: number[] = [];
  try {
    const leader = fetchBytes(URL_A, {
      cacheName,
      fetch,
      onProgress: (p) => leaderProgress.push(p.loaded),
    });
    const joiner = fetchBytes(URL_A, {
      cacheName,
      fetch,
      onProgress: (p) => joinerProgress.push(p.loaded),
    });
    gate.resolve();
    await Promise.all([leader, joiner]);
    assertEquals(leaderProgress, [2, 5]);
    assertEquals(joinerProgress, [2, 5]);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("single-flight: 途中合流者には直近の進捗が合流時に 1 回即時通知される", async () => {
  const cacheName = uniqueCacheName();
  // 手動制御ストリームで「チャンク1 → 合流 → チャンク2」の順序を決定的に作る。
  let controller!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(c) {
      controller = c;
    },
  });
  const { fetch } = mockFetch(() => new Response(stream));
  const leaderProgress: number[] = [];
  const leaderFirstChunk = Promise.withResolvers<void>();
  try {
    const leader = fetchBytes(URL_A, {
      cacheName,
      fetch,
      onProgress: (p) => {
        leaderProgress.push(p.loaded);
        leaderFirstChunk.resolve();
      },
    });
    controller.enqueue(new Uint8Array([1, 2]));
    await leaderFirstChunk.promise; // ここで state.last = {loaded: 2}
    const joinerProgress: number[] = [];
    const joiner = fetchBytes(URL_A, {
      cacheName,
      fetch,
      onProgress: (p) => joinerProgress.push(p.loaded),
    });
    // 合流時リプレイは合流の同期区間で走る（fetchBytes が最初の await に達した時点で通知済み）。
    assertEquals(joinerProgress, [2]);
    controller.enqueue(new Uint8Array([3, 4, 5]));
    controller.close();
    await Promise.all([leader, joiner]);
    assertEquals(leaderProgress, [2, 5]);
    assertEquals(joinerProgress, [2, 5]);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("single-flight: onProgress リスナーの throw は取得を巻き添えにしない（隔離+警告）", async () => {
  const cacheName = uniqueCacheName();
  const gate = Promise.withResolvers<void>();
  const { fetch } = mockFetch(async () => {
    await gate.promise;
    return chunkedResponse([new Uint8Array([1, 2, 3])]);
  });
  const seen: number[] = [];
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(String(args[0]));
  };
  try {
    // leader 自身のリスナーが事故を起こしても、合流フライト全体（joiner の取得）は続行する。
    const bad = fetchBytes(URL_A, {
      cacheName,
      fetch,
      onProgress: () => {
        throw new Error("リスナー事故");
      },
    });
    const good = fetchBytes(URL_A, {
      cacheName,
      fetch,
      onProgress: (p) => seen.push(p.loaded),
    });
    gate.resolve();
    const [a, b] = await Promise.all([bad, good]);
    assertEquals(a, new Uint8Array([1, 2, 3]));
    assertEquals(b, new Uint8Array([1, 2, 3]));
    assertEquals(seen, [3]);
    assertEquals(warns.some((w) => w.includes("onProgress")), true);
  } finally {
    console.warn = origWarn;
    await caches.delete(cacheName);
  }
});

Deno.test("single-flight: cache:false の呼び出しは合流しない（毎回取得の意図を尊重）", async () => {
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    return new Response(BYTES_A);
  });
  const first = fetchBytes(URL_A, { cache: false, fetch });
  const second = fetchBytes(URL_A, { cache: false, fetch });
  gate.resolve();
  await Promise.all([first, second]);
  assertEquals(calls.length, 2);
});

Deno.test("single-flight: cacheName が異なる呼び出しは合流しない（キーは cacheName + URL）", async () => {
  const cacheA = uniqueCacheName();
  const cacheB = uniqueCacheName();
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    return new Response(BYTES_A);
  });
  try {
    const first = fetchBytes(URL_A, { cacheName: cacheA, fetch });
    const second = fetchBytes(URL_A, { cacheName: cacheB, fetch });
    gate.resolve();
    await Promise.all([first, second]);
    assertEquals(calls.length, 2);
  } finally {
    await caches.delete(cacheA);
    await caches.delete(cacheB);
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

Deno.test("fetchBytes: init（ヘッダ・signal）は fetch へそのまま渡る", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, inits } = mockFetch(() => new Response(BYTES_A));
  const controller = new AbortController();
  try {
    await fetchBytes(URL_A, {
      cacheName,
      fetch,
      init: {
        headers: { authorization: "Bearer token" },
        signal: controller.signal,
      },
    });
    assertEquals(inits.length, 1);
    assertEquals(
      new Headers(inits[0]?.headers).get("authorization"),
      "Bearer token",
    );
    assertStrictEquals(inits[0]?.signal, controller.signal);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: GET 以外はキャッシュ有効のままだと throw、cache:false なら通る", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls, inits } = mockFetch(() => new Response(BYTES_A));
  try {
    const error = await assertRejects(
      () => fetchBytes(URL_A, { cacheName, fetch, init: { method: "POST" } }),
      Error,
    );
    assertStringIncludes(error.message, "cache: false");
    assertEquals(calls.length, 0); // fetch 前に fail loud。

    const bytes = await fetchBytes(URL_A, {
      cacheName,
      fetch,
      cache: false,
      init: { method: "POST" },
    });
    assertEquals(bytes, BYTES_A);
    assertEquals(inits[0]?.method, "POST");
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: decode は利用形を返し、cache には保存形 raw がそのまま入る", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const decode = (raw: Uint8Array) => raw.map((byte) => byte * 2);
  const decoded = new Uint8Array([2, 4, 6, 8, 10]);
  try {
    const first = await fetchBytes(URL_A, { cacheName, fetch, decode });
    assertEquals(first, decoded);

    // cache に入るのは decode 前の保存形 raw（保存形 ≠ 利用形）。
    const cache = await caches.open(cacheName);
    const cachedResponse = await cache.match(URL_A);
    assertExists(cachedResponse);
    assertEquals(new Uint8Array(await cachedResponse.arrayBuffer()), BYTES_A);

    // キャッシュヒット側にも decode が適用され、network には出ない。
    const second = await fetchBytes(URL_A, { cacheName, fetch, decode });
    assertEquals(second, decoded);
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: validate は decode 前の保存形 raw を受ける（両経路で契約を凍結）", async () => {
  const cacheName = uniqueCacheName();
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  const seen: Uint8Array[] = [];
  const validate = (bytes: Uint8Array) => {
    seen.push(bytes.slice());
  };
  const decode = (raw: Uint8Array) => new Uint8Array([raw.length]);
  try {
    const first = await fetchBytes(URL_A, {
      cacheName,
      fetch,
      validate,
      decode,
    });
    assertEquals(first, new Uint8Array([5])); // network 側: 戻り値は decode 適用後。
    const second = await fetchBytes(URL_A, {
      cacheName,
      fetch,
      validate,
      decode,
    });
    assertEquals(second, new Uint8Array([5])); // ヒット側も同じ利用形。
    assertEquals(seen, [BYTES_A, BYTES_A]); // validate は両経路とも raw（decoded ではない）。
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: キャッシュヒットの decode 失敗は evict して network から取り直す（self-heal）", async () => {
  const cacheName = uniqueCacheName();
  const original = new Uint8Array([10, 20, 30, 40]);
  const compressed = await gzipBytes(original);
  const { fetch, calls } = mockFetch(() => new Response(compressed));
  try {
    // 壊れた gzip（保存形として破損）を直接キャッシュへ仕込む。
    const cache = await caches.open(cacheName);
    await cache.put(URL_A, new Response(new Uint8Array([9, 9, 9])));

    const healed = await fetchBytes(URL_A, {
      cacheName,
      fetch,
      decode: decodeGzip,
    });
    assertEquals(healed, original); // evict → network の正常 gzip を解凍して返す。
    assertEquals(calls.length, 1);

    // 取り直した保存形（gzip のまま）がキャッシュされ、次はヒットで network 0 回。
    const cachedResponse = await cache.match(URL_A);
    assertExists(cachedResponse);
    assertEquals(
      new Uint8Array(await cachedResponse.arrayBuffer()),
      compressed,
    );
    await fetchBytes(URL_A, { cacheName, fetch, decode: decodeGzip });
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: network 取得物の decode 失敗は throw し、キャッシュしない", async () => {
  const cacheName = uniqueCacheName();
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    await assertRejects(
      () =>
        fetchBytes(URL_A, {
          cacheName,
          fetch,
          decode: () => {
            throw new Error("decode 不能");
          },
        }),
      Error,
      "decode 不能",
    );
    assertEquals(calls.length, 1);

    const cache = await caches.open(cacheName);
    assertEquals(await cache.match(URL_A), undefined); // decode 不能物は保存されない。
  } finally {
    await caches.delete(cacheName);
  }
});

Deno.test("fetchBytes: cache:false（素の fetch 経路）でも async decode が適用される", async () => {
  const cacheName = uniqueCacheName();
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  const bytes = await fetchBytes(URL_A, {
    cacheName,
    cache: false,
    fetch,
    decode: (raw) => Promise.resolve(new Uint8Array([raw.length])),
  });
  assertEquals(bytes, new Uint8Array([5]));
});

Deno.test("decodeGzip: gzip を解凍して元のバイト列を返し、不正入力は throw する", async () => {
  const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const compressed = await gzipBytes(original);
  assertEquals(await decodeGzip(compressed), original);
  await assertRejects(() => decodeGzip(new Uint8Array([1, 2, 3])));
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
    "listCachedUrls: keys() 未実装ランタイム（Deno 2.8 以前）では fail loud に throw する",
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
