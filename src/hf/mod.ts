/**
 * `@hdae/fetch-cache/hf` — HuggingFace Hub からのファイル取得（汎用 cache 層の上に実装）。
 *
 * 可変 ref（"main" 等）は必ず現在のコミット SHA へ解決してから取得する。SHA 固定 URL は
 * 不変＝キャッシュ可能なので、SHA が変わらない限り 2 回目以降は network なしで返る。
 * `expectedBytes` / `sha256` / カスタム `validate` は `fetchBytes` の validate フックへ
 * 合成され、キャッシュヒット側にも効く（破損キャッシュは self-heal）。ファイル毎の
 * `decode` で「保存形 ≠ 利用形」（gzip のまま保存・解凍して返す等）にも対応する。
 *
 * @module
 */

import {
  type CacheErrorContext,
  type DecodeBytes,
  fetchBytes,
  type FetchProgress,
  prefetchUrl,
  type ValidateBytes,
} from "../mod.ts";

export type HfRepoKind = "model" | "dataset" | "space";

export type HfRepoRef = {
  /** "owner/name" 形式。 */
  repo: string;
  /** 既定 "model"。 */
  kind?: HfRepoKind;
  /** ブランチ / タグ / コミット SHA。既定 "main"。 */
  revision?: string;
  /** 既定 "https://huggingface.co"（ミラー用に差し替え可能）。 */
  hubUrl?: string;
};

export type HfFileSpec = {
  path: string;
  /** バイト数検証（不一致 throw）。Hub 上の保存形 raw に対して。 */
  expectedBytes?: number;
  /**
   * SHA-256 検証（**64 桁の小文字 hex** — 形式不正は network に出る前に throw。不一致も
   * throw。crypto.subtle 必須 — 無ければ throw）。Hub 上の保存形 raw に対して照合する
   * （LFS メタデータの値がそのまま使える。`decode` 併用時も解凍前）。
   */
  sha256?: string;
  /**
   * カスタム検証。built-in（expectedBytes / sha256）の後に、同じく保存形 raw に対して走る。
   * throw = 破損扱い（キャッシュヒット側は self-heal）。利用形側の検証は `decode` 内で
   * throw する。
   */
  validate?: ValidateBytes;
  /**
   * 保存形 → 利用形の変換（cache 層の `decode` へそのまま転送。gzip なら同梱の
   * `decodeGzip` が使える）。cache には raw のまま保存され、戻り値だけが decode 適用後に
   * なる。ファイル毎に形式が違うため、呼び出しオプションではなくファイル指定側に置く。
   */
  decode?: DecodeBytes;
};

const DEFAULT_HUB_URL = "https://huggingface.co";
const DEFAULT_CACHE_NAME = "fetch-cache-hf";

// resolve URL は kind でパス接頭辞が、API は複数形セグメントが変わる。
const RESOLVE_PREFIX: Record<HfRepoKind, string> = {
  model: "",
  dataset: "datasets/",
  space: "spaces/",
};
const API_SEGMENT: Record<HfRepoKind, string> = {
  model: "models",
  dataset: "datasets",
  space: "spaces",
};

/** 40 桁小文字 hex のコミット SHA（不変 revision）か。短縮 SHA・ブランチ・タグは可変扱い。 */
export const isCommitSha = (revision: string): boolean =>
  /^[0-9a-f]{40}$/.test(revision);

// path はセグメント毎に percent-encode する（`/` は構造として保持）。revision は丸ごと
// encode（slash 入り ref `refs/pr/1` 等は %2F を要求するのが HF の実挙動 — 仕様保証ではない）。
// 公式クライアント huggingface_hub の quote(revision, safe="") / quote(filename, safe="/") と
// 同じ扱い。SHA・通常の path には恒等なのでキャッシュキーは変わらない。
const encodePath = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

/**
 * HuggingFace の resolve URL を組み立てる。model は
 * `{hubUrl}/{repo}/resolve/{revision}/{path}`、dataset / space はそれぞれ
 * `{hubUrl}/datasets/{repo}/...`・`{hubUrl}/spaces/{repo}/...`。
 * revision は丸ごと・path はセグメント毎に percent-encode する。repo（owner/name）の
 * `/` は構造要素なのでエンコードしない。
 */
export const hfResolveUrl = (ref: HfRepoRef & { path: string }): string => {
  const hubUrl = ref.hubUrl ?? DEFAULT_HUB_URL;
  const kind = ref.kind ?? "model";
  const revision = ref.revision ?? "main";
  return `${hubUrl}/${RESOLVE_PREFIX[kind]}${ref.repo}/resolve/${
    encodeURIComponent(revision)
  }/${encodePath(ref.path)}`;
};

