---
id: G3
topic: テスト品質（3b13d16 = v0.5.0 以降の唯一の未リリースコミット `feat: into`）
files_reviewed:
  - src/mod.test.ts（+253 / -0。into 節 1621-1873 が新規）
  - src/hf/mod.test.ts（+31 / -0。814-843 が新規）
  - src/core.ts（読み合わせ用。readBody / acquireAndDecode / fetchBytesWithKey / sha256HexNative）
  - src/hf/mod.ts（読み合わせ用。HfFileSpec.into / fetchResolvedFile / fetchHfFiles / prefetchHfFile）
  - src/testing/mock_fetch.ts（mockFetch / chunkedResponse。今回未変更）
  - docs/decisions/0009-into-caller-buffer.md / docs/limitations.md / README.md（契約の一次資料）
  - .claude/reviews/2026-08-28_c91e955/ROADMAP.md（前回の見送りテストギャップ）
date: 2026-09-02
model: opus
---

# G3 — テスト品質レビュー（`into` 追加分）

## サマリ

**総評: 追加された 12 本は全て「実装のどこか 1 行を壊せば赤になる」テストで、トートロジー・
型で保証済みの assertion・deadline 無しポーリング・固定名前空間の掃除漏れはいずれも無い。**
特に良い点が 3 つある。① 器（`into`）を実長より大きく取り、`into[実長]` の番兵バイトと
`assertPrefixView`（buffer 同一性 + byteOffset + byteLength）で「器を指しているか」を実装から
独立に観測している。② 容量不足系は `lazyResponse` の `pulled()` / `cancelled()` で
「どのチャンクで止めたか」「body を解放したか」まで縛っており、fail loud の縮退禁止
（ADR 0009 §2）が実際に検証されている。③ single-flight の 2 本は `Promise.withResolvers`
のゲートで合流順序を決定的にしており、ポーリングもタイムアウト待ちも無い。

既存テストの**弱体化・書き換えは 1 行も無い**（`git show 3b13d16 --numstat`: mod.test.ts
+253/-0、hf/mod.test.ts +31/-0。差分中の `-` 行は diff ヘッダの 2 行のみ）。

問題は「書かれたものの質」ではなく**網羅**にある。ADR 0009 が定めた契約のうち、
**キャッシュヒット側の縮退経路（self-heal 2 種）・`body === null` フォールバック・空 body の
境界・ヒット時に `onProgress` を発火させない契約**が未凍結で、いずれも「壊しても 12 本は緑の
まま」通る。とりわけ ADR 0009 の主目的である「ヒットは `arrayBuffer()` ではなく stream で器へ
流す」は、現状どのテストも `arrayBuffer()` 実装と区別できない（後述 G3-06 に観測方法あり）。

重大度別件数（全 20 件・重要度で絞っていない）:

| 重大度 | 件数 | 内訳 |
| --- | --- | --- |
| 🔴 critical | 0 | — |
| 🟠 warning（未凍結: 分岐 / 失敗パス / 境界 / 並行） | 6 | G3-01〜G3-06 |
| 🟡 note（未凍結だが分岐の亜種・間接凍結あり） | 8 | G3-07〜G3-14 |
| 🔵 low（改善提案） | 6 | G3-15〜G3-20 |
| 🟢 良好（指摘なし） | — | 追加 12 本の本体・既存テストの非改変 |

---

## ファイル別分類

| ファイル | 判定 | 理由 |
| --- | --- | --- |
| `src/mod.test.ts`（1621-1873 新規 11 本 + ヘルパ 1） | 🟡 | 11 本とも実装依存の観測点を持ち有効。ヒット側の縮退経路・null body・空 body・onProgress 契約が未凍結（G3-01〜06, 09, 10, 13）。 |
| `src/hf/mod.test.ts`（814-843 新規 1 本） | 🟡 | `spec.into` の転送は凍結済み。HF 層固有の契約（`prefetchHfFile` が見ない / `fetchHfFiles` の器分離）は未凍結（G3-11, G3-12）。 |
| `src/core.ts`（テストレンズでの被覆） | 🟡 | `readBody` の into 分岐は網羅（成功 / 容量超過 / prefix view）。`body===null` 分岐 390-402 と、`acquireAndDecode` のヒット側 catch 経路 636-675 が未到達。 |
| `src/hf/mod.ts`（テストレンズでの被覆） | 🟡 | `fetchResolvedFile` の `into: spec.into` は凍結。`prefetchHfFile` が `into` を渡さないことは未凍結。 |
| `src/testing/mock_fetch.ts` | 🟢 | 今回未変更。新規テストは既存の `mockFetch` / `chunkedResponse` と、mod.test.ts ローカルの `lazyResponse`（1565-1589）で足りており、ヘルパの重複追加も無い。 |
| 既存テスト（全 170 本） | 🟢 | 削除・改変ゼロ。`assertStrictEquals` の import 追加のみ（両ファイル）。 |

---

## 追加テスト 12 本の読み合わせ

「赤にする実装行」は**机上で特定した**もの（読み取り専用のためテストは実行していない。
オーケストレータ実行済みの 170 passed / 0 failed / 1 ignored を前提にしている）。

