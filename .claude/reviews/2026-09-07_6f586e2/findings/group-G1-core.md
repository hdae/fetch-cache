---
id: G1
topic: cache 層の区間読み実装（`src/core.ts` の `openCachedUrl` / `openCachedUrlWithKey` / `readFromBlob` / `readFromStream` と既存 core への接続）
commit: 6f586e2
files_reviewed:
  - src/core.ts（差分: 348-358 / 1362-1688。既存側は 690-800 の fetchBytes ヒット経路・258-336 の
    キー直列化と URL 正規化・555-610 の記録ハッシュ / SHA256_HEX・1725-1855 の evictUrl /
    clearCache / listCachedUrls を突合のみ）
  - src/mod.test.ts（3179-3516 の openCachedUrl テスト群 — カバレッジ判定のため読了・担当外）
  - src/mod.ts（再公開面 45 / 50 / 56 のみ・担当外）
  - src/hf/mod.ts（openCachedUrlWithKey の唯一の実利用点 544-550 のみ・担当外）
  - docs/decisions/0012-open-cached-range-read.md
  - docs/decisions/0001-cache-io-degrade-with-notification.md（§縮退と通知）
  - docs/decisions/0008-remove-public-key-and-backfill-record.md（§1 内部導管 / §2 backfill）
  - docs/limitations.md（152-171 の区間読み 3 項目）
date: 2026-09-07
model: opus (effort high)
---

# G1 — cache 層の区間読み実装

## サマリ

**区間の算術は全経路で正しい**。`readFromStream` の「読み飛ばし → 充足 → 末尾判定」の 3 状態は、
`skipped <= offset` / `filled <= length` が単調増加で必ず飽和することから、`done` に到達した時点で
`skipped + filled` が本文長そのものになることを証明できた（後述「証明 1」）。`(0,0)` / `(size,0)` /
`(size+1,0)` / `(0,size)` / `(size-1,1)` / チャンクをまたぐ読み / 1 チャンク内に収まる読みの 7 組を
手で追い、**"blob" と "stream" が同じ `size` を報告し、同じ文言で落ちる**ことも確認した。資源所有も
健全で、`reader.cancel()` は正常 / throw / abort の 3 経路すべてで `finally` を通る（証明 2）。
Deno 2.9.6 で Cache API を実測し（`caches` 名前空間 `probe-G1-*`・実行後に削除）、①読み戻しの
チャンクは 64 KiB 固定 ②0 バイト本文でも `response.body` は `null` にならない ③`caches.delete(name)`
後は保持中の `Cache` オブジェクトからも `match` が `undefined` を返す ④`new Uint8Array(2^53-1)` は
`RangeError` — の 4 点を裏取りした。

欠陥は**「開いた後」の同一性**に集中する。最大のものは、"stream" 戦略の `read` が毎回 `match` し直す
のに**記録ハッシュを再確認しない**点（G1-01）。`sha256` を渡して開いたハンドルが、並行する
`fetchBytes(sha256: 別値)` の self-heal + 再取得でエントリが**差し替わった**後、別内容のバイト列を
黙って返す。ADR 0012 の Consequences は「消えれば次の `read` が throw」までしか書いておらず、
「差し替わった」場合が抜けている。次に、"blob" 戦略の `open` で `blob()` が**確保失敗**しても
`onCacheError` + `undefined` へ縮退する（G1-02）。同じファイルの `readFromStream` は確保失敗を
範囲外へ読み替えて **throw** し、`fetchBytes` は `IntoCapacityError` を「申告ミスであって cache I/O の
失敗ではない」として縮退させない（`core.ts:751`）。同一原因が経路によって throw / 縮退に割れる。

テストは 12 本あり、いずれも実装行を狙って赤にできる（tautological なものは無い）。乱数 256 KiB の
エントリは Deno で 4 チャンクに割れるので、「チャンクをまたぐ読み飛ばし」を実際に通しているという
テストの前提も実測で成立している。未凍結は 3 か所（G1-04 / G1-05 / G1-06）で、いずれも
`length === 0` と `body === null` という**空の端**、および**並行**に偏る。

| 重大度      | 件数 |
| ----------- | ---- |
| 🔴 Critical | 0    |
| 🟠 Error    | 1    |
| 🟡 Warning  | 6    |
| 🔵 Low      | 7    |

---

## ファイル別分類

