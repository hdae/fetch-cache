# hf-api — HF 層（src/hf/mod.ts）+ 公開 API 面レビュー（HF-）

対象: `git diff v0.4.0..HEAD`（ffc8bef「キャッシュ制御 API を再設計」）のうち `src/hf/mod.ts` と
公開 API 面（`deno.json` exports / `src/mod.ts` の export 群）。読み取り専用レビュー（コード変更なし）。
基準文書: CLAUDE.md、docs/decisions/0006（§4 HF 既定キー・§5 キー粒度ポリシー）、0007。

スコープ外（依頼どおり）: README.md / docs/limitations.md の未コミット変更と docs 全面書き換え、
`.claude/reviews/2026-08-25_6a00aa1/` の既存台帳、`src/mod.ts` の内部実装深掘りとテスト
（境界所見は主担当を明記して記載）。

凡例: 🟢 良い点 / 🔵 情報・軽微 / 🟡 要対応（軽） / 🟠 要対応（重） / 🔴 設計原則違反。

検証環境: deno 2.9.4。`deno check .` 緑（exit 0）。`deno doc --lint src/mod.ts src/hf/mod.ts` は
missing-jsdoc 7 件のみ（HF-09）。旧 API 残骸の機械確認は `rg` で実施（HF-14）。

---

## HF-01 🟡 `prefetchHfFile` の「温めたエントリはそのままヒットになる」保証が sha256 無し spec で成立しない

### 概要（挙動・実害・発生条件）

新しい JSDoc は「キャッシュキーの既定も `fetchHfFile` と同じ式（`sha256` があれば内容キー、無ければ
resolve URL）なので、**温めたエントリはそのまま `fetchHfFile` のヒットになる**」と無条件に述べる
（src/hf/mod.ts:299-301）。この保証が本当に構造的なのは `spec.sha256` がある場合だけである。

`sha256` が無い spec では既定キーが SHA 固定 resolve URL なので、次の並びで温めが丸ごと無駄になる:

1. `prefetchHfFile({ repo, revision: "main" }, "model.bin")` → main が SHA1 に解決 → SHA1 の
   resolve URL をキーに数 GB を格納。
2. upstream が SHA2 へ動く（README 更新だけでも動く。これが ADR 0006 Context の出発点）。
3. `fetchHfFile({ repo, revision: "main" }, "model.bin")` → SHA2 に解決 → キーが違うので **miss →
   全量再ダウンロード**。SHA1 のエントリは孤児として残る（寿命軸は ADR 0006 §3 でスコープ外、
   URL キーなので `evict` プレフィックスの射程外 — 掃除は `evictUrl` に当時の URL を渡すしかない。
   HF-03 と連鎖する）。

v0.4.0 の JSDoc にはこの穴への対処が明記されていた（`git show v0.4.0:src/hf/mod.ts`、当時の
本文「以後 `fetchHfFile` の `revision` にその SHA を渡せばキャッシュキーが一致し、温めと読み出しの
間に upstream が動いてもキャッシュミス（+ 孤児エントリ）にならない」）。ffc8bef はこの 2 行を削除
したが、`sha256` 無し経路の挙動は 1 ミリも変わっていない。同時に戻り値 `revision`（src/hf/mod.ts:290）
の存在理由の説明も失われ、「どの SHA を温めたか分かる」という事実だけが残って**その値を何に使うのか**
が書かれていない状態になっている。

### 修正案

`prefetchHfFile` の JSDoc に、削除された対処ガイダンスを `sha256` 無し条件付きで復活させる（実装変更
不要 / 1 段落）。例:

> `spec.sha256` があるときはキーが内容キーなので、温めと読み出しの間に upstream が動いてもヒットする。
> `sha256` が無いときのキーは SHA 固定 resolve URL なので、戻り値の `revision` を `fetchHfFile` の
> `revision` に渡すこと — 渡さないと温めと読み出しの間の revision bump がそのままミス（+ 孤児エントリ）
> になる。

併せて `HfPrefetchResult.revision`（src/hf/mod.ts:290）の JSDoc に「`sha256` 無し運用ではこの値を
読み出しへ渡すのが正しい使い方」と用途を書き戻す。

### 対象

