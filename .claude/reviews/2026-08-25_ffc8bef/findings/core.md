# core — `src/mod.ts`（コア cache 層）レビュー（v0.4.0..HEAD / ffc8bef）

対象: `git diff v0.4.0..HEAD -- src/mod.ts`（643 行変更）と現行 `src/mod.ts` 全文。
正本: `docs/decisions/0006-cache-control-redesign.md` / `0007-explicit-expected-bytes-fail-loud.md`、
`CLAUDE.md`（依存ゼロ MUST / fail loudly / 縮退経路は self-heal と onCacheError の 2 つだけ）。
スコープ外: `README.md` / `docs/limitations.md` の未コミット変更、`src/hf/`・テスト（別レンズ。
境界に跨る所見は CORE-008 / CORE-004 に印を付けた）。コード変更は行っていない（読み取り専用）。

事実確認は実測ベース（Deno 2.x・network には出ていない）:

- 配列キー直列化の URL 往復安定性（13 パターン: `/` 入り・非 ASCII・空白・孤立サロゲート・
  `1` vs `"1"`・指数表記・空文字）→ 全て `Request.url` を通しても文字列が変化せず完全復元。
- `Cache` の URL 正規化と予約 origin ガードの突破（CORE-001 / 使い捨て名前空間で検証・後始末済み）。
- `crypto.subtle.digest` の呼び出し回数計測（CORE-002 / `caches` DI + fetch DI で検証）。

---

## 🟡W CORE-001 — 予約 origin ガードが URL の**大文字表記**をすり抜け、配列キーのエントリを上書きできる

**概要**: `assertNotReservedOrigin` は生の文字列前方一致（`url.startsWith(KEY_ORIGIN)`）で判定する
（`src/mod.ts:229-235`）が、Cache API 側は `Request` 構築時に scheme / host を小文字へ正規化する。
そのため `HTTPS://FETCH-CACHE.INVALID/v1/%22a%22` はガードを通り抜け（`startsWith` = false）、
`cache.match` / `cache.put` の時点で `https://fetch-cache.invalid/v1/%22a%22` ＝ **配列キー
`["a"]` のエントリそのもの**に解決される。実測（使い捨て名前空間）:

```
after array-key put: [ "https://fetch-cache.invalid/v1/%22a%22" ]   // key ["a"] → [1,2,3]
after bypass  put  : [ "https://fetch-cache.invalid/v1/%22a%22" ]   // 大文字 URL で put
array key now reads: [ 9, 9 ]                                        // ["a"] の内容が入れ替わった
```

`URL` オブジェクトで渡した場合は `url.href` が正規化するので捕まる。**文字列で渡した経路だけ**が
抜ける（`fetchBytes:604` / `prefetchUrl:769` / `evictUrl:928` の 3 入口すべて）。

**実害・発生条件**: 呼び出し側が予約ホストを非小文字表記で名指した場合に、① 読出しで他キーの内容を
その URL の内容として受け取る（`sha256` / `validate` 未指定なら黙って誤ったバイトが返る）、
② 書込みで配列キーのエントリを上書きする、③ `/v1/` 配下に復元不能なエントリが生まれると
`listKeys` が名前空間全体に対して throw し続ける（`src/mod.ts:1016-1020`）、④ `/v1/` 外に落ちた
エントリは `listKeys`（prefix 不一致）にも `listCachedUrls`（`KEY_ORIGIN` で除外・`:1042`）にも
現れない**不可視の残骸**になり、`clearCache` / `evict([])` 以外で掃除できない。実測で ①③④ を確認。
なお `.invalid` は名前解決されないので、network 側 fetch が成立するのは `opts.fetch` 差し替え /
Service Worker 経由の場合に限られる（read 側の ① は差し替え無しでも成立する）。

**修正案**: 比較を文字列前方一致から origin 同値判定へ変える（1 箇所の変更で ①〜④ すべて塞がる）:

```ts
const isReservedOrigin = (url: string): boolean => {
  try { return new URL(url).origin === KEY_ORIGIN; } catch { return false; }
};
```