| ファイル                                     | 判定       | 根拠                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core.ts`（差分 348-358 / 1362-1688）    | 🟡 Warning | 区間算術・資源解放・入口検査は正しい（証明 1〜3）。欠陥は「開いた後」の同一性と失敗の割れ方に限る: ①"stream" の再 `match` で記録ハッシュを再確認しない（G1-01・`core.ts:1508-1513`） ②"blob" の `open` で確保失敗が miss へ縮退する（G1-02・`core.ts:1660-1667`） ③`blob()` 失敗を `op: "match"` で通知する（G1-03・`core.ts:1665`） ④`body === null` 分岐・`length === 0` 境界・並行 `read` が未凍結（G1-04 / G1-05 / G1-06） ⑤`clearCache` 後の `read` がブラウザでは throw しない可能性（G1-07・`core.ts:1578-1580`）。 |
| `src/core.ts`（既存側・突合のみ）            | 🟢 Safe    | `normalizeUrl` / `serializeKey` / `SHA_HEADER` / `SHA256_HEX` / `DEFAULT_CACHE_NAME` / `globalCaches` は差分ゼロで、`openCachedUrlWithKey:1598-1599` は `fetchBytesWithKey:1001/1023` と同じ順（正規化 → 直列化 → 形式検査 → cache）を守る。予約 origin ガードも `normalizeUrl:324-328` を共有するので `fetchBytes` と同挙動。self-heal の evict と `op: "delete"` 通知は `core.ts:755-761` と同型。                                                                                                            |
| `src/mod.test.ts`（3179-3516・担当外の参考） | 🟡 Warning | 12 本すべてに「赤にできる実装行」が実在（後述「テスト ↔ 実装行の対応」）。256 KiB × 乱数という素材の選択も実測（64 KiB × 4 チャンク）に照らして妥当。未凍結は G1-04 / G1-05 / G1-06 の 3 点。                                                                                                                                                                                                                                                                                                            |
| `src/mod.ts`（担当外の参考）                 | 🟢 Safe    | 追加は値 1 個（`openCachedUrl`）と型 2 個（`CachedEntry` / `OpenCachedOptions`）の再公開のみ。`openCachedUrlWithKey` は載っておらず、ADR 0008 §1 の「内部導管は `exports` 外」を維持している。                                                                                                                                                                                                                                                                                                                       |

---

## 重要な経路の図（実コード行番号付き）

### `openCachedUrlWithKey` の 7 つの return（`src/core.ts:1593-1688`）

```
openCachedUrlWithKey(url, key, opts)
  │
  ├─ 1598 normalizeUrl(url) ──────────── throw（解釈不能 / 予約 origin）※ fetchBytes と同一
  ├─ 1599 serializeKey(key) ──────────── throw（オブジェクト / 非有限数値の要素）
  ├─ 1604 SHA256_HEX 検査 ────────────── throw（形式不正 sha256）
  ├─ 1611 read の値検査 ──────────────── throw（"blob" / "stream" 以外）※ cache に触る前
  │
  ├─ 1623 cacheStorage === undefined ─→ return undefined（エラーではない）
  ├─ 1626 cacheStorage.open  ─ catch ─→ onCacheError{op:"open"} → return undefined
  ├─ 1633 cache.match        ─ catch ─→ onCacheError{op:"match"} → return undefined
  ├─ 1638 cached === undefined ──────→ return undefined（純粋な miss）
  │
  ├─ 1641 sha256 指定 && recorded !== sha256
  │        1642 body.cancel()
  │        1643 recorded !== null → 1647 cache.delete（self-heal）
  │                                  ─ catch → onCacheError{op:"delete"}
  │        1655 ─────────────────────→ return undefined
  │
  ├─ 1659 strategy === "blob"
  │        1663 cached.blob() ─ catch ─→ onCacheError{op:"match"} → return undefined  ★G1-02 / G1-03
  │        1668 ─────────────────────→ return { strategy, read: readFromBlob(blob, …) }
  │
  └─ 1675 body.cancel()（stream は read 毎に開き直すので開く時の body は捨てる）
           1676 ─────────────────────→ return { strategy, read: readFromStream(cache, storageKey, …) }
                                                              ↑ storageKey だけを持ち回り、
                                                                opts.sha256 は渡らない ★G1-01
```

### `readFromStream` の 3 状態（`src/core.ts:1496-1556`）

```
1504 assertRange ─ throw（負 / 非整数）
1505 signal.throwIfAborted ─ throw（呼び出し前に abort 済み）
1508 cache.match ─→ undefined なら 1510 throw「開いた後にエントリが消えました」
                 ─ reject ならそのまま伝播（縮退しない）※ 未凍結 G1-06
1514 body === null ─→ 1517 offset+length > 0 なら outOfRange(size=0) / 1518 空配列  ※ 未凍結 G1-04
1524 new Uint8Array(length) ─ catch ─→ 1526 outOfRange(size=undefined) + cause 保持

1530 reader = body.getReader()
     ┌──────────────────────────────────────────────────────────────────┐
1534 │ while (skipped < offset || filled < length)                      │
1536 │   signal.throwIfAborted()   ← 中断の観測点はここだけ（read() が   │
     │                               pending の間の abort は届かない）  │
1537 │   { done, value } = await reader.read()                          │
1540 │   done → throw outOfRange(size = skipped + filled)  ※ 証明 1     │
1542 │   skipped < offset なら skip = min(offset-skipped, chunk.length)  │
1547 │   take = min(length - filled, chunk.length)                      │
     └──────────────────────────────────────────────────────────────────┘
