/**
 * `@hdae/fetch-cache` — Cache API を「制御」するダウンロード層（汎用層）。
 *
 * `fetchBytes` は URL（または配列 `key`）をキーに Cache Storage へ保存し、2 回目以降は
 * network なしで返す。鮮度の扱いは 3 系統: 省略時はヒットを信じる（ノーヒント）、`sha256` を
 * 渡せば保存時に検証して**記録ハッシュ**をエントリへ焼き、以後のヒットは記録との文字列比較
 * だけで済ませる（HashSum。既定はローカル格納を信頼 = 再ハッシュしない。`recheck` で opt-out）。
 * 条件付き GET（revalidate）は将来の変種として予約のみ（DECIDED: docs/decisions/0006）。
 * `validate` フックはキャッシュヒット側にも常に適用され、破損キャッシュは evict して真実源から
 * 取り直す（self-heal）。`decode` フックで「保存形 ≠ 利用形」（例: gzip のまま保存・解凍して
 * 返す）に対応する（throw は破損扱い＝validate と同じ縮退経路）。`caches` が無いランタイム
 * （Node.js 等）では素の fetch にフォールバックする＝キャッシュは正しさの要件ではなく最適化。
 * `prefetchUrl` は body をそのまま cache へ流し込む streaming 版で、巨大アセットをヒープに
 * 載せずに温めるためにある（`sha256` を渡せば通過中に検証し、通ったエントリにだけ記録
 * ハッシュを焼く）。
 *
 * キーの直列化はこの層が所有する（`key` は配列で受け、内部で予約 origin の URL へ畳む）。
 * 名前空間は内部固定 1 個で、区分けはキー先頭要素とプレフィックス操作（`evict` / `listKeys`）
 * で行う（DECIDED: docs/decisions/0006）。
 *
 * MUST: 実行時依存ゼロ。fetch / caches / crypto.subtle など Web 標準 API のみを使う
 * （通過中の逐次ハッシュだけは一括専用の crypto.subtle で賄えないため純 TS 実装を内包する
 * — src/sha256.ts）。
 *
 * @module
 */

import { createSha256 } from "./sha256.ts";

export const VERSION = "0.4.0";

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

/**
 * キャッシュキー。直列化（単射・可逆）はライブラリが所有し、呼び出し側は配列のまま扱う。
 * 先頭要素が名前空間の役を果たし、`evict` / `listKeys` はプレフィックスで部分木を操作できる。
 *
 * **同一キーを名乗ること = 内容が同一だという呼び出し側の主張**であり、その正しさをこの層は
 * 検証しない（別 URL でも同一キーなら同じエントリ・同じ in-flight フライトを共有する —
 * DECIDED: docs/decisions/0006）。
 *
 * MUST NOT: オブジェクト・非有限数値（NaN / ±Infinity）は要素にできない（fail loud）。
 * 前者は決定的直列化を保証できず、後者は JSON 化で "null" に潰れて相互に衝突するため。
 */
export type CacheKey = readonly (string | number | boolean)[];