`listCachedUrls:1042` の除外述語も**同じ述語に揃える**こと（片方だけ直すと、いまは一致している
ガードと除外の判定が乖離して「fetch は通るのに一覧に出ない URL」が生まれる）。副次的に、現行の
素の前方一致が誤って弾いている `https://fetch-cache.invalid.example.com/...`（実在し得る別 origin）
も救われる。

**対象**: `src/mod.ts:228-235`（ガード本体）/ `src/mod.ts:604` / `:769` / `:928`（3 入口）/
`src/mod.ts:1042`（`listCachedUrls` の除外）

**根拠**: ADR 0006 §1 は「ホストは RFC 2606 予約 TLD の `fetch-cache.invalid` — **実在 URL と衝突し
得ない**」を直列化所有権移動の要としており（`0006:43-44`）、旧レビュー IM-03（fragment 剥がしに
よるキー衝突）の「構造的消滅」（`0006:51-52`）もこの不変条件に乗っている。ガードが 1 文字の
ケース差で破れる以上、この不変条件は実装として成立していない。CLAUDE.md「Fail loudly / 破損・
不正データを黙って握りつぶさない」にも抵触する（①は無言の誤配になる）。

---

## 🟡W CORE-002 — 記録ハッシュが**不一致**のヒットで、実バイトを全量読み出し + 全量ハッシュしてから self-heal する

**概要**: ヒット処理は `recorded` を読んだうえで `trusted` を計算するだけで、**不一致を
short-circuit しない**（`src/mod.ts:503-524`）。`recorded !== opts.sha256` のとき `trusted` が
false になり、`checkAndDecode` が `sha256HexNative(raw)` を走らせてから「不一致」で throw →
catch → evict → network、という順路になる（`:423-430` / `:526-535`）。さらに `cachedBytes` は
鮮度判定の**前**に `await cached.arrayBuffer()` で無条件に materialize される（`:509`）。

`crypto.subtle.digest` の呼び出しを計測した実測（記録 = 旧内容のハッシュ、期待 = 新内容のハッシュ）:

```
evicted = true
digest calls = 2 (bytes hashed = 22; cached=11, fresh=11)
=> 記録が不一致でもキャッシュ実体を全量ハッシュしてから self-heal している
```

**実害・発生条件**: 「安定キー + `sha256`」運用（ADR 0006 §5 の 2 行目・ピンポン）で revision を
切り替えるたび、破棄すると分かっているエントリに対して **N バイトのキャッシュ読出し + N バイトの
native digest** を必ず払う。ADR 0005 が想定する数 GB 級では、切替 1 回あたり数秒の CPU と
ヒープ N バイトのピークが増える（Chromium の単一 ArrayBuffer 上限 2,145,386,496 バイトを超える
エントリでは `arrayBuffer()` 自体が RangeError → `op: "match"` の縮退通知になり、記録を読めば
1 文字で分かったはずの判定が「cache I/O 失敗」として報告される）。挙動（self-heal）は正しいので
correctness の欠陥ではないが、**公開 JSDoc の記述とは食い違う**: `:87-89` は
「記録ハッシュと期待値の**文字列比較だけ**で鮮度を判定する（ハッシュ計算ゼロ）。不一致 = 内容が
変わったものとして evict」と書いており、不一致側では成立していない。

**修正案**: `cached` を得た直後、body を materialize する前に記録で判定する。

```ts
const cached = await cache.match(storageKey);
if (cached !== undefined) {
  recorded = cached.headers.get(SHA_HEADER);
  if (opts.sha256 !== undefined && recorded !== null && recorded !== opts.sha256) {
    await cached.body?.cancel().catch(() => {});   // 読み出さずに捨てる
    staleEntry = true;                              // → evict してフォールスルー
  } else {
    cachedBytes = new Uint8Array(await cached.arrayBuffer());
  }
}
```

`recheck: true` でも short-circuit してよい（記録が期待値と違う時点でそのエントリは呼び出し側が
求めた内容ではない。`recheck` の役目は「記録と実バイトの乖離」の検出であり、記録自体が別内容を
指しているケースはその手前で決着する）。この分岐を入れる場合は、`recheck: true` + 記録不一致で
再ハッシュが走らないことを 1 テストで凍結しておくと退行を防げる。

