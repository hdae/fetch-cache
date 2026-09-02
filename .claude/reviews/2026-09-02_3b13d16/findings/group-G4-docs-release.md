---
id: G4
topic: 文書・API 整合とリリース検品（into 追加 / 0.6.0 公開前）
files_reviewed:
  - README.md
  - CLAUDE.md
  - docs/limitations.md
  - docs/known-issues.md
  - docs/decisions/0009-into-caller-buffer.md
  - docs/decisions/0005-streaming-prefetch-and-verified-marker.md
  - docs/decisions/0007-explicit-expected-bytes-fail-loud.md
  - docs/decisions/0004-single-flight-raw-sharing.md
  - src/core.ts
  - src/hf/mod.ts
  - src/mod.ts
  - deno.json
  - .github/workflows/release.yml
  - scripts/bump.ts
  - scripts/verify_tag.ts
  - .claude/reviews/2026-08-28_c91e955/SUMMARY.md
  - .claude/reviews/2026-08-28_c91e955/ROADMAP.md
date: 2026-09-02
model: opus
---

# G4 — 文書・API 整合とリリース検品

## サマリ

対象は v0.5.0 タグ以降の唯一の未リリースコミット 3b13d16（`FetchBytesOptions.into` /
`HfFileSpec.into` の追加）と、0.6.0 公開前の文書・API・リリース手順の検品。

**総評**: 実装そのものは ADR 0009 の裁定内容に忠実で、公開 API は追加のみ・既定挙動は不変。
リリース手順（bump / tag / release.yml / publish include）も現状のまま通る。ブロッカーは無い。

指摘は前回（c91e955）の **D 群「文書の過大保証クラスタ」と同型のものが 3 件**再発している点に
集中する。すなわち ① README の `into` 節が「呼び出し毎の確保がゼロ」を無条件に主張している
（実際は受信チャンク確保・合流者コピー・body null 経路・Cache 実装依存の 4 つの例外がある）、
② 「`expectedBytes` 超過は network に出る前に throw」が HF 層では成立しない（revision 解決
リクエストが先に出る）、③ ADR 0009 §2 の「ヒット経路の 2 つの catch」が実装では 1 箇所。
加えて `fetchHfFiles`（並列）へ同じ `into` を渡したときの危険が limitations で過小記述である
（単なる「戻り値の上書き」ではなく、記録ハッシュと中身の食い違うエントリを生む余地がある）。

**重大度別件数**: 🔴 Blocker 0 / 🟠 Warning 5 / 🟡 Suggestion 8 / 🔵 Info 3（計 16 件）。
すべて文書側で閉じられる（コード修正を推奨するのは G4-03 / G4-04 の各 a 案のみで、いずれも
別グループ・オーナー裁定事項）。

## ファイル別分類

| ファイル | 判定 | 要点 |
| --- | --- | --- |
| README.md | 🟠 | `into` 節・Features 箇条書きの過大保証（G4-01 / G4-02）、HF 節の「network に出る前」（G4-03）、prefetch が無視する項目の列挙漏れ（G4-07） |
| docs/decisions/0009-into-caller-buffer.md | 🟠 | §2「2 つの catch」が実装と不一致（G4-05）、実測根拠が非公開記録指し（G4-12） |
| docs/limitations.md | 🟠 | `into` 項の並列共有ハザードが過小（G4-04）、Cache 実装依存の caveat 欠落（G4-09） |
| docs/decisions/0005-streaming-prefetch-and-verified-marker.md | 🟡 | §1「戻り値は常に tight view」が 0009 に覆されたまま未改定（G4-08） |
| src/hf/mod.ts | 🟠 | 容量検査が revision 解決より後（G4-03）、prefetchHfFile の NOTE 列挙が `into` 未反映（G4-07） |
| src/core.ts | 🔵 | JSDoc は実装と一致。`IntoCapacityError` の判別手段が未文書（G4-10）のみ |
| src/mod.ts | 🟢 | 公開ファサードは変更不要（`into` は既存型のプロパティ追加） |
| deno.json | 🟢 | publish include/exclude は変更不要（新規追加は ADR と *.test.ts のみ） |
| .github/workflows/release.yml | 🟢 | check → verify_tag → publish の順は現状で妥当 |
| scripts/bump.ts / verify_tag.ts | 🟢 | `deno task bump minor` で deno.json + src/mod.ts を 1 コミット同期。tag/push は手動 |
| CLAUDE.md | 🟢 | Layout の公開一覧は src/mod.ts:31-51・src/hf/mod.ts と一致（更新不要） |
| docs/known-issues.md | 🟢 | 新規のオープン問題は無い（G4-15 に判断根拠） |

## 主張突合表