1551 finally: await reader.cancel().catch(()=>{})   ← 正常 / throw / abort の 3 経路すべて ※ 証明 2
1555 return out（length ちょうど）
```

**証明 1（`done` 時の `size` が正確であること）**: `skip = Math.min(offset - skipped, chunk.length)`
より `skipped <= offset`、`take = Math.min(length - filled, chunk.length)` より `filled <= length` が
常に成り立つ。ループを正常脱出するのは `skipped >= offset && filled >= length`、すなわち
`skipped === offset && filled === length` のときだけ。したがって `done` に到達したなら
`filled < length` が確定し、`filled` が飽和して**捨てられたバイトは 1 つも無い**（`take` が
`chunk.length` を下回るのは `filled` が `length` に達する瞬間だけで、その回はループを抜ける）。
`skipped` 側も同様。よって `skipped + filled` は消費した全バイト = 本文長そのもの。
`(offset, length) = (8, 5)`・本文 10 バイトなら `8 + 2 = 10`、`(99, 1)`・本文 10 バイトなら
`10 + 0 = 10` で、どちらも "blob" 側の `blob.size` と一致する。

**証明 2（body の解放）**: `getReader()`（1530）の直後から `finally`（1551）までが `try` で囲まれて
いる。3 つの脱出経路 ①正常完了 ②`done` での `outOfRange` throw（1540） ③`throwIfAborted` の throw
（1536）はすべて `finally` を通る。`new Uint8Array(length)` の確保失敗（1524）は `getReader()` より
**前**なので reader は存在せず、`cached.body` は未消費のまま GC 対象になる（cancel されないが、
reader も立っていないので消費中のハンドルは無い）。開く時の body も "blob" なら `blob()` が、
"stream" なら 1675 の `cancel()` が、sha256 不一致なら 1642 の `cancel()` が引き受ける — **`cached` を
得てから返るまでのどの分岐でも body が宙に浮かない**。

**証明 3（入口検査が cache に触らないこと）**: 1604 / 1611 の throw は 1621 の `cacheStorage` 取得
より前にあり、`mod.test.ts` の `untouchableCaches`（`open` が呼ばれたら記録して reject）で凍結
されている。`normalizeUrl` / `serializeKey` の throw も同様に前段。

---

## 詳細指摘

### G1-01 🟠 Error — "stream" 戦略の `read` は再 `match` 時に記録ハッシュを再確認せず、差し替わったエントリを黙って返す

**質問**: `openCachedUrl(url, { sha256 })` で開いたハンドルが、並行してエントリが**別内容へ
差し替わった**あとも読み続けられる現状を、「差し替わりも throw」へ寄せますか。それとも
「"stream" のハンドルに sha256 の保証は付かない」と ADR / JSDoc へ明記して現状を仕様にしますか。

**概要**:
`openCachedUrlWithKey` は開く時に `recorded === opts.sha256` を確認してからハンドルを返す
（`core.ts:1640-1656`）。しかし "stream" 戦略が持ち回るのは `cache` と `storageKey` だけで
（`core.ts:1678-1687`）、`readFromStream` は `read` の度に `cache.match(storageKey)`
（`core.ts:1508`）してその応答の `headers` を**一切見ない**。エントリが消えていれば
`undefined` を検出して throw する（1509-1513）が、**別内容へ差し替わっている場合は素通り**する。

発生条件は 3 手:

1. `openCachedUrl(url, { sha256: A, read: "stream" })` → 記録 A と一致して open 成功。
2. 並行して `fetchBytes(url, { sha256: B })` が走る。記録 A ≠ 期待 B なので `core.ts:755-761` の
   self-heal で evict され、真実源から内容 B が取得されて**同じ storageKey へ** put される。
3. `entry.read(offset, length)` → `match` は内容 B のエントリを返し、**B のバイト列が返る**。

呼び出し側は「A を検証したハンドル」を持っているつもりで B の中身を受け取る。区間読みは実ハッシュを
計算できないので、下流はこの取り違えを**検出する手段を持たない**（区間の数 KB だけでは何も照合
できない）。ADR 0012 Consequences（`0012:123-126`）は「消えれば次の `read` が throw」までしか
書いておらず、`docs/limitations.md:168-171` も同じ。差し替わりのケースは**設計判断として存在しない**
（＝考慮漏れ）と読める。

**守っている目的**: 「`sha256` を渡して開けたなら、そのハンドルから読めるのは記録が `sha256` である
エントリのバイト列だけ」という、この API の唯一の検証契約。CLAUDE.md の fail loud（破損・不正データを
黙って握りつぶさない）に直接掛かる。

**選択肢**:
- a) ★ `readFromStream` に期待ハッシュを渡し、再 `match` のたびに 1 行で照合する。
  `openCachedUrlWithKey:1678` の呼び出しへ `opts.sha256` を足し、`readFromStream` の
  `core.ts:1513` の直後に

  ```ts
  if (expectedSha256 !== undefined && cached.headers.get(SHA_HEADER) !== expectedSha256) {
    await cached.body?.cancel().catch(() => {});
    throw new Error(
      `fetch-cache: 開いた後にエントリが差し替わりました（記録ハッシュが開いた時点と異なります） (${requestUrl})`,
    );
  }
  ```

  を置く。追加コストはヘッダ 1 参照で、`sha256` 無しの生読みは今までどおり。理由: ①「消えた」を
  throw にしているのと同じ理屈が「変わった」にもそのまま当てはまる ②検証契約を破る唯一の穴を
  1 行で塞げる ③"blob" 戦略は開いた時点の Blob を持つので**元から A のバイト列しか返さない** —
  a) を入れて初めて 2 戦略の意味論が揃う（現状は戦略によって「読めるもの」が違う）。
- b) `readFromStream` を変えず、ADR 0012 §4 / Consequences と `CachedEntry.read` の JSDoc
  （`core.ts:1367-1375`）に「"stream" は `read` ごとに現在のエントリを読むため、開いた時点の
  `sha256` は以後の `read` を保証しない」と明記する。実装は 1 行も動かないが、下流は
  「区間読みの結果を信じてよい条件」を自分で組み立てることになる。
- c) 現状維持（文書も変えない）。

**リスク**: a) は "stream" のみに 1 回のヘッダ参照を足すだけで、`sha256` を渡さない呼び出しには
影響しない。唯一の退行は「evict → 再 put で内容が同じでも記録が付き直したケース」だが、記録値が
同じなら照合は通るので実害は無い。b) は実装リスクゼロだが、下流（yomi / sbv2-web）が
「open で検証した」と読む余地を残す。

**対象**: `src/core.ts:1496-1513`（`readFromStream` の再 `match`）/ `src/core.ts:1676-1687`
（`readFromStream` への引数）/ `docs/decisions/0012-open-cached-range-read.md:123-126` /
`docs/limitations.md:168-171`。

**影響範囲**: `openCachedUrl` / `openHfFile` の "stream" 戦略のみ（= Deno 既定）。ブラウザ既定の
"blob" は影響なし。`fetchBytes` / `prefetchUrl` には及ばない。

**引き継ぎ**: テストは `mod.test.ts:3448-3465` の「開いた後に消えたエントリで throw する」テストの直後に
同型で足せる — `fetchBytes(URL_A, { fetch, sha256: BYTES_A_SHA256 })` で温めて
`openCachedUrl(URL_A, { sha256: BYTES_A_SHA256, read: "stream" })` を開き、続けて
`fetchBytes(URL_A, { fetch: mockFetch(() => new Response(BYTES_B)).fetch, sha256: BYTES_B_SHA256 })`
で差し替えてから `entry.read(0, 2)` を叩く。現状の実装では **`BYTES_B` の先頭 2 バイトが返って
テストが緑にならない**（`assertRejects` が「差し替わりました」を待つので赤で始まる = fault
injection として機能する）。a) を入れたあと `read: "blob"` で同じ手順を踏み、そちらは
`BYTES_A` が返り続けることも併せて凍結すると、戦略ごとの意味論の違いが記録される。

---

### G1-02 🟡 Warning — "blob" 戦略の `open` は確保失敗（`RangeError`）も miss へ縮退させる（同じ原因が `readFromStream` では throw）

**質問**: `cached.blob()` が**ヒープ確保失敗**で落ちたときに、現状の「`onCacheError` して
`undefined`（＝エントリ無し）」から、`readFromStream` の確保失敗（`core.ts:1523-1529`）や
`fetchBytes` の `IntoCapacityError`（`core.ts:751`）と同じ「そのまま throw」へ寄せますか。

**概要**:
`core.ts:1660-1667` は `cached.blob()` の失敗をひとまとめに `onCacheError({ op: "match" })` +
`return undefined` へ縮退させる。ADR 0012 §4（`0012:96-99`）が「開く時（`cacheStorage.open` /
`cache.match` / "blob" の `blob()`）の失敗は miss と同じ `undefined` へ縮退」と宣言しているので
**ADR には従っている**。問題は `blob()` の失敗理由が 2 種類あることで、ADR はそれを区別していない:

| 失敗の理由                      | 実体                            | 現状        | 同種の事象の他所での扱い                                     |
| ------------------------------- | ------------------------------- | ----------- | ------------------------------------------------------------ |
| Cache 実装の I/O エラー         | ストレージ破損・権限            | 縮退 + 通知 | 妥当（ADR 0001 と同型）                                      |
| 本文が大きすぎてヒープに載らない | `RangeError`（確保失敗）        | 縮退 + 通知 | `readFromStream:1526` は**範囲外として throw**、`fetchBytes:750` は `IntoCapacityError` を**縮退させず throw** |

Deno で `read: "blob"` を明示した場合、`blob()` は ADR 0012 の実測表（`0012:31`）どおり本文全量を
ヒープへ載せる。253 MB × 9 shard を扱う下流でこれが失敗すると、呼び出し側には「キャッシュに
無い」としか見えない。README（`README.md:295` 付近）の指示どおり `fetchBytes` へ落ちると、そちらは
同じ本文をさらに全量読もうとして**同じ理由で落ちる** — つまり縮退先が縮退になっていない。
`fetchBytes` が `IntoCapacityError` に付けた理由（「呼び出し側バッファの容量不足は申告ミスであって
cache I/O の失敗ではない（縮退させない）」`core.ts:750-751`）がそのまま当てはまる。

**守っている目的**: 縮退は「別の手段で回復できるとき」だけ行う、という ADR 0001 の建て付け。
回復できない失敗を miss に見せると、原因が診断不能になる（`console.warn` は出るが戻り値は miss と
区別が付かない）。

**選択肢**:
- a) ★ `RangeError` だけを素通しする。`core.ts:1664` の catch を
  `if (error instanceof RangeError) throw error;` で分岐させ、それ以外を現状どおり縮退させる。
  `fetchBytes` の `IntoCapacityError` 素通し（`core.ts:751`）と同じ形で、判定は 1 行。
- b) `readFromStream` に揃えて、確保失敗を専用の文言（「本文全量をヒープへ載せられません」）へ
  読み替えて throw する。診断は最も明確だが、"blob" の open にだけ新しいエラー種が増える。
- c) 現状維持。ADR 0012 §4 の宣言どおりであることを根拠に、`OpenCachedOptions.read` の JSDoc
  （`core.ts:1400-1412`）へ「Deno で "blob" を強制すると open が全量を確保するので、大きな
  エントリでは open が `undefined` になりうる」と一文足すだけに留める。

**リスク**: a) は `RangeError` を投げる Cache 実装が他にあれば（現実的には確保失敗のみ）その分だけ
throw が増える。破壊的ではない（今まで `undefined` だったものが例外になるので、`undefined` 判定で
分岐している下流には**挙動の変化として届く** — needs-human: 0.8.0 は追加のみのリリースなので、
「新 API 内の挙動変更」として許容されるかはオーナー判断）。c) は無コストだが非対称が残る。

**対象**: `src/core.ts:1660-1667` / `src/core.ts:1523-1529`（対比）/ `src/core.ts:750-751`（対比）/
`docs/decisions/0012-open-cached-range-read.md:96-99`。

**影響範囲**: `read: "blob"` を明示した Deno 実行、およびブラウザで極端に大きなエントリを開く場合。
ブラウザの遅延 Blob では確保が起きないので実質 Deno 限定。

**引き継ぎ**: テストは `mod.test.ts:3483-3505` の「blob() 失敗も match と同じく undefined へ縮退して
通知する」を素材にできる。`brokenResponse.blob` を `() => Promise.reject(new RangeError("Array
buffer allocation failed"))` に差し替えた 2 本目を足し、a) なら `assertRejects`、c) なら現状どおり
`undefined` を凍結する。既存テストの `new Error("blob failed")` 側は縮退のまま残すこと（2 種類の
失敗が割れることをテストが表現する）。

---

### G1-03 🟡 Warning — `blob()` の失敗を `op: "match"` として通知するので、診断で「`match` は成功したのに `match` 失敗」と読める

**質問**: `CacheErrorContext.op` に `"blob"`（または `"read"`）を足して `blob()` 失敗を区別しますか。
それとも `op` の 4 値を維持し、既存の `"match"` に丸め続けますか。

**概要**:
`CacheErrorContext.op` は `"open" | "match" | "put" | "delete"` の 4 値で、**Cache API の操作名**を
表す型として定義されている（`core.ts:30-34` の JSDoc「`op` は失敗した Cache API 操作」）。
`core.ts:1665` は `cached.blob()` の失敗を `op: "match"` で通知するが、`cache.match` 自体は
`core.ts:1633` で**成功している**。`onCacheError` でログを集めている下流から見ると、「`match` が
失敗した」という報告と「実際に `cache.match` が reject した」（`core.ts:1635`）が同じラベルに
なり、G1-02 の確保失敗と Cache 実装の I/O エラーも同じラベルに乗る。`blob()` は `Response` の
メソッドであって Cache API の操作ではないので、型の定義文そのものとも食い違う。

**守っている目的**: `onCacheError` は「どこで壊れたか」を呼び出し側へ渡すための唯一の口。ラベルが
実際の失敗点とずれると、この口の存在意義（診断）が削れる。

**選択肢**:
- a) ★ `op` に `"blob"` を足す（`core.ts:31`）。公開型の union を**広げる**のは値の追加なので、
  `onCacheError` を「受け取って読むだけ」の下流には非 breaking。理由: ①失敗点が 1:1 で分かる
  ②G1-02 をどちらに倒しても診断が正しくなる ③`op` は既に 4 値の実装詳細を露出しているので、
  5 値目を足すことに設計上の新しさは無い。
- b) 現状維持し、`OpenCachedOptions.onCacheError` の JSDoc（`core.ts:1414-1418`）に
  「"blob" 戦略の `blob()` 失敗も `op: "match"` として通知する」と明記して、少なくとも文書と
  実装を一致させる。
