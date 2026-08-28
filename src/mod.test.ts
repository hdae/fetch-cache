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
  evict,
  evictUrl,
  fetchBytes,
  listCachedUrls,
  listKeys,
  prefetchUrl,
} from "./mod.ts";
// 配列キーの注入導管は内部モジュール専用（公開 `key` オプションは 0.5.0 で撤去 —
// DECIDED: docs/decisions/0008）。直列化層・プレフィックス管理の契約はここ経由で凍結する。
import { fetchBytesWithKey, prefetchUrlWithKey } from "./core.ts";
import {
  chunkedResponse,
  mockFetch,
  uniqueCacheName,
} from "./testing/mock_fetch.ts";

// 名前空間は内部固定 1 個（DECIDED: docs/decisions/0006 §3）。テストの隔離は
// 「テスト毎に finally で名前空間ごと削除」+「ファイル内逐次実行」で行う。
const CACHE_NAME = "fetch-cache";

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
const URL_B = "https://example.com/assets/b.bin";
const BYTES_A = new Uint8Array([1, 2, 3, 4, 5]);
const BYTES_B = new Uint8Array([6, 7, 8]);

/** 期待 sha256 の組み立て（native の一括 digest — 実装と独立な対照）。 */
const sha256HexOf = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

const BYTES_A_SHA256 = await sha256HexOf(BYTES_A);
const BYTES_B_SHA256 = await sha256HexOf(BYTES_B);

// 記録ハッシュのヘッダ名（公開契約として凍結 — DECIDED: docs/decisions/0006 §2）。
const SHA_HEADER = "x-fetch-cache-sha256";

/**
 * 配列キーの直列化形式のゴールデン（保存形式は公開契約として凍結する）:
 * 予約 origin `https://fetch-cache.invalid/v1/` + セグメント毎に JSON.stringify →
 * encodeURIComponent。実装のヘルパを使わずテスト側で独立に組み立てる（トートロジー回避）。
 */
const keyUrl = (...elements: (string | number | boolean)[]): string =>
  "https://fetch-cache.invalid/v1/" +
  elements.map((element) => encodeURIComponent(JSON.stringify(element))).join(
    "/",
  );

