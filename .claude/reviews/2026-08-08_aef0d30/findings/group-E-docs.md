---
id: E
topic: docs 突合（README / CLAUDE.md / docs/limitations.md / docs/known-issues.md / docs/decisions/0005（+0001〜0004）/ .claude/future-work.md ⇔ 実コード）
files_reviewed:
  - README.md
  - CLAUDE.md
  - docs/limitations.md
  - docs/known-issues.md
  - docs/decisions/0005-streaming-prefetch-and-verified-marker.md
  - docs/decisions/0001-cache-io-degrade-with-notification.md（参照整合のみ）
  - docs/decisions/0004-single-flight-raw-sharing.md（参照整合のみ）
  - .claude/future-work.md
date: 2026-08-08
model: claude-sonnet-5 (effort: medium, group E)
---

## サマリ

対象 7 文書（+ ADR 0001/0004 は突合参照のみ）を `git diff v0.3.1..HEAD` の全差分および
`src/mod.ts` / `src/hf/mod.ts` / `src/sha256.ts` の現物、テスト（`src/mod.test.ts` /
`src/hf/mod.test.ts` / `src/sha256.test.ts`）、`deno.json` の exports/publish 設定と突合した。
`deno task check`（fmt + lint + check + test）はフルグリーン（110 passed / 0 failed / 1
ignored）。

- 検証可能な主張: 概算 60 件強（README の API 例のシグネチャ・戻り値・import パス、
  limitations.md の各箇条、ADR 0005 §1〜5 の各決定、future-work.md の裁定記述、CLAUDE.md の
  Layout 記述）。
- **accurate**: ほぼ全件。README の新 API 例（`prefetchUrl` / `prefetchHfFile` /
  `verifiedMarker` / `trustCachedSha256`）は import パス・シグネチャ・戻り値型とも
  `src/mod.ts` / `src/hf/mod.ts` の実装と一致し、そのまま動く形になっている。
  `docs/limitations.md` の新規箇条（expectedBytes はヒントのみ／prefetch の検証は sha256
  指定時のみ／prefetch は single-flight 対象外／マーカーの信頼境界／prefetch 由来マーカーは
  sha256 一致のみを主張）は実装・テストの両方と 1 対 1 で対応している。ADR 0005 の §1〜5
  も実装の分岐（`allocateHint` / `storableResponse` / `prefetchUrl` の sha256 検証・マーカー
  焼き込み・fail-loud）と食い違いなし。`deno.json` の `exports`（`.` / `./hf` のみ）・
  `publish.exclude`（`src/**/*.test.ts` / `src/testing/**`）は CLAUDE.md の
  「`src/sha256.ts` は非公開の内部モジュール」「`src/testing/` は publish 対象外」の記述と一致。
- **drifted**: 0 件（このディレクションの差分に限れば実装と文書の乖離は検出できなかった）。
- **unverifiable**: 3 件（後述 E-1）— いずれもベンチマーク数値の主張で、コードレビューの
  範囲では再現・反証ができない。
- W 以上の指摘: 0 件。L（拾っておくが再修正不要）: 2 件。

このリリース前チェックの結論として、**docs 側はリリースを妨げる要因ではない**。

## ファイル別分類

| ファイル | 分類 | 理由 |
|---|---|---|
| README.md | L | 新 API 例は import パス・シグネチャ・戻り値まで実装と一致し「そのまま動く」。E-2（マーカー文字列のプレフィックス不統一）のみ、実害のない表記ゆれとして残す。 |
| CLAUDE.md | S | Layout 節の追記（`src/sha256.ts` 非公開・`src/hf/mod.ts` の export 一覧）は実際の export / deno.json exports と完全一致。 |
| docs/limitations.md | S | 新規 7 箇条すべて実装・テストと 1 対 1 対応（詳細はサマリ参照）。 |
| docs/known-issues.md | S | 今回の差分では無変更。prefetch 系の新規事象で known-issues 入りすべきものは見当たらない（ADR 0005 Consequences の「ブラウザで stream put が全量バッファする可能性」は正しさに影響しない性能不確実性としてADR側に留める判断で妥当）。 |
| docs/decisions/0005-streaming-prefetch-and-verified-marker.md | L | 内容は実装と精緻に一致。E-1（ベンチマーク数値 3 件が unverifiable）と、§3(a) を後から§5 で撤回する「本文内追記」という編集スタイル（別 ADR を切らず同一ファイルに追記）が将来の参照者を混乱させうる点を注記に留める（実害なし、再修正不要）。 |
| docs/decisions/0001-cache-io-degrade-with-notification.md | S | 今回差分で無変更。ADR 0005 の `prefetchUrl` fail-loud 記述（「ADR 0001 の縮退契約は fetchBytes 専用」）と矛盾なし。 |
| docs/decisions/0004-single-flight-raw-sharing.md | S | 今回差分で無変更。ADR 0005 が「prefetch は single-flight 対象外」と明記しており、0004 側に prefetch の言及が無いこと自体は矛盾ではない（0004 は prefetch 導入前の ADR）。 |
| .claude/future-work.md | S | 2 件のメモ（paths-info 自動取得／純 TS SHA-256 の置換条件）とも「未実装」であることが本文中に明記されており、実装状況（未着手）と整合。裁定の記録先としても DECIDED 相当の遡及ポインタが無い代わりに「起票日・ユーザー裁定」の形で妥当に記録されている。 |

## 詳細指摘

### E-1: ADR 0005 のベンチマーク数値が unverifiable（needs-human）

