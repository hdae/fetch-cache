---
id: G1
topic: "`into`（呼び出し側バッファ）経路の正しさ — 契約が全分岐で守られているかの確定"
commit: 3b13d16
files_reviewed:
  - src/core.ts
  - src/hf/mod.ts
  - src/mod.ts
  - src/sha256.ts
  - src/mod.test.ts
  - src/hf/mod.test.ts
  - docs/decisions/0009-into-caller-buffer.md
  - docs/decisions/0004-single-flight-raw-sharing.md
  - docs/decisions/0005-streaming-prefetch-and-verified-marker.md
  - docs/decisions/0007-explicit-expected-bytes-fail-loud.md
  - docs/limitations.md
  - docs/known-issues.md
  - README.md
date: 2026-09-02
model: opus
---

## サマリ

`into` の中核契約 — ①戻り値 = `into` の prefix view ②容量不足は fail loud（縮退なし）
③キャッシュヒットはエントリ温存・network へ縮退しない ④`expectedBytes > 容量` は入口 throw
⑤prefetch は `into` を見ない ⑥single-flight の合流者へ leader のバッファを渡さない — は、
**全分岐で守られている**。特に懸念していた single-flight の `followers` カウント TOCTOU
（合流者が `shared.resolve` 後・`inflight.delete` 前に紛れ込んで leader の生バッファを掴む）は
**成立しない**ことを、`await` 境界の位置から証明した（後述「結論 2」）。sha256 の部分ビュー
直渡しも WebIDL の仕様保証に乗っており、実装挙動依存ではない。

一方で、**「呼び出し側が契約を破ったときに何が壊れるか」の見積もりが文書と実態でずれている**。
最大のものは、同一バッファを `fetchHfFiles` の複数 spec へ渡した場合に「記録ハッシュ付きで
中身が食い違うキャッシュエントリ」が構造的に生成されうる点（G1-01）で、これはこのライブラリが
prefetch 側で「呼び出し側の行儀に依存させない」と MUST 宣言して守っている不変条件そのもの。
次に、`into` を使うとキャッシュヒットの self-heal が一部無効化され、壊れたエントリで恒久的に
詰まる経路が生まれる（G1-02）。どちらも「バグ」ではなく契約設計・文書の穴だが、
影響が恒久的（キャッシュに残る）なので Error / Warning に置いた。

コード自体の欠陥（誤った分岐・取りこぼし・リーク）は**発見できなかった**。指摘は
「契約の穴」「文書と実装の乖離」「診断性」「テストギャップ」に集中する。

| 重大度       | 件数 |
| ------------ | ---- |
| 🔴 Critical  | 0    |
| 🟠 Error     | 1    |
| 🟡 Warning   | 5    |
| 🔵 Low       | 8    |
| 🟢 Safe      | —    |

---

## ファイル別分類

| ファイル | 判定 | 根拠 |
| --- | --- | --- |
| `src/core.ts` | 🟡 Warning | `into` 経路の分岐・容量検査・リーダ/合流者の所有権分離はすべて正しい（証明は後述）。ただし ①ヒット経路の容量超過が self-heal を無効化する（G1-02） ②leader の申告ミスが全合流者へ伝播する（G1-04） ③self-heal 側の `catch` が bare（`core.ts:666`）で ADR の約束と食い違う（G1-03） ④エラー文言がヒット経路でも「受信」（G1-06）。 |
| `src/hf/mod.ts` | 🟠 Error | `into` の転送自体は正しい（`hf/mod.ts:241`）。`fetchHfFiles` は `Promise.all` で**並列**（`hf/mod.ts:380-387`）なので、同一バッファを複数 spec へ渡すと戻り値の上書きに留まらず、記録ハッシュ付きの不整合エントリを作りうる（G1-01）。JSDoc（`hf/mod.ts:77-78`）はこの帰結を「戻り値同士が上書きし合う」としか書いていない。 |
| `src/mod.ts` | 🟢 Safe | `FetchBytesOptions` を型として再公開（`mod.ts:41-50`）しており、`into` は追加のみで公開ファサードに変更不要。差分ゼロで正しい。 |
| `src/sha256.ts` | 🟢 Safe | 差分ゼロ。純 TS 逐次ハッシュは `prefetchUrl` の通過中検証専用（`core.ts:1051`, `core.ts:1095`）で、`into` はそこへ到達しない。`update` は `chunk.subarray` / `compress(…, chunk, offset)` と全て view 相対で添字するため、仮に部分ビューが渡っても正しい（`sha256.ts` の `update`）。今回の変更による影響なし。 |
| `src/hf/mod.ts`（型面） | 🟡 Warning | `HfFileSpec.into: Uint8Array<ArrayBuffer>`（`hf/mod.ts:81`）が `FetchBytesOptions.into`（`core.ts:146`）と並んで**公開 API に初めて現れる TS 5.7+ 依存の型**。利用者側 TS 要件が未文書（G1-05）。 |
| `src/mod.test.ts` | 🔵 Low | 追加 10 本は主要分岐（network / ヒット / 器の使い回し / sha256 / decode / 容量不足 3 種 / single-flight 2 種 / cache:false）を的確に押さえている。未カバー分岐あり（G1-14）。 |
| `src/hf/mod.test.ts` | 🔵 Low | 1 本（network + ヒット + `expectedBytes` 併用）。`fetchHfFiles` × 同一バッファの誤用挙動が未凍結（G1-14）。 |
| `docs/decisions/0009-into-caller-buffer.md` | 🟡 Warning | §2 の「ヒット経路の**2 つの** catch はこの例外だけ素通しする」がコードと不一致（実装は 1 箇所のみ・G1-03）。§4 の WebCrypto 前提は正しい（結論 3）。 |
| `docs/limitations.md` | 🟡 Warning | `into` 節（38-47 行相当）は契約を正確に列挙しているが、①同一バッファ並列渡しの帰結を過小評価（G1-01） ②ヒット容量超過が self-heal を殺すことと回復手順が無い（G1-02） ③throw 時のバッファ内容が未定義である旨が無い（G1-08）。 |
| `docs/decisions/0004-single-flight-raw-sharing.md` | 🔵 Low | 帰結の「合流者は leader と同じ raw インスタンスを受け取る」が条件付きで偽になったのに追記が無い（G1-07）。 |
| `docs/known-issues.md` | 🟢 Safe | 本差分に起因する新規オープン問題は無い（本レビューの Warning は仕様・文書側の判断待ちであり、known-issues 化は裁定後）。 |
| `README.md` | 🔵 Low | `into` 節は契約を正しく要約している。①TS 要件の記述なし（G1-05） ②例の「`bytes` is `into.subarray(0, shard.size)`」は実受信長依存で厳密には不正確（G1-11）。 |

---

## 詳細指摘