- src/hf/mod.ts:296-322（`prefetchHfFile` JSDoc。断定は :299-301）
- src/hf/mod.ts:286-294（`HfPrefetchResult`）
- 対比: v0.4.0 の同 JSDoc（`git show v0.4.0:src/hf/mod.ts`）

### 根拠

- 実装: 既定キーは `spec.sha256 === undefined` のとき `undefined` を返す＝`prefetchUrl` /
  `fetchBytes` が `requestUrl` をキーにする（src/hf/mod.ts:208-212 / src/mod.ts:618-626 /
  src/mod.ts:781-783）。`url` は解決済み revision で組み立てられる（src/hf/mod.ts:333, 221）ので、
  revision が動けばキーが動く。
- ADR 0006 §4（docs/decisions/0006-cache-control-redesign.md:113-115）は sha256 無しの既定を
  「revision 毎にエントリが溜まる点は従来と同じ」と明言しており、**従来と同じ = 従来の注意も同じ**。
  注意書きだけが消えたのは記述漏れであって設計変更ではない。

---

## HF-02 🟡 `toSpec` の fail loud が revision 解決リクエストの後に走る（「network に出る前に throw」が不成立）

### 概要（挙動・実害・発生条件）

`HfFileSpec.sha256` の JSDoc は「形式不正は network に出る前に throw」（src/hf/mod.ts:44）、`toSpec` の
コメントも「全量ダウンロードしてから落とすと呼び出し毎に帯域を捨てる」（src/hf/mod.ts:245-247）と述べる。
だが 3 入口すべてで `toSpec` は `await resolveHfRevision(...)` の**後**に呼ばれる:

- `fetchHfFile`: resolve（:268-271）→ `toSpec`（:272）
- `prefetchHfFile`: resolve（:328-331）→ `toSpec`（:332）
- `fetchHfFiles`: resolve（:357-360）→ map 内で `toSpec`（:367）

実害は 2 段階。①可変 ref なら形式不正の申告 1 個につき revision 解決 API へ必ず 1 リクエスト出る
（小さいが「出る前に」は嘘）。②`fetchHfFiles` はより悪い: `names.map` のコールバックは最初の await まで
同期に走るため、`files` の 3 番目に不正 sha256 があると **1・2 番目の `fetchResolvedFile` は既に
fetch を開始しており**、`Promise.all` の reject 後もそのダウンロードは中断されない（誰もキャンセル
しない）。呼び出し側は即座にエラーを受け取るのに、回線は数 GB を運び続ける。これは `toSpec` の
存在理由（帯域を捨てさせない）そのものの反例である。

なお v0.4.0 でも順序は同じで、ffc8bef が壊したわけではない（`git show v0.4.0:src/hf/mod.ts`）。ただし
cache 層側の同種ガードは本当に network 前で完結しており（src/mod.ts:631-646 / :788-792）、語彙を
揃えたと書いてある以上（src/hf/mod.ts:246-247）、HF 層だけ成立していないのは契約のズレとして扱うべき。

### 修正案

各入口で spec の正規化を `resolveHfRevision` の await より前へ移す（挙動の他の側面は不変・3 箇所の
行移動のみ）:

```ts
// fetchHfFile
const spec = toSpec(file);                       // ← 先に正規化（network 前）
const revision = await resolveHfRevision(ref, { fetch: opts.fetch, init: opts.init });
return await fetchResolvedFile(ref, revision, spec, opts);

// fetchHfFiles
const names = Object.keys(files) as Names[];
const specs = names.map((name) => toSpec(files[name]));  // ← 全 spec を先に検証
const revision = await resolveHfRevision(...);
const entries = await Promise.all(names.map(async (name, i) => [name, await fetchResolvedFile(ref, revision, specs[i], opts)] as const));
```

`prefetchHfFile` も同様（:332 の `toSpec` を :328 の前へ）。

### 対象

- src/hf/mod.ts:263-273（`fetchHfFile`）
- src/hf/mod.ts:323-346（`prefetchHfFile`）
- src/hf/mod.ts:352-373（`fetchHfFiles`。並列 map は :363-370）
- src/hf/mod.ts:44, 243-256（成立していない断定と `toSpec`）

### 根拠