| # | 主張（出典） | 出典 path:line | 実装 path:line | verdict |
| --- | --- | --- | --- | --- |
| 1 | 「reuse one buffer across many shards and the heap never holds more than one of them」 | README.md:35-37 | core.ts:366-386 / 404-434 / 890-897 | **over-claims** |
| 2 | 「network download と cache hit の両方を器へ書き、prefix view を返す」 | README.md:228-231 | core.ts:617-627, 433-434 | holds |
| 3 | 「No per-call allocation happens」 | README.md:231-233 | core.ts:387-403, 404-432, 890-897 | **over-claims** |
| 4 | 「戻り値と validate/decode の raw は次の書き込みまで有効、decode 併用時は器に保存形」 | README.md:233-236 / limitations.md:41-44 | core.ts:513-528, 129-146 | holds |
| 5 | 「容量不足の network は超過チャンクで打ち切り・キャッシュしない」 | README.md:238-240 / ADR 0009:44 | core.ts:410-419（cancel → throw、697 の checkAndDecode/put へ到達しない） | holds |
| 6 | 「キャッシュヒットは throw するがエントリは消さない／network へ縮退しない」 | README.md:240 / ADR 0009:45-47 | core.ts:630-635（632 で instanceof 素通し → 636 の delete と 679 の fetch を飛ばす） | holds |
| 7 | 「`expectedBytes` が容量を超える申告は network に出る前に throw」 | README.md:240-241 / limitations.md:45-46 / ADR 0009:48 | core.ts:804-814（`fetchBytes` は holds）／ hf/mod.ts:274-285, 367-388（revision 解決が先） | **over-claims（HF 経路）** |
| 8 | 「合流者は leader のバッファを受け取らない（自分のコピーか自分の `into`）」 | README.md:241-244 / ADR 0009:51-58 | core.ts:842-853, 890-897 | holds |
| 9 | 「`into` はファイル毎の設定、逐次 `fetchHfFile` で使う」 | README.md:343-344 | hf/mod.ts:71-81, 241 | holds |
| 10 | 「`prefetchHfFile` が spec から読むのは sha256 だけ（`expectedBytes` / `validate` は無視）」 | README.md:410-412 / hf/mod.ts:327-330 | hf/mod.ts:339-362（`into` も無視される） | **under-claims（列挙が不完全）** |
| 11 | 「ヒット経路の 2 つの catch はこの例外だけ素通しする」 | ADR 0009:46-47 | core.ts:630-635 のみ。core.ts:666 は無条件 catch | **contradicts** |
| 12 | 「合流者がいるときだけ leader は共有前に raw をコピーする」 | ADR 0009:55-57 | core.ts:895-897（`followers > 0` で slice） | holds |
| 13 | 「WebCrypto の digest は部分ビューを受け付ける／SharedArrayBuffer 背面だけコピー」 | ADR 0009:62-64 / core.ts:479-482 | core.ts:489-495 | holds（WebIDL 上 `SubtleCrypto.digest` の引数は `[AllowShared]` 無しの `BufferSource`。ハッシュ対象は view の byteOffset/byteLength 範囲） |
| 14 | 「非 breaking（オプションの追加のみ）。`into` を渡さない呼び出しの挙動は不変」 | ADR 0009:68 | core.ts:367（into 未指定分岐）, 619-620, 896 | holds（実行時）／型面の注記は G4-06 |
| 15 | 「ヒット経路が stream 読みになる分、効果は Cache 実装依存」 | ADR 0009:70-72 | README / limitations に未伝播 | 文書間 **under-propagated**（G4-09） |
| 16 | 「戻り値は**常に** buffer 全体を占める tight view」 | ADR 0005:34 | core.ts:433-434（`into` 指定時は prefix view） | **contradicts**（0009 が改定したが未追記） |
| 17 | 「`fetchHfFiles` の複数 spec に同じバッファを渡すと戻り値同士が上書きし合う」 | limitations.md:48-49 / hf/mod.ts:78-80 | hf/mod.ts:380-386（`Promise.all` = 並列） | **under-claims（危険の実体）** |
| 18 | 「prefetch は `into` を見ない」 | limitations.md:47-48 / hf/mod.ts:80-81 | hf/mod.ts:351-360（`prefetchUrlWithKey` へ渡していない） | holds |
| 19 | limitations の `into` 項の `DECIDED:` ポインタ | limitations.md:41-42 | docs/decisions/0009-into-caller-buffer.md 実在・状態「採用」・日付 2026-09-02 | holds |
| 20 | CLAUDE.md Layout の mod.ts 公開一覧 | CLAUDE.md:8-12 | src/mod.ts:31-51 | holds（更新不要） |
| 21 | 「Cache API はヘッダ更新不可なので backfill は N バイト再 put」ほか既存主張 | README.md:83-92 | core.ts:651-664 | holds（今回の差分で劣化なし） |

## 詳細指摘

### G4-01 🟠 Warning — README の「No per-call allocation happens」を実装の範囲へ限定するか？

**概要**: README.md:231-233 は `into` 使用時に「呼び出し毎の確保は起きない」と無条件で書いて
いるが、実装には少なくとも 4 つの確保経路が残る。
① stream 読みでは fetch 実装が返すチャンクが毎回新規確保される（core.ts:404-408。`into` は
その write 先を消すだけでチャンク自体は消えない）。
② single-flight で合流者がいる場合、leader は共有前に**全長コピー**を切る（core.ts:895-897）。
③ `response.body === null` のランタイムでは `arrayBuffer()` で全量を確保してから `into` へ
写す（core.ts:387-402）＝ 一時的に 2N。
④ キャッシュヒットの stream 読みは Cache 実装が body を stream で返す前提で、全量 materialize
する実装では効果が消える（ADR 0009:70-72 が自ら caveat として書いている）。
前回レビュー D 群（README/JSDoc が実装より広い保証を書く）と同型の再発。

**選択肢**:
- a) ★「呼び出し毎の**受信バッファ / 戻り値バッファ**の確保が無くなる」へ主語を限定し、②③④を
  1 文の但し書き（合流者がいる場合の 1 回コピー・body 非 stream ランタイム・Cache 実装依存）に
  まとめる