export type FetchBytesOptions = {
  /**
   * キャッシュキー（**省略時は URL がそのままキー = 従来と同じ**）。指定するとキャッシュの
   * 読出し・self-heal の evict・書込み・single-flight の合流キーがすべてこのキーになり、
   * network へ出る URL だけが第 1 引数のまま残る。取得元 URL が変わってもキーが同じなら
   * ヒットする（revision 跨ぎ・ミラー跨ぎのキャッシュ共有）。
   *
   * キーの粒度はポリシーである（DECIDED: docs/decisions/0006 §5）: キーに内容識別
   * （sha256 要素等）を含めない安定キーで取得元の revision を切り替えると、`sha256` 併用時は
   * 同一エントリの上書き（行き来で毎回再取得 = ピンポン）、`sha256` 無しでは変更を検知できず
   * 最初の内容に固着（stale）する。内容を共存させたいならキー末尾に sha256 等を含めること。
   *
   * MUST: `cache: false` との併用は「キャッシュを触らないのにキーを指定している」矛盾として
   * throw する。
   */
  key?: CacheKey;
  /** false で Cache API を一切触らない素の fetch。既定 true。 */
  cache?: boolean;
  /**
   * 期待 SHA-256（**64 桁の小文字 hex** — 形式不正は network に出る前に throw）。指定すると:
   *
   * - **network 取得時**: 取得バイト列を native digest で検証（不一致は throw・キャッシュ
   *   しない）し、通過したエントリに**記録ハッシュ**（`x-fetch-cache-sha256` ヘッダ）を焼く。
   * - **キャッシュヒット時**: 記録ハッシュと期待値の**文字列比較だけ**で鮮度を判定する
   *   （ハッシュ計算ゼロ）。不一致 = 内容が変わったものとして evict → 取得元から取り直して
   *   同じキーへ上書き（self-heal）。記録が無いエントリ（旧版・無検証 prefetch 由来）は
   *   実ハッシュを計算して突合する（一致しても記録は書き足さない — N バイトの再 put を要する
   *   ため。DECIDED: docs/decisions/0005 と同じ判断）。
   *
   * MUST: 記録一致のヒットを信じるのは「ローカル単一ユーザーの格納を信頼する」判断である
   * （ADR 0002 の認証スタンスと同型。格納後の故障は大半が miss として現れ、誤ったバイトの
   * 成功ヒットに至るのはビット腐敗・実装バグ級のまれな事象のみ）。疑う運用は `recheck` を使う
   * （DECIDED: docs/decisions/0006 §2）。crypto.subtle が無いランタイムでは throw。
   */
  sha256?: string;
  /**
   * true でキャッシュヒット時に実バイトを再ハッシュして期待値と突合する（既定 false =
   * ローカル格納を信頼）。`sha256` とセットでのみ意味を持つ（単独指定は throw）。
   */
  recheck?: boolean;
  /**
   * 取得/キャッシュ読出しバイト列のカスタム検証。throw = 不正。キャッシュヒット側にも
   * **常に**適用され（記録ハッシュが省くのは sha256 の再計算だけ）、失敗時は evict して
   * network から取り直す（self-heal）。network 取得物の失敗はそのまま throw（不正物は
   * キャッシュしない）。built-in の `sha256` 検証の後に走る。
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
   * 返す。gzip には同梱の `decodeGzip` がそのまま使える。
   *
   * MUST NOT: `raw` を破壊的に変更しない — network 側では decode 成功後にその raw を
   * cache.put するため、変更すると壊れた内容がキャッシュされる。
   * MUST NOT: `decode` / `validate` の中から同一キー（`key` ?? URL）の `fetchBytes` を
   * 呼ばない — 自分自身の in-flight フライトに合流して自己デッドロックする
   * （DECIDED: docs/decisions/0004。キー単位への読み替えは 0006）。
   */
  decode?: DecodeBytes;
  /**
   * 受信バイト数の事前申告（**確保ヒントのみ** — 検証には使わない）。分かっているときは
   * 受信バッファを 1 本先に確保してチャンクを直接書き込むため、チャンク蓄積 → 連結で
   * 一瞬 2N になるヒープのピークが 1N で済む（数 GB 級で実害）。省略時は content-length を
   * ヒントに使う。申告と実受信のずれは黙って吸収する（超過なら蓄積経路へ、不足なら実長へ
   * 詰め直す）— 長さの検証がしたいなら `validate` で行う。
   *
   * MUST: 明示申告の**確保自体が失敗**した場合（実行環境の単一 ArrayBuffer 上限超え等）は
   * 縮退せず、受信を始める前に throw する — 縮退しても蓄積経路の終端が同じサイズの連結
   * バッファを要求して同じ理由で落ちるため、失敗を遅らせて帯域を捨てるだけになる（DECIDED:
   * docs/decisions/0007。content-length 由来の確保失敗は従来どおり縮退する）。
   */
  expectedBytes?: number;
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
   * キーは URL（`key` 指定時はそのキー）のみでヘッダ非依存なので、認証付きで取得した bytes は
   * 以後認証なしの呼び出しでもヒットする（docs/limitations.md）。
   *
   * NOTE: Cache API は GET しか格納できないため、cache 有効のまま GET 以外の method を
   *       指定すると throw する（`cache: false` なら任意の method 可 —
   *       DECIDED: docs/decisions/0002）。
   */
  init?: RequestInit;
  /** fetch の差し替え（テスト・カスタム輸送用）。既定 globalThis.fetch。 */
  fetch?: typeof globalThis.fetch;
  /** CacheStorage の差し替え（テストの隔離・故障注入用）。既定 globalThis.caches。 */
  caches?: CacheStorage;
};

// 名前空間は内部固定 1 個。区分けはキー先頭要素 + プレフィックス操作で行う（cacheName
// オプションは 0.5.0 で撤去 — DECIDED: docs/decisions/0006 §3）。
const DEFAULT_CACHE_NAME = "fetch-cache";

// 配列キーを畳み込む予約 origin。RFC 2606 予約 TLD（.invalid）なので実在 URL と衝突しない。
// `/v1/` は直列化方式の識別子（将来方式を変えるときの区別用）。
const KEY_ORIGIN = "https://fetch-cache.invalid";
const KEY_PREFIX = `${KEY_ORIGIN}/v1/`;

/**
 * キー要素の検査。オブジェクト等は決定的直列化を保証できず、非有限数値は JSON 化で "null" に
 * 潰れて相互に衝突する（NaN と Infinity が同一キーになる）ため、どちらも fail loud で弾く。
 */
const assertKeyElement = (element: unknown, key: CacheKey): void => {
  const kind = typeof element;
  if (kind !== "string" && kind !== "number" && kind !== "boolean") {
    throw new Error(
      `fetch-cache: key の要素は string | number | boolean で指定してください（${kind} は不可）: ${
        JSON.stringify(key)
      }`,
    );
  }
  if (kind === "number" && !Number.isFinite(element as number)) {
    throw new Error(
      `fetch-cache: key の数値要素は有限値で指定してください（NaN / Infinity は JSON 直列化で衝突します）: ${
        JSON.stringify(key)
      }`,
    );
  }
};