- c) `op` に `"blob"` を足しつつ、`CacheErrorContext` の JSDoc（`core.ts:30`）を「失敗した cache
  読み書きの局面」へ言い換える。

**リスク**: a) / c) は、`onCacheError` の中で `switch (context.op)` を網羅（`never` 検査つき）して
いる TypeScript 下流があれば**コンパイルエラーになる**（union の拡大は入力位置では安全でも、
網羅検査を書いた側では破壊的）。0.1.0 以降「公開 API の破壊的変更は不可」なので、**needs-human**:
下流（yomi / sbv2-web）が `op` を網羅 switch しているかを確認してから決める。確認方法は下流リポで
`rg 'onCacheError' -A 10`。網羅 switch が無ければ a) は安全。b) はゼロリスク。

**対象**: `src/core.ts:29-34`（`CacheErrorContext`）/ `src/core.ts:1665` / `src/core.ts:1414-1418`。

**影響範囲**: `onCacheError` を受ける全 API（`fetchBytes` / `prefetchUrl` / `openCachedUrl` /
HF 層）。実際に新しい値が流れるのは `openCachedUrl` の "blob" 経路だけ。

**引き継ぎ**: a) を採るなら `mod.test.ts:3500` の
`assertEquals(notified.map((context) => context.op), ["match"])` を `["blob"]` へ変える（それだけで
赤 → 緑が確認できる）。b) を採るならテスト変更は不要で、JSDoc 1 行のみ。

