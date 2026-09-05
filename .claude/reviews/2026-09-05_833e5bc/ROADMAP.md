# ROADMAP — 再試行 + HF `expectedBytes` 上限（833e5bc）レビュー時点の見送り事項

前回（`.claude/reviews/2026-09-02_3b13d16/ROADMAP.md` と `2026-08-28_c91e955/ROADMAP.md`）の項目は
全て継続。ここは今回追加分。

## 優先度 中（設計・公開 API 追加 — 実利用のフィードバック待ち）

| ID | 内容 | 推定コスト | 着手タイミング |
| --- | --- | --- | --- |
| 2 の根治 | `fetchHfFiles` の並行度上限（`HfFetchOptions.concurrency?: number`、既定 = 無制限 = 現状）。429 を誘発する初回 fan-out そのものに効く。ADR 1 本 | 中（ADR + 実装 + テスト） | 並列取得で 429 が実際に観測されたら |
| 2(b) | opt-in の jitter（`RetryPolicy.jitter?: boolean` 既定 false。バックオフ由来の待機だけに equal jitter、`Math.min` の前・`Math.random` は DI） | 小 | 同上 |
| 3(b)/(c) | 汎用層だけの既定 `maxDelayMs` / 待機累計の上限 `maxTotalDelayMs` | 小〜中（ADR 0010 §2 の改定） | 任意 origin へ向ける利用者から長時間待機の報告が出たら |
| G3-04 | `onRetry` の context に HF の `path` を付ける（`HfRetryContext = RetryContext & { path?: string }`、`onProgress` と対称。revision 解決由来は `path` 無し） | 小（追加のみ） | `fetchHfFiles` でどのファイルの再試行か識別したい要望が出たら |
| G3-05 | `resolveHfRevision` の opts を名前付き公開型 `HfResolveOptions` にする（追加のみ・下流がラッパを書けるように） | 極小 | 次の HF 層 API 変更に同乗 |

## 優先度 低（内部品質・テストギャップ）

| ID | 内容 | 推定コスト |
| --- | --- | --- |
| G4-02 | テスト suite を Deno 2.8 以前でも緑に保つかを規約として決める。決めるなら `keys()` 依存 API を無条件に呼ぶ 4 件（`hf/mod.test.ts:1282`・`mod.test.ts:1634 / 1715 / 1779`）を feature-detect で揃える | 小 |
| G2-08 | 内部導管の `maxBytes` を `fetchBytesWithKey` / `prefetchUrlWithKey` の入口で形式検査（現状は HF の `toSpec` だけが守っている） | 極小 |
| G2-04 | 保険 delete の文言を `label` の先頭空白で組む構造をやめ、事由ごとに完成した句を持たせる | 極小 |
| G2-05 | `readBody` の位置引数 7 個を options オブジェクトへ（次に引数が増えるとき） | 小 |
| G1-09 | method 正規化 `(init?.method ?? "GET").toUpperCase()` の 3 か所重複を `retry.ts` の 1 関数へ | 極小 |
| G3-06 | `expectedBytes` の拒否文言「0 以上の整数」を判定条件（安全整数）に揃える（既存テスト 3 か所の文言照合も追従） | 極小 |
| G3-07 | 「prefetch は `into` を使わない」の 3 か所（JSDoc / README / limitations）に「容量検査だけは全入口で共通に走る」を添える（0.6.0 からの既存事項） | 極小 |
| G1-05 ①②⑤ | 待機完了時の abort リスナー解除 / 失敗応答の body 解放 / `maxDelayMs` が指数側にも効くこと、の凍結 | 小 |
| G4-07 | 未来の HTTP-date で正の待機になること（`3_500_000 < delayMs <= 3_600_000`） | 極小 |