/**
 * 配列キー → 予約 origin URL への直列化（単射・可逆）。要素毎に JSON 化してから
 * percent-encode するため、`"1"`（文字列）と `1`（数値）が区別され、`/` 入り文字列と
 * セグメント境界の衝突（`["a","b/c"]` と `["a/b","c"]`）も起きない。復元は `deserializeKey`。
 */
const serializeKey = (key: CacheKey): string => {
  if (key.length === 0) {
    throw new Error("fetch-cache: key は 1 要素以上の配列で指定してください");
  }
  for (const element of key) assertKeyElement(element, key);
  return KEY_PREFIX +
    key.map((element) => encodeURIComponent(JSON.stringify(element))).join("/");
};

/** 予約 origin URL → 配列キーへの復元。この層の直列化を経ていない URL は undefined。 */
const deserializeKey = (url: string): CacheKey | undefined => {
  if (!url.startsWith(KEY_PREFIX)) return undefined;
  try {
    return url.slice(KEY_PREFIX.length).split("/").map((segment) =>
      JSON.parse(decodeURIComponent(segment)) as string | number | boolean
    );
  } catch {
    // 復元不能 = この層の直列化を経ていない（外部直書き等）。判定は呼び出し側に委ねる。
    return undefined;
  }
};

/** 予約 origin を取得元 URL に使わせないガード（配列キーのエントリと衝突するため）。 */
const assertNotReservedOrigin = (url: string): void => {
  if (url.startsWith(KEY_ORIGIN)) {
    throw new Error(
      `fetch-cache: ${KEY_ORIGIN} はキー直列化の予約 origin です（URL には使えません） (${url})`,
    );
  }
};

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
 * content-length 由来の受信バッファ事前確保。サーバ申告は信頼しないので、不正値（非整数・
 * 負・巨大すぎて RangeError）は「ヒント無し」に落として蓄積経路へ委ねる（取得は落とさない —
 * 明示 expectedBytes の確保失敗だけは fail loud。DECIDED: docs/decisions/0007）。
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
 *
 * 明示 `expectedBytes` の**確保失敗**だけは縮退しない: 縮退した蓄積経路も終端で同じ長さの
 * 連結バッファ（下の `new Uint8Array(loaded)`）を要求し、同じ理由で落ちる。全量ダウンロード後に
 * 落とすのは帯域を捨てるだけなので、受信前に fail loud で throw する（DECIDED:
 * docs/decisions/0007。形式不正の申告は従来どおり「ヒント無し」= 確保失敗とは別分岐）。
 */