---

### G1-04 🟡 Warning — `readFromStream` の `body === null` 分岐が未凍結（Deno では到達可能・ライブラリ経路では到達不能）

**質問**: `core.ts:1514-1519` の `body === null` 分岐に、到達可能性を示すテストを足しますか。それとも
「ライブラリが書くエントリでは到達しない」ことを根拠に分岐ごと落としますか。

**概要**:
Deno 2.9.6 で実測したところ、Cache API の応答が `body === null` になるのは**元の `Response` の body
が `null` だったとき**（`new Response(null)` / `204`）だけで、0 バイトの本文
（`new Response(new Uint8Array(0))`）では `body` は `null` にならず、最初の `read()` が
`{ done: true }` を返すストリームになる。このライブラリが cache へ書く経路は
`storableResponse`（`core.ts:572-583`）1 本で、常に `ReadableStream` を body に持たせるので、
**"fetch-cache" 名前空間の中に `body === null` のエントリは生まれない**。つまり 1514-1519 は
現状ではライブラリ経路から到達不能な防御コードで、かつテストも無い。

分岐の中身自体は正しい（`offset + length > 0` なら `size = 0` の範囲外、そうでなければ空配列 —
"blob" 側で `blob.size === 0` としたときと同じ答えになる）。問題は「正しさを誰も凍結していない」
ことと、Simplicity first（単一使用の抽象・不要な分岐を置かない）との緊張。

**守っている目的**: 空の端で "blob" と "stream" が同じ答えを返すこと。落とす場合はその同値性が
壊れないかを確かめる必要がある（落とすと `body!.getReader()` が `TypeError` になる）。

**選択肢**:
- a) ★ 分岐を残し、テストを 1 本足す。`caches.open(CACHE_NAME)` へ直接 `cache.put(URL_A,
  new Response(null))` で仕込み、`openCachedUrl(URL_A, { read: "stream" })` の `read(0, 0)` が
  空配列、`read(0, 1)` が「本文 0 バイト」で throw することを凍結する（Deno で到達可能なことは
  実測済み）。理由: ①外部が同名前空間へ書く可能性を完全には否定できない（`caches` は共有資源）
  ②防御コードの正しさが記録される ③テストは 10 行以下。
- b) 分岐を落として `body` を `!` で受け、`storableResponse` が唯一の書き手であることを
  コメントで根拠づける。行数は減るが、外部が書いたエントリで `TypeError` になる（fail loud では
  あるが文言が実装の生エラーになる）。
- c) 現状維持（分岐もテストも今のまま）。

**リスク**: a) はテストが 1 本増えるだけ。b) は「ライブラリだけがこの名前空間へ書く」という前提に
依存する — `docs/limitations.md:196` 付近が「固定名前空間 "fetch-cache" を共有する」と書いている
ことを踏まえると、その前提は明文化されていない。

**対象**: `src/core.ts:1514-1519` / `src/core.ts:572-583`（唯一の書き手）。

**影響範囲**: "stream" 戦略のみ。

**引き継ぎ**: 実測手順は `deno run -A` の使い捨てスクリプトで再現できる（`caches.open("probe-*")` →
`cache.put(url, new Response(null))` → `match(url).body === null` が `true`。0 バイト本文
`new Response(new Uint8Array(0))` では `false`）。テストを書くときは "fetch-cache" 名前空間を
使い、`finally` で `caches.delete` すること（CLAUDE.md の規約）。

---

### G1-05 🟡 Warning — `length === 0` と「1 チャンク内に収まる読み」の境界が未凍結（"blob" と "stream" で経路が大きく違う）

**質問**: 空区間（`read(0, 0)` / `read(size, 0)`）と 1 チャンク内完結の読みを、両戦略で凍結する
テストを足しますか。

**概要**:
現在のテストが踏んでいる `(offset, length)` は `(3,16)` / `(131067,4096)` / `(size-8,8)`（正常系）と
`(1,size)` / `(99,1)` / `(0,MAX_SAFE_INTEGER)`（範囲外）だけで、**`length === 0` が 1 つも無い**。
`length === 0` は 2 戦略で経路が根本的に違う:

| 呼び出し         | "blob"（`core.ts:1479-1492`）        | "stream"（`core.ts:1534-1550`）                                     |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------- |
| `read(0, 0)`     | `0 > size` は偽 → 空配列（I/O ゼロ） | ループ条件が最初から偽 → 空配列（`match` はするが `read()` は 0 回） |
| `read(size, 0)`  | `size > size` は偽 → 空配列          | **本文を最後まで読み飛ばして**から脱出（O(size)）                   |
| `read(size+1, 0)` | `size+1 > size` → 範囲外 throw       | 全部読み飛ばして `done` → 範囲外 throw（`size` は一致）             |

手で追った限り 3 行とも両戦略の**答えは一致する**（証明 1 の帰結）が、`read(size, 0)` が "stream"
では本文全量の読み飛ばしになる点は誰も気付けない。加えて「1 チャンク（64 KiB）内で完結する読み」
（例 `read(10, 16)`）と「複数チャンクにまたがる読み」（例 `read(60000, 20000)`）の区別も、現在の
3 点（`(3,16)` は 1 チャンク内、`(131067,4096)` はチャンク境界 131072 をまたぐ）で偶然カバーされて
いるだけで、テストの意図としては書かれていない。

**守っている目的**: 「2 戦略はどちらを選んでも同じバイト列・同じエラーを返す」という、`strategy` を
診断用の情報に留めるための同値性。ここが割れると `read` の強制が性能ではなく**意味**を変える。

**選択肢**:
- a) ★ 既存の `for (const strategy of ["blob","stream"] as const)` ループ（`mod.test.ts:3195`）へ
  `(0,0)` / `(size,0)` / `(size-1,1)` を足し、範囲外ループ（`mod.test.ts:3292-3321`）へ `(size+1,0)` を
  足す。テーブル駆動なので追加は 4 行。
