/**
 * 再試行（429 / 503 の Retry-After 追従）の内部実装。cache 層・HF 層の fetch 呼び出し点は
 * すべてこの 1 本を通る（`fetchBytes` の network 経路 / `prefetchUrl` / `resolveHfRevision`）。
 *
 * このモジュール自体は deno.json の `exports` に載せない — 公開されるのは `RetryPolicy` /
 * `RetryContext` の 2 型だけで、再公開は src/mod.ts（`.`）と src/hf/mod.ts（`./hf`）が行う。
 *
 * MUST: 実行時依存ゼロ。fetch / setTimeout / AbortSignal など Web 標準 API のみを使う。
 *
 * @module
 */

/**
 * 再試行方針。省略時は既定値。`retry: false` で再試行しない（従来どおり即 throw）。
 *
 * 各値は形式検査され、外れた値は network に出る前に throw する（`sha256` / `expectedBytes` の
 * 形式検査と同じ fail loud — NaN 等を黙って受けると待機の上限ガードが素通りする）。
 */
export type RetryPolicy = {
  /** 再試行する HTTP ステータス（**400〜599 の整数**）。既定 [429, 503]。 */
  statuses?: readonly number[];
  /** 再試行の最大回数（初回の要求は数えない。**0 以上の整数**）。既定 5。 */
  maxRetries?: number;
  /**
   * Retry-After が無いときの待機の基準 ms（**0 以上の有限数**）。既定 1000。待機は再試行の
   * 通算回数で 2 倍ずつ伸びる（1, 2, 4, 8, 16 秒 — Retry-After に従った回も回数に数える）。
   */
  baseDelayMs?: number;
  /**
   * 待機の上限 ms（**0 以上の有限数**。Retry-After の指示にも適用）。省略時は上限なし
   * （サーバの指示どおり待つ）。
   */
  maxDelayMs?: number;
};

/** 再試行 1 回ごとの通知。 */
export type RetryContext = {
  readonly url: string;
  readonly status: number;
  /** 何回目の再試行か（1 始まり）。 */
  readonly attempt: number;
  /** これから待つ ms。 */
  readonly delayMs: number;
  /** 応答の Retry-After ヘッダ（無ければ undefined）。 */
  readonly retryAfter?: string;
};

/** `fetchWithRetry` の結果。`retries` は実際に再試行した回数（0 = 初回で決着）。 */
export type RetryOutcome = {
  response: Response;
  retries: number;
};

const DEFAULT_STATUSES: readonly number[] = [429, 503];
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 1000;

/**
 * setTimeout が扱える待機の上限（符号付き 32bit の最大 = 約 24.8 日）。これを超える指定は
 * 実装が 1 に潰して**即時発火**する（Deno は TimeoutOverflowWarning を出す）ため、待った
 * ことにできない。MUST: 超える待機は再試行しない（下の `fetchWithRetry` 参照）。
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** 再試行してよい method か（副作用のある要求を打ち直さない MUST — 冪等な GET / HEAD だけ）。 */
const isRetriableMethod = (method: string): boolean =>
  method === "GET" || method === "HEAD";

/**
 * Retry-After の解釈。delta-seconds（非負整数の秒）と HTTP-date（曜日名で始まる日時 —
 * 現在時刻との差・過去なら 0）の 2 形式を読む。どちらとしても解釈できない値は undefined
 * =「指示なし」へ落とす（サーバの書式ミスで取得を落とさない — 待機規則の既定へ委ねれば済む）。
 *
 * MUST: 英字で始まらない値を `Date.parse` に渡さない — V8 は "1.5" / "+120" のような数値系の
 * 書式ミスを 2000 年前後の日付として受理するので、渡すと「過去 → 待機 0」に化けて「指示なし」へ
 * 落とせない（rate limit 中の相手へ待機ゼロで連打することになる）。RFC 9110 の HTTP-date 3 形式
 * （IMF-fixdate / RFC 850 / asctime）はいずれも曜日名で始まるため、この検査で正規の値は落ちない。
 */
const parseRetryAfter = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  if (!/^[A-Za-z]/.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
};

/**
 * RetryPolicy の形式検査（要求の前に fail loud）。NaN は `Math.min` を通っても NaN のままで
 * `NaN > MAX_TIMER_MS` が偽になり「守れない待機は再試行しない」ガードを素通りする。
 * `maxRetries: NaN` は `attempt >= NaN` が恒偽で回数では止まらなくなる。黙って受けるとこの
 * 2 つの MUST が裏返るため、`expectedBytes` / `sha256` と同じく入口で弾く。
 */