- 概要: ADR 0005 および `src/sha256.ts` 冒頭コメント・`.claude/future-work.md` に繰り返し登場
  する 3 つの実測値——① 純 TS SHA-256 実測 212 MB/s（開発機）② native 一括 digest 実測
  810 MB/s ③ `new Response(bytes)` vs 1 チャンク stream の RSS 差分（+512MiB → +4MiB、
  Deno 2.9.4）——は、3 文書間で数値が完全に一致しており内部矛盾は無いが、コードレビューの
  範囲（静的検証・`deno task check`）では実測の再現ができない。数値そのものの真偽を判定する
  材料が無い。
- 対象 path:line:
  - `docs/decisions/0005-streaming-prefetch-and-verified-marker.md`（Decision §3(a) 撤回理由
    の段落、および Context の RSS 実測の段落）
  - `src/sha256.ts:8-10`
  - `.claude/future-work.md`（純 TS SHA-256 の置換条件の節、末尾）
- リスク: 数値が架空または古い環境のものだった場合、「§3(a) を撤回して純 TS 逐次検証を採用した」
  という設計判断の前提が崩れる。ただし判断の実体（prefetch は回線律速なので CPU 差は無関係）は
  数値の大小に依存しない定性的主張であり、数値が多少ずれても結論は揺らがない。
- 引き継ぎ: 次回オーナーが実測を追試したいなら `deno bench` 等でハーネスを組むのが妥当（現状
  ベンチマークコードはリポジトリに存在しない — `rg -l "Deno.bench"` はヒット無し）。
- 裁定: needs-human（数値の真偽はコードレビューでは判定不能。ただし判断ロジックは数値非依存
  なのでリリースのブロッカーにはしない）。

### E-2（L・参考）: README のマーカー文字列表記が節ごとに不統一

- 概要: README「Large assets」節では `prefetchUrl({ sha256: "1a2b…" })` →
  `fetchBytes({ verifiedMarker: "1a2b…" })` と、両者が同じ生の hex 文字列で揃っている
  （実装上も `prefetchUrl` が焼くマーカーは `expectedSha256` そのもの、prefix 無し —
  `src/mod.ts:607-609` の `markerInit`）。一方 README「Skipping re-validation on cache hits」
  節の独立した例では `verifiedMarker: "sha256:1a2b…"` と `"sha256:"` prefix 付きで書かれている。
- 発生条件: 読者が後者の例をそのまま `prefetchUrl` の sha256 と組み合わせて使おうとすると
  マーカー文字列が食い違い、ヒットしても常に「検証を省けない」（string 比較が一致しない）状態
  になる。
- 対象 path:line: `README.md`（「Skipping re-validation on cache hits (opt-in)」節のコード
  ブロック、`verifiedMarker: "sha256:1a2b…"` の行）
- 修正案:
  1. （推奨★）当該節の例をプレフィックス無し（`"1a2b…"`）に揃える — 他の 2 箇所と表記が
     一致し、`prefetchUrl` と組み合わせる読者にとって齟齬が起きない。
  2. 現状維持 — 当該節は `prefetchUrl` と独立した「呼び出し側が任意の validate をカスタム
     実装する」例であり、marker は完全に呼び出し側の自由形式（JSDoc: 「典型は sha256 hex」
     であって規定ではない）なので技術的には誤りではない。
- リスク: 低（実害は「コピペで組み合わせて使うと気づかず不一致になる」という UX 上の罠のみ。
  型としてはただの `string` なので実行時エラーにはならず、単に検証がヒットせず毎回 validate
  が走るだけ — fail loud にもならない静かな劣化）。
- 影響範囲: README のみ。src 側の実装・テストには影響なし。
- 引き継ぎ: 修正するなら README.md の 1 行差し替えのみ（`deno fmt` 対象、コード例ブロックは
  fmt 対象外なので手動整形で足りる）。
- 裁定: 選択肢 ① 推奨で採用するか、② 現状維持（意図的に独立例と示す）で確定するかはオーナー
  判断。W ではなく L 相当（実行時に静かに検証コストが増えるだけで、正しさは壊れない）。

## 横断所見

- ドキュメント一式（README / CLAUDE.md / limitations.md / ADR 0005）は、この規模の機能追加
  （streaming prefetch・通過中 sha256 検証・検証済みマーカー・純 TS SHA-256）にしては
  珍しいほど実装との乖離が無い。特に limitations.md の新規 7 箇条は、対応するテストケース名
  （`src/mod.test.ts:1045-1444` 付近、`src/hf/mod.test.ts:677-812` 付近）と文言レベルで
  対応が取れており、"仕様が先に書かれてテストと実装が後追いした" のではなく "実装した契約を
  そのまま文書化した" 形跡が明確（DECIDED ポインタも全箇所で `docs/decisions/0005` を指し、
  迷子のポインタは無い）。
- ADR 0005 は §3(a) を §5 で「撤回」する形式を取っている（別 ADR を切らず同一ファイル内に
  追記）。今回はその追記自体が首尾一貫しており実害は無いが、今後同様の"設計判断の上書き"が
  重なると 1 つの ADR が時系列で読みにくくなる可能性がある。決定が構造的に変わる場合は新規
  ADR を切って「supersedes 0005 §3(a)」とリンクする方が追跡しやすい、という運用上の所感を
  ここに記録しておく（指摘としてのアクションは求めない — 現状の 0005 単体としては問題ない）。
- CLAUDE.md の「実行時依存ゼロ MUST」原則と、ADR 0005 が導入した純 TS SHA-256 実装
  （`src/sha256.ts`）は緊張関係にあるが、ADR 側で「Web 標準に streaming digest が無いので
  純 TS 実装だけが唯一の手段」という原則適合の理由付けが明記されており、原則違反ではなく
  原則を満たすための必然的帰結として書かれている（`.claude/future-work.md` の「Web 標準に
  streaming digest が入ったら削除する」という撤退条件も明記済み）。C 判定（原則違反）には
  該当しない。