### G1-01 🟠 Error — 同一バッファを並列 spec へ渡すと「記録ハッシュ付き・中身が食い違う」エントリが作られうる

**質問**: `fetchHfFiles` に同一 `into` を渡す誤用の帰結を、現状の「戻り値同士が上書きし合う」から
「キャッシュに恒久的な不整合エントリが残りうる」へ格上げして文書化しますか、それとも重なり検出の
実行時ガードを入れますか。

**概要**:
`fetchHfFiles` は `Promise.all` で全 spec を**並列**取得する（`src/hf/mod.ts:380-387`）。
同一バッファを 2 つの spec に渡すと、2 本の `readBody` が同じ領域へチャンク単位で交互に書く。
ほとんどの場合は sha256 / `expectedBytes` 検証が落ちて throw するだけで済むが、次の順序が成立
すると不正エントリが**成立して残る**:

1. A の `readBody` が完了し、`checkAndDecode` が A の内容で sha256 を通す（`core.ts:697`）。
2. `storableResponse(bytes, opts.sha256)` は bytes を**コピーせず** 1 チャンクの
   `ReadableStream` に載せるだけ（`core.ts:464-474` — これは意図的な最適化）。
3. `await cache.put(...)`（`core.ts:704`）の最中に B の `readBody` が同じ領域へ書く。
4. Cache 実装が読み出すのは書き換わった後のバイト列。**ヘッダには A の sha256 が焼かれている。**

出来上がるのは「記録ハッシュは正しいのに中身が違う」エントリで、既定（`recheck: false`）の
読み出しは記録の文字列比較だけで信じる（`core.ts:648-650`）ため、**self-heal では回復しない**。
これは `prefetchUrl` 側でチャンクを複製してまで排除している失敗クラスそのもの（`core.ts:1087-1091`
の「MUST: 記録の健全性を呼び出し側の行儀に依存させない」）で、同じ不変条件が `into` 経路では
呼び出し側の行儀に委ねられている。

**守っている目的**: 「記録ハッシュ = 保存時にこの sha256 と一致した」という主張を、正規経路からは
決して破れなくすること（ADR 0006 §2 / 0008 の信頼モデルの土台）。

**発生条件**: `fetchHfFiles` の複数 spec に同一バッファ（または重なる部分ビュー）を渡す、あるいは
同一バッファで複数の `fetchHfFile` / `fetchBytes` を `await` せず並行に走らせる。逐次利用（文書が
指示している使い方）では発生しない。

**選択肢**:
- a) ★ `docs/limitations.md` と `HfFileSpec.into` の JSDoc を「戻り値が上書きし合う」から
  「**MUST NOT**: 記録ハッシュ付きの内容不整合エントリが残りうる（self-heal で回復しない）」へ
  格上げし、回復手順（`evict` / `evictUrl` → 取り直し）を併記する。
- b) `into.buffer` + `[byteOffset, byteOffset+byteLength)` の**範囲重なり**で in-flight 登録を持ち、
  重なる並行呼び出しを fail loud で弾く（`buffer` 同一だけで弾くと、1 本の大バッファの互いに
  素な領域へ並列に読む正当な用途を過剰拒否するため、範囲比較が必須）。
- c) 現状維持（`decode` / `validate` の「raw 非破壊 MUST NOT」と同じく契約のみで守る）。

**リスク**: a) は文書のみで実装リスクゼロ・誤用の検出はできない。b) は数十行の追加と、
range 管理の複雑さ（`Simplicity first` との緊張）。c) は誤用時に恒久汚染が残り続ける。

**対象**: `src/hf/mod.ts:77-79`（JSDoc）/ `src/hf/mod.ts:380-387`（並列取得）/
`src/core.ts:464-474`（コピーしない Response）/ `src/core.ts:697-708`（検証 → put）/
`docs/limitations.md` の `into` 節。

**影響範囲**: HF 層の複数ファイル取得を使う下流全般。実害は誤用時のみだがキャッシュに永続する。

**引き継ぎ**: a) を採るなら、文言に「self-heal では回復しない（記録が一致するため）」「回復は
`evict(["hf", kind, repo])` か `evictUrl(hfResolveUrl(...))`」を必ず含めること。b) を採るなら
登録／解除は `fetchBytesWithKey` の `into` 検査直後（`core.ts:804` 付近）と `finally` に置き、
`cache:false` 経路・合流者経路の両方を通す（合流者も `opts.into.set(raw)` で書く — `core.ts:851`）。

---

### G1-02 🟡 Warning — `into` はキャッシュヒットの self-heal を無効化する（器より大きい壊れたエントリで恒久スタック）

**質問**: 「キャッシュエントリが `into` より大きい」ケースを、現状どおり呼び出し側の申告ミスとして
throw し続けますか（文書 + 回復手順の追加のみ）、それとも破損として self-heal に乗せますか。

**概要**:
`into` 指定のヒット経路は `readBody(cached, …, opts.into)` で読み込む（`core.ts:617-627`）。
エントリが `into.length` を超えると `IntoCapacityError` が投げられ、`core.ts:632` の
`if (error instanceof IntoCapacityError) throw error;` でそのまま外へ抜ける — **evict もせず、
network へも出ない**（契約どおり）。

問題は、この分岐が「呼び出し側の器が小さい」と「キャッシュエントリの中身が壊れている（長すぎる）」を
区別できないこと。後者の場合、`into` を使わない従来経路なら
`validate`（HF 層の `expectedBytes` 完全長検査 — `hf/mod.ts:197-206`）や sha256 が落ちて
`core.ts:666-675` の self-heal（evict → network 取り直し）へ乗り、次回以降は自動回復していた。
`into` 指定ではその回復が**永久に起きない**: 何度呼んでも同じ `IntoCapacityError` が返る。

**守っている目的**: 「破損キャッシュは真実源から取り直して自動回復する」という ADR 0001 / 0006 の
self-heal 契約。`into` はその外に穴を開けている。

**発生条件**: 記録ハッシュが無い（旧版 / 無検証 prefetch 由来）か `sha256` 未指定のエントリで、
実バイト長が `into.length` を超えている。`sha256` + 記録一致のエントリでは、記録が正しければ
長さも正しいのでほぼ起こらない。

**選択肢**:
- a) ★ 現状維持 + 文書化: `docs/limitations.md` の `into` 節に「エントリ側が大きすぎる場合も同じ
  例外になり self-heal しない。回復は `evictUrl` / `evict`、または `into` 無しで 1 回読む」を明記。
- b) ヒット経路の容量超過だけ破損扱いにして self-heal（evict → network）へ乗せる。
  帯域を捨てる代償があり、「呼び出し側の申告ミスは縮退させない」という ADR 0009 §2 と真っ向から
  衝突するため、`expectedBytes` 明示時に限定するなどの条件付けが必要。