| # | テスト名（path:line） | 縛っている契約 | 赤にする実装行（フォルト注入） | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `into は network 受信を器の先頭へ書き、prefix view を返す`<br>mod.test.ts:1633 | ADR 0009 §1（network → 器 / 戻り値 = prefix view）+ 「into 経路でも通常どおりキャッシュされる」 | `core.ts:367-368`（`buffer = into`）を消す → content-length 無しなので蓄積経路 → 別バッファ → `assertPrefixView` 赤。`core.ts:434`（`return into.subarray(0, loaded)`）を `.slice()` に → buffer 同一性が赤。`core.ts:701`（`storableResponse(bytes, …)`）を `storableResponse(into, …)` に → 再読出しが 8 バイトになり `assertEquals(…, BYTES_A)` 赤 | 🟢 有効 |
| 2 | `into はキャッシュヒットでも器へ流し込み、network に出ない`<br>mod.test.ts:1652 | ADR 0009 §1（ヒットも器へ）+ ヒット時 network 非通過 | `core.ts:619-627` の三項を `new Uint8Array(await cached.arrayBuffer())` 固定に → 戻り値が別バッファ → `assertPrefixView` 赤 | 🟢 有効（ただし「stream で流したか」は区別できない → G3-06） |
| 3 | `同じ器を渡し回すと毎回先頭から上書きされ、戻り値は各回の実長になる`<br>mod.test.ts:1667 | 所有権契約（戻り値の寿命は次の書き込みまで）+ 実長 = 各回の受信長 | `core.ts:434` を `into.slice(0, loaded)` に → 最終行 `a.subarray(0,3) === BYTES_B` が `[1,2,3]` になり赤 | 🟢 有効（最終 assertion は `a` が器の view であることを独立に縛る＝冗長ではない） |
| 4 | `into 使用時の sha256 は器の prefix view で検証される（network・記録なしヒット）`<br>mod.test.ts:1685 | ADR 0009 §4（digest は view の範囲）+ network 不一致は非キャッシュ + 記録なしヒットの backfill | `core.ts:492-494` を `new Uint8Array(bytes.buffer)` に → 器 64B の残り 0xff まで digest され一致ケースが不一致で赤。`core.ts:656-663`（backfill put）を消す → `SHA_HEADER` が null で赤。backfill を `storableResponse(opts.into, …)` に → 保存body が 64B になり `recorded.arrayBuffer()` 比較が赤 | 🟢 有効（器を実長の 12 倍にして「範囲外まで読んでいないか」を観測しているのが要点） |
| 5 | `into と decode の併用は器に保存形 raw・戻り値は decode 後`<br>mod.test.ts:1724 | ADR 0009 §1（器 = 保存形 raw / 戻り値 = decode 結果） | `core.ts:688-697` の順序を崩し decode 結果を器へ書くようにする → `into.subarray(0, compressed.length) === compressed` が赤 | 🟢 有効（🔵 G3-18: 「戻り値は別バッファ」の assertion のみ欠） |
| 6 | `into の容量不足は network 受信を打ち切って throw し、キャッシュしない`<br>mod.test.ts:1742 | ADR 0009 §2（network は打ち切り・cancel・非キャッシュ） | `core.ts:412-419`（into 分岐）を消す → 蓄積経路へ落ちて成功 → `assertRejects` 赤。`core.ts:414`（`reader.cancel()`）だけ消す → `lazy.cancelled()` 赤。`pulled()===2` は「3 チャンク目まで引いていない」を縛る | 🟢 有効（本差分で最も強いテスト。`highWaterMark: 0` の pull 駆動で `pulled` が決定的） |
| 7 | `into の容量不足はキャッシュヒットでも throw し、エントリを消さず network にも出ない`<br>mod.test.ts:1766 | ADR 0009 §2（ヒットは entry 温存・network 非縮退・`onCacheError` 非通知） | `core.ts:632`（`if (error instanceof IntoCapacityError) throw error;`）を消す → `onCacheError({op:"match"})` 発火 + network 縮退 → `cacheErrors` 赤 + `calls.length` 赤 | 🟢 有効（3 つの禁止を同時に縛っており、最後の再読出しで evict されていないことまで見ている） |
| 8 | `expectedBytes が into の容量を超える申告は network に出る前に throw する`<br>mod.test.ts:1791 | ADR 0009 §2 第 3 項（入口 throw） | `core.ts:805-814`（入口ガード）を消す → readBody 側の同型エラーになるがメッセージは通るため、`assertEquals(calls.length, 0)` が赤（＝この 1 行が load-bearing） | 🟢 有効（🔵 G3-19: 申告値 `expectedBytes 5 バイト` を見ていない） |
| 9 | `leader の into は合流者へ渡らない（合流者はコピー、または自分の into を受け取る）`<br>mod.test.ts:1810 | ADR 0009 §3（呼び出し側所有メモリを共有しない） | `core.ts:895-897` の `entry.followers > 0 ? raw.slice() : raw` を `raw` 固定に → `b.buffer === leaderInto.buffer` が真で赤 + `leaderInto.fill(0)` 後に `b` がゼロで赤。`core.ts:842-853`（合流者の写し）を消す → `assertPrefixView(c, followerInto, …)` 赤 | 🟢 有効（`fill(0)` 後の再検査で「コピーが本当に切れているか」を実態で観測している。合流順序は `inflight.set` まで await 無し＝決定的） |
| 10 | `合流者の into が保存形より小さければその呼び出しだけ throw する`<br>mod.test.ts:1841 | ADR 0009 §3（合流者の容量不足は自分だけ落ちる・evict しない） | `core.ts:844-850`（合流者側の容量検査）を消す → `opts.into.set(raw)` の `RangeError`（別メッセージ）になり `assertRejects(…, "into の容量 2 バイト")` 赤。合流者側に evict を足す → 末尾の「エントリ健在」assertion が赤 | 🟢 有効（合流者の self-heal 禁止＝ ADR 0004 の再確認としても効いている） |
| 11 | `cache:false でも into は効く（受信を器へ書く）`<br>mod.test.ts:1865 | `cache:false` 経路（合流も cache も通らない素の fetch）へも `into` が届く | `core.ts:818-825`（cache:false 分岐の `acquireAndDecode` 呼び出し）で opts を素通ししなくする → `assertPrefixView` 赤 | 🟢 有効（🔵 G3-15: cache 非接触の assertion と finally が無い） |
| 12 | `HfFileSpec.into は cache 層へ流れ、network もキャッシュヒットも器の prefix view を返す`<br>hf/mod.test.ts:814 | `HfFileSpec.into` → `FetchBytesOptions.into` の転送（network / ヒットの両方） | `src/hf/mod.ts:241`（`into: spec.into`）を消す → `assertStrictEquals(fromNetwork.buffer, into.buffer)` 赤。ヒット側は `into.fill(0)` 後の `assertEquals(fromCache, BYTES)` が赤 | 🟢 有効（🔵 G3-16: `byteOffset` / `byteLength` を見ていない＝ mod.test.ts の `assertPrefixView` 相当が無い） |

補足（トートロジー・冗長性の点検結果）:

- 12 本のうち**型で保証済みの assertion は無い**。`assertStrictEquals(bytes.buffer, into.buffer)`
  も `byteOffset === 0` も型レベルでは何も保証されていない（`Uint8Array<ArrayBuffer>` は背面型
  だけを言う）ため、いずれも実装で壊せる。
- #3 の最終 assertion（`a.subarray(0,3) === BYTES_B`）は一見 `b` の再確認に見えるが、`a` には
  `assertPrefixView` を当てていないため「`a` が器の view である」ことを独立に縛る。冗長ではない。
- **deadline 無しのポーリングはゼロ**。並行 2 本（#9 / #10）はどちらも `Promise.withResolvers`
  の明示ゲートで、待ちループを使っていない。
- **固定名前空間 "fetch-cache" の後始末**は #11 を除く全本が `finally { await caches.delete(CACHE_NAME) }`
  を持つ。#11 は `cache: false` なので名前空間を開かない（既存の
  `cache:false（素の fetch 経路）でも async decode`（mod.test.ts:864）と同じ流儀）。掃除漏れでは
  ないが、退行時に汚染を検知できない点だけ G3-15 で扱う。

---

## ADR 0009 契約 × 分岐の網羅表

「凍結済み」= そのテストを消す/実装を壊すと赤になる。「未凍結」= 壊しても 12 本は緑のまま。

