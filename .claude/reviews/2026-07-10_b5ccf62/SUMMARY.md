---
title: Deep Review — @hdae/fetch-cache 初回レビュー
date: 2026-07-10
head: b5ccf62
prev_review: なし（初回）
mode: A（差分＝初回につき全域を対象）
reviewer: Claude (orchestrator: fable / finders: opus×3 + sonnet×1 / verifiers: fable×2)
---

# SUMMARY — 2026-07-10 @ b5ccf62

## 実施概要

- **モード**: A。初回レビューのため差分基点なし、全ファイル（除外なし・生成物なし）を 4 グループで並列レビュー後、Pass2（敵対的検証）2 本を実施。
- **対象**: リポジトリ全体（src 5 / scripts 6 / workflows 2 / docs 3 / 設定 2）。
- **モデル配分**: finders = Opus（A: cache 層 / B: HF 層 / C: release）+ Sonnet（D: docs 突合・機械的）。verifiers = Fable（V-A: 並行性・仕様検証、V-B: HF URL エンコード実測）。
- **CI 状況**: レビュー開始時 `deno task check` 全緑（26 passed / 0 failed / 1 ignored）。ignored は Deno に `Cache.keys()` が無いため実行不能な一覧テスト（意図どおり）。
- **Pass2 実施根拠**: needs-human 多数 + 同一ファイル跨ぎ複数 Warning（src/hf/mod.ts に 5 件）。結果: 1 件格上げ（W-B-1→Error）、1 件反証・取り下げ（W-A-5）、2 件確定（W-A-3 / E-A-1 の安全側主張）、1 件新規 Low（V4 body 未 cancel）。

## グループ別レポート

| Group | 担当 | findings | 結果 |
| --- | --- | --- | --- |
| A | cache 層（src/mod.ts + test） | findings/group-A-cache.md | E2 / W3 / L4 |
| B | HF 層 + testing（src/hf/ + src/testing/） | findings/group-B-hf.md | W5 / L1 |
| C | version/release（scripts + CI + deno.json） | findings/group-C-release.md | W5 / L5 |
| D | docs 突合（README / CLAUDE.md / LICENSE） | findings/group-D-docs.md | E1 / W4（突合 45 件: accurate 41 / drifted 3 / unverifiable 1） |
| V-A | 敵対的検証（並行性・truncation・cache I/O・body cancel） | findings/verify-A.md | V1 holds / V2 **refuted** / V3 holds / V4 holds(Low) |
| V-B | 敵対的検証（HF URL エンコード・公式実装突合・実測） | findings/verify-B.md | W-B-1 **holds→Error** / W-B-2 holds(縮小) |

## 全体評価

設計品質は高い。中核不変条件（不正物を put しない / self-heal 有界 / 依存ゼロ / 依存方向 hf→cache 一方向 / version drift の 3 層防御 / テストのネットワーク非依存）はすべて成立を確認。弱点は (1) HF URL の revision 未エンコード（正当入力 slash ref が確実に 404）、(2) 失敗パス・並行・null-body のテスト網羅、(3) パイプライン外周（bump 部分失敗の罠 / scripts の型検査漏れ / release 前の check 欠落）、(4) README のコード例品質、に集中。

## ファイル別分類（最終・Pass2 反映後）

| File | 分類 | 主因 |
| --- | --- | --- |
| src/mod.ts | 🟡 | W-A-3（cache I/O 失敗ポリシー未決・要判断）、L: 非 2xx 時 body 未 cancel（V4） |
| src/mod.test.ts | 🟠 | E-A-1（並行未テスト）+ E-A-2（null-body 分岐未通過）+ W-A-4（失敗・境界） |
| src/hf/mod.ts | 🟠 | **E-B-1**（旧 W-B-1 格上げ: revision 未エンコードで slash ref が 404。実測+公式実装で確定）+ W-B-2（path の `#`） |
| src/hf/mod.test.ts | 🟡 | W-B-3/4/5（HTTP エラー・404 伝播・self-heal 配線の失敗パス未テスト） |
| src/testing/mock_fetch.ts | 🔵 | 堅実。忠実度の留保のみ（L-B-a〜c） |
| scripts/bump.ts | 🟡 | W-C-1（部分失敗で rollback 無し）+ W-C-2（CI 型検査外） |
| scripts/config_version.ts | 🟢 | — |
| scripts/release_tag.ts | 🟢 | — |
| scripts/release_tag.test.ts | 🟡 | W-C-5（prerelease 受理・境界未テスト） |
| scripts/verify_tag.ts | 🔵 | W-C-2 に含む（CI 型検査外） |
| scripts/version_sync.test.ts | 🟢 | 非タウトロジーの真の drift 検出 |
| .github/workflows/ci.yml | 🟡 | W-C-2 + W-C-4（SHA pin 無し。checkout@v7 の実在は gh api で確認済み＝Error 格上げ回避） |
| .github/workflows/release.yml | 🟡 | W-C-3（publish 前に check 無し）+ W-C-4 |
| deno.json | 🔵 | L-C-b（check の entrypoint 手写し重複） |
| deno.lock / .gitignore / LICENSE / CLAUDE.md | 🟢 | — |
| README.md | 🟠→修正済 | E-D-1（例の未定義 `url`）+ W-D-1〜4 → 本セッションの英語化リライトで全て解消 |

