---
id: G2
topic: 並行性と所有権（single-flight リファクタ / `into` = 呼び出し側バッファの所有権・エイリアシング）
files_reviewed:
  - src/core.ts
  - src/hf/mod.ts
  - src/mod.test.ts
  - src/hf/mod.test.ts
  - docs/decisions/0009-into-caller-buffer.md
  - docs/decisions/0004-single-flight-raw-sharing.md
  - docs/limitations.md
  - README.md
commit: 3b13d16
date: 2026-09-02
model: opus
---

# G2 — 並行性と所有権

## サマリ

**総評**: single-flight のリファクタ（`{raw, decoded}` の promise → `Promise.withResolvers` +
`followers` カウンタ）そのものは並行性の観点で**健全**。今回のレビューで狙った 6 つの失敗形状
（lost wakeup / 合流の TOCTOU / 二重 resolve / 未処理拒否 / 自己デッドロック / エイリアシングに
よる上書き）は、単一呼び出し側が契約どおり**逐次**に `into` を使う限りすべて棄却できた。
`shared.resolve → return → finally(inflight.delete)` は 1 つの同期区間に収まっており、
「resolve 済みだが Map にまだ居る」窓は存在しない。`followers` は resolve 時点の合流済み数を
正確に表す。

ただし `into` は「呼び出し側が所有するメモリをライブラリの内部経路（sha256 → validate/decode →
`cache.put`）に貫通させる」という新しい種類の口であり、**その所有権契約が破れたときの被害が
文書の記述より重い**。具体的には、同じバッファを別キーの並行呼び出しへ渡すと
「記録ハッシュ付きの不正エントリは構造的に生まれない」（ADR 0005 §5）という不変条件が破れる。
`fetchHfFiles` が `Promise.all` で spec を並列に走らせる以上、この誤用は API の形が誘発する。
ここが本レビューの最重要指摘（G2-01）。

**重大度別件数**（全 9 件 — 全件報告。改善提案は low として区別）

| 重大度 | 件数 | ID |
| --- | --- | --- |
| 🔴 Critical | 0 | — |
| 🟠 Warning | 2 | G2-01 / G2-02 |
| 🟡 Minor | 5 | G2-03 / G2-04 / G2-05 / G2-06 / G2-08 |
| 🔵 Info・改善提案（low） | 2 | G2-07 / G2-09 |

## ファイル別分類

| ファイル | 判定 | 根拠 |
| --- | --- | --- |
| `src/core.ts` `fetchBytesWithKey` leader 部（857-906） | 🟢 | resolve → return → finally(delete) が単一同期区間（883-906 に `shared.resolve` 以降の `await` が無い）。全 throw 経路が `finally` を通り `inflight` を閉じる。二重 settle 経路なし |
| `src/core.ts` `fetchBytesWithKey` 合流部（831-855） | 🟡 G2-03 | `followers += 1`（834）の正しさが「関数入口〜834 に `await` を挟まない」同期区間不変条件に依存するが、その MUST が未記載（leader 側 857 にはある） |
| `src/core.ts` `shared.promise.catch(() => {})`（875） | 🟢 | 派生 promise を捨てるだけで元の promise の reject は全 reaction へ届く。合流者ゼロ時の未処理拒否のみを黙らせ、leader 自身は 899-901 で必ず rethrow |
| `src/core.ts` `raw.slice()` 判定（895-897） | 🟠 G2-04（メモリ）/ 🟢（正しさ） | `opts.into !== undefined` は「raw が呼び出し側メモリを指す」と厳密に同値（下記 §2 参照）。コピーは `resolve` の引数評価 = 同期で完了 |
| `src/core.ts` `readBody` の `into` 経路（358-446） | 🟠 G2-02 / 🟡 G2-05 | 容量超過 throw が leader 経由でフライト全体を落とす。throw 時に器が途中まで書き潰される点が未文書 |
| `src/core.ts` キャッシュヒット `into` 経路（617-635） | 🟢 | `IntoCapacityError` の素通し（632）で self-heal にも network 縮退にも乗らない。`onProgress` は `undefined` 固定でヒット時無通知の契約を維持 |
| `src/core.ts` backfill put（651-664） | 🟢 | `await cache.put` は body 読み切りまで待つ（Cache API 仕様）。逐次契約下で呼び出し側は suspend 中のため器は書き換わらない |
| `src/core.ts` `hasArrayBufferBacking` / `sha256HexNative`（476-500） | 🟡 G2-06 / 🔵 G2-07 | 部分ビュー許容は WebCrypto 仕様どおりで正しい。SAB 背面の実行時ガードが無い / digest 自体はコピーを取るのでピーク 2N は残る |
| `src/core.ts` `emit` / `isolateProgress`（859-870・553-566） | 🟢 | a58c79e の snapshot 反復（869 `[...listeners]`）が維持されている。今回の変更は listeners / state に触れていない |
| `src/hf/mod.ts` `HfFileSpec.into`（70-81）→ `fetchResolvedFile`（241） | 🟠 G2-01 | 転送は素通しで正しいが、`fetchHfFiles`（367-390）が `Promise.all` で並列実行するため「同じ器を複数 spec へ」の誤用が構造的に届く |
| `src/mod.test.ts` into テスト群（1620-1872） | 🟡 G2-08 | 合流者側の容量不足（1841）は凍結済み。leader 側容量不足 × 合流者ありの非対称は未凍結 |
| `src/hf/mod.test.ts`（814-841） | 🟢 | 転送経路（network / ヒット両方で prefix view）の凍結として妥当 |
| `docs/decisions/0009` §3 | 🟡 G2-04 | コピーの同期完了の証明は正しい。コピーの**サイズ**（= `into` の目的が並行 1 本で崩れる）が Consequences に無い |
| `docs/limitations.md`（41-49） | 🟠 G2-01 / 🟡 G2-05 | 「戻り値同士が上書きし合う」は被害を過小評価（実害は記録付き不正エントリ）。容量不足時の器の状態も未定義 |
| `README.md`（211-243） | 🟢 | 逐次ループの用例・fail loud・合流者非共有の記述は実装と一致 |

---

## 詳細指摘

### G2-01 🟠 Warning — 同じ `into` を別キーの並行呼び出しへ渡すと、記録ハッシュ付きの不正エントリが生まれ得る

**質問**: `into` の「同じバッファを渡し回す」用途で、逐次ではなく**並行**に使われたときの被害を
「戻り値同士が上書きし合う」で済ませてよいか。それとも `fetchHfFiles` で機械的に弾くか。

**概要**

`into` を渡すと、`checkAndDecode`（sha256 → validate → decode）も `cache.put` も、
**呼び出し側が所有し呼び出し側がいつでも書けるメモリ**を読む。逐次利用では呼び出し側が
`await` で止まっているため安全だが、同じバッファを**別キーの並行フライト**へ渡すと以下が起きる。

発生条件（キーが違うので single-flight では合流しない = 2 本のフライトが同時に走る）:

1. F1 = `fetchBytes(urlA, { into: B, sha256: hA })`、F2 = `fetchBytes(urlB, { into: B, sha256: hB })`
   を同時に開始。
2. 両方の `readBody` が `B` の先頭へチャンクを書く（`core.ts:410-431`）。書き込みは
   `await reader.read()` を挟むので**インターリーブする**。
3. F1 の `sha256HexNative(B[0..n1])` が走った瞬間に `B` が F1 の内容だった場合、検証は**通る**
   （WebCrypto は呼び出し時点でバイトのコピーを取るため、以後の書き換えは digest に影響しない）。
4. 続く `await cache.put(storageKey, storableResponse(bytes, opts.sha256))`（`core.ts:701-704`）が
   `B` を**その時点の内容で**読む。3 と 4 の間に F2 のチャンクが着地していれば、
   **記録ハッシュ `hA` を持つが中身は別物のエントリ**が成立する。