**対象**: `src/mod.ts:503-524`（ヒット処理）/ `src/mod.ts:423-430`（`checkAndDecode`）/
`src/mod.ts:87-89`（食い違っている JSDoc）

**根拠**: ADR 0006 §2「**ヒット時**: 期待 `sha256` と記録ハッシュの**文字列比較のみ**（ハッシュ
計算ゼロ）。一致 → 採用。不一致 → 内容が変わったものとして self-heal（evict → 取得元から取り直し）」
（`0006:69-71`）。ADR は不一致側にもハッシュ計算を課していない。ADR 0006 Context の動機
（「バイト不変のファイルまで再ダウンロードになる」＝ GB 級の無駄を消す）とも方向が逆。

---

## 🟡W CORE-003 — single-flight 合流者の経路には self-heal が無い（JSDoc は無条件に self-heal と書いている）

**概要**: 合流者は `await existing.promise` の後に `checkAndDecode(raw, opts)` を走らせるだけで、
`cache` ハンドルを持たない（`src/mod.ts:663-674`）。したがって**合流者の `sha256` / `validate` /
`decode` がバイト列を拒否しても、evict も再取得も起きず素の throw になる**。一方 `fetchBytes` の
JSDoc は `:575-577` で無条件に「`sha256` / `validate` / `decode` がキャッシュ内容を拒否したら
evict して network から取り直す（self-heal）」と書いている。

**実害・発生条件**: 「同じ `key` を名乗る並行呼び出しで、検証オプションが呼び出し側ごとに違う」
ときに顕在化する。例: 呼び出し A（`sha256` 無し）が leader になって陳腐化エントリをヒットで返し、
呼び出し B（`sha256` 有り）が合流 → B だけが例外を受け取り、**陳腐化エントリは残ったまま**。B が
単独で走れば leader になって self-heal するので恒久化はしないが、A が常に先着する構成（起動時に
2 コンポーネントが同時要求する等）では B が毎回失敗し続ける。ADR 0006 §1 が「同一キーを名乗ること
= 内容同一という呼び出し側の主張」として別 URL の合流まで許した以上、「同一キーだが検証条件が違う
呼び出し」は設計上あり得る組合せになった。

**修正案**: コードで塞ぐより**記述を実挙動へ寄せる**のを推奨する（合流者に evict 権を与えると、
leader が正当に put した直後のエントリを合流者が消すスラッシングを新たに作る）。

- `fetchBytes` の JSDoc `:575-577` に「self-heal は leader 経路のみ。合流者の検証失敗は
  evict を伴わない throw になる（次の単独呼び出しが self-heal する）」を 1 文追加。
- `docs/limitations.md` の合流制約（「合流者のオプションが使われない」系）に同じ 1 行を足す。
- コードで直すなら、合流者の検証失敗時に `evict(key)` 相当を 1 回だけ試す案があるが、上記の
  スラッシングと「leader が network から取ったばかりの正当なエントリを消す」副作用の裁定が要る
  ため、オーナー判断事項として据え置くのが妥当。

**対象**: `src/mod.ts:663-674`（合流経路）/ `src/mod.ts:575-577`（無条件に self-heal と書く JSDoc）

**根拠**: CLAUDE.md「正規の縮退経路は 2 つだけ: キャッシュ破損は evict → 真実源から取り直す
self-heal、cache I/O 失敗は network へ縮退 + `onCacheError` 通知」。合流者の検証失敗はどちらにも
乗らない第 3 の経路（素の throw）になっており、公開 JSDoc の記述もそれを反映していない。
なお本挙動は 0.4.0 から継続（`validate` のみだった当時から同型）で、ffc8bef が持ち込んだ欠陥では
ないが、`sha256` の一級化で「検証条件の違う合流」が現実的になったため 0.5.0 で記述を揃える価値がある。

---

## 🟡W CORE-004 — `prefetchUrl` は記録ハッシュを見ないため、安定キー運用で陳腐化エントリを streaming 経路から更新できない

