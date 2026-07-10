# ROADMAP — 2026-07-10 @ b5ccf62

初回レビューの指摘一覧。同日、承認を受けて大半を実装済み（消し込み欄参照）。

## 対応済み（2026-07-10 実装）

| ID | 内容 | commit |
| --- | --- | --- |
| E-B-1 / W-B-2 | HF revision/path の percent-encode + URL 凍結テスト | 09a8ea6 |
| E-A-1/E-A-2/W-A-4 | cache 層の並行・null-body・失敗/境界テスト | 649872d |
| W-B-3/4/5 | HF 失敗パス・self-heal 配線テスト | 038b097 |
| V4 | 非 2xx throw 前の body 解放 | cfba008 |
| W-A-3 | cache I/O 失敗の縮退+通知（onCacheError、ADR 0001）+ CacheStorage DI + L-A-6（open 1 回化）同梱 | 9d7763e |
| 要判断④ | RequestInit パススルー（init、ADR 0002）— gated repo 認証・AbortSignal | 7bdeac7 |
| W-C-1 | bump 部分失敗時の原状復帰 | b422afe |
| W-C-5 | release_tag の prerelease・境界テスト | 8465dda |
| W-C-2 / L-C-b | `deno check .` 化（scripts も型検査・列挙の二重管理解消） | d530a81 |
| W-C-3 | release.yml に publish 前 check ゲート | 76b4690 |
| 要判断⑤ | docs/ レイアウト（limitations / known-issues / ADR）導入 | 3ab2d72 |
| E-D-1 / W-D-1〜4 | README 英語化 + 新機能追記 | 1f4fc08, 07ca1b3 |

## 残（ユーザー判断済みの先送り）

| ID | 内容 | 判断 | 着手タイミング |
| --- | --- | --- | --- |
| E-A-1(挙動) | single-flight（in-flight map で同一 URL 並行を合流） | **a案を今後のバージョンで実装**（2026-07-10 ユーザー判断。docs/limitations.md に記載済み） | 次期バージョン |
| W-C-4 | GitHub Actions の SHA pin | 複数リポジトリ横断の議題として**後でまとめて**（2026-07-10 ユーザー判断） | 横断対応時 |

## 残（小・任意）

| ID | 内容 | 推定コスト | 備考 |
| --- | --- | --- | --- |
| L-C-c | bump サブプロセス（deno bump-version）の deno.lock 書込み有無の動作確認、必要なら --no-lock 伝播 | 極小 | 確認のみ |
| — | bump.ts の統合テスト（tmp git repo での部分失敗→復元の検証） | 中 | テスト権限（--allow-run/--allow-write）の拡張が要る |
| L-A-8 等 | 各 findings の Low 項目 | — | 次回レビューで再評価 |

## 取り下げ（実施しないこと・理由付き）

| ID | 内容 | 理由 |
| --- | --- | --- |
| W-A-5 | `loaded === total` の突合ガード | **反証済み（verify-A V2）**: Fetch 仕様が Content-Length を unreliable と明文。gzip（Content-Encoding）越しでは解凍後 bytes と圧縮 content-length の不一致が正常応答で必発し、誤検知バグになる。真の truncation は stream error で既に fail-loud。整合性は validate 委譲の現設計が正（docs/limitations.md に明文化済み）。 |
