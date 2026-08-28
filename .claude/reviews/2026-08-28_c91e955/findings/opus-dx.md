# レビュー: 利用者エルゴノミクス（DX）— opus-dx

対象 HEAD: c91e955 (v0.5.0)。一次資料: README.md / src/mod.ts / src/hf/mod.ts /
src/core.ts（公開シンボルの挙動確認用）/ docs/limitations.md / docs/decisions/0006〜0008。
立場: 0.5.0 を初めて導入する外部開発者。`src/core.ts` は `deno.json` の `exports` に無いので
import 不能 = 見えない前提で読んだ（`fetchBytesWithKey` 等は利用者の道具に数えていない）。

先に結論だけ: 「sha256 を宣言できるファイル」の導線は README どおりに書けて詰まらない。
詰まるのは **sha256 を宣言できないファイル（config.json 等）** の系統で、キャッシュの
掃除・強制再検証・オフラインの 3 つが README の説明と食い違うか、導線が無い。

---

## 指摘

### [severity: error] README.md:283-284, 346-348 / src/core.ts:1084-1114 — `evict` プレフィックスは sha256 なし HF エントリに一切当たらないのに「repo を丸ごと解放できる」と書いてある

**機序**
`contentKey`（src/hf/mod.ts:199-202）は `spec.sha256 === undefined` なら `undefined` を返し、
`fetchResolvedFile` はそのまま URL キー（実 URL `https://huggingface.co/owner/name/resolve/{sha}/config.json`）で
格納する。一方 `evict` / `listKeys` は `serializePrefix` が返す `https://fetch-cache.invalid/v1/...`
前方一致でしか当たらない（src/core.ts:1079-1087）。実 URL のエントリは**構造上一致しない**。
README:283-284 は「no `sha256` → …（one entry per revision; old ones are cleaned up by prefix or
`evictUrl`）」と書いており、前半の "by prefix" は成立しない。README:346-348 の
「Free a repo with `evict(["hf","model","owner/name"])`」「inspect what is stored with
`listKeys(["hf"])`」も、sha256 なしファイルには当たらない・映らない。

**実害（ユースケース③ でそのまま踏んだ）**
「特定 repo のキャッシュを全部消してディスクを空ける」を README どおりに書くとこうなる:

```typescript
const freed = await evict(["hf", "model", "owner/name"]); // 例: 3
```

戻り値は「消えた件数」なので、`config.json` / `tokenizer.json` 等が残っていても
呼び出し側からは成功にしか見えない。しかも残ったエントリは URL キーなので、消すには
**その時点で解決済みだったコミット SHA を含む resolve URL** が要る。ブランチが動いた後は
`resolveHfRevision` が別の SHA を返すため、その URL はもう再構成できない = 孤児エントリが
`clearCache()`（全消し）以外では消せなくなる。数百 MB 級の tokenizer/onnx を sha256 無しで
取る利用者は、repo 単位の解放をしているつもりでディスクが減らない。

**利用者の誤読シナリオ**
README の Cache management 節（README:230-240）は「URL-keyed entries = everything fetched
without a sha256-keyed HF spec」と正しく書いてあるのに、HF 節（README:283-284, 346）が
「prefix で掃除できる」と上書きしてしまう。HF 節だけ読んだ利用者は
`evict(["hf", kind, repo])` を repo 単位 GC の完全な導線だと理解する。

**修正案**（コード変更なしで閉じる案を優先）
1. README:283-284 の "cleaned up by prefix or `evictUrl`" から "by prefix" を落とし、
   「sha256 なしのエントリは配列キー空間に居ないので `evict` / `listKeys` の対象外。
   掃除は `listCachedUrls()` を repo URL で絞って `evictUrl`」と明記する。
