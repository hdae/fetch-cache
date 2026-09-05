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

/** 再試行方針。省略時は既定値。`retry: false` で再試行しない（従来どおり即 throw）。 */
export type RetryPolicy = {
  /** 再試行する HTTP ステータス。既定 [429, 503]。 */
  statuses?: readonly number[];
  /** 再試行の最大回数（初回の要求は数えない）。既定 5。 */
  maxRetries?: number;
  /** Retry-After が無いときの 1 回目の待機 ms。以後 2 倍ずつ（1, 2, 4, 8, 16 秒）。既定 1000。 */
  baseDelayMs?: number;
  /** 待機の上限 ms（Retry-After の指示にも適用）。省略時は上限なし（サーバの指示どおり待つ）。 */
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
 * Retry-After の解釈。delta-seconds（非負整数の秒）と HTTP-date（現在時刻との差・過去なら 0）
 * の 2 形式を読む。どちらとしても解釈できない値は undefined =「指示なし」へ落とす
 * （サーバの書式ミスで取得を落とさない — 待機規則の既定へ委ねれば済む）。
 */
const parseRetryAfter = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
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
 */
export const fetchWithRetry = async (
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit | undefined,
  policy: RetryPolicy | false | undefined,
  onRetry: ((context: RetryContext) => void) | undefined,
): Promise<RetryOutcome> => {
  if (policy === false) {
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
    attempt += 1;
    const retryAfter = response.headers.get("retry-after") ?? undefined;
    // Retry-After があればサーバの指示が優先。無ければ指数バックオフ（既定 1, 2, 4, 8, 16 秒）。
    const delayMs = Math.min(
      parseRetryAfter(retryAfter) ?? baseDelayMs * 2 ** (attempt - 1),
      maxDelayMs ?? Infinity,
    );
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