/**
 * 可変 ref（"main" 等）を現在のコミット SHA へ解決する。revision が既に SHA なら
 * ネットワークに出ずそのまま返す。
 *
 * NOTE: `{hubUrl}/api/{models|datasets|spaces}/{repo}/revision/{ref}` が `{"sha": ...}` を
 *       返すのは HF の実装挙動依存で仕様保証ではない。応答に sha が無ければ throw する。
 */
export const resolveHfRevision = async (
  ref: HfRepoRef,
  opts: { fetch?: typeof globalThis.fetch; init?: RequestInit } = {},
): Promise<string> => {
  const revision = ref.revision ?? "main";
  if (isCommitSha(revision)) return revision;
  const hubUrl = ref.hubUrl ?? DEFAULT_HUB_URL;
  const kind = ref.kind ?? "model";
  const url = `${hubUrl}/api/${API_SEGMENT[kind]}/${ref.repo}/revision/${
    encodeURIComponent(revision)
  }`;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, opts.init);
  if (!response.ok) {
    // 未消費 body は接続リソースを保持し続けるため解放してから throw する（mod.ts と同じ扱い）。
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `fetch-cache: HTTP ${response.status} ${response.statusText} (${url})`,
    );
  }
  const info = await response.json() as { sha?: unknown };
  if (typeof info.sha !== "string" || info.sha === "") {
    throw new Error(`fetch-cache: revision 解決応答に sha が無い (${url})`);
  }
  return info.sha;
};

export type HfFetchOptions = {
  /** 既定 "fetch-cache-hf"。 */
  cacheName?: string;
  /** ファイル毎の進捗（path 付き）。 */
  onProgress?: (progress: FetchProgress & { path: string }) => void;
  /** cache I/O 失敗の通知（cache 層へそのまま渡す）。既定 console.warn。 */
  onCacheError?: (context: CacheErrorContext) => void;
  /**
   * fetch へそのまま渡す RequestInit（gated/private repo の Authorization 等）。revision
   * 解決 API とファイル取得の両方へ渡る。キャッシュキーは URL のみ（docs/limitations.md）。
   */
  init?: RequestInit;
  fetch?: typeof globalThis.fetch;
  /** CacheStorage の差し替え（cache 層へそのまま渡す）。既定 globalThis.caches。 */
  caches?: CacheStorage;
  /**
   * **opt-in**: `sha256` を宣言したファイルについて、保存時に検証済みマーカーを焼き、
   * 以後のキャッシュヒットで印が一致したら検証（expectedBytes / sha256 / カスタム validate）を
   * まるごと省く。既定 false = 現行どおりヒット毎に全量ハッシュする。
   *
   * MUST: これは「ローカル格納を信頼する」選択である（cache 層 `verifiedMarker` の信頼境界を
   * そのまま継承 — 格納後の改竄・ビット腐敗は検出できない）。数 GB のモデルで起動毎の
   * 再ハッシュが重すぎる場合の逃げ道であり、既定にはしない（DECIDED: docs/decisions/0005）。
   * NOTE: 印が付くのは「このオプション付きで network から取得して保存した」エントリだけ。
   *       既存のキャッシュには印が無いので、次に取り直すまでは通常どおり検証が走る。
   */
  trustCachedSha256?: boolean;
};

/**
 * buffer 全体を占める ArrayBuffer 背面の view か（= そのまま digest へ渡せるか）。
 * SharedArrayBuffer 背面はここで弾く（述語が主張する `Uint8Array<ArrayBuffer>` を嘘にしない）。
 */
