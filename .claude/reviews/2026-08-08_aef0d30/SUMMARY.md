---
title: リリース前レビュー — v0.3.1..HEAD 未リリース差分（streaming prefetch / 検証済みマーカー / 純 TS SHA-256 / prefetchHfFile）
date: 2026-08-08
head: aef0d30
prev_review: 2026-07-10_b5ccf62
mode: A（差分 + テスト品質横断 + 全域薄 + リリース準備）
reviewer: Claude (orchestrator: fable / finders: opus×3 + sonnet×3 / verifiers: opus×3)
---

# SUMMARY — 2026-08-08 @ aef0d30

## 結果ダイジェスト

**リリースブロッカー（🟠E / 🔴C）: 0 件。** 実装バグは A-1（prefetch の通過中検証のみ・自傷シナリオ限定）の 1 件で、他はすべて「実装は正しいが凍結（テスト/文書）が無い」型。中核不変条件（依存ゼロ / fail loud の 2 縮退経路 / 公開 API 互換 / ネットワーク非依存テスト / hf→cache 一方向依存）はすべて成立を確認。`deno task check` 全緑（110 passed / 0 failed / 1 ignored）。

- 指摘: 最終 🟡W 7 / 🔵L 8（Pass2 で 降格 4・取り下げ 2）。needs-human の設計判断 1 件（C-3）。
- **最優先の要判断: A-1**（ADR 0005 §5 の中核主張「不正な印付きエントリが構造的に生まれない」が公開 API のみで反証された — 根治は数行）。
- semver 判定: 追加 export（`prefetchUrl` / `PrefetchUrlOptions` / `prefetchHfFile` / `HfPrefetchOptions`）+ optional フィールド追加のみ = **minor（0.4.0）**。version は 0.3.1 のまま未 bump（F-2）。

## 要判断（ユーザー裁定待ち）

### カテゴリ1: 実装修正（唯一のコード挙動変更）

#### A-1 — prefetch の通過中検証が「チャンクは update 後に書き換わらない」暗黙不変条件に依存【W・要判断①】

- **概要**: `prefetchUrl` は `hasher.update(chunk)` した同一の Uint8Array インスタンスをそのまま `controller.enqueue` して `cache.put` へ渡す。呼び出し側が自前の `fetch` 実装や `onProgress` コールバック経由でチャンクへの参照を保持し、update 後に書き換えると「印（検証済みマーカー）付きなのに中身がハッシュと違うエントリ」が成立する。印は以後の検証を丸ごと省かせるため self-heal では回復せず恒久化する。**Pass2 で実証済み**: 公開 API のみ（fetch DI + onProgress の同期窓での書き換え）で乖離エントリの作成に成功（verifier V1 probe A-1c: marker=b8f12ea8… / 実内容 sha=3dc30fba…）。`fetchBytes` 側は validate と put が同一バッファに当たるため、この穴は prefetch 固有（V1 probe A-1b で確認）。
- **修正案**:
  - **★案1（根治）**: sha256 指定時のみ transform 内で `const copy = chunk.slice()` を取り、hash と enqueue の両方に copy を使う。呼び出し側は copy への参照を持てないため、ハッシュ対象と格納対象の同一性が構造的に保証され、ADR の主張が真になる。コスト = チャンク 1 個ぶんの memcpy/確保（ピークヒープはチャンク数個のまま。prefetch は回線律速なので CPU 影響なし）。sha256 未指定時は印が無く乖離が無害なのでコピー不要。
  - 案2（文書のみ）: `PrefetchUrlOptions.fetch` **と** `onProgress` の JSDoc に「通過中検証対象のチャンクを update 後に書き換えてはならない（MUST NOT）」を明記 + ADR 0005 §5 に但し書き。挙動不変・コスト 0 だが、実証済みの欠陥を温存する（`decode` の同種 MUST NOT（ADR 0003）に前例はある）。
  - 案3: 現状維持（非推奨 — ADR の中核主張が偽のまま出荷される）。
