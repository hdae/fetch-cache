# レンズ: 潜在的な問題 — ffc8bef..HEAD の新規変更の敵対的検証

- 対象: HEAD = c91e955（v0.5.0・未 publish）。`git diff ffc8bef..HEAD -- src/` の 12 コミット。
- 読んだ一次資料: `src/core.ts`（全文）/ `src/mod.ts` / `src/hf/mod.ts` /
  `git show ffc8bef:src/mod.ts`（差分の突き合わせ元）/ `git show f2fd9c8:src/mod.ts`（0.4.0 実装）/
  `docs/decisions/0008` / `docs/limitations.md` / `README.md`（Migrating from 0.4.0）/
  `src/mod.test.ts` の該当テスト / `deno.json`。
- 実行はしていない（読み取り専用）。テスト結果は既存の緑を前提にしていない — 以下の指摘は
  「テストは緑だが利用者が踏む」ものを狙って選んである。

---

## 1) 指摘

### [severity: error] src/core.ts:894 — prefetch の「削除してから取り直す」は、取得失敗時に既存エントリを丸ごと失わせる

**機序**

`prefetchUrlWithKey` の既存エントリ検査（0008 §3 で新設）:

```ts
const existing = await cache.match(storageKey);
if (existing !== undefined) {
  await existing.body?.cancel().catch(() => {});
  if (expectedSha256 === undefined ||
      existing.headers.get(SHA_HEADER) === expectedSha256) {
    return false;
  }
  await cache.delete(storageKey);   // ← core.ts:894
}
// ここから network（fetch → put）
```

`cache.delete` が **network に出る前** に走る。以後の `fetchImpl` / `response.ok` /
`cache.put` のどれが落ちても、この関数は throw して抜けるだけで、**削除したエントリは復元
されない**。

一方 `cache.put(request, response)` は同一キーの既存エントリを**置換**する（Cache API の
規定）。したがってこの `delete` は「温め直し」の成立に一切必要ない — 成功時は put が上書き
し、失敗時は delete しなければ旧エントリが残る。純粋に失敗窓を作っているだけ。

**利用者への実害（どう踏むか）**

limitations.md:41-58 が推奨している「無検証で温める → 後から検証付きで固める」フロー、および
0.4.0 で `prefetchUrl(url)`（記録ヘッダなし）で温めたエントリを 0.5.0 で固め直すフローが
そのまま該当する。再現:

```ts
// 1) 3GB のモデルを無検証で温めてある（記録なしエントリ。0.4.0 由来でも同じ）
await prefetchUrl(MODEL_URL);

// 2) アプリ起動時に「記録を焼いておく」つもりで検証付き prefetch
//    → 記録が無いので既存エントリを delete → その直後に回線が落ちる / Hub が 503
await prefetchUrl(MODEL_URL, { sha256: MODEL_SHA });   // throw

// 3) fallback として README どおり fetchBytes へ逃げる
await fetchBytes(MODEL_URL, { sha256: MODEL_SHA });    // cache は空 → 3GB 再取得、オフラインなら失敗
```

`delete` が無ければ 2) の失敗後も旧エントリは残り、3) の `fetchBytes` が実ハッシュで突合して
一致 → backfill（core.ts:571）で記録が焼かれ、**network に出ずに** 目的が達成される。つまり
現状の delete は「本来は成功していたはずの縮退経路」を自分で潰している。オフライン起動を
前提にした下流（yomi / sbv2-web）ではアプリが起動不能になる。

なお `prefetchHfFile` 経由の HF エントリでは 0.4.0 の名前空間が別（`fetch-cache-hf`）なので
移行時にこの経路は踏まないが、**URL キーの `prefetchUrl` 直利用と、0.5.0 内での
無検証 prefetch → 検証付き prefetch は素で踏む**。

**修正案**

`core.ts:893-894` の 2 行を削除する（put の置換に委ねる）。保険 delete（core.ts:987）との
整合も崩れない:

- put 成功（正常）: 旧エントリは put が置換済み。
- put reject（stream error = ハッシュ不一致 / 転送中断 / quota）: catch 節は `integrityError`
  をそのまま throw するだけで delete しない → 旧エントリが残る。**これは望ましい**（失敗した
  温め直しで既存資産を失わない）。
