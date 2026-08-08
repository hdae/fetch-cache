---
id: F
topic: リリース準備（deno.json / deno.lock / scripts / .github/workflows / src/testing / .gitignore / LICENSE）
files_reviewed:
  - deno.json
  - deno.lock
  - scripts/bump.ts
  - scripts/config_version.ts
  - scripts/release_tag.ts
  - scripts/release_tag.test.ts
  - scripts/verify_tag.ts
  - scripts/version_sync.test.ts
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
  - src/testing/mock_fetch.ts
  - .gitignore
  - LICENSE
date: 2026-08-08
model: claude-sonnet-5
---

## サマリ

担当範囲（deno.json / deno.lock / scripts/\* / .github/workflows/\* / src/testing/\* /
.gitignore / LICENSE）は **v0.3.1..HEAD で 1 バイトも変更されていない**
（`git diff v0.3.1..HEAD --stat -- <担当ファイル>` が空、`git log --oneline -- <担当ファイル>`
の最新も v0.3.1 bump コミット自身）。今回の未リリース差分（streaming prefetch / 通過中
sha256 検証 / 検証済みマーカー / `prefetchHfFile`）は `src/mod.ts` / `src/hf/mod.ts` /
`src/sha256.ts` とそのテスト、および docs/README にのみ及んでおり、リリース基盤
（バージョン管理・CI・publish 設定・テストヘルパ）には触れていない。

- `deno task check` を実行し **110 passed / 0 failed / 1 ignored**（ignored は
  `Deno.version` ガード付きの `listCachedUrls` throw テストで、実行環境が Deno 2.9+ のため
  意図通り skip — 既知の by-design 挙動、docs/limitations.md 記載どおり）。
- リリースフロー（`deno task bump` → tag push → `release.yml` → JSR publish）は今回差分に
  対しても構造上そのまま機能する。`deno.json.version` と `src/mod.ts` の `VERSION` は現在
  両方 `0.3.1` で同期済み（drift なし）。**ただし今回の差分は追加 API を含むため、公開前に
  owner が `deno task bump minor` を実行する必要がある**（本 findings は「今のまま publish
  すると 0.3.1 として意図せず再 publish される」ことを指摘する位置づけ — 実行判断は範囲外）。
- publish 対象設定（`deno.json` の `publish.include` / `exclude`）は `src/sha256.ts`
  （非公開内部モジュール）を除外していないが、`exports` マップには `"."` と `"./hf"` のみで
  `sha256.ts` は含まれないため **モジュール自体は配布物に同梱されるが公開 API としては
  露出しない**。CLAUDE.md の記述（「内部モジュール（非公開）」）と実態は一致している
  — 意図的な状態と判断（下記 F-1 で軽く触れる、W ではない）。
- 新規 export（`prefetchUrl` / `prefetchHfFile`）と既存 options 型への追加フィールド
  （`FetchBytesOptions.expectedBytes` / `.verifiedMarker`、`HfFileSpec.expectedBytes` /
  `.sha256`、`HfFetchOptions.trustCachedSha256` 等）はすべて optional な追加であり、
  既存シグネチャの破壊的変更は確認できなかった（詳細は F-2）。**semver 的には minor 相当**
  で CLAUDE.md の「公開 API の破壊的変更は不可」規約に抵触しない。
- 前回未消化事項（W-C-4 SHA pin 先送り / L-C-c bump サブプロセスの deno.lock 書込み確認 /
  bump.ts 統合テスト不在）はいずれも本差分で変化なし。現状報告のみ、以下「横断所見」参照。

**分類件数**: S=10 / L=1 / W=1 / E=0 / C=0

## ファイル別分類

| ファイル | 分類 | 理由 |
|---|---|---|
| deno.json | S | v0.3.1..HEAD で無変更。exports/publish include-exclude とも今回差分の実態と整合（F-1 参照、指摘は W 未満） |
| deno.lock | S | v0.3.1..HEAD で無変更。内容は `@std/assert` のみで妥当 |
| scripts/bump.ts | S | v0.3.1..HEAD で無変更。前回レビュー時から機能に変化なし |
| scripts/config_version.ts | S | v0.3.1..HEAD で無変更 |
| scripts/release_tag.ts | S | v0.3.1..HEAD で無変更 |
| scripts/release_tag.test.ts | S | v0.3.1..HEAD で無変更、`deno task check` で green |
| scripts/verify_tag.ts | S | v0.3.1..HEAD で無変更。`src/mod.ts` の VERSION drift 検証ロジックは今回追加された export 群とは独立（VERSION 文字列一致のみ見る）ため、今回差分でも壊れない |
| scripts/version_sync.test.ts | S | v0.3.1..HEAD で無変更 |
| .github/workflows/ci.yml | S | v0.3.1..HEAD で無変更。`deno task check` を叩くだけなので新規テスト（sha256.test.ts 等）も自動的に対象に入る |
| .github/workflows/release.yml | L | v0.3.1..HEAD で無変更だが、release ゲートが `deno task check` 依存の一枚岩であることの複雑度をここで記録（F-3、W 未満・状態把握目的） |
| src/testing/mock_fetch.ts | S | v0.3.1..HEAD で無変更。`chunkedResponse` が既存のまま streaming prefetch / sha256 検証の新規テスト群（`src/mod.test.ts` L173〜, `src/hf/mod.test.ts`）に転用され、追加改修なしで用が足りている |
| .gitignore | S | v0.3.1..HEAD で無変更 |
| LICENSE | S | v0.3.1..HEAD で無変更 |

