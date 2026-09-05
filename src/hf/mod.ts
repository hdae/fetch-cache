/**
 * `@hdae/fetch-cache/hf` — HuggingFace Hub からのファイル取得（汎用 cache 層の上に実装）。
 *
 * 可変 ref（"main" 等）は必ず現在のコミット SHA へ解決してから取得する。キャッシュキーは
 * `spec.sha256` の有無で変わる: **あれば内容キー `["hf", kind, repo, path, sha256]`**（revision
 * を含まないので、README 更新だけで revision が動いてもバイト不変のファイルはヒットのまま。
 * revision を切り替えても内容毎にエントリが共存する）、無ければ従来どおり SHA 固定 resolve URL
 * がキー（DECIDED: docs/decisions/0006 §4）。`expectedBytes` / カスタム `validate` は
 * `fetchBytes` の validate フックへ合成され、`sha256` は cache 層の一級オプションへ渡る
 * （キャッシュヒットは記録ハッシュとの突合だけで済み、再ハッシュは走らない — 疑う運用は
 * `recheck`）。ファイル毎の `decode` で「保存形 ≠ 利用形」にも対応する。
 * revision 解決もファイル取得も 429 / 503 は既定で再試行する（DECIDED: docs/decisions/0010）。
 *
 * @module
 */

// 配列キーの注入導管（fetchBytesWithKey / prefetchUrlWithKey）は内部モジュールにだけある
// — 公開 `key` オプションは 0.5.0 で撤去（DECIDED: docs/decisions/0008）。
import {
  type CacheErrorContext,
  type CacheKey,
  type DecodeBytes,
  fetchBytesWithKey,
  type FetchProgress,
  IntoCapacityError,
  prefetchUrlWithKey,
  type ValidateBytes,
} from "../core.ts";
import {
  fetchWithRetry,
  type RetryContext,
  type RetryPolicy,
  retrySuffix,
} from "../retry.ts";

// `./hf` の公開シグネチャに現れる cache 層の型を再公開する（`./hf` 単独利用者が `.`
// エントリを併せて import しなくて済むように。`.` エントリの同名型と同一物）。
export type {
  CacheErrorContext,
  DecodeBytes,
  FetchProgress,
  RetryContext,
  RetryPolicy,
  ValidateBytes,
};

export type HfRepoKind = "model" | "dataset" | "space";

export type HfRepoRef = {
  /** "owner/name" 形式。 */
  repo: string;
  /** 既定 "model"。 */
  kind?: HfRepoKind;
  /** ブランチ / タグ / コミット SHA。既定 "main"。 */
  revision?: string;
  /** 既定 "https://huggingface.co"（ミラー用に差し替え可能）。末尾の `/` は吸収される。 */
  hubUrl?: string;
};

export type HfFileSpec = {
  path: string;
  /** バイト数検証（不一致 throw）。Hub 上の保存形 raw に対して。 */
  expectedBytes?: number;
  /**
   * 期待 SHA-256（**64 桁の小文字 hex** — 形式不正は network に出る前に throw。不一致も
   * throw。crypto.subtle 必須 — 無ければ throw）。Hub 上の保存形 raw に対して照合する
   * （LFS メタデータの値がそのまま使える。`decode` 併用時も解凍前）。
   *
   * 指定するとキャッシュキーが内容キー `["hf", kind, repo, path, sha256]` になり、
   * revision を跨いでバイト不変のファイルがヒットする（DECIDED: docs/decisions/0006 §4）。
   * ヒット時の検証は保存時に焼いた記録ハッシュとの突合だけで済む（再ハッシュ無し。
   * 疑う運用は `HfFetchOptions.recheck`）。
   */
  sha256?: string;
  /**
   * カスタム検証。built-in（sha256 → expectedBytes）の後に、同じく保存形 raw に対して走る。
   * throw = 破損扱い（キャッシュヒット側は self-heal）。キャッシュヒットでも**常に**走る
   * （記録ハッシュが省くのは sha256 の再計算だけ）。利用形側の検証は `decode` 内で throw する。
   */
  validate?: ValidateBytes;
  /**
   * 保存形 → 利用形の変換（cache 層の `decode` へそのまま転送。gzip なら同梱の
   * `decodeGzip` が使える）。cache には raw のまま保存され、戻り値だけが decode 適用後に
   * なる。ファイル毎に形式が違うため、呼び出しオプションではなくファイル指定側に置く。
   */
  decode?: DecodeBytes;
  /**
   * 呼び出し側が確保した書き込み先バッファ（cache 層の `into` へそのまま転送）。受信も
   * キャッシュ読出しもこのバッファの先頭へ書き、戻り値はその prefix view になる — 同じ
   * バッファを渡し回して shard を逐次読めば、RAM の増分はバッファ 1 本ぶんで止まる
   * （DECIDED: docs/decisions/0009）。容量不足は fail loud。ファイル毎の器なので
   * ファイル指定側に置く。
   *
   * MUST NOT: 同じバッファを複数の spec へ渡さない — `fetchHfFiles` は全ファイルを並列
   * 取得するため、cache 層の入口が使用中のバッファを検知して throw する（並行受信が同じ
   * 領域へ交互に書くと、記録ハッシュと中身が食い違うエントリが成立しうるため）。spec 毎に
   * 別のバッファを渡すか、逐次の `fetchHfFile` で 1 本を渡し回すこと。`prefetchHfFile` は
   * 見ない（バイト列を手元に持たない）。
   */
  into?: Uint8Array<ArrayBuffer>;
};

