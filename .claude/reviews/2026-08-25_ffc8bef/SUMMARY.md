# レビュー SUMMARY — v0.4.0..HEAD（ffc8bef「キャッシュ制御 API 再設計」）

- 実施日: 2026-08-25 / HEAD: ffc8bef / モード: A（差分・ユーザー指示「念の為 v0.4.0 以降をレビュー。Opus + Codex 併用」）
- 配分: Opus 3 レンズ並列（core / hf-api / tests、いずれも読み取り専用・実測込み）+ **Codex CLI 独立レビュー**
  （codex-cli 0.147.0、`--sandbox danger-full-access`。入れ子サンドボックスで bwrap が死ぬため
  Codex 側サンドボックス無効はユーザー承認済み）。検証パスはオーケストレータが要所見を反証チェック
  （CORE-001 は自前再現スクリプト、他はコード読みで突合）。
- 結果: **🔴 0 / 🟠 1 / 🟡 実質 13（重複統合後）/ 🔵 多数**。リリースブロッカーは無いが、
  「リリース前が最安の修正」が数件。
- **重要な文脈**: 本レビューと並行して「sha256 有無で戦略を完全分離する再設計（Design R、
  ほぼリブート）」の採否検討が走っている（scratchpad/design-brief-two-mode.md）。**R 採用なら
  配列キー機構ごと消える指摘が複数ある**ため、裁定は設計フォーク確定後に行う（各項に R での帰趨を付記）。

## 検証パスの評定（verdict）

| 指摘 | verdict | 根拠 |
| --- | --- | --- |
| CORE-001（origin ガード大文字すり抜け） | **holds** | オーケストレータが独立再現（配列キー `["a"]` を `[9,9]` へ上書き）。Codex も独立検出 + inflight キー正規化不一致の追加角度 |
| CORE-002 ≡ HF-05 ≡ Codex#3（記録不一致ヒットの全量読出し+全量ハッシュ） | **holds** | 独立 3 系統が同一指摘。mod.ts:506-509 で trust 判定前の無条件 materialize を確認 |
| TS-001（--parallel 無限ハング） | **holds** | hf/mod.test.ts:448-453 の期限なしポーリング × 固定名前空間共有。エージェント実測（7 分 pending・2 ファイル並列 14 failed） |
| HF-01 / HF-02 ≡ Codex#4 | **holds** | オーケストレータが hf/mod.ts 全文読みで突合（resolve → toSpec の順、JSDoc の無条件断定） |
| Codex 新規 2 件（CX-01 validate 改変 / CX-02 保険 delete 黙殺） | **holds** | mod.ts:431 / :899 をコードで確認 |
| Codex の -0 を error とする主張 | **refuted（過大評価）** | `-0 === 0` で別内容の誤ヒットは作れない。CORE-013（🔵・記述で足りる）を正とする |
| TS-002〜009 ほかテストギャップ | **holds** | tests レンズが判別性まで実測（TS-002 は判別可能な変形も実証済み） |

## 🟠 Error（1 件）

### 1. テストを `--parallel` で走らせると赤ではなく無限ハングする [🟠/テスト基盤] — TS-001
**概要**: 両テストファイルが固定名前空間 `"fetch-cache"` を共有し、hf 側の同期待ち
（hf/mod.test.ts:448-453）が期限なしポーリング。他ファイルの `caches.delete` が割り込むと永久に
抜けない。`deno task check` は逐次なので現在は顕在化しない（139 緑は正）。
**修正案**: ① ポーリングに 2 秒 deadline（ハング→明示失敗化。アサーション変更なし）
② `--parallel` 禁止を deno.json / CLAUDE.md に明記 + ADR 0006 の「ファイル内逐次」を
「ファイル間も逐次」へ訂正。③（任意）caches DI ラッパで共有面積縮小。
**R での帰趨**: 残る（隔離規約はどちらの設計でも同じ）。①② は設計と無関係に実施可。
**対象**: src/hf/mod.test.ts:443-482 / deno.json / docs/decisions/0006:149-151

## 🟡 Warning（重複統合後 13 件）

