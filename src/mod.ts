/**
 * `@hdae/fetch-cache` — URL ベースの Cache API 付きダウンロード（汎用層）。
 *
 * `fetchBytes` は URL をそのままキーに Cache Storage へ保存し、2 回目以降は network なしで返す。
 * `validate` フックはキャッシュヒット側にも適用され、破損キャッシュは evict して真実源から取り直す
 * （self-heal）。`caches` が無いランタイム（Node.js 等）では素の fetch にフォールバックする＝
 * キャッシュは正しさの要件ではなく最適化。
 *
 * MUST: 実行時依存ゼロ。fetch / caches / crypto.subtle など Web 標準 API のみを使う。
 *
 * @module
 */

export const VERSION = "0.1.0";

/** ダウンロード進捗。`total` は content-length ヘッダがあるときだけ入る。 */
export type FetchProgress = { loaded: number; total?: number };

/** cache I/O 失敗の通知内容。`op` は失敗した Cache API 操作。 */
export type CacheErrorContext = {
  op: "open" | "match" | "put" | "delete";
  url: string;
  error: unknown;
};

export type FetchBytesOptions = {
  /** Cache Storage の名前空間。既定 "fetch-cache"。 */
  cacheName?: string;
  /** false で Cache API を一切触らない素の fetch。既定 true（URL がそのままキー）。 */
  cache?: boolean;
  /**
   * 取得/キャッシュ読出しバイト列の検証。throw = 不正。キャッシュヒット側にも適用され、
   * 失敗時は evict して network から取り直す（self-heal）。network 取得物の失敗はそのまま
   * throw（不正物はキャッシュしない）。
   */
  validate?: (bytes: Uint8Array) => void | Promise<void>;
  /** ダウンロード進捗（チャンク毎）。キャッシュヒット時は呼ばれない。 */
  onProgress?: (progress: FetchProgress) => void;
  /**
   * cache I/O 失敗（open/match/put/delete の throw。quota 超過等）の通知先。既定 console.warn。
   * キャッシュは最適化であり正しさの要件ではないため、失敗はダウンロードを落とさず network 側へ
   * 縮退して続行する。無言では握り潰さない（DECIDED: docs/decisions/0001）。
   */
  onCacheError?: (context: CacheErrorContext) => void;
  /**
   * fetch へそのまま渡す RequestInit（Authorization 等のヘッダ・AbortSignal など）。
   * キャッシュキーは URL のみ（ヘッダ非依存）なので、認証付きで取得した bytes は以後
   * 認証なしの呼び出しでもヒットする（docs/limitations.md）。
   *
   * NOTE: Cache API は GET しか格納できないため、cache 有効のまま GET 以外の method を
   *       指定すると throw する（`cache: false` なら任意の method 可 —
   *       DECIDED: docs/decisions/0002）。
   */
  init?: RequestInit;
  /** fetch の差し替え（テスト・カスタム輸送用）。既定 globalThis.fetch。 */
  fetch?: typeof globalThis.fetch;
  /** CacheStorage の差し替え（テストの故障注入用）。既定 globalThis.caches。 */
  caches?: CacheStorage;
};

const DEFAULT_CACHE_NAME = "fetch-cache";

// `caches` が無いランタイム（Node.js 等）では undefined（素の fetch へフォールバック）。
const globalCaches = (): CacheStorage | undefined =>
  typeof caches !== "undefined" ? caches : undefined;

const defaultOnCacheError = (context: CacheErrorContext): void => {
  console.warn(
    `fetch-cache: キャッシュ ${context.op} に失敗したため network へ縮退します (${context.url})`,
    context.error,
  );
};

/** content-length を進捗の total に読む。無い・数値でないヘッダは「total 不明」扱い（進捗は任意情報）。 */
const readTotal = (response: Response): number | undefined => {
  const header = response.headers.get("content-length");
  if (header === null) return undefined;
  const total = Number(header);
  return Number.isFinite(total) && total >= 0 ? total : undefined;
};

/**
 * body を streaming で読み切り、チャンク毎に onProgress を発火する。
 * body が null のランタイム向けに arrayBuffer フォールバックを持つ（そのときは読み切り後に 1 回発火）。
 */