- JS の実行順: `async` 関数本体は最初の `await` まで同期実行される。`fetchResolvedFile` →
  `fetchBytes` は `serializeKey` / ガードを同期に通してから `acquireAndDecode` を呼び、そこで
  cache open / fetch の await に入る（src/mod.ts:599-696, 479-539）。よって map の 1 要素目の
  取得は 3 要素目の `toSpec` throw より前に開始している。
- ADR 0007（docs/decisions/0007-explicit-expected-bytes-fail-loud.md:34-35）が明文化した価値判断
  「守れているのは*落ちる時刻を遅らせること*だけであり、それは呼び出し側にとって害でしかない」は
  そのままこのケースに当てはまる。

---

## HF-03 🟡 HF 層エントリの掃除導線が公開 API に無い（既定キー式が private・sha256 有無で列挙が分裂）

### 概要（挙動・実害・発生条件）

ADR 0006 §3 は「名前空間はキー接頭辞、管理はプレフィックス操作」を管理の唯一の筋にした。ところが
HF 層の既定キー式は private な `defaultKey`（src/hf/mod.ts:208-212）にしか無く、export もされて
いない。下流（yomi / sbv2-web）が「このリポジトリのキャッシュを消す」を実装するには:

1. 式 `["hf", kind ?? "model", repo, path, sha256]` を**手写し**して `evict(["hf", kind, repo])` を
   呼ぶ（ライブラリ側が要素を 1 つ足した瞬間、下流の prefix は黙って外れる = 派生値の二重管理）。
2. さらに `sha256` を宣言していないファイルは URL キーなので `evict` の射程外。`listCachedUrls()` で
   拾って `evictUrl` する第 2 経路が別途要る。

つまり「HF のキャッシュを掃除する」という 1 つの意図が、公開 API では 2 経路 + 私有知識の手写しに
分解される。HF-01 の孤児エントリを掃除する導線もここに乗る。

補足（欠陥ではない注意点）: `HfFileSpec.key` の JSDoc が例示する安定キー `["hf", repo, path]`
（src/hf/mod.ts:59）は、ライブラリ既定キーと**同じ "hf" 部分木**に入る。`evict(["hf"])` が両方を
掃くのは望ましい挙動だが、「先頭要素はアプリ名前空間」という §3 の推奨（`["app-name", ...]`）とは
別の使い方を例示していることになるので、README のキー粒度表と揃えるときに一言あると親切。

### 修正案

最小（実装変更なし・docs 残作業に含めるべき具体項目として）: README のキー粒度表と
docs/limitations.md に「HF 既定キーは `["hf", kind, repo, path, sha256]`。sha256 を宣言しない
ファイルは URL キーなので `evict` では消えず `listCachedUrls` + `evictUrl` が要る」を明記する。

任意（API を 1 本増やす案・非破壊なので後付け可）: 既定キー式を公開する
`export const hfCacheKey = (ref: HfRepoRef, spec: HfFileSpec): CacheKey | undefined` を `./hf` から
出し、`defaultKey` をその薄いラッパにする（実装は 3 行、`defaultKey` を消して置換するだけ）。
「派生値を独立に持たせない／二つの経路が一致すべきなら経路を 1 本にする」原則にそのまま乗る。
`Simplicity first` とのトレードオフはあるので採否はオーナー判断（速報値ではなく、下流が prefix を
手写しする現実があるかで決めるのが妥当）。

### 対象

- src/hf/mod.ts:208-212（private `defaultKey`）
- src/mod.ts:986-998（`evict` = 配列キー専用）、src/mod.ts:1035-1043（`listCachedUrls` = URL キー専用）
- src/hf/mod.ts:54-65（`HfFileSpec.key` の JSDoc と安定キー例）

### 根拠

- ADR 0006 §3（docs/decisions/0006-cache-control-redesign.md:87-102）が管理 API をプレフィックス
  操作に一本化した一方、§4（同 :113-115）で sha256 無しは URL キーのままとしたため、HF 層のエントリは
  構造的に 2 つの鍵空間へ分かれる。両者を跨ぐ導線は現在の公開 API には無い。
- グローバル規約「派生可能な状態を独立更新の非正規化フィールドに持たない／二つの経路が一致すべき
  ときは経路を共有する」。下流が手写しする prefix は定義上この非正規化に当たる。