- b) 主語限定だけ行い、但し書きは limitations 側（G4-09 と同時）へ寄せる
- c) 現状維持（下流が実測済みなので実害なしと判断する）

**リスク**: c は D 群の再発を公開文書に残す。実測環境（Deno）以外（ブラウザの Cache 実装、
body が null になる環境）で「効かない」報告を受けたときに、文書が反証材料にならない。

**対象**: README.md:231-233
**影響範囲**: README のみ（JSR には README が載る）。コード変更なし。
**引き継ぎ**: 文面は G4-02 / G4-09 と同時に直すのが効率的。

### G4-02 🟠 Warning — Features 箇条書きの「the heap never holds more than one of them」を条件付きにするか？

**概要**: README.md:35-37 の Features 箇条書きも同じ無条件保証。箇条書きは要約なので多少の
省略は許容されるが、「never」は G4-01 の②③④で破れる。前回 D1（`evict(["hf",…])` が「repo
丸ごと解放」と書いていた）と同じ「never / 丸ごと」型の断定。

**選択肢**:
- a) ★「reuse one buffer across many shards instead of allocating one per call」のように
  「呼び出し毎の確保が消える」へ言い換え、never を落とす
- b) 「the heap keeps one buffer's worth for the sequential case」へ用途限定
- c) 現状維持

**リスク**: c は上と同じ。Features は最初に読まれる箇所なので、期待値のずれがここで生まれる。

**対象**: README.md:35-37
**影響範囲**: README のみ。
**引き継ぎ**: G4-01 とセット。

### G4-03 🟠 Warning — HF 層で「network に出る前に throw」が成立しない件を、文書で限定するかコードを揃えるか？

**概要**: `expectedBytes > into.byteLength` の入口 throw は cache 層
（core.ts:804-814）にあり、`fetchBytes` では確かに一切の I/O 前に落ちる。しかし HF 層は
`fetchHfFile` / `fetchHfFiles` が **先に `resolveHfRevision`（network）を走らせてから**
`fetchBytesWithKey` を呼ぶ（hf/mod.ts:274-285 / 367-388）ため、可変 ref では revision 解決
リクエストが 1 発出た後に throw する。README.md:240-241・limitations.md:45-46・ADR 0009:48 の
「network に出る前に throw」は HF 経路では成り立たない。
これは v0.5.0 のリリースノートが明示的に謳った原則（「The HF entry points validate the file
spec (sha256 format) before the revision-resolution request」）の穴でもある。実際 sha256 の
形式検査は `toSpec`（hf/mod.ts:257-270）で解決前に済ませており、`into` の容量検査だけが
その位置に無い。

**選択肢**:
- a) ★ `toSpec` と同じ位置（各入口の解決前）へ容量事前検査を移す／追加する。`fetchHfFiles`
  は全 spec を同期検査してから解決する構造（hf/mod.ts:374-377）なのでそこに 1 行で収まる
- b) コードは触らず、文書側を「cache 層の入口で（HF 層では revision 解決の後で）」へ限定する
- c) 両方（コード修正 + 文書の言い換え）

**リスク**: a はコード変更なので本グループの範囲外（別グループ / オーナー裁定）。b だけだと
「事前検査は入口で行う」という 0.5.0 で立てた原則が層ごとにばらつく状態が固定される。損害は
API 1 発ぶんで小さく、可逆。

**対象**: README.md:240-241 / docs/limitations.md:45-46 / docs/decisions/0009:48 /
src/core.ts:804-814 / src/hf/mod.ts:274-285, 367-388
**影響範囲**: 文書 3 箇所。a を採るなら hf/mod.ts に検査 1 箇所（+ 凍結テスト 1 本）。
**引き継ぎ**: a の採否はコード担当グループ / オーナーへ。文書修正だけなら独立して実施可。

### G4-04 🟠 Warning — `fetchHfFiles` へ同じ `into` を渡したときの危険を「上書き」から「記録ハッシュ不整合の余地」へ書き換えるか？

**概要**: limitations.md:48-49 と hf/mod.ts:78-80 は、`fetchHfFiles` の複数 spec に同じ
バッファを渡した場合の帰結を「**戻り値同士が上書きし合う**」と書いている。しかし
`fetchHfFiles` は `Promise.all` で**並列**取得する（hf/mod.ts:380-386）ため、危険は結果の
上書きに留まらない。
ファイル A の検証通過（core.ts:697）から `cache.put` 完了（core.ts:701-707）までの間に
ファイル B の受信が同じ領域を書き替えうる。`storableResponse`（core.ts:464-474）は渡された
view を 1 チャンクとして stream に enqueue するだけで、実際に読まれるのは Cache 実装が
消費するときなので、**A の記録ハッシュを持つエントリに B のバイト列が入る**構成が理屈上
成立する。これはこのライブラリの中核不変条件（「記録付きの不正エントリは構造的に生まれない」
— ADR 0005 §5）に触れる。
※ 実際に混入するかは Cache 実装がチャンクをいつ読むかに依存する（Deno / ブラウザ実装で未実測）
ため、**uncertain**。ただし「文書化された誤用」の帰結としては現在の記述が軽すぎる。

