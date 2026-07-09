# @hdae/fetch-cache

Deno / ブラウザ両対応の「URL ベースの Cache API 付きダウンロード」ライブラリ。この
ファイルがプロジェクトの入口で、グローバル規約より優先される。

## Layout

- `src/mod.ts` — `.` エントリ（汎用 cache 層: fetchBytes / evictUrl / clearCache /
  listCachedUrls / VERSION 焼き込み）。
- `src/hf/mod.ts` — `./hf` エントリ（HuggingFace 層。cache 層の上に実装）。
- `src/testing/` — テスト専用の mock fetch ヘルパ（publish 対象外）。
- `scripts/` — version 単一真実源（deno.json）+ drift ガード一式（bump / verify_tag）。

## Commands

- `deno task check` — fmt (check) + lint + `deno check` + test。Clear before moving on.
- `deno task bump <patch|minor|major>` — deno.json + src/mod.ts の VERSION を 1 コミットで同期。

## Conventions

- **依存ゼロ MUST（Web 標準のみ）**: fetch / caches / crypto.subtle / TextEncoder 等。
  実行時依存を追加しない（`@std/assert` はテスト専用）。
- **ネットワークに出るテスト禁止**: fetch は必ず DI（`opts.fetch`）で偽装する。Cache API は
  実物を使い、テスト毎にユニークな cacheName + 後始末 `caches.delete`。
- **Fail loudly.** 破損・不正データを黙って握りつぶさない（キャッシュ破損だけは evict →
  真実源から取り直す self-heal が正規経路）。
- 未リリースなので migration / 後方互換 shim は書かない。breaking change は可。
