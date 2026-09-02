# レビュー SUMMARY — `into` 追加（3b13d16）の 0.6.0 リリース前検品

- 実施日: 2026-09-02 / HEAD: 3b13d16（v0.5.0 タグ = 37d781b 以降の唯一の未リリースコミット）/
  前回: `.claude/reviews/2026-08-28_c91e955/` / モード: **A（差分）** — 対象コミットが 1 件なので
  差分レビュー + テスト品質横断 + 文書整合 + リリース検品の 4 レンズ
- 配分: Opus × 4（Agent ツール・セッション effort 継承）。G1 = `into` 経路の正しさ / G2 = 並行性と
  所有権 / G3 = テスト品質 / G4 = 文書・API 整合とリリース検品。統合と検証パスはオーケストレータ
  （コード実読 + grep）。Pass2 の再派遣は無し — 根拠は §実施概要。
- CI: `deno task check` 緑（170 passed / 0 failed / 1 ignored）、`deno publish --dry-run` 成功。

## 結果ダイジェスト

| 重大度 | 件数 | 主なもの |
| --- | --- | --- |
| 🔴 Critical | 0 | — |
| 🟠 Error | 3（重複統合後） | E1 同一バッファの並行使用で「記録ハッシュ付きの不正エントリ」/ E2 HF 層で `expectedBytes` 超過の事前検査が revision 解決の後 / E3 テスト未凍結 6 経路（ヒット側の縮退経路・null body・空 body・onProgress・stream 読み） |
| 🟡 Warning | 12 | 合流者コピーの 2N 復活 / leader 容量不足の全員伝播 / `into` がヒット self-heal を無効化 / ADR と実装の catch 数不一致 / README の過大保証 3 箇所（前回 D 群と同型）/ TS 5.7+ 要件と `Promise.withResolvers` のブラウザ下限が未記載 ほか |
| 🔵 Low | 19 | 文書の小粒・テスト assertion の補強・棄却済み最適化の記録 |

**ブロッカー無し**。`into` の中核契約（prefix view / 容量不足 fail loud / ヒットはエントリ温存・非縮退 /
入口 throw / prefetch 不参照 / 合流者へバッファを渡さない）は全分岐で成立し、single-flight の
リファクタは lost wakeup / 合流 TOCTOU / 二重 resolve / 未処理拒否 / 自己デッドロックを全て棄却
（G2 が実行順序図で証明・オーケストレータが `shared.resolve → return → finally` の同一同期区間を
実読で確認）。指摘は「**誤用時の壊れ方**」「**文書が実装より広い**」「**テストの網羅**」に集中。

要判断は **2 件**（下記 2・4）。最優先は 2（同一バッファの並行使用ガードの置き場所）。

## 要判断（ユーザー裁定待ち）

### 1. 推奨案で進める一覧（承認語 1 つで一括・個別に外せる）

コード:

- 1-1) **E2 / G4-03**: `toSpec`（`src/hf/mod.ts:259`）へ `expectedBytes > into.byteLength` の
  事前検査を移し、HF 入口でも revision 解決（network）より前に throw する。凍結テスト 1 本
  （`calls.length === 0`）。cache 層の同検査（`src/core.ts:805-814`）は残す（`fetchBytes` 直呼びの入口）。
- 1-2) **G1-06 + G1-02(c)**: `IntoCapacityError` の文言をキャッシュ読出しと network 受信で出し分ける
  （現状はヒット経路でも「受信 N バイト」と出て、network に出ていないのにダウンロード失敗に見える）。
  `readBody` に出どころ引数を足す最小変更。既存テストはメッセージ前半で照合しており壊れない。
- 1-3) **G1-10**: `Promise.withResolvers`（`src/core.ts:874`）を素の `new Promise` executor に戻す。
  0.5.0 の本体コードには無く（テストのみ）、今回初めて本体に入ったため、ブラウザ下限が黙って
  Safari 17.4 / Chrome 119 / Firefox 121 へ上がる。4 行で回避でき、下限を動かさない方が minor
  リリースとして安全。
- 1-4) **G2-06**: `fetchBytesWithKey` の入口ガード群（`src/core.ts:805`）に SharedArrayBuffer 背面の
  `into` を fail loud で弾く 1 行を足す（JS 呼び出し・`as` 経由で型を素通りしたとき、`cache.put`
  が生の SAB を読む — 他 Worker の書き込みで記録ハッシュと中身が食い違う）。