---

## HF-04 🟡 新設の `evict` / `listKeys` に `caches` DI が無く、`opts.caches` 運用のエントリは管理不能

### 概要（挙動・実害・発生条件）

`fetchBytes` / `prefetchUrl` / HF 層 3 API はすべて `caches?: CacheStorage` を受け取り、差し替えた
CacheStorage へ書き込める（src/mod.ts:167, 731、src/hf/mod.ts:168, 283）。一方で今回新設された
`evict` / `listKeys` を含む管理 API 群は、グローバル `caches` を直接見る実装で DI 口が無い
（src/mod.ts:986-998, 1005-1024, 926-935, 942-945）。

結果として「`opts.caches` に自前の CacheStorage を渡して取得したエントリ」は、公開 API では
**列挙も削除もできない**（呼び出し側が Cache API を直接叩くしかない）。ADR 0006 §3 が管理 API を
再定義した回であり、`evict` / `listKeys` はこの commit で生えた新 API なので、ここを揃える最も安い
タイミングは 0.5.0 リリース前である。

なお v0.4.0 の `evictUrl` / `clearCache` / `listCachedUrls` にも DI は無かった（`git show
v0.4.0:src/mod.ts` の :699-741）ので、退行ではなく「新 API が既存の穴を継承した」形。オプション引数の
追加は非破壊なので緊急ではない。

### 修正案

管理 API 5 本に共通の任意引数を足す（既定はグローバル `caches`。省略時の挙動は完全不変）:

```ts
export const evict = async (prefix: CacheKey, opts: { caches?: CacheStorage } = {}): Promise<number>
export const listKeys = async (prefix: CacheKey = [], opts: { caches?: CacheStorage } = {}): Promise<CacheKey[]>
// evictUrl / clearCache / listCachedUrls も同型（evictUrl は 0.4.0 の opts 引数の位置がそのまま使える）
```

`typeof caches === "undefined"` の分岐は既存の `globalCaches()`（src/mod.ts:238-239）へ寄せると
5 本の重複も消える。採否はオーナー判断（「テスト・故障注入用」と明記した DI 口を管理側にも
開くか、fetch 側だけの非対称を意図として維持するか）。

### 対象

- src/mod.ts:986-998（`evict`）、1005-1024（`listKeys`）
- src/mod.ts:926-935（`evictUrl`）、942-945（`clearCache`）、1035-1043（`listCachedUrls`）
- 対比: src/mod.ts:166-167（`FetchBytesOptions.caches`）、730-731（`PrefetchUrlOptions.caches`）

### 根拠

- 実装が `caches.has` / `caches.open` / `caches.delete` をグローバル参照で直接呼んでいる
  （src/mod.ts:988-990, 1007-1009, 929-933, 943-944, 1036-1038）。
- ADR 0006 §3（docs/decisions/0006-cache-control-redesign.md:93-100）が管理 API の形を定義した際、
  DI については触れていない＝意図的な非対称という記録は無い。

---

## HF-05 🟡（境界所見・主担当は cache 層レンズ）記録ハッシュが「有るが不一致」のヒットで不要な全量再ハッシュが走る

### 概要（挙動・実害・発生条件）

ADR 0006 §2 のヒット時アルゴリズムは 3 分岐である: 記録一致 → 採用 / **記録不一致 → self-heal** /
記録なし → 1 回だけ digest して突合。実装は前 2 者を区別せず、`trusted` が false のときは常に
`sha256HexNative(raw)` を計算する（src/mod.ts:520-521 → 423-430）。「記録あり・期待値と不一致」の
ヒットでは、計算結果を捨てて self-heal するためだけに**全量ハッシュ 1 回**を払う。

影響するのは HF 層で `HfFileSpec.key` に安定キーを使う運用（ADR §5 の「ピンポン」列。同 JSDoc が
明示的に支持している使い方 — src/hf/mod.ts:54-63）。revision を行き来するたび「全量ハッシュ →
evict → 全量再ダウンロード」になり、数 GB 級ではハッシュぶんが丸ごと上乗せされる。HF 既定の内容キー
配下では記録が食い違い得ない（HF-15）ので、こちらは影響を受けない。