- b) a) に加えて、`read(size, 0)` が "stream" で O(size) になることを
  `OpenCachedOptions.read` の JSDoc へ 1 文足す。
- c) 現状維持。

**リスク**: なし（テストの追加のみ）。a) は現状の実装で緑になるはず — 赤になったら本文中の
「答えは一致する」という私の証明が誤りなので、その場合は G1-01 より優先度が上がる。

**対象**: `src/core.ts:1479-1481` / `src/core.ts:1534-1550` / `src/mod.test.ts:3196-3229`（正常系
ループ）/ `src/mod.test.ts:3292-3321`（範囲外ループ）。

**影響範囲**: テストのみ。

**引き継ぎ**: `(size, 0)` を "stream" で走らせると 256 KiB を読み飛ばすので、テスト時間は
実質ゼロのまま（実測 64 KiB × 4 チャンク）。`assertEquals(bytes.length, 0)` と
`assertEquals(bytes, new Uint8Array(0))` の両方を書くこと（前者だけだと `undefined` を素通しする）。

---

### G1-06 🟡 Warning — 並行 `read` と「`read` 中の `cache.match` 失敗」が未凍結（縮退しないことを誰も確かめていない）

**質問**: ①同一 `CachedEntry` からの並行 `read` が互いに干渉しないこと ②`read` 中の cache I/O
失敗が `onCacheError` へ流れず**そのまま throw** すること — の 2 点をテストで凍結しますか。

**概要**:
①について、"stream" は `read` ごとに `cache.match` するので独立した `Response` / `ReadableStream` を
得る。Deno で実測し、同じ `Cache` ハンドルから 2 本同時に `match` して両方 1024 バイト読めることを
確認した（干渉なし）。"blob" は `blob.slice()` が毎回新しい `Blob` を返すので同じく独立。**実装は
正しい**が、テストは常に逐次で叩いており、`Promise.all([entry.read(a), entry.read(b)])` が 1 本も
無い。下流の decode ループが並行に引く形へ変わると、ここが最初に壊れる箇所になる。

②について、ADR 0012 §4（`0012:100-102`）と JSDoc（`core.ts:1575-1577`）が「`read` 中の失敗は縮退先が
無いのでそのまま throw する」と宣言している。実装（`core.ts:1508`）は `cache.match` を `try` で
囲んでいないので宣言どおりだが、`open` 側の縮退（`mod.test.ts:3352` / `3370`）だけがテストされて
いて、read 側の「縮退しない」は凍結されていない。将来 `readFromStream` に `try/catch` が足されても
テストは緑のままになる。

**守っている目的**: ①ハンドルが状態を共有しない（`read` は純粋な問い合わせである）こと
②`onCacheError` の適用範囲を「開く時」に限る、という ADR 0001 との住み分け。

**選択肢**:
- a) ★ 2 本足す。並行は `Promise.all` で異なる区間を 4 本同時に読み、それぞれ
  `RANGE_BYTES.subarray(...)` と一致することを両戦略で確認。縮退しないほうは
  `failingCacheStorage({ match: … })` を**開いた後に**壊す形（`match` を 1 回目だけ成功させる
  カウンタ付きスタブ）で `assertRejects` し、`onCacheError` が呼ばれていないことも
  `assertEquals(notified, [])` で凍結する。
- b) ②だけ足す（①は実測で確認済みなので所見に残すに留める）。
- c) 現状維持。

**リスク**: なし（テストの追加のみ）。a) の縮退しないテストは `failingCacheStorage` の既存ヘルパを
そのまま使えるので、新しいテスト用機構は要らない。

**対象**: `src/core.ts:1508`（`try` で囲まれていないこと自体が仕様）/ `src/core.ts:1575-1577`
（JSDoc の宣言）/ `docs/decisions/0012-open-cached-range-read.md:100-102`。

**影響範囲**: テストのみ。

**引き継ぎ**: 並行テストは "stream" が本命（毎回 `match` するため）。"blob" 側は `blob.slice()` の
独立性を見るだけなので 1 本にまとめてよい。カウンタ付きスタブは
`let calls = 0; match: (r) => (calls++ === 0 ? caches.open(CACHE_NAME).then(c => c.match(r)) :
Promise.reject(new Error("storage broken")))` の形で書ける。

---

### G1-07 🟡 Warning — 「`clearCache` でエントリが消えれば次の `read` が throw」はブラウザでは成立しない可能性がある（needs-human）

**質問**: `docs/limitations.md:168-171` と ADR 0012 Consequences（`0012:123-126`）の「並行する
`evict` / `clearCache` / self-heal でエントリが消えれば次の `read` が throw する」という記述を、
`clearCache` だけランタイム依存として但し書きしますか。

**概要**:
`openCachedUrlWithKey` は開く時に `Cache` オブジェクトを 1 回だけ取得し（`core.ts:1626`）、
"stream" のハンドルはその `cache` を**保持し続ける**（`core.ts:1680`）。`clearCache` は
`cacheStorage.delete(DEFAULT_CACHE_NAME)`（`core.ts:1745`）なので、保持中の `Cache` オブジェクトが
削除後も生きるかは実装依存になる。

- Deno 2.9.6 で実測: `caches.delete(name)` の後、保持していた `Cache` から `match` すると
  `undefined` が返る → **文書どおり throw する**。
- ブラウザ（Service Worker 仕様の storage model）では、`CacheStorage.delete` は名前 → cache の
  対応を外すだけで、既存の `Cache` 参照が指す cache は参照が残る限り生き続ける（Chrome の
  "doomed cache"）。この場合 `clearCache()` の後も "stream" の `read` は**成功し続ける**可能性が
  高い。`evictUrl` / `evict` / self-heal（＝`cache.delete(key)`）は同じ `Cache` に対する操作なので
  ランタイムに依らず throw する — 割れるのは `clearCache` だけ。

**needs-human**: ブラウザ側は仕様の読みと Chrome の既知挙動からの推定で、**未実測**。Chrome 152 で
①`caches.open("t")` → `put` → ②`caches.delete("t")` → ③保持していた `Cache` から `match` を 1 回
叩けば確定する（10 行の HTML で足りる）。

**守っている目的**: 「開いたハンドルはスナップショットではない」という宣言の正確さ。文書が
「消えれば throw」と言い切っていると、ブラウザで `clearCache()` 後も読めることを**バグとして
報告される**か、逆に「clearCache すれば区間読みも止まる」という誤った前提でコードが書かれる。