- c) `IntoCapacityError` に「どちら側の超過か」の情報（cache / network）を持たせ、
  文書で回復手順を案内する（a の強化版・G1-06 と同時に対処できる）。

**リスク**: a) は穴が残るが挙動は予測可能。b) は「器が小さいだけ」の呼び出しで数 GB を再取得し、
しかも再取得も同じ容量で落ちる（0007 が忌避する「帯域を捨てる失敗の遅延」そのもの）ため推奨しない。

**対象**: `src/core.ts:617-635`（ヒット経路の読み込みと passthrough）/ `src/core.ts:666-675`
（self-heal 側の catch）/ `src/hf/mod.ts:197-206`（長さ検証）/ `docs/limitations.md` の `into` 節。

**影響範囲**: `into` を使う全呼び出し。恒久スタックは「壊れたエントリ × 記録なし」の合流条件のみ。

**引き継ぎ**: a) + c) を採るなら、`IntoCapacityError` のコンストラクタに `source: "cache" | "network"`
を足して文言を出し分ける（`core.ts:330-337`）。ヒット経路の呼び出しは `core.ts:621-627` の 1 箇所
だけなので、`readBody` へフラグを渡すか、ヒット経路側で catch して詰め替える形が最小。

---

### G1-03 🟡 Warning — ADR 0009 §2 の「ヒット経路の 2 つの catch」は事実と異なり、self-heal 側は bare `catch` のまま

**質問**: ADR 0009 §2 の記述をコード（passthrough は 1 箇所）に合わせて訂正しますか、それとも
コード側に防御的 passthrough を足して記述どおりにしますか。

**概要**:
ADR 0009 §2 は「ヒット経路の **2 つの** catch はこの例外だけ素通しする」と書く
（`docs/decisions/0009-into-caller-buffer.md:46-47`）。実装で `IntoCapacityError` を素通しするのは
`core.ts:632` の 1 箇所（match の catch）だけで、self-heal 側（`core.ts:666` の `} catch {`）には
passthrough が無い。

現時点でこれは**バグではない**: 2 つ目の catch が包むのは `checkAndDecode` と backfill put だけで
（`core.ts:650-664`）、`IntoCapacityError` を投げるコードはそこに無い（`checkAndDecode` は
sha256 不一致 / `validate` / `decode` の throw のみ・`core.ts:513-528`。`IntoCapacityError` は
module-private なので呼び出し側が構築することもできない）。したがって到達不能。

危険なのは構造の方: `core.ts:666` は**エラーを束縛しない bare `catch {}`** で、将来ここへ
`into` 由来の読み込みが移動・追加されると、容量不足が**黙って「破損」と解釈されエントリが
delete される** — ADR が明示的に禁じた挙動（エントリを消さない）が、レビューに掛からず反転する。

**守っている目的**: 「容量不足は破損でも cache I/O 失敗でもない」という分類の一貫性。

**発生条件**: 現状は発生しない。将来のリファクタで発現する。

**選択肢**:
- a) ADR 0009 §2 を「ヒット経路の catch（match 側）は…」へ訂正し、self-heal 側は到達不能である
  理由を 1 行添える。
- b) ★ `core.ts:666` を `catch (error) { if (error instanceof IntoCapacityError) throw error; …}` に
  して ADR の記述どおりにする（2 行・実行時コストゼロの防御。分類の不変条件をコードに固定する）。
- c) 両方（b を入れて ADR の「2 つ」を事実にする）。

**リスク**: b) 単体では「到達不能なコード」を足すことになり `Simplicity first` と緊張するが、
不変条件を型／構造で固定する側の価値の方が大きい（bare catch は将来の誤りを黙って飲む）。

**対象**: `docs/decisions/0009-into-caller-buffer.md:46-47` / `src/core.ts:630-635` /
`src/core.ts:666-675`。

**影響範囲**: 挙動変化なし。将来の変更に対する安全網。

**引き継ぎ**: b) を採る場合、`catch` に束縛を足すと `deno lint` の未使用変数規則に触れないよう
`error` を実際に使う形（passthrough 条件）にすること。既存の `onCacheError({ op: "delete", … })`
の catch（`core.ts:671-674`）と混同しないこと（そちらは delete 失敗用で別物）。

---

### G1-04 🟡 Warning — leader の `into` 容量不足が、`into` を渡していない合流者まで巻き込んで落とす

**質問**: leader 側の `into` 申告ミスによる失敗を、現状どおり全合流者へ伝播させますか。

**概要**:
single-flight の leader が `into` を渡し、その容量が足りないと `IntoCapacityError` が
`acquireAndDecode` から抜け、`shared.reject(error)`（`core.ts:900`）で**全合流者へ伝播**する。
合流者は `into` を渡していなくても、「fetch-cache: into の容量 N バイトに収まりません
（…） (leader の URL)」というメッセージで落ちる — 自分が渡していないオプションの名前と、
自分が指定したのとは限らない URL（内容キー合流では別 URL がありうる — ADR 0006）で。

ADR 0004 の「取得失敗は合流全員へ伝播する」は成立するが、これは**取得の失敗ではなく
leader 固有の引数エラー**で、合流者側に回避手段が無い（network 受信は打ち切られ、キャッシュにも
入らないので、後続の呼び出しは再取得になる = 帯域も無駄になる）。

**守っている目的**: 単一フライトの結果を全員で共有するという合流契約の単純さ。

**発生条件**: 同一キーへの並行呼び出しで、先着（leader）が小さすぎる `into` を渡したとき。

**選択肢**:
- a) ★ 現状維持 + 文書化: `docs/limitations.md` の single-flight 節に「leader の `into` 容量不足は
  合流者にも伝播する（合流者の `into` は使われない、という既存の「合流者のオプションは使われない」
  一覧と同じ性質）」を 1 行足す。
- b) leader の `IntoCapacityError` を合流者へ渡す前に「leader 側の申告不備で取得が中断された」旨の
  ラップエラーへ詰め替える（`cause` に原本）。診断性は上がるが、合流者は結局失敗する。
- c) leader が容量不足で落ちたら、合流者のうち 1 人を新 leader に昇格させて取得を続行する
  （実装コスト・複雑度が大きく、ADR 0004 の「1 フライト」モデルを崩す）。

**リスク**: a) は驚きが残るが実害は「並行呼び出し時に 1 回失敗して再試行になる」だけ。
c) は非推奨（合流モデルの再設計に相当）。

**対象**: `src/core.ts:688-694`（leader の readBody）/ `src/core.ts:899-901`（reject 伝播）/
`src/core.ts:841-853`（合流者の into 処理）/ `docs/limitations.md` single-flight 節。

**影響範囲**: 同一キーへの並行呼び出しを行う下流のみ。