- 1-5) **G2-03**: 合流部（`src/core.ts:831` 直前）に「関数入口からここまで `await` を挟まない MUST」
  コメントを追加。`followers` の正しさ = 合流者が leader の呼び出し側バッファを掴まない安全性が
  この同期区間に依存しており、現状のコメントは二重フライト（性能）の理由しか書いていない。

テスト（G3 🟠 6 件 + 新ガードの凍結。既存テストは触らない）:

- 1-6) G3-01 `body === null` フォールバック + `into`（成功 / 容量不足）。
- 1-7) G3-02 記録不一致ヒット → self-heal → network で器へ再書き込み。
- 1-8) G3-03 `validate` 拒否ヒット → self-heal → network で器へ再書き込み（器の二度書き）。
- 1-9) G3-04 `into` のキャッシュヒットで `onProgress` が呼ばれない。
- 1-10) G3-05 空 body + `into`（長さ 0 の prefix view・空エントリ成立）。
- 1-11) G3-06 ヒットが `arrayBuffer()` ではなく body stream で読まれる（`caches` DI で pull を観測）。
- 1-12) G2-08 leader の容量不足が合流者へ伝播する（1-2 の文言と併せて凍結）。
- 1-13) G3-11 `prefetchHfFile` が `into` を見ない（器が無傷）。
- 1-14) 1-1 / 1-4 / 2（採択案）の各ガードの凍結テスト。

文書（README は英語・JSDoc は日本語）:

- 1-15) **G4-01 / G4-02 / G4-09**: README の「No per-call allocation happens」「the heap never holds
  more than one of them」を「呼び出し毎の受信・戻り値バッファの確保が無くなる」へ主語限定し、
  但し書き（合流者がいるときの 1 回コピー / body が null のランタイム / ヒット側の効果は Cache
  実装が body を stream で返すか次第 / `sha256` 検証時は WebCrypto がコピーを取る）を
  limitations と README に 1 文ずつ。前回 D 群と同型の再発。
- 1-16) **G1-02 / G2-05 / G4-10**: limitations の `into` 項に ①エントリ側が器より大きい場合も同じ
  例外で self-heal しない（回復は `evictUrl` / `evict` か `into` 無しで 1 回読む）②throw 後の器の
  内容は未定義（先頭から一部書き換わる）③判別は `error.name === "IntoCapacityError"`、を追記。
- 1-17) **G2-02 / G1-04**: limitations の single-flight 項に「leader の `into` 容量不足はフライト
  全員へ伝播する（合流者側の容量不足だけがその呼び出しに留まる）」を追記。
- 1-18) **G1-03 / G4-05**: ADR 0009 §2 の「ヒット経路の 2 つの catch」を実装どおり「読出しを囲む
  catch 1 箇所（self-heal 側には届かない）」へ訂正。到達不能な防御コードは足さない。
- 1-19) **G1-05 / G4-06**: README の Runtime support に「型定義は TypeScript 5.7 以降を前提
  （`Uint8Array<ArrayBuffer>`）」を 1 行。`into` の JSDoc に `new Uint8Array(new ArrayBuffer(n))`
  で確保する旨。
- 1-20) 小粒: G4-07 prefetch が無視する項目の列挙に `into` を追加（README + JSDoc）/ G4-08 ADR
  0009 の関連行に「0005 §1 の tight view 保証を `into` 指定時に限り改定」/ G4-11 README 例に
  `expectedBytes` は完全長検査で `into` は器、の補足 / G4-13 README Releasing 節の bump 引数を
  実装（pre\* 含む）に揃える / G1-07 ADR 0004 の「同じ raw インスタンス」帰結に条件を付記。
- 1-21) **リリース**: 追加のみ → `deno task bump minor`（0.6.0）。移行節は不要。リリースノートは
  英語・💥 無し・✨ / 📝 構成、独立レッグで主張突合してから確定。タグと GitHub Release は
  オーナーが作成。

### 2. 同じ `into` を**並行**する呼び出しへ渡す誤用を、どこで止めますか？ [Error / 設計]

