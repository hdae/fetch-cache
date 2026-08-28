# ROADMAP — 2026-08-25 @ 6a00aa1

裁定待ちは SUMMARY.md の要判断参照。ここは見送り・先送りのみ。

## 今回レビュー由来

| ID | 内容 | 推定コスト | 着手タイミング |
| --- | --- | --- | --- |
| AP-01(d) | sha256 hex ヘルパ（buildValidate 相当含む）の export — fetchBytes 直呼び読み出しの DX 改善 | 小 | 下流から要望が出たら（非破壊追加） |
| AP-04 | CacheErrorContext.key?: string（裁定③で見送りの場合） | 極小 | 要望発生時（非破壊追加） |
| AP-06 | cacheKey の string → string \| URL 拡張 | 極小 | 要望発生時（非破壊追加） |
| TS-003 | onCacheError.url が cacheKey 指定時も requestUrl である契約の専用テスト | 極小 | 次回テスト補完時 |
| DC-2 残余 | 0006 Consequences へ「印が内容ハッシュ由来でない場合の誤キー混入は self-heal 不能」1 文 | 極小 | 任意（optional） |

## 前回（2026-08-08_aef0d30）からの継続

| ID | 内容 | 推定コスト | 着手タイミング |
| --- | --- | --- | --- |
| C-4 残余 | 非 ASCII path の prefetch → fetchHfFile ヒット統合テスト 1 本 | 小 | 次回テスト補完時 |
| A-L1 | prefetchUrl の open/match 失敗の fetch-cache: プレフィックス + cause ラップ | 小 | 次回 |
| W-C-4 | GitHub Actions の SHA pin（複数リポ横断対応待ち） | 小 | 横断対応時 |
| L-C-c | bump サブプロセスの deno.lock 書込み確認 | 極小 | 任意 |
| — | bump.ts の統合テスト（tmp git repo） | 中 | 任意 |
| B-4 | 長さ下位語の 2^50 超 precision コメント（対応不要が既定） | 極小 | 任意 |
| future-work | paths-info API による sha256 自動取得（.claude/future-work.md） | 中 | 要望発生時 |