**引き継ぎ**: 既存テスト「single-flight: 合流者の into が保存形より小さければ**その呼び出しだけ**
throw する」（`src/mod.test.ts` の該当ケース）は逆向き（合流者側）を凍結している。a) を採るなら
対になる「leader 側の容量不足は合流者も落とす」テストを足すと契約が両向きで固定される。

---

### G1-05 🟡 Warning — `Uint8Array<ArrayBuffer>` を公開 API に置いたことによる利用者側 TS 要件が未文書

**質問**: 利用者に要求する TypeScript バージョン下限（5.7+）を README / deno.json のどこかに明記しますか。

**概要**:
`FetchBytesOptions.into`（`src/core.ts:146`）と `HfFileSpec.into`（`src/hf/mod.ts:81`）が
`Uint8Array<ArrayBuffer>` を使う。`Uint8Array` が型引数を取るようになったのは **TypeScript 5.7**
の `lib.es5.d.ts` 変更以降で、それ以前の TS では `Type 'Uint8Array' is not generic` になる。
grep で確認した限り、この差分以前は `Uint8Array<ArrayBuffer>` は**内部（非 export）**の
`allocateHint` / `readBody` / `cachedBytes` にしか出ていない（`core.ts:315/363/364/366/600`）ので、
**公開 API に現れるのは今回が初めて**。Deno 本体は TS 6.0.3 を同梱（この環境で確認）なので
Deno 利用者は影響を受けないが、JSR 経由で npm / bundler から型を引く利用者には要件が乗る。

副次的な使い勝手: TS 5.7+ でも素の `Uint8Array`（= `Uint8Array<ArrayBufferLike>`）は
`Uint8Array<ArrayBuffer>` へ代入できない。他ライブラリ由来のバッファをそのまま渡せず、
`new Uint8Array(new ArrayBuffer(n))`（README の例のとおり）か明示的な絞り込みが要る。
なお `new Uint8Array(n)` は TS 5.7+ で `Uint8Array<ArrayBuffer>` に推論されるので、素直な確保は通る。

**守っている目的**: SharedArrayBuffer 背面を型で排除すること（WebCrypto の `BufferSource` は
`[AllowShared]` ではないため SAB 背面は `digest` で TypeError になる — `core.ts:489-495` は
その場合だけコピーする）。方向としては正しい: 後から緩める（`ArrayBufferLike` 化）のは非破壊、
後から締めるのは破壊的なので、**リリース済みパッケージでは締めた側から始めるのが正**。

**発生条件**: JSR → npm 互換経由で TS 5.6 以前の利用者が型を引いたとき、または
`Uint8Array<ArrayBufferLike>` 型の既存バッファを渡そうとしたとき。

**選択肢**:
- a) ★ README の Runtime support 付近に「型定義は TypeScript 5.7+ を前提」と 1 行足す。
- b) さらに `into` の JSDoc へ「`new Uint8Array(new ArrayBuffer(n))` で確保する（`Uint8Array` 型の
  値は `ArrayBufferLike` 背面なのでそのままでは渡せない）」を追記する。
- c) 型を `Uint8Array`（`ArrayBufferLike`）へ緩め、SAB 背面は実行時に fail loud で弾く。

**リスク**: c) は緩める方向なので後からでもできる — 今決め打つ必要はない。a)+b) が最小で十分。

**対象**: `src/core.ts:129-146` / `src/hf/mod.ts:72-81` / `README.md`（Runtime support 節・475 行付近）。

**影響範囲**: 型のみ（実行時挙動に影響なし）。下流 yomi / sbv2-web は Deno / ブラウザ想定なので実害は薄い。

**引き継ぎ**: `deno.json` に TS 下限を書く仕組みは無いので、記載先は README（と必要なら
`docs/limitations.md` のランタイム節）。

---

### G1-06 🟡 Warning — `IntoCapacityError` の文言がキャッシュヒット経路でも「受信」と言い、回復手順が無い

**質問**: 容量不足エラーの文言を「network 受信」と「キャッシュ読出し」で出し分けますか。

**概要**:
`readBody` は network とキャッシュヒットの両方で共有される（`core.ts:621-627` と `core.ts:688-694`）。
容量超過時の文言は常に `受信 ${loaded + value.length} バイト以上`（`core.ts:415-419`）／
`受信 ${bytes.length} バイト`（`core.ts:394-400`）で、**キャッシュから読んでいるときも「受信」**と出る。
利用者はダウンロードが失敗したと読むが、実際には network に一切出ていない（G1-02 の恒久スタックと
組み合わさると「何度リトライしても同じダウンロードエラー」に見える）。

さらに、エラーは回復手段を示さない。ヒット経路の回復は「`evictUrl` / `evict` してから取り直す」か
「`into` 無しで 1 回読む」だが、メッセージにも `docs/limitations.md` にも書かれていない。

**守っている目的**: fail loud の実効性 — 落とすだけでなく、次に何をすればよいかが分かること
（このリポジトリの他のエラー文言、たとえば `core.ts:1119` の「fetchBytes へフォールバックしてください」や
`core.ts:767-769` の「cache: false を指定してください」と同じ水準）。

**発生条件**: `into` の容量不足がキャッシュヒット経路で起きたとき。

**選択肢**:
- a) ★ `IntoCapacityError` に出どころ（cache / network）を渡し、cache 側は
  「キャッシュエントリ N バイト」+ 回復手順（evict して取り直す）を出す。
- b) 文言はそのままで `docs/limitations.md` に回復手順だけ書く。
- c) 現状維持。

**リスク**: a) はコンストラクタ引数 1 個の追加と呼び出し 4 箇所の更新のみ。既存テストは
メッセージ前半（`into の容量 N バイト`）で assert しているので壊れない
（`src/mod.test.ts` の 3 本が `"into の容量 3 バイト"` 等で照合）。

**対象**: `src/core.ts:330-337`（クラス）/ `core.ts:394-400`, `core.ts:415-419`（readBody の 2 箇所）/
`core.ts:809-813`（入口ガード）/ `core.ts:845-849`（合流者）。

**影響範囲**: 診断性のみ。

**引き継ぎ**: `readBody` は出どころを知らないので、①`readBody` に `source` 引数を足す
②ヒット経路（`core.ts:621-627`）で catch して詰め替える、のどちらか。②の方が `readBody` の
シグネチャ（既に 5 引数）を太らせずに済む。入口ガード（`core.ts:809`）と合流者（`core.ts:845`）は
既に文脈が明確なので個別の文言を持たせられる。

---

### G1-07 🔵 Low — ADR 0004 の帰結「合流者は leader と同じ raw インスタンスを受け取る」が条件付きで偽になった

**質問**: ADR 0004 に 0009 への追補ポインタを足しますか。