これは ADR 0005 §5 の「記録付きの不正エントリは構造的に生まれない」と、ADR 0006 §2 の
「記録一致のヒットは計算ゼロで信じる」（既定 `recheck: false`）の**両方を同時に破る**。
self-heal は記録と期待が一致する限り発火しないので、**汚染は恒久化**し、`clearCache` /
`evict` するまで壊れたバイトが返り続ける。`sha256` 未指定なら記録は焼かれないが、
インターリーブしたゴミがそのままキャッシュされる（この場合は読み出し側 `validate` があれば
self-heal で回復する）。

守っている目的: 「fail loudly」（CLAUDE.md）と「破損データを黙って握り潰さない」。現状はこの
誤用だけが**黙って**壊れる。

`fetchHfFiles` はこの誤用への導線そのものになっている: `HfFileSpec.into` はファイル毎の設定で、
`fetchHfFiles(ref, { a: specA, b: specB })` は `Promise.all` で並列に走る（`src/hf/mod.ts:380-387`）。
「1 本の器を使い回す」という `into` の売り文句を素直に読むと、`specA.into === specB.into` は
自然な書き方であり、現状の防御は doc コメント 1 行（`src/hf/mod.ts:76-78`）だけ。

**選択肢**

- a) ★ `fetchHfFiles` で spec 群の `into` の**同一性を同期検査**し、重複したら
  `toSpec` と同じ位置（revision 解決より前）で throw する。`Set` への `spec.into` 参照追加で
  O(n)、実行時コストは無視できる。同時に `docs/limitations.md:47-49` と
  `src/hf/mod.ts:76-78` の文言を「戻り値が上書きし合う」から「並行実行なので受信そのものが
  インターリーブし、記録ハッシュ付きの不正エントリが成立し得る」へ差し替える。
- b) 文書のみ強化（`limitations.md` と `HfFileSpec.into` の doc に MUST NOT を明記し、
  cache 層の `into` doc にも「MUST NOT: 同じバッファを並行呼び出しへ渡さない」を追加）。
  API での防止はしない。
- c) 現状維持（呼び出し側の契約違反として扱う）。

推奨は a)。理由: ①同一 buffer 参照の検査は完全に機械的で誤検知が無い（`Object.is` 相当の
参照比較）②この層は「呼び出し側の申告ミスを network に出る前に弾く」（`expectedBytes` >
`into.length` の入口ガード `core.ts:804-814`、非 GET ガード、sha256 形式ガード）という
既存の一貫した流儀を持っており、a) はそこに素直に並ぶ ③破れる不変条件（記録と内容の整合）が
このライブラリの中心的な安全性の主張であり、blast radius が「恒久的に壊れたキャッシュ
エントリ」= 回復に `clearCache` が要る不可逆側。なお cache 層（`fetchBytes`）側は呼び出しが
独立しているため同種の機械的検査ができない（グローバルな「使用中バッファ台帳」を持つのは
過剰）ので、そちらは b) の文書強化に留めるのが妥当。

**リスク**: a) は `fetchHfFiles` に新しい throw を足す（追加ガードなので非 breaking だが、
同じ器を渡して「たまたま動いていた」呼び出しは赤くなる。未リリース機能なので実害なし）。
c) は現状の穴が残る。

**対象**: `src/hf/mod.ts:70-81`（`HfFileSpec.into` doc）/ `src/hf/mod.ts:367-390`
（`fetchHfFiles` の `Promise.all`）/ `src/core.ts:129-146`（`into` doc）/
`src/core.ts:697-708`（digest → put の窓）/ `docs/limitations.md:41-49`

**影響範囲**: HF 層の複数ファイル取得を使う下流全体。キャッシュ内容の整合性（記録ハッシュの
信頼）という中心的な不変条件。

**引き継ぎ**: a) を採る場合、テストは「同じ `into` を 2 spec へ渡した `fetchHfFiles` が
revision 解決の fetch に出る前に throw する」（`calls.length === 0` の凍結）で足りる。
実際のインターリーブ汚染そのものは決定的に再現しにくいので凍結対象にしない判断が妥当。

---

### G2-02 🟠 Warning — leader の `into` 容量不足が合流者全員を巻き添えにする（合流者側の失敗は隔離されているのに非対称）

**質問**: `IntoCapacityError` は「その呼び出しの申告ミス」なのに、leader で起きるとフライト
全員が失敗し network も無駄になる。この非対称を許容するか、leader 経路だけ縮退させるか。

**概要**