- **リスク**: 案1 は挙動変更だが「壊れるのは悪用コードだけ」（正当な呼び出しはバイト列同一）。案2 は文書が CI で守られない。
- **対象**: [src/mod.ts:628-646](../../..//src/mod.ts)
- **影響範囲**: prefetch + sha256 経路のみ。既定経路・fetchBytes・公開 API シグネチャは不変。
- **引き継ぎ**: transform 内 `hasher.update(chunk)` の前に copy を取り `hasher.update(copy)` → `controller.enqueue(copy)`。emit（進捗）は copy でなく元 chunk の byteLength を読めばよい。凍結テスト: V1 probe A-1c と同型（onProgress で書き換え）→ 案1 適用後は「印と中身が一致する」or「不一致 throw」のどちらかしか起きないことを assert。
- **裁定**: 案1 / 案2 / 案3

### カテゴリ2: API 形状（未リリースの今が最後の変更機会）

#### C-3 — `prefetchHfFile` の戻り値が boolean のみで、解決した revision を返さない【W・要判断②】

- **概要**: 可変 ref（"main" 等）のまま prefetch すると、どの SHA を温めたかを呼び出し側が知る手段が無い。温めと読み出しの間に upstream が動くと fetchHfFile は別 SHA の URL を引き、キャッシュ丸ごとミス + 孤児エントリが残る（Pass2 で実挙動を再現確認）。回避策（`resolveHfRevision` で 1 回解決 → SHA を `revision` に渡す）は公開 API として実在し、JSDoc / README が明示的に誘導済み。prefetchHfFile は未リリースなので、戻り値を `{fetched, revision, url}` 等へ変えられるのは今だけ。
- **修正案**: **★案1: boolean のまま出荷**（根拠: ① `prefetchUrl` と戻り値対称 ② 回避策が公式手順として文書化済みで、object を返しても呼び出し側が revision を使い回さなければ同じ穴に落ちる — 実効性は結局規律に依存 ③ 将来必要になったら別名 API 追加で非破壊拡張できるため不可逆性は低い）/ 案2: `{fetched, revision, url}` へ変更（テスト 5 箇所 + README 例の更新のみ・破壊コストは今ゼロ）。
- **リスク**: 案1 は将来の変更が breaking になる（ただし追加 API での回避可）。案2 は prefetchUrl と非対称になる。
- **対象**: [src/hf/mod.ts:305-327](../../../src/hf/mod.ts)
- **影響範囲**: 未リリース API のみ。下流（yomi / sbv2-web）は 0.3.1 に存在しない API のため参照不能（Pass2 で git tag --contains により確認）。
- **裁定**: 案1 / 案2

### カテゴリ3: ガード・テスト・文書の補完（判断不要に近い明確な不足 — 一括承認可）

#### C-1 — sha256 の形式ガードが fetch 経路に無い【W・要判断③の一部】

- **概要**: `prefetchUrl` は形式不正（大文字 hex 等）を network 前に throw するが、`fetchHfFile` / `fetchHfFiles` は検証せず「全量 DL → 不一致 throw」を毎呼び出し繰り返す（数 GB 級では呼ぶ度に帯域を捨てる。Pass2 で再現: 呼ぶ度に network 取得が 1 回ずつ増える）。sha256Hex の出力は常に小文字 hex なので「動いていた大文字 hex 申告」は存在し得ず、`toSpec` への regex ガード追加は成功経路を 1 件も壊さない（throw の時刻とメッセージが変わるだけ）。
- **修正案**: ★`toSpec`（全入口の正規化点）に `prefetchUrl` と同じ `/^[0-9a-f]{64}$/` ガード + HF 層テスト（fetch/prefetch 両経路で network 前 throw を凍結）。
- **対象**: [src/hf/mod.ts:252-253](../../../src/hf/mod.ts)。留意: toSpec は revision 解決の後に呼ばれるため解決リクエスト 1 本は出る（実害僅少・許容）。

#### D-1 / A-2 — 保険 delete 分岐（ADR 0005 §5 の最後の砦）が未テスト【W】

- **概要**: sha256 不一致時に put が誤って resolve する非準拠 Cache 実装に備えた保険（delete → throw、[src/mod.ts:660-665](../../../src/mod.ts)）が deno coverage 実測で 0 回実行。壊れると「印付き汚染の恒久化」なのに気付けない。Pass2 で到達手順を実証済み（fake put は**必ず body を消費してから resolve** する形が必須 — 消費しないと flush が走らず分岐に入らない）。
- **修正案**: ★テスト 1 本追加（約 20 行、既存 failingCacheStorage と同型の DI。assertRejects で不一致エラー + cache.match undefined を assert）。

#### D-2 — `expectedBytes` 不正値ガードが未テスト【W】

- **概要**: `allocateHint` の入口ガード（[src/mod.ts:157](../../../src/mod.ts)、非整数・0 以下 → 蓄積経路へ縮退）が coverage 0 回。既存の巨大申告テストは RangeError 側（:161）を踏んでおり別分岐（lcov 生値で確認済み: DA:157,0）。壊れると「申告が外れても取得は落とさない」という limitations の by-design 契約が破れる。
- **修正案**: ★expectedBytes に 1.5 / -1（と 0）を渡して「取得が落ちず内容が正しい」を assert する既存同型テストの追加。

#### B-1 — SHA-256 長さフィールド上位 32bit（>512MiB）が未凍結【W】

- **概要**: 総入力長のビット長 encode の上位語（[src/sha256.ts:156](../../../src/sha256.ts)）が非ゼロになるのは 512MiB 以上のみで、テスト最大は 100003 バイト。「上位語を 0 に落とす」変異が既存 4 テストを全部生存通過（Pass2 で独立再現）。本命ワークロード（数 GB モデル）が必ず踏む領域に回帰検出力が無い。実装自体は正しい（native / node crypto と 512MiB+1 等で一致を二重に実証済み）。
- **修正案**: ★64KiB パターン使い回しの 512MiB+1 golden vector テスト（golden はハードコード: `54bebaf76af865fe6c1ad7e980aeaef4b43d0a8685785a6b2091575bc06f82ed`。実測 2.4s / ピーク RAM 64KiB — 既存テスト NOTE の省略理由「~600MB の RAM」は実測で崩れているため NOTE も追従修正）。

#### B-2 — `update()` の非保持契約が未文書・未凍結【W→L 降格】

- **概要**: `prefetchUrl` は update 直後に同一チャンクを enqueue しており（transfer/detach されうる）、update の「呼び出し後にチャンクを保持しない」性質が load-bearing なのに契約化されていない。現実装の非保持性は Pass2 で実証済み。
- **修正案**: ★JSDoc に MUST 明記 + retain テスト（update 後に元配列を fill(0xaa) → hex() が native と一致、12 行・非トートロジー）+ [src/mod.ts:632-634](../../../src/mod.ts) 側に WHY 一行。（A-1 案1 採用時は enqueue 側が copy になるため WHY の文面を合わせること）

#### 文書修正パッケージ【A-3 縮小 / C-2 残余 / C-5 / E-2 / B-3】

- **A-3（縮小）**: limitations.md:10-13 の「合流者で使われないオプション」列挙に `verifiedMarker` / `expectedBytes` を追加 + fetchBytes JSDoc の同列挙（src/mod.ts:403-405）も同時修正（片方だけだと乖離）。読み出し側（合流者は印を見ない）は既に明文化済みのため書かない。
- **C-2（残余のみ）**: 「`prefetchHfFile` は spec.expectedBytes / spec.validate を受け取っても使わない」の一文を JSDoc + limitations.md へ（元指摘の「JSDoc が誤り」は Pass2 で棄却 — 記述自体は正しい）。
- **C-5**: sha256Hex のコメント「全量コピーしない」を実態（WebCrypto 仕様上 digest は内部コピーを取るため 3N→2N の削減。W3C 仕様文言 + RSS 実測で確認済み）へ修正。コードは正しいので不変。
- **E-2**: README の verifiedMarker 例の表記ゆれ（prefix 有無）を統一。
- **B-3**: schedule スクラッチ共有が安全な理由（compress が毎回全上書き）のコメント一行。

### カテゴリ4: リリース手順

#### F-2 — version 未 bump【W・手順】

- **概要**: deno.json / src/mod.ts とも 0.3.1 のまま。このまま v0.3.1 タグを切ると verify_tag の三者一致は通ってしまう。追加 API のみなので **minor（0.4.0）が正**。
- **修正案**: ★修正パッケージ確定後に `deno task bump minor` → タグ → push（push はユーザー）。

## 実施済み指摘の記録（2026-08-08 裁定 → 同日実装）

裁定: A-1=案1（根治）/ C-3=案2（object 化。「object 方針で検討し、価値が薄ければ boolean」の
条件付き承認 → 検討の結果採用）/ 補完パッケージ=一括実施 / リリース=タグ作成まで。

| ID | 実装 | commit | 検証 |
| --- | --- | --- | --- |
| A-1 | sha256 指定時のみチャンク複製をハッシュ・格納で共有（構造的封じ） | 3378723 | 凍結テストの fault injection 実施 — 修正なしで失敗・ありで成功を確認 |
| C-3 | `HfPrefetchResult { fetched, revision, url }` へ変更 + revision 渡し回しの対比テスト | d632239 | upstream 移動シナリオをテストで凍結 |
| C-1 | `toSpec` に 64 桁小文字 hex ガード + fetch/prefetch 両経路テスト | 77c385b | calls.length === 0 で network 前 throw を凍結 |
| D-1 / D-2 / B-1 / B-2 | 保険 delete 分岐・expectedBytes 不正値・512MiB golden・retain テスト | f65aeff | 保険分岐 lcov 0→1 回 / ガード行到達を lcov 生値で確認。**golden は `4e00324d…`（パターン: 64KiB 内 `index % 251` ×8192 + 1B）— SUMMARY 上記 B-1 の `54bebaf7…` は検証エージェントの別パターン由来で、実装では 2 系統の native（crypto.subtle / node:crypto）+ オーケストレータの独立再導出で `4e00324d…` を確定** |
| A-3 縮小 / C-2 残余 / C-5 / E-2 / B-3 / ADR 追従 | docs / JSDoc / コメント追従一式 + レビュー成果物の git 管理化 | 72f2c5d | 突合読了。追加ドリフト 1 件（limitations の prefetchHfFile 戻り値表記）を発見しフォロー修正 |

- 変異試験の残項目: B-1 / B-2 の変異生存試験は実装エージェントの環境では権限ブロックで未実施（到達性は lcov で確認済み。B-1 の変異検出力は Pass2 検証エージェントが別パターンで実証済み）。
- `deno task check`: 全コミットで全緑（最終 118 passed / 0 failed / 1 ignored）。

## 取り下げ・棄却（Pass2 反証）

| ID | 内容 | 反証根拠 |
| --- | --- | --- |
| A-L2 | content-length を確保サイズに信頼する新しい面 | limitations.md:24-27 に by-design 明記済みの重複指摘。実測でも RSS 増分ほぼ 0（遅延ゼロページ）・RangeError は縮退で吸収 |
| C-2 本体 | JSDoc「expectedBytes は実質包含」が誤りという主張 | 当該 NOTE は sha256 指定時に条件づけられた文で誤りではない。無検証格納の事実も limitations.md:28-35 でカバー済み（残余のみカテゴリ3へ） |
| A-3 読み出し側 | 合流者が印を見ないことが未文書という主張 | limitations.md:48-49 と ADR 0005:92 に明記済み（書き込み側のみ残存） |

## L（対応任意・記録のみ）

- **A-L1**: prefetchUrl の open/match 失敗だけ生エラーが漏れる（fail loud は満たす。ラップすると既存テストのメッセージ期待の変更が絡むため見送り可 → ROADMAP）。
- **B-4**: 長さ下位語が 2^50 バイト超で double 精度を失う（1 PiB — 到達不能。対応不要）。
- **C-4（縮小）**: encode 契約は共有ユニットの既存テストで実質凍結済み。残る価値は「非 ASCII path の prefetch → fetch ヒット」統合 1 本のみ（採用任意）。
- **E-1**: ADR 0005 のベンチ数値 3 件は unverifiable とされたが、Pass2 実測が実質裏付け（512MiB 純 TS 2.42s ≈ 217MB/s vs ADR 記載 212MB/s、RSS 挙動も再現）。対応不要。
- **F-1**: sha256.ts が publish 物に同梱される（exports に出ないため公開 API 非露出。現状維持が妥当）。

## 実施概要

- **モード**: A（差分基点 v0.3.1..HEAD = 6 コミット・+1,892 行）。findings 6 グループ → Pass2 敵対的検証 3 本。
- **Pass2 実施根拠**: src/mod.ts に W 3 件集中・needs-human 4 件。
- **モデル配分**: finders = Opus 5 medium ×3（cache 層 / sha256 / HF 層）+ Sonnet 5 medium ×3（テスト品質 / docs 突合 / リリース準備）。verifiers = Opus 5 medium ×3（反証指向・scratchpad での実験許可）。計 601k + 228k tokens。
- **CI 状況**: レビュー開始時・終了時とも `deno task check` 全緑（110 passed / 0 failed / 1 ignored）。
- **検証の質**: verifier は再現実験を伴う評定を返した（A-1 の乖離エントリ実作成、C-1/C-3 の mock 再現、B-1 の変異試験再現、D-1/D-2 の lcov 生値確認）。「実測に基づく」と報告された finder 所見はすべて独立再現された。

## グループ別レポート表

| Group | 担当 | model | findings | 結果（Pass2 反映後） |
| --- | --- | --- | --- | --- |
| A | cache 層（src/mod.ts） | opus | findings/group-A-cache.md | W2（A-1, A-2）+ 縮小 W→docs 1（A-3）+ L1 + 取り下げ 1 |
| B | 純 TS SHA-256 | opus | findings/group-B-sha256.md | W1（B-1）+ L3（B-2 降格含む） |
| C | HF 層 | opus | findings/group-C-hf.md | W2（C-1, C-3）+ L3（C-2 残余 / C-4 降格 / C-5） |
| D | テスト品質横断 | sonnet | findings/group-D-tests.md | W2（D-1, D-2） |
| E | docs 突合 | sonnet | findings/group-E-docs.md | L2（E-1, E-2）。突合: README/CLAUDE.md/limitations/ADR 全て実装一致 |
| F | リリース準備 + 全域薄 | sonnet | findings/group-F-release.md | W1（F-2 = bump 手順）+ L1。scripts/CI/deno.json は v0.3.1..HEAD 無変更で前回分類維持 |

## 過去レビュー（2026-07-10_b5ccf62）からの進捗

- E-A-1（single-flight）: 0.3.0 で実装済み。本差分でも合流契約は不変（Pass2 で TOCTOU / self-deadlock / lost wakeup を個別に棄却。prefetchUrl は inflight に触れず自己合流も無し）。**解消確認**。
- W-C-4（Actions SHA pin）: ユーザー判断による先送りのまま（横断対応時）。
- L-C-c / bump 統合テスト: 未着手のまま（小・任意 → ROADMAP 維持）。

## アクションアイテム（裁定後の実施計画・コミット分割案）

1. `fix(cache)`: A-1 根治（採用時）— hash/enqueue の copy 共有化 + 凍結テスト
2. `fix(hf)`: C-1 — toSpec の sha256 形式ガード + 両経路テスト
3. `test`: D-1（保険 delete 分岐）+ D-2（expectedBytes 不正値）+ B-1（512MiB golden）+ B-2（retain）
4. `docs`: A-3 縮小 + C-2 残余 + C-5 + E-2 + B-3 + ADR 0005 追従（A-1 の帰結を §5 に追記）
5. `chore(release)`: `deno task bump minor`（0.4.0）→ タグ（push はユーザー）
6. （C-3 で案2 採用時のみ）`feat(hf)!前倒し`: prefetchHfFile 戻り値の object 化

## 次回レビューの観点

- A-1 修正の凍結テストが「印と中身の一致」を直接 assert しているか
- 🟢確定ファイル（scripts 一式 / workflows / LICENSE / .gitignore / deno.lock / src/testing）は無変更なら対象外
- Deno Cache put 上書きの orphan body ファイル（known-issues 記載・上流注視）継続

## 検査メソッドのメモ

- finder→verifier の 2 段は今回も有効: 取り下げ 2・降格 4・**格上げ相当の実証 1（A-1: 理論指摘 → 公開 API のみで実作成）**は finder 単独では到達しなかった。
- verifier への「scratchpad での実験許可」が決定打（乖離エントリ実作成 / lcov 生値 / 変異再現）。次回も維持。
- 教訓: Workflow の `args` に JSON 文字列を渡すとスクリプト側で未展開になる（今回 findings 出力先が undefined/ に散った）。定数はスクリプトへ直接埋め込むこと。