**概要**: `docs/decisions/0004-single-flight-raw-sharing.md` の帰結に
「合流者は leader と同じ raw インスタンスを受け取る」とあるが、leader が `into` を使い合流者が
1 人以上いる場合はコピーが渡る（`core.ts:895-897`）。0009 §3 が上書きしているものの、0004 側に
追補が無いので、0004 だけを読むと誤った不変条件を前提にしてしまう。

**選択肢**: a) ★ 0004 の当該行に「（`into` 使用時の例外は 0009 §3）」を足す。 b) 現状維持。

**対象**: `docs/decisions/0004-single-flight-raw-sharing.md` の帰結節 / `src/core.ts:890-897`。

---

### G1-08 🔵 Low — throw 時に `into` の内容が未定義（部分書き込み済み）である旨が未文書

**概要**: 容量超過は「超過を検知したチャンク」で落ちる（`core.ts:411-419`）ため、
そこまでのバイトは既に `into` へ書かれている。ヒット経路の読み込み失敗が
`op: "match"` の縮退（`core.ts:634`）に落ちた場合も、部分書き込みのまま network 経路が同じ器へ
先頭から書き直す（結果は正しい）。しかし「呼び出しが throw したとき器の内容は未定義」という
一文がどこにも無く、「失敗したなら器は無傷」と読める余地がある。

**選択肢**: a) ★ `docs/limitations.md` の `into` 節と `into` の JSDoc に
「throw した場合、器の内容は未定義（部分的に書かれている）」を追記。 b) 現状維持。

**対象**: `src/core.ts:129-146` / `docs/limitations.md` の `into` 節。

---

### G1-09 🔵 Low — `IntoCapacityError` は非公開クラス。判別手段（`err.name`）が未文書

**概要**: `IntoCapacityError` は module-private で `mod.ts` からも re-export されない
（`src/mod.ts:31-50`）。呼び出し側が「器が小さかったので確保し直して再試行する」という
自然な回復を書くには、`error.name === "IntoCapacityError"`（`core.ts:335` で設定済み）か
メッセージ照合しかない。`name` は安定な判別子として使えるが、README にも JSDoc にも書かれていない。

**選択肢**: a) ★ `into` の JSDoc に「容量不足のエラーは `error.name === "IntoCapacityError"` で
判別できる」を 1 行足す（クラスは非公開のまま）。 b) クラスを公開して `instanceof` を提供する
（公開面が増えるので慎重に）。 c) 現状維持。

**対象**: `src/core.ts:330-337` / `src/core.ts:129-146` / `README.md` の `into` 節。

---

### G1-10 🔵 Low — `Promise.withResolvers` の採用でブラウザ下限が上がる（Safari 17.4）

**概要**: `core.ts:874` の `Promise.withResolvers` が、src 配下（テスト以外）で初めての使用
（grep で確認: `src/core.ts:874` のみ）。ES2024 で、Chrome 119 / Firefox 121 / Safari 17.4 以降。
これまでの最も新しい依存は `DecompressionStream`（Safari 16.4）だったので、実質的な
ブラウザ下限が 16.4 → 17.4 に上がる。README の Runtime support 表はランタイム種別しか書いておらず、
ES 機能の下限に触れていない。

**選択肢**: a) ★ README に「モダンブラウザ（`Promise.withResolvers` を含む ES2024）」の
一文を足す。 b) `withResolvers` を手書きの `new Promise` パターンへ置き換えて下限を維持する。
c) 現状維持。

**リスク**: b) は 3 行増えるだけだが、可読性は `withResolvers` の方が高い。下流（Deno / モダン
ブラウザ想定）で実害が出る可能性は低い。

**対象**: `src/core.ts:874` / `README.md:475-500`。

---

### G1-11 🔵 Low — README 例の「`bytes` is `into.subarray(0, shard.size)`」は実受信長依存で厳密には不正確

**概要**: README の `into` 例のコメントが `bytes` を `into.subarray(0, shard.size)` と断定するが、
core 層の `expectedBytes` は**確保ヒントであって検証ではない**（`docs/limitations.md` の 0005 節）ので、
実受信が短ければ `into.subarray(0, 実受信長)` になる。例では `sha256` を併記しているので実害は
出ない（短ければハッシュ不一致で落ちる）が、`sha256` を外した読者が誤解しうる。

**選択肢**: a) ★ コメントを `into.subarray(0, bytes.length)`（= 実受信長）へ直し、
「長さを保証したいなら `sha256` か HF 層の `expectedBytes`」の既存記述へつなげる。 b) 現状維持。

**対象**: `README.md` の `### Reusing one buffer across many reads (into)` 節。

---

### G1-12 🔵 Low（改善提案）— 非ゼロ offset の `into`（大バッファの部分ビュー）が正しく動くのに未文書・未テスト

**概要**: `into` に `big.subarray(1000, 2000)` のような部分ビューを渡しても、実装は全て view 相対で
動く: `buffer.set(value, loaded)`（`core.ts:426`）は view の offset 起点、`into.subarray(0, loaded)`
（`core.ts:434`）も view 相対、`hasArrayBufferBacking`（`core.ts:480-482`）は byteOffset を問わなく
なったので `crypto.subtle.digest` へそのまま渡り view 範囲だけがハッシュされる（結論 3 参照）。
つまり「1 本の大バッファの互いに素な領域へ複数 shard を読み込む」という有用な使い方が
**そのまま動く**が、README も JSDoc も `new Uint8Array(new ArrayBuffer(n))` の形しか示しておらず、
テストも zero-offset の器しか使っていない（`assertPrefixView` は `byteOffset === 0` を assert する
— `src/mod.test.ts` のヘルパ）。

**選択肢**: a) ★ 部分ビューが使える旨を JSDoc に 1 行足し、`into = big.subarray(off, off+len)` の
テストを 1 本追加して契約として凍結する。 b) 現状維持（暗黙にサポート）。

**リスク**: b) のままだと将来の最適化（例: `byteOffset === 0` を前提にした書き込み）で黙って壊れる。

**対象**: `src/core.ts:129-146` / `src/core.ts:426,434,480-482` / `src/mod.test.ts` の `assertPrefixView`。

---

### G1-13 🔵 Low — キャッシュヒットの `body === null` フォールバックは `into` でも一度 2N を踏む

**概要**: `readBody` の `body === null` 経路は `await response.arrayBuffer()` で全量を確保してから
`into.set(bytes)` する（`core.ts:388-402`）。`into` の目的（確保ゼロ）が満たされないうえ、
一瞬 N（arrayBuffer）+ N（器）がヒープに載る。これは 0007 期から続く既存挙動で、前回レビューの
ROADMAP にも「readBody body===null 経路の buffer 解放（2N ピーク・0007 由来の既存挙動）」として
見送りが記録されている（`.claude/reviews/2026-08-28_c91e955/ROADMAP.md`）。`into` を足したことで、
この経路が「契約は守るが目的は果たさない」ことが新たに意味を持つ。

