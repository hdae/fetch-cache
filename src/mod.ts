/**
 * `@hdae/fetch-cache` — URL ベースの Cache API 付きダウンロード（汎用層）。
 *
 * `fetchBytes` は URL をそのままキーに Cache Storage へ保存し、2 回目以降は network なしで返す。
 * `validate` フックはキャッシュヒット側にも適用され、破損キャッシュは evict して真実源から取り直す
 * （self-heal）。`decode` フックで「保存形 ≠ 利用形」（例: gzip のまま保存・解凍して返す）に
 * 対応する（throw は破損扱い＝validate と同じ縮退経路）。`caches` が無いランタイム
 * （Node.js 等）では素の fetch にフォールバックする＝キャッシュは正しさの要件ではなく最適化。
 * `prefetchUrl` は body をそのまま cache へ流し込む streaming 版で、巨大アセットを
 * ヒープに載せずに温めるためにある（`sha256` を渡せば通過中に検証し、通ったエントリにだけ
 * 検証済みマーカーを焼く。渡さなければ検証は読み出し時 = `fetchBytes` に一本化）。
 *
 * MUST: 実行時依存ゼロ。fetch / caches / crypto.subtle など Web 標準 API のみを使う
 * （通過中の逐次ハッシュだけは一括専用の crypto.subtle で賄えないため純 TS 実装を内包する
 * — src/sha256.ts）。
 *
 * @module
 */

import { createSha256 } from "./sha256.ts";

export const VERSION = "0.3.1";

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
   * 受信バイト数の事前申告（**確保ヒントのみ** — 検証には使わない）。分かっているときは
   * 受信バッファを 1 本先に確保してチャンクを直接書き込むため、チャンク蓄積 → 連結で
   * 一瞬 2N になるヒープのピークが 1N で済む（数 GB 級で実害）。省略時は content-length を
   * ヒントに使う。申告が実受信とずれたら黙って蓄積経路へ落ちる（超過なら継ぎ足し、不足なら
   * 実長へ詰め直す）— content-length を信頼しない現行方針（docs/limitations.md）と同じく、
   * ヒントが外れても取得は落とさない。長さの検証がしたいなら `validate` で行う。
   */
  expectedBytes?: number;
  /**
   * 検証済みマーカー（**opt-in**。省略時は現行どおりヒット毎に `validate` が走る）。
   *
   * 指定すると network 取得物の `validate` 通過後、この文字列を印としてキャッシュエントリへ
   * 焼き込み、以後のキャッシュヒットで印が一致したときだけ `validate` を丸ごと省く
   * （典型は sha256 hex。数 GB のモデルで毎回の再ハッシュを避ける用途）。
   *
   * MUST: これは「ローカル格納を信頼する」選択である。印は「このエントリのバイト列は保存時に
   * validate を通った」という自己申告に過ぎず、格納後の改竄・ビット腐敗は検出できない
   * （マーカーごと書き換えられる）。信頼境界を移す判断なので既定は据え置き（DECIDED:
   * docs/decisions/0005）。
   * NOTE: 印は `validate` **全体**の通過を意味する（HF 層なら expectedBytes / sha256 /
   *       カスタム validate の全部）。同じ URL に別の検証ロジックを当てるなら印も変えること。
   * NOTE: 印が焼かれるのは「このオプション付きで network 取得した」エントリと
   *       「`prefetchUrl` に `sha256` を渡して通過中検証を通した」エントリだけで、既存エントリや
   *       検証なし prefetch が書いたエントリには付かない。single-flight の合流者も印を見ない
   *       （常に自分の validate を走らせる = 安全側）。
   *       prefetch 由来の印が意味するのは sha256 の一致だけなので、同じ URL に sha256 以外の
   *       検証（カスタム validate 等）も当てているなら、その分はヒット時に省かれる
   *       （sha256 一致 = バイト同一なので実害は宣言の食い違いに限られる）。
   */
  verifiedMarker?: string;
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
 * 受信バッファの事前確保。サイズ申告は信頼しないので、不正値（非整数・負・巨大すぎて
 * RangeError）は「ヒント無し」に落として蓄積経路へ委ねる（取得は落とさない）。
 */
