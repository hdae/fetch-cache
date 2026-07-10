// テスト専用の fetch モック（publish 対象外）。呼び出し URL を記録し、ハンドラが組み立てた
// Response を返す。テストは絶対にネットワークに出ない（fetch は必ずこれで差し替える）。

export type MockFetch = {
  /** fetchBytes / resolveHfRevision へ DI する fetch 実装。 */
  fetch: typeof globalThis.fetch;
  /** 呼び出された URL の記録（回数 = length）。 */
  calls: string[];
  /** 呼び出し毎の RequestInit の記録（init パススルー検証用。未指定は undefined）。 */
  inits: (RequestInit | undefined)[];
};

/** URL ごとに Response を返すハンドラから mock fetch を作る。 */
export const mockFetch = (
  handler: (url: string) => Response | Promise<Response>,
): MockFetch => {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    inits.push(init);
    return Promise.resolve(handler(url));
  };
  return { fetch: fetchImpl, calls, inits };
};

/**
 * チャンク分割された streaming body を持つ Response を作る（onProgress 検証用）。
 * content-length は自動付与しない — total を検証したいテストだけが headers で明示する。
 */
export const chunkedResponse = (
  chunks: readonly Uint8Array<ArrayBuffer>[],
  headers?: HeadersInit,
): Response => {
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { headers });
};

/** テスト毎にユニークな cacheName（後始末は各テストが caches.delete で行う）。 */
export const uniqueCacheName = (): string =>
  `fetch-cache-test-${crypto.randomUUID()}`;