| # | 契約・分岐 | 状態 | 凍結しているテスト / 未凍結の理由 |
| --- | --- | --- | --- |
| a | network + into 通常（器へ書く・prefix view・通常どおりキャッシュ） | 🟢 凍結済み | #1（mod.test.ts:1633） |
| b | `body === null` フォールバック + into（`into.set` / 容量不足 throw） | 🟠 **未凍結** | `core.ts:390-402` に到達するテストが無い。既存の null body テスト（mod.test.ts:515）は into 無し → G3-01 |
| c | 容量超過 network（cancel されたか・キャッシュされないか） | 🟢 凍結済み | #6（`pulled()===2` / `cancelled()===true` / `listCachedUrls()===[]`） |
| d | 容量超過キャッシュヒット（entry 温存・network 不通過・onCacheError 非通知） | 🟢 凍結済み | #7 |
| e | `expectedBytes > 容量` の入口 throw | 🟢 凍結済み | #8（`calls.length===0`） |
| f-1 | into + decode（network） | 🟢 凍結済み | #5 |
| f-2 | into + decode（キャッシュヒット） | 🟡 未凍結 | ヒット側は `checkAndDecode` を共有するため機序は同じ。ただし「器に raw・戻り値は decode 後」がヒット経路でも成り立つことは未観測 → G3-09 |
| g-1 | into + sha256（network 一致 / 不一致） | 🟢 凍結済み | #4 前半 |
| g-2 | into + sha256（記録あり一致ヒット = trusted・再ハッシュ無し） | 🟡 未凍結（間接のみ） | HF の #12 が結果として通る（1 回目 network で記録が焼かれ 2 回目がヒット）が、`trusted` 分岐（`core.ts:648-649`）を狙った assertion は無い → G3-07 |
| g-3 | into + sha256（記録なしヒット → 実ハッシュ突合 → backfill） | 🟢 凍結済み | #4 後半（記録ヘッダ + 保存 body の両方を検査） |
| g-4 | into + sha256（記録不一致 → self-heal → network で器へ再書き込み） | 🟠 **未凍結** | `core.ts:611-642`（staleRecord → `cached.body.cancel()` → delete → network）に into を通す経路が未到達 → G3-02 |
| h | into + validate / decode 拒否 → self-heal → network で器へ再書き込み | 🟠 **未凍結** | `core.ts:666-675`（ヒット catch → delete → フォールスルー）に into を通す経路が未到達。器が「ヒットで一度書かれた後もう一度 network で上書きされる」二度書きも未観測 → G3-03 |
| i-1 | single-flight: leader into × 合流者（into 無し = コピー / into 有り = 写し） | 🟢 凍結済み | #9 |
| i-2 | single-flight: 合流者の into が容量不足 | 🟢 凍結済み | #10 |
| i-3 | single-flight: leader into 無し × 合流者 into 有り（成功系） | 🟡 未凍結 | #9 は leader に into がある構成のみ。leader が into 無しのとき共有 raw は leader 自身のバッファ（コピーされない）で、合流者はそれを自分の器へ写す — 別の組み合わせ → G3-08 |
| j | cache:false + into | 🟢 凍結済み | #11 |
| k-1 | HF: `fetchHfFile` の `spec.into` 転送 | 🟢 凍結済み | #12 |
| k-2 | HF: `fetchHfFiles` に同じバッファ（= 上書きし合う）/ spec 毎の別バッファ | 🟡 未凍結 | `fetchHfFiles` は `Promise.all`（hf/mod.ts）で完全並列。limitations.md に「戻り値同士が上書きし合う」と明記した挙動もその回避（spec 毎に別器）も未観測 → G3-12 |
| k-3 | HF: `prefetchHfFile` は `into` を見ない | 🟡 未凍結 | `HfFileSpec` に `into` があるので型は通るが `prefetchUrlWithKey` へは渡らない（hf/mod.ts の prefetch 経路）。器が無傷であることは未観測 → G3-11 |
| l | 同じバッファの逐次再利用（先頭から上書き・戻り値は各回の実長） | 🟢 凍結済み | #3 |
| m | `loaded === 0`（空 body）+ into（`into.subarray(0,0)`・空エントリの成立） | 🟠 **未凍結** | 既存の空 body テスト（mod.test.ts:515）は into 無し。境界（長さ 0 の prefix view / 空 body の `storableResponse`）が未観測 → G3-05 |
| n | `sha256HexNative` の部分ビュー digest（コピー無し） | 🟡 部分凍結 | 「view の範囲だけを digest する」は #4 が器 64B / 実長 5B で強く縛っている。「コピーを作らない」は観測不能、`hasArrayBufferBacking` の false 側（SharedArrayBuffer 背面）は公開 API から到達不能 → G3-14 |
| 追加 | into のキャッシュヒットで `onProgress` が発火しない（公開契約） | 🟠 **未凍結** | 本差分でヒット経路が `readBody` を通るようになったため、第 3 引数に `emitProgress` を渡す退行が起きうる。`core.ts:621-627` が `undefined` を渡していることは未観測 → G3-04 |
| 追加 | ヒット経路が本当に stream 読みか（`arrayBuffer()` で materialize していないか） | 🟠 **未凍結** | ADR 0009 の RAM 目的そのもの。#2 は `into.set(new Uint8Array(await cached.arrayBuffer()))` 実装と区別できない → G3-06（観測方法あり） |
| 追加 | into があるとき `expectedBytes` は確保に使われない（申告超過でも蓄積経路へ落ちない） | 🟡 未凍結 | `core.ts:367-370` の分岐順序（into 優先）。`expectedBytes: 2, into: 8B, 実受信 5B` が成功することは未観測 → G3-10 |
| 追加 | into + `recheck: true` のヒット再ハッシュ（器の prefix view で） | 🟡 未凍結 | `trusted` が false に落ちる別経路。機序は g-3 と同じだが組み合わせは未観測 → G3-13 |

---

## 詳細指摘

### G3-01 🟠 warning — `body === null` フォールバックの `into` 経路（成功 / 容量不足）が未凍結

**質問: `readBody` の `body === null` 分岐に足した `into` の 2 分岐（写し取り・容量不足 throw）を凍結しますか。**

概要: `core.ts:388-403` は body を持たないランタイム向けのフォールバックで、今回
`into === undefined` の早期 return（393）・容量検査（394-400）・`into.set(bytes)`（401）・
prefix view の return（402）が新設された。既存の null body テスト（mod.test.ts:515）は
`into` を渡さないため 393 で抜け、394-402 は**一度も実行されない**。この 9 行を丸ごと
`return bytes` に置き換えても 12 本は緑のまま通り、`into` 契約（戻り値 = 器の view）が
null body ランタイムでだけ黙って破れる。前回 ROADMAP の見送り項目「readBody body===null
経路の buffer 解放」と同じ場所に、今回さらに未検証コードが積まれた形。

選択肢:
- a) ★ 2 ケース（容量足りる = prefix view / 足りない = `IntoCapacityError`）を 1 本のテストで凍結する。
- b) 成功ケースだけ凍結し、容量不足は他経路（#6/#7）と同型なので省く。
- c) 見送り（ROADMAP へ）。null body ランタイムは Deno / 主要ブラウザでは発生しないため。

リスク: a) を採らない場合、null body ランタイム（実測対象外）でのみ `into` の戻り値が器を
指さなくなる退行が CI をすり抜ける。ただし実害の露出は限定的。

対象: `src/core.ts:388-403` / 新規テストは `src/mod.test.ts` の into 節（1621-1873）末尾。

影響範囲: テストのみ（実装変更なし）。

引き継ぎ（テスト仕様）:
- ファイル: `src/mod.test.ts`（into 節、`cache:false` テストの直後）。
- 縛る振る舞い: body を持たない応答でも `into` の先頭へ写し、prefix view を返す。容量不足は
  `IntoCapacityError` で落ちる。
- 器の作り方: `new Response(BYTES_A)` を作ってから
  `Object.defineProperty(response, "body", { value: null })` で body を潰す（`arrayBuffer()`
  は生きる）。`new Response(null)` は空になってしまうので使えない。
- ケース 1（成功）: `into = new Uint8Array(new ArrayBuffer(8)).fill(0xff)` →
  `assertPrefixView(bytes, into, 5)` / `assertEquals(bytes, BYTES_A)` /
  `assertEquals(into[5], 0xff)`。
- ケース 2（容量不足）: `into = new Uint8Array(new ArrayBuffer(3))` →
  `assertRejects(…, Error, "into の容量 3 バイト")` かつ
  `assertEquals(await listCachedUrls(), [])`（不正物を格納していない）。
- フォルト注入で赤になる行: ケース 1 は `core.ts:401-402`（`into.set` / `subarray`）を消して
  `return bytes` にすると赤。ケース 2 は `core.ts:394-400` の容量検査を消すと `into.set` の
  `RangeError`（別メッセージ）になり `assertRejects` のメッセージ照合が赤。
- 後始末: `finally { await caches.delete(CACHE_NAME) }`。

---

### G3-02 🟠 warning — 記録不一致ヒット（stale record）→ self-heal → network で器へ再書き込みが未凍結