**概要**: 既存エントリ検査は「あるか無いか」だけで、記録ハッシュ（`x-fetch-cache-sha256`）と
`opts.sha256` を突き合わせない（`src/mod.ts:802-808`）。したがって同じキーに別内容が載っている
状態で `prefetchUrl(url, { key, sha256 })` を呼んでも **`false` を返して何もしない**。

**実害・発生条件**: ADR 0006 §5 の「安定キー + `sha256`」ポリシー（有界ストレージ）で内容が
変わったとき、更新手段が `fetchBytes` の self-heal しか無い。ところが `fetchBytes` は全量を
ヒープに materialize する経路であり、ADR 0007 が実在例として挙げる 3,913,609,588 バイトの重みでは
Chromium の単一 ArrayBuffer 上限を超えて**そもそも成立しない**（`readBody` の明示 `expectedBytes`
は fail loud で throw する — ADR 0007 §1）。つまり「上限超えの単一ファイル × 安定キー」の組合せ
では、`evict(prefix)` を呼び出し側が手動で挟まない限りエントリを更新できない。prefetch は
まさにその大きさのために存在する API なので、穴が開いているのは想定用途の中心付近になる。

**修正案**: 既存エントリ検査に記録ハッシュの突合を足す（記録が読めるので追加コストはヘッダ 1 本）:

```ts
const existing = await cache.match(storageKey);
if (existing !== undefined) {
  const recorded = existing.headers.get(SHA_HEADER);
  await existing.body?.cancel().catch(() => {});
  // 記録が期待値と食い違うエントリは「別内容」— 温め直しの対象にする
  if (expectedSha256 === undefined || recorded === null || recorded === expectedSha256) return false;
  await cache.delete(storageKey);
}
```

`expectedSha256` 未指定時と記録なしエントリは従来どおり `false`（無検証 prefetch の意味論を
変えない）。ADR 0006 §2 の「記録 = 保存時に一致した sha256」という一本化された意味に完全に乗る。
**by-design と裁定するなら**、`PrefetchUrlOptions.sha256` の NOTE（`:717-718`）と
`docs/limitations.md` に「安定キーで内容が変わった場合、prefetch では更新できない（`evict` して
から温め直す）」を明記する必要がある — 現行 NOTE の「既存の内容を検証したいなら `fetchBytes` を
使うこと」は、上限超えファイルでは実行不能な案内になっている。

**対象**: `src/mod.ts:802-808`（既存エントリ検査）/ `src/mod.ts:717-718`（現行 NOTE）
※ HF 層（`src/hf/mod.ts:336-337` で `key` / `sha256` を prefetch へ渡す）に跨るが、既定キーが
内容キー（`[..., path, sha256]`）である限り HF 経由では顕在化しない — 顕在化するのは
`HfFileSpec.key` で安定キーを明示した場合。HF 側の主担当は別レンズ。

---

## 🔵L CORE-005 — `deserializeKey` が `null` / オブジェクト / 配列を `CacheKey` 要素として通す

`JSON.parse(...) as string | number | boolean`（`src/mod.ts:219-221`）は JSON.parse が成功しさえ
すれば何でも通す。実測で `/v1/null` → `null`、`/v1/%7B%22a%22%3A1%7D` → `{a:1}`、
`/v1/%5B1%2C2%5D` → `[1,2]` が復元されることを確認。結果、`listKeys` の fail loud
（`:1016-1020`「復元できないエントリ」）は `JSON.parse` が throw するケースしか捕まえず、
型が嘘になった `CacheKey` を返してしまう。`assertKeyElement` と同じ述語で要素を検査し、
外れたら `undefined` を返す（＝ `listKeys` の fail loud に載せる）のが素直。
TypeScript 規約（`as` を避け、`unknown` 境界で検証する）にも合う。

**対象**: `src/mod.ts:216-226` / `src/mod.ts:1013-1021`

---

## 🔵L CORE-006 — `assertKeyElement` のエラー生成が `JSON.stringify(key)` で二次 throw する