**選択肢**: a) ★ ADR 0009 Consequences の「Cache 実装が body を stream で返すかで効果が変わる」に
「`body === null` のランタイムでは器へ写す前に一度全量が載る」を追記。 b) ROADMAP へ送る。
c) 現状維持。

**対象**: `src/core.ts:388-402` / `docs/decisions/0009-into-caller-buffer.md` Consequences。

---

### G1-14 🔵 Low — テストギャップ（`into` 経路で未凍結の分岐）

**概要**: 追加テスト 11 本（core 10 + HF 1）は主要経路を的確に押さえている。未カバーは以下。
いずれも現状のコードでは正しく動くことを読解で確認済みなので、**バグではなく回帰防御の穴**。

| 未カバー分岐 | 対象 path:line |
| --- | --- |
| `body === null` × `into`（写しと prefix view）／同経路の容量超過 | `core.ts:388-402` |
| 受信長 0（空 body）× `into` → `into.subarray(0,0)` と `checkAndDecode` | `core.ts:434`, `core.ts:643` |
| チャンク境界ちょうど（`loaded + value.length === into.length`）で通ること | `core.ts:411` |
| `staleRecord`（記録 ≠ 期待）× `into` → body cancel → network が同じ器へ書く | `core.ts:611-615`, `core.ts:688-694` |
| ヒット時 self-heal（validate 拒否）× `into` → evict → network が同じ器へ書き直す | `core.ts:666-675` |
| `recheck: true` × `into`（器の view で再ハッシュ） | `core.ts:648-650` |
| 非ゼロ offset の `into`（G1-12） | `core.ts:426,434` |
| `fetchHfFiles` × 同一バッファの誤用挙動（G1-01 の凍結） | `hf/mod.ts:380-387` |
| leader 側容量不足の合流者への伝播（G1-04 の凍結） | `core.ts:899-901` |

**選択肢**: a) ★ 上表のうち `body === null` × `into`・空 body・境界ちょうど・self-heal × `into` の
4 本を追加（いずれも既存の `mockFetch` / `chunkedResponse` / `lazyResponse` で書ける）。
b) 全部足す。 c) ROADMAP へ送る。

**対象**: `src/mod.test.ts` の `into` 節 / `src/hf/mod.test.ts:814-841`。

---

## 担当項目 1〜6 の結論

### 1. `readBody` — `into` × (body===null / streaming / 容量超過 cancel) × `expectedBytes` 併用

**問題なし。** 分岐を 1 本ずつ確認した。

- **バッファ選択**（`core.ts:366-386`）: `into` があれば無条件で `buffer = into`（`core.ts:367-368`）。
  `expectedBytes` の確保（`core.ts:369-382`）にも content-length の確保（`core.ts:384-386`）にも
  進まないので、**`into` 指定時に ADR 0007 の「明示 `expectedBytes` の確保失敗 → 受信前 throw」は
  そもそも起こり得ない**（確保しないため）。これは 0009 の狙いどおりで、入口ガード
  （`core.ts:804-814`）が代わりに「必ず容量不足になる申告」を弾く。
- **`body === null` フォールバック**（`core.ts:387-403`）: `into` があるときだけ写す。
  容量超過は書く前に判定して throw（`core.ts:394-400`）— **器は無傷**。
  `into` 無しなら従来どおり materialize した配列をそのまま返す（`core.ts:393`）。
- **streaming**（`core.ts:404-432`）: `loaded + value.length > buffer.length` の判定は
  **境界ちょうど（`===`）では発火しない**ので、器がぴったりのときは最後のチャンクまで書き切る
  （`core.ts:411`）。超過時は `into` があれば `reader.cancel()` してから throw
  （`core.ts:412-420`）— 未消費 body の解放を先に行っており、既存テストが `pulled() === 2`（超過を
  検知したチャンクで停止）と `cancelled() === true` を凍結している。`into` が無い場合だけ従来の
  蓄積経路へフォールバック（`core.ts:421-424`）。`into` があると `buffer` が `undefined` に
  なることは無いので、`chunks` は常に空のまま（`core.ts:429` は到達しない）= 二重保持は起きない。
- **`loaded === 0`**: `into.subarray(0, 0)`（`core.ts:434`）を返す。`acquireAndDecode` 側の
  `cachedBytes !== undefined` 判定（`core.ts:643`）はオブジェクト比較なので空配列でも真 — 
  falsy 罠は無い。
- **content-length 申告との相互作用**: `readTotal`（`core.ts:365`）は `total`（進捗表示）にしか
  使われず、`into` 指定時は確保にも検証にも関与しない。`docs/limitations.md` の
  「`loaded` と content-length の突合はしない」は維持されている。
- **戻り値**: `into` があれば必ず prefix view（`core.ts:434`）で、`buffer.slice(0, loaded)` による
  詰め直し（`core.ts:436-438`）へは落ちない — 詰め直すとコピーになり契約が逆転するため、
  この順序（`into` の return が先）は必須。正しく先に置かれている。

### 2. キャッシュヒット経路 — `staleRecord` / backfill put / self-heal と `IntoCapacityError`

**分岐は正しい。ADR §2 の記述だけが事実と異なる（G1-03）。**

- **記録ハッシュ判定は読み込みより前**（`core.ts:606-615`）: `recorded !== opts.sha256` なら
  `staleRecord = true` にして `cached.body?.cancel()` — **器には一切書かない**まま evict
  （`core.ts:636-642`）→ network（同じ器へ先頭から書く）。器の汚染も無駄読みも無い。
- **`IntoCapacityError` の passthrough は 1 箇所だけ**（`core.ts:632`）。ADR 0009 §2 は「2 つの
  catch」と書くが、2 つ目（`core.ts:666` の bare `catch {}`）が包む `checkAndDecode` と backfill put は
  `IntoCapacityError` を投げ得ないので**到達不能**。現時点で欠陥ではないが、bare catch は将来の
  取りこぼしを黙って evict に変換する構造なので G1-03 として起票した。
- **backfill put**（`core.ts:651-664`）: `cachedBytes` が器の view でも
  `storableResponse(cachedBytes, opts.sha256)` → `await cache.put` で**同期的に完結してから**
  return する（`core.ts:665`）ので、呼び出し側へ制御が戻る前に格納が終わっている。器の上書き競合は
  単独呼び出しでは起きない（並列誤用時のみ — G1-01）。
- **self-heal（`core.ts:666-675`）と `into`**: 器へ読み込み済みのバイトが validate/sha256/decode で
  拒否されると evict → フォールスルーして network が**同じ器へ先頭から**書き直す
  （`core.ts:688-694`）。`cachedBytes` の参照は捨てられるだけでエイリアス問題は起きない。