## 件数集計（Pass2 反映後）

🔴 0 / 🟠 4（E-A-1, E-A-2, E-B-1, E-D-1）/ 🟡 10（W-A-3, W-A-4, W-B-2, W-B-3, W-B-4, W-B-5, W-C-1, W-C-2, W-C-3, W-C-4, W-C-5 のうち W-D 系は README 修正で解消済につき残 10）/ 🔵 多数（各 findings 参照）/ 取り下げ 1（W-A-5 — V2 で反証: loaded==total 強制は Content-Encoding 越しで誤検知バグになるため現設計が正）

## 本セッションで実施した修正

- README.md を英語化リライト（hnsw 構成準拠）。E-D-1（未定義 `url`）と W-D-1〜4（HF 名前空間分離 / ブラウザ導入 / 部分キャッシュ副作用 / エンコード前提）を同時解消。
- コード修正は未実施（ユーザー承認待ち。下記アクションアイテム参照）。

## アクションアイテム（承認待ちの修正計画）

コミット単位の提案。①〜⑥ は判断不要（明確な欠陥/不足）、⑦〜 は要判断。

1. `fix(hf)`: revision を `encodeURIComponent`、path をセグメント毎エンコード（E-B-1 / W-B-2。公式 2 実装と一致、SHA には恒等＝キャッシュキー不変、既存テスト緑のまま）+ URL 構築を凍結するテスト
2. `test`: cache 層の並行・null-body・失敗/境界テスト追加（E-A-1 テスト側 / E-A-2 + null-body mock ヘルパ / W-A-4 ①〜⑤）
3. `test(hf)`: HTTP エラー・404 伝播・fetchHfFiles 全体 reject・self-heal 配線の fault injection テスト（W-B-3/4/5）
4. `chore`: `deno task check` の `deno check` に scripts を追加（W-C-2）
5. `ci(release)`: publish 前に `deno task check` を実行（W-C-3）
6. `test(scripts)`: release_tag の prerelease 受理・境界テスト（W-C-5）
7. `fix(scripts)`: bump 部分失敗時の deno.json 復元 or 復旧手順の fail-loud 出力（W-C-1 — 方式は 2 案）
8. `fix(mod)`: 非 2xx throw 前の `body.cancel()`（V4, Low — 採否任意）

## 要判断（ユーザー決定待ち）

1. **W-A-3**: cache I/O 失敗（put の QuotaExceededError は仕様明文）が成功 DL を巻き添えにする現挙動。選択肢: (a) 縮退+通知フック（推奨・「キャッシュは最適化」明文と整合、無言の握り潰しにしない）/ (b) 現状維持＝fail-loud を DECIDED 化 / (c) 縮退+console.warn。
2. **E-A-1 振る舞い側**: single-flight（同一 URL 並行の合流）を lib 責務にするか、limitations 明文化に留めるか。
3. **W-C-4**: Actions の SHA pin 採用（release は id-token:write を持つため露出大。ただし更新運用コスト付き）。
4. **gated repo 認証**: Authorization ヘッダの口が無い（fetch DI で回避可能）。意図的制約として limitations 文書化か、opts.headers 追加か。
5. **docs/ レイアウト**: known-issues / limitations / decisions（ADR）の骨組みをグローバル規約どおり導入するか。

## 次回レビューの観点

- 承認された修正の実装確認（特に E-B-1 のエンコードと URL 凍結テスト）
- 🟢 Safe 確定ファイル（config_version / release_tag / version_sync / LICENSE / .gitignore / deno.lock）は無変更なら対象外
- Deno の Cache 実装が put 上書き時に旧 body ファイルを orphan として残す件（verify-A 副作用注記・Low）— Deno 側の将来修正を注視

## 検査メソッドのメモ

- Opus 並列 finder 3 + Sonnet 機械枠 1 は適配分だった。D（sonnet）は 45 件突合+実行検証まで完遂。
- Pass2 の Fable 2 本はいずれも価値があった: V2 の反証（W-A-5 取り下げ）と W-B-1 の実測格上げは finder 単独では到達していない。「所見を壊す」明示指示 + 実測許可（軽い HEAD/GET）が効いた。
- 初回だったため LEDGER 不使用（モード A）。次回は本 SUMMARY の未解決 ID を §1.4 で取り込むこと。