要素不正を報告する 2 つの `throw` は、メッセージ組み立てに `JSON.stringify(key)` を使う
（`src/mod.ts:186-190` / `:192-198`）。`key` に BigInt や循環参照オブジェクトが混じっていると
**その `JSON.stringify` 自体が TypeError を投げる**（実測: `Do not know how to serialize a BigInt` /
`Converting circular structure to JSON`）ため、意図した「fetch-cache: key の要素は…」ではなく
ライブラリ名も原因も分からない例外が呼び出し側に出る。型で防げるのは TS 呼び出し側だけで、
JSR 経由の JS 呼び出し側には効かない。`String(element)` か try-catch 付きの安全整形に落とすこと。

**対象**: `src/mod.ts:183-199`

---

## 🔵L CORE-007 — fail loud の網羅が非対称: `recheck: false` 単独は throw、`recheck` × `cache: false` は素通し

`else if (opts.recheck !== undefined)`（`src/mod.ts:642-646`）は `recheck: false` も弾く。
「明示したのに無意味」を fail loud にする判断としては一貫している（HF 層は
`recheck: spec.sha256 === undefined ? undefined : opts.recheck` で回避済み — `src/hf/mod.ts:228`）
ものの、`{ ...common, recheck: flag }` のようなスプレッド合成では驚きになり得る。
一方で **`sha256` + `recheck` + `cache: false`**（ヒットが存在しないので `recheck` は同様に無意味）
は素通しする。`key` × `cache: false` は矛盾として throw する（`:619-626`）のだから、同じ物差しなら
`recheck` × `cache: false` も対象になるはず。どちらの向きに揃えるかはオーナー判断（現状のままなら
`recheck` の JSDoc `:99-103` に「`cache: false` との併用は無意味だが throw しない」を明記）。

**対象**: `src/mod.ts:642-646` / `src/mod.ts:619-626` / `src/mod.ts:99-103`

---

## 🔵L CORE-008 — `sha256` 不一致エラーに URL / キーが載らない

`checkAndDecode` の不一致メッセージは `fetch-cache: SHA-256 不一致: ${actual} != ${opts.sha256}`
のみ（`src/mod.ts:426-428`）。`prefetchUrl` 側（`:825-828`）と HF 層のバイト数不一致
（`src/hf/mod.ts:190-194` は `spec.path` を載せる）は対象を含めているので、この 1 本だけが
「どのファイルか分からない」。`fetchHfFiles` の並列取得で 1 本落ちたときの切り分けに効く。
`checkAndDecode` は `requestUrl` を受け取っていないので、引数追加が必要（内部関数なので非破壊）。
※ 実害が出るのは HF 層の複数ファイル API で、主担当は別レンズ。

**対象**: `src/mod.ts:418-433`（`checkAndDecode` のシグネチャとメッセージ）

---

## 🔵L CORE-009 — 管理 API 群が `caches` DI を受けない（`cacheName` 撤去で逃げ道が 1 本減った）

`evictUrl` / `clearCache` / `evict` / `listKeys` / `listCachedUrls` はいずれもグローバル `caches`
直参照で、`FetchBytesOptions.caches` / `PrefetchUrlOptions.caches` の DI を受けない
（`src/mod.ts:926-1043`）。DI した `CacheStorage` へ書いたエントリは、この 5 本のどれからも
削除・列挙できない。0.4.0 から続く非対称だが、当時は `cacheName` で名前空間を分けられたのに対し
0.5.0 では名前空間が内部固定 1 個になったため、隔離の手段が DI 一本になっている。0.5.0 は breaking
を許容する窓なので、`opts.caches` を任意引数で足す（既定はグローバル）なら今が唯一のタイミング。
入れないなら `docs/limitations.md` に「DI した `caches` のエントリは管理 API の対象外」を明記したい。

**対象**: `src/mod.ts:926-1043`

---

## 🔵L CORE-010 — `VERSION` / `deno.json` が `0.4.0` のまま（bump 未実施）