- 非準拠 Cache が stream error を無視して put を成立させた場合: 保険 delete が消すのは
  「put が置き換えた後の不正エントリ」で、現状と同じ。

既存テスト（mod.test.ts:2068 / 2099 / 1913 / 1968）はいずれも「delete と put のどちらで
置き換わったか」ではなく最終状態を見ているので、この修正で緑のまま通るはず（未実行・要確認）。
ADR 0008 §3 の「記録 ≠ 期待なら削除して温め直し」という文言も、実装意図は「温め直す」であって
「先に消す」ではないと読めるため、ADR 本文の変更までは要らないと考える（この点は解釈なので
オーナー判断）。

---

### [severity: warning] src/core.ts:566-579 — backfill でヒット経路が writer になり、並行 evict / prefetch の結果を静かに巻き戻す

**機序**

0008 §2 で `fetchBytes` のキャッシュヒット経路が `cache.put` を行うようになった（記録なし
エントリの記録焼き直し）。この put は

- `evict` / `evictUrl` / `clearCache`（single-flight にも cache 操作にも参加しない管理 API）
- `prefetchUrl`（limitations.md:59-62 のとおり明示的に single-flight 対象外）

のいずれとも相互排他ではない。かつ backfill の対象は**記録なしの巨大エントリ**なので、
`checkAndDecode` の全量ハッシュ（数 GB で秒〜十数秒）を挟んだ **長い TOCTOU 窓**を持つ。

**利用者への実害（どう踏むか）**

(a) 手動の空き容量確保が黙って取り消される:

```ts
const p = fetchBytes(MODEL_URL, { sha256: MODEL_SHA }); // 記録なし 3GB をヒット → ハッシュ中
await clearCache();          // ユーザーが「キャッシュを削除」を押す（別の非同期処理）
await p;                     // ← ここで backfill put が 3GB を書き戻す
await listCachedUrls();      // 消したはずのエントリが復活している
```

`evict(["hf", ...])` / `evictUrl(url)` でも同型。UI に「キャッシュを削除」を持つ下流
（sbv2-web 系）で、削除直後に容量が戻らない・戻ったり戻らなかったりする、という
再現性の低い挙動になる。

(b) 並行 prefetch の成果が捨てられる:

```ts
// 記録なしエントリ（バイト列 A）が既にある
const r = fetchBytes(URL, { sha256: SHA_A });        // ヒット → A をハッシュ中
await prefetchUrl(URL, { sha256: SHA_B });           // 既存を消し、B を DL して記録 B で格納 → true
await r;                                              // backfill put が A + 記録 A で上書き
await fetchBytes(URL, { sha256: SHA_B });            // 記録 A ≠ B → evict → B を再ダウンロード
```

prefetch は `true`（温めた）を返したのに成果が消え、次の読み出しで丸ごと再取得になる。

**不変条件そのものは破れていない**（重要）: backfill の分岐条件は `recorded === null` で、
このとき core.ts:563-564 の `trusted` は必ず `false` になるため `checkAndDecode` は実ハッシュを
計算済み。したがって「記録は検証済みバイトにしか付かない」は保たれ、上書き後のエントリも
（バイト列 A・記録 A で）自己整合している。失うのは**新しさ**であって**正しさ**ではない。
レンズが疑っていた「記録付き不正エントリ」の生成手順は、私の検証では見つからなかった。

**修正案**（軽い順）

1. 最小: `docs/limitations.md` に「`sha256` 指定 × 記録なしエントリのヒットは書き込みを伴う
   （backfill）。並行する `evict` / `clearCache` / `prefetchUrl` に対して last-writer-wins で、
   削除が巻き戻る場合がある」を明記する。ADR 0008 Consequences には書かれているが
   limitations.md には 1 行も無く、「意図的な制約」の索引としては欠落している。
2. 窓を詰める: backfill 直前に `await cache.match(storageKey)` を取り直し、
   `undefined`（= 消された）または記録が既に付いている場合は put をスキップする。TOCTOU は
   残るが、ハッシュ計算ぶんの長い窓は畳める。コストは match 1 回（Deno/ブラウザとも
   body を読まなければ安い）。