**質問: `sha256` の記録が期待値と食い違うヒットから network 再取得へ落ちる経路を、`into` 付きで凍結しますか。**

概要: `core.ts:607-642` の staleRecord 経路は「バイト列を読まずに `cached.body.cancel()` →
`cache.delete` → network へフォールスルー」で、フォールスルー先の `readBody`（688-694）に
`opts.into` が渡る。この組み合わせは 12 本のどれも通らない。ここが壊れる形は 2 つある:
① staleRecord 側で誤って `readBody(cached, …, opts.into)` を呼ぶようになると、破棄するはずの
古い内容が呼び出し側の器へ書かれ、その後 network が上書きするまでの間に器が汚れる。
② フォールスルー先で `opts.into` を渡し忘れると、self-heal 後の戻り値だけ器を指さなくなる
（＝呼び出し側は前回の内容を GPU へ書く）。②は「ヒットしたときだけ契約が破れる」ため、
下流の逐次読みで最も痛い形の退行。

選択肢:
- a) ★ 記録不一致ヒット + `into` の 1 本を追加し、戻り値が器の prefix view であること・network に
  1 回出ること・エントリが新内容へ置換されることを縛る。
- b) 実装は `readBody` を共有しているので network 単体テスト（#1）で足りるとみなし見送り。
- c) G3-03（validate 拒否 self-heal）と 1 本に統合する。

リスク: b) を採ると、②の「フォールスルーで into を渡し忘れる」退行が完全に無検出になる
（network 単体テストは常に緑）。

対象: `src/core.ts:607-642`（stale 判定・cancel・delete）+ `:688-694`（フォールスルー先の readBody）。

影響範囲: テストのみ。

引き継ぎ（テスト仕様）:
- ファイル: `src/mod.test.ts` into 節。
- 前提の作り方: 既存の記録不一致テスト（`x-fetch-cache-sha256` を別値で焼いたエントリを
  `cache.put` で直接置く手口。mod.test.ts の sha256 節に同型の準備コードがある）を流用し、
  `cache.put(URL_A, new Response(BYTES_B, { headers: { [SHA_HEADER]: BYTES_B_SHA256 } }))` の
  ように **期待値と違う記録**を持つエントリを置く。
- 呼び出し: `fetchBytes(URL_A, { fetch, into, sha256: BYTES_A_SHA256 })`。mock は
  `new Response(BYTES_A)` を返す。
- 観測値: `assertPrefixView(bytes, into, BYTES_A.length)` /
  `assertEquals(bytes, BYTES_A)` / `assertEquals(calls.length, 1)`（network へ出た）/
  `cache.match(URL_A)` の body が `BYTES_A`・`SHA_HEADER` が `BYTES_A_SHA256`（置換された）。
- 器の作り方: `new Uint8Array(new ArrayBuffer(8)).fill(0xff)` にして
  `assertEquals(into[BYTES_A.length], 0xff)` で範囲外書き込みも見る。
- フォルト注入で赤になる行: `core.ts:692`（`opts.into` の受け渡し）を `undefined` に
  すると `assertPrefixView` が赤。`core.ts:614-615` を「stale でも読む」に変えると
  `into` の中身が一時的に `BYTES_B` になるが最終値は上書きされるため、そこは
  `assertEquals(calls.length, 1)` と `cache.match` の置換確認で担保する。

---

### G3-03 🟠 warning — `validate` / `decode` 拒否ヒット → self-heal → network で器へ再書き込みが未凍結

**質問: 破損キャッシュの self-heal（`core.ts:666-675`）を `into` 付きで凍結しますか。**

概要: ヒット経路で `checkAndDecode` が throw すると catch → `cache.delete` → network へ
フォールスルーする。`into` 付きだと **1 回の `fetchBytes` の中で器が二度書かれる**
（ヒット内容 → network 内容）。この二度書きは ADR 0009 の所有権契約の中で唯一「呼び出し側が
何もしていないのに器の内容が 2 回変わる」ケースで、既存の self-heal テスト
（mod.test.ts:534 付近の「破損キャッシュは evict して network から取り直す」）は `into` 無し。
G3-02 と機序は近いが、こちらは**器に一度書いてから捨てる**点が違う（stale record 側は
読まずに捨てる）。network 内容がヒット内容より短い場合に器の末尾に前回の残骸が残るのは
仕様どおり（戻り値は prefix view）だが、それを凍結しておかないと後から「安全のため
`into.fill(0)` する」といった変更が黙って入りうる（＝数 GB のゼロ埋めコストの逆行）。

選択肢:
- a) ★ `validate` 拒否で self-heal し、network 内容の prefix view が返ることを 1 本で縛る。
  併せて「器の末尾は消されない（`into[network長] === 0xff` ではなく**ヒット時の残骸**）」を
  明示的に観測して、将来のゼロ埋め追加を赤にする。
- b) self-heal の成立だけ縛り、器の末尾の状態は仕様化しない（実装自由度を残す）。
- c) 見送り。

リスク: b) を採ると「安全側のつもりのゼロ埋め」が無検出で入り、ADR 0009 の性能目的
（確保とゼロ埋めと GC の往復を消す）が静かに損なわれる。

対象: `src/core.ts:643-676`（ヒット側 try/catch と delete）+ `:688-697`。

影響範囲: テストのみ。ただし a) を採ると「器の末尾は触らない」が公開契約として固定される
（現状 limitations.md には書かれていない）。ここは要判断。

引き継ぎ（テスト仕様）:
- ファイル: `src/mod.test.ts` into 節。
- 前提: `cache.put(URL_A, new Response(BYTES_B))`（3 バイト）を直接置く。mock は
  `new Response(BYTES_A)`（5 バイト）を返す。
- 呼び出し: `fetchBytes(URL_A, { fetch, into, validate: (bytes) => { if (bytes.length !== 5) throw new Error("破損"); } })`。
  器は `new Uint8Array(new ArrayBuffer(8)).fill(0xff)`。
- 観測値: `assertPrefixView(bytes, into, 5)` / `assertEquals(bytes, BYTES_A)` /
  `assertEquals(calls.length, 1)` / `cache.match(URL_A)` の body が `BYTES_A`（置換済み）。
- 追加観測（a を採る場合）: 器の末尾 `into[5..8)` が `0xff` のままであること（ヒット内容は
  3 バイトなので 3..5 は network が上書き、5 以降は誰も触らない）。
- フォルト注入で赤になる行: `core.ts:669`（self-heal の `cache.delete`）を消すと
  次回読み出しが破損エントリのままになる（同テスト内で 2 回目の `fetchBytes` を打てば赤）。
  `core.ts:692` の `opts.into` を落とすと `assertPrefixView` が赤。`readBody` の冒頭に
  `into?.fill(0)` を足すと追加観測が赤。

---

### G3-04 🟠 warning — 「キャッシュヒット時 `onProgress` は呼ばれない」が `into` 経路で未凍結

**質問: 本差分でヒット経路が `readBody` を通るようになったことによる `onProgress` 退行を凍結しますか。**

概要: `onProgress` の公開 doc は「キャッシュヒット時は呼ばれない」（`core.ts:148-153`）と
明言している。従来ヒット側は `cached.arrayBuffer()` で進捗を発火しようが無かったが、今回
`readBody(cached, requestUrl, undefined, undefined, opts.into)`（`core.ts:621-627`）を通るように
なり、**第 3 引数に `emitProgress` を渡すだけでこの契約が破れる**構造になった。しかも
`readBody` の progress は「ダウンロード進捗」の意味なので、ヒットで発火すると呼び出し側の
プログレス UI が二重に進む。この 1 文字の退行を検出するテストが無い。