**選択肢**:
- a) ★ Chrome で実測してから、割れるなら `limitations.md:168-171` を「`evictUrl` / `evict` /
  self-heal は次の `read` が throw する。`clearCache` は保持中の `Cache` オブジェクトの寿命が
  ランタイム依存なので、読み続けられることがある」へ書き分ける。ADR 0012:123-126 も同様。
- b) 実装側で揃える: ハンドルに `cacheStorage` を持たせ、`read` のたびに
  `cacheStorage.open(DEFAULT_CACHE_NAME)` からやり直す。`clearCache` 後は新しい空 cache が開かれる
  ので、どのランタイムでも `undefined` → throw になる。代償は `read` ごとに `open` が 1 回増える
  こと（`read` は 1 token 1 回叩かれる想定の口なので、`open` のコスト次第では効く — 未計測）。
- c) 現状維持（Deno での挙動だけを文書にする）。

**リスク**: a) は文書のみ。b) は `read` のホットパスに I/O を 1 回足すので、ADR 0012 が解こうとして
いる性能問題そのものに触れる — 採るなら計測が先。

**対象**: `src/core.ts:1626`（`Cache` の 1 回取得）/ `src/core.ts:1676-1687`（保持）/
`src/core.ts:1578-1580`（JSDoc の宣言）/ `docs/limitations.md:168-171` /
`docs/decisions/0012-open-cached-range-read.md:123-126`。

**影響範囲**: ブラウザでの `clearCache` と "stream" の併用のみ。ブラウザ既定は "blob"（そちらは
**元から**開いた時点の Blob を持つので消えても読める、と既に明記済み）なので、`read: "stream"` を
明示したブラウザ利用だけが該当する。

**引き継ぎ**: 実測は Deno 側だけ済んでいる（`caches.delete` 後に保持ハンドルから `match` →
`undefined`）。ブラウザは自動テストに載せられない（CLAUDE.md のネットワーク禁止規約とは別に、
Cache API のブラウザ実装差は Deno のテストからは観測できない）ので、手動確認 → 文書化が現実的。

---

### G1-08 🔵 Low — "stream" は本文長を知る前に `length` ぶんを確保するので、小さいエントリへ巨大な `length` を投げると確保だけが先に走る

`core.ts:1520-1529`。`read(0, 500_000_000)` を 10 バイトのエントリへ投げると、500 MB の確保に
成功してから `done` で範囲外 throw する（"blob" は `blob.size` 比較で I/O ゼロで落ちる）。コメントは
この順序を「本文長が読み終わるまで分からないので確保が先」と説明しており、実際 Deno の Cache API の
応答には `content-length` が**付かない**ことを実測で確認した（`x-fetch-cache-sha256` だけ）ので、
安く本文長を先に知る手は無い。回避するならバッファを段階的に伸ばす実装になるが、「確保できない
`length` も範囲外として同じ文言で落とす」という ADR 0012 §4 の判断（`0012:103-106`）と引き換えに
なる。**現状維持を推奨**し、必要なら `OpenCachedOptions.read` の JSDoc に一文を足すに留める。

---

### G1-09 🔵 Low — `failure.cause = error` は `new Error(msg, { cause })` 形式に揃えたい

`core.ts:1526-1528`。`outOfRange` が `Error` を返すので後から `cause` を代入しているが、同じファイルの
`normalizeUrl`（`core.ts:319-323`）は `new Error(msg, { cause: error })` を使っている。`outOfRange` に
第 5 引数 `cause?: unknown` を足して `new Error(message, cause === undefined ? undefined : { cause })`
とすれば形式が揃う。挙動は同一（`cause` の後付け代入も enumerable な own property になる点だけが
違う）。

---

### G1-10 🔵 Low — `CachedEntry.read` の戻り型は `Uint8Array<ArrayBuffer>` まで絞れる

`core.ts:1376-1380`。`readFromBlob` は `new Uint8Array(await …arrayBuffer())`、`readFromStream` は
`new Uint8Array(length)` を返すので、**常に `ArrayBuffer` 背面**であることが実装から確定している。
`Promise<Uint8Array>` のままだと、受け取ったバイト列を `fetchBytes` の `into`（型は
`Uint8Array<ArrayBuffer>` — `core.ts:162`）や `crypto.subtle.digest` へそのまま渡せず、下流に `as` を
強いる（TypeScript 規約「`satisfies` over `as`」に反する形で表面化する）。型を狭める変更は既存の
呼び出しを壊さない（`Uint8Array<ArrayBuffer>` は `Uint8Array` の部分型）ので追加のみのリリースに
載せられる。`fetchBytes` が `Promise<Uint8Array>` なのは `decode` が任意の `Uint8Array` を返せる
ためで、`read` にはその事情が無い。

---

### G1-11 🔵 Low — `outOfRange` のメッセージ内の `offset + length` は安全整数の和で桁落ちしうる

`core.ts:1459-1461`。`assertRange` は両者が `Number.isSafeInteger` であることしか要求しないので、
`read(2**53 - 1, 2**53 - 1)` のような呼びでは `offset + length` が不正確な値として**メッセージに
出る**。判定側（`offset + length > blob.size`）は和が過小評価されても必ず `size` を超えるので
**挙動は正しい**（"stream" 側も `new Uint8Array(2**53-1)` が `RangeError` になることを実測済み）。
表示だけの問題なので、気になるなら文言を `offset ${offset} + length ${length}` へ変える。

---

### G1-12 🔵 Low — `OpenCachedOptions.read`（戦略名）と `CachedEntry.read`（関数）が同名で読みにくい

`core.ts:1400` と `core.ts:1376`。`openCachedUrl(url, { read: "blob" })` の直後に
`entry.read(offset, length)` が並ぶので、読み手が「`read` オプションが `read` 関数を差し替える」と
誤読しうる。ADR 0012 §2 でも `read` で強制すると書かれているため文書は一貫しているが、
`strategy: "blob" | "stream"` にすれば戻り値の `entry.strategy` とも呼応して自明になる。
**0.8.0 未リリースの今しか変えられない**（公開後は breaking）。判断はオーナー。

---

### G1-13 🔵 Low — `openCachedUrl` は single-flight に参加しないことが文書に無い