const validatePolicy = (policy: RetryPolicy, url: string): void => {
  const { statuses, maxRetries, baseDelayMs, maxDelayMs } = policy;
  if (
    maxRetries !== undefined &&
    (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
  ) {
    throw new Error(
      `fetch-cache: retry.maxRetries は 0 以上の整数で指定してください: ${maxRetries} (${url})`,
    );
  }
  for (
    const [name, value] of [
      ["baseDelayMs", baseDelayMs],
      ["maxDelayMs", maxDelayMs],
    ] as const
  ) {
    if (value !== undefined && !(Number.isFinite(value) && value >= 0)) {
      throw new Error(
        `fetch-cache: retry.${name} は 0 以上の有限数で指定してください: ${value} (${url})`,
      );
    }
  }
  for (const status of statuses ?? []) {
    if (!Number.isSafeInteger(status) || status < 400 || status > 599) {
      throw new Error(
        `fetch-cache: retry.statuses は 400〜599 の整数で指定してください: ${status} (${url})`,
      );
    }
  }
};

/**
 * 中断可能な待機。MUST: 待機完了時は abort リスナーを外し、abort 時は timer を clear する —
 * どちらも残すと Deno のテストサニタイザがリーク（未解決の timer / 生き残った listener）として
 * 検出する。既に aborted なら待たずに `signal.reason` で reject する（次の要求を出しても
 * どのみち同じ理由で落ちるため）。
 */
const sleep = (
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal === undefined) {
      setTimeout(resolve, delayMs);
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    // timer とリスナーは相互に参照する（完了時にリスナーを外し、abort 時に timer を消す）ため、
    // 先に束縛だけ作る。型はランタイム依存（Deno の number / Node の Timeout）なので推論に委ねる。
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * onRetry の隔離ラッパ。通知は任意情報（正しさの要件ではない）なので、リスナーの throw で
 * 取得を落とさない — onProgress と同じ「落とさず・無言にもしない」縮退方針
 * （DECIDED: docs/decisions/0004）。
 */
const notifyRetry = (
  onRetry: ((context: RetryContext) => void) | undefined,
  context: RetryContext,
): void => {
  if (onRetry === undefined) return;
  try {
    onRetry(context);
  } catch (error) {
    console.warn(
      `fetch-cache: onRetry リスナーが throw しました（通知のみ中断・再試行は続行） (${context.url})`,
      error,
    );
  }
};

/** HTTP エラー文言の末尾に添える再試行回数（0 回なら空文字＝従来どおりの文言）。 */
export const retrySuffix = (retries: number): string =>
  retries === 0 ? "" : `（再試行 ${retries} 回の後）`;

/**
 * 対象ステータス（既定 429 / 503）の応答が返る間だけ待って取り直す fetch。それ以外の応答
 * （ok も、対象外のエラーも）は 1 回目でそのまま返し、回数を使い切ったときも**最後の応答を
 * そのまま返す** — HTTP エラーの throw は呼び出し点に残す（文言互換を保つため。
 * DECIDED: docs/decisions/0010）。
 *
 * 待機は `init.signal` で中断でき、再試行の前に失敗応答の body は解放する（未消費 body は
 * 接続リソースを保持し続けるため）。`onRetry` は待機の**前**に呼ぶ。
 *
 * 再試行しないのは 2 つ。①GET / HEAD 以外（`cache: false` 経由の POST 等 — 副作用のある
 * 要求を盲目的に打ち直さない）は最初の応答をそのまま返す（`retries` は 0）。②`maxDelayMs`
 * 適用後の待機が `MAX_TIMER_MS` を超えるとき（setTimeout が即時発火するので「待った」ことに
 * できない）は**そのラウンドの応答**をそのまま返す — そのラウンドは再試行回数に数えず
 * `onRetry` も呼ばないが、それまでに再試行していれば `retries` にはその回数が残り、呼び出し点の
 * 文言末尾にも付く（DECIDED: docs/decisions/0010）。
 *
 * `policy` の形式不正（NaN・負・非整数・範囲外のステータス）は要求の前に throw する。
 */
export const fetchWithRetry = async (
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit | undefined,
  policy: RetryPolicy | false | undefined,
  onRetry: ((context: RetryContext) => void) | undefined,
): Promise<RetryOutcome> => {
  if (policy !== undefined && policy !== false) validatePolicy(policy, url);
  if (
    policy === false ||
    !isRetriableMethod((init?.method ?? "GET").toUpperCase())
  ) {
    return { response: await fetchImpl(url, init), retries: 0 };
  }
  const statuses = policy?.statuses ?? DEFAULT_STATUSES;
  const maxRetries = policy?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = policy?.maxDelayMs;
  let attempt = 0;
  while (true) {
    const response = await fetchImpl(url, init);
    if (!statuses.includes(response.status) || attempt >= maxRetries) {
      return { response, retries: attempt };
    }
    const retryAfter = response.headers.get("retry-after") ?? undefined;
    // Retry-After があればサーバの指示が優先。無ければ指数バックオフ（既定 1, 2, 4, 8, 16 秒）。
    const delayMs = Math.min(
      parseRetryAfter(retryAfter) ?? baseDelayMs * 2 ** attempt,
      maxDelayMs ?? Infinity,
    );
    // MUST: 守れない待機は再試行しない — setTimeout の上限を超える指定は即時発火するので、
    // 再試行しても「指示を無視して打ち直した」だけになる（回数も 1 回ぶん無駄に減る）。
    if (delayMs > MAX_TIMER_MS) return { response, retries: attempt };
    attempt += 1;
    await response.body?.cancel().catch(() => {});
    notifyRetry(onRetry, {
      url,
      status: response.status,
      attempt,
      delayMs,
      retryAfter,
    });
    await sleep(delayMs, init?.signal ?? undefined);
  }
};