## 詳細指摘

### F-1（L）: publish 物に非公開モジュール `src/sha256.ts` が同梱される

- **概要**: `deno.json` の `publish.include` は `src/**/*.ts` を丸ごと含み、`exclude` は
  `*.test.ts` と `src/testing/**` のみ。`src/sha256.ts` はテストでも testing/ 配下でもない
  ため **JSR パッケージに同梱される**。一方 `exports` マップは `"."` と `"./hf"` のみで
  `sha256.ts` を指さないため、`import { createSha256 } from "@hdae/fetch-cache/sha256"` の
  ような形では読み込めない（JSR の exports 制約により非公開のまま）。
- **発生条件**: 常時（v0.3.1 の時点でも同型の設定は無かったため、これは今回差分で新規に
  同梱されるファイル）。
- **修正案**:
  1. （★推奨）現状維持。JSR は `exports` に載らないモジュールへの外部からの `import` を
     ブロックしないが、`deno.json` の `exports` に無いパスは公式にサポート外という扱いに
     なる。ソースが同梱されること自体は「内部実装を隠す」目的をやや弱めるが、実害
     （下流が意図的に非公開パスへ直接 import してくる）は考えにくく、修正コストに見合わない。
  2. `publish.exclude` に `src/sha256.ts` を追加して完全に非同梱にする。ただし `src/mod.ts`
     は `sha256.ts` を静的 import しているため、**publish 前提の型解決・実行が壊れる
     （JSR は import グラフの到達可能性をチェックする）**。この案は採用不可 — 除外すると
     publish 自体が失敗する可能性が高い（要検証、needs-human）。
  3. `exports` に `"./internal/sha256"` 等を追加して意図的に公開する。CLAUDE.md の
     「内部モジュール（非公開）」という設計判断（sha256.ts 冒頭コメント・ADR 0005 §5）に
     反するため不採用。
- **リスク**: 低。実害が顕在化するとすれば「下流が `@hdae/fetch-cache/src/sha256.ts` のような
  非公式パスへ直接依存し、以後の内部変更が意図せず破壊的になる」だが、JSR の `exports` 制約下
  ではこの依存パスの発見コストは高く、現実的な脅威ではない。
- **対象**: deno.json:12-21（`exports` と `publish.include`/`exclude` の両ブロック）
- **影響範囲**: 公開パッケージの同梱物のみ。ランタイム挙動・公開 API には影響しない。
- **引き継ぎ**: 対応するなら案 2 の実行可否（`deno publish --dry-run` で `src/mod.ts` →
  `src/sha256.ts` の到達可能性チェックが exclude 設定とどう相互作用するか）を先に検証する
  必要がある。現状では「対応不要」の判断が妥当と考える。
- **裁定**: 対応不要（現状維持）— 実害が小さく、案 2 は publish を壊すリスクがあるため。

### F-2（W）: 今回追加 API の semver 分類が minor で正しいことの確認（要 bump 実行）

- **概要**: `deno.json.version` は `0.3.1` のまま、`src/mod.ts` の `VERSION` 焼き込みも
  `0.3.1` のまま（両者は同期済みで drift なし）。しかし今回の差分は次を追加している:
  - 新規 export: `prefetchUrl`（cache 層）, `prefetchHfFile`（HF 層）
  - 既存公開型への optional フィールド追加: `FetchBytesOptions.expectedBytes` /
    `.verifiedMarker`、`HfFileSpec.expectedBytes` / `.sha256`、`HfFetchOptions
    .trustCachedSha256`
  いずれも「新規 export の追加」または「既存 options 型への optional フィールド追加」で、
  構造的部分型（TypeScript の構造的型付け）の下では下流コードを壊さない **加算的
  （minor）変更**と判断した。既存の必須フィールド化・関数シグネチャの破壊的変更・
  export 削除は `git diff v0.3.1..HEAD -- src/mod.ts src/hf/mod.ts` を通読した限り見当たら
  なかった（この確認自体は担当外ファイルの読解だが、release readiness 判断に直結するため
  ここで報告する）。
- **発生条件**: 現状のまま `git push` → GitHub Release を `v0.3.1` で作成すると、
  `release.yml` の `verify_tag.ts` は「タグ==deno.json.version==VERSION」の一致だけを見る
  ため通ってしまい、**新機能を含む内容が旧バージョン番号のまま JSR に publish される**
  （実害: 下流が `^0.3.1` 等でピン留めしていても中身だけ変わる形は避けられているが——
  実際には JSR は同一バージョンの再 publish 自体を拒否するため、この経路では publish が
  失敗して気づける可能性が高い。ただし「気づける」であって「防止できる」ではない）。