3. backfill を「今このプロセスが network から取ってきた場合」に限定する案もあるが、それでは
   0008 §2 の目的（旧エントリの毎ヒット全量ハッシュの解消）を果たさないので却下を推す。

推奨は 1 + 2。

---

### [severity: low] src/core.ts:241-246 — ブラウザで `<base href>` を持つ文書だと相対 URL の解決先が fetch と食い違う

**機序**

`normalizeUrl` は相対 URL を `globalThis.location?.href` に対して解決する。一方、文書
コンテキストの `fetch()` は HTML 仕様上 **document base URL**（`<base href>` があればそれ）に
対して解決する。0.4.0 は生文字列をそのまま `fetch` へ渡していたため、この差は無かった。

**利用者への実害**

`<base href="/assets/">` を置いたページで `fetchBytes("model.bin")` を呼ぶと、0.4.0 は
`/assets/model.bin` を、0.5.0 は `/model.bin` を取りに行く（404 になるか、別物を掴む）。
`<base>` を使うページ + 相対 URL という組み合わせは狭く、README のサンプルも絶対 URL なので
実害は限定的。ただし「network へ渡る URL が正規化で変わる副作用」としては唯一見つかった実物。

**修正案**

`(globalThis as { document?: { baseURI?: string } }).document?.baseURI ?? location?.href` を
base に使う（Worker には `document` が無いので `location` へ落ちる）。あるいは相対 URL を
サポート対象外として fail loud にし、limitations.md に明記する（依存ゼロ規約とは無関係に
どちらも取れる）。憶測を排すため補足: 「fetch が baseURI を使う」は HTML/Fetch 仕様の記述に
基づく事実だが、私はブラウザで実測していない。

---

### [severity: low] src/core.ts:317-341 — `expectedBytes` 確保後に body === null 経路へ入ると RAM ピークが 2N になる

**機序**

`readBody` は `expectedBytes` 指定時に先に `buffer = new Uint8Array(expectedBytes)` を確保する。
その直後の `body === null` フォールバック（core.ts:335-341）は `buffer` を使わないが、
**`buffer` の参照はスコープに残ったまま** `await response.arrayBuffer()` を待つため、
3GB 申告なら 3GB + 3GB が同時にヒープへ載る。コメント（core.ts:336-337）は「参照を捨てるだけで
害はない」と書いているが、実際には捨てていない。

同様に、申告超過の蓄積フォールバック（core.ts:353）は `buffer.subarray(0, loaded)` を
chunks に積むので確保済み buffer 全体が生き残り、終端の連結と合わせて最大 3N になる。
申告不足時の `buffer.slice(0, loaded)`（core.ts:365）も一時的に 2N。

**利用者への実害**

`expectedBytes` は「ピークを 1N に抑える」ためのオプション（ADR 0007）なので、目的が
反転する経路がある。ただし body === null は `Response.body` を持たないランタイム限定で、
超過/不足経路も「申告が外れたとき」だけ。**この関数は ffc8bef から未変更で、今回の差分の
新規混入ではない**（0007 由来）。

**修正案**

`if (body === null) { buffer = undefined; ... }` の 1 行。超過経路は
`chunks.push(buffer.slice(0, loaded)); buffer = undefined;`（subarray → slice）で背面を切る。
どちらもスコープ外の既存挙動なので、今回のリリースに入れるかはオーナー判断。

---

### [severity: low] src/hf/mod.ts:18-26 — `./hf` エントリが cache 層の型を再公開しないため、利用者は型注釈を書くのに `.` エントリを併せて import する必要がある

**機序**

`HfFetchOptions.onProgress` は `FetchProgress & { path: string }`、`HfFileSpec.validate` は
`ValidateBytes`、`decode` は `DecodeBytes`、`onCacheError` は `CacheErrorContext` を使うが、
`src/hf/mod.ts` はこれらを `import type` するだけで re-export しない。`src/core.ts` は
`deno.json` の `exports` に無いので、`./hf` だけを import している利用者は
`@hdae/fetch-cache/hf` からこれらの型名に到達できない。

**利用者への実害**