2. その掃除レシピを README に 3 行で載せる（`hfResolveUrl` / `listCachedUrls` が既に公開
   されているので新 API は不要）:
   ```typescript
   const prefix = `https://huggingface.co/owner/name/resolve/`;
   for (const url of await listCachedUrls()) {
     if (url.startsWith(prefix)) await evictUrl(url);
   }
   ```
3. docs/limitations.md の「HF 層」に by-design として 1 項追加（現状 0006/0008 にも
   この掃除の穴は書かれていない）。

（憶測の切り分け: 「repo 単位 GC の API を足すべき」とまでは言っていない。実害は
**README が実際より広い保証を書いていること**で、文書修正で消せる。）

---

### [severity: warning] src/hf/mod.ts:260-264, 325-328 — 全部キャッシュ済みでも可変 ref なら毎回 revision 解決の network に出る（オフラインで落ちる）ことが README に書かれていない

**機序**
`fetchHfFile` / `fetchHfFiles` / `prefetchHfFile` は入口で必ず `resolveHfRevision` を
await する。`isCommitSha`（40 桁 hex）でなければ `{hubUrl}/api/.../revision/main` へ実 fetch
する（src/hf/mod.ts:118-143）。内容キー（sha256 あり）ならキャッシュヒット自体は revision 非
依存で成立するのに、**その手前の解決リクエストが失敗すると全体が throw する**。

**実害（ユースケース① の 2 回目起動）**
README:307-330 のとおり書いた prefetch → 読み出しのアプリを、機内モード / hub 障害 /
社内 proxy 断で再起動すると:

```typescript
const files = await fetchHfFiles({ repo: "owner/name" }, { model: SPEC }); // ← ここで throw
```
数 GB のモデルが完全にキャッシュに載っているのに `fetch failed` で起動できない。回避策は
「起動時に使う revision を解決済み SHA として自前で永続化し、`revision` に渡す」だが、
README にはその必要性がどこにも書かれていない（README:314-317 は「解決を 1 回に減らす」
性能の話としてしか読めない）。

**利用者の誤読シナリオ**
Features の "URL as the key: just call `fetchBytes(url)` to cache and reuse" と
Runtime support の「Caching is an optimization」から、「キャッシュが温まっていれば network
不要」と理解する。HF 層だけこの前提が崩れる。

**修正案**
README の HF 節「A few things worth knowing」に 1 項追加:
「可変 ref（`main` 等）を渡すと、キャッシュが完全に温まっていても revision 解決の
リクエストが 1 回走る。オフライン起動を成立させたいなら `resolveHfRevision` の結果 SHA を
アプリ側で永続化して `revision` に渡す（`isCommitSha` で判定できる）」。
`prefetchHfFile` の戻り値 `revision` がまさにその値なので、README:338-343 の説明と繋げると
自然（現状 `revision` の説明は「sha256 が無いときにキーが孤児にならないため」の文脈しか無い）。

---

### [severity: warning] src/hf/mod.ts:217 / README.md:344-345 — `recheck: true` が sha256 なしファイルでは無言の no-op（cache 層は同じ指定を throw する）

**機序**
cache 層は `sha256` 無しの `recheck` を fail loud で弾く（src/core.ts:713-717
「recheck は sha256 とセットでのみ指定できます」）。HF 層は
`recheck: spec.sha256 === undefined ? undefined : opts.recheck`（src/hf/mod.ts:217）で
**黙って落とす**。同じ名前のオプションが、層をまたぐと throw から無言 no-op に変わる。

**実害（ユースケース④）**
「キャッシュが壊れているかも」で README:344-345（"Suspicious about a cached file?
`{ recheck: true }` … no manual eviction needed"）に従って書くと:

```typescript
const cfg = await fetchHfFile({ repo }, "config.json", { recheck: true }); // 何も起きない
```
壊れたキャッシュがそのまま返る。利用者は「再検証した」と信じたまま壊れたバイトを使う。
sha256 なしファイルに対する強制再取得の導線は現状 `evictUrl(hfResolveUrl({...ref, revision, path}))`
しか無く、README にはそのレシピが無い（かつ revision の解決が要る = 指摘②と絡む）。

**利用者の誤読シナリオ**
README:344 の "declared files"（= sha256 宣言済み）という限定語は、日本語話者に限らず
読み飛ばされやすい位置にある。直前の文が「Suspicious about a cached file?」と一般化して
いるため、「全ファイルに効く安全弁」と読む。

**修正案**（どちらか。①のほうがプロジェクトの Fail loudly 規約に沿う）
1. `fetchHfFile`（単一ファイル入口）で `opts.recheck === true` かつ `spec.sha256 === undefined`
   なら throw する。`fetchHfFiles` は混在が正常なので現状維持（この非対称は JSDoc に書く）。
2. 最低でも README:344 を「`sha256` を宣言したファイルにだけ効く。宣言の無いファイルを
   疑うときは `evictUrl(hfResolveUrl({ ...ref, revision, path }))` で落とす」に書き換え、
   docs/limitations.md へ by-design として記録する。

---

### [severity: warning] src/hf/mod.ts:43, 174-188 vs src/core.ts:110-122 / README.md:189-192 vs 286 — `expectedBytes` が層ごとに逆の契約（ヒント / 厳密検査）で、HF 側で外すと毎回フル再ダウンロードする

**機序**
- cache 層 `FetchBytesOptions.expectedBytes`: **確保ヒントのみ・検証には使わない**。
  README:189-192 は明示的に "A wrong hint costs nothing"。
- HF 層 `HfFileSpec.expectedBytes`: `buildValidate` で `validate` に合成され、
  `bytes.length !== spec.expectedBytes` で throw（src/hf/mod.ts:179-185）。README:286 は
  "(exact length check)"。

同名・同じ型・同じ「ファイル指定に添える数値」なのに、片方は外れても無害、片方は
致命的エラー。しかも HF 側は `validate` 経由なので**キャッシュヒット側にも効く**。

**実害（ユースケース① の値をうろ覚えで入れた場合）**
`expectedBytes` が 1 バイトでも違うと、`fetchHfFile` は
ヒット → validate throw → evict（self-heal）→ network 再取得 → 再び validate throw、
となり、**呼び出しの度に数 GB を落として捨てる**。sha256 は一致しているのでエラーメッセージは
「バイト数不一致」だけで、なぜ再ダウンロードが走るのかは利用者からは見えない。
cache 層の README を先に読んだ利用者は「ヒントだから概算で良い」と学習した直後に
HF 層で同じ名前に概算を渡す。

**利用者の誤読シナリオ**
README を上から読むと Large assets 節（:189）で「A wrong hint costs nothing — the download
simply falls back to the chunked path.」を先に学ぶ。HF 節（:286）の "(exact length check)" は
括弧内の 3 語で、直前の学習を上書きするには弱い。

**修正案**
コード側の改名は breaking なので取らない前提で、README:286 を独立した警告文へ格上げする:
「HF 層の `expectedBytes` は cache 層の同名オプションと違い**厳密検査**で、値が違うと
キャッシュヒットが破損扱いになり毎回フル再取得になる。値に確信が無いなら省略する」。
`HfFileSpec.expectedBytes` の JSDoc（src/hf/mod.ts:43）にも「cache 層の
`FetchBytesOptions.expectedBytes` はヒントだが、こちらは検査である」を 1 行足す。

---

### [severity: warning] README.md:307-330 — README 自身の prefetch サンプルが、prefetch では使われない `expectedBytes` / `validate` 入りの spec を渡している

**機序**
`prefetchHfFile` が spec から見るのは `sha256` だけ（src/hf/mod.ts:331-339 で
`prefetchUrlWithKey` に渡すのは `sha256` / `onProgress` / `init` / `fetch` / `caches` のみ）。
JSDoc（src/hf/mod.ts:307-309）と docs/limitations.md:49-52 には明記があるが、
**README には一言も無い**。そして README:318 のサンプルは
`for (const spec of MODEL_FILES) { // [{ path, sha256, expectedBytes }, …]` と、
まさに無視される `expectedBytes` を含む spec をループで渡している。

**実害**
「prefetch の時点で長さも検証されている」と誤解した利用者は、`sha256` を省いた spec で
prefetch し（sha256 は LFS メタデータからしか取れないので省く動機は現実的にある）、
`expectedBytes` があるから安全だと信じる。実際には**無検証バイトがキャッシュに載る**
（limitations.md:45）。壊れていることに気付くのは `fetchHfFile` で読む時 = 起動時で、
そこから数 GB の再取得が走る。

**利用者の誤読シナリオ**
README は spec 型を「fetch と prefetch で共通の HfFileSpec」として提示しているため、
「spec のフィールドは両方の入口で同じ意味を持つ」と読むのが自然。実際は prefetch 側だけ
部分無視という非対称がある。

**修正案**
README:331-334 付近（"There is no multi-file prefetch on purpose" の隣）に 1 行:
「`prefetchHfFile` が spec から見るのは `sha256` だけ。`expectedBytes` / `validate` は
渡しても prefetch では使われず、`fetchHfFile` で読み出すときに効く」。
サンプルのコメントも `// [{ path, sha256 }, …]` に寄せるか、`expectedBytes` を残すなら
「読み出し側で効く」と注記する。

---

### [severity: low] README.md 全体 — `hfResolveUrl` / `isCommitSha` が公開されているのに README に一度も出てこない（かつ、それらが解く問題は README に「未解決のまま」残っている）

**機序**
`./hf` の公開シンボルは `fetchHfFile` / `fetchHfFiles` / `prefetchHfFile` /
`resolveHfRevision` / `hfResolveUrl` / `isCommitSha` + 型。README が触れるのは前 4 つだけ。

**実害**
指摘①（sha256 なしエントリの掃除）と指摘③（sha256 なしファイルの強制再取得）は、どちらも
`hfResolveUrl` でキー URL を組み立てて `evictUrl` に渡せば解ける。`isCommitSha` は指摘②の
「revision が固定されているか」の判定にそのまま使える。**道具はあるのに README に導線が無い**
ため、利用者は JSR の型ページを漁って初めて見つける（あるいは見つけずに `clearCache()` で
全消しする）。

**修正案**
README の「A few things worth knowing」に 2 行足して、①③のレシピの中で自然に登場させる。
新 API は不要。

---

### [severity: low] README.md:386-395 — Runtime support 表と縮退リストが `prefetchUrl` / `prefetchHfFile` の fail loud を落としている

**機序**
README:392-395 は「On runtimes without `caches`, `fetchBytes` falls back to a plain fetch …
`evictUrl` / `evict` / `clearCache` return false / 0, `listCachedUrls` / `listKeys` return `[]`」
と縮退の全体像を列挙するが、prefetch 系だけ**列挙から漏れている**。実際は
`caches` 不在で throw する（src/core.ts:870-875）。README:182-184 に別途書いてはあるが、
Node.js 対応可否を確認する読者が最後に見るのはこの表と段落。

**実害**
Node.js（`caches` 無し）でも動く前提で prefetch を起動シーケンスに組み込み、
初回実行で例外。README:184 の "Fall back to `fetchBytes` when it throws" に従うと、
今度は数 GB がヒープに載る（prefetch を使っていた理由がそれの回避なので、フォールバックが
成立しないケースがある）。

**修正案**
Runtime support の表 or 直後の段落に「`prefetchUrl` / `prefetchHfFile` は `caches` が
無いランタイムでは縮退せず throw する（唯一の非縮退 API）」を追記する。

---

### [severity: low] src/hf/mod.ts:18-26 — `./hf` エントリが、自分の公開シグネチャに現れる型（`FetchProgress` / `CacheErrorContext` / `ValidateBytes` / `DecodeBytes`）を再公開していない

**機序**
`HfFetchOptions.onProgress` は `FetchProgress & { path: string }`、`onCacheError` は
`CacheErrorContext`、`HfFileSpec.validate` / `.decode` は `ValidateBytes` / `DecodeBytes` を
使うが、これらは `../core.ts` から `import type` されるだけで re-export されない。
利用者は `.` エントリ（src/mod.ts:41-50）から取る必要がある。

**実害**
HF 層だけを使うアプリでハンドラに明示型を付けようとすると、import 元が 2 つに割れる:

```typescript
import { fetchHfFiles } from "@hdae/fetch-cache/hf";
import type { FetchProgress } from "@hdae/fetch-cache"; // ← ここだけ別エントリ
const onProgress = (p: FetchProgress & { path: string }) => { /* … */ };
```
詰まりはしないが、`/hf` から取れないことに気付くまで型エラーと往復する。

**修正案**
`src/hf/mod.ts` で `export type { CacheErrorContext, DecodeBytes, FetchProgress, ValidateBytes };`
を足す（非破壊追加）。あるいは README の HF 節に「型は `.` エントリから」と 1 行。

---

## 問題なし（見て問題が無かった重要ポイント）

- **README のサンプルの import はすべて実在する**: `fetchBytes` / `prefetchUrl` /
  `decodeGzip` / `clearCache` / `evict` / `evictUrl` / `listCachedUrls` / `listKeys`
  （src/mod.ts:31-40）、`fetchHfFile` / `fetchHfFiles` / `prefetchHfFile` /
  `resolveHfRevision`（src/hf/mod.ts）。書き写してそのまま型が通る。
- **ユースケース①（sha256 宣言済み・複数ファイルの prefetch → 読み出し）と
  ⑤（versioned CDN URL + sha256）は README どおりに書けて詰まらない。** 特に
  「prefetch で記録ハッシュを焼く → 起動時のヒットは文字列比較」という本命の価値が、
  README:154-174 と JSDoc（src/hf/mod.ts:303-306）で同じ言葉で説明されていて食い違わない。
- **`recheck` の既定反転（0.4.0 → 0.5.0）が Migrating 節（README:361-382）で明示されている。**
  「default is reversed」という強い言い方で、旧 `x-fetch-cache-verified` エントリの扱い
  （記録なし → 初回読み出しで再ハッシュ + backfill）まで書かれており、
  src/core.ts:566-579 の実装と一致する。
- **`decode` の契約（保存形 raw をキャッシュ・戻り値だけ decode・throw は破損扱い・入力非破壊
  MUST）が README:118-150 / core.ts:96-109 / hf/mod.ts:62-67 の三者で一致。**
  「validate は decode の前・raw に対して走る」という順序も 3 箇所で同じ。
- **`sha256` の形式検査が network に出る前** に効く（src/core.ts:702-707、
  src/hf/mod.ts:239-247、`fetchHfFiles` は全 spec を解決 API の前に検査
  src/hf/mod.ts:354-355）。64 桁 hex を間違えて数 GB 落としてから落ちる、が起きない。
- **`prefetchHfFile` の戻り値 `HfPrefetchResult`（fetched / revision / url）の説明が
  README:338-343 と JSDoc で一致**し、`fetched: false` でも `revision` / `url` が必ず返る
  ことまで書いてある（src/hf/mod.ts:300-302）。
- **管理 API 5 本すべてに `caches` DI がある**（`CacheAdminOptions`）ので、テストで DI した
  CacheStorage の中身を列挙・削除できる。DI したら管理 API にも同じものを渡す必要がある、と
  JSDoc に明記されている（src/core.ts:1018-1026）。
- **`clearCache` / `evictUrl` / `evict` / `listKeys` が名前空間を副作用で作らない**
  （`cacheStorage.has` を先に見る — src/core.ts:1041, 1105, 1128, 1160）。
  「消すつもりで呼んだら空の名前空間ができた」が起きない。

---

## 総評（リリース可否の観点）

sha256 を宣言できる系統（LFS メタデータのあるモデルファイル、versioned CDN アセット）の DX は
0.5.0 で明確に良くなっており、README も実装と食い違わない。ブロッカーは無い。

ただし **sha256 を宣言できない系統の説明が実装より広い保証を書いている** のが 1 点あり
（指摘①: `evict(["hf", kind, repo])` は URL キーのエントリに当たらないのに「repo を丸ごと
解放できる」と読める）、これは「消えていないのに成功が返る」= 利用者が検知できない齟齬なので、
文書修正なしでの publish は勧めない。修正はすべて README + docs/limitations.md で閉じ、
コード変更を要さない（指摘③ の案 1 を採るなら HF 層に 1 ガード追加）。

推奨: 指摘①②③④⑤ を README / limitations への追記で潰してから publish。①④は
「読者が実際より安全だと信じる」タイプなので優先度が高い。⑥⑦⑧ は次リリースでよい。
なお本レビューは公開エントリ（`.` と `./hf`）のみを一次資料とし、テストは実行していない。
