# 0001 — cache I/O 失敗は network へ縮退し、通知フックで可視化する

- 日付: 2026-07-10
- 状態: 採用（ユーザー承認済み）

## Context

`fetchBytes` は「キャッシュは最適化であり正しさの要件ではない」（src/mod.ts モジュール doc）
を設計原則として明文化する一方、cache I/O（open/match/put/delete）の throw をそのまま伝播
させていたため、validate まで通過した成功ダウンロードが `cache.put` の失敗で巻き添え reject
されていた（QuotaExceededError は Service Worker 仕様の Batch Cache Operations に明文の
ある現実的な失敗）。プロジェクト規約の fail-loudly（黙殺禁止）とこの原則の衝突点であり、
初回レビュー（.claude/reviews/2026-07-10_b5ccf62 の W-A-3）で要判断として上がった。

## Decision

cache I/O 失敗はダウンロード結果に影響させず network 側へ縮退して続行する。ただし無言の
握り潰しにはせず、`onCacheError` フック（既定 `console.warn`）で全失敗を通知する。

- open / match 失敗 = miss と同じ扱いで network へ。
- put 失敗 = 取得済み bytes をそのまま返す。
- self-heal 中の delete 失敗 = 再取得は続行（破損エントリは次回ヒット時にまた self-heal を試みる）。
- `evictUrl` / `clearCache` / `listCachedUrls` は対象外: キャッシュ操作そのものが目的の API
  なので、失敗は従来どおり fail-loud に throw する。

## Consequences

- 呼び出し側は quota 逼迫やストレージ破損でもダウンロード結果を失わない。通知に反応して
  掃除・容量確保する余地が残る。
- 既定 console.warn はログ汚染になり得るが、無通知（真の黙殺）よりを優先した。フックで
  差し替え・無効化できる。
- テストの故障注入のため `caches`（CacheStorage）を DI 可能にした（`fetch` DI と同型）。