const allocateHint = (size: number): Uint8Array<ArrayBuffer> | undefined => {
  if (!Number.isSafeInteger(size) || size <= 0) return undefined;
  try {
    return new Uint8Array(size);
  } catch {
    return undefined;
  }
};

/**
 * body を streaming で読み切り、チャンク毎に onProgress を発火する。
 * body が null のランタイム向けに arrayBuffer フォールバックを持つ（そのときは読み切り後に 1 回発火）。
 *
 * サイズが分かるとき（`expectedBytes` か content-length）は 1 本のバッファを先に確保して
 * チャンクを直接書き込む。チャンク蓄積 → 連結だと連結の瞬間に N + N がヒープに載るため
 * （数 GB 級で実害）、ピークを 1N に抑えるのが目的。申告が外れたら蓄積経路へ落ちるだけで、
 * 申告そのものは検証に使わない（docs/limitations.md の「content-length と突合しない」を維持）。
 * 戻り値は常に buffer 全体を占める tight view（呼び出し側の zero-copy 前提を壊さない）。
 */
const readBody = async (
  response: Response,
  onProgress?: (progress: FetchProgress) => void,
  expectedBytes?: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  const total = readTotal(response);
  const body = response.body;
  if (body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.({ loaded: bytes.length, total });
    return bytes;
  }
  const hint = expectedBytes ?? total;
  let buffer = hint === undefined ? undefined : allocateHint(hint);
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (buffer !== undefined) {
      if (loaded + value.length > buffer.length) {
        // 申告超過（Content-Encoding 越しの content-length 等）。ここまでの内容を蓄積経路へ
        // 引き継いで以降は従来どおり溜める。
        chunks.push(buffer.subarray(0, loaded));
        buffer = undefined;
      } else {
        buffer.set(value, loaded);
      }
    }
    if (buffer === undefined) chunks.push(value);
    loaded += value.length;
    onProgress?.({ loaded, total });
  }
  // 申告不足（宣言 > 実受信）のときだけ実長へ詰め直す（tight view を保つ）。
  if (buffer !== undefined) {
    return loaded === buffer.length ? buffer : buffer.slice(0, loaded);
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
 * 検証済みマーカーを載せるレスポンスヘッダ。Cache API はヘッダごと格納するので、印は
 * エントリと同じ寿命を持つ（エントリが消えれば印も消える＝取り違えない）。
 */
const VERIFIED_HEADER = "x-fetch-cache-verified";

/**
 * 保存用 Response を組み立てる。bytes を直接 body にすると実装が全量コピーする
 * （Deno 2.9.4 実測: 512MiB の `new Response(bytes)` で RSS が +512MiB）ため、1 チャンクの
 * stream として渡してコピーを避ける（同 +4MiB）。受信バッファの事前確保（`expectedBytes`）と
 * 合わせて network 経路のヒープを 1N に保つのが狙いで、格納内容は完全に同じ。
 * `marker` があれば検証済みマーカーを焼く。
 */
const storableResponse = (bytes: Uint8Array, marker?: string): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return marker === undefined
    ? new Response(body)
    : new Response(body, { headers: { [VERIFIED_HEADER]: marker } });
};

/**
 * validate（raw の完全性検証）→ decode（保存形 → 利用形）の共有経路。キャッシュヒット側と
 * network 側で必ずこの順・この意味論を共有する（経路毎に別実装すると契約が黙って乖離する）。
 * throw はどちら由来でも「破損」として呼び出し側の縮退経路に乗る。
 *
 * `verified` はキャッシュヒットでマーカーが一致したときだけ true になり、validate を省く
 * （opt-in — `FetchBytesOptions.verifiedMarker`）。decode は利用形を作る変換なので常に走る。
 */