**概要**: `fetchHfFiles` は全 spec を `Promise.all` で並列取得する（`src/hf/mod.ts:380-387`）。
`HfFileSpec.into` はファイル毎の設定なので、「1 本の器を使い回す」という売り文句を素直に読むと
全 spec に同じバッファを渡す書き方になる。すると 2 本の受信が同じ領域へ交互に書き、A の
sha256 検証が通った瞬間（WebCrypto は呼び出し時点でコピーを取る）と `cache.put` が実際に
バッファを読む瞬間の間に B の書き込みが入ると、**A の記録ハッシュを持つのに中身は B のエントリ**が
成立する。`storableResponse`（`src/core.ts:464-474`）は view をそのまま stream に載せコピー
しないため、put が読むのは「その時点の器の中身」。既定（`recheck: false`）は記録の文字列比較で
信じるので self-heal は発火せず、`clearCache` / `evict` するまで壊れたバイトが返り続ける。
これは「記録付きの不正エントリは正規経路から生まれない」（ADR 0005 §5）というこのライブラリの
中心的な安全性主張の穴。現在の文書は「戻り値同士が上書きし合う」としか書いておらず被害が過小。
逐次利用（文書が指示する使い方）では起きない。

- a) ★ **cache 層に「使用中バッファ台帳」を置く** — `fetchBytesWithKey` の入口で `into.buffer` を
  `Set` に登録し、既に登録済みなら fail loud、`finally` で解除。`fetchBytes` 直呼び・`fetchHfFile`
  の非 await 並行・`fetchHfFiles` の同一器・合流者の写し先まで 1 箇所で全部止まる。
  理由: ①破れる不変条件は cache 層のもので、守る場所も cache 層が根（HF 層だけ守ると
  `fetchBytes` の並行誤用が残る）②既存の `inflight` Map と同じモジュール状態で新しい概念を
  持ち込まない（~15 行）③壊れ方が「恒久汚染」= 不可逆側なので、入口で機械的に弾く既存の流儀
  （sha256 形式・非 GET・`expectedBytes` > 容量）に揃える。
  代償: 1 本の大バッファの互いに素な部分ビューへ**並列**に読む用途も弾く（buffer 同一性で判定。
  範囲重なり判定へ緩めるのは後からでも非破壊）。
- b) `fetchHfFiles` だけで spec 群の `into` 同一性を同期検査（`toSpec` と同じ位置・O(n)）+ 文書強化。
  誘発しやすい入口は塞がるが、cache 層の並行誤用は文書のみ。
- c) 文書のみ強化（MUST NOT + 回復手順）。実装リスクゼロ・検出はできない。

**リスク**: a) はモジュール状態が 1 つ増える。register/unregister を `try/finally` で囲むため
`fetchBytesWithKey` の 3 つの return 経路（cache:false / 合流者 / leader）を 1 つの内側関数に包む
小リファクタが要る。
**対象**: `src/core.ts:755-906`（fetchBytesWithKey）/ `src/hf/mod.ts:367-390` / `docs/limitations.md:41-49` /
`src/hf/mod.ts:70-81`（JSDoc）
**影響範囲**: `into` 使用者のみ。追加ガードなので非 breaking（未リリース機能）。
**引き継ぎ**: a) なら `const buffersInUse = new Set<ArrayBuffer>()` をモジュールスコープに置き、
`opts.into` ガード群の直後で `has → throw / add`、本体を `try { … } finally { delete }`。合流者も
`opts.into.set(raw)` で書くので同じ経路を通す。テストは「同じ器で 2 本同時に `fetchBytes` → 2 本目が
network に出る前に throw（`calls.length === 1`）」と「逐次なら通る（既存 #3 が凍結済み）」。
文書は a/b/c いずれでも「並行受信が交互に書き、記録ハッシュ付きの不整合エントリが残りうる
（self-heal で回復しない・回復は `evict` / `evictUrl`）」へ格上げする。

### 3. （欠番 — 1-3 に統合）

### 4. 合流者がいるときの leader 側 `raw.slice()`（N バイトの新規確保）を、今回は文書化に留めますか？ [Warning / 設計]

**概要**: leader が `into` を使い合流者が 1 人でもいると、共有前に保存形 raw を全長コピーする
（`src/core.ts:895-897`）。`into` で消したはずの N バイト確保がそのフライトだけ復活し（ピーク 2N）、
数 GB 級で確保が落ちると **ダウンロード・検証・`cache.put` が全部成功した後に** leader も合流者も
throw する（次の呼び出しはヒットになるので帯域は捨てない）。設計自体は正しい（呼び出し側所有
メモリを合流者へ渡せない以上コピー以外に手が無い）が、ADR 0009 Consequences の「合流者ぶんの
コピーは 1 回きり」からはこの帰結が読めない。