const readBody = async (
  response: Response,
  requestUrl: string,
  onProgress?: (progress: FetchProgress) => void,
  expectedBytes?: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  const total = readTotal(response);
  let buffer: Uint8Array<ArrayBuffer> | undefined;
  if (expectedBytes !== undefined) {
    if (Number.isSafeInteger(expectedBytes) && expectedBytes > 0) {
      try {
        buffer = new Uint8Array(expectedBytes);
      } catch (error) {
        // 未消費 body は接続リソースを保持し続けるため解放してから throw する。
        await response.body?.cancel().catch(() => {});
        throw new Error(
          `fetch-cache: expectedBytes ${expectedBytes} の受信バッファを確保できません` +
            `（実行環境の単一 ArrayBuffer 上限を超えている可能性があります） (${requestUrl})`,
          { cause: error },
        );
      }
    }
    // 形式不正（非整数・0 以下）はヒント無し（content-length にも頼らない従来挙動を維持）。
  } else if (total !== undefined) {
    buffer = allocateHint(total);
  }
  const body = response.body;
  if (body === null) {
    // この経路は buffer を使わない（全量が一度ヒープに載るフォールバック）。確保済みでも
    // 参照を捨てるだけで害はない。
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
 * 記録ハッシュを載せるレスポンスヘッダ。Cache API はヘッダごと格納するので、記録は
 * エントリと同じ寿命を持つ（エントリが消えれば記録も消える＝取り違えない）。値は
 * 「このエントリのバイト列は保存時にこの sha256 と一致した」ことだけを主張する
 * （DECIDED: docs/decisions/0006 §2。旧 `x-fetch-cache-verified` は 0.5.0 で廃止 —
 * 旧ヘッダ付きエントリは「記録なし」として扱われ、期待 sha256 があれば実ハッシュで突合される）。
 */
const SHA_HEADER = "x-fetch-cache-sha256";

/**
 * 保存用 Response を組み立てる。bytes を直接 body にすると実装が全量コピーする
 * （Deno 2.9.4 実測: 512MiB の `new Response(bytes)` で RSS が +512MiB）ため、1 チャンクの
 * stream として渡してコピーを避ける（同 +4MiB）。受信バッファの事前確保（`expectedBytes`）と
 * 合わせて network 経路のヒープを 1N に保つのが狙いで、格納内容は完全に同じ。
 * `sha256` があれば記録ハッシュを焼く。
 */
const storableResponse = (bytes: Uint8Array, sha256?: string): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return sha256 === undefined
    ? new Response(body)
    : new Response(body, { headers: { [SHA_HEADER]: sha256 } });
};

/**
 * buffer 全体を占める ArrayBuffer 背面の view か（= そのまま digest へ渡せるか）。
 * SharedArrayBuffer 背面はここで弾く（述語が主張する `Uint8Array<ArrayBuffer>` を嘘にしない）。
 */
const isTightView = (bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> =>
  bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 &&
  bytes.byteLength === bytes.buffer.byteLength;

/**
 * materialize 済みバイト列の一括ハッシュ（native crypto.subtle — 純 TS 逐次実装より速い。
 * 純 TS は「バイト列を手元へ materialize しない経路」= streaming prefetch 専用。
 * DECIDED: docs/decisions/0005）。crypto.subtle の有無は入口（fetchBytes）で検査済み。
 */
const sha256HexNative = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    // MUST: 手前で余計なコピーを作らない — 数 GB 級ではコピー 1 回ぶんが効く。この層が渡す
    // bytes は tight な ArrayBuffer 背面なのでそのまま渡せる。部分ビュー・SharedArrayBuffer
    // 背面（WebCrypto が拒否する）が来たときだけコピーで背面を保証する。
    isTightView(bytes) ? bytes : new Uint8Array(bytes),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * sha256（built-in）→ validate（カスタム）→ decode（保存形 → 利用形）の共有経路。
 * キャッシュヒット側と network 側で必ずこの順・この意味論を共有する（経路毎に別実装すると
 * 契約が黙って乖離する）。throw はどちら由来でも「不一致/破損」として呼び出し側の縮退経路に乗る。
 *
 * `trustedSha256` はキャッシュヒットで記録ハッシュが期待値と一致した（= 計算せずに信じる）
 * ときだけ true になる（DECIDED: docs/decisions/0006 §2）。カスタム validate と decode は
 * 常に走る（記録が省くのは sha256 の再計算だけ）。
 */
const checkAndDecode = async (
  raw: Uint8Array,
  opts: FetchBytesOptions,
  trustedSha256 = false,
): Promise<Uint8Array> => {
  if (opts.sha256 !== undefined && !trustedSha256) {
    const actual = await sha256HexNative(raw);
    if (actual !== opts.sha256) {
      throw new Error(
        `fetch-cache: SHA-256 不一致: ${actual} != ${opts.sha256}`,
      );
    }
  }
  await opts.validate?.(raw);
  return opts.decode === undefined ? raw : await opts.decode(raw);
};

/**
 * 同一キーの in-flight 取得（single-flight の合流点）。
 * `raw` は保存形（cache に入る/入っているバイト列）で、合流者は各自の
 * sha256 / validate / decode をこれに適用する（decode との直交 — DECIDED: docs/decisions/0004）。
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
 * raw 取得と（先行呼び出しオプションでの）検証・decode の本体。cache open/match →
 * 鮮度判定 → self-heal → network → put の一連で、常に { raw: 保存形, decoded: decode 適用後 }
 * を返す。single-flight の合流者は raw を受け取り、各自の検証・decode を適用し直す。
 *
 * キャッシュ側の 3 操作（match / delete / put）は `storageKey`、network への fetch は
 * `requestUrl` を使う（キーと取得元の分離 — DECIDED: docs/decisions/0006）。
 */
const acquireAndDecode = async (
  requestUrl: string,
  storageKey: string,
  opts: FetchBytesOptions,
  emitProgress: ((progress: FetchProgress) => void) | undefined,
): Promise<{ raw: Uint8Array; decoded: Uint8Array }> => {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const onCacheError = opts.onCacheError ?? defaultOnCacheError;

  const cacheStorage = (opts.cache ?? true)
    ? opts.caches ?? globalCaches()
    : undefined;

  // open は読出し・書込みで共有する 1 回だけ。失敗したらキャッシュ無しで続行（縮退+通知）。
  let cache: Cache | undefined;
  if (cacheStorage !== undefined) {
    try {
      cache = await cacheStorage.open(DEFAULT_CACHE_NAME);
    } catch (error) {
      onCacheError({ op: "open", url: requestUrl, error });
    }
  }

  if (cache !== undefined) {
    let cachedBytes: Uint8Array<ArrayBuffer> | undefined;
    let recorded: string | null = null;
    try {
      const cached = await cache.match(storageKey);
      if (cached !== undefined) {
        recorded = cached.headers.get(SHA_HEADER);
        cachedBytes = new Uint8Array(await cached.arrayBuffer());
      }
    } catch (error) {
      // 読出し失敗は miss と同じ扱いで network へ縮退する。
      onCacheError({ op: "match", url: requestUrl, error });
    }
    if (cachedBytes !== undefined) {
      try {
        // 鮮度判定: 記録ハッシュが期待値と一致すれば計算ゼロで信じる（既定 = ローカル格納を
        // 信頼。`recheck` 指定時と、記録が無い/食い違うエントリは実ハッシュで突合する —
        // 不一致は「内容が変わった/壊れた」として下の catch = self-heal へ）。
        const trusted = opts.sha256 !== undefined &&
          recorded === opts.sha256 && opts.recheck !== true;
        return {
          raw: cachedBytes,
          decoded: await checkAndDecode(cachedBytes, opts, trusted),
        };
      } catch {
        // 陳腐化/破損キャッシュ（sha256 不一致・validate 拒否・decode 不能）。真実源から
        // 取り直すため evict してフォールスルー（self-heal）。
        try {
          await cache.delete(storageKey);
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
  const bytes = await readBody(
    response,
    requestUrl,
    emitProgress,
    opts.expectedBytes,
  );
  // sha256 / validate / decode 成功後にのみ cache.put（不一致物・不正物をキャッシュに
  // 残さない）。失敗はそのまま throw。put するのは常に保存形 raw（decode 前）。
  const decoded = await checkAndDecode(bytes, opts);
  if (cache !== undefined) {
    // 検証を通過したバイト列にだけ記録ハッシュを焼く（Response の組み立ては try の外 —
    // 呼び出し側のバグは縮退で黙らせず fail loud に出す）。
    const stored = storableResponse(bytes, opts.sha256);
    // put 失敗（quota 超過等）は成功したダウンロードを巻き添えにしない（縮退+通知）。
    try {
      await cache.put(storageKey, stored);
    } catch (error) {
      onCacheError({ op: "put", url: requestUrl, error });
    }
  }
  return { raw: bytes, decoded };
};

/**
 * URL からバイト列を取得する（Cache API 優先・self-heal・single-flight・fail loud）。
 *
 * キャッシュヒット時は network に出ない（onProgress も呼ばれない）。`sha256` / `validate` /
 * `decode` がキャッシュ内容を拒否したら evict して network から取り直す（self-heal —
 * `sha256` 指定時は「内容が変わった」検知を兼ねる: 同一キーのまま取得元を切り替えると同じ
 * キーへ上書きされる）。network 取得物が検証に落ちたらそのまま throw し、不正物はキャッシュ
 * しない。HTTP エラーは `fetch-cache: HTTP {status} {statusText} ({url})` で throw する。
 * cache に入るのは常に保存形（raw）で、戻り値は `decode` 適用後（省略時は raw）。
 *
 * **single-flight**: 同一キー（`key` ?? URL）への並行呼び出しは 1 フライトに合流し、
 * network への取得は 1 回だけになる（cache 有効時のみ。`cache: false` は「毎回取りに行く」
 * 意図を尊重して合流しない）。同一 `key` を名乗る別 URL の呼び出しも合流する（同一キー =
 * 内容同一という呼び出し側の主張をそのまま採る — DECIDED: docs/decisions/0006）。合流者には
 * 保存形 raw が共有され、`sha256` / `validate` / `decode` は各呼び出しが自分のオプションで
 * 適用する（合流者は記録ハッシュを見ない = 常に自分の検証を走らせる安全側）。取得失敗は
 * 合流した全呼び出しへ伝播し、フライト終了後の呼び出しは新規に取得する（失敗は記憶しない）。
 * `onProgress` は合流者へも fan-out され、合流時に直近の進捗が 1 回即時通知される。
 * NOTE: 合流者の `fetch` / `caches` / `init` / `onCacheError` / `expectedBytes` は使われない
 * — 取得は先行呼び出しのオプションで走っている（記録ハッシュを焼くのも leader の `sha256`
 * だけ。DECIDED: docs/decisions/0004、docs/limitations.md）。
 *
 * NOTE: `caches` が無いランタイム（Node.js 等）では `cache` / `key` 指定に関わらず素の fetch
 *       にフォールバックする（キャッシュは最適化であり正しさの要件ではない。single-flight の
 *       合流だけはキー空間で効き続ける）。
 * NOTE: cache I/O の失敗（quota 超過等）もダウンロードを落とさず network 側へ縮退して続行し、
 *       `onCacheError`（既定 console.warn）で通知する（DECIDED: docs/decisions/0001）。
 */
export const fetchBytes = async (
  url: string | URL,
  opts: FetchBytesOptions = {},
): Promise<Uint8Array> => {
  const requestUrl = typeof url === "string" ? url : url.href;
  assertNotReservedOrigin(requestUrl);

  // Cache API は GET しか格納できない。`caches` の有無に依らず（Node.js でも）一貫して
  // fail loud にするため、ガードは「キャッシュを使う意図」（cache !== false）で判定する。
  const method = (opts.init?.method ?? "GET").toUpperCase();
  if ((opts.cache ?? true) && method !== "GET") {
    throw new Error(
      `fetch-cache: GET 以外（${method}）はキャッシュできません（Cache API の制約）。` +
        `cache: false を指定してください (${requestUrl})`,
    );
  }

  // キーの直列化はここで 1 回だけ（要素の検査も serializeKey が行う）。cache を触らない
  // 呼び出しでのキー指定は矛盾なので fail loud（DECIDED: docs/decisions/0006）。
  let storageKey = requestUrl;
  if (opts.key !== undefined) {
    if (opts.cache === false) {
      throw new Error(
        `fetch-cache: cache: false と key は併用できません（キャッシュを触らない呼び出しにキーは無意味です） (${requestUrl})`,
      );
    }
    storageKey = serializeKey(opts.key);
  }

  // sha256 の形式不正は必ず不一致になる申告（＝全量ダウンロードしてから落ちる）なので
  // network に出る前に弾く。crypto.subtle 不在も入口で fail loud（ヒット検証・network 検証の
  // 両方が依存するため、縮退経路の奥で気付くと無駄な再取得が走る）。
  if (opts.sha256 !== undefined) {
    if (!SHA256_HEX.test(opts.sha256)) {
      throw new Error(
        `fetch-cache: sha256 は 64 桁の小文字 hex で指定してください: ${opts.sha256} (${requestUrl})`,
      );
    }
    if (typeof crypto === "undefined" || crypto.subtle === undefined) {
      throw new Error(
        `fetch-cache: crypto.subtle が利用できないため sha256 検証ができません (${requestUrl})`,
      );
    }
  } else if (opts.recheck !== undefined) {
    throw new Error(
      `fetch-cache: recheck は sha256 とセットでのみ指定できます (${requestUrl})`,
    );
  }

  // cache 無効の呼び出しは合流しない（非 GET・「必ず新規取得」の意図を保つ）。
  if (opts.cache === false) {
    const { decoded } = await acquireAndDecode(
      requestUrl,
      storageKey,
      opts,
      opts.onProgress === undefined
        ? undefined
        : isolateProgress(opts.onProgress, requestUrl),
    );
    return decoded;
  }

  // 合流キーは cache と同じキー空間そのもの（直列化済みキー or URL。名前空間は内部固定
  // 1 個なので連結不要 — DECIDED: docs/decisions/0006）。
  const existing = inflight.get(storageKey);
  if (existing !== undefined) {
    // 合流: raw（保存形）を受け取り、自分の sha256 / validate / decode を適用する。
    if (opts.onProgress !== undefined) {
      const isolated = isolateProgress(opts.onProgress, requestUrl);
      existing.listeners.add(isolated);
      // 直近の進捗を 1 回即時通知して、合流者の表示を現在地へ追いつかせる。
      if (existing.state.last !== undefined) isolated(existing.state.last);
    }
    const { raw } = await existing.promise;
    return await checkAndDecode(raw, opts);
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
  const promise = acquireAndDecode(requestUrl, storageKey, opts, emit).finally(
    () => {
      // 成否に依らずフライトを閉じる（失敗を記憶すると自然回復を妨げる）。合流者は
      // promise への参照を直接持つため、この削除で取りこぼしは起きない。
      inflight.delete(storageKey);
    },
  );
  inflight.set(storageKey, { promise, listeners, state });
  const { decoded } = await promise;
  return decoded;
};

export type PrefetchUrlOptions = {
  /**
   * キャッシュキー（**省略時は URL がそのままキー**）。既存エントリ検査（network に出るかの
   * 判定）も格納もこのキーで行い、取得元 URL は fetch にだけ使う。`fetchBytes` の `key` と
   * 同じ意味論・同じキー空間なので、温めたエントリは同じ `key` の `fetchBytes` でヒットする
   * （DECIDED: docs/decisions/0006）。
   */
  key?: CacheKey;
  /**
   * 期待 SHA-256（64 桁小文字 hex）。指定すると**通過中に**逐次ハッシュして検証する
   * （バイト列はヒープに溜めない）。省略時は従来どおり無検証で格納する。
   *
   * 一致したときだけエントリが成立し、同時に記録ハッシュ（この sha256）が焼かれるため、
   * 以後 `fetchBytes` に同じ `key` と `sha256` を渡せばヒット時の再ハッシュも走らない。
   * 不一致なら stream を error にして `cache.put` ごと reject させる ＝
   * **記録付きの不正エントリは構造的に生まれない**（DECIDED: docs/decisions/0005 §5）。
   *
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
  /** CacheStorage の差し替え（テストの隔離・故障注入用）。既定 globalThis.caches。 */
  caches?: CacheStorage;
};

/**
 * URL の内容を**ヒープに全量を載せずに**キャッシュへ格納する（streaming prefetch）。
 * network 応答の body をそのまま `cache.put` へ流すため、数 GB 級でも JS ヒープの使用は
 * チャンク数個ぶんで済む。戻り値は「network から取得して格納した」なら true、
 * 「既にエントリがあって何もしなかった」なら false。`key` を渡した場合は既存エントリ検査も
 * 格納もそのキーで行い、取得元 URL は fetch にだけ使う（DECIDED: docs/decisions/0006）。
 *
 * **検証は `sha256` を渡したときだけ**: 渡せば通過中に逐次ハッシュして突合し、一致した
 * ものだけがエントリとして成立する（同時に記録ハッシュが焼かれ、以後の `fetchBytes` は
 * 再ハッシュを省ける）。渡さなければ従来どおり無検証で格納し、完全性の検証は読み出し側
 * （`fetchBytes` の `sha256` / `validate` → 失敗なら evict → 取り直し）に一本化する
 * — その場合は未検証バイトが一時的にキャッシュへ載る（TOCTOU。self-heal があるので恒久化は
 * しない）。`validate` フックそのものは持てない（バイト列が手元に無いため）ので、sha256 以外の
 * 検証をしたい用途では `fetchBytes` を使うこと（DECIDED: docs/decisions/0005）。
 *
 * **single-flight の対象外**: `fetchBytes` の合流（ADR 0004）は「leader の保存形 raw を
 * 合流者へ渡す」契約だが、prefetch は raw を持たないため合流できない。同一キーの並行
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
  assertNotReservedOrigin(requestUrl);

  // Cache API は GET しか格納できない。prefetch は「キャッシュへ入れる」ことが目的なので
  // 非 GET に縮退の余地は無い（fetchBytes の cache:false に相当する逃げ道も持たない）。
  const method = (opts.init?.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    throw new Error(
      `fetch-cache: prefetchUrl は GET 専用です（${method} は Cache API に格納できません） (${requestUrl})`,
    );
  }

  // キーの直列化（fetchBytes と同じ。要素検査込み）。
  const storageKey = opts.key === undefined
    ? requestUrl
    : serializeKey(opts.key);

  // 形式不正の申告は必ず不一致になる（＝全量ダウンロードしてから落ちる）。呼び出し側のバグ
  // なので network に出る前に fail loud で弾く。
  const expectedSha256 = opts.sha256;
  if (expectedSha256 !== undefined && !SHA256_HEX.test(expectedSha256)) {
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
  const cache = await cacheStorage.open(DEFAULT_CACHE_NAME);

  // 既存エントリがあれば network に出ない（検証はしない — 読み出し側の self-heal に委ねる）。
  // match が返す Response の body は消費しないので、接続/ファイルハンドルを解放しておく。
  const existing = await cache.match(storageKey);
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

  // 記録ハッシュは Response の構築時点で焼く。put の成立と通過中検証の通過が不可分に
  // なり、「記録だけ付いた不正エントリ」が構造的に作れなくなる（DECIDED: docs/decisions/0005）。
  const markerInit = expectedSha256 === undefined
    ? undefined
    : { headers: { [SHA_HEADER]: expectedSha256 } };

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
          // update 後に書き換えられるため、共有すると「記録は付いたが中身がハッシュと違う」
          // エントリを作る手順が生まれる（MUST: 記録の健全性を呼び出し側の行儀に依存させない
          // — DECIDED: docs/decisions/0005 §5）。記録が無ければ乖離は無害なので複製しない。
          const owned = hasher === undefined ? chunk : chunk.slice();
          // update は戻った時点で owned への参照を持たない（sha256.ts の MUST 契約）。
          // だから複製を先へ流して以後どう扱われても、ハッシュ側は影響を受けない。
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
    await cache.put(storageKey, stored);
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
    // 保険: stream の error を無視してエントリを作る Cache 実装があっても、記録付きの不正
    // エントリだけは残さない（記録は以後の検証を省かせるので、残ると恒久的に効いてしまう）。
    await cache.delete(storageKey).catch(() => {});
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
 * 指定 URL のキャッシュエントリを削除する（URL キーのエントリ用 — 配列キーは `evict`）。
 * エントリがあったら true。`caches` が無いランタイム・名前空間ごと存在しない場合は常に false。
 */
export const evictUrl = async (url: string | URL): Promise<boolean> => {
  const requestUrl = typeof url === "string" ? url : url.href;
  assertNotReservedOrigin(requestUrl);
  if (typeof caches === "undefined") return false;
  // caches.open は無い名前空間を永続作成してしまう（削除 API の副作用として不適切）。
  // 名前空間が無ければエントリも無い — 触らずに false を返す。
  if (!(await caches.has(DEFAULT_CACHE_NAME))) return false;
  const cache = await caches.open(DEFAULT_CACHE_NAME);
  return await cache.delete(requestUrl);
};

/**
 * キャッシュを丸ごと削除する（URL キー・配列キーの両方）。何かあったら true。
 * `caches` が無いランタイムでは常に false。部分的に消したいときは `evict`（配列キーの
 * プレフィックス）か `evictUrl` を使う。
 */
export const clearCache = async (): Promise<boolean> => {
  if (typeof caches === "undefined") return false;
  return await caches.delete(DEFAULT_CACHE_NAME);
};

// Cache.keys() の有無はランタイム依存（Deno 2.8 以前は未実装・2.9 で実装、ブラウザは実装済み）。
// 型定義もバージョンで揺れるため、実行時の feature-detect で判定する。
type CacheWithKeys = Cache & { keys: () => Promise<readonly Request[]> };
const supportsKeys = (cache: Cache): cache is CacheWithKeys =>
  typeof (cache as Partial<CacheWithKeys>).keys === "function";

const requireKeys = (cache: Cache): CacheWithKeys => {
  if (!supportsKeys(cache)) {
    throw new Error(
      "fetch-cache: このランタイムの Cache API は keys() を実装していないため列挙できません（Deno 2.8 以前など）",
    );
  }
  return cache;
};

/**
 * プレフィックスの直列化。空プレフィックスは「配列キーの全エントリ」に一致する。
 * 直列化が単射なので文字列前方一致で足りる（`["a"]` と `["ab"]` はセグメント境界 `/` で
 * 区別される）。
 */
const serializePrefix = (prefix: CacheKey): string => {
  for (const element of prefix) assertKeyElement(element, prefix);
  return prefix.length === 0 ? KEY_PREFIX : serializeKey(prefix);
};

const matchesPrefix = (url: string, serialized: string): boolean =>
  serialized === KEY_PREFIX
    ? url.startsWith(KEY_PREFIX)
    : url === serialized || url.startsWith(`${serialized}/`);

/**
 * 配列キーのエントリをプレフィックスで削除し、消した件数を返す。**常にプレフィックス意味論**:
 * 完全キーを渡せばそのエントリ（+ それを接頭辞に持つ子孫）、`["app"]` なら部分木ごと、
 * `[]` なら配列キーの全エントリが対象になる（DECIDED: docs/decisions/0006 §3）。
 *
 * `caches` が無い・名前空間ごと存在しない場合は 0。`Cache.keys()` 未実装のランタイム
 * （Deno 2.8 以前）では fail loud に throw する（実在エントリを見逃して「消えた」と
 * 誤認させないため）。
 */
export const evict = async (prefix: CacheKey): Promise<number> => {
  const serialized = serializePrefix(prefix);
  if (typeof caches === "undefined") return 0;
  if (!(await caches.has(DEFAULT_CACHE_NAME))) return 0;
  const cache = requireKeys(await caches.open(DEFAULT_CACHE_NAME));
  let count = 0;
  for (const request of await cache.keys()) {
    if (matchesPrefix(request.url, serialized) && await cache.delete(request)) {
      count++;
    }
  }
  return count;
};

/**
 * 配列キーのエントリ一覧をキー（配列）のまま返す。`prefix` を渡すとその部分木だけに絞る。
 * URL キーのエントリは含まない（そちらは `listCachedUrls`）。`caches` が無い・名前空間ごと
 * 存在しない場合は []。`Cache.keys()` 未実装のランタイムでは fail loud に throw する。
 */
export const listKeys = async (prefix: CacheKey = []): Promise<CacheKey[]> => {
  const serialized = serializePrefix(prefix);
  if (typeof caches === "undefined") return [];
  if (!(await caches.has(DEFAULT_CACHE_NAME))) return [];
  const cache = requireKeys(await caches.open(DEFAULT_CACHE_NAME));
  const keys: CacheKey[] = [];
  for (const request of await cache.keys()) {
    if (!matchesPrefix(request.url, serialized)) continue;
    const key = deserializeKey(request.url);
    // 予約 origin 配下は必ずこの層の直列化を経ている（不変条件）。復元できないエントリは
    // 外部からの直書き等の異常なので、黙って飛ばさず fail loud に出す。
    if (key === undefined) {
      throw new Error(
        `fetch-cache: 予約 origin 配下に復元できないエントリがあります: ${request.url}`,
      );
    }
    keys.push(key);
  }
  return keys;
};

/**
 * URL キーのキャッシュ済み URL 一覧を返す（配列キーのエントリは含まない — そちらは
 * `listKeys`）。`caches` が無いランタイム・名前空間ごと存在しない場合は []（空は事実 —
 * 名前空間を作る副作用も持たない）。
 *
 * NOTE: `caches` はあるが `Cache.keys()` が未実装のランタイム（Deno 2.8 以前）では throw する
 *       （fail loud）。実在するエントリを [] と偽ると、この一覧に基づく掃除・表示が静かに
 *       壊れるため、欠落は隠さない。
 */
export const listCachedUrls = async (): Promise<string[]> => {
  if (typeof caches === "undefined") return [];
  if (!(await caches.has(DEFAULT_CACHE_NAME))) return [];
  const cache = requireKeys(await caches.open(DEFAULT_CACHE_NAME));
  const keys = await cache.keys();
  return keys
    .map((request) => request.url)
    .filter((url) => !url.startsWith(KEY_ORIGIN));
};