選択肢:
- a) ★ 「into 付きのキャッシュヒットで `onProgress` が 1 回も呼ばれない」を 1 本で縛る（既存の
  #2 に assertion を足すのでも良い — 器と mock は既にある）。
- b) 既存の onProgress テスト群に into 版を足す。
- c) 見送り（doc のみ）。

リスク: c) は「公開 doc に書いてある契約が、doc を読んだだけでは守られていると確認できない」
状態を残す。コストは assertion 2 行なので見送る理由が薄い。

対象: `src/core.ts:621-627`（第 3 引数の `undefined`）/ `src/mod.test.ts:1652-1665`（#2 に追記可）。

影響範囲: テストのみ。#2 への追記なら新規テストすら不要。

引き継ぎ（テスト仕様）:
- ファイル: `src/mod.test.ts:1652`（#2 `into はキャッシュヒットでも器へ流し込み、network に出ない`）へ追記。
- 変更: `const events: FetchProgress[] = []` を用意し、2 回目の `fetchBytes` に
  `onProgress: (p) => events.push(p)` を渡す。末尾に
  `assertEquals(events, [], "キャッシュヒットで onProgress が発火している")`。
- フォルト注入で赤になる行: `core.ts:623` の第 3 引数 `undefined` を `emitProgress` に
  変えると `events` が 1 件以上になり赤。

---

### G3-05 🟠 warning — 空 body（`loaded === 0`）+ `into` の境界が未凍結

**質問: 長さ 0 の prefix view という境界を凍結しますか。**

概要: `core.ts:434`（`return into.subarray(0, loaded)`）は `loaded === 0` でも成立し、
長さ 0 の view を返す。その view はさらに `checkAndDecode`（sha256 / validate / decode）へ渡り、
`storableResponse` で長さ 0 の Uint8Array が `controller.enqueue` される。既存の空 body テスト
（mod.test.ts:515）は `into` 無し・`body === null` 経路で、**stream があって中身が 0 バイト**
という組み合わせ（`chunkedResponse([])`）は into 有無を問わず未検証。境界としては
`subarray(0, 0)` の byteOffset・空 body の `cache.put` 成立・次回ヒットで空 view が返ること、の 3 点。

選択肢:
- a) ★ `chunkedResponse([])` + `into` で 1 本追加し、network / ヒットの両方で長さ 0 の
  prefix view が返り、空エントリが成立することを縛る。
- b) network 側だけ縛る。
- c) 見送り（0 バイトのモデル shard は現実に存在しない）。

リスク: c) は現実的だが、`loaded === 0` は `into.subarray(0, 0)` と
`storableResponse(空 view)` の 2 か所で分岐なしに素通りする値であり、将来
「`loaded === 0` なら早期 return」のような最適化が入ったときに戻り値が器を指さなくなる。

対象: `src/core.ts:433-434` / `:464-474`（storableResponse）。

影響範囲: テストのみ。

引き継ぎ（テスト仕様）:
- ファイル: `src/mod.test.ts` into 節。
- 呼び出し 1（network）: mock が `chunkedResponse([])` を返す →
  `fetchBytes(URL_A, { fetch, into })`。器は `new Uint8Array(new ArrayBuffer(8)).fill(0xff)`。
- 観測値: `assertPrefixView(bytes, into, 0)`（buffer 同一・byteOffset 0・byteLength 0）/
  `assertEquals(into[0], 0xff, "空 body なのに器を書き換えている")` /
  `assertEquals(await listCachedUrls(), [URL_A])`（空エントリが成立）。
- 呼び出し 2（ヒット）: 同じ URL を `into` 付きで再取得 →
  `assertPrefixView(bytes2, into, 0)` / `assertEquals(calls.length, 1)`。
- フォルト注入で赤になる行: `core.ts:434` の前に `if (loaded === 0) return new Uint8Array(0);`
  を足すと `assertPrefixView` の buffer 同一性が赤。

---

### G3-06 🟠 warning — 「ヒットは `arrayBuffer()` ではなく stream で器へ流す」が観測されていない

**質問: ADR 0009 の主目的（ヒット側 RAM ピークの削減）を、実装差し替えで赤になる形で凍結しますか。**

概要: ADR 0009 §1 と README は「キャッシュヒットは `arrayBuffer()` ではなく body stream を
`into` へ流す」と明言し、これがヒット側の RAM 効果の全てである。しかし #2 は
`into.set(new Uint8Array(await cached.arrayBuffer()))` という**目的を完全に潰した実装でも緑**に
なる（戻り値は同じ prefix view）。ADR は「効果の大きさはランタイム依存」と断っているが、
**「materialize してから写す」実装への退行**は仕様レベルの逆行であって、ランタイム依存では
片付かない。

観測方法はある。`opts.caches` を DI して `match` が返す Response を、pull 駆動
（`highWaterMark: 0`）の 2 チャンク stream で組む。stream 実装は 2 回目の `pull` の時点で
`into[0]` を覗く。stream で流していれば 1 チャンク目は既に器へ書かれている（`readBody` は
`read()` → `buffer.set` → 次の `read()` の順）。`arrayBuffer()` で materialize していれば、
全チャンクを読み切るまで器は 1 バイトも書かれない。既存の `lazyResponse`（mod.test.ts:1565）
とほぼ同じ道具立てで書ける。

選択肢:
- a) ★ 上記の pull フックで「1 チャンク目が器へ書かれた後に 2 チャンク目が引かれる」ことを縛る。
- b) 目的（RAM）は測定でしか確認できないとして、テストは書かず ADR の Consequences に留める。
- c) `Cache` の `match` 呼び出し回数と `arrayBuffer` 未呼び出しを spy で縛る（実装詳細に密着しすぎ）。

リスク: b) を採ると、ADR 0009 のヒット側の価値が**テストで一切守られない**状態が残る
（network 側は `expectedBytes` 由来の既存テスト群があるのと対照的）。a) は実装詳細ではなく
「書き込みと読み出しのインターリーブ」という振る舞いを見るので、実装の自由度は保たれる。

対象: `src/core.ts:617-627`（ヒット側の三項）/ `:404-432`（readBody の逐次ループ）。

影響範囲: テストのみ。DI 用の `CacheStorage` ラッパは既存の `failingCacheStorage`
（mod.test.ts:39-67）を雛形にできる。

引き継ぎ（テスト仕様）:
- ファイル: `src/mod.test.ts` into 節。
- 道具: `failingCacheStorage({ match: … })` の `overrides` で `match` を差し替え、
  pull 駆動の 2 チャンク stream（`[1,2,3]` / `[4,5]`、`highWaterMark: 0`）を body に持つ
  Response を返す。`pull` の中で `pulled` をカウントし、`pulled === 1`（= 2 チャンク目を
  引く直前）の時点の `into[0]` を記録する。
- 呼び出し: `fetchBytes(URL_A, { fetch, into, caches: storage })`。器は `.fill(0xff)`。
- 観測値: 記録した `into[0]` が `1`（= 1 チャンク目が既に書かれている）。
  `assertEquals(observedFirstByteAtSecondPull, 1, "ヒット body を materialize してから写している")`。
  併せて `assertPrefixView(bytes, into, 5)`。
- フォルト注入で赤になる行: `core.ts:619-627` の三項を `new Uint8Array(await cached.arrayBuffer())`
  固定 + `into.set(...)` に書き換えると、2 回目の pull 時点で `into[0]` が `0xff` のままになり赤。
- 注意: `match` の override は `Cache` 型の部分実装なので、既存 `failingCacheStorage` と同じく
  `overrides: Partial<Cache>` 経由で渡す（`as any` は不要）。