- a) ★ 文書化のみ — ADR 0009 Consequences / limitations / README の `into` 節に「同一キーへ並行
  呼び出しが入ったフライトに限り N バイトのコピーが 1 回発生し、確保が落ちれば取得は成功していても
  throw する（再試行はヒット）」を明記。代替設計は ROADMAP へ。
  理由: ①主用途（逐次読み）では合流者ゼロでコピーは一度も起きない ②代替（合流者が leader の
  put 済みエントリを cache から読み直す）は「put が縮退した / cache 無効」の分岐を増やし、
  0.6.0 の追加のみリリースに載せる変更として重い ③挙動は今も予測可能で不可逆な壊れ方はしない。
- b) 今回実装 — leader が `into` を使い合流者がいるとき、合流者へは「cache から読み直せ」を配り
  （put 成功時）、put が縮退したときだけコピーへ落とす。
- c) `raw.slice()` の失敗だけ握って合流者に専用エラーを配り、leader は成功させる（部分成功の
  新しいエラー種別を single-flight に持ち込む）。

**リスク**: a) は挙動を変えない。b) c) は「フライトの部分成功」という新状態を持ち込み、
ADR 0004 の「取得失敗は合流全員へ伝播」の単純さを崩す。
**対象**: `src/core.ts:890-897` / `docs/decisions/0009-into-caller-buffer.md:66-75` / `docs/limitations.md:41-49` / `README.md:228-243`
**影響範囲**: 同一 shard へ並行呼び出しが入る運用（UI 再入など）のみ。
**引き継ぎ**: b) を将来採るなら G2-02 の「leader 容量不足の全員伝播」と合わせて 1 本の ADR で
「フライトの部分成功」を設計する。

参考の優先度感: 2 > 1-1 / 1-3 / 1-15 > 残り。

## 検証パス評定（オーケストレータ）

| 指摘 | 系統 | verdict | 根拠 |
| --- | --- | --- | --- |
| 同一バッファ並行使用で記録付き不正エントリ | G1-01 ≡ G2-01 ≡ G4-04（G4 は uncertain） | **holds** | `storableResponse` は view を `controller.enqueue` するだけでコピーしない（core.ts:464-474 実読）。put が読むのは消費時点の中身。digest は WebIDL の BufferSource 取り扱いで呼び出し時コピー（仕様保証） |
| single-flight リファクタの安全性 | G2 | **holds（問題なし）** | `shared.resolve(...)` → `return decoded` → `finally { inflight.delete }` が単一同期区間（core.ts:894-906 実読）。合流側は関数入口〜`followers += 1` に await 無し |
| `raw.slice()` は put 成功後に走る | G2-04 | **holds** | `acquireAndDecode` が put まで完了してから 895 行 |
| ADR 0009 §2「2 つの catch」 | G1-03 ≡ G4-05 | **holds（文書誤り）** | passthrough は core.ts:632 のみ。666 の bare catch には `IntoCapacityError` が届かない（readBody は 630 側 try の中） |
| HF 層で入口検査が revision 解決の後 | G4-03 | **holds** | `fetchHfFile` は `toSpec` → `resolveHfRevision`（network）→ `fetchResolvedFile` → `fetchBytesWithKey` の順（hf/mod.ts:274-285 実読）。容量検査は core.ts:805 にしか無い |
| `Promise.withResolvers` の下限上昇 | オーケストレータ ≡ G1-10 | **holds** | `git grep withResolvers v0.5.0 -- src` はテスト 10 箇所のみ、本体は今回 core.ts:874 が初 |
| sha256 の部分ビュー直渡し | G1 | **holds（仕様保証）** | WebCrypto `digest` の BufferSource は view の範囲を取る。`src/sha256.ts`（prefetch 経路）は無関係 |

## 実施概要

- モード A。対象範囲 = 3b13d16 の全 7 ファイル + 読み合わせ用に core.ts / hf/mod.ts 全体。
- Pass2 再派遣: **無し**。E/C の集中は「同一バッファ並行使用」1 点で、3 系統が独立に一致し、
  オーケストレータの実読で holds を確定できたため再派遣不要と判断。uncertain は G4-04 の
  「実際に put へ流れる view が上書きされるか」だけで、これは stream の enqueue がコピーしない
  という構造的事実で閉じた。
- モデル配分メモ: Opus × 4 は所見の重複（同一バッファ問題を 3 系統が指摘）が多く、G1 と G2 の
  レンズは次回統合してよい。G3 の「赤にする実装行」列挙は有用で継続。