**選択肢**:
- a) ★ 文書を強化する: limitations と `HfFileSpec.into` JSDoc に「`fetchHfFiles` の複数 spec へ
  同じバッファを渡すこと MUST NOT（並列受信が互いの領域を壊し、記録ハッシュと中身が食い違う
  エントリを作りうる）」と、危険の実体まで書く
- b) `fetchHfFiles` 側で同一 `into` 参照の重複を検出して fail loud（コード。並列入口なので
  検出は spec 配列の同一性比較 1 箇所で済む）
- c) 両方

**リスク**: a のみだと「読んでいない利用者」に対する防御は無い。b は追加ガードなので非破壊だが
コード変更でありリリース内容が増える。c が最も安全。

**対象**: docs/limitations.md:48-49 / src/hf/mod.ts:78-80 / src/hf/mod.ts:380-386 /
src/core.ts:697-707
**影響範囲**: 文書 2 箇所（+ b を採るなら hf/mod.ts に 1 ガードとテスト 1 本）。
**引き継ぎ**: 「実際に put へ流れる view が上書きされるか」の実測は本グループの読み取り専用
制約では不可 — **needs-human / 別グループの実測**。文書強化（a）は実測を待たずに実施可。

### G4-05 🟠 Warning — ADR 0009 §2 の「ヒット経路の 2 つの catch」を実装に合わせて訂正するか、実装側にガードを足すか？

**概要**: ADR 0009:46-47 は「ヒット経路の **2 つの catch** はこの例外だけ素通しする」と書く。
実装でヒット経路にある catch は core.ts:630（match / 器への読み出しを囲む）と core.ts:666
（検証・decode 失敗 = self-heal）の 2 つだが、`IntoCapacityError` の素通し（`instanceof` で
再 throw）があるのは **630 の 1 つだけ**（core.ts:632）。666 は無条件 catch で、そこに
`IntoCapacityError` が届けば「破損」と誤認して `cache.delete`（core.ts:669）してしまう。
現状は器への書き込み（readBody 呼び出し、core.ts:621-627）が 630 側の try にしか無いので
**到達しない = 挙動バグではない**。しかし ADR が「2 箇所で守っている」と述べている一方で
守りは 1 箇所しかなく、将来 readBody 呼び出しが 666 側の try に移ると「ヒットではエントリを
消さない」契約が黙って壊れる。

**選択肢**:
- a) ★ ADR 文面を実装に合わせて訂正する（「読み出しを囲む catch がこの例外だけ素通しする。
  self-heal 側の catch には届かない」）
- b) core.ts:666 の catch にも `instanceof IntoCapacityError` の再 throw を足す（現状 no-op の
  防御。ADR の記述はそのまま正しくなる）
- c) 両方（ADR を「2 箇所で守る」と読める形に保ちつつ実装を追随させる）

**リスク**: a のみだと将来の移動に対する防御は無い（ただし ADR が正確になるので誤解は減る）。
b は現状 no-op のコードを足すことになり、「起こり得ない分岐のエラーハンドリング」を禁じる
プロジェクト規約（簡潔性）と衝突しうる — この観点では a が素直。

**対象**: docs/decisions/0009-into-caller-buffer.md:46-47 / src/core.ts:630-635, 666-675
**影響範囲**: ADR 1 箇所（b を採るなら core.ts 2 行）。
**引き継ぎ**: b の採否はコード担当 / オーナーへ。

### G4-06 🟡 Suggestion — `Uint8Array<ArrayBuffer>` が公開型に初登場する件を、リリースノートで注記するか？

**概要**: `Uint8Array<ArrayBuffer>`（型引数付き TypedArray）は v0.5.0 時点では内部実装のみで
使われていた（v0.5.0 の core.ts:297, 326, 328, 420, 539。公開型には無し）。今回それが
`FetchBytesOptions.into`（core.ts:146）と `HfFileSpec.into`（hf/mod.ts:81）で**公開型の
シグネチャに初めて現れる**。TypedArray が型引数を取るのは TypeScript 5.7 以降で、5.6 以前では
`Uint8Array` は非ジェネリックなので型解決が壊れる。README.md:56 は `npx jsr add` による
npm / バンドラ利用を案内しているため、この経路の利用者は影響を受けうる。
※ 多くのプロジェクトは `skipLibCheck: true` を使っており、`into` を実際に使わなければ
エラーが表面化しない可能性が高い（そのため Blocker ではなく Suggestion）。Deno / JSR 直利用は
無関係。**本レビュー環境で TS 5.6 での再現は未実施 — needs-human**。

**選択肢**:
- a) ★ 実装はそのまま。リリースノート（と必要なら README の Installation 付近）に
  「npm 経由の利用では TypeScript 5.7 以降が必要」を 1 行入れる
- b) 公開型を `Uint8Array`（型引数なし）にして内部で絞る — 利用者側の型は緩くなるが、
  SharedArrayBuffer 背面のバッファを受け取り得る意味論変化が入る
- c) 何もしない（Deno / JSR 直利用が主用途という前提）

**リスク**: b は `into` の契約（`hasArrayBufferBacking` で SAB のみコピー、core.ts:479-495）と
の噛み合わせを再検討する必要があり、追加のみの release に載せる変更としては重い。c は
npm 利用者からの型エラー報告を受けたときに原因の説明コストを払う。

**対象**: src/core.ts:146 / src/hf/mod.ts:81 / README.md:52-57
**影響範囲**: リリースノート 1 行（+ README 1 行）。
**引き継ぎ**: TS 5.6 での実挙動（`skipLibCheck` の有無別）の確認は未実施。オーナーが npm 利用者
を想定範囲に入れるかで a / c が決まる。

