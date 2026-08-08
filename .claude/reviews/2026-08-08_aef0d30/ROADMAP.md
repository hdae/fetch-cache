# ROADMAP — 2026-08-08 @ aef0d30

裁定待ちの計画は SUMMARY.md のアクションアイテム参照。ここは見送り・先送り分のみ。

## 高

（なし — リリース前対応候補はすべて SUMMARY の要判断へ）

## 中

| ID | 内容 | 推定コスト | 着手タイミング |
| --- | --- | --- | --- |
| C-4 残余 | 非 ASCII path の prefetch → fetchHfFile ヒット統合テスト 1 本（経路間キャッシュキー合意の凍結） | 小 | 次回テスト補完時 |
| A-L1 | prefetchUrl の open/match 失敗を fetch-cache: プレフィックス + cause でラップ（既存テストのメッセージ期待変更を伴う） | 小 | 次回 |

## 低

| ID | 内容 | 推定コスト | 着手タイミング |
| --- | --- | --- | --- |
| W-C-4 | GitHub Actions の SHA pin（前回から継続・ユーザー判断で横断対応待ち） | 小 | 複数リポ横断対応時 |
| L-C-c | bump サブプロセスの deno.lock 書込み確認 | 極小 | 任意 |
| — | bump.ts の統合テスト（tmp git repo） | 中 | 任意 |
| B-4 | 長さ下位語の 2^50 超 precision コメント一行 | 極小 | 任意（対応不要が既定） |
| future-work | paths-info API による sha256 自動取得（ユーザー裁定「将来的に実装」済み） | 中（~150 行 + テスト） | 要望発生時 |

## 取り下げ（実施しないこと・理由付き）

| ID | 内容 | 理由 |
| --- | --- | --- |
| A-L2 | content-length 確保信頼の対策 | Pass2 反証: limitations.md:24-27 の by-design 明記と重複。実測で RSS 増分ほぼ 0・確保失敗は縮退で吸収済み |
| C-2 本体 | prefetchHfFile JSDoc「実質包含」の書き換え | Pass2 反証: 当該文は sha256 指定時に条件づけられており誤りではない（残余の一文追加のみ SUMMARY カテゴリ3へ） |