## ファイル別分類（統合）

| ファイル | 判定 | 理由 |
| --- | --- | --- |
| `src/core.ts` | 🟡 | 契約は全分岐で成立。誤用時の壊れ方（並行使用 / SAB）・文言・コメントの補強が要る |
| `src/hf/mod.ts` | 🟠 | `into` 容量の事前検査が revision 解決の後（G4-03）。`fetchHfFiles` が誤用の導線 |
| `src/mod.test.ts` / `src/hf/mod.test.ts` | 🟡 | 追加 12 本は全て有効・既存改変ゼロ。ヒット側縮退経路ほか 6 経路が未凍結 |
| `README.md` | 🟠 | 過大保証 3 箇所（前回 D 群と同型）+ TS 要件未記載 |
| `docs/decisions/0009-…` | 🟡 | catch 数の記述誤り・0005 改定関係の未記録 |
| `docs/limitations.md` | 🟡 | `into` 項の被害記述が過小・回復手順無し |
| `src/mod.ts` / `deno.json` / `.github/` / `scripts/` | 🟢 | 変更不要。リリース機構は健全 |

## 過去レビューからの進捗

前回 ROADMAP（2026-08-28）の見送り事項は全て未着手のまま（0.6.0 候補の revalidate / HF sha256
後付け移送 / 寿命軸、品質小粒、TS-006 以降のテストギャップ）。今回の `into` は ROADMAP 外の新規
要求で、既存見送りと抵触しない。

## アクションアイテム

1. 裁定（2・4）→ 1 の一覧と併せて実装（コード → テスト → 文書の順でコミット分割）。
2. `deno task check` 緑 → `deno task bump minor` → リリースノート草案 → 独立レッグで主張突合 →
   オーナーがタグ `v0.6.0` + GitHub Release publish（release.yml が JSR へ publish）。
3. 次回観点: 「ADR の Consequences を README / limitations へ写す」工程を機能追加のチェック項目に
   する（G4 横断所見 1 — D 群再発の構造的対策）。

## 実施済み指摘の記録（裁定後・2026-09-02）

裁定: 1 の一覧は 1-3（`Promise.withResolvers` の置換）を除き承認。1-3 はオーナー判断で取り下げ
（下流は WebGPU 前提でブラウザ下限は問題にならない）— 代わりに README Runtime support へ JS 下限
（Baseline 2024）を明記し以後の基準とした。2 = a)（cache 層の使用中バッファ台帳）、4 = a)（文書化）。

| commit | 内容 | 閉じた指摘 |
| --- | --- | --- |
| e4550f2 | fix(into): 台帳 `buffersInUse`（buffer 同一性・finally 解除）+ SharedArrayBuffer ガード + HF `toSpec` の容量事前検査 + 容量不足文言の出し分け（キャッシュ側は回復手順つき）+ 合流部の MUST コメント。取得本体を `runFlight` へ切り出し（意味論不変） | 2(a) / G1-01 / G2-01 / G4-04 / G4-03 / G1-06 / G1-02(c) / G2-06 / G2-03 |
| e60585a | docs(into): README / limitations の過大保証の限定と残る確保 4 つ、並行使用禁止・SAB・error.name・器の内容未定義・エントリ側超過の回復手順・leader 容量不足の伝播、ADR 0009 §2 訂正 + §5 台帳 + Consequences（2N・0005 改定）、ADR 0004 追補、Runtime support（Baseline 2024 / TS 5.7+）、prefetch 無視列挙、Releasing の bump 引数 | 4(a) / G4-01 / G4-02 / G4-05 / G4-06 / G4-07 / G4-08 / G4-09 / G4-10 / G4-11 / G4-13 / G1-02 / G1-03 / G1-04 / G1-05 / G1-07 / G1-08 / G1-09 / G2-02 / G2-04 / G2-05 / G2-07 |
| affe54d | test(into): 12 本（G3-01〜06 / G2-08 / G3-11 / 台帳 / SAB / 文言 / HF 入口）。フォルト注入で全本の赤化を実測 | G3-01〜06 / G3-11 / G3-12（台帳テストで代替） / G2-08 |
| 35e6a6d | chore(release): 0.6.0 | 1-21 |

未処理（ROADMAP へ）: G3-07〜10 / G3-13〜20、G1-12 / G1-13 / G4-12 / G4-14、G2-04(b)。