`src/mod.ts:30` が `export const VERSION = "0.4.0"`、`deno.json` も `"version": "0.4.0"`。
本コミットは ADR 0006 が「0.5.0 として出す」と決めた breaking 変更（`0006:28`）なので、
`deno task bump minor` 前に publish すると焼き込みバージョンが実体と食い違う。
**既知の残作業**（メモリ「fetch-cache のリリース状態」に「残り docs → bump → タグ」と記録済み）
なので新規指摘ではなく、リリース前チェックリストの確認項目として置く。

**対象**: `src/mod.ts:30` / `deno.json:3`

---

## 🔵L CORE-011 — コメントの根拠が事実と食い違う 2 箇所

1. `src/mod.ts:396-399`: 「部分ビュー・SharedArrayBuffer 背面（**WebCrypto が拒否する**）が来た
   ときだけコピーで背面を保証する」— 実測では `crypto.subtle.digest` は部分ビューを拒否せず、
   コピー版と同一ダイジェストを返す（`subarray(2,5)` で確認済み）。拒否が問題になるのは
   SharedArrayBuffer 背面だけ。コピー自体は無害（この層が渡すのは常に tight view なので実行もされない）
   だが、根拠の記述が誤っていると将来「部分ビューは危険」という誤読を生む。
2. `src/mod.ts:312-314`: body が null のフォールバックで「確保済みでも参照を捨てるだけで**害はない**」
   — 実際には確保済み `buffer`（`expectedBytes` バイト）がスコープに生きたまま
   `response.arrayBuffer()` でもう 1 本 N バイトを確保するので、この経路のピークは 2N になる。
   `readBody` が 1N を守るための関数である以上、「害はない」は言い過ぎ（該当は body が null の
   ランタイムに限られるので、記述を「この経路のピークは 2N になるが対象ランタイムが限られる」へ
   直すだけで足りる）。

**対象**: `src/mod.ts:396-399` / `src/mod.ts:311-316`

---

## 🔵L CORE-012 — `serializePrefix` の要素検査ループが冗長

`for (const element of prefix) assertKeyElement(element, prefix);`（`src/mod.ts:968`）の直後に
`serializeKey(prefix)` を呼んでおり（`:969`）、`serializeKey` は同じ検査を自前で回す（`:210`）。
`prefix.length === 0` のときこのループは何もしないので、行を落としても挙動は 1 つも変わらない。

**対象**: `src/mod.ts:967-970`

---

## 🔵L CORE-013 — `-0` が `0` に潰れる（ADR 0006 §1 の「完全復元」の唯一の例外）

`JSON.stringify(-0)` は `"0"` なので、`[-0]` と `[0]` は同一キーへ直列化され、`listKeys` は
`0` を返す（実測確認）。`-0 === 0` なので実害はないが、ADR 0006 §1 の「**可逆**: … 元の配列へ
完全復元できる」（`0006:43-44`）に対する唯一の例外。非有限数値を弾いた `assertKeyElement` の
JSDoc（`src/mod.ts:59-60`）と同じ場所に 1 行足すか、ADR 側に但し書きを置くかで足りる。

**対象**: `src/mod.ts:206-226` / `src/mod.ts:56-61`

---

## single-flight の故障形 — 個別の潰し込み

レビュー観点の指定に従い、4 形 + 隣接 2 形を列挙して各々の成否を判定した。**新規の欠陥は無い**。