### 修正案

`recheck !== true` かつ記録が存在して期待値と食い違う場合は、計算せずに self-heal へ倒す。例:

```ts
const recordedMismatch = opts.sha256 !== undefined && recorded !== null &&
  recorded !== opts.sha256 && opts.recheck !== true;
// recordedMismatch なら checkAndDecode を呼ばずに evict → フォールスルー
```

安全性は落ちない: 記録は「保存時にこの sha256 と一致した」ことのみを主張し、記録付きの不正エントリは
構造的に作られない（ADR 0005 §5 / 0006 §2）。記録そのものを疑う運用は `recheck` が担当する。

### 対象

- src/mod.ts:515-536（ヒット時の鮮度判定と self-heal）、特に :520-521 の `trusted`
- src/mod.ts:418-433（`checkAndDecode` の `trustedSha256` 分岐）

### 根拠

- ADR 0006 §2（docs/decisions/0006-cache-control-redesign.md:69-73）は「不一致 → 内容が変わった
  ものとして self-heal」と「**記録が無いエントリは** native digest で 1 回計算して突合する」を
  別々に書いており、記録不一致で計算するとは書いていない。
- ADR 0006 §5 の表（同 :125-129）が「安定キー + `sha256`」を正規のポリシー選択肢として提示し、
  `HfFileSpec.key` の JSDoc（src/hf/mod.ts:59-63）もそれを MUST 付きで案内している以上、その経路の
  コストは設計上の関心事に入る。

---

## HF-06 🔵 `HfPrefetchResult.url` とモジュール doc が `spec.key` 上書きを反映していない

`HfPrefetchResult.url` の JSDoc は「取得元。`spec.sha256` 無しならキャッシュキーでもある」
（src/hf/mod.ts:292）だが、`spec.key` を渡した場合は sha256 の有無に関わらずキーは `spec.key` で、
URL はキーではない（src/hf/mod.ts:209, 336）。モジュール doc（同 :4-8）も同様に `spec.key` 上書きに
触れずキー決定則を述べている（`defaultKey` の JSDoc :200-207 と `HfFileSpec.key` :54-65 は正しい）。
`url` をそのまま `evictUrl` に渡す使い方をすると、`spec.key` 運用では何も消えない（戻り値 false）。

修正案: :292 を「取得元 URL（`spec.key` を渡さず `spec.sha256` も無いときはキャッシュキーでもある）」に、
モジュール doc に「`spec.key` を渡した場合はそれが優先」を 1 節足す。実装変更なし。

---

## HF-07 🔵 `resolveHfRevision` の JSON パース失敗が URL 情報の無い生 `SyntaxError` になる

`resolveHfRevision` は !ok と「sha が無い」を丁寧に URL 付きで throw する（src/hf/mod.ts:141-151）が、
`await response.json()`（:148）が 200 応答の非 JSON（プロキシのログインページ、HTML エラーページ等）で
throw する経路だけは素通しで、`SyntaxError: Unexpected token '<'` が URL も文脈も無しに呼び出し側へ
飛ぶ。fail loud 自体は満たすが、この層が他 2 経路で守っている「どの URL で何に失敗したか」が欠ける。
body は `json()` の失敗時に内部で消費/エラー化されるのでリソース漏れは無い。

修正案（任意・3 行）: `json()` を try で包み、`fetch-cache: revision 解決応答が JSON ではない (${url})`
＋ `cause` に元エラーを載せて投げ直す（:141-151 の語彙と揃う）。

---

## HF-08 🔵 `hfResolveUrl` が `repo` を無エンコードで埋めるため、`#` / `?` 混入時に取得元とキーが乖離する

`encodePath` はセグメント毎 encode、revision は丸ごと encode で、公式クライアント
（`quote(revision, safe="")` / `quote(filename, safe="/")`）と一致しており妥当（src/hf/mod.ts:98-119）。
ただし `repo` だけは「`/` が構造要素だから」という理由で無変換のまま埋め込まれる（:116）。`repo` に
`#` や `?` が混ざると URL 側だけが fragment / query として切れ、内容キー側（:211）は生文字列を保持する
ため、取得元とキーの表現が食い違う。HF のリポジトリ名は実際には `[A-Za-z0-9._-]` に限られるので実運用の
リスクは低く、実害が出る前に 404 か sha256 不一致で fail loud に落ちる（＝ゴミが静かにキャッシュされる
経路は無い）。