---

### G3-07 🟡 note — 記録あり一致ヒット（`trusted` 経路）+ `into` の凍結が HF テスト経由の間接のみ

**質問: `trusted`（記録ハッシュ一致で再ハッシュを省く）分岐 + `into` を cache 層のテストで直接凍結しますか。**

概要: `core.ts:648-649` の `trusted` は「記録 === 期待 && recheck !== true」。この分岐を
`into` と組み合わせて通るのは HF の #12（hf/mod.test.ts:814）だけで、しかも #12 は
`trusted` を狙った assertion（再ハッシュしていないこと）を持たない。cache 層のテストには
`into` + 記録一致ヒットが 1 本も無い。#4 が縛っているのは `recorded === null`（記録なし）側。

選択肢: a) ★ #4 に「記録あり一致ヒット」ケースを追記（#4 は既に URL_A へ記録付きエントリを
作っているので、そのまま `into` 付きで 3 回目を打てば良い）/ b) 独立した 1 本 / c) 見送り。

リスク: 低。機序（`checkAndDecode(cachedBytes, opts, trusted)`）は共有されており、`into` 固有の
分岐はない。

対象: `src/core.ts:643-650` / `src/mod.test.ts:1685-1722`（#4）。

影響範囲: テストのみ。

引き継ぎ（テスト仕様）: #4 の URL_A ブロック末尾に、`into` を `.fill(0)` してから
`fetchBytes(URL_A, { fetch, into, sha256: BYTES_A_SHA256 })` を追加。観測値は
`assertPrefixView(…, into, 5)` / `assertEquals(calls.length, 2)`（network に出ていない）。
再ハッシュしていないことは、器を `.fill(0)` した上で **意図的に壊れた記録を使わない**構成では
直接観測できないため、`recheck: true` 版（G3-13）と対にして「recheck 有りだけ実ハッシュが走る」
形で縛るのが素直。

---

### G3-08 🟡 note — leader が `into` 無し × 合流者が `into` 有り（成功系）が未凍結

**質問: single-flight の 4 象限のうち残り 1 つを凍結しますか。**

概要: #9 は leader に `into` がある構成、#10 は leader に `into` 無し × 合流者の器が小さい
（失敗）構成。**leader `into` 無し × 合流者 `into` 有り × 容量十分**（成功）が抜けている。
この構成では共有 raw が leader 自身のバッファ（`raw.slice()` されない — `core.ts:896` の条件
`opts.into !== undefined` が false）で、合流者は `opts.into.set(raw)` で写す。合流者側の
`into` 分岐（`core.ts:842-853`）は #9 の `withInto` で通っているので、真に未検証なのは
「leader 側でコピーが**切られない**こと（不要なコピーをしない）」の方。

選択肢: a) ★ #10 に成功する合流者（十分な器）をもう 1 つ足す（同じゲート・同じ mock で済む）
/ b) 独立した 1 本 / c) 見送り。

リスク: 低。ただし a) を採ると `raw.slice()` の条件が「into 有りの leader のときだけ」で
あることが、合流者側から間接的に固定される。

対象: `src/core.ts:895-897` / `src/mod.test.ts:1841-1863`（#10）。

影響範囲: テストのみ。

引き継ぎ（テスト仕様）: #10 のゲート内に
`const ok = fetchBytes(URL_A, { fetch, into: new Uint8Array(new ArrayBuffer(8)) })` を追加。
観測値: `assertPrefixView(await ok, okInto, 5)` / `assertEquals(calls.length, 1)` /
leader の戻り値 `a` が `okInto.buffer` を指していないこと
（`assertNotStrictEquals((await leader).buffer, okInto.buffer)`）。
フォルト注入: `core.ts:851`（`opts.into.set(raw)`）を消すと `assertPrefixView` が赤。

---

### G3-09 🟡 note — `into` + `decode` のキャッシュヒット側が未凍結

**質問: 「器に保存形 raw・戻り値は decode 後」がヒット経路でも成り立つことを凍結しますか。**

概要: #5 は network 経路のみ。ヒット経路では `cachedBytes`（器の prefix view）が
`checkAndDecode` に渡り、`decode` の戻り値が別バッファで返る（`core.ts:650`）。
機序は共有だが、「ヒットでも器に入るのは gzip のまま」は limitations.md に書かれた契約。

選択肢: a) ★ #5 に 2 回目（ヒット）を足す / b) 独立した 1 本 / c) 見送り。

リスク: 低。

対象: `src/core.ts:643-665` / `src/mod.test.ts:1724-1740`（#5）。

影響範囲: テストのみ。

引き継ぎ（テスト仕様）: #5 の末尾で `into.fill(0)` してから同じ呼び出しを再実行。観測値:
`assertEquals(decoded2, original)` / `assertEquals(into.subarray(0, compressed.length), compressed)` /
`assertEquals(calls.length, 1)`。フォルト注入: `core.ts:650` の第 1 引数を decode 済みに
すり替えると `into` の中身が赤。

---

### G3-10 🟡 note — `into` があるとき `expectedBytes` が確保に使われない（申告超過でも蓄積経路へ落ちない）が未凍結

**質問: `readBody` の分岐順序（`into` が `expectedBytes` に優先する）を凍結しますか。**

概要: `core.ts:366-386` は `into` → `expectedBytes` → content-length の順で `buffer` を決める。
`into` があると `expectedBytes` の値は**確保に一切使われない**（入口の容量ガードにだけ使われる）。
したがって `expectedBytes: 2, into: 8B, 実受信 5B` は成功し、prefix view が返る。もし将来
「into があっても expectedBytes を尊重して `into.subarray(0, expectedBytes)` を使う」ような
変更が入ると、申告が外れた瞬間に `IntoCapacityError` が誤発火する（申告は検証に使わないという
`expectedBytes` の doc 契約に反する）。この組み合わせは未検証。

選択肢: a) ★ 1 本追加（`expectedBytes` 過少申告 + 十分な `into` が成功する）/ b) 見送り。

リスク: 低〜中。`expectedBytes` は HF 層が `spec.expectedBytes` を素通しするため、
`into` と同時指定される可能性は実運用で高い（README のサンプルが両方渡している）。

対象: `src/core.ts:366-386` / `src/mod.test.ts` into 節。

影響範囲: テストのみ。

引き継ぎ（テスト仕様）: mock は `chunkedResponse([[1,2,3],[4,5]])`。
`fetchBytes(URL_A, { fetch, into: new Uint8Array(new ArrayBuffer(8)), expectedBytes: 2 })` →
`assertPrefixView(bytes, into, 5)` / `assertEquals(bytes, BYTES_A)`。
フォルト注入: `core.ts:367-368` を `buffer = into.subarray(0, expectedBytes ?? into.length)` に
変えると `IntoCapacityError` で赤。

---

### G3-11 🟡 note — `prefetchHfFile` が `into` を見ない（器が無傷）ことが未凍結

**質問: 型としては書けてしまう `prefetchHfFile(ref, { path, into })` が器を触らないことを凍結しますか。**

概要: `HfFileSpec.into` は `fetchHfFile` / `fetchHfFiles` 用だが、`prefetchHfFile` も同じ
`HfFileSpec` を受けるため型検査は通る。実装は `prefetchUrlWithKey` へ `sha256` /
`onProgress` / `init` / `fetch` / `caches` しか渡さないので `into` は無視される
（ADR 0009 §1・hf/mod.ts の doc に明記）。`expectedBytes` / `validate` が無視されることは
limitations.md に書かれているが、テストでは未凍結（`into` も同様）。誤って
`into: spec.into` を prefetch 側にも足すと、器に何が書かれるか未定義のまま緑になる。

