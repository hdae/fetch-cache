/**
 * `@hdae/fetch-cache` — URL ベースの Cache API 付きダウンロード（汎用層）。
 *
 * `fetchBytes` は URL をそのままキーに Cache Storage へ保存し、2 回目以降は network なしで返す。
 * `validate` フックはキャッシュヒット側にも適用され、破損キャッシュは evict して真実源から取り直す
 * （self-heal）。`decode` フックで「保存形 ≠ 利用形」（例: gzip のまま保存・解凍して返す）に
 * 対応する（throw は破損扱い＝validate と同じ縮退経路）。`caches` が無いランタイム
 * （Node.js 等）では素の fetch にフォールバックする＝キャッシュは正しさの要件ではなく最適化。
 *
 * MUST: 実行時依存ゼロ。fetch / caches / crypto.subtle など Web 標準 API のみを使う。
 *
 * @module
 */

export const VERSION = "0.3.0";

/** ダウンロード進捗。`total` は content-length ヘッダがあるときだけ入る。 */
export type FetchProgress = { loaded: number; total?: number };

/** cache I/O 失敗の通知内容。`op` は失敗した Cache API 操作。 */
export type CacheErrorContext = {
  op: "open" | "match" | "put" | "delete";
  url: string;
  error: unknown;
};

/** 保存形（raw）バイト列の検証。throw = 破損。 */
export type ValidateBytes = (bytes: Uint8Array) => void | Promise<void>;

/**
 * 保存形（raw）→ 利用形への変換（解凍・復号など）。throw = 破損扱い（validate と同じ縮退経路:
 * キャッシュヒット側は self-heal、network 側はそのまま throw・キャッシュしない）。
 */