/** decodeGzip テスト用の gzip 圧縮（CompressionStream = Web 標準）。 */
const gzipBytes = async (
  bytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> => {
  const stream = new Blob([new Uint8Array(bytes)]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

// Cache.keys() の実装有無はランタイム依存（Deno 2.9 で実装）。keys() に依存するテストを
// 実行時サポートで分岐する（実装側 supportsKeys と同じ feature-detect）。
const probeName = uniqueCacheName();
const probeCache = await caches.open(probeName);
const runtimeHasCacheKeys =
  typeof (probeCache as Partial<{ keys: () => Promise<readonly Request[]> }>)
    .keys === "function";
await caches.delete(probeName); // probe の名前空間を残さない。

Deno.test("fetchBytes: ミスで fetch 1回、2回目はキャッシュヒットで fetch 0回", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    const first = await fetchBytes(URL_A, { fetch });
    assertEquals(first, BYTES_A);
    assertEquals(calls, [URL_A]);

    const second = await fetchBytes(URL_A, { fetch });
    assertEquals(second, BYTES_A);
    assertEquals(calls.length, 1); // ヒット時は network に出ない。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: cache:false は Cache API を触らず毎回 fetch する", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    await fetchBytes(URL_A, { cache: false, fetch });
    await fetchBytes(URL_A, { cache: false, fetch });
    assertEquals(calls.length, 2);

    // cache:false ではキャッシュに書き込まれない。
    const cache = await caches.open(CACHE_NAME);
    assertEquals(await cache.match(URL_A), undefined);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: 破損キャッシュは evict して network から取り直す（self-heal）", async () => {
  const corrupt = new Uint8Array([9, 9, 9]);
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const validate = (bytes: Uint8Array) => {
    if (bytes.length !== BYTES_A.length) throw new Error("破損");
  };
  try {
    // 破損エントリを直接キャッシュへ仕込む。
    const cache = await caches.open(CACHE_NAME);
    await cache.put(URL_A, new Response(corrupt));

    const healed = await fetchBytes(URL_A, { validate, fetch });
    assertEquals(healed, BYTES_A);
    assertEquals(calls.length, 1); // evict → network 1回。

    // 取り直した正常物がキャッシュされている（再呼び出しで fetch 0回）。
    await fetchBytes(URL_A, { validate, fetch });
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: network 取得物の validate 失敗は throw し、キャッシュしない", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    await assertRejects(
      () =>
        fetchBytes(URL_A, {
          fetch,
          validate: () => {
            throw new Error("常に不正");
          },
        }),
      Error,
      "常に不正",
    );
    assertEquals(calls.length, 1);

    const cache = await caches.open(CACHE_NAME);
    assertEquals(await cache.match(URL_A), undefined); // 不正物は保存されない。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: onProgress はチャンク毎に loaded を累積し、content-length があれば total を持つ", async () => {
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
  const { fetch } = mockFetch(() =>
    chunkedResponse(chunks, { "content-length": "7" })
  );
  const events: { loaded: number; total?: number }[] = [];
  try {
    const bytes = await fetchBytes(URL_A, {
      fetch,
      onProgress: (progress) => events.push(progress),
    });
    assertEquals(bytes, new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
    assertEquals(events, [{ loaded: 3, total: 7 }, { loaded: 7, total: 7 }]);

    // キャッシュヒット時は onProgress が呼ばれない。
    events.length = 0;
    await fetchBytes(URL_A, {
      fetch,
      onProgress: (progress) => events.push(progress),
    });
    assertEquals(events, []);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: content-length が無ければ total は undefined", async () => {
  const { fetch } = mockFetch(() =>
    chunkedResponse([new Uint8Array([1, 2, 3])])
  );
  const events: { loaded: number; total?: number }[] = [];
  try {
    await fetchBytes(URL_A, {
      fetch,
      onProgress: (progress) => events.push(progress),
    });
    assertEquals(events, [{ loaded: 3, total: undefined }]);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: HTTP エラーは status 入りメッセージで throw する", async () => {
  const { fetch } = mockFetch(() =>
    new Response("missing", { status: 404, statusText: "Not Found" })
  );
  try {
    const error = await assertRejects(
      () => fetchBytes(URL_A, { fetch }),
      Error,
    );
    assertStringIncludes(error.message, "fetch-cache: HTTP 404 Not Found");
    assertStringIncludes(error.message, URL_A);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("single-flight: 同一 URL の並行呼び出しは 1 フライトに合流し fetch は 1 回", async () => {
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    return new Response(BYTES_A);
  });
  try {
    const first = fetchBytes(URL_A, { fetch });
    const second = fetchBytes(URL_A, { fetch });
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assertEquals(a, BYTES_A);
    assertEquals(b, BYTES_A);
    assertEquals(calls.length, 1);

    // 収束後は正常な 1 エントリでヒットする（フライトは閉じている）。
    await fetchBytes(URL_A, { fetch });
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("single-flight: decode は合流後に各呼び出しが自分のものを適用する", async () => {
  const original = new Uint8Array([10, 20, 30, 40]);
  const compressed = await gzipBytes(original);
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    return new Response(compressed);
  });
  try {
    // 先行呼び出しは decode あり、合流者は decode なし。合流者には保存形 raw が渡る。
    const withDecode = fetchBytes(URL_A, { fetch, decode: decodeGzip });
    const withoutDecode = fetchBytes(URL_A, { fetch });
    gate.resolve();
    const [decoded, raw] = await Promise.all([withDecode, withoutDecode]);
    assertEquals(decoded, original);
    assertEquals(raw, compressed);
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("single-flight: 合流者の validate 失敗はその呼び出しだけ throw する", async () => {
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    return new Response(BYTES_A);
  });
  try {
    const leader = fetchBytes(URL_A, { fetch });
    const strictJoiner = fetchBytes(URL_A, {
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
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("single-flight: 取得失敗は合流全員へ伝播するが、失敗は記憶されず次の呼び出しで再取得する", async () => {
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
    const first = fetchBytes(URL_A, { fetch });
    const second = fetchBytes(URL_A, { fetch });
    gate.resolve();
    await assertRejects(() => first, Error, "HTTP 503");
    await assertRejects(() => second, Error, "HTTP 503");
    assertEquals(calls.length, 1);

    // フライトは閉じているので、次の呼び出しは新規に取得して成功する。
    assertEquals(await fetchBytes(URL_A, { fetch }), BYTES_A);
    assertEquals(calls.length, 2);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("single-flight: onProgress は合流者へも fan-out される", async () => {
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
      fetch,
      onProgress: (p) => leaderProgress.push(p.loaded),
    });
    const joiner = fetchBytes(URL_A, {
      fetch,
      onProgress: (p) => joinerProgress.push(p.loaded),
    });
    gate.resolve();
    await Promise.all([leader, joiner]);
    assertEquals(leaderProgress, [2, 5]);
    assertEquals(joinerProgress, [2, 5]);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("single-flight: 途中合流者には直近の進捗が合流時に 1 回即時通知される", async () => {
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
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("single-flight: onProgress リスナーの throw は取得を巻き添えにしない（隔離+警告）", async () => {
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
      fetch,
      onProgress: () => {
        throw new Error("リスナー事故");
      },
    });
    const good = fetchBytes(URL_A, {
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
    await caches.delete(CACHE_NAME);
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

Deno.test("single-flight: 同一 URL でも key の有無でキーが違えば合流しない", async () => {
  // 合流キーは cache と同じキー空間（key ?? URL）。URL キーと配列キーは別エントリなので
  // 別フライトになる（DECIDED: docs/decisions/0006）。
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    return new Response(BYTES_A);
  });
  try {
    const urlKeyed = fetchBytes(URL_A, { fetch });
    const arrayKeyed = fetchBytesWithKey(URL_A, ["k1"], { fetch });
    gate.resolve();
    await Promise.all([urlKeyed, arrayKeyed]);
    assertEquals(calls.length, 2);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: body が null の応答は arrayBuffer フォールバックで空 bytes・onProgress 1回", async () => {
  const { fetch, calls } = mockFetch(() => new Response(null));
  const events: { loaded: number; total?: number }[] = [];
  try {
    const bytes = await fetchBytes(URL_A, {
      fetch,
      onProgress: (progress) => events.push(progress),
    });
    assertEquals(bytes, new Uint8Array(0));
    assertEquals(events, [{ loaded: 0, total: undefined }]);

    // 空エントリとしてキャッシュされ、2 回目はヒットする。
    const second = await fetchBytes(URL_A, { fetch });
    assertEquals(second, new Uint8Array(0));
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: self-heal の再取得も validate 失敗なら throw し、エントリは残らない", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const validate = () => {
    throw new Error("常に不正");
  };
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(URL_A, new Response(new Uint8Array([9])));

    await assertRejects(
      () => fetchBytes(URL_A, { validate, fetch }),
      Error,
      "常に不正",
    );
    // evict → network 1 回 → validate 失敗で終端（無限ループしない）。
    assertEquals(calls.length, 1);
    // 破損エントリは evict 済みで、不正な取得物も put されない。
    assertEquals(await cache.match(URL_A), undefined);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: async validate の reject も拾い、resolve は通す", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  try {
    await assertRejects(
      () =>
        fetchBytes(URL_A, {
          fetch,
          validate: () => Promise.reject(new Error("async 不正")),
        }),
      Error,
      "async 不正",
    );

    const bytes = await fetchBytes(URL_A, {
      fetch,
      validate: () => Promise.resolve(),
    });
    assertEquals(bytes, BYTES_A);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: fetch の transport 例外は握りつぶさず伝播する", async () => {
  const { fetch } = mockFetch(() =>
    Promise.reject(new Error("connection refused"))
  );
  try {
    await assertRejects(
      () => fetchBytes(URL_A, { fetch }),
      Error,
      "connection refused",
    );
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes / evictUrl: URL オブジェクト入力は文字列と同じキーになる", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    const bytes = await fetchBytes(new URL(URL_A), { fetch });
    assertEquals(bytes, BYTES_A);

    // 文字列入力で同一キーにヒットする（URL→href の正規化が一致）。
    await fetchBytes(URL_A, { fetch });
    assertEquals(calls.length, 1);

    assertEquals(await evictUrl(new URL(URL_A)), true);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: 正常キャッシュヒットは validate 通過で network に出ない", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const validate = (bytes: Uint8Array) => {
    if (bytes.length !== BYTES_A.length) throw new Error("破損");
  };
  try {
    await fetchBytes(URL_A, { validate, fetch });
    const second = await fetchBytes(URL_A, { validate, fetch });
    assertEquals(second, BYTES_A);
    assertEquals(calls.length, 1); // ヒット + validate 通過 → network 0 回。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: HTTP エラー時は body を cancel して接続リソースを解放する", async () => {
  let response: Response | undefined;
  const { fetch } = mockFetch(() => {
    response = new Response("missing", {
      status: 404,
      statusText: "Not Found",
    });
    return response;
  });
  try {
    await assertRejects(() => fetchBytes(URL_A, { fetch }), Error);
    assertEquals(response?.bodyUsed, true); // cancel 済み＝disturbed。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: cache.put 失敗は成功したダウンロードを巻き添えにせず通知する", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  const notified: CacheErrorContext[] = [];
  try {
    const bytes = await fetchBytes(URL_A, {
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
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: cache 読出し失敗は miss として network へ縮退し通知する", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const notified: CacheErrorContext[] = [];
  try {
    const bytes = await fetchBytes(URL_A, {
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
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: caches.open 失敗はキャッシュ無しの素の fetch へ縮退する", async () => {
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
    fetch,
    caches: brokenCaches,
    onCacheError: (context) => notified.push(context),
  });
  assertEquals(bytes, BYTES_A);
  assertEquals(calls.length, 1);
  assertEquals(notified.map((context) => context.op), ["open"]); // open は 1 回だけ試行。
});

Deno.test("fetchBytes: self-heal 中の evict 失敗でも再取得は続行し通知する", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const notified: CacheErrorContext[] = [];
  const validate = (bytes: Uint8Array) => {
    if (bytes.length !== BYTES_A.length) throw new Error("破損");
  };
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(URL_A, new Response(new Uint8Array([9])));

    const bytes = await fetchBytes(URL_A, {
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
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: init（ヘッダ・signal）は fetch へそのまま渡る", async () => {
  const { fetch, inits } = mockFetch(() => new Response(BYTES_A));
  const controller = new AbortController();
  try {
    await fetchBytes(URL_A, {
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
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: GET 以外はキャッシュ有効のままだと throw、cache:false なら通る", async () => {
  const { fetch, calls, inits } = mockFetch(() => new Response(BYTES_A));
  try {
    const error = await assertRejects(
      () => fetchBytes(URL_A, { fetch, init: { method: "POST" } }),
      Error,
    );
    assertStringIncludes(error.message, "cache: false");
    assertEquals(calls.length, 0); // fetch 前に fail loud。

    const bytes = await fetchBytes(URL_A, {
      fetch,
      cache: false,
      init: { method: "POST" },
    });
    assertEquals(bytes, BYTES_A);
    assertEquals(inits[0]?.method, "POST");
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: decode は利用形を返し、cache には保存形 raw がそのまま入る", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const decode = (raw: Uint8Array) => raw.map((byte) => byte * 2);
  const decoded = new Uint8Array([2, 4, 6, 8, 10]);
  try {
    const first = await fetchBytes(URL_A, { fetch, decode });
    assertEquals(first, decoded);

    // cache に入るのは decode 前の保存形 raw（保存形 ≠ 利用形）。
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(URL_A);
    assertExists(cachedResponse);
    assertEquals(new Uint8Array(await cachedResponse.arrayBuffer()), BYTES_A);

    // キャッシュヒット側にも decode が適用され、network には出ない。
    const second = await fetchBytes(URL_A, { fetch, decode });
    assertEquals(second, decoded);
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: validate は decode 前の保存形 raw を受ける（両経路で契約を凍結）", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  const seen: Uint8Array[] = [];
  const validate = (bytes: Uint8Array) => {
    seen.push(bytes.slice());
  };
  const decode = (raw: Uint8Array) => new Uint8Array([raw.length]);
  try {
    const first = await fetchBytes(URL_A, { fetch, validate, decode });
    assertEquals(first, new Uint8Array([5])); // network 側: 戻り値は decode 適用後。
    const second = await fetchBytes(URL_A, { fetch, validate, decode });
    assertEquals(second, new Uint8Array([5])); // ヒット側も同じ利用形。
    assertEquals(seen, [BYTES_A, BYTES_A]); // validate は両経路とも raw（decoded ではない）。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: キャッシュヒットの decode 失敗は evict して network から取り直す（self-heal）", async () => {
  const original = new Uint8Array([10, 20, 30, 40]);
  const compressed = await gzipBytes(original);
  const { fetch, calls } = mockFetch(() => new Response(compressed));
  try {
    // 壊れた gzip（保存形として破損）を直接キャッシュへ仕込む。
    const cache = await caches.open(CACHE_NAME);
    await cache.put(URL_A, new Response(new Uint8Array([9, 9, 9])));

    const healed = await fetchBytes(URL_A, { fetch, decode: decodeGzip });
    assertEquals(healed, original); // evict → network の正常 gzip を解凍して返す。
    assertEquals(calls.length, 1);

    // 取り直した保存形（gzip のまま）がキャッシュされ、次はヒットで network 0 回。
    const cachedResponse = await cache.match(URL_A);
    assertExists(cachedResponse);
    assertEquals(
      new Uint8Array(await cachedResponse.arrayBuffer()),
      compressed,
    );
    await fetchBytes(URL_A, { fetch, decode: decodeGzip });
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: network 取得物の decode 失敗は throw し、キャッシュしない", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    await assertRejects(
      () =>
        fetchBytes(URL_A, {
          fetch,
          decode: () => {
            throw new Error("decode 不能");
          },
        }),
      Error,
      "decode 不能",
    );
    assertEquals(calls.length, 1);

    const cache = await caches.open(CACHE_NAME);
    assertEquals(await cache.match(URL_A), undefined); // decode 不能物は保存されない。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: cache:false（素の fetch 経路）でも async decode が適用される", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  const bytes = await fetchBytes(URL_A, {
    cache: false,
    fetch,
    decode: (raw) => Promise.resolve(new Uint8Array([raw.length])),
  });
  assertEquals(bytes, new Uint8Array([5]));
});

// --- 配列 key（キャッシュキーと取得元 URL の分離。HF 層専用の内部導管 —
//     公開 `key` オプションは 0.5.0 で撤去。DECIDED: docs/decisions/0008）---

Deno.test("key: 格納も読出しもキー側で行い、取得元 URL が変わってもヒットする", async () => {
  const KEY = ["models", "a"] as const;
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    const first = await fetchBytesWithKey(URL_A, KEY, { fetch });
    assertEquals(first, BYTES_A);
    assertEquals(calls, [URL_A]); // network に出るのは取得元 URL のまま。

    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(keyUrl("models", "a"));
    assertExists(cached); // 直列化形式（ゴールデン）もここで凍結される。
    assertEquals(new Uint8Array(await cached.arrayBuffer()), BYTES_A);
    assertEquals(await cache.match(URL_A), undefined); // URL 側にはエントリを作らない。

    // 取得元が別 URL（別 revision 相当）でも、同じ key ならヒットする＝これが分離の目的。
    const second = await fetchBytesWithKey(URL_B, KEY, { fetch });
    assertEquals(second, BYTES_A);
    assertEquals(calls.length, 1);
    assertEquals(await cache.match(URL_B), undefined);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("key: 破損したキー側エントリを evict して取り直す（self-heal もキー側）", async () => {
  const KEY = ["models", "heal"] as const;
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const validate = (bytes: Uint8Array) => {
    if (bytes.length !== BYTES_A.length) throw new Error("破損");
  };
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(keyUrl("models", "heal"), new Response(new Uint8Array(3)));

    const healed = await fetchBytesWithKey(URL_A, KEY, { validate, fetch });
    assertEquals(healed, BYTES_A);
    assertEquals(calls.length, 1); // evict → network 1 回。

    // 取り直した正常物はキー側へ置き換わっている（再呼び出しで network 0 回）。
    const cached = await cache.match(keyUrl("models", "heal"));
    assertExists(cached);
    assertEquals(new Uint8Array(await cached.arrayBuffer()), BYTES_A);
    await fetchBytesWithKey(URL_A, KEY, { validate, fetch });
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("key: 同一 key・別 URL の並行呼び出しは合流し fetch は 1 回", async () => {
  const KEY = ["models", "join"] as const;
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    return new Response(BYTES_A);
  });
  try {
    // 同一キーを名乗る = 内容同一の主張なので、取得元が違っても合流してよい（ADR 0006）。
    const first = fetchBytesWithKey(URL_A, KEY, { fetch });
    const second = fetchBytesWithKey(URL_B, KEY, { fetch });
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assertEquals(a, BYTES_A);
    assertEquals(b, BYTES_A);
    assertEquals(calls, [URL_A]); // 先行呼び出しの取得元だけが network に出る。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("key: 直列化は単射（セグメント境界・要素型・非 ASCII が衝突しない）", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  // 衝突しやすい形の組: `/` 入り文字列 vs 境界、"1"（文字列） vs 1（数値） vs true。
  const keys: (string | number | boolean)[][] = [
    ["a", "b/c"],
    ["a/b", "c"],
    ["a", "b", "c"],
    ["1"],
    [1],
    [true],
    ["日本語 キー%22"],
  ];
  try {
    for (const key of keys) await fetchBytesWithKey(URL_A, key, { fetch });
    assertEquals(calls.length, keys.length); // 全て別キー = 全て network に出る。

    const cache = await caches.open(CACHE_NAME);
    const stored = (await cache.keys()).map((request) => request.url);
    assertEquals(new Set(stored).size, keys.length); // エントリも衝突していない。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("key: 不正な指定は network に出る前に fail loud", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  // 空配列・オブジェクト要素・非有限数値・cache:false 併用はいずれも呼び出し側のバグ。
  await assertRejects(
    () => fetchBytesWithKey(URL_A, [], { fetch }),
    Error,
    "1 要素以上",
  );
  await assertRejects(
    () =>
      fetchBytesWithKey(URL_A, ["a", { x: 1 } as unknown as string], { fetch }),
    Error,
    "string | number | boolean",
  );
  await assertRejects(
    () => fetchBytesWithKey(URL_A, ["a", Number.NaN], { fetch }),
    Error,
    "有限値",
  );
  await assertRejects(
    () => fetchBytesWithKey(URL_A, ["a"], { cache: false, fetch }),
    Error,
    "cache: false と key",
  );
  assertEquals(calls.length, 0);
});

Deno.test("予約 origin（fetch-cache.invalid）は取得元 URL に使えない", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const reserved = "https://fetch-cache.invalid/v1/%22x%22";
  await assertRejects(() => fetchBytes(reserved, { fetch }), Error, "予約");
  await assertRejects(() => prefetchUrl(reserved, { fetch }), Error, "予約");
  await assertRejects(() => evictUrl(reserved), Error, "予約");
  assertEquals(calls.length, 0);
});

// --- URL 正規化（storage / single-flight / 予約判定を Cache API と同じ正規化で統一）---

Deno.test("URL 正規化: 大文字 scheme/host・既定 port・fragment の表記違いは同一キーにヒットする", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    await fetchBytes(URL_A, { fetch });
    // Cache API はキーを正規化して格納する。入口で正規化しないと match は当たるのに
    // ガード・合流キーだけ表記のまま、という食い違いが生じる（レビュー CORE-001）。
    const spelled = await fetchBytes("HTTPS://EXAMPLE.COM:443/assets/a.bin#f", {
      fetch,
    });
    assertEquals(spelled, BYTES_A);
    assertEquals(calls.length, 1); // 表記違いでもヒット（network 0 回）。
    assertEquals(await evictUrl("https://example.com:443/assets/a.bin"), true);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("URL 正規化: 表記違いの並行呼び出しも 1 フライトに合流する（二重取得しない）", async () => {
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    return new Response(BYTES_A);
  });
  try {
    const first = fetchBytes(URL_A, { fetch });
    const second = fetchBytes("https://EXAMPLE.com/assets/a.bin#frag", {
      fetch,
    });
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assertEquals(a, BYTES_A);
    assertEquals(b, BYTES_A);
    assertEquals(calls.length, 1); // 合流キーも正規化済み URL（別フライトにならない）。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("予約 origin ガード: 大文字表記もすり抜けず、network に出る前に fail loud", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  // 大文字表記は Cache API の正規化で予約 origin に到達する（生文字列前方一致では素通り）。
  const uppercase = "HTTPS://FETCH-CACHE.INVALID/v1/%22x%22";
  await assertRejects(() => fetchBytes(uppercase, { fetch }), Error, "予約");
  await assertRejects(() => prefetchUrl(uppercase, { fetch }), Error, "予約");
  await assertRejects(() => evictUrl(uppercase), Error, "予約");
  assertEquals(calls.length, 0);
});

Deno.test({
  name:
    "予約 origin ガード: 似て非なる origin は過剰拒否せず、一覧からも巻き添え除外しない",
  ignore: !runtimeHasCacheKeys,
  fn: async () => {
    const { fetch } = mockFetch(() => new Response(BYTES_A));
    // 生文字列の前方一致だと "https://fetch-cache.invalid" の後にホストが続く別 origin を
    // 巻き添えにする。origin の等価判定なら正当な URL として通る。
    const lookalike = "https://fetch-cache.invalid.example.com/a.bin";
    try {
      assertEquals(await fetchBytes(lookalike, { fetch }), BYTES_A);
      assertEquals(await listCachedUrls(), [lookalike]);
      assertEquals(await evictUrl(lookalike), true);
    } finally {
      await caches.delete(CACHE_NAME);
    }
  },
});

Deno.test("解釈できない URL は fail loud（fetch へ丸投げしない）", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  // location の無いランタイム（Deno）では相対 URL は解決できない = 呼び出し側のバグ。
  await assertRejects(
    () => fetchBytes("assets/a.bin", { fetch }),
    Error,
    "URL を解釈できません",
  );
  await assertRejects(
    () => prefetchUrl("assets/a.bin", { fetch }),
    Error,
    "URL を解釈できません",
  );
  assertEquals(calls.length, 0);
});

// --- sha256（一級の既知ハッシュ検証 + 記録ハッシュ。既定はローカル格納を信頼）---

Deno.test("sha256: network 取得を検証し、記録ハッシュをエントリへ焼く", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    const bytes = await fetchBytes(URL_A, { sha256: BYTES_A_SHA256, fetch });
    assertEquals(bytes, BYTES_A);

    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(URL_A);
    assertExists(cached);
    assertEquals(cached.headers.get(SHA_HEADER), BYTES_A_SHA256);

    // 2 回目は記録一致のヒット（network 0 回）。
    await fetchBytes(URL_A, { sha256: BYTES_A_SHA256, fetch });
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("sha256: network 取得の不一致は throw し、キャッシュしない", async () => {
  const wrong = "f".repeat(64);
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    const error = await assertRejects(
      () => fetchBytes(URL_A, { sha256: wrong, fetch }),
      Error,
    );
    // 期待値と実測値の両方を出す（どちらが違うのか分からないと呼び出し側は調べようがない）。
    assertStringIncludes(error.message, "SHA-256 不一致");
    assertStringIncludes(error.message, BYTES_A_SHA256);
    assertStringIncludes(error.message, wrong);
    assertEquals(calls.length, 1);

    const cache = await caches.open(CACHE_NAME);
    assertEquals(await cache.match(URL_A), undefined);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("sha256: 記録一致のヒットは再ハッシュせず信じる（既定）— recheck で opt-out できる", async () => {
  // 「信頼」の意味の凍結: 記録ヘッダだけ一致させた偽エントリ（中身は別物）を仕込む。
  // 既定はハッシュを計算しないので偽の中身がそのまま返り（= 計算していない証明）、
  // recheck: true は実ハッシュ突合で見破って self-heal する。
  const corrupt = new Uint8Array([9, 9, 9]);
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      URL_A,
      new Response(corrupt, { headers: { [SHA_HEADER]: BYTES_A_SHA256 } }),
    );

    const trusted = await fetchBytes(URL_A, {
      sha256: BYTES_A_SHA256,
      fetch,
    });
    assertEquals(trusted, corrupt); // 記録を信じる = 中身は検査しない（ビット腐敗は検出不能）。
    assertEquals(calls.length, 0);

    const rechecked = await fetchBytes(URL_A, {
      sha256: BYTES_A_SHA256,
      recheck: true,
      fetch,
    });
    assertEquals(rechecked, BYTES_A); // 実ハッシュ不一致 → self-heal → 取り直し。
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("sha256: 記録が無いエントリは実ハッシュで突合し、一致したら記録を焼き直す（backfill）", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    // 記録ヘッダ無しの既存エントリ（旧版・無検証 prefetch 相当）。
    const cache = await caches.open(CACHE_NAME);
    await cache.put(URL_A, new Response(BYTES_A));

    const bytes = await fetchBytes(URL_A, { sha256: BYTES_A_SHA256, fetch });
    assertEquals(bytes, BYTES_A);
    assertEquals(calls.length, 0); // 実ハッシュ一致 → 採用（network に出ない）。

    // 一致した記録なしエントリには記録が焼き直される（backfill — 放置すると毎ヒット全量
    // ハッシュが恒久化する。DECIDED: docs/decisions/0008）。
    const backfilled = await cache.match(URL_A);
    assertExists(backfilled);
    assertEquals(backfilled.headers.get(SHA_HEADER), BYTES_A_SHA256);
    assertEquals(new Uint8Array(await backfilled.arrayBuffer()), BYTES_A);

    // 中身が期待と食い違うエントリは self-heal で取り直す。
    await cache.put(URL_B, new Response(new Uint8Array([9, 9, 9])));
    const healed = await fetchBytes(URL_B, { sha256: BYTES_A_SHA256, fetch });
    assertEquals(healed, BYTES_A);
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("sha256: 無検証 prefetch → sha256 付き読み出しで記録が補完され、ヒットのまま", async () => {
  // 「prefetch は sha256 無し・読み出しは sha256 あり」の組み合わせが記録なしエントリを
  // 恒久化させないことの外形凍結（設計検討で見つかった病理の再発防止）。
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    await prefetchUrl(URL_A, { fetch }); // 記録なしで温まる。
    const bytes = await fetchBytes(URL_A, { sha256: BYTES_A_SHA256, fetch });
    assertEquals(bytes, BYTES_A);
    assertEquals(calls.length, 1); // prefetch の 1 回だけ（読み出しはヒット）。

    const cached = await (await caches.open(CACHE_NAME)).match(URL_A);
    assertExists(cached);
    assertEquals(cached.headers.get(SHA_HEADER), BYTES_A_SHA256);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("sha256: backfill の put 失敗は結果を壊さず通知して続行する（縮退）", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const notified: CacheErrorContext[] = [];
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(URL_A, new Response(BYTES_A)); // 記録なし。

    const bytes = await fetchBytes(URL_A, {
      sha256: BYTES_A_SHA256,
      fetch,
      caches: failingCacheStorage({
        put: () => Promise.reject(new Error("quota exceeded")),
      }),
      onCacheError: (context) => notified.push(context),
    });
    assertEquals(bytes, BYTES_A);
    assertEquals(calls.length, 0); // ヒットのまま（backfill 失敗で取り直しはしない）。
    assertEquals(notified.map((context) => context.op), ["put"]);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("sha256: 記録 ≠ 期待は実バイトが期待と一致していても evict して取り直す（判定は記録のみ）", async () => {
  // 実バイトも食い違うエントリだと「記録を無視して再ハッシュ→self-heal」でも同じ結果に
  // なり、判定方式を凍結できない。実バイト一致・記録だけ別値のエントリが唯一の判別点。
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      URL_A,
      new Response(BYTES_A, { headers: { [SHA_HEADER]: BYTES_B_SHA256 } }),
    );

    const bytes = await fetchBytes(URL_A, { sha256: BYTES_A_SHA256, fetch });
    assertEquals(bytes, BYTES_A);
    assertEquals(calls.length, 1); // 記録の文字列比較だけで network へ（再ハッシュ判定しない）。

    // 取り直しで記録は正しい値へ置き換わっている。
    const healed = await cache.match(URL_A);
    assertExists(healed);
    assertEquals(healed.headers.get(SHA_HEADER), BYTES_A_SHA256);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("sha256: 記録 ≠ 期待は「内容が変わった」として同じキーを上書きする（安定キーのピンポン凍結)", async () => {
  const KEY = ["models", "pingpong"] as const;
  const { fetch, calls } = mockFetch((url) =>
    new Response(url === URL_A ? BYTES_A : BYTES_B)
  );
  try {
    // revision A を安定キーで取得。
    await fetchBytesWithKey(URL_A, KEY, { sha256: BYTES_A_SHA256, fetch });
    assertEquals(calls.length, 1);

    // revision B へ切り替え: 記録(A) ≠ 期待(B) → self-heal で B を取得し同じキーへ上書き。
    const b = await fetchBytesWithKey(URL_B, KEY, {
      sha256: BYTES_B_SHA256,
      fetch,
    });
    assertEquals(b, BYTES_B);
    assertEquals(calls.length, 2);
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(keyUrl("models", "pingpong"));
    assertExists(cached);
    assertEquals(cached.headers.get(SHA_HEADER), BYTES_B_SHA256);

    // A へ戻すと再取得（= ピンポン）。内容を共存させたいならキーに sha256 を含めること
    // （HF 層の内容キーはそうしている）。
    const a = await fetchBytesWithKey(URL_A, KEY, {
      sha256: BYTES_A_SHA256,
      fetch,
    });
    assertEquals(a, BYTES_A);
    assertEquals(calls.length, 3);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("sha256: カスタム validate は記録一致のヒットでも常に走る（省くのは再ハッシュだけ）", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  let validateCalls = 0;
  const opts = {
    sha256: BYTES_A_SHA256,
    fetch,
    validate: () => {
      validateCalls++;
    },
  };
  try {
    await fetchBytes(URL_A, opts); // network: sha256 + validate。
    await fetchBytes(URL_A, opts); // ヒット: 記録一致でも validate は走る。
    assertEquals(calls.length, 1);
    assertEquals(validateCalls, 2);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("sha256: 合流者は自分の期待値で検証する（不一致はその呼び出しだけ throw）", async () => {
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    return new Response(BYTES_A);
  });
  try {
    const leader = fetchBytes(URL_A, { sha256: BYTES_A_SHA256, fetch });
    const joiner = fetchBytes(URL_A, { sha256: "f".repeat(64), fetch });
    gate.resolve();
    assertEquals(await leader, BYTES_A);
    await assertRejects(() => joiner, Error, "SHA-256 不一致");
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("sha256 / recheck: 不正な指定は network に出る前に fail loud", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const error = await assertRejects(
    () => fetchBytes(URL_A, { sha256: BYTES_A_SHA256.toUpperCase(), fetch }),
    Error,
  );
  assertStringIncludes(error.message, "64 桁の小文字 hex");
  await assertRejects(
    () => fetchBytes(URL_A, { recheck: true, fetch }),
    Error,
    "sha256 とセット",
  );
  assertEquals(calls.length, 0);
});

// --- 受信バッファの事前確保（expectedBytes / content-length はヒント。検証には使わない）---

/**
 * 手動制御ストリームの応答。事前確保の観測に使う: **同一インスタンスを 2 回 enqueue** し、
 * 間で中身を書き換える。事前確保経路は読み取り時に即コピーするので内容が保たれ、
 * 蓄積経路（参照を溜めて最後に連結）だと後の書き換えが 1 個目にも波及して壊れる。
 */
const manualStream = (): {
  response: (headers?: HeadersInit) => Response;
  controller: () => ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
} => {
  let ctrl!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    response: (headers) => new Response(stream, { headers }),
    controller: () => ctrl,
  };
};

/** 送信側がバッファを使い回す応答を流し、受信結果を返す（事前確保のヒント源をテスト側が選ぶ）。 */
const fetchWithReusedChunks = async (
  opts: { expectedBytes?: number; contentLength?: string },
): Promise<Uint8Array> => {
  const { response, controller } = manualStream();
  const { fetch } = mockFetch(() =>
    response(
      opts.contentLength === undefined
        ? undefined
        : { "content-length": opts.contentLength },
    )
  );
  const reused = new Uint8Array([1, 2, 3]);
  const firstChunk = Promise.withResolvers<void>();
  const promise = fetchBytes(URL_A, {
    fetch,
    expectedBytes: opts.expectedBytes,
    onProgress: () => firstChunk.resolve(),
  });
  controller().enqueue(reused);
  await firstChunk.promise; // 1 チャンク目が読み取られた（事前確保ならコピー済み）。
  reused.set([4, 5, 6]); // 同じインスタンスを書き換えて再送。
  controller().enqueue(reused);
  controller().close();
  return await promise;
};

/** 返り値は buffer 全体を占める tight view（呼び出し側の zero-copy 前提）。 */
const isTightView = (bytes: Uint8Array): boolean =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;

Deno.test("fetchBytes: expectedBytes を渡すと受信バッファを事前確保しチャンクを即コピーする", async () => {
  try {
    const bytes = await fetchWithReusedChunks({ expectedBytes: 6 });
    assertEquals(bytes, new Uint8Array([1, 2, 3, 4, 5, 6]));
    assertEquals(isTightView(bytes), true);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: expectedBytes 省略時は content-length を確保ヒントに使う", async () => {
  try {
    const bytes = await fetchWithReusedChunks({ contentLength: "6" });
    assertEquals(bytes, new Uint8Array([1, 2, 3, 4, 5, 6]));
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: content-length が無ければ従来どおり蓄積経路で読み切る", async () => {
  const { fetch } = mockFetch(() =>
    chunkedResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])
  );
  try {
    const bytes = await fetchBytes(URL_A, { fetch });
    assertEquals(bytes, new Uint8Array([1, 2, 3, 4, 5]));
    assertEquals(isTightView(bytes), true);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: 申告を超えて届いたら蓄積経路へ落ちて全量を返す（ヒントは検証ではない）", async () => {
  // Content-Encoding 越しの content-length のように、宣言より多く届くケース。
  const { fetch } = mockFetch(() =>
    chunkedResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])], {
      "content-length": "3",
    })
  );
  try {
    const bytes = await fetchBytes(URL_A, { fetch });
    assertEquals(bytes, new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
    assertEquals(isTightView(bytes), true);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: 申告に足りない受信は実長へ詰め直して tight view で返す", async () => {
  const { fetch } = mockFetch(() =>
    chunkedResponse([new Uint8Array([1, 2, 3])])
  );
  try {
    const bytes = await fetchBytes(URL_A, { fetch, expectedBytes: 10 });
    assertEquals(bytes, new Uint8Array([1, 2, 3]));
    assertEquals(isTightView(bytes), true);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: expectedBytes は content-length より優先される", async () => {
  try {
    // content-length が誤り（3）でも expectedBytes（6）で確保できていれば内容は壊れない。
    const bytes = await fetchWithReusedChunks({
      expectedBytes: 6,
      contentLength: "3",
    });
    assertEquals(bytes, new Uint8Array([1, 2, 3, 4, 5, 6]));
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: 確保できないほど巨大な content-length でも取得は落とさず蓄積経路で完走する", async () => {
  // サーバ申告は信頼しないので確保失敗は「ヒント無し」へ縮退する。明示 expectedBytes の
  // 確保失敗だけが fail loud（ADR 0007 — 下の専用テスト）で、この非対称は by-design。
  const { fetch } = mockFetch(() =>
    chunkedResponse([new Uint8Array([1, 2, 3])], {
      "content-length": String(Number.MAX_SAFE_INTEGER),
    })
  );
  try {
    const bytes = await fetchBytes(URL_A, { fetch });
    assertEquals(bytes, new Uint8Array([1, 2, 3]));
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("fetchBytes: 不正な expectedBytes（非整数・0 以下）は確保ヒントを捨てて蓄積経路で完走する", async () => {
  // 確保失敗（ADR 0007 の fail loud）とは別分岐: 形式不正は確保を試みる前に弾かれ、
  // 「申告が外れても取得は落とさない」という by-design 契約（docs/limitations.md）のまま。
  for (const expectedBytes of [1.5, -1, 0]) {
    const { fetch } = mockFetch(() =>
      chunkedResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])
    );
    try {
      const bytes = await fetchBytes(URL_A, { fetch, expectedBytes });
      assertEquals(bytes, BYTES_A, `expectedBytes=${expectedBytes}`);
      assertEquals(isTightView(bytes), true, `expectedBytes=${expectedBytes}`);
    } finally {
      await caches.delete(CACHE_NAME);
    }
  }
});

/**
 * 読み取られるまで 1 チャンクも流さない応答（pull 駆動）。「受信を始める前に落ちたか」と
 * 「body を解放したか」を観測するために使う。
 */
const lazyResponse = (
  chunks: readonly Uint8Array<ArrayBuffer>[],
): { response: Response; pulled: () => number; cancelled: () => boolean } => {
  let pulled = 0;
  let cancelled = false;
  // highWaterMark 0 = 先読みしない（read() が来て初めて pull が走る）。既定の 1 だと
  // 誰も読んでいなくても 1 チャンク先読みされ、「受信を始めたか」の観測にならない。
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (pulled >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[pulled++]);
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  return {
    response: new Response(stream),
    pulled: () => pulled,
    cancelled: () => cancelled,
  };
};

Deno.test("fetchBytes: 明示 expectedBytes の確保が落ちたら受信前に fail loud で止める", async () => {
  // 蓄積経路へ縮退させると「全量 DL してから同じ理由で落ちる」= 帯域を丸ごと捨てるだけ
  // （DECIDED: docs/decisions/0007）。
  const lazy = lazyResponse([new Uint8Array([1, 2, 3])]);
  const { fetch } = mockFetch(() => lazy.response);
  try {
    const error = await assertRejects(
      () =>
        fetchBytes(URL_A, {
          fetch,
          expectedBytes: Number.MAX_SAFE_INTEGER,
        }),
      Error,
    );
    assertStringIncludes(error.message, String(Number.MAX_SAFE_INTEGER));
    assertStringIncludes(error.message, "ArrayBuffer");
    assertStringIncludes(error.message, URL_A);
    assertEquals(
      lazy.pulled(),
      0,
      "受信を始めてしまっている（帯域を捨てている）",
    );
    assertEquals(lazy.cancelled(), true, "未消費 body を解放していない");
    assertEquals(await listCachedUrls(), [], "落ちた取得をキャッシュしている");
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

// --- prefetchUrl（streaming put・検証は読み出し側に一本化）---

Deno.test("prefetchUrl: body を streaming で格納し、以後の fetchBytes は network に出ない", async () => {
  const { fetch, calls } = mockFetch(() =>
    chunkedResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])
  );
  try {
    assertEquals(await prefetchUrl(URL_A, { fetch }), true);
    assertEquals(calls.length, 1);

    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(URL_A);
    assertExists(cached);
    assertEquals(
      new Uint8Array(await cached.arrayBuffer()),
      new Uint8Array([1, 2, 3, 4, 5]),
    );

    const bytes = await fetchBytes(URL_A, { fetch });
    assertEquals(bytes, new Uint8Array([1, 2, 3, 4, 5]));
    assertEquals(calls.length, 1); // ヒット。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: 既にエントリがあれば network に出ず false を返す", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    await fetchBytes(URL_A, { fetch });
    assertEquals(calls.length, 1);
    assertEquals(await prefetchUrl(URL_A, { fetch }), false);
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: key 側へ格納し、既存エントリ検査も key で行う", async () => {
  const KEY = ["warm", "a"] as const;
  const { fetch, calls } = mockFetch(() =>
    chunkedResponse([BYTES_A.slice(0, 2), BYTES_A.slice(2)])
  );
  try {
    assertEquals(await prefetchUrlWithKey(URL_A, KEY, { fetch }), true);
    assertEquals(calls, [URL_A]);

    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(keyUrl("warm", "a"));
    assertExists(cached);
    assertEquals(new Uint8Array(await cached.arrayBuffer()), BYTES_A);
    assertEquals(await cache.match(URL_A), undefined);

    // 既存エントリ検査もキー側 = 取得元が別 URL でも network に出ない。
    assertEquals(await prefetchUrlWithKey(URL_B, KEY, { fetch }), false);
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: 転送が途中で切れたら throw し、エントリは成立しない", async () => {
  const { fetch } = mockFetch(() =>
    new Response(
      new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(new Error("転送断"));
        },
      }),
    )
  );
  try {
    const error = await assertRejects(
      () => prefetchUrl(URL_A, { fetch }),
      Error,
    );
    assertStringIncludes(error.message, "キャッシュ書込みに失敗");
    assertEquals((error.cause as Error).message, "転送断"); // 原因は握り潰さない。

    const cache = await caches.open(CACHE_NAME);
    assertEquals(await cache.match(URL_A), undefined); // 中途半端なエントリは残らない。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: put 失敗（quota 等）は縮退せず throw する（手元にバイトが無い）", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  try {
    const error = await assertRejects(
      () =>
        prefetchUrl(URL_A, {
          fetch,
          caches: failingCacheStorage({
            put: () => Promise.reject(new Error("quota exceeded")),
          }),
        }),
      Error,
    );
    assertStringIncludes(error.message, "fetchBytes へフォールバック");
    assertEquals((error.cause as Error).message, "quota exceeded");
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: caches.open 失敗も縮退せず throw する", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const brokenCaches: CacheStorage = {
    open: () => Promise.reject(new Error("open failed")),
    has: (name) => caches.has(name),
    delete: (name) => caches.delete(name),
    keys: () => caches.keys(),
    match: (request, options) => caches.match(request, options),
  };
  await assertRejects(
    () => prefetchUrl(URL_A, { fetch, caches: brokenCaches }),
    Error,
    "open failed",
  );
  assertEquals(calls.length, 0); // 格納できないと分かった時点で network に出ない。
});

Deno.test("prefetchUrl: HTTP エラーは throw し、body を cancel してエントリも作らない", async () => {
  let response: Response | undefined;
  const { fetch } = mockFetch(() => {
    response = new Response("missing", {
      status: 404,
      statusText: "Not Found",
    });
    return response;
  });
  try {
    const error = await assertRejects(
      () => prefetchUrl(URL_A, { fetch }),
      Error,
    );
    assertStringIncludes(error.message, "HTTP 404 Not Found");
    assertEquals(response?.bodyUsed, true);
    const cache = await caches.open(CACHE_NAME);
    assertEquals(await cache.match(URL_A), undefined);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: 非 GET は fail loud（Cache API に格納できない）", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const error = await assertRejects(
    () => prefetchUrl(URL_A, { fetch, init: { method: "POST" } }),
    Error,
  );
  assertStringIncludes(error.message, "GET 専用");
  assertEquals(calls.length, 0);
});

Deno.test("prefetchUrl: onProgress はチャンク毎に発火し content-length を total に持つ", async () => {
  const { fetch } = mockFetch(() =>
    chunkedResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])], {
      "content-length": "7",
    })
  );
  const events: { loaded: number; total?: number }[] = [];
  try {
    await prefetchUrl(URL_A, {
      fetch,
      onProgress: (progress) => events.push(progress),
    });
    assertEquals(events, [{ loaded: 3, total: 7 }, { loaded: 7, total: 7 }]);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: single-flight の対象外（並行の fetchBytes / prefetch と合流しない）", async () => {
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = mockFetch(async () => {
    await gate.promise;
    return new Response(BYTES_A);
  });
  try {
    const prefetching = prefetchUrl(URL_A, { fetch });
    const fetching = fetchBytes(URL_A, { fetch });
    gate.resolve();
    const [prefetched, bytes] = await Promise.all([prefetching, fetching]);
    assertEquals(prefetched, true);
    assertEquals(bytes, BYTES_A);
    // leader は raw を持たないため合流できない = それぞれ network に出る（内容同一の
    // last-writer-wins で整合性は壊れない）。
    assertEquals(calls.length, 2);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: body が null の応答も空エントリとして成立する", async () => {
  const { fetch, calls } = mockFetch(() => new Response(null));
  const events: { loaded: number; total?: number }[] = [];
  try {
    assertEquals(
      await prefetchUrl(URL_A, {
        fetch,
        onProgress: (progress) => events.push(progress),
      }),
      true,
    );
    assertEquals(events, [{ loaded: 0, total: undefined }]);
    assertEquals(await fetchBytes(URL_A, { fetch }), new Uint8Array(0));
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

// --- prefetch の通過中 sha256 検証（opt-in。省略時は従来どおり無検証） ---

Deno.test("prefetchUrl: sha256 一致で記録付きエントリが成立し、読み出しは記録との突合だけで済む", async () => {
  // チャンク分割して届いても分割位置に依らず同じダイジェストになることを込みで確かめる。
  const { fetch, calls } = mockFetch(() =>
    chunkedResponse([BYTES_A.slice(0, 2), BYTES_A.slice(2)])
  );
  try {
    assertEquals(
      await prefetchUrl(URL_A, { fetch, sha256: BYTES_A_SHA256 }),
      true,
    );
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(URL_A);
    assertExists(cached);
    // 記録は期待 sha256 そのもの（fetchBytes の記録一致ヒットにそのまま繋がる）。
    assertEquals(cached.headers.get(SHA_HEADER), BYTES_A_SHA256);
    assertEquals(new Uint8Array(await cached.arrayBuffer()), BYTES_A);

    const bytes = await fetchBytes(URL_A, { fetch, sha256: BYTES_A_SHA256 });
    assertEquals(bytes, BYTES_A);
    assertEquals(calls.length, 1); // ヒット（network に出ない）。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: key + sha256 の記録はキー側に焼かれ、同じ key の読み出しに繋がる", async () => {
  const KEY = ["warm", "sha"] as const;
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  let validateCalls = 0;
  try {
    await prefetchUrlWithKey(URL_A, KEY, { sha256: BYTES_A_SHA256, fetch });
    const cached = await (await caches.open(CACHE_NAME)).match(
      keyUrl("warm", "sha"),
    );
    assertExists(cached);
    assertEquals(cached.headers.get(SHA_HEADER), BYTES_A_SHA256);

    // 温めた側と同じ key + sha256 で読めばヒットし、記録一致で再ハッシュも走らない
    // （カスタム validate は常に走る）。
    const bytes = await fetchBytesWithKey(URL_B, KEY, {
      sha256: BYTES_A_SHA256,
      fetch,
      validate: () => {
        validateCalls++;
      },
    });
    assertEquals(bytes, BYTES_A);
    assertEquals(calls.length, 1);
    assertEquals(validateCalls, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: sha256 不一致は put ごと reject させ、エントリを成立させない", async () => {
  const wrong = "f".repeat(64);
  const { fetch } = mockFetch(() =>
    chunkedResponse([BYTES_A.slice(0, 2), BYTES_A.slice(2)])
  );
  try {
    const error = await assertRejects(
      () => prefetchUrl(URL_A, { fetch, sha256: wrong }),
      Error,
    );
    // 期待値と実測値の両方を出す（どちらが違うのか分からないと呼び出し側は調べようがない）。
    assertStringIncludes(error.message, "SHA-256 不一致");
    assertStringIncludes(error.message, BYTES_A_SHA256);
    assertStringIncludes(error.message, wrong);

    const cache = await caches.open(CACHE_NAME);
    assertEquals(await cache.match(URL_A), undefined); // 記録付きの不正エントリは残らない。
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: stream の error を握り潰す非準拠 Cache でも記録付きの不正エントリは残さない（保険 delete はキー側）", async () => {
  const wrong = "f".repeat(64);
  const KEY = ["warm", "insurance"] as const;
  const entries = new Map<string, Response>();
  const deleted: string[] = [];
  // 準拠実装なら controller.error() は put の reject として現れるが、それを無視して
  // エントリを作ってしまう Cache 実装に備えた保険（put 後の delete → throw）の凍結。
  // key 指定時は保険 delete も**キー側**に向くこと（取得元 URL ではなく）を併せて凍結する
  // — 取り違えても準拠 Cache のテストは全て通ってしまうため、ここが唯一の検出点。
  // NOTE: put は**必ず body を消費してから** resolve すること。消費しないと TransformStream
  //       の flush（= 不一致の検出そのもの）が走らず、この分岐に入らない。
  const lenientCaches: CacheStorage = {
    open: () => {
      const wrapper = {
        match: (request: RequestInfo | URL) =>
          Promise.resolve(entries.get(String(request))),
        put: async (request: RequestInfo | URL, response: Response) => {
          await response.arrayBuffer().catch(() => {});
          entries.set(String(request), response);
        },
        delete: (request: RequestInfo | URL) => {
          deleted.push(String(request));
          return Promise.resolve(entries.delete(String(request)));
        },
        keys: () => Promise.resolve([] as Request[]),
      };
      return Promise.resolve(wrapper);
    },
    has: () => Promise.resolve(false),
    delete: () => Promise.resolve(false),
    keys: () => Promise.resolve([]),
    match: () => Promise.resolve(undefined),
  };
  const { fetch } = mockFetch(() =>
    chunkedResponse([BYTES_A.slice(0, 2), BYTES_A.slice(2)])
  );

  const error = await assertRejects(
    () =>
      prefetchUrlWithKey(URL_A, KEY, {
        fetch,
        sha256: wrong,
        caches: lenientCaches,
      }),
    Error,
  );
  // put が resolve しても、落ちる理由は cache 書込み失敗ではなく取得内容の不正のまま。
  assertStringIncludes(error.message, "SHA-256 不一致");
  assertStringIncludes(error.message, BYTES_A_SHA256);
  assertEquals(error.message.includes("キャッシュ書込みに失敗"), false);
  // 記録は以後の検証を省かせるので、残ると恒久的に効いてしまう。消す先はキー側。
  assertEquals(deleted, [keyUrl("warm", "insurance")]);
  assertEquals(entries.size, 0);
});

Deno.test("prefetchUrl: 保険 delete まで失敗したら黙殺せず両方の失敗を束ねて throw する", async () => {
  const wrong = "f".repeat(64);
  // 二重故障の注入: stream error を無視して put が成功し（非準拠）、さらに delete も落ちる。
  // 黙殺すると「記録付きの不正エントリが残ったまま成功裏に throw」になり、以後の既定
  // 読み出しが記録を信じ続ける（fail loudly 違反 — レビュー CX-02）。
  const brokenCaches: CacheStorage = {
    open: () => {
      const wrapper = {
        match: (_request: RequestInfo | URL) => Promise.resolve(undefined),
        put: async (_request: RequestInfo | URL, response: Response) => {
          // body を消費して resolve（消費しないと flush = 不一致検出が走らない）。
          await response.arrayBuffer().catch(() => {});
        },
        delete: (_request: RequestInfo | URL) =>
          Promise.reject(new Error("delete failed")),
        keys: () => Promise.resolve([] as Request[]),
      };
      return Promise.resolve(wrapper);
    },
    has: () => Promise.resolve(false),
    delete: () => Promise.resolve(false),
    keys: () => Promise.resolve([]),
    match: () => Promise.resolve(undefined),
  };
  const { fetch } = mockFetch(() =>
    chunkedResponse([BYTES_A.slice(0, 2), BYTES_A.slice(2)])
  );

  const error = await assertRejects(
    () => prefetchUrl(URL_A, { fetch, sha256: wrong, caches: brokenCaches }),
    AggregateError,
  );
  assertStringIncludes(error.message, "SHA-256 不一致");
  assertStringIncludes(error.message, "削除にも失敗");
  assertEquals(error.errors.length, 2);
  assertStringIncludes((error.errors[0] as Error).message, "SHA-256 不一致");
  assertEquals((error.errors[1] as Error).message, "delete failed");
});

Deno.test("prefetchUrl: 通過中検証のチャンクは呼び出し側の書き換えから隔離される（記録と中身が乖離しない）", async () => {
  // 呼び出し側が参照を握ったままのバッファを 1 チャンクだけ流し、onProgress（ハッシュ直後・
  // 格納前に同期で走る呼び出し側コード）で書き換える敵対的な輸送を再現する。隔離が無いと
  // 「記録はハッシュ時の内容・格納は書き換え後の内容」という乖離エントリが成立してしまう。
  const buffer = new Uint8Array(16).fill(0x11);
  const expected = await sha256HexOf(buffer.slice());
  const { fetch } = mockFetch(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(buffer);
          controller.close();
        },
      }),
    )
  );
  try {
    assertEquals(
      await prefetchUrl(URL_A, {
        fetch,
        sha256: expected,
        onProgress: () => buffer.fill(0x22),
      }),
      true,
    );
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(URL_A);
    assertExists(cached);
    const stored = new Uint8Array(await cached.arrayBuffer());
    // 記録が主張するハッシュと格納内容が必ず一致する（書き換え前の内容が格納される）。
    assertEquals(await sha256HexOf(stored), cached.headers.get(SHA_HEADER));
    assertEquals(stored, new Uint8Array(16).fill(0x11));
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: body が null の応答でも sha256 は検証される", async () => {
  const emptySha256 = await sha256HexOf(new Uint8Array(0));
  const { fetch } = mockFetch(() => new Response(null));
  try {
    assertEquals(
      await prefetchUrl(URL_A, { fetch, sha256: emptySha256 }),
      true,
    );
    await assertRejects(
      () =>
        prefetchUrl(URL_B, {
          fetch,
          sha256: BYTES_A_SHA256, // 空バイト列とは一致しない。
        }),
      Error,
      "SHA-256 不一致",
    );
    const cache = await caches.open(CACHE_NAME);
    assertEquals(await cache.match(URL_B), undefined);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: 既存エントリの記録が期待 sha256 と食い違えば削除して温め直す", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    // 陳腐化エントリ（中身も記録も別内容）。有無だけの検査だと恒久に温め直せない。
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      URL_A,
      new Response(BYTES_B, { headers: { [SHA_HEADER]: BYTES_B_SHA256 } }),
    );

    assertEquals(
      await prefetchUrl(URL_A, { fetch, sha256: BYTES_A_SHA256 }),
      true,
    );
    assertEquals(calls.length, 1); // network で温め直す。
    const warmed = await cache.match(URL_A);
    assertExists(warmed);
    assertEquals(warmed.headers.get(SHA_HEADER), BYTES_A_SHA256);
    assertEquals(new Uint8Array(await warmed.arrayBuffer()), BYTES_A);

    // 記録が一致していれば従来どおり何もしない（false）。
    assertEquals(
      await prefetchUrl(URL_A, { fetch, sha256: BYTES_A_SHA256 }),
      false,
    );
    assertEquals(calls.length, 1);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: 記録なしエントリへの sha256 付き prefetch は検証付きで温め直す", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  try {
    await prefetchUrl(URL_A, { fetch }); // 無検証 = 記録なしで温まる。
    assertEquals(
      await prefetchUrl(URL_A, { fetch, sha256: BYTES_A_SHA256 }),
      true,
    );
    assertEquals(calls.length, 2); // 既存の実バイトは検証できないため取り直す。
    const cached = await (await caches.open(CACHE_NAME)).match(URL_A);
    assertExists(cached);
    assertEquals(cached.headers.get(SHA_HEADER), BYTES_A_SHA256);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: sha256 未指定なら記録は付かない（既定の無検証格納は不変）", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  try {
    await prefetchUrl(URL_A, { fetch });
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(URL_A);
    assertExists(cached);
    assertEquals(cached.headers.get(SHA_HEADER), null);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("prefetchUrl: 形式不正の sha256 は network に出る前に fail loud", async () => {
  const { fetch, calls } = mockFetch(() => new Response(BYTES_A));
  const error = await assertRejects(
    () =>
      prefetchUrl(URL_A, {
        fetch,
        sha256: BYTES_A_SHA256.toUpperCase(), // 大文字 hex は必ず不一致になる申告ミス。
      }),
    Error,
  );
  assertStringIncludes(error.message, "64 桁の小文字 hex");
  assertEquals(calls.length, 0); // 全量ダウンロードしてから落ちる、を避ける。
});

Deno.test("decodeGzip: gzip を解凍して元のバイト列を返し、不正入力は throw する", async () => {
  const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const compressed = await gzipBytes(original);
  assertEquals(await decodeGzip(compressed), original);
  await assertRejects(() => decodeGzip(new Uint8Array([1, 2, 3])));
});

// --- 管理 API（evictUrl / clearCache / listCachedUrls / evict / listKeys）---

Deno.test("evictUrl: エントリがあれば削除して true、無ければ false", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  try {
    assertEquals(await evictUrl(URL_A), false); // 未キャッシュ。
    await fetchBytes(URL_A, { fetch });
    assertEquals(await evictUrl(URL_A), true);

    const cache = await caches.open(CACHE_NAME);
    assertEquals(await cache.match(URL_A), undefined);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test("evictUrl / listCachedUrls / evict / listKeys: 無い名前空間を作らない（読み取り系の永続化副作用の禁止）", async () => {
  await caches.delete(CACHE_NAME); // 前提: 名前空間が無い状態から始める。
  assertEquals(await evictUrl(URL_A), false);
  assertEquals(await caches.has(CACHE_NAME), false);
  // 名前空間が無ければ keys() 未実装ランタイム（Deno 2.8 以前）でも [] / 0 を返せる。
  assertEquals(await listCachedUrls(), []);
  assertEquals(await listKeys(), []);
  assertEquals(await evict(["x"]), 0);
  assertEquals(await caches.has(CACHE_NAME), false);
});

Deno.test("clearCache: 名前空間ごと削除して true、既に無ければ false", async () => {
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  await fetchBytes(URL_A, { fetch });
  assertEquals(await clearCache(), true);
  assertEquals(await clearCache(), false);
});

Deno.test({
  name:
    "listCachedUrls: keys() 未実装ランタイム（Deno 2.8 以前）では fail loud に throw する",
  ignore: runtimeHasCacheKeys,
  fn: async () => {
    const { fetch } = mockFetch(() => new Response(BYTES_A));
    try {
      await fetchBytes(URL_A, { fetch });
      const error = await assertRejects(() => listCachedUrls(), Error);
      assertStringIncludes(error.message, "keys()");
    } finally {
      await caches.delete(CACHE_NAME);
    }
  },
});

Deno.test({
  name:
    "listCachedUrls / listKeys: URL キーと配列キーを分けて一覧する（keys() 実装ランタイムのみ）",
  ignore: !runtimeHasCacheKeys,
  fn: async () => {
    const { fetch } = mockFetch(() => new Response(BYTES_A));
    try {
      assertEquals(await listCachedUrls(), []);
      await fetchBytes(URL_A, { fetch });
      await fetchBytesWithKey(URL_B, ["app", "models", "a"], { fetch });
      // URL 一覧に合成 origin は混ざらず、キー一覧に URL キーは混ざらない。
      assertEquals(await listCachedUrls(), [URL_A]);
      assertEquals(await listKeys(), [["app", "models", "a"]]);
    } finally {
      await caches.delete(CACHE_NAME);
    }
  },
});

Deno.test({
  name: "evict / listKeys: プレフィックスで部分木を操作できる",
  ignore: !runtimeHasCacheKeys,
  fn: async () => {
    const { fetch } = mockFetch(() => new Response(BYTES_A));
    const sortKeys = (keys: readonly (readonly unknown[])[]) =>
      keys.map((key) => JSON.stringify(key)).sort();
    try {
      await fetchBytes(URL_A, { fetch }); // URL キー（プレフィックス操作の対象外）。
      for (
        const key of [
          ["app", "models", "a"],
          ["app", "models", "b"],
          ["app", "config"],
          ["other"],
        ]
      ) {
        await fetchBytesWithKey(URL_B, key, { fetch });
      }

      assertEquals(
        sortKeys(await listKeys(["app", "models"])),
        sortKeys([["app", "models", "a"], ["app", "models", "b"]]),
      );

      // 部分木だけ消える（件数を返す）。もう一度消しても 0。
      assertEquals(await evict(["app", "models"]), 2);
      assertEquals(await evict(["app", "models"]), 0);
      assertEquals(
        sortKeys(await listKeys()),
        sortKeys([["app", "config"], ["other"]]),
      );

      // 空プレフィックス = 配列キーの全エントリ。URL キーは残る。
      assertEquals(await evict([]), 2);
      assertEquals(await listKeys(), []);
      assertEquals(await listCachedUrls(), [URL_A]);
    } finally {
      await caches.delete(CACHE_NAME);
    }
  },
});

Deno.test({
  name:
    "evict: プレフィックス一致はセグメント境界で判定される（['a'] は ['ab'] に一致しない）",
  ignore: !runtimeHasCacheKeys,
  fn: async () => {
    const { fetch } = mockFetch(() => new Response(BYTES_A));
    try {
      for (const key of [["a"], ["ab"], ["a", "b"]]) {
        await fetchBytesWithKey(URL_A, key, { fetch });
      }
      // ["a"] は自分自身と子孫 ["a","b"] に一致し、["ab"] には一致しない。
      assertEquals(await evict(["a"]), 2);
      assertEquals(await listKeys(), [["ab"]]);
    } finally {
      await caches.delete(CACHE_NAME);
    }
  },
});

/**
 * global caches とエントリを一切共有しない in-memory CacheStorage。管理 API の `caches` DI が
 * 本当に DI 先へ向いているかの判別用（global へ委譲するラッパでは区別できない）。keys() を
 * 自前実装するので keys() 未実装ランタイムでも動く。
 */
const memoryCacheStorage = (): CacheStorage => {
  const urlOf = (request: RequestInfo | URL): string =>
    typeof request === "string"
      ? request
      : request instanceof Request
      ? request.url
      : request.href;
  const namespaces = new Map<
    string,
    Map<string, { bytes: Uint8Array; headers: Headers }>
  >();
  const openCache = (name: string): Cache => {
    const entries = namespaces.get(name) ??
      new Map<string, { bytes: Uint8Array; headers: Headers }>();
    namespaces.set(name, entries);
    const wrapper = {
      match: (request: RequestInfo | URL) => {
        const entry = entries.get(urlOf(request));
        return Promise.resolve(
          entry === undefined
            ? undefined
            : new Response(entry.bytes.slice(), { headers: entry.headers }),
        );
      },
      put: async (request: RequestInfo | URL, response: Response) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        entries.set(urlOf(request), { bytes, headers: response.headers });
      },
      delete: (request: RequestInfo | URL) =>
        Promise.resolve(entries.delete(urlOf(request))),
      keys: () =>
        Promise.resolve([...entries.keys()].map((url) => new Request(url))),
    };
    return wrapper as Cache;
  };
  return {
    open: (name) => Promise.resolve(openCache(name)),
    has: (name) => Promise.resolve(namespaces.has(name)),
    delete: (name) => Promise.resolve(namespaces.delete(name)),
    keys: () => Promise.resolve([...namespaces.keys()]),
    match: () => Promise.resolve(undefined),
  };
};

Deno.test("管理 API: caches DI — DI したストレージのエントリを列挙・削除でき、global には触れない", async () => {
  const memory = memoryCacheStorage();
  const { fetch } = mockFetch(() => new Response(BYTES_A));
  try {
    await fetchBytes(URL_A, { fetch, caches: memory });
    await fetchBytesWithKey(URL_B, ["app", "m"], { fetch, caches: memory });

    // DI 側に入っており、global の名前空間は作られない。
    assertEquals(await listCachedUrls({ caches: memory }), [URL_A]);
    assertEquals(await listKeys([], { caches: memory }), [["app", "m"]]);
    assertEquals(await caches.has(CACHE_NAME), false);

    // 削除系も DI 側に向く。
    assertEquals(await evict(["app"], { caches: memory }), 1);
    assertEquals(await evictUrl(URL_A, { caches: memory }), true);
    assertEquals(await listCachedUrls({ caches: memory }), []);
    assertEquals(await clearCache({ caches: memory }), true);
    assertEquals(await clearCache({ caches: memory }), false);
  } finally {
    await caches.delete(CACHE_NAME);
  }
});

Deno.test({
  name:
    "listKeys: 予約 origin 配下に復元できないエントリがあれば fail loud に throw する",
  ignore: !runtimeHasCacheKeys,
  fn: async () => {
    try {
      // この層の直列化を経ていない直書きエントリ（JSON として復元できないセグメント）。
      const cache = await caches.open(CACHE_NAME);
      await cache.put(
        "https://fetch-cache.invalid/v1/notjson",
        new Response(BYTES_A),
      );
      const error = await assertRejects(() => listKeys(), Error);
      assertStringIncludes(error.message, "復元できない");
    } finally {
      await caches.delete(CACHE_NAME);
    }
  },
});