- **修正案**:
  1. （★推奨）owner が publish 前に `deno task bump minor` を実行し `0.4.0` へ上げてから
     tag/release する。scripts 側のガード（clean-tree・drift 検証）はそのまま機能する。
  2. 現状のまま release タグを `v0.3.1` で切ろうとした場合の実際の失敗モードを
     `deno publish --dry-run`（またはローカルの `deno publish` を dry-run 相当で）実行して
     確認する — 本レビューでは未実施（needs-human: JSR 側の「同一バージョン再 publish 拒否」
     挙動は API 越しの実測が必要で、ローカルからは検証しづらい）。
- **リスク**: 低〜中。verify_tag.ts 自体にバグは無く（タグ/deno.json/VERSION の三者一致は
  正しく検証している）、あくまで「bump し忘れて古いバージョン番号で release を切る」
  ヒューマンエラーを機械的には防げないという運用上のギャップ。JSR 側の重複バージョン拒否が
  最終防波堤として機能する可能性が高い（未実測）。
- **対象**: deno.json:3（`version` フィールド）、src/mod.ts:22（`VERSION` 焼き込み）— 両方
  現状 `0.3.1` で今回差分に対して未 bump。
- **影響範囲**: リリース手順のみ。コード・テストには影響しない。
- **引き継ぎ**: 実装側の対応は不要。owner 判断で `deno task bump minor` を実行してから
  tag push するオペレーション上の handoff 事項。
- **裁定**: needs-human（owner が bump 実行タイミングを判断する運用事項であり、コード上の
  修正対象ではない）。

### F-3（参考・W 未満）: release.yml の check ゲートが `deno task check` の内容に暗黙依存

- **概要**: `release.yml` は `deno task check`（fmt+lint+型+test）を red-gate として実行して
  いるが、この task の中身は `deno.json` の `tasks.check` 文字列に一枚岩でハードコードされて
  おり、release.yml 側にはどのチェックが走っているかの明示的な列挙が無い。今回のように
  `src/sha256.test.ts` のような新規テストファイルが増えても `deno test` はディレクトリ丸ごと
  拾うため自動的に対象に入り、実害は無い（実測: 上記サマリの 110 passed に `sha256.test.ts`
  の 4 件が含まれることを確認済み）。
- **判断**: 現状で機能しているため W 未満・対応不要。CI 設定の可読性メモとして記録するのみ。
- **対象**: .github/workflows/release.yml:26-27, deno.json:14（`tasks.check`）

## 横断所見

- **前回未消化事項（報告のみ・再指摘不要）**:
  - W-C-4（Actions SHA pin 先送り）: `ci.yml` / `release.yml` とも `actions/checkout@v7`,
    `denoland/setup-deno@v2` を tag 参照のまま（SHA pin なし）。今回差分でも変化なし。
    ユーザー判断済みで再指摘不要 — 現状報告のみ。
  - L-C-c（bump サブプロセスの deno.lock 書込み確認）: `scripts/bump.ts` は
    `deno bump-version` サブプロセスを `Deno.Command` で spawn するのみで `deno.lock` への
    書込みは確認していない。`deno task bump` 自体は `--no-lock` フラグ付きで起動される
    （deno.json:15 `"bump": "deno run --allow-read --allow-run=deno,git
    --allow-write=src/mod.ts --no-lock scripts/bump.ts"`）ため、bump.ts が spawn する
    `deno bump-version` サブプロセスも親プロセスの `--no-lock` を継承するかは未検証
    （子プロセスは別 `deno` invocation のため継承されない可能性がある — needs-human）。
    今回差分では bump.ts 自体が無変更のため、これは前回からの持ち越しであり本レビューでの
    新規指摘ではない。
  - bump.ts 統合テスト不在: `scripts/*.test.ts` は `release_tag.test.ts` /
    `version_sync.test.ts` のみで、`bump.ts` 自体（clean-tree ガード・原状復帰・commit）を
    実行系で検証するテストは無い。今回差分でも変化なし、持ち越し。
- **scripts / CI と `deno task check` の整合**: `ci.yml` は `deno task check` をそのまま
  叩いており、`deno.json.fmt` の対象（`.github CLAUDE.md README.md deno.json docs scripts
  src`）・`deno lint scripts src`・`deno check .`・`deno test --allow-read` のいずれも
  今回追加されたファイル（`src/sha256.ts`, `src/sha256.test.ts`, `docs/decisions/0005-*.md`,
  `.claude/future-work.md` 等）を自動的に拾う設計になっており、CI 設定側の追従作業は
  不要だった（実測: `deno task check` が実際に green で完走することをローカルで確認済み、
  上記サマリ参照）。
- **担当ファイルの無変更という事実そのものが今回のリリース判断材料**: streaming prefetch /
  通過中 sha256 検証という比較的大きな機能追加であっても、リリース基盤（バージョン管理・
  CI・publish 設定）に一切手を入れずに済んでいる ＝ 既存のリリース機構が新機能追加を
  正しく吸収できる設計になっている、という肯定的な観察として記録する。
