# レビュー SUMMARY — v0.5.0 リリース前検品（c91e955）

- 実施日: 2026-08-28 / HEAD: c91e955（タグ v0.5.0 済み・未 publish）/ モード: フォーカス
  （ユーザー指示「利用者視点での使いやすさ・潜在的な問題。Opus と Codex Sol に同様のタスク」）
- 配分: **同一の 3 レンズ（DX / 新規変更の敵対検証 / リリース検品）を Opus（effort medium・
  Workflow 並列 3）と Codex Sol（gpt-5.6-sol・xhigh・並列 3）へ二重投球**（3+3）。
  検証パスはオーケストレータが主要指摘をコード読み + grep で反証チェック。
- 結果: **コード起因ブロッカー 1（B1・独立 2 系統一致）+ 文書の過大保証クラスタ（D 群）**。
  実装のコア不変条件（記録は検証済みバイトのみ・単射性・TOCTOU・公開境界）は両系統の敵対
  検証でも破れず。指摘の大半は「README/JSDoc が実装より広い保証を書いている」に集中。

## 検証パス評定（verdict）

| 指摘 | 系統 | verdict | 根拠 |
| --- | --- | --- | --- |
| B1: prefetch が delete → fetch の順で、取得失敗時に既存エントリを失う | opus-new-code(error) ≡ codex-new-code(warning) | **holds** | core.ts:893-894 実読。put は同一キー置換なので delete は不要、純粋に失敗窓 |
| D1: `evict(["hf",kind,repo])` は sha256 無しエントリに当たらないのに README が「repo 丸ごと解放」 | opus-dx(error) ≡ codex-dx(error) | **holds** | contentKey は sha 無しで undefined = URL キー。README:283/346 は過大 |
| D2: recheck の「無条件 self-heal」表現（合流者例外）+ HF 層 recheck の無言 no-op | codex-dx(error) + opus-dx(warning) | **holds（文書）** | 合流者経路は evict しない（limitations 明記済み・README:97-99 が過大）。hf/mod.ts:217 で sha 無しは黙って落とす（テストで凍結済みの意図挙動） |
| D3: core.ts:779 JSDoc が撤去済み `key` を案内（JSR に載る） | opus-release ≡ codex-dx ≡ codex-release（3 系統） | **holds** | grep 確認 |
| D4: 移行節の不足（管理 API シグネチャ変更 / verifiedMarker のケース分け / expectedBytes fail loud / prefetch は旧エントリ再DL / cacheName 分割の代替表現） | opus-release + codex-release | **holds** | 0.4.0 実装（f2fd9c8）と突合済み。JS 利用者の `clearCache("fetch-cache-hf")` が既定名前空間を消す静かな外れ方は実在 |
| D5: README 相対リンク 9 本が JSR 配布物で 404 | opus-release + codex-dx + codex-release | **holds（未実測）** | publish.include に docs/ 無し |
| codex-new-code#1: recheck × 記録不一致 short-circuit は契約違反 | codex | **refuted（error として）** | 「記録 ≠ 期待 = 内容が変わった → 真実源から取り直す」は ADR 0006 §2 / 0008 の裁定済み意味論で、判別テストが意図的に凍結。「実バイト一致・記録だけ別値」は正規経路から作れない状態。recheck JSDoc への 1 行明記は採用価値あり |
| codex-new-code#2: 正規化 URL を network にも渡す意味論変化 | codex（error）≡ opus-new-code（low） | **一部 holds（low）** | `<base href>` 相対解決差は実在（baseURI 基準へ 1 行修正で閉じる）。カスタム輸送 + fragment 有意 URL は極端ケース — 文書化で足りる |
| codex-new-code#4: leader sha 無し × 合流者 sha 有りで backfill されない | codex | **holds（low・影響過大評価）** | 恒久化には「常に並行」が必要。単独の検証付き読みで backfill される |
| codex-new-code#5: 非正規 JSON（`1e0`）が消せない幽霊キーになる | codex | **holds（low）** | round-trip 検査（serializeKey(復元) === url）2 行で閉じる |
| opus-new-code#2: backfill put が並行 evict/prefetch を巻き戻す | opus | **holds（low〜warning）** | 正しさは破れない（新しさのみ）。clearCache（名前空間 delete）への巻き戻しは実装依存で uncertain。limitations 記載 + put 前 re-match で窓を畳める |
| codex-dx#5: hubUrl 末尾 `/` で二重スラッシュ URL | codex | **holds（low）** | 生連結を確認。正規化 1 行 or JSDoc |
| codex-release#L4: ADR 0008 の「0.4.0 の cacheKey」記述が事実誤り | codex | **holds** | cacheKey:string は未リリース draft（archive）。ADR の文言修正 |
| codex-dx#7: サンプルの `"1a2b…"` が動かない | codex | **refuted（実質）** | 省略記法のプレースホルダ（一般的な README 慣行）。MODEL_FILES の擬似定義注記は任意 |
| -0 直列化衝突（再掲） | codex | **refuted（前回済み）** | −0===0 で誤配は構成不能（CORE-013 🔵 のまま） |