`into` の容量不足は ADR 0009 §2 の定義どおり「呼び出し側の申告ミス」であり、
`cache I/O 失敗でも破損でもない」。実際、**合流者**側でこれが起きたときは
その呼び出しだけが throw し、leader のエントリは健在（`src/core.ts:842-853`、
テスト `src/mod.test.ts:1841-1863` で凍結済み）。

ところが **leader** 側で起きると:

- network 経路（`core.ts:410-420`）: 超過チャンクで `reader.cancel()` → `IntoCapacityError` →
  `acquireAndDecode` を素通り → `fetchBytesWithKey` の `catch`（`core.ts:899-901`）で
  `shared.reject(error)`。**器が十分に大きい / そもそも `into` を渡していない合流者まで**
  `IntoCapacityError` で落ちる。しかも body は cancel 済みでキャッシュも成立しないので、
  合流者にとっては「他人の器が小さかったせいで自分の取得が失敗し、帯域も無駄になった」。
- キャッシュヒット経路（`core.ts:617-632`）: 同じく全員が落ちる。こちらは network に出ないので
  帯域の損はないが、健在なエントリがあるのに全員が失敗する。

ADR 0004 §4 の「取得失敗は合流全員へ伝播する」は**取得（network / cache I/O）の失敗**を
指した規定で、`into` のような**呼び出し側ローカルな**失敗は想定外。ADR 0009 §3 も
「合流者へ leader のバッファは渡さない」までしか書いておらず、逆向き（leader の器の問題が
合流者へ伝播する）には触れていない。

守っている目的: fail loud（縮退させない）。ただし「誰に対して loud か」の宛先がずれている。

**選択肢**

- a) ★ 現状維持 + 文書化。`docs/limitations.md` の `into` 項と ADR 0009 §3 に
  「leader の容量不足はフライト全員へ伝播する（合流者ローカルの容量不足だけがその呼び出しに
  留まる）」を明記し、`single-flight` の limitations 項（`limitations.md:7-17`）の
  「取得失敗は合流全員へ伝播する」に `into` の容量不足を含む旨を添える。
- b) leader の容量不足を検知したら、その leader だけ throw し、合流者のために
  フライトを引き継ぐ（＝合流者の 1 人を新 leader に昇格させて再取得する）。
- c) leader が `into` を持ちかつ合流者が居るときは、そもそも器へ直接書かず内部バッファへ受けて
  最後に leader の器へ写す（＝合流者が居る時点で `into` の zero-alloc をあきらめる）。

推奨は a)。理由: ①b) は「フライトの引き継ぎ」という新しい状態機械（誰が新 leader か・進捗
リスナーの移譲・二重 network 発火の防止）を持ち込み、single-flight の「ロック不要・
マイクロタスク意味論のみに依存」（ADR 0004 帰結）という設計上の強みを直接壊す
②c) は `into` の存在意義（確保ゼロ）を、外から観測できない条件（誰かが合流したか）で
静かに取り下げることになり、G2-04 と同じ「性能特性が並行度で非決定になる」問題を悪化させる
③この失敗は呼び出し側のバグであり、正しい器サイズを渡せば消える。恒久的な破損も残らない
（キャッシュは温存され、次回の呼び出しで普通に成功する）ので、回復可能な側の誤り。

**リスク**: a) は穴を残すのではなく「仕様として明記する」選択。並行呼び出しで器サイズが
不揃いな運用（例: 下流が複数の shard サイズで同じ URL を叩く）では、たまたま先に来た
呼び出しの器サイズがフライト全体を決めることになる。この非決定性は文書に書く価値がある。

**対象**: `src/core.ts:410-420`（network 経路）/ `src/core.ts:617-635`（ヒット経路）/
`src/core.ts:899-901`（`shared.reject`）/ `docs/decisions/0009-into-caller-buffer.md:50-58` /
`docs/limitations.md:7-17`・`41-49`

**影響範囲**: 同一キーへ並行に `fetchBytes` する下流（yomi の `getDictionary` 再入、
HF 層の同一内容キー並行取得）。

**引き継ぎ**: a) を採るなら G2-08 のテスト追加（leader 容量不足 × 合流者ありの伝播を凍結）と
セットにすると、以後この非対称が「意図」だと分かる。

---

### G2-03 🟡 Minor — `followers` カウンタの正しさが依存する同期区間の MUST が未記載

**質問**: leader 側（`core.ts:857-858`）にある「ここから `inflight.set` まで `await` を挟まない
MUST」と同じ強度のコメントを、合流側（関数入口 → `followers += 1`）にも置くか。

**概要**

`followers` は「resolve 時点で合流済みの数」を表す必要があり（それが `raw.slice()` するか
どうか = **メモリ安全性**の判定になる）、その正しさは次の 2 点だけで成り立っている:

1. `fetchBytesWithKey` の関数入口から `inflight.get`（`core.ts:831`）→ `followers += 1`
   （`core.ts:834`）まで `await` が 1 つも無い。`async` 関数は最初の `await` まで**呼び出し側の
   同期区間で**走るので、合流を決めた呼び出しは必ずその場でカウントを済ませる。
2. leader 側で `shared.resolve`（895）と `inflight.delete`（905）が同一同期区間にある
   （`try` の `return` 式評価 → `finally` は同期実行）ため、「resolve 後・delete 前に合流する」
   窓が存在しない。

1 は現在の実装では成立している（入口から 831 までは `normalizeUrl` / method ガード /
`serializeKey` / sha256 形式ガード / `into` × `expectedBytes` ガードで、いずれも同期）。
しかしこれは**偶然ではなく守るべき不変条件**で、例えば将来 `crypto.subtle` の有無検査を
非同期化したり、キー生成に `await` の入る正規化を足した瞬間に、`followers` が過少に数えられて
**leader が `raw.slice()` を省き、合流者が leader の呼び出し側バッファを掴む**という
サイレントなメモリ破壊に化ける。今の 857-858 のコメントは「二重フライトになる（TOCTOU）」
という**性能上の**理由しか述べていない。

守っている目的: 「atomic only by accident」な区間を名指しする（CLAUDE.md の並行性規律）。

**選択肢**

- a) ★ `core.ts:831` の直前に MUST コメントを追加する。文面案:
  「MUST: 関数入口からここ（`followers += 1`）まで `await` を挟まない — 挟むと合流が
  leader の `raw.slice()` 判定より後にずれ込み、合流者が leader の呼び出し側バッファを
  掴む（`into` 使用時のメモリ破壊）。二重フライト（TOCTOU）だけでなく所有権の問題でもある。」
  併せて 857-858 の既存コメントにも「`shared.resolve` と `inflight.delete` が同一同期区間で
  あることが合流の窓を閉じている」を 1 行足す。
- b) 何もしない（コードを読めば分かる）。

推奨は a)。この commit で `followers` が導入されるまで、この同期区間は「二重 DL を防ぐ」
性能上の性質でしかなかった。今は**安全性**の性質になったので、格上げをコメントに反映すべき。

**リスク**: なし（コメントのみ）。

**対象**: `src/core.ts:829-834`（合流部）/ `src/core.ts:857-858`（既存 MUST）/
`src/core.ts:876-882`・`902-906`

**影響範囲**: 保守（将来の変更で壊れたときの検知）。

**引き継ぎ**: 同じ不変条件は `docs/decisions/0009` §3 の「コピーは leader の呼び出し側へ制御が
戻る前に同期で終わる」の裏返しなので、ADR 側にも 1 文添えると対になる。

---

### G2-04 🟡 Minor — 合流者が 1 人でも現れると `into` のピーク 1N 保証が崩れ、大サイズでは成功した取得が RangeError で throw に転ぶ

**質問**: `raw.slice()` のサイズ（= 数百 MiB〜数 GB）と、その確保が落ちたときに
「ダウンロードも検証もキャッシュも成功済みの leader が throw する」ことを、
ADR 0009 の Consequences に明記するか。

**概要**

`core.ts:895-897` の `raw.slice()` は N バイトの新規確保である。`into` の存在理由は
「呼び出し毎の確保をゼロにしてピークを 1 本ぶんに抑える」（ADR 0009 Context の実測: 1.05GB →
0.45GB）だが、**同一キーへの並行呼び出しが 1 本入るだけで、そのフライトだけピークが 2N に戻る**。
ADR 0009 Consequences は「合流者ぶんのコピーは 1 回きり」と書いているが、それが
「`into` で消したはずの N バイト確保が復活する」ことだとは読めない。

さらに `raw.slice()` が RangeError で落ちた場合（Chromium の単一 ArrayBuffer 上限
2,145,386,496 バイト付近、あるいは単に空きが無い）:

- `shared.resolve(...)` は呼ばれず、例外が `try` を抜けて `catch`（899-901）へ入り、
  `shared.reject(error)` → leader も合流者も throw。
- しかし `acquireAndDecode` は既に完了しており、**`cache.put` は成功している**
  （`core.ts:698-708`）。つまりバイトは取れて検証も通り格納も済んだのに、
  「合流者が居た」という leader からは見えない理由で失敗が返る。
- 救いは、次の呼び出しがキャッシュヒットになること（帯域は捨てない）。

これは ADR 0007 が扱った「確保失敗は遅らせず fail loud」と方向は同じだが、
**受信前に弾けない**（合流者の有無は受信完了時まで確定しない）点が違う。

守っている目的: 合流者へ呼び出し側所有メモリを渡さない（ADR 0009 §3）。この目的自体は正しく、
コピー以外の実現手段は「合流者を待たせて leader の器を借りる」しかなく、それは所有権契約と
矛盾する。したがって**設計は正しく、記述が足りていない**という指摘。

**選択肢**

- a) ★ ADR 0009 Consequences と `docs/limitations.md:41-49` に
  「同一キーへ並行呼び出しが入ったフライトでは、そのフライトに限り N バイトのコピーが 1 回
  発生する（＝ピークは 2N に戻り、確保が落ちれば取得は成功していても throw する。
  再試行はキャッシュヒットになる）」を明記する。README の `into` 節にも 1 文。
- b) `raw.slice()` の失敗を握って、合流者にだけ「コピーできなかった」旨の専用エラーを配り、
  leader は成功させる（leader の結果は器の中に正しく入っているため）。
- c) 現状維持。

推奨は a)。b) は挙動としては筋が良い（leader の成功を合流者の都合で潰さない）が、
`shared.reject` に「取得は成功したが共有できない」という**新しいエラー種別**を持ち込むことになり、
ADR 0004 §4「取得失敗は合流全員へ伝播」の単純な意味論に例外を刻む。0.6.0 の設計課題として
挙げるのは妥当だが、この commit の範囲では文書化が正しい落とし所。

**リスク**: a) は挙動を変えないので無い。b) は G2-02 と同じ「フライトの部分成功」という
状態を持ち込む。

**対象**: `src/core.ts:890-897` / `docs/decisions/0009-into-caller-buffer.md:50-58`・`66-75` /
`docs/limitations.md:41-49` / `README.md:219-243`

**影響範囲**: 数百 MiB 級の shard を扱う下流（karume / sbv2-web）で、UI の再入などにより
同一 shard へ並行呼び出しが入る運用。

**引き継ぎ**: b) を将来検討するなら、G2-02 の b) と同じ「フライトの部分成功」設計に含めて
1 本の ADR で扱うのがよい。

---

### G2-05 🟡 Minor — 容量不足で throw したとき、呼び出し側の器が途中まで書き潰されている点が未文書

**質問**: `IntoCapacityError` で throw したあとの `into` の内容を「未定義（先頭から一部が
書き換わっている）」と明記するか、それとも「throw 時は器に触れない」を保証するか。

**概要**

`readBody` は容量超過を**検知したチャンクで**止める（`core.ts:411-420`）。つまりそれまでの
チャンクは既に `buffer.set(value, loaded)`（427）で器へ書き込まれている。したがって
`IntoCapacityError` を受けた呼び出し側の器は、**先頭から `loaded` バイトが前回の内容から
書き換わった**状態で返る。キャッシュヒット経路（`core.ts:617-627` 経由の `readBody`）も同じ。

現在の文書（`docs/limitations.md:44-47`、ADR 0009 §2、README 235-243）は
「network は打ち切ってキャッシュしない / ヒットはエントリを消さない」までしか言っておらず、
**器の状態**には触れていない。「同じ器を渡し回す」用途では、前の読み出し結果がまだ器に
入っている状態で次の呼び出しが失敗すると、呼び出し側が「失敗したから前の値は残っている」と
仮定してリカバリを書くのは自然な誤解であり、そこで壊れる。

守っている目的: 所有権契約（呼び出し側が器の状態を予測できること）。

**選択肢**

- a) ★ 「`IntoCapacityError` を含むあらゆる throw の後、器の内容は未定義（先頭から一部が
  書き換わっている可能性がある）」を `limitations.md` の `into` 項・`FetchBytesOptions.into`
  の doc・ADR 0009 §2 に明記する。
- b) throw 前に器を復元する（不可能 — 元の内容を保持していない）。
- c) 現状維持。

推奨は a)。b) は原理的に無理（復元用のコピーを持てば `into` の目的が消える）。

**リスク**: なし（文書のみ）。

**対象**: `src/core.ts:410-431`（書き込み → 検知の順序）/ `src/core.ts:129-146`（doc）/
`docs/limitations.md:41-49` / `docs/decisions/0009-into-caller-buffer.md:38-48`

**影響範囲**: 容量不足からのリカバリを書く呼び出し側。

**引き継ぎ**: 既存テスト `src/mod.test.ts:1742-1764` は「打ち切り・非キャッシュ」を凍結して
いるが、器の内容は見ていない。文書化に合わせて `into[0] !== 0` 相当の 1 行を足すと意図が固まる。

---

### G2-06 🟡 Minor — `into` に SharedArrayBuffer 背面の view が渡ったときの実行時ガードが無い

**質問**: 型（`Uint8Array<ArrayBuffer>`）だけで SAB を排除する現状でよいか、
入口で 1 行の fail loud ガードを置くか。

**概要**

`into?: Uint8Array<ArrayBuffer>`（`core.ts:146`）は TypeScript の型としては SAB 背面の view を
弾くが、①JS からの呼び出し ②`as` キャスト ③型を持たない境界（動的な spec 組み立て）では
素通りする。SAB が入った場合:

- `sha256HexNative` は `hasArrayBufferBacking`（`core.ts:480-482`）が false になるので
  コピーを取って digest する — **ここは正しく守られている**。
- しかし `cache.put` は `storableResponse` 越しに**生の SAB を読む**（`core.ts:701-704`）。
  他エージェント（Worker）が同時に書けば、G2-01 と同じ「記録ハッシュ付きの不正エントリ」が
  今度は**単一の呼び出しだけ**で作れる。
- `readBody` の `buffer.set(value, loaded)` も SAB へ書くので、他エージェントから途中経過が
  観測できる（そこは用途次第で意図的かもしれない）。

守っている目的: 記録ハッシュと内容の整合（ADR 0005 §5 / 0006 §2）。この層は
「呼び出し側の申告ミスは network に出る前に fail loud」という流儀を一貫して持っており、
SAB はその一種として扱えるのに、今は型でしか止めていない。

**選択肢**

- a) ★ `fetchBytesWithKey` の入口ガード群（`core.ts:804-814` の隣）に
  `if (opts.into !== undefined && !(opts.into.buffer instanceof ArrayBuffer)) throw ...` を足す。
  既存の `hasArrayBufferBacking` をそのまま使えば 1 行 + メッセージ。
- b) 文書に「MUST NOT: SharedArrayBuffer 背面のバッファを渡さない」とだけ書く。
- c) 現状維持（型で十分とみなす）。

推奨は a)。理由: ①コストがゼロに近い（呼び出し 1 回につき `instanceof` 1 回）
②壊れ方が「恒久的に汚染されたキャッシュエントリ」で不可逆側
③このリポの他のガード（sha256 形式・非 GET・`expectedBytes` > 容量）と完全に同型で、
新しい概念を持ち込まない。

**リスク**: 将来「SAB 背面の器へ直接受信したい」正当な用途が出たときに緩める必要があるが、
そのときは `cache.put` 前のコピーとセットで設計すべきなので、ガードを置いておくほうが
議論の入口として正しい。

**対象**: `src/core.ts:146`（型）/ `src/core.ts:476-500`（既存ヘルパ）/
`src/core.ts:804-814`（入口ガードの並び）/ `src/core.ts:698-708`（put が生バッファを読む箇所）

**影響範囲**: JS からの利用・動的 spec 組み立て。TS のみの利用者には無影響。

**引き継ぎ**: 実装する場合、`hasArrayBufferBacking` を型述語のまま入口ガードへ流用すると
`opts.into` の型が絞られてしまう副作用があるので、素直に `instanceof` を直書きするほうが読める。

---

### G2-07 🔵 Info（severity: low） — `sha256` 併用時のピークは `into` を使っても 2N のまま（WebCrypto が仕様上コピーを取る）

**質問**: ADR 0009 §4 の「数 GB 級でコピー 1 回ぶんが効く」を、
「この層のコピーが消えるだけで、`digest` 自体のコピーは残る」と補足するか。

**概要**

`hasArrayBufferBacking` への緩和（`core.ts:476-482`）は正しい: WebCrypto の `digest` は
BufferSource の**view の範囲**を対象とし、部分ビューをそのまま受け付ける。
そして同じ仕様が「`digest(algorithm, data)` はまず `data` が保持するバイトの**コピー**を取る」と
定めており、これが `await` 中の書き換えから digest を守っている（G2-01 の手順 3 が
「検証は通る」になる理由でもある）。

その帰結として、`sha256` を指定した数 GB のファイルでは `digest` の内部コピー N バイトが
確保されるため、**`into` を使ってもそのフライトのピークは 2N** になる。ADR 0009 §4 の
「コピー 1 回ぶんが効く」は「この層が明示的に作っていたコピーが消える」という意味では正しいが、
`into` の RAM 目標（ピーク 1N）が `sha256` 併用時には成立しないことは読み取れない。

注記: 上記は W3C WebCrypto の仕様文（"get a copy of the bytes held by the buffer source"）に
基づく。Deno / 各ブラウザの実装がこのコピーを実際にどう最適化しているかは本レビューでは
未検証（実測は下流の研究記録側の仕事）。**この段落は仕様ベースの推論であり実測ではない。**

**選択肢**

- a) ★ ADR 0009 §4 と README の `into` 節に「`sha256` 併用時は WebCrypto の digest が
  仕様上バイト列のコピーを取るため、そのフライトのピークは 2N になる（コピーが消えるのは
  この層が作っていたぶん）」を 1 文添える。
- b) 現状維持。

推奨は a)（期待値の調整。下流は実測でこれに気づくが、先に書いてあるほうが良い）。

**リスク**: なし。

**対象**: `src/core.ts:476-500` / `docs/decisions/0009-into-caller-buffer.md:60-64` /
`README.md:219-234`

**影響範囲**: `into` の RAM 効果の見積もり。

---

### G2-08 🟡 Minor — 並行性まわりのテストギャップ（leader 側容量不足の伝播 / 進捗リスナー内合流 × `into`）

**質問**: 今回追加された 2 本（`src/mod.test.ts:1810`・`1841`）に加えて、
以下 2 つを凍結するか。

**概要**

追加された single-flight テストは「leader の器は合流者へ渡らない」「合流者の容量不足は
その呼び出しだけ」の 2 つを凍結しており、いずれも今回の設計判断の核心を突いていて良い。
一方、以下 2 つは**設計判断であって偶然ではない**のに凍結されていない。

1. **leader 側容量不足の伝播（G2-02 の非対称）**: leader の器が小さいとき、合流者が
   十分な器を持っていても（あるいは `into` を持たなくても）落ちる。1841 の裏返しであり、
   1841 と並べて置くと「非対称は意図」が読み取れる。テストは既存 1841 のミラーで書ける
   （`gate` で leader を止め、合流者を作り、leader の器だけ 2 バイトにする）。
2. **進捗リスナー内からの合流 × leader `into`**: 既存テスト `src/mod.test.ts:411`
   （二重通知の凍結）は leader の `onProgress` の中から合流者を作る。leader が `into` を
   持つ場合、この合流は `emit` の同期区間で `followers` を増やすので、`raw.slice()` が
   走ることになる。これは `followers` カウンタの「同期区間で数える」設計が効いている唯一の
   非自明な経路で、`assertEquals(follower の buffer === leaderInto.buffer, false)` で
   凍結できる。壊れると**サイレントなメモリ共有**になるので、赤で気づける価値が高い。

**選択肢**

- a) ★ 上記 2 本を追加する。
- b) 1 のみ追加（2 は 1810 の一般形として既にカバーされているとみなす）。
- c) 現状維持。

推奨は a)。特に 2 は「G2-03 の同期区間不変条件が壊れたとき赤くなる唯一のテスト」になる。
1810 は合流者を `await` の外（トップレベル）で作っているため、`followers` の
同期区間性が壊れても（例えば `followers += 1` の前に `await` が 1 つ入っても）
たまたま通ってしまう可能性がある。

**リスク**: なし（テスト追加）。テストは `deno task check`（逐次実行）で走らせること
（並列実行は固定名前空間の共有でハングする — CLAUDE.md）。

**対象**: `src/mod.test.ts:1810-1863`（追加済みの 2 本）/ `src/mod.test.ts:411-446`（流用元）/
`src/core.ts:834`・`895-897`

**影響範囲**: 回帰検知。

---

### G2-09 🔵 改善提案（severity: low） — 「合流者が全員自前の `into` を持つならコピー不要」という最適化は**採らないほうがよい**（棄却の記録）

**質問**: `followers` を「共有 raw を必要とする合流者数」（= `opts.into === undefined` の
合流者数）に絞れば、全員が自前の器を持つケースで `raw.slice()` を省ける。採るべきか。

**概要**

マイクロタスク順序を追うと、この最適化は**現在の実装では成立する**:
`shared.resolve` の時点で合流者の reaction job が先に enqueue され、leader の呼び出し側の
job はその後に enqueue される。合流者の `opts.into.set(raw)`（`core.ts:851`）は resume 直後の
同期文なので、**leader の呼び出し側が再開する前に全合流者のコピーが終わる**。
したがって「自前の器を持つ合流者」に限れば、leader のバッファを直接読ませても安全に見える。

しかし採るべきではない。理由:

1. 安全性が「`await` のホップ数」という極めて脆い性質に依存する。leader 側に
   `await` が 1 つ増えても、合流者側の `await existing.promise` が
   `await checkAndDecode(...)` 経由の別チェーンに変わっても、順序保証が崩れる。
2. 得られるのは「全合流者が自前の器を持つ」という稀なケースでのコピー 1 回の削減だけ。
   その条件では合流者側が結局 N バイトずつ書き込むので、総メモリ帯域は変わらない。
3. 壊れたときの症状が「合流者の手元が静かに書き換わる」= デバッグ不能なデータ破損。
   CLAUDE.md の「irreversibility と blast radius で重み付け」に照らして、
   節約側に振る価値がない。

現在の**保守的な判定（合流者が 1 人でも居ればコピー）は、この脆いマイクロタスク順序に
一切依存しない**点で正しい。ADR 0009 §3 の「合流者がいるときだけ」という書き方は
結果的にこの堅牢性を選んでいる。

**選択肢**

- a) ★ 現状維持。上記の棄却理由を ADR 0009 §3 に 1〜2 文で残す
  （「合流者の `into` の有無で判定を細分化しない — マイクロタスクのホップ数に依存する
  脆い保証になるため」）。
- b) 最適化を実装する。

推奨は a)。

**リスク**: なし。

**対象**: `src/core.ts:841-853`（合流者側）/ `src/core.ts:895-897`（判定）/
`docs/decisions/0009-into-caller-buffer.md:50-58`

---

## 担当項目 1〜7 の結論

### 1. single-flight リファクタ（`{raw, decoded}` promise → `shared` + `followers`）

**旧実装との意味論の差分（全列挙）**

| # | 項目 | 旧（`promise = acquireAndDecode(...).finally(delete)`） | 新（`Promise.withResolvers` + try/catch/finally） | 判定 |
| --- | --- | --- | --- | --- |
| 1-a | 合流者が受け取る値 | `{ raw, decoded }` を受け取り `raw` を分解 | `Uint8Array`（raw）を直接受け取る | 意味論同一。`decoded` は leader しか使っていなかったので情報の削減のみ |
| 1-b | 合流者が受け取る**インスタンス** | 常に leader と同一インスタンス | leader が `into` を使い合流者が居るときだけコピー | **意図した変更**（ADR 0009 §3）。他の組み合わせは従来どおり同一インスタンス共有（ADR 0004 帰結の「同じ raw インスタンス」は `into` 非使用時に限り維持） |
| 1-c | 合流者が resume するタイミング | `acquireAndDecode` の settle → `finally` → 合流者 | `acquireAndDecode` の settle → leader の resume → `shared.resolve` → 合流者 | マイクロタスクが 1 ホップ増える。観測可能な意味論の差は無い（`inflight.delete` との前後関係は下記 1-d のとおり不変） |
| 1-d | `inflight.delete` と合流者 resume の前後 | delete が先（合流者は `finally` 連鎖の下流） | delete が先（resolve と delete が同一同期区間 → 合流者の job はその後） | **同一**。どちらも「合流者が動く時点で Map は空」 |
| 1-e | 失敗時に leader と合流者のどちらが先に throw するか | 合流者が先に settle し得る（leader も同じ promise を await していた） | leader が必ず先（leader の `catch` で `reject` してから rethrow） | 順序が反転。観測可能だが依存すべき性質ではない。既存テスト（`src/mod.test.ts:318`）は `Promise.all` で受けるため影響なし |
| 1-f | 未処理拒否 | `promise` は leader 自身が await していたので常にハンドラ有り | `shared.promise` は誰も await しない可能性がある → `catch(() => {})` を付与（`core.ts:875`） | 新規に必要になった補償。正しく置かれている |
| 1-g | leader の戻り値の出どころ | `await promise` の `decoded` | `await acquireAndDecode(...)` の `decoded` | 同一 |
| 1-h | エントリの可変性 | オブジェクトリテラル（不変） | `entry` を変数に持ち `followers` を変異 | 新規。G2-03 の不変条件が乗る |

**`resolve → return → finally(delete)` は同期か** — **証明**。
`core.ts:883-906` の `try` ブロックは `shared.resolve(...)`（895-897）→ `return decoded;`（898）で、
その間に `await` は無い。`return` は「戻り値の式を評価 → `finally` ブロックを実行 → 関数を抜ける」
の順で、`finally`（902-906）にも `await` が無い。したがって
**`shared.resolve` から `inflight.delete` までは 1 つの同期区間**であり、他のタスク・
マイクロタスクが割り込む余地はない。`catch` 経路（899-901）も同様
（`shared.reject` → `throw` → `finally` の delete が同期）。

**`followers` は「resolve 時点で合流済みの数」を正しく表すか** — **証明**（ただし G2-03 の
未文書な前提に依存）。
- 合流者は `inflight.get` で entry を得た**同じ同期区間で** `followers += 1` する
  （`core.ts:831-834`。関数入口からここまで `await` が無い — G2-03）。
  よって「合流を決めたが未カウント」の中間状態は外から観測できない。
- 「合流者が join と await の間に増やす」窓は存在しない（join = カウントが同一文の並び）。
- 「resolve 後〜delete 前に join できる窓」も存在しない（上の同期区間の証明より）。
- delete 後に来た呼び出しは entry を得られず新 leader になる（`followers` とは無関係）。

**失敗形状の判定**

| 失敗形状 | 判定 | 根拠 |
| --- | --- | --- |
| lost wakeup（合流者が永久に待つ） | **棄却** | leader の `try` からの脱出経路は「正常 return（895 で resolve 済み）」と「throw（900 で reject 済み）」の 2 つのみ。`shared.resolve` の引数評価（`raw.slice()`）が throw しても `catch` が拾って reject する（`core.ts:895-901`） |
| 合流の TOCTOU（同一ターンの二重フライト） | **棄却** | `inflight.get`（831）→ `inflight.set`（882）の間に `await` が無い（859-882 は Set 生成・`Promise.withResolvers`・オブジェクトリテラル・`set` のみ） |
| 二重 resolve / resolve 後 reject | **棄却** | `resolve` と `reject` は排他な `try`/`catch` 経路。`Promise.withResolvers` の resolver は 2 回目以降が no-op なので、仮に両方通っても状態は壊れない |
| 未処理拒否（合流者ゼロ） | **棄却** | `shared.promise.catch(() => {})`（875）が entry 作成と同時に登録される。leader 自身は 901 で必ず rethrow するので、拒否が黙殺されることはない |
| 自己デッドロック（`validate`/`decode` からの同一キー再入） | **不変（旧と同じ）** | leader の hook は `acquireAndDecode` 内（`checkAndDecode`）で走り、その時点で `inflight` に entry が有る → 再入は合流 → `shared` は hook の完了を待っている → デッドロック。旧実装も同型（`promise` を待つ）。合流者の hook は delete 後に走るので再入しても新 leader になり、デッドロックしない（これも旧と同じ） |
| エイリアシングによる上書き | **条件付きで棄却** | 逐次利用の契約下では棄却（§2・§5 参照）。契約を破る並行利用では成立する → G2-01 |

### 2. leader が `into` を持ち `followers > 0` のとき `raw.slice()` する設計

**コピーが leader の呼び出し側へ制御が戻る前に完了することの証明** — **証明**。
`raw.slice()` は `shared.resolve` の**引数**として評価される同期式であり
（`core.ts:895-897`）、その後 `return decoded`（898）→ `finally`（905）→ leader の
async 関数の promise が resolve される。leader の呼び出し側が resume できるのは、その
promise の reaction job が実行されるとき、すなわち**現在の同期区間が終わってから**。
したがってコピーは必ず先に完了している。コピー元（leader の器）が書き換えられるのは
leader の呼び出し側が動いてからなので、上書き競合は起きない。

**`opts.into !== undefined` が「raw が呼び出し側メモリを指す」と同値であることの証明** — **証明**。
leader の raw は 2 経路でしか作られない:
- キャッシュヒット: `opts.into === undefined` なら `new Uint8Array(await cached.arrayBuffer())`
  （ライブラリ所有）、そうでなければ `readBody(cached, …, opts.into)` → `into.subarray`
  （`core.ts:619-627`）。
- network: `readBody(response, …, opts.into)`（`core.ts:688-694`）。`into` が有れば
  `buffer = into`（367-368）で `into.subarray(0, loaded)` を返す（434）。`body === null`
  フォールバックも `into.set(bytes)` → `into.subarray`（394-402）。
どの経路でも「`opts.into` が有る ⇔ raw は `into` の view」。したがって判定は過不足なし。

**leader が `into` 無し・合流者が `into` 有り** — **安全（証明）**。
共有 raw はライブラリ所有のバッファ。合流者は `opts.into.set(raw)`（851）で自分の器へ写し、
以後は自分の器の view で `checkAndDecode` する。共有 raw は変更しない（読み取りのみ）ので
他の合流者・leader への影響なし。ADR 0003/0004 の「raw を破壊的に変更しない MUST NOT」は
維持されている。

**leader が `into` 有り・合流者ゼロ（`shared.promise` に呼び出し側 view が残る）** —
**メモリ保持の問題なし（証明）**。
`shared.resolve(raw)` により `shared.promise` は呼び出し側バッファの view を保持するが、
①`entry` は `inflight.delete`（905）で Map から外れる ②`shared` は leader の async 関数の
フレームだけが参照しており、関数が return した時点でフレームごと到達不能になる
③`shared.promise.catch(() => {})` が作る派生 promise も参照を持たない。
よって `shared.promise` は GC 可能で、残るのは呼び出し側自身が所有する ArrayBuffer への
参照だけ（呼び出し側が持っているものと同じ）。**`inflight.delete` 後に到達する経路は無い**
（Map 以外に entry への参照が無いため、新規の合流者が拾うことはできない）。

**副次的な指摘**: コピーのサイズと確保失敗 → G2-04。

### 3. 合流者側 `opts.into.set(raw)` のタイミングと、leader と器を共有した場合

**タイミング** — leader の `shared.resolve` によって enqueue された reaction job の中で、
合流者の `await existing.promise`（841）が resume した**直後の同期文**として走る（842-853）。
`checkAndDecode`（854）はその後の `await` なので、`set` は必ず先に完了する。

**leader と合流者が同じ器を渡した場合（同一キー・同一フライト）** — **実害なし（証明）**。
この組み合わせでは `opts.into !== undefined && followers > 0` が成立するので leader は
`raw.slice()` を渡す。合流者の `opts.into.set(copy)` は**同じ内容**を同じ器へ書き戻すだけで、
leader の戻り値 view の内容は変わらない。`decode` 併用時も器に入る保存形は同一。
（無駄な書き込みが 1 回走るだけ。）

**別キーの並行呼び出しで器を共有した場合** — **実害あり** → **G2-01**。
`fetchHfFiles` の `Promise.all` がこれを構造的に作れる。

**文書化されているか** — **不十分**。
`docs/limitations.md:47-49` と `src/hf/mod.ts:76-78` は「戻り値同士が上書きし合う」としか
書いておらず、①受信そのものがインターリーブすること ②記録ハッシュ付きの不正エントリが
成立し得ること のどちらも書かれていない。`FetchBytesOptions.into` の doc
（`core.ts:129-146`）には並行利用への言及自体が無い。→ G2-01 の選択肢 a)/b)。

### 4. `shared.promise.catch(() => {})` と全 throw 経路での inflight のクローズ

**拒否伝播（合流者が居るとき）** — **証明**。
`.catch(() => {})` は `shared.promise` に reaction を 1 つ足して**新しい promise を返す**だけで、
元の promise の拒否状態は変わらない。合流者の `await existing.promise` はそれぞれ独立した
reaction を登録しているので、全員が同じ拒否を受け取る。既存テスト
（`src/mod.test.ts:318` 「取得失敗は合流全員へ伝播する」）が凍結済み。

**黙殺（合流者ゼロ）が leader の catch/throw で補われるか** — **証明**。
`catch`（899-901）は `shared.reject(error)` の直後に `throw error` する。leader の
async 関数の promise が拒否されるので、呼び出し側が握らなければ通常どおり未処理拒否になる。
`.catch(() => {})` が黙らせるのは `shared.promise` の**その枝だけ**。

**`acquireAndDecode` の全 throw 経路で inflight が閉じるか** — **証明**（全経路列挙）。

| # | throw 経路 | 位置 | `finally` 到達 |
| --- | --- | --- | --- |
| 4-a | HTTP エラー | `core.ts:680-687` | ✓ |
| 4-b | `expectedBytes` の確保失敗 | `core.ts:372-381` | ✓ |
| 4-c | `IntoCapacityError`（network・チャンク超過） | `core.ts:411-420` | ✓ |
| 4-d | `IntoCapacityError`（network・`body === null` 経路） | `core.ts:394-400` | ✓ |
| 4-e | `IntoCapacityError`（キャッシュヒット・素通し） | `core.ts:632` | ✓ |
| 4-f | sha256 不一致（network 経路） | `core.ts:518-525` | ✓ |
| 4-g | `validate` 拒否 / `decode` 失敗（network 経路） | `core.ts:526-527` | ✓ |
| 4-h | ストリーム切断（`reader.read()` の reject） | `core.ts:408` | ✓ |
| 4-i | `storableResponse` の構築失敗 | `core.ts:701`（try の外＝意図的） | ✓ |
| 4-j | `cache.open` / `match` / `delete` / `put` の失敗 | 各 catch で `onCacheError` → 縮退（throw しない） | 該当なし |
| 4-k | `raw.slice()` の RangeError（`acquireAndDecode` の外） | `core.ts:896` | ✓（`catch` → `finally`） |

いずれも `try`（883）の内側で発生し、`finally`（902-906）の `inflight.delete` を必ず通る。
`inflight.set`（882）と `try {`（883）の間に throw し得る文は無い。**フライトの取り残しは無い**。

### 5. エイリアシング

| ケース | 判定 | 根拠 |
| --- | --- | --- |
| `validate` / `decode`（利用者コード）が非同期で raw を保持したまま、次の `fetchBytes` が同じ器へ書く | **契約で防げる（棄却）** | 「戻り値と raw は次に同じバッファへ書くまで有効」（`limitations.md:41-49`）＋ `ValidateBytes` / `DecodeBytes` の「raw を破壊的に変更しない MUST NOT」（`core.ts:32-36`・`109-111`）。逐次利用なら次の書き込みは呼び出し側が起こすので、保持し続ける側の責任 |
| hook が**器へ書き込む**（`validate` の MUST NOT 違反） | **既存契約でカバー済み** | `into` で新しく危険になったが、禁止自体は既に MUST NOT として明記済み。破ると digest 後・put 前の書き換えになり、記録付き不正エントリを作れる（G2-01 と同じ機序） |
| `sha256HexNative` の `digest` 中（`await`）に同じバッファへ書かれる | **棄却（仕様ベース）** | WebCrypto の `digest` は呼び出し時点でバイト列のコピーを取る仕様。digest の結果は呼び出し時のスナップショット。**ただしその帰結として「digest は通ったが put の内容は別」が起こり得る**（G2-01）。また実装の実測は未検証（G2-07） |
| `cache.put` の Response 構築はコピーか（WHATWG "extract a body"）と `put` の `await` | **棄却（仕様ベース）／逐次契約下で安全** | `storableResponse`（`core.ts:464-474`）は `ReadableStream` に view を `enqueue` するだけで**コピーしない**（これは意図的 — 512MiB の `new Response(bytes)` が全量コピーする問題の回避）。読むのは `cache.put` で、Cache API 仕様の `put` は body stream を**読み切ってから**解決する。`await cache.put(...)`（`core.ts:704`・`657`）で待っているため、逐次利用では呼び出し側が動く前に読み終わっている。**並行利用ではここが窓になる**（G2-01） |
| SharedArrayBuffer 背面の `into` | **uncertain → ガード推奨** | 型では弾かれるが実行時ガードが無い。`digest` はコピーで守られるが `cache.put` は生の SAB を読む → G2-06 |
| 器が resizable ArrayBuffer 背面で、受信中に縮められる | **uncertain（極小エッジ）** | `buffer.set(value, loaded)` が RangeError で落ち、フライトは `finally` で閉じるので取り残しは無い。エラーメッセージが `IntoCapacityError` ではなく生の RangeError になる程度の差。呼び出し側の重大な契約違反であり、G2-06 のガードを入れるなら同じ場所で扱える |
| 契約の境界は明文化されているか | **部分的** | 「次に同じバッファへ書くまで」（逐次）は明文。**「並行呼び出しで同じ器を共有しない」は明文でない** → G2-01 b)。「throw 後の器の状態」も明文でない → G2-05 |

### 6. 進捗通知（`listeners` / `state.last` / `isolateProgress`）

**結論: 壊れていない（証明）**。

- `emit`（`core.ts:867-870`）は `[...listeners]` の**snapshot** を反復しており、a58c79e の
  修正が維持されている（`git show a58c79e` で確認: 同一の `for (const listener of [...listeners])`）。
  この commit は `emit` の中身に一切触れていない（diff 上、`emit` 定義は文脈行のみ）。
- `state.last` の更新（868）→ 反復（869）の順序も不変。合流時の即時リプレイ
  （`core.ts:838-839`）も不変。
- 合流部の変更は `existing.followers += 1`（834）を `if (opts.onProgress !== undefined)` の
  **前**に挿入しただけで、リスナー登録・リプレイのロジックには触れていない。
  `followers` のカウントと進捗の登録は独立（`onProgress` を持たない合流者もカウントされる）。
- キャッシュヒット経路の `readBody` は `onProgress: undefined` を明示的に渡している
  （`core.ts:621-627`）ので、「キャッシュヒット時は `onProgress` を呼ばない」契約
  （`core.ts:147-153`）は維持されている。既存テスト `src/mod.test.ts:206-212` が凍結済み。
- 新規の副作用として、**進捗リスナーの中から合流すると `followers` が増える**ため、
  leader が `into` を使っていれば `raw.slice()` が走る。これは正しい挙動（その合流者は
  隔離されたコピーを必要とする）だが未凍結 → G2-08 の 2。

### 7. backfill put（cache-hit + 記録なし + `into`）と並行する別呼び出し

| 相手 | 判定 | 根拠 |
| --- | --- | --- |
| **同じキー**の並行 `fetchBytes`（`into` の有無を問わず） | **競合しない（証明）** | 同一キーは single-flight で合流するため、backfill を行うのは leader ただ 1 つ。合流者は `acquireAndDecode` を実行しない（`core.ts:841-854` は `checkAndDecode` のみ）。したがって「2 つの backfill put が同じキーへ同時に走る」ことは構造的に起きない |
| **同じキー**の並行 `evict` / `clearCache` / `prefetchUrl` | **既知（本 commit で悪化なし）** | `docs/limitations.md:79-84` に last-writer-wins として文書化済み。前回レビューの見送り事項（`.claude/reviews/2026-08-28_c91e955/ROADMAP.md`「backfill TOCTOU の窓縮小」）。`into` はこの窓の**長さ**を変えない（`checkAndDecode` → `put` の間に新たな `await` を足していない） |
| **別キー**の並行 `fetchBytes` が**同じ器**を使う | **新規の実害** → **G2-01** | backfill put も `storableResponse(cachedBytes, opts.sha256)`（`core.ts:657-660`）で呼び出し側の器を読むため、network 経路と同じ機序で記録付き不正エントリを作れる。しかも backfill は「記録なしエントリの実ハッシュが一致した」ケースなので、汚染が**既存の正常エントリを置換**する形になる（network 経路より悪い） |
| backfill put の失敗 | **健全** | `try`/`catch` → `onCacheError`（661-663）→ 結果は変わらず `return`（665）。器の内容にも影響しない |

**backfill と `into` の相互作用そのもの（逐次利用下）** — **安全（証明）**。
`cachedBytes` は器の prefix view、`checkAndDecode`（650）で実ハッシュ突合が通ったあと
`await cache.put`（657）で読み切られる。この間、呼び出し側は `fetchBytes` を await して
suspend しており、器へ書けるのは `validate` / `decode` フック（MUST NOT で禁止）だけ。
テスト `src/mod.test.ts:1685-1722` が「記録なしヒット → 器の view で突合 → backfill」の
経路と、backfill 後のエントリ内容が正しいこと（`recorded.arrayBuffer()` の照合）を
凍結している。

---

## single-flight の実行順序（ASCII 図）

leader が `into` を持ち、合流者 1 名（`into` 無し）が居るケース。
`║` = 同期区間（割り込み不可）、`- - -` = マイクロタスク境界、`[n]` = 実行番号。

```
 呼び出し側 A (leader)                      呼び出し側 B (follower)
 ─────────────────────────                  ─────────────────────────
 [1] fetchBytes(url,{into:A})
     ║ normalizeUrl / 各種入口ガード
     ║ (core.ts:760-814 — すべて同期)
     ║ [2] inflight.get(key) → undefined
     ║ [3] listeners/state/shared 生成
     ║     shared.promise.catch(()=>{})      ← 未処理拒否の抑止 (875)
     ║ [4] entry = {promise, listeners,
     ║              state, followers:0}
     ║ [5] inflight.set(key, entry)   (882)
     ║  ── MUST: [2]〜[5] に await 無し ──
     ║     （挟むと二重フライト = TOCTOU）
     ║ [6] acquireAndDecode(...) 開始
 - - - ─ await（A の呼び出し側へ制御が戻る）─ - - -
                                            [7] fetchBytes(url,{})
                                                ║ 入口ガード（同期）
                                                ║ [8] inflight.get → entry
                                                ║ [9] entry.followers += 1  (834)
                                                ║  ── MUST（未文書 = G2-03）:
                                                ║     入口〜[9] に await 無し
                                                ║ [10] listeners.add + 直近進捗
                                                ║      のリプレイ (836-839)
                                                ║ [11] await shared.promise
 - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 [12] cache.match / fetch / readBody
      → 器 A の先頭へ直接書き込み (367,427)
      各チャンクで emit → listeners の
      snapshot 反復 (869) で B にも通知
 [13] checkAndDecode(raw)               ← raw = A.subarray(0,n)
      digest は呼び出し時にコピーを取る（仕様）
 [14] await cache.put(...)              ← 器 A を読み切ってから解決
 - - - ─ acquireAndDecode settle ─ - - -
 [15] leader resume ─────────────────────────────────────────┐
      ║ opts.into!==undefined && followers>0 → raw.slice()    │
      ║ [16] N バイトの同期コピー (896)  ← G2-04 のピーク 2N   │ この
      ║ [17] shared.resolve(copy) (895)                       │ 4 手は
      ║       └→ B の reaction job を enqueue                 │ 1 つの
      ║ [18] return decoded → finally                         │ 同期
      ║ [19] inflight.delete(key) (905)                       │ 区間
      ║       └→ 以後の呼び出しは新 leader になる             │
      ║ [20] leader の promise を resolve                     │
      ║       └→ A の呼び出し側の job を enqueue（B の後ろ）  │
      ╚═══════════════════════════════════════════════════════┘
   ※ [17] と [19] の間に await が無い ⇒「resolve 済みだが Map に居る」窓は無い
   ※ [16] は [20] より前 ⇒ コピーは A の呼び出し側が再開する前に完了
 - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
                                            [21] B resume（copy を受領）
                                                ║ opts.into があれば
                                                ║   into.set(raw) → subarray
                                                ║   (851-852)
                                                ║ ── ここも [24] より前 ──
                                                [22] await checkAndDecode
                                                     （B 自身の sha256/
                                                       validate/decode）
 - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 [23] A の呼び出し側 resume
      戻り値 = A.subarray(0,n)
      ここで初めて器 A を再利用できる
      （B は copy を持っているので無害）
                                            [24] B の呼び出し側 resume
```

失敗時（`acquireAndDecode` が throw）は [15] が `catch` に入り、
`[16'] shared.reject(error)` → `[17'] throw` → `[18'] inflight.delete` の順で、
やはり 1 つの同期区間。B は [21] で拒否を受け取り、A も自分の promise を拒否する。

---

## 横断所見

1. **`into` は「所有権の境界をライブラリの内部経路に貫通させる」初めての口である。**
   これまで `fetchBytes` が触るバイト列はすべてライブラリ所有で、「raw を壊さない」契約は
   利用者の hook に対する一方向の禁止だけで足りていた。`into` 以後は逆方向
   （ライブラリが呼び出し側メモリを digest → `cache.put` まで読み続ける）が加わる。
   この commit はその一方向（合流者へ渡さない）を丁寧に閉じている一方、
   もう一方（呼び出し側が並行に書く）が文書の一行に委ねられている。G2-01 / G2-05 / G2-06 は
   すべてこの一点の派生。

2. **「fail loud」の宛先が呼び出し単位ではなくフライト単位になる箇所がある**（G2-02）。
   `IntoCapacityError` は呼び出し側ローカルな誤りなのに、leader で起きるとフライト全体を
   落とす。この commit の設計判断としては正しい（部分成功を持ち込まないほうが単純）が、
   ADR 0004 §4「取得失敗は合流全員へ伝播」の "取得失敗" の定義が実質的に広がっている点は
   ADR 側に反映する価値がある。

3. **性能特性が並行度で非決定になった**（G2-04）。`into` の「確保ゼロ・ピーク 1N」は
   同一キーへの並行呼び出しがゼロであることを暗黙の前提にしている。下流（karume）の
   逐次読み用途では成立するが、README の売り文句としては条件付きであることを添えたい。

4. **良い点として記録しておく**:
   - `hasArrayBufferBacking` への緩和は WebCrypto 仕様に照らして正しく、
     `isTightView` の過剰な制約（`byteOffset === 0` かつ `byteLength === buffer.byteLength`）を
     `into` のために外す判断として妥当（コピー条件を SAB 背面のみに絞るのは仕様の下限に一致）。
   - キャッシュヒット経路で `IntoCapacityError` だけを `instanceof` で素通しする設計
     （`core.ts:632`）は、「破損 → self-heal」「cache I/O 失敗 → network 縮退」という
     既存の 2 つの縮退経路のどちらにも当てはまらない第 3 のクラスを、
     縮退させずに正しく分離している。ADR 0009 §2 の記述とコードが一致している。
   - `opts.into !== undefined` を「raw が呼び出し側メモリを指す」の判定に使うのは、
     一見すると間接的だが全経路で厳密に同値であることが証明できる（§2）。
     `raw.buffer === opts.into.buffer` のような直接比較より速く、意味も同じ。
   - 合流者の容量不足をその呼び出しだけに留める非対称（`core.ts:842-853`）は、
     ADR 0009 §3 の設計意図どおりで、テストで凍結されている。

5. **needs-human（本レビューでは断定しない）**:
   - Deno / 各ブラウザの `cache.put` が body stream を「解決前に読み切る」ことは
     Cache API 仕様の要求だが、Deno 2.9 の実装で実測確認はしていない。G2-01 の機序は
     この仕様が守られていても（むしろ守られているからこそ digest と put の間に窓が空く形で）
     成立するので結論は変わらないが、「put が呼び出し時に同期コピーする」実装なら
     窓は消える。実測する価値はある（`storableResponse` の stream に細工した観測用 stream を
     噛ませれば、put がいつ pull するか計測できる）。
   - WebCrypto `digest` の「呼び出し時にコピーを取る」も仕様文ベースで、実装の実測は未確認
     （G2-07）。
</content>
</invoke>