const DEFAULT_HUB_URL = "https://huggingface.co";

// hubUrl の末尾スラッシュは吸収する。生連結だと `https://mirror.example/` という自然な指定が
// `//owner/...` の二重スラッシュ URL になり、404 や（sha256 無しの）別キー重複保存を生む。
const hubBase = (hubUrl: string | undefined): string =>
  (hubUrl ?? DEFAULT_HUB_URL).replace(/\/+$/, "");

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
  const hubUrl = hubBase(ref.hubUrl);
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
  opts: {
    fetch?: typeof globalThis.fetch;
    init?: RequestInit;
    /** 再試行方針（cache 層と同じ既定・`false` で無効 — DECIDED: docs/decisions/0010）。 */
    retry?: RetryPolicy | false;
    /** 再試行 1 回ごとの通知（待機の前に呼ばれる）。 */
    onRetry?: (context: RetryContext) => void;
  } = {},
): Promise<string> => {
  const revision = ref.revision ?? "main";
  if (isCommitSha(revision)) return revision;
  const hubUrl = hubBase(ref.hubUrl);
  const kind = ref.kind ?? "model";
  const url = `${hubUrl}/api/${API_SEGMENT[kind]}/${ref.repo}/revision/${
    encodeURIComponent(revision)
  }`;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  // 解決 API も 429 を返す（Hub の rate limit はファイル取得と共通）。cache 層と同じ 1 本を通す。
  const { response, retries } = await fetchWithRetry(
    fetchImpl,
    url,
    opts.init,
    opts.retry,
    opts.onRetry,
  );
  if (!response.ok) {
    // 未消費 body は接続リソースを保持し続けるため解放してから throw する（mod.ts と同じ扱い）。
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `fetch-cache: HTTP ${response.status} ${response.statusText} (${url})${
        retrySuffix(retries)
      }`,
    );
  }
  const info = await response.json() as { sha?: unknown };
  if (typeof info.sha !== "string" || info.sha === "") {
    throw new Error(`fetch-cache: revision 解決応答に sha が無い (${url})`);
  }
  return info.sha;
};

export type HfFetchOptions = {
  /** ファイル毎の進捗（path 付き）。 */
  onProgress?: (progress: FetchProgress & { path: string }) => void;
  /** cache I/O 失敗の通知（cache 層へそのまま渡す）。既定 console.warn。 */
  onCacheError?: (context: CacheErrorContext) => void;
  /**
   * fetch へそのまま渡す RequestInit（gated/private repo の Authorization 等）。revision
   * 解決 API とファイル取得の両方へ渡る。キャッシュキーにヘッダは入らない
   * （docs/limitations.md）。
   */
  init?: RequestInit;
  fetch?: typeof globalThis.fetch;
  /** CacheStorage の差し替え（cache 層へそのまま渡す）。既定 globalThis.caches。 */
  caches?: CacheStorage;
  /**
   * true で `sha256` 宣言ファイルのキャッシュヒット時に実バイトを再ハッシュして突合する
   * （cache 層 `recheck` へそのまま渡す。既定 false = 保存時に焼いた記録ハッシュとの
   * 文字列比較だけで信じる — ローカル単一ユーザーの格納を信頼する判断。DECIDED:
   * docs/decisions/0006 §2）。`sha256` の無いファイルには影響しない。
   */
  recheck?: boolean;
  /**
   * 再試行方針（既定で有効 — 429 / 503 を `Retry-After` に従って取り直す）。`init` と同じく
   * **revision 解決とファイル取得の両方**へ渡る。`retry: false` で従来どおり即 throw する
   * （DECIDED: docs/decisions/0010）。
   */
  retry?: RetryPolicy | false;
  /** 再試行 1 回ごとの通知（待機の前に呼ばれる）。revision 解決・ファイル取得の両方から届く。 */
  onRetry?: (context: RetryContext) => void;
};

/**
 * HfFileSpec の検証（expectedBytes / カスタム validate）を fetchBytes の validate フックへ
 * 合成する。validate として渡すことでキャッシュヒット側にも効き、破損キャッシュは self-heal
 * される。`sha256` はここに含めない — cache 層の一級オプション（記録ハッシュ + 突合）へ渡す
 * （DECIDED: docs/decisions/0006 §2）。
 */