### G4-07 🟡 Suggestion — 「prefetch が spec から無視する項目」の列挙に `into` を足すか？

**概要**: README.md:410-412 と hf/mod.ts:327-330 は「`prefetchHfFile` が spec から読むのは
`sha256` だけ。`expectedBytes` / `validate` は温めるときには使われない」と**列挙形式**で
書いている。`into` が spec に加わった今、この列挙は不完全（`into` も無視される）。
なお `HfFileSpec.into` の JSDoc（hf/mod.ts:80-81）と limitations.md:47-48 には
「prefetch は `into` を見ない」があるので、情報自体は 2 箇所に存在する — 列挙側だけが古い。

**選択肢**:
- a) ★ 両方の列挙に `into` を追加する（README 1 行 + hf/mod.ts の NOTE 1 行）
- b) 列挙をやめて「spec から読むのは `sha256` だけ」と総称形にする
- c) 現状維持（`HfFileSpec.into` JSDoc に書いてあるので実害なし）

**リスク**: c は spec にフィールドが増えるたびに古びる形の記述を残す（今回で 2 回目）。

**対象**: README.md:410-412 / src/hf/mod.ts:327-330
**影響範囲**: README 1 行・JSDoc 1 行（JSR に載る）。

### G4-08 🟡 Suggestion — ADR 0005 §1 の「戻り値は常に tight view」を改定済みと明記するか？

**概要**: ADR 0005:34 は「戻り値は**常に** buffer 全体を占める tight view（下流の
`bytes.buffer` zero-copy 前提を壊さない）」と書いている。`into` 指定時の戻り値は
`into.subarray(0, loaded)` = prefix view（core.ts:433-434）なので、この「常に」は 0009 で
覆っている。ADR 0009 の関連行（0009:5-7）は 0005 を「（`expectedBytes` の導入）」としか
参照しておらず、改定関係が記録されていない。本リポは ADR 0008 が「関連: 0006（本 ADR が一部を
改定する）」と明示する運用（0008-remove-public-key-and-backfill-record.md:5-6）なので、
そこと不揃い。

**選択肢**:
- a) ★ ADR 0009 の関連行に「0005 §1 の tight view 保証を `into` 指定時に限り改定」を追記
- b) ADR 0005:34 側に追補行（0008 が 0006 に対して取った形の逆方向）
- c) 両方

**リスク**: 放置すると、`bytes.buffer` をそのまま使う下流（zero-copy 前提）が 0005 を根拠に
判断を誤る余地が残る。README には tight view の約束は無いので、公開面の実害は無い。

**対象**: docs/decisions/0009-into-caller-buffer.md:5-7 / docs/decisions/0005-…:34（参考: 同 130）
**影響範囲**: ADR 2 ファイル（GitHub のみ。JSR 配布物には docs/ は入らない）。

### G4-09 🟡 Suggestion — 「効果は Cache 実装依存」の caveat を ADR の外へ出すか？

**概要**: ADR 0009:70-72 は「ヒット経路が stream 読みになる分、Deno / ブラウザの Cache 実装が
body を stream で返すか（全量を一度 materialize しないか）で RAM 効果の大きさが変わる。これは
実装挙動で仕様保証ではない」と正しく書いている。この caveat は README にも limitations にも
出ていない一方、README.md:228-233 は効果を無条件に主張している（G4-01）。ADR は
`docs/decisions/` にあり JSR 配布物にも入らないので、利用者にはまず届かない。

**選択肢**:
- a) ★ limitations.md の `into` 項（41-49）に 1 行足す（「キャッシュヒット側の RAM 効果は
  Cache 実装が body を stream で返すかに依存する。仕様保証ではない」）
- b) README の `into` 節にも 1 文入れる（G4-01 の a と同時）
- c) a + b

**リスク**: 無し（純増の注記）。書かない場合、ブラウザで効果が出ないという報告に対して
「by-design の実装依存」と示す文書が公開側に無い。

**対象**: docs/limitations.md:41-49 / README.md:228-233 / docs/decisions/0009:70-72
**影響範囲**: 文書のみ。known-issues ではなく limitations が適切（バグではなく実装依存の制約）。

### G4-10 🟡 Suggestion — 容量不足エラーの判別手段を文書化するか、型を公開するか？

**概要**: 容量不足は `IntoCapacityError`（core.ts:330-337）で落ちるが、このクラスは
src/mod.ts から再公開されていない（core.ts は exports 外 — CLAUDE.md の規約どおり）ため
利用者は `instanceof` で判別できない。判別可能な手掛かりは `error.name === "IntoCapacityError"`
（core.ts:335）だけだが、README・JSDoc・limitations のいずれにも `name` の記載が無い。
現状、利用者に残る選択肢は日本語エラーメッセージの部分一致になる。
※ エラーメッセージが日本語なのはライブラリ全体で一貫（core.ts の全 throw が日本語）なので、
今回の追加は既存規約に沿っている。

**選択肢**:
- a) ★ `into` の JSDoc / limitations / README に「容量不足は `name === "IntoCapacityError"` の
  Error で落ちる」と 1 行明記する（`name` はリテラル代入なのでミニファイでも壊れない）