const isTightView = (bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> =>
  bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 &&
  bytes.byteLength === bytes.buffer.byteLength;

/** バイト列をハッシュして小文字 hex を返す（sha256 検証用）。crypto.subtle が無ければ throw。 */
const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) {
    throw new Error(
      "fetch-cache: crypto.subtle が利用できないため sha256 検証ができません",
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    // MUST: 全量コピーしない — 数 GB 級ではコピー 1 回が一時 RAM を倍増させる。cache 層が
    // 渡す bytes は tight な ArrayBuffer 背面なのでそのまま渡せる。部分ビュー・
    // SharedArrayBuffer 背面（WebCrypto が拒否する）が来たときだけコピーで背面を保証する。
    isTightView(bytes) ? bytes : new Uint8Array(bytes),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
};

/**
 * HfFileSpec の検証（expectedBytes / sha256 / カスタム validate）を fetchBytes の validate
 * フックへ合成する。validate として渡すことでキャッシュヒット側にも効き、破損キャッシュは
 * self-heal される。built-in を先に走らせる（安価な長さ検査 → sha256 → カスタム）。
 */
const buildValidate = (spec: HfFileSpec): ValidateBytes | undefined => {
  if (
    spec.expectedBytes === undefined && spec.sha256 === undefined &&
    spec.validate === undefined
  ) {
    return undefined;
  }
  return async (bytes) => {
    if (
      spec.expectedBytes !== undefined && bytes.length !== spec.expectedBytes
    ) {
      throw new Error(
        `fetch-cache: ${spec.path} のバイト数不一致: ${bytes.length} != ${spec.expectedBytes}`,
      );
    }
    if (spec.sha256 !== undefined) {
      const actual = await sha256Hex(bytes);
      if (actual !== spec.sha256) {
        throw new Error(
          `fetch-cache: ${spec.path} の SHA-256 不一致: ${actual} != ${spec.sha256}`,
        );
      }
    }
    await spec.validate?.(bytes);
  };
};

/** 解決済み revision（不変 SHA）で 1 ファイルを取得する。fetchHfFile / fetchHfFiles の共有経路。 */
const fetchResolvedFile = (
  ref: HfRepoRef,
  revision: string,
  spec: HfFileSpec,
  opts: HfFetchOptions,
): Promise<Uint8Array> => {
  const url = hfResolveUrl({ ...ref, revision, path: spec.path });
  const onProgress = opts.onProgress;
  return fetchBytes(url, {
    cache: true,
    cacheName: opts.cacheName ?? DEFAULT_CACHE_NAME,
    validate: buildValidate(spec),
    decode: spec.decode,
    // 既に持っているバイト数申告を受信バッファの確保ヒントとして流す（検証は validate 側）。
    expectedBytes: spec.expectedBytes,
    // マーカーは sha256 を宣言したファイルにだけ意味がある（印 = その sha256 の検証済み）。
    verifiedMarker: opts.trustCachedSha256 === true ? spec.sha256 : undefined,
    onProgress: onProgress === undefined
      ? undefined
      : (progress) => onProgress({ ...progress, path: spec.path }),
    onCacheError: opts.onCacheError,
    init: opts.init,
    fetch: opts.fetch,
    caches: opts.caches,
  });
};

/**
 * ファイル指定を HfFileSpec へ正規化する（全入口の合流点）。形式不正の `sha256` はここで
 * fail loud に弾く — 必ず不一致になる申告なので、全量ダウンロードしてから落とすと呼び出し毎に
 * 帯域を捨てることになる（cache 層 `prefetchUrl` の同じガードと語彙を揃える）。
 */
const toSpec = (file: string | HfFileSpec): HfFileSpec => {
  const spec = typeof file === "string" ? { path: file } : file;
  if (spec.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(spec.sha256)) {
    throw new Error(
      `fetch-cache: sha256 は 64 桁の小文字 hex で指定してください: ${spec.sha256} (${spec.path})`,
    );
  }
  return spec;
};

/**
 * HuggingFace リポジトリからファイルを 1 つ取得する。可変 ref は現在の SHA へ解決してから
 * SHA 固定 URL で取得・キャッシュする（revision に SHA を渡せば解決リクエストは発生しない）。
 */
export const fetchHfFile = async (
  ref: HfRepoRef,
  file: string | HfFileSpec,
  opts: HfFetchOptions = {},
): Promise<Uint8Array> => {
  const revision = await resolveHfRevision(ref, {
    fetch: opts.fetch,
    init: opts.init,
  });
  return await fetchResolvedFile(ref, revision, toSpec(file), opts);
};

/** `prefetchHfFile` のオプション（cache 層 `prefetchUrl` と同じく縮退しない＝fail loud）。 */
export type HfPrefetchOptions = {
  /** 既定 "fetch-cache-hf"（fetchHfFile / fetchHfFiles と同じ名前空間）。 */
  cacheName?: string;
  /** ファイル毎の進捗（path 付き）。既にエントリがあるときは呼ばれない。 */
  onProgress?: (progress: FetchProgress & { path: string }) => void;
  /** fetch へそのまま渡す RequestInit。revision 解決とファイル取得の両方へ渡る。 */
  init?: RequestInit;
  fetch?: typeof globalThis.fetch;
  /** CacheStorage の差し替え（cache 層へそのまま渡す）。既定 globalThis.caches。 */
  caches?: CacheStorage;
};

/** `prefetchHfFile` の結果（何をしたか + どの revision / URL を温めたか）。 */
export type HfPrefetchResult = {
  /** 取得して格納したなら true、既にエントリがあって何もしなかったなら false。 */
  fetched: boolean;
  /** 温めた対象の解決済みコミット SHA（可変 ref を渡した場合の解決結果）。 */
  revision: string;
  /** 温めた対象の SHA 固定 URL（= キャッシュキー）。 */
  url: string;
};

/**
 * HuggingFace のファイルを**ヒープに全量を載せずに**キャッシュへ温める（streaming prefetch）。
 * 可変 ref は `fetchHfFile` と同じ流儀で現在の SHA へ解決してから SHA 固定 URL で取得するので、
 * 温めたエントリはそのまま `fetchHfFile` のヒットになる。戻り値の `fetched` は「取得して
 * 格納した」なら true、「既にエントリがあって何もしなかった」なら false。
 *
 * 可変 ref（"main" 等）を渡しても、**どの SHA を温めたかが戻り値の `revision` で分かる**
 * （revision 解決は既存エントリで何もしない場合も必ず走るので、`revision` / `url` は常に
 * 返る）。以後 `fetchHfFile` の `revision` にその SHA を渡せばキャッシュキーが一致し、
 * 温めと読み出しの間に upstream が動いてもキャッシュミス（+ 孤児エントリ）にならない。
 *
 * `spec.sha256` があれば cache 層の通過中検証（`prefetchUrl` の `sha256`）へ自動で流れ、
 * 一致したエントリにだけ検証済みマーカーが焼かれる。以後 `trustCachedSha256: true` で読めば
 * ヒット時の再ハッシュを省ける（数 GB のモデルで起動毎の全量ハッシュを避ける本命の使い方）。
 * NOTE: 焼かれる印が主張するのは sha256 の一致だけ。`expectedBytes` は sha256 一致が
 *       バイト同一を含意するので実質包含されるが、`spec.validate`（カスタム検証）は
 *       `trustCachedSha256` 有効時にヒットで省かれる（DECIDED: docs/decisions/0005）。
 *
 * **縮退しない（fail loud）**: `caches` 不在・HTTP エラー・転送中断・put 失敗・sha256 不一致は
 * すべて throw する（cache 層 `prefetchUrl` の契約をそのまま継承）。fallback は `fetchHfFile`。
 *
 * NOTE: 複数ファイルを温めるときは `resolveHfRevision` で 1 回だけ SHA を解決し、
 *       `revision` にその SHA を渡して呼ぶこと（毎回の解決リクエストが省け、ファイル間で
 *       revision がずれる余地も無くなる）。並行度の選択は呼び出し側に委ねる — 数 GB 級では
 *       逐次の方が望ましいことが多く、ライブラリ側で並列版を決め打ちしない。
 */
export const prefetchHfFile = async (
  ref: HfRepoRef,
  file: string | HfFileSpec,
  opts: HfPrefetchOptions = {},
): Promise<HfPrefetchResult> => {
  const revision = await resolveHfRevision(ref, {
    fetch: opts.fetch,
    init: opts.init,
  });
  const spec = toSpec(file);
  const url = hfResolveUrl({ ...ref, revision, path: spec.path });
  const onProgress = opts.onProgress;
  const fetched = await prefetchUrl(url, {
    cacheName: opts.cacheName ?? DEFAULT_CACHE_NAME,
    sha256: spec.sha256,
    onProgress: onProgress === undefined
      ? undefined
      : (progress) => onProgress({ ...progress, path: spec.path }),
    init: opts.init,
    fetch: opts.fetch,
    caches: opts.caches,
  });
  return { fetched, revision, url };
};

/**
 * revision を 1 回だけ解決し、全ファイルを並列取得して名前→バイト列のマップで返す。
 * どれか 1 つでも取得・検証に失敗したら全体が reject する（fail loud）。
 */
export const fetchHfFiles = async <Names extends string>(
  ref: HfRepoRef,
  files: Record<Names, string | HfFileSpec>,
  opts: HfFetchOptions = {},
): Promise<Record<Names, Uint8Array>> => {
  const revision = await resolveHfRevision(ref, {
    fetch: opts.fetch,
    init: opts.init,
  });
  // Object.keys は string[] に落ちるため Names[] へ戻す（キーは files の実キーそのもの）。
  const names = Object.keys(files) as Names[];
  const entries = await Promise.all(
    names.map(async (name) =>
      [
        name,
        await fetchResolvedFile(ref, revision, toSpec(files[name]), opts),
      ] as const
    ),
  );
  // fromEntries は Record<string, ...> に落ちるため Names キーへ戻す（entries は names 起点）。
  return Object.fromEntries(entries) as Record<Names, Uint8Array>;
};