## 修正セット（裁定対象）

### B1（コード・publish 前必須）: prefetch の先行 delete を撤去 — `src/core.ts:893-894`
put は同一キーを置換するため delete は不要。現状は delete 後の fetch/put 失敗で温め済み資産
（数 GB）を失い、オフライン起動（下流の主用途）を壊す。**2 行削除 + 「503 で既存エントリが
残る」凍結テスト 1 本**。既存テストは最終状態のみを見るため緑のまま（Opus 分析・要 check）。

### C 群（コード・小粒、同梱推奨）
- C1: `hubUrl` 末尾 `/` の正規化（hfResolveUrl / resolveHfRevision の 2 連結点）
- C2: `deserializeKey` に round-trip 検査（幽霊キー根絶・fail loud 契約の完全化）
- C3: `normalizeUrl` の基底を `document.baseURI ?? location.href` に（`<base>` ページの相対 URL）
- C5: `./hf` から `FetchProgress` / `CacheErrorContext` / `ValidateBytes` / `DecodeBytes` を
  型再公開（両系統・両レンズが指摘した導線切れ。非破壊）

### D 群（文書・publish 前必須）
- D1: sha256 無し HF エントリの掃除は `listCachedUrls` + `evictUrl` レシピへ（README 2 箇所 +
  limitations 1 項）
- D2: recheck の保証を leader/ヒット経路に限定 + HF 層「sha256 宣言ファイル限定」明記
  （+ recheck JSDoc に「記録不一致は再ハッシュせず取り直す」1 行）
- D3: core.ts:779 の `key` 文言修正
- D4: 移行節増補（管理 API before/after・verifiedMarker 3 ケース・expectedBytes fail loud・
  prefetch は旧エントリを再 DL・cacheName 分割は caches DI ラッパで代替可と明記）
- D5: README の docs/ リンクを GitHub 絶対 URL 化
- D6: 小粒一括 — clearCache「Everything at once」注記 / backfill の N バイト再 put コスト
  （known-issues の Deno orphan にも接続）/ 可変 ref はキャッシュ済みでも解決 network 1 回
  （オフライン運用は SHA 永続化）/ prefetch サンプルの spec コメント / Runtime 表に prefetch
  throw / ADR 0008 の cacheKey 記述訂正 / ADR 0006 Consequences:147 の backfill 追従 /
  deno.json に description
- 見送り（0.6.0 / ROADMAP）: backfill TOCTOU の窓縮小（limitations 記載のみ今回）/ 合流者
  backfill / has-open 競合 / 読み出し側 materialize 上限の注記強化 / 予約 origin 旧エントリ

## 🟢 両系統一致の健全性確認（要点）

version/タグ/CI/OIDC の整合・semver（0.x minor）妥当・exports 境界（core.ts 到達不能・
内部導管漏れなし・公開型再公開漏れなし・明示戻り値型）・0.4.0 残骸との遭遇は全経路安全側
（URL キー継続ヒット・旧ヘッダ不信 + backfill・旧名前空間は孤立のみ）・記録の不変条件
（検証済みバイトにのみ付与）は両系統の敵対検証でも構成不能・sha256 宣言系ユースケース
（本命）の README ↔ 実装一致。

## 実施記録
- Opus: Workflow wf_7f3a3aa7-fc1（3 並列・395k tokens・8 分）。Codex: gpt-5.6-sol xhigh ×3
  （--sandbox danger-full-access はユーザー承認済み・読み取り専用指示）。
- 全指摘の採否はオーナー裁定待ち。タグ v0.5.0 は修正採用時に切り直しが必要（未 push）。