なお ADR 0006 §1 が「構造的に消滅する」と言う fragment 問題は**キー側**の話で、そちらは配列キーの
直列化所有により実際に消えている（HF-16）。ここで残るのは取得元 URL 側のみ。

修正案（任意）: `repo` をセグメント毎 encode（`encodePath(ref.repo)`）にする。SHA・通常の repo 名には
恒等なのでキャッシュキーも既存エントリも動かない。採否はオーナー判断（入力バリデーションを増やさない
方針なら現状維持でも一貫する）。

---

## HF-09 🔵 `./hf` から `CacheKey` / `ValidateBytes` / `DecodeBytes` が再エクスポートされていない（+ doc lint 7 件）

`HfFileSpec` / `HfFetchOptions` / `HfPrefetchOptions` は `CacheKey`（src/hf/mod.ts:65）、
`ValidateBytes`（:71）、`DecodeBytes`（:77）、`FetchProgress`（:157）、`CacheErrorContext`（:159）を
公開シグネチャに使うが、いずれも `../mod.ts` からの type import で `./hf` からは出ていない
（src/hf/mod.ts:16-24）。同一パッケージの `.` エントリから import すれば解決するので機能上の欠落では
ないが、`./hf` だけを使う下流は `spec.key` の型を書くために 2 エントリを import することになる。

`deno doc --lint src/mod.ts src/hf/mod.ts` は missing-jsdoc 7 件（`VERSION`、`FetchBytesOptions`、
`PrefetchUrlOptions`、`HfRepoKind`、`HfRepoRef`、`HfFileSpec`、`HfFetchOptions` の型自体に JSDoc が
無い。メンバは全て記述済み）。JSR の publish 阻害要因（no-slow-types）ではなく、`deno task check` にも
含まれない既存スタイル。

その他エクスポート面の突合結果は健全: `deno.json` の `exports`（`.` → src/mod.ts、`./hf` →
src/hf/mod.ts）と実ファイルは一致、`publish.include`/`exclude` は `src/**/*.ts` からテストと
`src/testing/**` を除外していて、公開モジュールがそれらへ依存していないことも確認済み
（`src/sha256.ts` は exports に無い＝ADR どおり非公開、ただし publish には同梱され `.` から内部利用）。
ADR 0006 §3 が定めた管理 API 5 本（`evict` / `listKeys` / `evictUrl` / `listCachedUrls` /
`clearCache`）はシグネチャまで記述どおり実装されている。

---

## HF-10 🔵 CLAUDE.md のテスト隔離規約が ADR 0006 の Consequences と食い違ったまま

CLAUDE.md:36 は「Cache API は実物を使い、テスト毎にユニークな cacheName + 後始末 `caches.delete`」と
書くが、ADR 0006 Consequences（docs/decisions/0006-cache-control-redesign.md:149-151）はこれを
「固定名前空間を使い、テスト毎に finally で `caches.delete("fetch-cache")`」へ変更している。
`cacheName` オプションが全廃された以上、旧規約は実行不能（`src/testing/mock_fetch.ts:45-47` の
`uniqueCacheName` は現在 `Cache.keys()` の feature probe 用途でのみ生存 — src/mod.test.ts:106。
残骸ではない）。

依頼のスコープ外に挙がっているのは README.md / docs/limitations.md なので、CLAUDE.md は docs 残作業の
チェックリストから漏れやすい。同 docs コミットで 1 行更新するのが妥当。

---

## HF-11 🔵 `HfFileSpec.key` の DECIDED ポインタ先（docs/limitations.md のキー粒度記述）が未追従

`HfFileSpec.key` の JSDoc は「（DECIDED: docs/decisions/0006 §5、docs/limitations.md）」と 2 箇所を
指す（src/hf/mod.ts:63）が、現時点の docs/limitations.md（未コミット変更込み）にキー粒度・ピンポン・
stale 固着の記述は無い（`rg 'キー粒度|ピンポン|stale'` でヒット 0）。ADR 0006 §5 は
「**MUST 文書化**: … docs/limitations.md・`HfFileSpec.key` の JSDoc・README のキー粒度表に記載する」
（docs/decisions/0006-cache-control-redesign.md:131-134）と 3 箇所を義務化しており、JSDoc 側は
完了・残り 2 箇所が未了。docs 全面書き換え（既知残作業）の中で確実に消化されるべき項目としてのみ記録
（スコープ外につき所見扱い）。