`const onProgress = (p: ???) => {}` を外出しで書きたいとき、`@hdae/fetch-cache`（`.` エントリ）
からの追加 import が要る。同一パッケージなので**書けなくなってはいない**（推論に任せれば
そもそも不要）。0.4.0 も同じ構造だったので**今回の core.ts 分離による新規の劣化ではない** —
レンズの「型の再公開漏れ」に対する回答としては「漏れは無いが導線がやや遠い」。

**修正案**

`src/hf/mod.ts` の末尾に
`export type { CacheErrorContext, DecodeBytes, FetchProgress, ValidateBytes } from "../core.ts";`
を足す（非破壊追加）。やらなくてもリリースは可。

---

### [severity: low] src/mod.test.ts — 「prefetch が既存エントリ削除後に取得失敗する」ケースがテストで凍結されていない

指摘 1 の失敗窓は、既存テストのどれも観測していない（2068 / 2099 はいずれも fetch 成功系）。
指摘 1 を修正する場合は「記録の食い違う既存エントリがあり、network が 503 を返す →
`prefetchUrl` は throw するが**既存エントリは残っている**」を凍結するテストを同じコミットで
入れるべき。修正しない場合も、現状の破壊的挙動を意図として凍結するテストが要る（どちらの
判断であれ、契約が明文化されていない状態が一番まずい）。

---

## 2) 「問題なし」確認リスト

以下は疑って読んだが、この差分の範囲では破れなかった点。

- **記録ハッシュの不変条件（記録は検証済みバイトにしか付かない）**: backfill の分岐は
  `recorded === null`（core.ts:566）で、その条件下では `trusted`（core.ts:563-564）が必ず
  `false` になるため `checkAndDecode` が実ハッシュを計算・突合した後にしか put されない。
  network 経路（core.ts:611-618）も `checkAndDecode` 成功後にのみ put。prefetch は
  記録を Response 構築時に焼き、不一致は stream error → put reject（+ 保険 delete）。
  「記録付きの不正エントリ」を正規経路から作る手順は見つからなかった。
- **URL 正規化と 0.4.0 既存エントリのキー互換**: 0.4.0 は生文字列を `cache.match/put` に
  渡していたが、Cache API 側が Request 構築時に同じ URL パーサで正規化するため、
  **格納済みキーは既に正規化形**。0.5.0 が `parsed.href` で引くのは同じ形に落ちるので、
  大文字 scheme/host・既定 port・fragment のいずれでも移行ミスは発生しない（fragment は
  Request 構築時に剥がれるので二重に一致）。IDN も同じ理由で一致する。
- **予約 origin ガードの origin 等価比較**: `https://FETCH-CACHE.INVALID/…` や
  `https://fetch-cache.invalid:443/…` は `URL.origin` が KEY_ORIGIN に畳まれて弾かれ、
  `https://fetch-cache.invalid.example/…` は別 origin として通る（0.4.0 の前方一致は
  後者を過剰拒否していた）。`listCachedUrls` の除外述語も同じ判定で揃っている。
- **配列キー直列化の単射性 × URL パーサ正規化**: 各要素は `JSON.stringify` されてから
  `encodeURIComponent` されるため、文字列は必ず `%22…%22` で囲まれ、数値は `1`、真偽値は
  `true`。したがって**どのセグメントも `.` / `..` / `%2e%2e`（URL 仕様の dot-segment）には
  なりえず**、パス圧縮で潰れる経路が無い。`/` を含む文字列は `%2F` になり URL パーサは
  これを復号しないので、`["a","b/c"]` と `["a/b","c"]` は別キーのまま。空要素も生じない。
- **`deserializeKey` の型検査追加**: `serializeKey` が通す値（有限数値・文字列・真偽値）は
  すべて round-trip する（`1e300` などの巨大有限値も finite のまま復元）。`serializeKey` が
  弾く NaN / Infinity は `deserializeKey` 側も弾くので、`listKeys` の fail loud 契約
  （外部直書きの検出）に穴は無い。
- **single-flight の TOCTOU**: `acquireAndDecode(...).finally(() => inflight.delete(...))` の
  finally コールバックはマイクロタスクなので、同期実行中の `inflight.set`（core.ts:768）が
  必ず先に走る。leader 決定から `set` までに `await` は挟まっていない。
