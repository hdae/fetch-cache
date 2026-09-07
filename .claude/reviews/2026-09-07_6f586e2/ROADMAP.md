# ROADMAP — 区間読み（6f586e2）レビュー時点の見送り事項

前回（`.claude/reviews/2026-09-05_833e5bc/ROADMAP.md`・`2026-09-02_3b13d16/ROADMAP.md`・`2026-08-28_c91e955/ROADMAP.md`）の項目は全て継続。うち G3-05（`HfResolveOptions`）は今回の `openHfFile` 追加で着手条件が満たされた → SUMMARY 要判断 4。G3-06 / G3-07 は該当箇所が `openHfFile` で 1 つずつ増えた（G2-11 / G2-12）。ここは今回追加分。

## 優先度 中（実測・設計 — 実利用フィードバック待ち）

| ID | 内容 | 推定コスト | 着手タイミング |
| --- | --- | --- | --- |
| 要判断 5 | `deno test --sanitize-resources` を deno.json の test task に常設し、赤になる既存テスト 16 本（Cache 応答の body 未消費、テスト側）を直す。常設後は `fetchBytes` / `prefetchUrl` 各経路の body 解放が横断的に縛られる | 小〜中（16 本の修正 + 1 行） | 0.8.0 リリース直後（要判断 5 で a) の場合） |
| G1-07 | ブラウザ実測: `caches.delete(name)` 後に保持していた Cache オブジェクトから `match` できるか（Chrome 152 で 10 行の HTML）。割れるなら limitations の clearCache 記述を確定形へ | 極小（ユーザーのブラウザが要る） | 次にブラウザで下流を動かすとき |
| G4-13 / ADR 0012 前提 | ブラウザ側の未実測項目: 0 バイトエントリの `body` が null か / `Blob.slice(...).arrayBuffer()` が本当に定数時間か（ADR は Chrome 152 の 1 点実測）| 小 | 同上 |
| G2-13 | `CachedEntry` に「何を開いたか」の識別情報（`url` / 配列キー / "blob" なら `size`）を持たせる。`HfPrefetchResult` と対称にする追加のみ | 小（ADR 0012 の追記） | 下流から要望が出たら |
| G2-05 後半 | エラー・通知の URL ラベルに sha256 が入らないため、同一 path で sha256 違いの 2 エントリが同じ文言になる。`CacheErrorContext.url` は URL 前提なので非 URL ラベルは契約破り — 別フィールド（`key`）を足す設計が要る | 小〜中 | 診断で困る報告が出たら |

## 優先度 低（内部品質・テストギャップ）

| ID | 内容 | 推定コスト |
| --- | --- | --- |
| G1-10 | `CachedEntry.read` の戻り型を `Uint8Array<ArrayBuffer>` まで絞る。`fetchBytes` の戻り型が `Uint8Array` のままなので、揃えるなら両方同時に（絞りは非 breaking） | 極小 |
| G1-11 | 範囲外エラー文言の `offset + length` は安全整数の和で桁落ちしうる（表示だけの問題） | 極小 |
| G1-08 | "stream" は本文長を知る前に `length` ぶんを確保する。小さいエントリへ巨大な `length` を投げると確保だけが先に走る（1-2 で match より前へ移すので資源は取らない。確保自体は残る） | — （仕様として明記済みで対応不要の見込み） |
| G3-22 | 偽 `CacheStorage` のボイラープレートが mod.test.ts / hf/mod.test.ts に 3 種ある。`src/testing/` に `spyCacheStorage` として畳む | 小 |
| G4-10 | 同じ事実（記録ハッシュの文字列比較・2 戦略の性格・非スナップショット）が JSDoc / README / ADR / limitations / CLAUDE.md の 5 か所に重複。将来のドリフト源。ADR を正としてほかは要点 + リンクに寄せる | 小 |
| body `== null` | `Response.body` が `undefined` になる旧ランタイム（Safari < 14.1・fetch polyfill）では `readBody`（0.7.0 既存）も `readFromStream` も `=== null` 判定を素通りして生の TypeError になる。対応するなら両方同時に | 極小 |
| G2-10 | `openHfFile` の sha256 未宣言エラーのテンプレートリテラルが 1 行 239 バイト（fmt は通る） | 極小 |