| 故障形 | 判定 | 根拠 |
| --- | --- | --- |
| **TOCTOU（二重フライト）** | 成立しない | `inflight.get`（`:663`）から `inflight.set`（`:695`）までに `await` が 1 つも無い。`acquireAndDecode` は async 関数なので呼び出しは同期プロローグまでしか進まず、最初の `await`（`cacheStorage.open` / `fetchImpl`）で必ず制御が戻る。**唯一の抜け穴**は DI した `opts.caches.open` が同期的に `fetchBytes(同一キー)` を再入する場合（`open` の呼び出し自体は同期に起きる）だが、`CacheStorage` 実装が本 API を再入するのは想定外の DI であり実害としては数えない。 |
| **lost wakeup（合流し損ね）** | 成立しない | 合流点は Promise（ラッチする）であって信号ではない。leader が既に settle 済みの entry に合流しても `await existing.promise` は解決する。`inflight.delete` は `.finally` のマイクロタスクで走り、その時点より後に `get` が成功することはない（削除済み）。 |
| **stale delete（新しいフライトの entry を消す）** | 成立しない | `.finally` の反応は inner promise の settle 時に**最初に**キューされ、`inflight.set` は同一同期ブロック内で先に完了している。settle と finally の間に別の `set` が割り込むには、finally より先にキューされたマイクロタスクが必要だが、それは settle 前にキューされたもの＝ settle より前に走る。FIFO 順序から順序反転は作れない。 |
| **自己デッドロック** | 成立する（設計上の既知・文書済み） | leader の `validate` / `decode` から同一キーの `fetchBytes` を呼ぶと自分のフライトへ合流して停止する。`FetchBytesOptions.decode` の JSDoc `:123-125` に MUST NOT として明記済み（`DECIDED: 0004` / キー単位への読み替えは 0006）。検出機構は無い。なお**合流者側の `decode` からの再入は停止しない**（`await existing.promise` 後には entry が削除済みで新規 leader になる）。この非対称は無害。 |
| **spurious wakeup 相当（合流時の進捗リプレイ）** | 無害 | 合流時に `state.last` を 1 回即時通知する（`:670`）。既に完了したフライトへ合流した場合は最終値が 1 回届いて以後無音になるが、`onProgress` は任意情報で単調増加、直後に `fetchBytes` が解決する。 |
| **失敗の記憶 / unhandled rejection** | 成立しない | `.finally` は成否に依らず entry を削除する（`:688-694`）ので失敗は記憶されない。inner promise の rejection は `.finally` が、chained promise の rejection は leader の `await` と合流者の `await` が受けるので、未処理拒否は残らない。 |

---

## 🟢 明示的に確認して問題が無かった点

- **キー直列化の単射性・可逆性**（`:206-226`）: 要素毎 `JSON.stringify` → `encodeURIComponent` →
  `/` 連結。`"1"` vs `1`、`["a","b/c"]` vs `["a/b","c"]`、非 ASCII・空白・空文字・指数表記・
  **孤立サロゲート**（well-formed `JSON.stringify` が `\ud800` へエスケープするので
  `encodeURIComponent` の URIError も起きない）まで 13 パターンを実測し、`Request.url` を
  通した後も文字列が変化せず（正規化不変）、`deserializeKey` で完全復元できた。
  `encodeURIComponent` の非エスケープ集合（`A-Za-z0-9-_.!~*'()`）と URL path の
  percent-encode set は交差しないため、URL 正規化による書き換えが原理的に起きない。
  ドットセグメント（`.` / `..`）も、文字列要素は必ず `%22` で挟まれ数値・真偽値は
  裸のドットにならないため生成され得ない。
- **プレフィックスマッチのセグメント境界**（`:972-975`）: `url === serialized ||
  url.startsWith(serialized + "/")` で `["a"]` と `["ab"]` を正しく分離。空プレフィックスの
  番兵（`serialized === KEY_PREFIX`）は `serializeKey` が 1 要素以上を要求する（`:207-209`）ため
  実キーと衝突し得ず、`[]` が「配列キー全件」を意味する分岐が曖昧にならない。URL キーの
  エントリが配列キーの `evict` / `listKeys` に混ざらないことも判定式から成立する。
- **ガード順序**: `fetchBytes` は 予約 origin → GET → `cache:false` × `key` → キー直列化（要素検査）
  → `sha256` 形式 → `crypto.subtle` 不在 → `recheck` 単独 の順で、**すべて network へ出る前**に
  完了する（`:604-646`）。`prefetchUrl` も 予約 origin → GET → キー直列化 → `sha256` 形式 →
  `caches` 不在 → open → 既存エントリ検査 → fetch の順で同様（`:769-811`）。
