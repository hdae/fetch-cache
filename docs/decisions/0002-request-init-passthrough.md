# 0002 — RequestInit パススルー（`init`）で fetch 互換の口を開ける／非 GET はキャッシュ非対応

- 日付: 2026-07-10
- 状態: 採用（設計判断はユーザーから委任）

## Context

gated / private な HuggingFace repo の取得には Authorization ヘッダが必要だが、渡す口が
無かった（初回レビューの要判断④）。`fetch` DI で回避はできるが、ヘッダ 1 つのために fetch
をラップさせるのは重い。ユーザーの方向付けは「fetch API と同等の形にすれば置き換えやすい」。

## Decision

`FetchBytesOptions` / `HfFetchOptions` に `init?: RequestInit` を追加し、fetch へそのまま
渡す。HF 層では revision 解決 API とファイル取得の両方へ伝播する。

- **キャッシュキーは URL のみ（ヘッダ非依存）**: 認証付きで取得した bytes は、以後認証なしの
  呼び出しでもヒットする。ローカル単一ユーザーのキャッシュとしては妥当（docs/limitations.md）。
- **非 GET はキャッシュ非対応**: Cache API は GET しか格納できない（`cache.put` は非 GET
  request で throw する仕様）。POST 応答のキャッシュにはボディハッシュ等のキー合成という
  別物の設計が必要で、需要が見えるまでスコープ外とする。cache 有効 + 非 GET は
  `caches` の有無（Node.js 含む）に依らず一貫して fail-loud に throw し、`cache: false` を
  明示させる。

## Consequences

- fetch からの移行が容易（同じ `RequestInit` がそのまま使える）。`AbortSignal` による中断も通る。
- `init.cache`（HTTP キャッシュモード）と本ライブラリの `cache`（Cache Storage）は別物の
  まま共存する（`init` は透過なので干渉しない）。
- POST キャッシュの需要が実際に出たら、本 ADR を差し替えてキー合成設計を起こす。