const validateAndDecode = async (
  raw: Uint8Array,
  opts: FetchBytesOptions,
  verified = false,
): Promise<Uint8Array> => {
  if (!verified) await opts.validate?.(raw);
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
    // 検証済みマーカーが一致したエントリだけ validate を省く（opt-in。既定は毎回検証）。
    let verified = false;
    try {
      const cached = await cache.match(requestUrl);
      if (cached !== undefined) {
        verified = opts.verifiedMarker !== undefined &&
          cached.headers.get(VERIFIED_HEADER) === opts.verifiedMarker;
        cachedBytes = new Uint8Array(await cached.arrayBuffer());
      }
    } catch (error) {
      // 読出し失敗は miss と同じ扱いで network へ縮退する。
      onCacheError({ op: "match", url: requestUrl, error });
    }
    if (cachedBytes !== undefined) {
      try {
        return {
          raw: cachedBytes,
          decoded: await validateAndDecode(cachedBytes, opts, verified),
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
  const bytes = await readBody(response, emitProgress, opts.expectedBytes);
  // validate / decode 成功後にのみ cache.put（不正物・decode 不能物をキャッシュに残さない）。
  // 失敗はそのまま throw。put するのは常に保存形 raw（decode 前）。
  const decoded = await validateAndDecode(bytes, opts);
  if (cache !== undefined) {
    // Response の組み立ては try の外（不正な verifiedMarker は cache I/O 失敗ではなく
    // 呼び出し側のバグなので、縮退で黙らせず fail loud に出す）。
    const stored = storableResponse(bytes, opts.verifiedMarker);
    // put 失敗（quota 超過等）は成功したダウンロードを巻き添えにしない（縮退+通知）。
    try {
      await cache.put(requestUrl, stored);
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
 * NOTE: `expectedBytes`（受信バッファの確保ヒント）と `verifiedMarker`（検証済みマーカーで
 *       ヒット時の validate を省く opt-in）は既定挙動を変えない追加オプション
 *       （DECIDED: docs/decisions/0005）。
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

export type PrefetchUrlOptions = {
  /** Cache Storage の名前空間。既定 "fetch-cache"（fetchBytes と同じ）。 */
  cacheName?: string;
  /**
   * 期待 SHA-256（64 桁小文字 hex）。指定すると**通過中に**逐次ハッシュして検証する
   * （バイト列はヒープに溜めない）。省略時は従来どおり無検証で格納する。
   *
   * 一致したときだけエントリが成立し、同時に検証済みマーカー（この sha256）が焼かれる
   * ため、以後 `fetchBytes` の `verifiedMarker` に同じ値を渡せばヒット時の再ハッシュを
   * 省ける。不一致なら stream を error にして `cache.put` ごと reject させる ＝
   * **印付きの不正エントリは構造的に生まれない**（DECIDED: docs/decisions/0005）。
   *
   * NOTE: 印は「この sha256 に一致した」ことだけを主張する。読み出し側が sha256 以外の
   *       検証も宣言していて `verifiedMarker` で省いてよいかは、呼び出し側の判断。
   * NOTE: 既存エントリがあるときは network に出ないので検証も走らない（戻り値 false）。
   *       既存の内容を検証したいなら `fetchBytes`（self-heal 付き）を使うこと。
   */
  sha256?: string;
  /**
   * ダウンロード進捗（チャンク毎）。既にキャッシュ済みで network に出ないときは呼ばれない。
   * リスナーの throw は取得を落とさない（fetchBytes と同じ隔離）。
   */
  onProgress?: (progress: FetchProgress) => void;
  /** fetch へそのまま渡す RequestInit（Authorization / AbortSignal など）。GET のみ。 */
  init?: RequestInit;
  /** fetch の差し替え（テスト・カスタム輸送用）。既定 globalThis.fetch。 */
  fetch?: typeof globalThis.fetch;
  /** CacheStorage の差し替え（テストの故障注入用）。既定 globalThis.caches。 */
  caches?: CacheStorage;
};

/**
 * URL の内容を**ヒープに全量を載せずに**キャッシュへ格納する（streaming prefetch）。
 * network 応答の body をそのまま `cache.put` へ流すため、数 GB 級でも JS ヒープの使用は
 * チャンク数個ぶんで済む。戻り値は「network から取得して格納した」なら true、
 * 「既にエントリがあって何もしなかった」なら false。
 *
 * **検証は `sha256` を渡したときだけ**: 渡せば通過中に逐次ハッシュして突合し、一致した
 * ものだけがエントリとして成立する（同時に検証済みマーカーが焼かれ、以後の `fetchBytes` は
 * `verifiedMarker` で再ハッシュを省ける）。渡さなければ従来どおり無検証で格納し、完全性の
 * 検証は読み出し側（`fetchBytes` の `validate` → 失敗なら evict → 取り直し）に一本化する
 * — その場合は未検証バイトが一時的にキャッシュへ載る（TOCTOU。self-heal があるので恒久化は
 * しない）。`validate` フックそのものは持てない（バイト列が手元に無いため）ので、sha256 以外の
 * 検証をしたい用途では `fetchBytes` を使うこと（DECIDED: docs/decisions/0005）。
 *
 * **single-flight の対象外**: `fetchBytes` の合流（ADR 0004）は「leader の保存形 raw を
 * 合流者へ渡す」契約だが、prefetch は raw を持たないため合流できない。同一 URL の並行
 * prefetch はそれぞれ network に出る（put は内容同一の last-writer-wins で整合性は壊れない
 * — `cache: false` と同じ割り切り）。
 *
 * **縮退しない（fail loud）**: `caches` が無い / open 失敗 / HTTP エラー / 転送中断 /
 * put 失敗（quota 超過等）はすべて throw する。cache への格納がこの関数の唯一の仕事であり、
 * 手元にバイトも残らないので「続行」に意味が無いため（`fetchBytes` の縮退契約
 * ADR 0001 とはここが違う）。呼び出し側は throw を受けたら `fetchBytes` へフォールバック
 * すればよい（そちらは全量をヒープに載せる代わりに cache 失敗でも結果を返す）。
 * 転送が途中で切れた場合、`cache.put` 自体が reject してエントリは成立しない
 * （中途半端なエントリは残らない）。sha256 不一致も同じ経路でエントリを潰すが、
 * そちらは cache の失敗ではなく取得内容の不正なので、期待値と実測値を含む専用のエラーを
 * 投げる（fetchBytes へ逃げても同じ物が落ちてくるため）。
 */
export const prefetchUrl = async (
  url: string | URL,
  opts: PrefetchUrlOptions = {},
): Promise<boolean> => {
  const requestUrl = typeof url === "string" ? url : url.href;

  // Cache API は GET しか格納できない。prefetch は「キャッシュへ入れる」ことが目的なので
  // 非 GET に縮退の余地は無い（fetchBytes の cache:false に相当する逃げ道も持たない）。
  const method = (opts.init?.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    throw new Error(
      `fetch-cache: prefetchUrl は GET 専用です（${method} は Cache API に格納できません） (${requestUrl})`,
    );
  }

  // 形式不正の申告は必ず不一致になる（＝全量ダウンロードしてから落ちる）。呼び出し側のバグ
  // なので network に出る前に fail loud で弾く。
  const expectedSha256 = opts.sha256;
  if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(
      `fetch-cache: sha256 は 64 桁の小文字 hex で指定してください: ${expectedSha256} (${requestUrl})`,
    );
  }

  const cacheStorage = opts.caches ?? globalCaches();
  if (cacheStorage === undefined) {
    throw new Error(
      `fetch-cache: このランタイムには caches が無いため prefetch できません（fetchBytes を使ってください） (${requestUrl})`,
    );
  }
  const cache = await cacheStorage.open(opts.cacheName ?? DEFAULT_CACHE_NAME);

  // 既存エントリがあれば network に出ない（検証はしない — 読み出し側の self-heal に委ねる）。
  // match が返す Response の body は消費しないので、接続/ファイルハンドルを解放しておく。
  const existing = await cache.match(requestUrl);
  if (existing !== undefined) {
    await existing.body?.cancel().catch(() => {});
    return false;
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const response = await fetchImpl(requestUrl, opts.init);
  if (!response.ok) {
    // 未消費 body は接続リソースを保持し続けるため解放してから throw する（fetchBytes と同じ）。
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `fetch-cache: HTTP ${response.status} ${response.statusText} (${requestUrl})`,
    );
  }

  const total = readTotal(response);
  const emit = opts.onProgress === undefined
    ? undefined
    : isolateProgress(opts.onProgress, requestUrl);
  const hasher = expectedSha256 === undefined ? undefined : createSha256();
  const mismatch = (actual: string): Error =>
    new Error(
      `fetch-cache: prefetch の SHA-256 不一致: ${actual} != ${expectedSha256} (${requestUrl})`,
    );
  // 不一致は put の reject として現れるが、それは cache I/O の失敗ではなく取得内容の不正。
  // put のラップメッセージに埋もれさせず本来のエラーを投げるため、ここで捕まえておく。
  let integrityError: Error | undefined;

  // 検証済みマーカーは Response の構築時点で焼く。put の成立と通過中検証の通過が不可分に
  // なり、「印だけ付いた不正エントリ」が構造的に作れなくなる（DECIDED: docs/decisions/0005）。
  const markerInit = expectedSha256 === undefined
    ? undefined
    : { headers: { [VERIFIED_HEADER]: expectedSha256 } };

  const body = response.body;
  let stored: Response;
  if (body === null) {
    // body が null のランタイム向けフォールバック（この経路だけは全量が一度ヒープに載る）。
    const bytes = new Uint8Array(await response.arrayBuffer());
    emit?.({ loaded: bytes.length, total });
    if (hasher !== undefined) {
      hasher.update(bytes);
      const actual = hasher.hex();
      // ここはまだ put していないので、そのまま throw すればエントリは作られない。
      if (actual !== expectedSha256) throw mismatch(actual);
    }
    stored = new Response(bytes, markerInit);
  } else {
    // 素通しの TransformStream で進捗を数え、sha256 指定時はチャンク毎に取り込む
    // （バッファはしない＝ヒープに溜めない）。
    let loaded = 0;
    const counted = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          loaded += chunk.byteLength;
          // 通過中検証があるときはチャンクを複製し、ハッシュと格納へ同じ複製を渡す。元の
          // チャンクは呼び出し側（fetch 差し替えや onProgress リスナー）が参照を握ったまま
          // update 後に書き換えられるため、共有すると「印は付いたが中身がハッシュと違う」
          // エントリを作る手順が生まれる（MUST: 印の健全性を呼び出し側の行儀に依存させない
          // — DECIDED: docs/decisions/0005 §5）。印が無ければ乖離は無害なので複製しない。
          const owned = hasher === undefined ? chunk : chunk.slice();
          hasher?.update(owned);
          emit?.({ loaded, total });
          controller.enqueue(owned);
        },
        flush(controller) {
          if (hasher === undefined) return;
          const actual = hasher.hex();
          if (actual === expectedSha256) return;
          // stream を error にして cache.put ごと reject させる（＝エントリ不成立）。
          integrityError = mismatch(actual);
          controller.error(integrityError);
        },
      }),
    );
    stored = new Response(counted, markerInit);
  }

  try {
    await cache.put(requestUrl, stored);
  } catch (error) {
    // 転送中断も quota 超過もここに集まる（どちらも put の reject として現れる）。原因は
    // cause に残し、「手元にバイトが無い＝縮退できない」ことを呼び出し側へ伝える。
    if (integrityError !== undefined) throw integrityError;
    throw new Error(
      `fetch-cache: prefetch のキャッシュ書込みに失敗しました（バイト列は手元に残らないため fetchBytes へフォールバックしてください） (${requestUrl})`,
      { cause: error },
    );
  }
  if (integrityError !== undefined) {
    // 保険: stream の error を無視してエントリを作る Cache 実装があっても、印付きの不正
    // エントリだけは残さない（印は以後の検証を省かせるので、残ると恒久的に効いてしまう）。
    await cache.delete(requestUrl).catch(() => {});
    throw integrityError;
  }
  return true;
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