選択肢: a) ★ 1 本追加（番兵で満たした器が prefetch 後も無傷）/ b) 見送り（doc のみ）。

リスク: 低。ただし assertion 1 行で永久に固定できる。

対象: `src/hf/mod.ts` の `prefetchHfFile`（`prefetchUrlWithKey` 呼び出し）/ `src/hf/mod.test.ts` の prefetch 節。

影響範囲: テストのみ。

引き継ぎ（テスト仕様）: `src/hf/mod.test.ts` の `prefetchHfFile` 節に追記。
`const into = new Uint8Array(new ArrayBuffer(16)).fill(0xff)` を spec に載せて
`prefetchHfFile({ repo: REPO, revision: SHA }, { path: "model.onnx", sha256: BYTES_SHA256, into })`
→ `assertEquals(into, new Uint8Array(new ArrayBuffer(16)).fill(0xff), "prefetch が器を書き換えている")` /
`assertEquals(result.fetched, true)`。`finally { await caches.delete(CACHE_NAME) }`。
フォルト注入: prefetch 側に `into` の受け渡しを足すと器が書き換わり赤。

---

### G3-12 🟡 note — `fetchHfFiles` の並列実行と器の関係が未凍結

**質問: `fetchHfFiles` に spec 毎の別バッファを渡した場合に混線しないことを凍結しますか。**

概要: `fetchHfFiles` は `Promise.all` で完全並列（hf/mod.ts）。limitations.md は
「同じバッファを複数 spec に渡すと戻り値同士が上書きし合う（逐次の `fetchHfFile` で使う）」と
by-design を宣言した。宣言した以上、**その裏返し（spec 毎に別バッファなら並列でも正しい）**は
凍結しておく価値がある。現状どちらも未検証。

選択肢: a) ★ 別バッファ 2 本で `fetchHfFiles` を呼び、各戻り値が自分の器の prefix view で
内容も正しいことを縛る / b) 「同じバッファを渡すと壊れる」という by-design 側も縛る
（壊れ方は非決定なので不適 — 推奨しない）/ c) 見送り。

リスク: 低。b) は非決定な結果を assert することになるので採らない。

対象: `src/hf/mod.ts` の `fetchHfFiles` / `src/hf/mod.test.ts` の fetchHfFiles 節。

影響範囲: テストのみ。

引き継ぎ（テスト仕様）: 既存の `fetchHfFiles` テスト（`BYTES` / `BYTES_2` を 2 ファイルで
返す mock がある）を雛形に、各 spec へ別々の 16B バッファを渡す。観測値:
各戻り値の `.buffer` がそれぞれの器と `assertStrictEquals`、内容が `BYTES` / `BYTES_2`、
`calls.length` が既存テストと同じ。フォルト注入: `hf/mod.ts:241` を全 spec 共通の器へ
差し替えると内容比較が赤。

---

### G3-13 🟡 note — `into` + `recheck: true` のヒット再ハッシュが未凍結

**質問: `recheck` と `into` の組み合わせを凍結しますか。**

概要: `recheck: true` は記録一致でも実ハッシュを再計算する（`core.ts:648-649` の
`opts.recheck !== true`）。`into` 付きだと再ハッシュ対象が器の prefix view になる。
#4 の記録なしヒットが同じ計算経路（`trusted === false`）を通るため機序は既に凍結されているが、
`recheck` フラグ自体との組み合わせは未検証。G3-07 と対にすると「recheck 有りだけ再ハッシュ」
が観測できる。

選択肢: a) ★ G3-07 と同じテストで recheck 有無を並べる / b) 見送り。

リスク: 低。

対象: `src/core.ts:648-649`。

影響範囲: テストのみ。

引き継ぎ（テスト仕様）: 記録付きエントリを置き、**実バイトを記録と食い違わせる**
（`cache.put(URL_A, new Response(BYTES_B, { headers: { [SHA_HEADER]: BYTES_A_SHA256 } }))`）。
`recheck` 無し + `into` → 記録を信じて `BYTES_B` の prefix view が返る（`calls.length === 0`）。
`recheck: true` + `into` → 実ハッシュ不一致で self-heal → network で `BYTES_A` を器へ
（`calls.length === 1` / `assertPrefixView(…, into, 5)`）。
フォルト注入: `core.ts:649` の `opts.recheck !== true` を落とすと recheck 版が
`calls.length === 0` になり赤。

---

### G3-14 🔵 low / needs-human — `sha256HexNative` の SharedArrayBuffer 分岐は公開 API から到達不能

**質問: `hasArrayBufferBacking` の false 側をどう扱いますか。**

概要: ADR 0009 §4 の変更で、コピー条件が「tight view でなければ」から「SharedArrayBuffer 背面
のときだけ」へ緩んだ。true 側（部分ビューをそのまま digest）は #4 が器 64B / 実長 5B で強く
縛っている。false 側（`new Uint8Array(bytes)` でコピー）は、`sha256HexNative` に渡るのが
必ず `readBody` / `cached.arrayBuffer()` 由来の ArrayBuffer 背面配列なので、**公開 API からは
到達できない**。`into` に SAB 背面の配列を渡せば到達するが、型（`Uint8Array<ArrayBuffer>`）に
反する呼び出しであり、テストで作るには型違反のキャストが要る（プロジェクト規約は `as any` を
禁じている）。

選択肢:
- a) 到達不能な防御コードとして現状維持（テストを書かない）。★ 判断はオーナーへ。
- b) `hasArrayBufferBacking` を内部 export してユニットテストする（内部 API の露出が増える）。
- c) 防御コード自体を削り、SAB 背面は fail loud にする（実装変更 — G3 の担当外）。

リスク: a) はカバレッジ上の穴が残るだけで実害は無い。c) は ADR 0009 §4 の判断を覆すので
本レビューの範囲外。**確証が無いため needs-human**（「到達不能」は現在の全呼び出し元を
読んだ結論であって、将来 `decode` 結果を再ハッシュするような変更が入れば到達しうる）。

対象: `src/core.ts:480-495`。

影響範囲: なし（現状維持なら）。

引き継ぎ: b) を採る場合は `src/sha256.ts` と同じ「内部モジュールのユニットテスト」の
体裁に揃える（`deno.json` の exports には載せない）。

---

### G3-15 🔵 low — `cache:false + into` テストに「cache を触っていない」assertion と `finally` が無い

概要: #11（mod.test.ts:1865-1873）は `try/finally` を持たず、キャッシュ非接触の assertion も
無い。既存の `cache:false（素の fetch 経路）でも async decode`（mod.test.ts:864）と同じ流儀
なので**規約違反ではない**が、より強い既存テスト
（`cache:false は Cache API を触らず毎回 fetch する`、mod.test.ts:131）は
`cache.match(URL_A) === undefined` を確認した上で `finally` を持つ。固定名前空間を全テストで
共有する構成では、`cache:false` 経路が誤って put するようになった場合、#11 は緑のまま
**後続テストへエントリを漏らす**（テスト間の順序依存を生む）。

選択肢: a) ★ mod.test.ts:131 と同じ形（`cache.match` 確認 + `finally`）に揃える /
b) 現状維持（既存の軽量な cache:false テストと同じ流儀）。

対象: `src/mod.test.ts:1865-1873`。影響範囲: テストのみ。

引き継ぎ: `try { … const cache = await caches.open(CACHE_NAME); assertEquals(await cache.match(URL_A), undefined); } finally { await caches.delete(CACHE_NAME); }` を追加。