const buildValidate = (spec: HfFileSpec): ValidateBytes | undefined => {
  if (spec.expectedBytes === undefined && spec.validate === undefined) {
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
    await spec.validate?.(bytes);
  };
};

/**
 * キャッシュキー。`sha256` があるときだけ内容キー `["hf", kind, repo, path, sha256]` —
 * revision を含めないので revision bump / 切り替えのどちらでも再ダウンロードが起きず、
 * `hubUrl` も含めないので同一内容ならミラーを跨いでエントリと合流を共有する。`sha256` が
 * 無ければ undefined = SHA 固定 resolve URL がキー（鮮度シグナルが無い以上、安定キーは
 * stale 固着を作るため revision 入りに倒す。DECIDED: docs/decisions/0006 §4）。
 * 呼び出し側による上書き（`HfFileSpec.key`）は 0.5.0 で撤去した（DECIDED: 0008）—
 * エントリの掃除はこのキー式を前提に `evict(["hf", kind, repo])` 等のプレフィックスで行う。
 */
const contentKey = (ref: HfRepoRef, spec: HfFileSpec): CacheKey | undefined => {
  if (spec.sha256 === undefined) return undefined;
  return ["hf", ref.kind ?? "model", ref.repo, spec.path, spec.sha256];
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
  return fetchBytesWithKey(url, contentKey(ref, spec), {
    cache: true,
    sha256: spec.sha256,
    // recheck は sha256 とセットでのみ有効（cache 層は単独指定を throw で弾く）。
    recheck: spec.sha256 === undefined ? undefined : opts.recheck,
    validate: buildValidate(spec),
    decode: spec.decode,
    // 既に持っているバイト数申告を受信バッファの確保ヒントとして流す（検証は validate 側）。
    expectedBytes: spec.expectedBytes,
    into: spec.into,
    onProgress: onProgress === undefined
      ? undefined
      : (progress) => onProgress({ ...progress, path: spec.path }),
    onCacheError: opts.onCacheError,
    init: opts.init,
    retry: opts.retry,
    onRetry: opts.onRetry,
    fetch: opts.fetch,
    caches: opts.caches,
  });
};

/**
 * ファイル指定を HfFileSpec へ正規化する（全入口の合流点）。形式不正の `sha256` と、`into` の
 * 容量を超える `expectedBytes` はここで fail loud に弾く — 必ず不一致 / 容量不足になる申告
 * なので、全量ダウンロードしてから落とすと呼び出し毎に帯域を捨てることになる（cache 層の
 * 同じガードと語彙を揃え、path 付きで報告する）。
 */
// MUST: 各入口で revision 解決（network）より前に呼ぶ — 後に回すと形式不正でも解決 API
// 1 発（複数ファイルでは兄弟ファイルの取得開始まで）が漏れる。
const toSpec = (file: string | HfFileSpec): HfFileSpec => {
  const spec = typeof file === "string" ? { path: file } : file;
  if (spec.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(spec.sha256)) {
    throw new Error(
      `fetch-cache: sha256 は 64 桁の小文字 hex で指定してください: ${spec.sha256} (${spec.path})`,
    );
  }
  if (
    spec.into !== undefined && spec.expectedBytes !== undefined &&
    spec.expectedBytes > spec.into.length
  ) {
    throw new IntoCapacityError(
      spec.path,
      spec.into.length,
      `expectedBytes ${spec.expectedBytes} バイト`,
    );
  }
  return spec;
};

/**
 * HuggingFace リポジトリからファイルを 1 つ取得する。可変 ref は現在の SHA へ解決してから
 * SHA 固定 URL で取得する（revision に SHA を渡せば解決リクエストは発生しない）。
 * `spec.sha256` があればキャッシュキーは内容キー（revision 非依存 — モジュール doc 参照）。
 */
export const fetchHfFile = async (
  ref: HfRepoRef,
  file: string | HfFileSpec,
  opts: HfFetchOptions = {},
): Promise<Uint8Array> => {
  const spec = toSpec(file);
  const revision = await resolveHfRevision(ref, {
    fetch: opts.fetch,
    init: opts.init,
    retry: opts.retry,
    onRetry: opts.onRetry,
  });
  return await fetchResolvedFile(ref, revision, spec, opts);
};