export type DecodeBytes = (raw: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export type FetchBytesOptions = {
  /** Cache Storage の名前空間。既定 "fetch-cache"。 */
  cacheName?: string;
  /** false で Cache API を一切触らない素の fetch。既定 true（URL がそのままキー）。 */
  cache?: boolean;
  /**
   * 取得/キャッシュ読出しバイト列の検証。throw = 不正。キャッシュヒット側にも適用され、
   * 失敗時は evict して network から取り直す（self-heal）。network 取得物の失敗はそのまま
   * throw（不正物はキャッシュしない）。
   *
   * NOTE: 常に保存形（raw = cache に入る/入っているバイト列そのもの）に対して走る。
   *       `decode` 併用時も decode の**前**。利用形側の検証は decode 内で throw する。
   */
  validate?: ValidateBytes;
  /**
   * 保存形（raw）→ 利用形への変換（例: gzip のまま保存し、解凍して返す）。cache には raw を
   * そのまま保存し、戻り値には decode 適用後を返す。decode の throw は破損扱いで validate と
   * 同じ縮退経路に乗る: キャッシュヒット側は evict → network から取り直し（self-heal）、
   * network 取得物はそのまま throw（decode 不能物はキャッシュしない）。省略時は raw をそのまま
   * 返す（従来と完全互換）。gzip には同梱の `decodeGzip` がそのまま使える。
   *
   * MUST NOT: `raw` を破壊的に変更しない — network 側では decode 成功後にその raw を
   * cache.put するため、変更すると壊れた内容がキャッシュされる。
   * MUST NOT: `decode` / `validate` の中から同一 (cacheName, URL) の `fetchBytes` を
   * 呼ばない — 自分自身の in-flight フライトに合流して自己デッドロックする
   * （DECIDED: docs/decisions/0004）。
   */
  decode?: DecodeBytes;
  /**
   * ダウンロード進捗（チャンク毎）。キャッシュヒット時は呼ばれない。進捗は任意情報であり、
   * リスナーの throw は取得を落とさない（console.warn で通知して続行 — single-flight の
   * 合流フライトで 1 リスナーの事故が他の呼び出しを巻き添えにしないため。
   * DECIDED: docs/decisions/0004）。
   */
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
 * validate（raw の完全性検証）→ decode（保存形 → 利用形）の共有経路。キャッシュヒット側と
 * network 側で必ずこの順・この意味論を共有する（経路毎に別実装すると契約が黙って乖離する）。
 * throw はどちら由来でも「破損」として呼び出し側の縮退経路に乗る。
 */
const validateAndDecode = async (
  raw: Uint8Array,
  opts: FetchBytesOptions,
): Promise<Uint8Array> => {
  await opts.validate?.(raw);
  return opts.decode === undefined ? raw : await opts.decode(raw);
};

/**
 * 同一 (cacheName, URL) の in-flight 取得（single-flight の合流点）。
 * `raw` は保存形（cache に入る/入っているバイト列）で、合流者は各自の
 * validate / decode をこれに適用する（decode との直交 — DECIDED: docs/decisions/0004）。
 */
type InflightEntry = {
  /** 先行呼び出しの取得結果。decoded は先行呼び出しのオプションで decode 済みの値。 */
  promise: Promise<{ raw: Uint8Array; decoded: Uint8Array }>;
  /** 進捗の fan-out 先（合流者の onProgress もここに登録される）。 */
  listeners: Set<(progress: FetchProgress) => void>;
  /** 直近の進捗。合流時に 1 回即時通知して、合流者の表示を現在地へ追いつかせる。 */
  state: { last?: FetchProgress };
};

const inflight = new Map<string, InflightEntry>();

/**
 * 進捗リスナーの隔離ラッパ。進捗は任意情報（正しさの要件ではない）なので、リスナーの throw で
 * 取得を落とさない — 特に single-flight の合流フライトでは 1 リスナーの事故が他の呼び出しの
 * ダウンロードまで巻き添えにする。onCacheError と同じ「落とさず・無言にもしない」縮退方針。
 */
const isolateProgress = (
  listener: (progress: FetchProgress) => void,
  requestUrl: string,
): (progress: FetchProgress) => void =>
(progress) => {
  try {
    listener(progress);
  } catch (error) {
    console.warn(
      `fetch-cache: onProgress リスナーが throw しました（通知のみ中断・取得は続行） (${requestUrl})`,
      error,
    );
  }
};

/**
 * raw 取得と（先行呼び出しオプションでの）validate/decode の本体。cache open/match →
 * self-heal → network → put の一連で、常に { raw: 保存形, decoded: decode 適用後 } を返す。
 * single-flight の合流者は raw を受け取り、各自の validate/decode を適用し直す。
 */
const acquireAndDecode = async (
  requestUrl: string,
  opts: FetchBytesOptions,
  emitProgress: ((progress: FetchProgress) => void) | undefined,
): Promise<{ raw: Uint8Array; decoded: Uint8Array }> => {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const cacheName = opts.cacheName ?? DEFAULT_CACHE_NAME;
  const onCacheError = opts.onCacheError ?? defaultOnCacheError;

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
      try {
        return {
          raw: cachedBytes,
          decoded: await validateAndDecode(cachedBytes, opts),
        };
      } catch {
        // 破損キャッシュ（validate 拒否 or decode 不能）。真実源から取り直すため evict して
        // フォールスルー（self-heal）。
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
  const bytes = await readBody(response, emitProgress);
  // validate / decode 成功後にのみ cache.put（不正物・decode 不能物をキャッシュに残さない）。
  // 失敗はそのまま throw。put するのは常に保存形 raw（decode 前）。
  const decoded = await validateAndDecode(bytes, opts);
  if (cache !== undefined) {
    // put 失敗（quota 超過等）は成功したダウンロードを巻き添えにしない（縮退+通知）。
    try {
      await cache.put(requestUrl, new Response(bytes));
    } catch (error) {
      onCacheError({ op: "put", url: requestUrl, error });
    }
  }
  return { raw: bytes, decoded };
};

/**
 * URL からバイト列を取得する（Cache API 優先・self-heal・single-flight・fail loud）。
 *
 * キャッシュヒット時は network に出ない（onProgress も呼ばれない）。`validate` / `decode` が
 * キャッシュ内容を拒否したら evict して network から取り直す（self-heal）。network 取得物が
 * `validate` / `decode` に落ちたらそのまま throw し、不正物はキャッシュしない。HTTP エラーは
 * `fetch-cache: HTTP {status} {statusText} ({url})` で throw する。cache に入るのは常に
 * 保存形（raw）で、戻り値は `decode` 適用後（省略時は raw）。
 *
 * **single-flight**: 同一 (cacheName, URL) への並行呼び出しは 1 フライトに合流し、
 * network への取得は 1 回だけになる（cache 有効時のみ。`cache: false` は「毎回取りに行く」
 * 意図を尊重して合流しない）。合流者には保存形 raw が共有され、`validate` / `decode` は
 * 各呼び出しが自分のオプションで適用する。取得失敗は合流した全呼び出しへ伝播し、フライト
 * 終了後の呼び出しは新規に取得する（失敗は記憶しない）。`onProgress` は合流者へも fan-out
 * され、合流時に直近の進捗が 1 回即時通知される。NOTE: 合流者の `fetch` / `caches` /
 * `init` / `onCacheError` は使われない — 取得は先行呼び出しのオプションで走っている
 * （DECIDED: docs/decisions/0004、docs/limitations.md）。
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

  // Cache API は GET しか格納できない。`caches` の有無に依らず（Node.js でも）一貫して
  // fail loud にするため、ガードは「キャッシュを使う意図」（cache !== false）で判定する。
  const method = (opts.init?.method ?? "GET").toUpperCase();
  if ((opts.cache ?? true) && method !== "GET") {
    throw new Error(
      `fetch-cache: GET 以外（${method}）はキャッシュできません（Cache API の制約）。` +
        `cache: false を指定してください (${requestUrl})`,
    );
  }

  // cache 無効の呼び出しは合流しない（非 GET・「必ず新規取得」の意図を保つ）。
  if (opts.cache === false) {
    const { decoded } = await acquireAndDecode(
      requestUrl,
      opts,
      opts.onProgress === undefined
        ? undefined
        : isolateProgress(opts.onProgress, requestUrl),
    );
    return decoded;
  }

  // 区切りは U+0000（cacheName にも URL 文字列にも現れない制御文字）。可視文字で連結すると
  // ("x", "y z") と ("x y", "z") のような別ペアが同一キーへ衝突し誤合流する。
  // NOTE: 必ずエスケープ表記で書く — 生の制御文字は不可視でレビューを欺く。
  const key = `${opts.cacheName ?? DEFAULT_CACHE_NAME}\u0000${requestUrl}`;
  const existing = inflight.get(key);
  if (existing !== undefined) {
    // 合流: raw（保存形）を受け取り、自分の validate / decode を適用する。
    if (opts.onProgress !== undefined) {
      const isolated = isolateProgress(opts.onProgress, requestUrl);
      existing.listeners.add(isolated);
      // 直近の進捗を 1 回即時通知して、合流者の表示を現在地へ追いつかせる。
      if (existing.state.last !== undefined) isolated(existing.state.last);
    }
    const { raw } = await existing.promise;
    return await validateAndDecode(raw, opts);
  }

  // 先行呼び出し（leader）。MUST: ここから inflight.set まで await を挟まない —
  // 挟むと同一ターンの並行呼び出しが合流できず二重フライトになる（TOCTOU）。
  const listeners = new Set<(progress: FetchProgress) => void>();
  if (opts.onProgress !== undefined) {
    listeners.add(isolateProgress(opts.onProgress, requestUrl));
  }
  const state: { last?: FetchProgress } = {};
  // リスナーは登録時点で全て隔離済み（isolateProgress）。
  const emit = (progress: FetchProgress): void => {
    state.last = progress;
    for (const listener of listeners) listener(progress);
  };
  const promise = acquireAndDecode(requestUrl, opts, emit).finally(() => {
    // 成否に依らずフライトを閉じる（失敗を記憶すると自然回復を妨げる）。合流者は
    // promise への参照を直接持つため、この削除で取りこぼしは起きない。
    inflight.delete(key);
  });
  inflight.set(key, { promise, listeners, state });
  const { decoded } = await promise;
  return decoded;
};

/**
 * gzip を解凍する decode ヘルパ（`decode: decodeGzip` でそのまま渡せる）。
 * DecompressionStream（Web 標準）が無いランタイムでは throw する（fail loud）。
 * 不正な gzip は throw = 破損扱いで self-heal の対象になる。
 */
export const decodeGzip = async (raw: Uint8Array): Promise<Uint8Array> => {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "fetch-cache: このランタイムには DecompressionStream が無いため gzip を解凍できません",
    );
  }
  // SharedArrayBuffer 由来でも Blob に渡せるようコピーで ArrayBuffer 背面を保証する。
  const stream = new Blob([new Uint8Array(raw)]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * 指定 URL のキャッシュエントリを削除する。エントリがあったら true。
 * `caches` が無いランタイム・名前空間ごと存在しない場合は常に false。
 */
export const evictUrl = async (
  url: string | URL,
  opts: { cacheName?: string } = {},
): Promise<boolean> => {
  if (typeof caches === "undefined") return false;
  const cacheName = opts.cacheName ?? DEFAULT_CACHE_NAME;
  // caches.open は無い名前空間を永続作成してしまう（削除 API の副作用として不適切）。
  // 名前空間が無ければエントリも無い — 触らずに false を返す。
  if (!(await caches.has(cacheName))) return false;
  const cache = await caches.open(cacheName);
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

// Cache.keys() の有無はランタイム依存（Deno 2.8 以前は未実装・2.9 で実装、ブラウザは実装済み）。
// 型定義もバージョンで揺れるため、実行時の feature-detect で判定する。
type CacheWithKeys = Cache & { keys: () => Promise<readonly Request[]> };
const supportsKeys = (cache: Cache): cache is CacheWithKeys =>
  typeof (cache as Partial<CacheWithKeys>).keys === "function";

/**
 * 名前空間内のキャッシュ済み URL 一覧を返す。`caches` が無いランタイム・名前空間ごと
 * 存在しない場合は []（空は事実 — 名前空間を作る副作用も持たない）。
 *
 * NOTE: `caches` はあるが `Cache.keys()` が未実装のランタイム（Deno 2.8 以前）では throw する
 *       （fail loud）。実在するエントリを [] と偽ると、この一覧に基づく掃除・表示が静かに
 *       壊れるため、欠落は隠さない。
 */
export const listCachedUrls = async (
  cacheName: string = DEFAULT_CACHE_NAME,
): Promise<string[]> => {
  if (typeof caches === "undefined") return [];
  if (!(await caches.has(cacheName))) return [];
  const cache = await caches.open(cacheName);
  if (!supportsKeys(cache)) {
    throw new Error(
      "fetch-cache: このランタイムの Cache API は keys() を実装していないため一覧できません（Deno 2.8 以前など）",
    );
  }
  const keys = await cache.keys();
  return keys.map((request) => request.url);
};