const readBody = async (
  response: Response,
  onProgress?: (progress: FetchProgress) => void,
): Promise<Uint8Array<ArrayBuffer>> => {
  const total = readTotal(response);
  const body = response.body;
  if (body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.({ loaded: bytes.length, total });
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.({ loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

/**
 * URL からバイト列を取得する（Cache API 優先・self-heal・fail loud）。
 *
 * キャッシュヒット時は network に出ない（onProgress も呼ばれない）。`validate` が
 * キャッシュ内容を拒否したら evict して network から取り直す（self-heal）。network 取得物が
 * `validate` に落ちたらそのまま throw し、不正物はキャッシュしない。HTTP エラーは
 * `fetch-cache: HTTP {status} {statusText} ({url})` で throw する。
 *
 * NOTE: `caches` が無いランタイム（Node.js 等）では `cache` 指定に関わらず素の fetch に
 *       フォールバックする（キャッシュは最適化であり正しさの要件ではない）。
 * NOTE: cache I/O の失敗（quota 超過等）もダウンロードを落とさず network 側へ縮退して続行し、
 *       `onCacheError`（既定 console.warn）で通知する（DECIDED: docs/decisions/0001）。
 */
export const fetchBytes = async (
  url: string | URL,
  opts: FetchBytesOptions = {},
): Promise<Uint8Array> => {
  const requestUrl = typeof url === "string" ? url : url.href;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const cacheName = opts.cacheName ?? DEFAULT_CACHE_NAME;
  const onCacheError = opts.onCacheError ?? defaultOnCacheError;

  // Cache API は GET しか格納できない。`caches` の有無に依らず（Node.js でも）一貫して
  // fail loud にするため、ガードは「キャッシュを使う意図」（cache !== false）で判定する。
  const method = (opts.init?.method ?? "GET").toUpperCase();
  if ((opts.cache ?? true) && method !== "GET") {
    throw new Error(
      `fetch-cache: GET 以外（${method}）はキャッシュできません（Cache API の制約）。` +
        `cache: false を指定してください (${requestUrl})`,
    );
  }

  const cacheStorage = (opts.cache ?? true)
    ? opts.caches ?? globalCaches()
    : undefined;

  // open は読出し・書込みで共有する 1 回だけ。失敗したらキャッシュ無しで続行（縮退+通知）。
  let cache: Cache | undefined;
  if (cacheStorage !== undefined) {
    try {
      cache = await cacheStorage.open(cacheName);
    } catch (error) {
      onCacheError({ op: "open", url: requestUrl, error });
    }
  }

  if (cache !== undefined) {
    let cachedBytes: Uint8Array<ArrayBuffer> | undefined;
    try {
      const cached = await cache.match(requestUrl);
      cachedBytes = cached === undefined
        ? undefined
        : new Uint8Array(await cached.arrayBuffer());
    } catch (error) {
      // 読出し失敗は miss と同じ扱いで network へ縮退する。
      onCacheError({ op: "match", url: requestUrl, error });
    }
    if (cachedBytes !== undefined) {
      if (opts.validate === undefined) return cachedBytes;
      try {
        await opts.validate(cachedBytes);
        return cachedBytes;
      } catch {
        // 破損キャッシュ。真実源から取り直すため evict してフォールスルー（self-heal）。
        try {
          await cache.delete(requestUrl);
        } catch (error) {
          // evict 失敗でも再取得は続行できる（残った破損エントリは次回また self-heal を試みる）。
          onCacheError({ op: "delete", url: requestUrl, error });
        }
      }
    }
  }

  const response = await fetchImpl(requestUrl, opts.init);
  if (!response.ok) {
    // 未消費 body は接続リソースを保持し続けるため解放してから throw する。
    // cancel 自体の失敗は握りつぶす（本命の HTTP エラーを優先する後始末）。
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `fetch-cache: HTTP ${response.status} ${response.statusText} (${requestUrl})`,
    );
  }
  const bytes = await readBody(response, opts.onProgress);
  // validate 成功後にのみ cache.put（不正物をキャッシュに残さない）。失敗はそのまま throw。
  await opts.validate?.(bytes);
  if (cache !== undefined) {
    // put 失敗（quota 超過等）は成功したダウンロードを巻き添えにしない（縮退+通知）。
    try {
      await cache.put(requestUrl, new Response(bytes));
    } catch (error) {
      onCacheError({ op: "put", url: requestUrl, error });
    }
  }
  return bytes;
};

/**
 * 指定 URL のキャッシュエントリを削除する。エントリがあったら true。
 * `caches` が無いランタイムでは常に false。
 */
export const evictUrl = async (
  url: string | URL,
  opts: { cacheName?: string } = {},
): Promise<boolean> => {
  if (typeof caches === "undefined") return false;
  const cache = await caches.open(opts.cacheName ?? DEFAULT_CACHE_NAME);
  return await cache.delete(typeof url === "string" ? url : url.href);
};

/**
 * 名前空間ごとキャッシュを削除する（`caches.delete`）。名前空間があったら true。
 * `caches` が無いランタイムでは常に false。
 */
export const clearCache = async (
  cacheName: string = DEFAULT_CACHE_NAME,
): Promise<boolean> => {
  if (typeof caches === "undefined") return false;
  return await caches.delete(cacheName);
};

// Deno（2.8 時点）は Cache API のうち keys() を実装していない（put/match/delete のみ）。
// 型定義には keys が居るため、実行時の feature-detect で判定する。
type CacheWithKeys = Cache & { keys: () => Promise<readonly Request[]> };
const supportsKeys = (cache: Cache): cache is CacheWithKeys =>
  typeof (cache as Partial<CacheWithKeys>).keys === "function";

/**
 * 名前空間内のキャッシュ済み URL 一覧を返す。`caches` が無いランタイムでは []。
 *
 * NOTE: `caches` はあるが `Cache.keys()` が未実装のランタイム（現行 Deno）では throw する
 *       （fail loud）。実在するエントリを [] と偽ると、この一覧に基づく掃除・表示が静かに
 *       壊れるため、欠落は隠さない。
 */
export const listCachedUrls = async (
  cacheName: string = DEFAULT_CACHE_NAME,
): Promise<string[]> => {
  if (typeof caches === "undefined") return [];
  const cache = await caches.open(cacheName);
  if (!supportsKeys(cache)) {
    throw new Error(
      "fetch-cache: このランタイムの Cache API は keys() を実装していないため一覧できません（現行 Deno など）",
    );
  }
  const keys = await cache.keys();
  return keys.map((request) => request.url);
};
