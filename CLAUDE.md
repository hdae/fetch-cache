# @hdae/fetch-cache

Deno / ブラウザ両対応の「URL ベースの Cache API 付きダウンロード」ライブラリ。この
ファイルがプロジェクトの入口で、グローバル規約より優先される。

## Layout

- `src/mod.ts` — `.` エントリ（汎用 cache 層: fetchBytes / evictUrl / clearCache /
  listCachedUrls / VERSION 焼き込み）。
- `src/hf/mod.ts` — `./hf` エントリ（HuggingFace 層。cache 層の上に実装）。
- `src/testing/` — テスト専用の mock fetch ヘルパ（publish 対象外）。
- `scripts/` — version 単一真実源（deno.json）+ drift ガード一式（bump / verify_tag）。
- `docs/` — 設計ドキュメント（下記 Docs 参照）。

## Commands

- `deno task check` — fmt (check) + lint + `deno check` + test。Clear before moving on.
- `deno task bump <patch|minor|major|pre*>` — deno.json + src/mod.ts の VERSION を 1 コミット
  で同期（pre\* = premajor / preminor / prepatch / prerelease）。

## Docs

- [docs/limitations.md](docs/limitations.md) — 意図的な制約（by-design。バグではない）。
- [docs/known-issues.md](docs/known-issues.md) — 未解決の既知問題。
- [docs/decisions/](docs/decisions/) — ADR（`NNNN-<slug>.md`）。コード中の `DECIDED:` はここを指す。

## Conventions

- **依存ゼロ MUST（Web 標準のみ）**: fetch / caches / crypto.subtle / TextEncoder 等。
  実行時依存を追加しない（`@std/assert` はテスト専用）。
- **ネットワークに出るテスト禁止**: fetch は必ず DI（`opts.fetch`）で偽装する。Cache API は
  実物を使い、テスト毎にユニークな cacheName + 後始末 `caches.delete`。
- **Fail loudly.** 破損・不正データを黙って握りつぶさない。正規の縮退経路は 2 つだけ:
  キャッシュ破損は evict → 真実源から取り直す self-heal、cache I/O 失敗は network へ
  縮退 + `onCacheError` 通知（DECIDED: docs/decisions/0001）。
- **リリース済み（v0.1.0 以降 JSR 公開・下流 yomi / sbv2-web が依存）— 公開 API の破壊的
  変更は不可**。やむを得ない場合は breaking と明記して migration / 非推奨経路を設計し、
  採否はオーナーに委ねる。「未リリースだから breaking 可」の規約は v0.1.0 で反転済み。