### 2. 予約 origin ガードが大文字表記をすり抜け、配列キーのエントリを読み書きできる — CORE-001（+Codex）
`assertNotReservedOrigin` が生 `startsWith`。`HTTPS://FETCH-CACHE.INVALID/...` が素通りし Cache API
正規化で配列キー空間に到達（読み=誤配 / 書き=上書き / listKeys 恒久 throw / 不可視残骸の 4 実害、実測済み）。
逆に `fetch-cache.invalid.example.com` は過剰拒否。Codex 追加角度: single-flight の join キーが
正規化前文字列のため、表記違いで「同一エントリ・別フライト」の二重 DL も起きる。
**修正案**: 入口で `new URL(url)` に通し正規化済み href を storage/inflight 双方に使い、予約判定は
`origin === KEY_ORIGIN` に（listCachedUrls の除外述語も同一関数へ）。
**R での帰趨**: 残る（R も予約 origin を使う）。**どちらの設計でも要修正**。
**対象**: src/mod.ts:228-235 / :604 / :769 / :928 / :1042

### 3. 記録ハッシュ不一致のヒットで全量読出し + 全量ハッシュしてから self-heal — CORE-002 ≡ HF-05（+Codex#3）
ADR 0006 §2 は「不一致 → 文字列比較のみで self-heal」だが、実装は materialize → 再ハッシュ。
数 GB × 安定キー切替で顕著（2GiB 超は arrayBuffer() 自体が落ち誤った縮退通知になる）。さらに
「記録≠期待だが実バイト=期待」の隅ケースでは記録未修復のままヒットを返し、以後毎回再ハッシュ。
**修正案**: match 直後に記録で short-circuit（cached.body.cancel() → evict → network）。
既存 ping-pong テストは判別不能（Codex 指摘: 記録だけ違い実バイト一致のエントリで凍結し直す）。
**R での帰趨**: **構造的に消滅**（Mode A はキー = ハッシュが記録そのもの。ヘッダ記録機構ごと不要）。
**対象**: src/mod.ts:503-536 / :418-433

### 4. single-flight 合流者経路に self-heal が無い（JSDoc は無条件と記述） — CORE-003
検証条件の違う並行呼び出しで、合流者の検証失敗が evict なしの素 throw。0.4.0 から同型・sha256
一級化で現実味が増した。**修正案**: JSDoc + limitations へ「self-heal は leader 経路のみ」を明記
（コードで塞ぐとスラッシングの裁定が要るため文書推奨）。**R での帰趨**: 残る（合流機構は共通）。
**対象**: src/mod.ts:663-674 / :575-577

### 5. prefetchUrl が記録ハッシュを見ず、安定キーの陳腐化エントリを streaming 経路から更新できない — CORE-004
既存エントリ検査が有無のみ。2GiB 超 × 安定キーでは fetchBytes 側 self-heal が成立しないため
evict 手動介入が必須になる。**修正案**: 既存検査に記録突合を 1 ヘッダ分追加（不一致なら delete して温め直し）。
**R での帰趨**: **消滅**（Mode A の prefetch はハッシュキーの有無 = 完全一致検査）。
**対象**: src/mod.ts:802-808

### 6. prefetch の JSDoc「温めたエントリはそのままヒット」が sha256 無し spec で不成立 — HF-01
revision bump を挟むと丸ごと miss + 孤児。v0.4.0 にあった「戻り値 revision を読みへ渡せ」の
注意書きが削除されている。**修正案**: JSDoc 復活（sha256 無し条件付き・実装変更なし）。
**R での帰趨**: 残る（Mode B1 = SHA 固定 URL キーの性質そのもの）。
**対象**: src/hf/mod.ts:296-322 / :286-294

### 7. toSpec の fail loud が revision 解決の後 — HF-02 ≡ Codex#4
「network に出る前に throw」の JSDoc に反し、可変 ref で解決 API 1 発 + fetchHfFiles では兄弟
ファイルの DL 開始まで漏れる。**修正案**: 3 入口で toSpec を resolve の await より前へ（行移動のみ）。
**R での帰趨**: 残る（HF 層の入口順序の問題）。**どちらでも要修正**。
**対象**: src/hf/mod.ts:263-273 / :323-346 / :352-373

### 8. HF エントリの掃除導線が公開 API に無い — HF-03
既定キー式が private・sha256 無しは URL キーで evict 射程外、の 2 分裂。**修正案**: 最小 = docs
明記。任意 = `hfCacheKey` export。**R での帰趨**: 形を変えて残る（R は listCached メタデータ設計に
吸収される — 設計検討の論点に含め済み）。
**対象**: src/hf/mod.ts:208-212