- **エントリ温存の契約**: 容量不足でヒット経路が落ちるとき、`core.ts:632` の再 throw は
  `cache.delete` にも network にも到達しない（`staleRecord` 分岐にも `cachedBytes !== undefined`
  分岐にも入らず、関数から抜ける）。既存テストが「エントリは健在・network 呼び出し 0・
  `onCacheError` 通知なし」を凍結している。**契約どおり。**ただしこの温存は、エントリ側が
  壊れて長すぎる場合に恒久スタックを生む（G1-02）。

### 3. `sha256HexNative` の `isTightView` → `hasArrayBufferBacking`

**Web 標準として正しい（仕様保証。実装挙動依存ではない）。**

`crypto.subtle.digest(algorithm, data)` は W3C WebCrypto で「data パラメータが保持するバイト列の
**コピーを取得した結果**を data とする」と定義され、その「バイト列のコピーを取得する」操作は
WebIDL 側で定義されている。ArrayBufferView に対しては `[[ViewedArrayBuffer]]` の
`[[ByteOffset]]` から `[[ByteLength]]` バイトだけを取り出す — つまり**view の範囲だけがハッシュ
対象**になる。したがって `into.subarray(0, n)` をそのまま渡してよい（`core.ts:489-495`）。

SharedArrayBuffer 背面を弾く必要があるのも正しい: WebCrypto の `BufferSource` は `[AllowShared]`
指定が無いため、SAB 背面の view を渡すと TypeError になる。`hasArrayBufferBacking`
（`core.ts:480-482`）は `bytes.buffer instanceof ArrayBuffer` のみを見るので、SAB 背面だけが
コピー経路（`new Uint8Array(bytes)`）へ回る。型述語 `bytes is Uint8Array<ArrayBuffer>` の主張は
「背面が ArrayBuffer」だけで、byteOffset/長さについては何も主張していないので**嘘になっていない**
（旧 `isTightView` は述語名と条件が一致していたが、条件が過剰だった）。

**純 TS sha256（`src/sha256.ts`）への影響: 無し。** 呼ばれるのは `prefetchUrl` の通過中検証だけで
（`core.ts:1051`, `core.ts:1095`）、prefetch は `into` を受け取らない。なお `update` は
`chunk.subarray(...)` と `compress(state, schedule, chunk, offset)` の添字アクセスで実装されており
全て view 相対なので、仮に部分ビューが渡っても正しく動く（今回は経路が無い）。

### 4. `storableResponse` → `new Response(view)` → `cache.put` の安全性

**安全。ただし根拠は「Response 構築時のコピー」ではなく「`await cache.put` の完了」にある。**

- `storableResponse`（`core.ts:464-474`）は **BufferSource を Response に渡していない** — 
  1 チャンクの `ReadableStream` に `enqueue(bytes)` して渡す。WHATWG fetch の「extract a body」は
  BufferSource なら「object のバイト列の**コピー**」を取るが、ReadableStream の場合は
  ストリームをそのまま body にするだけで**コピーしない**。これは 512MiB で RSS +512MiB を避ける
  ための意図的な設計（`core.ts:457-462` のコメント）。したがって「Response 構築でコピーされるから
  安全」という根拠は**成り立たない**。
- 実際の保証は `await cache.put(...)`（network 経路 `core.ts:704`、backfill 経路 `core.ts:657`）。
  Service Workers 仕様の `Cache.put` は response の body を**全て読み切ってから**バッチ更新して
  resolve する。つまり put の resolve は「バイト列がストレージ側へ取り込まれた」ことを含意する。
  この前提はこのライブラリで既に load-bearing でもある — `prefetchUrl` は「stream を error にすれば
  `cache.put` ごと reject する」という同じ性質に依存している（`core.ts:1103-1122`）。
- **したがって、呼び出し側が戻り値を受け取った後に器を上書きしても cache 内容は壊れない**:
  `fetchBytesWithKey` が値を返すまでに put は await 済みで、その間に制御が呼び出し側へ渡ることは
  ない（唯一の例外が並列誤用 — G1-01）。
- **仕様保証でなく実装挙動に依存している箇所**: put の resolve タイミングは仕様上明確だが、
  「ReadableStream に載せると実装が全量コピーしない」という RAM 上の利点の方は実装挙動
  （`core.ts:457-462` に Deno 2.9.4 の実測として明記済み）。正しさには関与しない。

### 5. `Uint8Array<ArrayBuffer>` を公開 API に置くことの利用者影響

**方向は正しいが要件が未文書（G1-05）。** 詳細は同指摘に記載。要点だけ再掲:
公開 API での初出（それ以前は内部のみ — `core.ts:315/363/364/366/600`）／TS 5.7+ 必須／
`new Uint8Array(n)` は TS 5.7+ で `Uint8Array<ArrayBuffer>` に推論されるので素直な確保は通る／
素の `Uint8Array`（= `ArrayBufferLike`）は代入不可／締めた側から始めたのはリリース済み
パッケージとして正しい（緩めるのは非破壊、締めるのは破壊的）。

### 6. HF 層 — `fetchHfFiles` × 同一バッファ、`expectedBytes` 完全長検証との相互作用

- **転送は正しい**: `spec.into` → cache 層 `into` へそのまま流す（`hf/mod.ts:241`）。
  `prefetchHfFile` は `spec.sha256` しか見ない（`hf/mod.ts:351-359`）ので「prefetch は `into` を
  見ない」契約は**構造的に**守られている（`HfPrefetchOptions` に `into` は無い）。
- **`expectedBytes` の完全長検証との相互作用は整合的**（`hf/mod.ts:197-206`）:
  HF 層の `expectedBytes` は `bytes.length !== spec.expectedBytes` で完全長を検証する。
  `into` 指定時の `bytes` は prefix view で `length` = 実受信長なので、検証の意味は変わらない。
  かつ cache 層の入口ガード（`core.ts:804-814`）が `expectedBytes > into.length` を network 前に
  弾くので、「器に入らないと分かっている申告」で帯域を捨てることはない。HF テストが
  `sha256 + expectedBytes + into` の 3 点セットを network とヒットの両方で凍結している。
- **同一バッファ × 複数 spec は文書どおり「動かない」が、帰結が文書より重い**（G1-01）:
  `fetchHfFiles` は `Promise.all` の**並列**（`hf/mod.ts:380-387`）なので、実際には戻り値の
  上書きだけでなくチャンク単位の交錯が起き、稀に記録ハッシュ付きの不整合エントリを残しうる。

---

## 重要経路の ASCII 図（実行番号つき）