- b) `IntoCapacityError` クラスを src/mod.ts から export する（追加のみ・非 breaking）
- c) 現状維持（`into` 使用者は自分の申告ミスとしてまとめて catch すればよい、という立場）

**リスク**: b はエラー型を公開 API に載せる決定で、以後クラス名・継承関係を変えにくくなる
（このライブラリは他のエラーをすべて素の `Error` で投げているので、1 つだけ型を公開すると
体系が不揃いになる）。a は安価で不可逆性が低い。

**対象**: src/core.ts:129-146, 330-337 / docs/limitations.md:41-49 / README.md:238-244
**影響範囲**: 文書のみ（a の場合）。

### G4-11 🟡 Suggestion — README の `into` 例で `expectedBytes` の役割を補足するか？

**概要**: README.md:213-226 のサンプルは `expectedBytes: shard.size` と `into` を併記するが、
`into` 指定時の `expectedBytes` は受信バッファの事前確保には使われない（確保は `into` で
置き換わる — core.ts:366-372）。残る役割は「容量事前検査のトリガ」（core.ts:804-814）だけで、
サンプルからはその意図が読み取れない。
併せて、コメント「`bytes` is `into.subarray(0, shard.size)`」は実受信長 = `shard.size` を
前提にしている。実装が返すのは実受信長の prefix view（core.ts:434）なので、宣言と実長が
ずれた場合はコメントの等式が成り立たない。

**選択肢**:
- a) ★ 例の直後に 1 文（「`into` と併せた `expectedBytes` は確保ヒントではなく、器に収まらない
  申告を network 前に弾くための事前検査になる」）を足し、コメントを
  「`into.subarray(0, 受信バイト数)`」相当へ緩める
- b) サンプルから `expectedBytes` を落とす（最小構成にする）
- c) 現状維持

**リスク**: b は「HF 層では `expectedBytes` が長さ検証として効く」導線を落とすので、逐次読みの
主用途からは情報が減る。

**対象**: README.md:213-226
**影響範囲**: README のみ。

### G4-12 🟡 Suggestion — ADR 0009 の実測根拠が非公開記録指しである点を明記するか？

**概要**: ADR 0009:14-17 は下流の実測値（ピーク ≈ 1.05GB + 最大 shard × 3 → ≈ 0.45GB +
最大 shard × 1、ロード時間が半分）を根拠に挙げ、0009:71-72 は「効果の実測は下流（karume）の
研究記録に置く」と外部を指す。下流プロジェクト名を ADR に書く運用自体は既存
（0003:8 の yomi、0006:32 の yomi / sbv2-web）なので問題ないが、**このリポの読者からは検証
不能な数値**が唯一の根拠になっている点は明示されていない。本レビューでも数値は未検証。

**選択肢**:
- a) ★ 0009:71-72 に「本リポでは未測定（計測は下流環境で実施）」と 1 句足す
- b) 測定条件（ランタイム・バージョン・shard 構成）を ADR 内に転記して自己完結させる
- c) 現状維持

**リスク**: c は将来「効果が出ない」と報告されたときに、比較すべき条件が復元できない。b は
下流の非公開情報をどこまで書くかの判断が要る（オーナー裁定）。

**対象**: docs/decisions/0009-into-caller-buffer.md:11-17, 70-72
**影響範囲**: ADR のみ。

### G4-13 🟡 Suggestion — README の Releasing 手順の bump 引数列挙を実装に揃えるか？（既存）

**概要**: README.md:510, 515 は `deno task bump patch` / `<patch|minor|major>` と書くが、
scripts/bump.ts:7-15 は `premajor / preminor / prepatch / prerelease` も受け付け、CLAUDE.md も
`<patch|minor|major|pre*>` と書いている。今回の差分とは無関係の既存ずれ。

**選択肢**: a) ★ README を `<patch|minor|major|pre*>` に揃える / b) 現状維持（README は
利用者向けで、pre リリース運用はオーナーのみ）

**リスク**: 無し。0.6.0 のリリース作業そのものには影響しない（`minor` は両方に載っている）。

**対象**: README.md:510, 515 / scripts/bump.ts:7-15 / CLAUDE.md:32-33
**影響範囲**: README のみ。

### G4-14 🔵 Info — JSDoc（日本語）と README（英語）の非対称は既存・今回のスコープ外

`into` の JSDoc（core.ts:129-146 / hf/mod.ts:71-81）は日本語で、JSR のドキュメントページには
そのまま日本語で載る。README は英語。この非対称はライブラリ全体で既存であり、今回の追加は
既存規約に沿っている（変更提案ではなく事実の記録）。

### G4-15 🔵 Info — known-issues.md への追記は不要と判断した根拠

docs/known-issues.md は「本ライブラリ起因のオープンな既知問題は無い」で、今回の差分でも
新規のオープン問題は生じていない。候補として検討したのは 2 件で、いずれも known-issues では
なく limitations が適切と判断した:
- Cache 実装が body を stream で返すかで RAM 効果が変わる（ADR 0009:70-72）→ 実装依存の制約
  であってバグではない（G4-09 で limitations へ）。
- `fetchHfFiles` へ同一 `into` を渡した場合の並列上書き（G4-04）→ 文書化された誤用。コード側で
  fail loud を入れる（G4-04 b）なら known-issues にも残らない。

### G4-16 🔵 Info — publish include / CLAUDE.md Layout / release.yml は現状で最新