`fetchBytes` の in-flight（`core.ts:645` 付近のフライト表）は `cache.put` が終わるまで cache に何も
書かないので、ダウンロード進行中に `openCachedUrl` を叩くと `undefined` が返る。「エントリが
無ければ `undefined`、温めるのは呼び出し側」（`core.ts:1567-1568`）から演繹はできるが、
「`prefetchUrl` を `await` せずに走らせておいて `openCachedUrl` でポーリングする」という誤用は
起こりうる。`OpenCachedOptions` か README の該当段落に「進行中のダウンロードは見えない
（`await` してから開く）」の一文を足すと閉じる。

---

### G1-14 🔵 Low — ROADMAP G3-05（`HfResolveOptions`）の発火条件が満たされた（担当外・記録のみ）

前回レビュー（2026-09-05）の ROADMAP G3-05 は「`resolveHfRevision` の opts を名前付き公開型
`HfResolveOptions` にする（追加のみ）— **次の HF 層 API 変更に同乗**」という条件付きだった。今回の
差分は HF 層へ `openHfFile` と `HfOpenOptions`（`src/hf/mod.ts:498-505` / `530-550`）を追加しており、条件は
満たされている。`resolveHfRevision` の opts は依然として無名のインライン型（`src/hf/mod.ts:173-180`）。
HF 層は G1 の担当外なので実施可否の判断は G3 / オーケストレータへ委ねるが、**同乗できる回を 1 つ
逃す**ことになるので記録する。

---

## テスト ↔ 実装行の対応（「そのテストが赤になる実装行」）

| テスト（`src/mod.test.ts`）                              | 赤にできる実装行                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| 区間を元バイト列どおりに読む × 2 戦略（3196）            | `core.ts:1482-1483`（slice の範囲）/ `1542-1549`（skip / take の算術） |
| キャッシュに無い URL は undefined（3230）                | `core.ts:1638`                                                      |
| 記録不一致は evict して undefined（3238）                | `core.ts:1641-1655`（self-heal 分岐）                               |
| 記録なしは undefined・evict しない（3259）               | `core.ts:1643`（`recorded !== null` の内側だけ delete）             |
| 範囲外は throw × 2 戦略（3292）                          | `core.ts:1479-1481` / `1540` / `1523-1529`（確保失敗の読み替え）     |
| signal で中断・`signal.reason` で reject（3323）         | `core.ts:1536`（ループ内の観測点）                                  |
| `caches.open` 失敗は縮退 + 通知（3352）                  | `core.ts:1627-1630`                                                 |
| `cache.match` 失敗は縮退 + 通知（3370）                  | `core.ts:1634-1637`                                                 |
| 配列キーのエントリを開く / 入口検査（3386）              | `core.ts:1599`（`serializeKey`）/ `1604-1608` / `1433-1446`          |
| `read` の不正値は cache に触る前に throw（3419）    | `core.ts:1611-1619` + 1621 より前にあること                         |
| 消えたエントリで throw（"stream" 3448）/ 読める（"blob" 3467）      | `core.ts:1509-1513` / `1668-1672`（Blob を握り続けること）           |
| `blob()` 失敗は縮退 + 通知（3483）                       | `core.ts:1661-1667`                                                 |
| 既定戦略は Deno なら "stream"（3506）               | `core.ts:1427-1428`                                                 |

未凍結（G1-04 / G1-05 / G1-06 / G1-01 のテスト仕様は各エントリ参照）: `body === null`（1514-1519）/
`length === 0` の 3 通り / 並行 `read` / `read` 中の `match` 失敗が縮退しないこと /
確保失敗時の `cause` 保持（1527）。

---

## 横断所見

- **ADR 0012 への追従は 1 点を除いて完全**。§1（network に出ない・`CachedEntry` の形・内部導管）
  §2（2 戦略・既定の選び方・2 値以外は throw・signal の観測点）§3（判定は記録ハッシュの文字列比較
  のみ・記録なしは `undefined` で evict しない・`validate` / `decode` / `recheck` / `into` を持たない）
  §4（開く時は縮退 + 専用文言、`read` 中は throw、確保失敗は範囲外へ読み替え）はすべて実装と一致
  する。唯一の欠落は §4 / Consequences が**エントリの差し替わり**を扱っていないこと（G1-01）。
- **既存規約との同型性は保たれている**。①記録ハッシュ判定は `fetchBytes`（`core.ts:722-731`）と
  同じく「文字列比較のみ・記録なしは evict しない」 ②self-heal の `cache.delete` 失敗は
  `op: "delete"` で通知（`core.ts:1649` ⇔ `core.ts:758`） ③予約 origin は `normalizeUrl` を共有する
  ので `fetchBytes` と完全同挙動 ④入口検査 → cache という順序も `fetchBytesWithKey` と同じ。
  意図的な非対称は `crypto.subtle` の存在検査を持たないこと（`core.ts:1035` に相当するものが無い）
  で、**この API は一度もハッシュを計算しないので正しい**。
- **fail loud は 1 か所（G1-02）を除いて守られている**。短い戻りの検出（1487-1491）、確保失敗の
  読み替え（1523-1529）、綴り違いの戦略名を黙って既定へ落とさないこと（1611-1619）は、いずれも
  「黙って縮退すると性能差 / データ欠けとしてしか現れない」という判断が明文で残っており、
  CLAUDE.md の趣旨と一致する。
- **型安全**: `any` / `@ts-` は 1 つも無い。`globalThis as { Deno?: unknown }`（1428）は
  `normalizeUrl`（`core.ts:315-317`）と同型のキャストで、既存の作法どおり。`??` の使い方
  （1600 / 1621 / 1658）も `||` への退行なし。改善余地は G1-10（戻り型の精密化）だけ。
- **リリース前の残作業**（担当外・確認のみ）: `deno.json` の `version` と `src/mod.ts:35` の
  `VERSION` はまだ `0.7.0`。`deno task bump minor` は別コミットの手順（メモリの「リリースフローの
  取り決め」どおり）なので、この差分で未実施であること自体は正しい。
- **実測に使った使い捨てスクリプト**は
  `/tmp/claude-1000/-home-developer-workspace-fetch-cache/6ccc60c2-a1f4-45d2-9b4b-e42eed4459c9/scratchpad/probe1.ts`
  〜 `probe3.ts`（Cache 名前空間 `probe-G1-01` 〜 `probe-G1-03`・実行後に `caches.delete` 済み）。
  "fetch-cache" 名前空間には一切触れていない。