```
fetchBytes(url, { into, sha256?, expectedBytes?, decode? })
│
├─① fetchBytesWithKey: 入口ガード                       core.ts:760-814
│    ・URL 正規化 / 非 GET 拒否 / sha256 形式 / recheck 単独
│    ・into && expectedBytes > into.length → IntoCapacityError  ← network に出ない
│
├─② cache:false なら合流せず acquireAndDecode へ直行     core.ts:817-827
│
├─③ single-flight                                       core.ts:831-882
│    ├─ 合流者（entry あり）                             core.ts:832-855
│    │    ③a followers += 1                （同期・await 前）  :834
│    │    ③b raw = await entry.promise      （leader の共有物）  :841
│    │    ③c into あり → raw.length > into.length なら throw    :844-850
│    │            ← エントリは leader が put 済みで健在
│    │    ③d into.set(raw); raw = into.subarray(0, raw.length)  :851-852
│    │    ③e checkAndDecode(raw, 自分のオプション)              :854
│    └─ leader（entry なし）→ ④
│
├─④ acquireAndDecode                                    core.ts:576-710
│    ├─④a cache.open（失敗 → onCacheError → 素の fetch へ）      :591-597
│    ├─④b cache.match                                          :604
│    │    ├─ 記録 ≠ 期待 → staleRecord / body.cancel（器は無傷） :611-615
│    │    └─ それ以外 → into なし: arrayBuffer()                :620
│    │                  into あり: readBody(cached,…,into) ─→ ⑤ :621-627
│    │    catch: IntoCapacityError は再 throw（縮退しない）      :632
│    │           それ以外は onCacheError("match") → network へ   :634
│    ├─④c staleRecord → cache.delete → network へ               :636-642
│    ├─④d ヒット成立                                            :643-676
│    │    ・trusted = sha256 && recorded === sha256 && !recheck  :648-649
│    │    ・checkAndDecode（器の prefix view で検証）            :650
│    │    ・記録なし & sha256 一致 → backfill put（await 済み）  :656-663
│    │    ・catch{}（bare）→ evict → フォールスルー（self-heal） :666-675
│    ├─④e fetch → !ok なら body.cancel + throw                  :679-687
│    ├─④f readBody(response,…,expectedBytes, into) ─→ ⑤        :688-694
│    ├─④g checkAndDecode（失敗 = throw・put しない）            :697
│    └─④h storableResponse(bytes) → await cache.put            :698-708
│              ↑ bytes は器の view。コピーは起きない。
│                await 完了 = 取り込み済み（Cache.put の仕様）。
│
├─⑤ readBody                                            core.ts:358-446
│    ├─⑤a into あり → buffer = into（確保しない）               :367-368
│    │      （expectedBytes / content-length の確保経路は不通）  :369-386
│    ├─⑤b body === null → arrayBuffer() → 超過なら throw        :388-400
│    │                     → into.set(bytes) → prefix view      :401-402
│    ├─⑤c streaming ループ                                     :407-432
│    │      loaded + value.length > buffer.length ?
│    │        into あり → reader.cancel() → IntoCapacityError   :412-419
│    │        into なし → 蓄積経路へ引き継ぎ                    :421-424
│    │      それ以外 → buffer.set(value, loaded)                :426
│    └─⑤d return into.subarray(0, loaded)（tight 化しない）     :434
│
└─⑥ leader の共有と後始末                               core.ts:883-906
     ⑥a shared.resolve(into && followers > 0 ? raw.slice() : raw)  :895-897
     ⑥b return decoded                                             :898
     ⑥c finally: inflight.delete(storageKey)                        :905
        ★ ⑥a→⑥c の間に await が無い＝合流者が割り込めない（証明）
```

**⑥a〜⑥c に await が無いことの意味（TOCTOU の棄却）**: 合流者の登録は
`inflight.get` → `followers += 1`（`core.ts:831-834`）が同期区間で、その前に await は入らない。
一方 leader 側は `shared.resolve(...)` → `return decoded` → `finally` の `inflight.delete` が
同期的に連続する（async 関数の `try` 内 `return` は、関数の promise が settle する前に `finally` を
同期実行する）。したがって「`followers` を読んだ後・エントリ削除の前」に新しい合流者が
入り込む隙間は存在せず、**leader の生バッファが合流者へ漏れる経路は無い**。
逆に、`acquireAndDecode` の settle 後・leader の継続再開前に合流した呼び出しは `followers` に
確実に数えられる（削除がその後だから）ので、コピーの取りこぼしも無い。
なお旧実装は `inflight.delete` を `acquireAndDecode(...).finally()` に置いていたため削除が
1 マイクロタスク早く、今回の順序変更は `followers` の判定を正しくするために**必要**である。

---

## 横断所見

1. **「呼び出し側の行儀に依存する不変条件」の線引きが 2 箇所で食い違う。**
   `prefetchUrl` は「記録の健全性を呼び出し側の行儀に依存させない」として通過中検証のチャンクを
   複製する（`core.ts:1087-1091` の MUST）。一方 `into` 経路では、同じ「記録付き不整合エントリ」の
   生成可能性が呼び出し側の契約遵守に委ねられている（G1-01）。`validate` / `decode` の
   raw 非破壊 MUST NOT（`core.ts:32-36`, `core.ts:109-110`）と同じ流儀と言えなくもないが、
   **prefetch 側だけがコストを払って守っている**のは非対称。どちらの線に揃えるかを一度決めると、
   将来の似た判断（例: 0.6.0 の revalidate）で迷わない。

2. **`into` は「縮退しない」オプションであり、self-heal の射程を狭める。**
   このライブラリの回復力は「疑わしきは evict → 真実源から取り直す」に集約されているが、
   `into` の容量判定はその手前で発火するため、ヒット経路の一部で self-heal が届かなくなる
   （G1-02）。`into` が「性能オプション」ではなく「**回復戦略にも影響する**オプション」であることは、
   ADR 0009 にも limitations にも書かれていない。文書の一段目に置く価値がある。

3. **エラーの分類は増えたが、公開面は増えていない。**
   `IntoCapacityError` は「破損でも cache I/O 失敗でもない第 3 のクラス」として内部的に導入された
   のに、呼び出し側からは `error.name` の文字列でしか見えない（G1-09）。fail loud を掲げる
   ライブラリとしては、分類がユーザーに届いていない。

4. **テストは契約の主要面を的確に凍結している。**
   特に「容量不足で `pulled() === 2`（超過チャンクで停止）・`cancelled() === true`・
   `listCachedUrls() === []`」「ヒット容量不足で network 0 回・`onCacheError` 空・エントリ健在」
   「leader の器を fill(0) しても合流者の手元が変わらない」の 3 本は、ADR の主張を直接検証していて
   質が高い。残るギャップ（G1-14）は分岐カバレッジの穴であって、契約解釈の穴ではない。

5. **ADR と実装の同期が 2 箇所でずれた**（0009 §2 の「2 つの catch」= G1-03、0004 の
   「同じ raw インスタンス」= G1-07）。どちらも今回の差分が生んだずれなので、
   0.6.0 を待たずこの差分の一部として直すのが筋。