### 9. 管理 API 5 本に caches DI が無い — HF-04 ≡ CORE-009
DI した CacheStorage のエントリは列挙も削除もできない。追加は非破壊だが 0.5.0 前が最安。
**R での帰趨**: 残る（管理 API の形は変わるが DI 非対称は同型）。
**対象**: src/mod.ts:926-1043

### 10. validate が受け取る raw を改変すると記録ハッシュと保存内容が乖離する — CX-01（Codex 新規）
ハッシュ計算 → 同一配列を validate へ → そのまま格納、の順。同期改変で「記録付きの不正エントリ」
が正規経路から作れる。**修正案**: ValidateBytes の JSDoc に非破壊 MUST（decode の自己デッドロック
MUST NOT と同じ流儀。コピー隔離は数 GB でコスト過大なので不採用を明記）。
**R での帰趨**: Mode A では記録ヘッダ自体が消えるが「キーと実体の乖離」として同型に残る → 文書は必要。
**対象**: src/mod.ts:418-433 / ValidateBytes JSDoc

### 11. prefetch 保険 delete の失敗黙殺で汚染エントリが trust されたまま残り得る — CX-02（Codex 新規）
`.catch(() => {})`。二重故障（非準拠 put 成功 + delete 失敗）の条件付きだが、帰結が「無言の誤配」
で fail loudly に反する。**修正案**: delete 失敗を integrityError の cause / suppressed に載せて
通知（黙殺をやめる 2 行）。**R での帰趨**: 残る（保険 delete は共通機構）。
**対象**: src/mod.ts:896-901

### 12〜14. テストギャップ主要 3 件 — TS-002 / TS-005 / TS-008
② expectedBytes 優先順位テストが判別不能（実質トートロジー・判別可能な変形を実証済み）
⑤ 旧ヘッダ `x-fetch-cache-verified` を読まないこと（安全側の意味論・破壊的移行の中核）が未凍結
⑧ hubUrl 非含有（ミラー跨ぎ）と kind の寄与が未凍結。
他 TS-003（可逆性）/ TS-004（記録を書き足さない）/ TS-006（crypto.subtle 不在）/ TS-007（keys()
fail loud が常時 ignored 1 本のみ = 「1 ignored」の正体）/ TS-009（fetchBytes 転送中断）。
**R での帰趨**: TS-003 は消滅、TS-004 は形を変える、他は残る。

## 🔵 Low（抜粋 — 詳細は findings/）

CORE-005 deserializeKey 型未検査（Codex 同指摘）/ CORE-006 エラー生成の二次 throw / CORE-007
recheck×cache:false の非対称 / CORE-008 sha 不一致エラーに URL 無し / CORE-010 bump 未実施（既知）/
CORE-011 コメント根拠誤り 2 箇所 / CORE-013 -0 潰れ（Codex の error 評価は refuted）/ HF-06〜11
（JSDoc 追従・resolveHfRevision の生 SyntaxError・repo 無エンコード・型再エクスポート・CLAUDE.md
テスト規約未追従・DECIDED ポインタ先未整備）/ TS-010〜014 / Codex low（進捗二重通知・HF
expectedBytes 二重用途 JSDoc・crypto.subtle 必須は fetch 系のみ）。

## 🟢 確認済みの健全性（要点）

キー直列化の単射・可逆・URL 正規化不変（13 パターン実測）/ prefix セグメント境界 / ガード順序
（両入口とも network 前完結）/ ADR 0007 文言一致 / 記録ハッシュ焼き条件（上流ヘッダ詐称不能）/
single-flight 故障形 6 種の潰し込み（自己デッドロックのみ既知・文書済み）/ 保険 delete のキー側
固定（旧 TS-002 解消）/ 旧 API 残骸ゼロ / defaultKey 一点実装による 3 API キー一致の構造保証 /
HF 既定キー配下の記録必在 / golden ヘルパの実装独立性 / trust 意味論の外形凍結（TS-016）。

## 裁定の進め方（要判断は保留中）

**全指摘の採否は Design R（二戦略分離リブート）の採否とセットで裁定する。** R 採用なら 3・5・
TS-003 等は消滅し、修正対象は「R に持ち越す共通部品」（1・2・4・7・10・11 と隔離規約）に絞られる。
現行維持なら上記 🟡 を 0.5.0 リリース前に採否裁定（いずれも小粒・ブロッカー無し）。
設計検討の結果は別途報告（scratchpad/design-brief-two-mode.md + Workflow two-mode-design-study）。