/** `prefetchHfFile` のオプション（cache 層 `prefetchUrl` と同じく縮退しない＝fail loud）。 */
export type HfPrefetchOptions = {
  /** ファイル毎の進捗（path 付き）。既にエントリがあるときは呼ばれない。 */
  onProgress?: (progress: FetchProgress & { path: string }) => void;
  /** fetch へそのまま渡す RequestInit。revision 解決とファイル取得の両方へ渡る。 */
  init?: RequestInit;
  fetch?: typeof globalThis.fetch;
  /** CacheStorage の差し替え（cache 層へそのまま渡す）。既定 globalThis.caches。 */
  caches?: CacheStorage;
  /**
   * 再試行方針（既定で有効・`init` と同じく revision 解決とファイル取得の両方へ渡る）。
   * `retry: false` で従来どおり即 throw する（DECIDED: docs/decisions/0010）。
   */
  retry?: RetryPolicy | false;
  /** 再試行 1 回ごとの通知（待機の前に呼ばれる）。 */
  onRetry?: (context: RetryContext) => void;
};

/** `prefetchHfFile` の結果（何をしたか + どの revision / URL を温めたか）。 */
export type HfPrefetchResult = {
  /** 取得して格納したなら true、既にエントリがあって何もしなかったなら false。 */
  fetched: boolean;
  /** 温めた対象の解決済みコミット SHA（可変 ref を渡した場合の解決結果）。 */
  revision: string;
  /** 温めた対象の SHA 固定 URL（取得元。`spec.sha256` 無しならキャッシュキーでもある）。 */
  url: string;
};

/**
 * HuggingFace のファイルを**ヒープに全量を載せずに**キャッシュへ温める（streaming prefetch）。
 * 可変 ref は `fetchHfFile` と同じ流儀で現在の SHA へ解決してから SHA 固定 URL で取得し、
 * キャッシュキーも `fetchHfFile` と同じ式（`sha256` があれば内容キー、無ければ
 * resolve URL）なので、**温めたエントリはそのまま `fetchHfFile` のヒットになる** — ただし
 * `sha256` の無い spec ではキーが revision（解決済み SHA）入りの URL のため、温めてから
 * 読むまでの間に upstream の revision が動くと丸ごとミスし、旧エントリは孤児になる。可変
 * ref で温めるときは戻り値の `revision` を以後の読み出しへ渡し回すこと（`sha256` があれば
 * 内容キー = revision 非依存なので渡し回しは不要）。戻り値の
 * `fetched` は「取得して格納した」なら true、「既にエントリがあって何もしなかった」なら false。
 *
 * 可変 ref（"main" 等）を渡しても、**どの SHA を温めたかが戻り値の `revision` で分かる**
 * （revision 解決は既存エントリで何もしない場合も必ず走るので、`revision` / `url` は常に
 * 返る）。
 *
 * `spec.sha256` があれば cache 層の通過中検証（`prefetchUrl` の `sha256`）へ自動で流れ、
 * 一致したエントリにだけ記録ハッシュが焼かれる。以後の `fetchHfFile` はヒット時に記録との
 * 突合だけで済む（再ハッシュ無し — 数 GB のモデルで起動毎の全量ハッシュを避ける本命の
 * 使い方。疑う運用は `HfFetchOptions.recheck`）。
 * NOTE: prefetch が spec から見るのは `sha256` だけ。`expectedBytes`
 *       （`fetchHfFile` では検証 + 確保ヒント）も `spec.validate` も `spec.into`（呼び出し側
 *       バッファ）も、渡しても prefetch では使われない（バイト列を手元に持たないため。
 *       docs/limitations.md）。
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
  const spec = toSpec(file);
  const revision = await resolveHfRevision(ref, {
    fetch: opts.fetch,
    init: opts.init,
    retry: opts.retry,
    onRetry: opts.onRetry,
  });
  const url = hfResolveUrl({ ...ref, revision, path: spec.path });
  const onProgress = opts.onProgress;
  const fetched = await prefetchUrlWithKey(url, contentKey(ref, spec), {
    sha256: spec.sha256,
    onProgress: onProgress === undefined
      ? undefined
      : (progress) => onProgress({ ...progress, path: spec.path }),
    init: opts.init,
    retry: opts.retry,
    onRetry: opts.onRetry,
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
  // Object.keys は string[] に落ちるため Names[] へ戻す（キーは files の実キーそのもの）。
  const names = Object.keys(files) as Names[];
  // 全 spec を先に同期検査 — 1 つでも形式不正なら解決 API にも兄弟ファイルの取得にも出ない。
  const specs = names.map((name) => toSpec(files[name]));
  const revision = await resolveHfRevision(ref, {
    fetch: opts.fetch,
    init: opts.init,
    retry: opts.retry,
    onRetry: opts.onRetry,
  });
  const entries = await Promise.all(
    names.map(async (name, index) =>
      [
        name,
        await fetchResolvedFile(ref, revision, specs[index], opts),
      ] as const
    ),
  );
  // fromEntries は Record<string, ...> に落ちるため Names キーへ戻す（entries は names 起点）。
  return Object.fromEntries(entries) as Record<Names, Uint8Array>;
};