- **進捗 snapshot 化（a58c79e）**: `emit` は `state.last = progress` を代入してから
  `[...listeners]` のコピーを反復する。リスナー内から同一キーへ合流した新リスナーは
  スナップショットに含まれず、合流時の即時リプレイ（core.ts:741）で
  **ちょうど 1 回**だけ通知される。二重通知も取りこぼしも無い。
- **公開境界（core.ts の内部性）**: `deno.json` の `exports` は `.` と `./hf` の 2 つだけで
  `./src/core.ts` は無く、`fetchBytesWithKey` / `prefetchUrlWithKey` は `src/mod.ts` からも
  `src/hf/mod.ts` からも re-export されていない。`publish.include` は `src/**/*.ts` なので
  core.ts はパッケージに同梱されるが（型解決に必要）、exports マップ経由では到達不能。
  `src/testing/**` は publish から除外され、`src/mod.ts` / `src/hf/mod.ts` からの import も
  無い（`src/mod.test.ts` のみ）。
- **管理 API の `caches` DI（6fd8f64）**: `evict` / `listKeys` / `evictUrl` /
  `listCachedUrls` は 4 本とも `has()` → 早期 return → `open()` の順で、DI 有無に関わらず
  「無い名前空間を open が永続作成する」副作用を避けている。`clearCache` だけ `has` を
  経ないが `CacheStorage.delete` は非存在で false を返すので副作用は無い。`opts.caches ??
  globalCaches()` の解決も 5 本 + fetchBytes + prefetchUrl で完全に一致している。
- **HF `toSpec` の前倒し（4f86b9f）**: `fetchHfFile` / `prefetchHfFile` / `fetchHfFiles` の
  3 入口すべてで `resolveHfRevision`（network）より前に呼ばれている。`fetchHfFiles` は
  `names` と `specs` を同一の `map` 順で作り `specs[index]` で引くので対応がずれない。
- **`AggregateError`（85c3fad）**: `new AggregateError(errors, message)` の引数順は正しく、
  ES2021 なので Deno / 対象ブラウザで利用可能。保険 delete 成功時は従来どおり
  `integrityError` 単体が飛ぶので、正常系のエラー型は変わらない。
- **記録不一致 short-circuit**: `staleRecord` 判定は `opts.sha256 !== undefined &&
  recorded !== null && recorded !== opts.sha256` に限定され、`sha256` 未指定・記録なしの
  従来経路には影響しない。`cached.body?.cancel()` は body が null でも安全（optional chain が
  `.catch` ごと短絡し `await undefined` になる）。旧挙動（実バイト再ハッシュで採用）に依存する
  正当なユースケースは、HF 層では sha256 がキーに入るため構造的に存在せず、URL キーでも
  「記録 ≠ 期待 = 内容が変わった」以外の解釈が成り立たない。帯域が跳ねるのは
  「同一 URL に複数の期待 sha256 が交互に来る」場合だけで、それは 0008 が意図的に
  表現不能化した誤用クラスの残滓（URL キー側）にすぎない。

---

## 3) 総評（リリース可否）

コア不変条件（記録は検証済みバイトにしか付かない / キー直列化の単射性 / single-flight の
TOCTOU / 予約 origin ガード）は敵対的に読んでも破れず、今回の 12 コミットは全体として
0006 実装の穴を正しく塞いでいる。URL 正規化と進捗 snapshot 化は素直な正当性修正で、
副作用も `<base>` 相対解決という極小の一点しか見つからなかった。

ブロッカーは指摘 1 の 1 件だけ。`prefetchUrl` の「delete してから取り直す」は put の置換
セマンティクスがあるので**不要な 2 行**であり、その 2 行のためにオフライン時にキャッシュ済み
資産を丸ごと失う経路が新設されている。下流（yomi / sbv2-web）はまさにオフライン起動と
巨大モデルの温めが主用途なので、publish 前に落としておくべきと考える。修正は 2 行削除 +
凍結テスト 1 本で済み、既存テストへの影響も無いはず。

指摘 2（backfill の TOCTOU）は正しさではなく新しさの問題で、リリースを止める性質ではないが、
「ヒット経路が writer になった」ことが limitations.md に一行も無いのは索引として欠落なので、
docs だけでも同時に入れるのを推す。残りの low 3 件は 0.6.0 以降で構わない。

指摘 1 を直せば publish 可、というのが私の判断。