同様に README.md / docs/limitations.md の未コミット版には `verifiedMarker` / `trustCachedSha256` /
`cacheName` / `"fetch-cache-hf"` の旧 API 記述が残っている（`rg` で確認）— これも既知残作業の範囲。
`src/mod.ts:30` の `VERSION = "0.4.0"` は deno.json と一致しており drift は無い（bump は残作業）。

---

## HF-12 🟢 `defaultKey` の単一実装で 3 API のキー一致が構造的に保証されている

キー式の構築点はリポジトリ全体で `src/hf/mod.ts:211` の 1 箇所だけ（`rg '"hf"' src/` で確認）。
`fetchResolvedFile`（:225、`fetchHfFile` / `fetchHfFiles` の共有経路）と `prefetchHfFile`（:336）が
同じ関数を同じ引数（`ref`, 正規化後 `spec`）で呼ぶため、「温めたエントリが読みでヒットする」ための
キー一致は分岐の同期に依存しない。`kind` は両経路とも `ref.kind ?? "model"` で正規化されるので、
`kind` 省略と `kind: "model"` が別エントリに割れることも無い。ADR 0006 §4 の「ファイル毎指定なので
3 API で一貫する」（docs/decisions/0006-cache-control-redesign.md:116-118）は実装で満たされている。

---

## HF-13 🟢 `recheck` の withholding が cache 層のガードと正しく噛み合っている

HF 層は `recheck: spec.sha256 === undefined ? undefined : opts.recheck`（src/hf/mod.ts:228）で、
sha256 を宣言しないファイルについてのみ `recheck` を落とす。cache 層は「`sha256` 無しで `recheck` が
`undefined` 以外なら throw」（src/mod.ts:642-646）なので、`fetchHfFiles` に sha256 有り/無しが混在した
`files` を渡して `recheck: true` を指定しても、無しのファイルが呼び出し全体を落とすことはない。
`HfFetchOptions.recheck` の JSDoc「`sha256` の無いファイルには影響しない」（:174）と挙動が一致する。
呼び出し単位のオプションをファイル単位のガードへ落とし込む唯一の妥当な形になっており、fail loud を
曲げているわけでもない（cache 層の単独指定 throw は cache 層の直接利用者に対しては生きている）。

---

## HF-14 🟢 旧 API の残骸は `src/` 配下に無い（機械確認）

`rg 'cacheName|verifiedMarker|trustCachedSha256|sha256Hex\b|isTightView|fetch-cache-hf|x-fetch-cache-verified'`
を `.git` 以外の全体に実行した結果、`src/` 側のヒットは以下のみで、いずれも残骸ではない:

- src/mod.ts:170-171 / :356-357 — `cacheName` 撤去・旧ヘッダ廃止を説明する意図的なコメント。
- src/mod.ts:384-386, 399 — `isTightView` は HF 層から cache 層へ移設された（旧 HF 層の
  `sha256Hex` ごと `sha256HexNative` に統合。diff で削除を確認）。
- src/mod.test.ts:39-61 — CacheStorage モックのメソッド引数名（Web API 側の名前）。
- src/testing/mock_fetch.ts:45-47 + src/mod.test.ts:106 — `uniqueCacheName` は `Cache.keys()` の
  feature probe 用に現役（HF-10 参照）。

HF 層からは `DEFAULT_CACHE_NAME = "fetch-cache-hf"`、`sha256Hex`、`isTightView`、`cacheName`、
`trustCachedSha256`、`verifiedMarker` が完全に消えており（`git diff v0.4.0..HEAD -- src/hf/mod.ts`）、
`deno check .` も緑。ADR 0006 §3 が言う「旧レビュー IM-01 の読み戻し罠が構造的に消滅」は達成されている。

---

## HF-15 🟢 HF 既定キー配下のエントリは必ず記録ハッシュを持つ（再ハッシュ無しの構造保証）