- deno.json:22-32 の include（README / LICENSE / deno.json / src/\*\*/\*.ts）と exclude
  （\*.test.ts / src/testing）は、今回の追加ファイル（docs/decisions/0009 と 2 つのテスト）に
  対して変更不要。docs/ は元から未同梱で、README のリンクは全て `blob/main` の絶対 URL
  （相対リンク 0 件を grep で確認済み）。
- CLAUDE.md:8-12 の mod.ts 公開一覧は src/mod.ts:31-51 と一致。`into` はオプション型の
  プロパティ追加なので Layout の記述に変更は要らない。
- .github/workflows/release.yml は check → verify_tag → publish の順で、今回の変更に依存する
  箇所は無い。

## リリース検品チェックリスト（0.6.0）

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| 未リリースコミットの範囲 | ✅ 1 件（3b13d16）のみ | `git log v0.5.0..HEAD` = 3b13d16。v0.5.0 タグは 37d781b |
| バージョン番号（追加のみ → minor） | ✅ 0.6.0 が妥当 | 公開 API は追加のみ・既定挙動不変（ADR 0009:68 / core.ts:367）。本リポの前例も「機能追加 = minor」（v0.3.0 = single-flight、v0.3.1 = fix のみ）。0.x では breaking も minor に載せる運用（0.4.0→0.5.0）なので、追加のみを minor に載せても衝突しない |
| 現在の版と焼き込み VERSION の一致 | ✅ 双方 0.5.0 | deno.json:3 / src/mod.ts:31。drift ガードは scripts/version_sync.test.ts（`deno task check` に含む）と scripts/verify_tag.ts:15-22 |
| bump 手順 | ✅ `deno task bump minor` | scripts/bump.ts:36-52（clean-tree ガード）→ 55-66（deno.json）→ 85-103（src/mod.ts）→ 105-115（`deno.json` + `src/mod.ts` の 2 ファイルだけを 1 コミット）。tag / push はしない（bump.ts:116-118） |
| tag 規約 | ✅ `v0.6.0` | .github/workflows/release.yml:7 のコメント + scripts/verify_tag.ts（tag == deno.json.version を fail loud 検証） |
| release.yml の変更要否 | ✅ 不要 | checkout → setup-deno → `deno task check` → verify_tag → `deno publish`（OIDC）。今回の差分に依存する箇所なし |
| publish include の過不足 | ✅ 変更不要 | deno.json:22-32。追加ファイルは docs/decisions/0009（元から未同梱）と \*.test.ts（exclude 済み） |
| README 内リンク | ✅ 相対リンク 0 件 | `grep -on "](…)" README.md` で `https://` 以外のヒット無し。新設の ADR 0009 リンク（README:244）も blob/main 絶対 URL |
| 0.5.0 → 0.6.0 の移行節 | ✅ 不要 | 追加のみで既定挙動不変。`into` 未指定の分岐（core.ts:367, 619-620, 896）は従来経路そのまま。※ 型面の注記（TypeScript 5.7 以降）は G4-06 で別途 |
| 既存利用者のコード互換 | ✅（実行時）/ ⚠️（型・要判断） | 実行時は追加のみ。型は `Uint8Array<ArrayBuffer>` が公開型に初登場（G4-06） |
| ROADMAP との整合 | ✅ 抵触なし | 0.6.0 候補（revalidate / HF sha256 後付け移送 / 寿命軸）はいずれも未着手のまま。`into` は ROADMAP 外の新規要求 |
| known-issues の追記要否 | ✅ 不要 | G4-15 の判断根拠を参照 |
| 検証（check / publish --dry-run） | ✅ オーケストレータ実施済み | check 緑（170 passed）・`deno publish --dry-run` 成功（本グループでは未実行 — 読み取り専用制約） |

## リリースノート材料

### 対応表（コミット ↔ ノート項目）

| コミット | 利用者可視の変更 | ノートの節 |
| --- | --- | --- |
| 3b13d16 | `FetchBytesOptions.into` — 呼び出し側が確保したバッファへ **network 受信も cache ヒットも**直接書き、戻り値はその prefix view（core.ts:146, 366-386, 617-627） | ✨ Features |
| 3b13d16 | `HfFileSpec.into` — HF 層でもファイル毎に同じ口が使える（hf/mod.ts:81, 241） | ✨ Features |
| 3b13d16 | cache ヒットが `arrayBuffer()` ではなく body stream 読みになる（`into` 指定時のみ。core.ts:619-627） | ✨ Features（上の項の内訳） |
| 3b13d16 | 容量不足は fail loud（network は超過チャンクで打ち切り・非キャッシュ / ヒットはエントリ温存・network へも縮退しない / `expectedBytes` 超過は事前 throw）— ADR 0007 と同型（core.ts:410-419, 630-635, 804-814） | ✨ Features（挙動契約として明記） |
| 3b13d16 | single-flight の合流者は leader のバッファを共有しない（leader は合流者がいるときだけ 1 回コピー。core.ts:890-897, 842-853） | ✨ Features（内訳）または 📝 Docs |
| 3b13d16 | sha256 検証のコピー条件を「tight view でなければコピー」→「SharedArrayBuffer 背面のときだけコピー」へ緩和（core.ts:479-495）。数 GB 級でコピー 1 回ぶんの削減 | ✨ Features（内部最適化として 1 行）|
| 3b13d16 | ADR 0009 追加・limitations に `into` 項（docs/decisions/0009 / limitations.md:41-49） | 📝 Docs |
| — | 💥 Breaking / 🐛 Fixes に該当する変更は無い | （節ごと省略） |