---

### G3-16 🔵 low — HF の #12 が `byteOffset` / `byteLength` を見ていない

概要: hf/mod.test.ts:814 は `assertStrictEquals(x.buffer, into.buffer)` + 内容比較で、
mod.test.ts の `assertPrefixView`（buffer + byteOffset 0 + byteLength）に相当する検査を
していない。`into.subarray(4, 8)` のようなオフセット付き view を返す実装でも、内容が
たまたま一致すれば通る余地がある（現実的には内容比較で落ちるが、テスト名が
「prefix view を返す」と言っている以上、offset は明示的に見るべき）。

選択肢: a) ★ `assertPrefixView` 相当を hf/mod.test.ts にもローカル定義して使う /
b) 共有ヘルパを `src/testing/` へ移す（publish 対象外なので可能だが、テスト専用ヘルパの
公開面が増える）/ c) 現状維持。

対象: `src/hf/mod.test.ts:824-826, 831-833`。影響範囲: テストのみ。

引き継ぎ: mod.test.ts:1623-1631 の `assertPrefixView` を hf/mod.test.ts にコピーして
`fromNetwork` / `fromCache` に適用する（`src/testing/` への共有化は b) を選んだ場合のみ）。

---

### G3-17 🔵 low — `assertEquals(x === y, false)` は `assertNotStrictEquals` にできる

概要: mod.test.ts:1826-1830 は
`assertEquals(b.buffer === leaderInto.buffer, false, "合流者が leader の器を指している")`。
`@std/assert` の `assertNotStrictEquals` を使えば失敗時に両辺が出る（現状は
`false !== true` としか出ない）。動作は同じなので純粋な可読性・診断性の提案。

選択肢: a) ★ `assertNotStrictEquals` に置換（import 追加 1 行）/ b) 現状維持。

対象: `src/mod.test.ts:1826-1830`。影響範囲: テストのみ。

---

### G3-18 🔵 low — `into` + `decode` テストが「戻り値は別バッファ」を assert していない

概要: ADR 0009 §1 は「`decode` 併用時は…戻り値は decode 結果（**別バッファ**）」と書いている。
#5（mod.test.ts:1724）は器の中身が raw であることは見ているが、戻り値が器を指していない
ことを見ていない。`decodeGzip` の実装上そうなるだけで、契約としては未凍結。

選択肢: a) ★ `assertNotStrictEquals(decoded.buffer, into.buffer)` を 1 行足す / b) 現状維持。

対象: `src/mod.test.ts:1732-1737`。影響範囲: テストのみ。

---

### G3-19 🔵 low — 入口 throw のメッセージに申告値（`expectedBytes N バイト`）が含まれることを見ていない

概要: #8（mod.test.ts:1791）は `"into の容量 4 バイト"` だけを照合している。
`IntoCapacityError` の `needed` 引数は経路ごとに違う文言
（`expectedBytes 5 バイト` / `受信 N バイト以上` / `保存形 N バイト`）で診断性を担っており、
入口 throw であることは `calls.length === 0` で担保されているものの、**どの申告値が問題か**が
メッセージに残ることは未凍結。同様に #6 は `"受信 5 バイト以上"`、#10 は `"保存形 5 バイト"` を
見ていない。

選択肢: a) ★ 各テストに `assertStringIncludes(error.message, …)` を 1 行ずつ足す
（既存の `expectedBytes` 確保失敗テスト（mod.test.ts:1590）が同じ流儀で申告値・"ArrayBuffer"・
URL の 3 点を見ており、揃う）/ b) 現状維持。

対象: `src/mod.test.ts:1793-1803`（#8）/ `:1748-1756`（#6）/ `:1855`（#10）。影響範囲: テストのみ。

---

### G3-20 🔵 low — 番兵バイトの assertion にメッセージが付いている箇所と付いていない箇所がある

概要: #1 は `assertEquals(into[BYTES_A.length], 0xff, "実長の外へ書いている")` とメッセージ付き、
#2（mod.test.ts:1660）は同じ検査でメッセージ無し。失敗時に「0xff が 0 になっている」だけが
出て意図が読めない。純粋な一貫性の提案。

選択肢: a) ★ #2 にも同じメッセージを付ける / b) 現状維持。

対象: `src/mod.test.ts:1660`。影響範囲: テストのみ。

---

## 横断所見

1. **既存テストの弱体化・書き換えはゼロ**（確認方法: `git show 3b13d16 --numstat` の
   `253 0 src/mod.test.ts` / `31 0 src/hf/mod.test.ts`、および
   `git show 3b13d16 -- src/mod.test.ts src/hf/mod.test.ts | grep -c '^-[^-]'` = 0）。
   `assertStrictEquals` の import 追加のみが既存行への変更。CLAUDE.md の
   「既存の assertion を通すためにテストを書き換えない」規約は守られている。

2. **今回の網羅の偏りには一貫した形がある**: 追加 11 本のうち 9 本が **network 経路**か
   **入口ガード**で、キャッシュ**ヒット経路**は #2（成功）と #7（容量不足）の 2 本だけ。
   しかし ADR 0009 が新設した分岐は、ヒット側（`arrayBuffer()` → `readBody` への切り替え、
   `IntoCapacityError` の素通し、self-heal 2 種へのフォールスルー、onProgress 非発火）に
   集中している。🟠 6 件のうち 4 件（G3-02/03/04/06）がヒット経路に集まったのはこのため。
   **オーケストレータへの提案: 追加するならヒット経路から**。

3. **テストの道具立ては十分揃っている**。`lazyResponse`（pull 駆動 + cancel 観測、
   mod.test.ts:1565）と `failingCacheStorage`（`Partial<Cache>` の override、mod.test.ts:39）が
   あるので、G3-01（null body）以外は新しいヘルパ無しで書ける。G3-01 だけ
   `Object.defineProperty(response, "body", { value: null })` という新しい手が要る
   （`new Response(null)` では**空**になってしまうため、中身のある bodyless 応答が作れない）。

4. **並行テストの決定性は構造的に保証されている**。`fetchBytesWithKey` は
   `inflight.set`（core.ts:882）まで await を挟まない設計で、コメントにも MUST として
   書かれている。#9 / #10 はこの性質に乗っており、待ちループもタイムアウトも不要。
   `deno test --parallel` 禁止（固定名前空間の共有）にも抵触しない。

5. **前回 ROADMAP との関係**: 見送り済みのテストギャップ（TS-006/007/009・TS-010〜014 =
   crypto.subtle 不在 / `keys()` 未実装ランタイム / 転送中断など）は本差分と無関係で、
   状況は変わっていない。ただし ROADMAP の
   「readBody body===null 経路の buffer 解放（2N ピーク・0007 由来の既存挙動）」と
   G3-01 は**同じ 9 行**を指しており、この経路は「既存の未解決事項 + 今回の未検証コード」が
   重なった状態になった。0.6.0 で触るなら一緒に片付けるのが効率的。

6. **`storableResponse` が呼び出し側の器を指す view を stream に enqueue する**点は、
   テストレンズからは危険に見える（`controller.enqueue(bytes)` は複製しない）。読み合わせた
   限り `await cache.put(...)` が同期的に完了してから呼び出し側へ制御が戻るため現状は安全で、
   #1 の「再読出しが 5 バイト」assertion がこれを間接的に守っている。ただし将来
   `cache.put` を await しない（fire-and-forget）変更が入ると**器の再利用と put が競合する**。
   本差分のバグではないため指摘には起こさないが、G1/G2（実装レンズ）が同じ箇所を見ていない
   場合はオーケストレータから回すことを勧める。