- **ADR 0007 の実装一致**（`:293-310`）: 明示 `expectedBytes` の確保失敗のみ `body.cancel()` →
  throw（メッセージに要求サイズ・URL・単一 ArrayBuffer 上限の可能性、`cause` に元エラー）。
  content-length 由来は `allocateHint` で従来どおり縮退（`:261-268`）。形式不正の申告は
  「ヒント無し」＝ v0.4.0 の `expectedBytes ?? total` と同じく content-length へも落ちない
  （`git show v0.4.0:src/mod.ts` と突合済み。ADR 0007 §3「挙動は不変」を満たす）。
- **バッファ成長と進捗の整数性**（`:322-349`）: 申告超過時に `buffer.subarray(0, loaded)` を
  蓄積経路へ引き継いでから `chunks.push(value)` する順序が正しく、チャンクの取りこぼし・
  二重計上が無い。`loaded` は単調増加でチャンク毎に 1 回だけ発火し、超過縮退後も連続する。
  戻り値は常に tight view（`loaded === buffer.length` なら現物、不足なら `slice`）。
- **記録ハッシュの焼き条件**（`:556-566`）: `checkAndDecode` 通過**後**にのみ `storableResponse`
  を組み、`opts.sha256` があるときだけヘッダを載せる。`storableResponse` は 1 チャンク stream の
  新規 `Response` を組むため**上流のヘッダを一切引き継がない** — 取得元サーバが
  `x-fetch-cache-sha256` を返しても記録を詐称できない（`prefetchUrl` の
  `new Response(counted, markerInit)` も同じ性質）。Deno 実測でヘッダが put/match を往復することも確認。
- **prefetch の保険 delete がキー側を向いている**（`:899`）: `cache.delete(storageKey)`。
  ADR 0006 が実装要件として持ち込んだ旧レビュー TS-002 相当（`0006:152-154`）を満たす。
- **`caches.has` による名前空間の非生成**（`:932` / `:989` / `:1008` / `:1037`）: 削除・列挙 API が
  `caches.open` の副作用で空の名前空間を作らない。`Cache.keys()` 未実装ランタイムでは
  `requireKeys` が fail loud（`:953-960`）。
- **依存ゼロ MUST**: 追加された import は無く（`./sha256.ts` のみ）、使用 API は fetch / caches /
  crypto.subtle / TextEncoder 相当の Web 標準に収まっている。

---

## 分類と総評

| 分類 | 件数 | ID |
| --- | --- | --- |
| 🔴 Critical | 0 | — |
| 🟠 Error | 0 | — |
| 🟡 Warning | 4 | CORE-001 / CORE-002 / CORE-003 / CORE-004 |
| 🔵 Low | 9 | CORE-005 〜 CORE-013 |
| 🟢 Safe | — | 上記「明示的に確認して問題が無かった点」8 項目 |

ADR 0006 の中核である「キー直列化の所有権をライブラリへ移す」判断は実装として完成度が高く、
単射性・可逆性・セグメント境界・URL 正規化不変性は実測でも崩せなかった（旧レビュー IM-03 の
問題クラスは宣言どおり消滅している）。ガード順序も 2 つの入口の全項目が network 到達前に揃い、
ADR 0007 は文言まで含めて仕様どおりに実装されている。残る 4 件の 🟡 は性格が 2 つに分かれる:
CORE-001 は**予約 origin という不変条件が 1 文字のケース差で破れる**という実装の穴で、
`new URL(...).origin` 比較への置き換え（ガードと `listCachedUrls` の除外を同じ述語に揃える）で
根治でき、これが唯一のコード起因の実害である。残る CORE-002 / 003 / 004 は「記録ハッシュという
新しい安価な判定材料を、置ける場所すべてに置き切れていない」という同根の設計の詰め残りで、
いずれも挙動は正しく（誤配は起きない）、コストと JSDoc の正確さの問題に留まる — 逆に言えば
0.5.0 のリリースブロッカーは無い。CORE-002 と CORE-004 は数 GB 級という本ライブラリの主戦場で
効く指摘なので、実装するなら 0.5.0 と同時（記録ハッシュの意味論が固まる今）が最も安く、
by-design と裁定する場合は `docs/limitations.md` への明記が必要になる。
