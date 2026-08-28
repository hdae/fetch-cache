/**
 * `@hdae/fetch-cache` — Cache API を「制御」するダウンロード層（汎用層）。
 *
 * `fetchBytes` は URL をキーに Cache Storage へ保存し、2 回目以降は network なしで返す。
 * 鮮度の扱いは 2 系統: 省略時はヒットを信じる（ノーヒント）、`sha256` を渡せば保存時に
 * 検証して**記録ハッシュ**をエントリへ焼き、以後のヒットは記録との文字列比較だけで済ませる
 * （HashSum。既定はローカル格納を信頼 = 再ハッシュしない。`recheck` で opt-out）。
 * 条件付き GET（revalidate）は将来の変種として予約のみ（DECIDED: docs/decisions/0006）。
 * `validate` フックはキャッシュヒット側にも常に適用され、破損キャッシュは evict して真実源から
 * 取り直す（self-heal）。`decode` フックで「保存形 ≠ 利用形」（例: gzip のまま保存・解凍して
 * 返す）に対応する（throw は破損扱い＝validate と同じ縮退経路）。`caches` が無いランタイム
 * （Node.js 等）では素の fetch にフォールバックする＝キャッシュは正しさの要件ではなく最適化。
 * `prefetchUrl` は body をそのまま cache へ流し込む streaming 版で、巨大アセットをヒープに
 * 載せずに温めるためにある（`sha256` を渡せば通過中に検証し、通ったエントリにだけ記録
 * ハッシュを焼く）。
 *
 * キャッシュキーは URL、または**ライブラリが生成する配列キー**（HF 層の内容キー
 * `["hf", kind, repo, path, sha256]` 等。直列化はこの層が所有し、予約 origin の URL へ畳む）。
 * 呼び出し側がキーを指定する公開オプションは意図的に持たない（DECIDED:
 * docs/decisions/0008）。名前空間は内部固定 1 個で、区分けはキー先頭要素とプレフィックス操作
 * （`evict` / `listKeys`）で行う（DECIDED: docs/decisions/0006）。
 *
 * MUST: 実行時依存ゼロ。fetch / caches / crypto.subtle など Web 標準 API のみを使う。
 * 実装は src/core.ts（内部モジュール — `exports` に載せない）。
 *
 * @module
 */

export const VERSION = "0.5.0";

export {
  clearCache,
  decodeGzip,
  evict,
  evictUrl,
  fetchBytes,
  listCachedUrls,
  listKeys,
  prefetchUrl,
} from "./core.ts";
export type {
  CacheAdminOptions,
  CacheErrorContext,
  CacheKey,
  DecodeBytes,
  FetchBytesOptions,
  FetchProgress,
  PrefetchUrlOptions,
  ValidateBytes,
} from "./core.ts";