### 含めるべき主張

1. 冒頭 1 段落: 「同じバッファを渡し回して数百 MiB の shard を逐次読む」用途に向けた
   **追加のみ**のリリースであること（前回のような移行節が不要な理由が伝わる）。
2. `into` は **network ダウンロードと cache ヒットの両方**に効く（cache ヒット側にも効くのが
   このリリースの肝 — 既存の `expectedBytes` は network 側だけの話だった）。
3. 戻り値は prefix view であり、**バッファの所有権は呼び出し側**・寿命は「次に同じバッファへ
   書くまで」という契約。`decode` 併用時は器に保存形 raw が入り、戻り値は別バッファ。
4. 容量不足は縮退せず fail loud で、cache ヒットでは**エントリを消さず network にも出ない**
   （破損でも cache I/O 失敗でもない、という位置づけ）。
5. single-flight の合流者は leader のバッファを受け取らない（合流者がいるときだけ 1 回コピー）。
6. `prefetchUrl` / `prefetchHfFile` は `into` を見ない（バイト列を手元に持たないため）。
7. `fetchHfFiles` は並列なので、同じバッファを複数 spec へ渡さないこと（逐次 `fetchHfFile`
   で使う）。← G4-04 の判断次第で表現を強める。
8. ADR 0009 へのリンク（`blob/main` 絶対 URL）と **Full Changelog**
   `https://github.com/hdae/fetch-cache/compare/v0.5.0...v0.6.0`。
9. （G4-06 を a で処理する場合）npm 経由の利用は TypeScript 5.7 以降が必要、の 1 行。

### 避けるべき表現（前回 D 群の教訓）

| 避ける | 理由 | 代替 |
| --- | --- | --- |
| 「No allocation at all」「zero allocation」 | 受信チャンク・合流者コピー・body null 経路・Cache 実装依存で破れる（G4-01） | 「no per-call receive/result buffer allocation」 |
| 「the heap never holds more than one buffer」 | 同上の無条件断定（G4-02） | 「keeps the sequential case at one buffer's worth」 |
| 「cache hits no longer materialize anything」 | ヒット側の効果は Cache 実装が body を stream で返すか次第（ADR 0009:70-72 / G4-09） | 「reads the entry through its body stream instead of `arrayBuffer()`」+ 実装依存の但し書き |
| 「throws before any network I/O」（HF 層を含めた断定） | HF 層は revision 解決が先に出る（G4-03） | 「`fetchBytes` throws before the request is made」 or 「before the file download」 |
| 「halves the peak / load time」を一般的な効果として断定 | 実測は下流の 1 構成のみ・本リポ未測定（G4-12） | 「in the downstream workload that motivated it, …」と条件を付ける |
| 「`into` works everywhere in the HF layer」 | `prefetchHfFile` は見ない（hf/mod.ts:339-362） | 「per-file on `HfFileSpec`; prefetch ignores it」 |
| 「breaking changes: none」だけで済ませる | 型面（`Uint8Array<ArrayBuffer>`）の前提が増えている可能性（G4-06） | 「additive only at runtime; npm consumers need TypeScript 5.7+」 |

## 横断所見

1. **D 群の再発パターンが特定できる**: 過大保証は「新機能の効果を要約する 1 文」で必ず起きて
   いる（0.5.0 では `evict` の「repo 丸ごと解放」、今回は `into` の「確保ゼロ / never」）。
   ADR には正しい caveat（0009:70-72）が書かれていて、README へ写すときに落ちる。**ADR の
   Consequences を README / limitations へ写す工程を、機能追加のチェック項目にする**のが構造的
   な対策になる（G4-01 / G4-02 / G4-09 は同一原因）。
2. **「事前検査は入口で行う」原則が層ごとに揃っていない**: sha256 の形式検査は HF 入口
   （hf/mod.ts:257-270）で解決前に済ませているのに、`into` の容量検査は cache 層の入口
   （core.ts:804-814）にしかない（G4-03）。0.5.0 のリリースノートで謳った原則なので、次に
   事前検査を足すときの置き場所を決めておくと再発しない。
3. **caller-owned メモリが cache.put まで届く経路がある**: `storableResponse`（core.ts:464-474）
   は渡された view を stream チャンクとして enqueue するため、`into` 指定時は**呼び出し側所有の
   メモリが Cache 実装へ渡る**。`await cache.put` の完了前に制御が呼び出し側へ戻ることは無いので
   単一呼び出しでは安全だが、同一バッファの並行使用（G4-04）だけがこの前提を破る。並行安全性の
   レンズを持つ別グループへ引き継ぐ価値がある（本グループの読み取り専用制約では実測不可 —
   **uncertain**）。
4. **ADR 間の改定関係の記録漏れ**: 0008 は「本 ADR が一部を改定する」と関連行に書く運用を
   確立したが、0009 は 0005 §1（tight view 保証）を覆したのに同じ書き方をしていない
   （G4-08）。ADR が増えるほど効いてくるので、今回で運用を固定しておきたい。
5. **リリース機構そのものは健全**: version 単一真実源（deno.json）→ bump の 1 コミット同期 →
   check → verify_tag → OIDC publish の連鎖に穴は見当たらず、今回の差分で触る必要は無い。
</content>
</invoke>