内容キー `["hf", kind, repo, path, sha256]` は `spec.sha256` があるときにしか生成されない
（src/hf/mod.ts:210-211）。そのキーへ書き込む経路は `fetchBytes`（`sha256` 付き → 検証通過後に
`SHA_HEADER` を焼く。src/mod.ts:556-566, 368-378）と `prefetchUrl`（`sha256` 付き → Response 構築
時点で焼く。src/mod.ts:835-837, 882）の 2 つだけで、どちらも記録なしのエントリを作らない。よって
モジュール doc の「キャッシュヒットは記録ハッシュとの突合だけで済み、再ハッシュは走らない」
（src/hf/mod.ts:9-11）は HF 既定キー運用では**構造的に**真になる（記録なし → 毎ヒット再計算という
ADR 0006 Consequences :142-144 の劣化パターンに、HF 既定経路は原理的に落ちない）。
prefetch → fetch の引き継ぎ（温め時に焼いた記録をそのまま読み側が信じる）もこの一貫性の上に乗る。

---

## HF-16 🟢 キー直列化の単射性により path / repo のスラッシュがキー衝突を作らない

内容キーには `repo`（"owner/name"）と `path`（"dir/file.bin"）という `/` 入り文字列が素で入るが、
直列化は要素毎に `JSON.stringify` → `encodeURIComponent` するため（src/mod.ts:206-213）、`/` は
`%2F` になりセグメント境界と衝突しない。`["hf","m","a/b","c"]` と `["hf","m","a","b/c"]` は別キーに
なり、`evict` のプレフィックス前方一致（src/mod.ts:972-975）も誤爆しない。旧 `cacheKey: string` 案が
抱えていた fragment 剥がれ（ADR 0006 Context :20-23、旧レビュー IM-03）は、HF 層が文字列 URL を
組み立てずに配列を渡す形になったことで HF 層側からも消えている。`encodePath`（:102-103）が
セグメント毎 encode で単射なので、異なる `path` が同一取得元 URL へ落ちることも無い。

---

## 分類一覧

| 分類 | 件数 | ID                                     |
| ---- | ---- | -------------------------------------- |
| 🔴   | 0    | —                                      |
| 🟠   | 0    | —                                      |
| 🟡   | 5    | HF-01, HF-02, HF-03, HF-04, HF-05      |
| 🔵   | 6    | HF-06, HF-07, HF-08, HF-09, HF-10, HF-11 |
| 🟢   | 5    | HF-12, HF-13, HF-14, HF-15, HF-16      |

## 総評

HF 層の再設計は中核が固い: 既定キーの式が `defaultKey` 1 箇所に閉じているため 3 API のキー一致が
分岐同期ではなく構造で保証され（HF-12）、内容キー配下のエントリは記録ハッシュを必ず持つので
「温め → 再ハッシュ無しの読み出し」も原理的に成立する（HF-15）。`recheck` のファイル単位 withholding は
cache 層のガードと過不足なく噛み合い（HF-13）、`cacheName` / `verifiedMarker` / `trustCachedSha256` /
`sha256Hex` / `isTightView` / `"fetch-cache-hf"` の残骸は `src/` 配下にゼロで、`deno check` も緑
（HF-14）。設計原則違反（🔴）も実装欠落（🟠）も見つからなかった。残る 🟡 5 件は性格が 2 種類で、
①JSDoc と実挙動の乖離が 2 件（sha256 無し prefetch の revision レース注意書きが削除された HF-01、
「network に出る前に throw」が revision 解決の後に走る HF-02）、②released になると訂正コストが跳ね上がる
API 面の未決着が 3 件（HF 既定キー式が private で掃除導線が分裂している HF-03、新設 `evict` /
`listKeys` に `caches` DI が無い HF-04、記録不一致ヒットの不要な全量再ハッシュ HF-05 — 後 2 者は
cache 層レンズが主担当）。①は docs 残作業と同じ 1 コミットで消せる純粋な記述修正、②はいずれも
「後から非破壊で足せるが、0.5.0 リリース前が最も安い」性質なので、リリースを止める理由にはならない
一方、出す前に採否だけは決めておく価値がある。
