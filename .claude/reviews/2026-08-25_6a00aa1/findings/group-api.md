# group-api — API 設計・利便性の妥当性評価（AP-）

対象: `git diff v0.4.0..HEAD`（a4163d6 / 4b9e0ed / 6a00aa1）。担当は「この設計が利便性面で
優れているか」「ADR 0006 を撤回すべき理由があるか」の判断材料出し。実装バグ探しは他レーン。

## 総括

実装そのものに設計原則違反（🔴C）も実装抜け（🟠E）も見つからなかった。省略時完全不変・
fail loud ガード・キー空間の一貫（match/delete/put/合流の 4 箇所）は ADR 記述と実コードが
一致している（src/mod.ts:347, 369, 389, 417, 506-508）。

判断材料としての焦点は 3 点: ①この機能は **capability ではなく ergonomics/diagnostics** で
あり、`fetch` DI の URL 書き換えで今日でも同じキャッシュ意味論が得られる（AP-05）。
②ADR 0006 §5 の非対称は「安い方（prefetch）に口を開け、高い方（読み出し）を塞ぐ」形に
なっていて、コスト勾配と逆向き（AP-01）。③その読み出し再実装の実コストは 30〜40 行だが、
うち 2 つ（`cacheName` の既定値差・`sha256Hex` の tight-view 最適化）は**静かに損をする**
種類の落とし穴（AP-02 / AP-03）。

リリース可否としては「今出しても壊れない」。ただし `prefetchHfFile.cacheKey` は released API に
なると**撤回不可**なので、案 (c)（HF 層から外す）を採る最後の機会が 0.5.0 リリース前である、
という点だけは締切のある判断。

---

## AP-01 🟡W ADR 0006 §5 の非対称が「再実装コストの勾配」と逆向き

### 概要（挙動・実害・発生条件）

§5 は「温めは `prefetchHfFile.cacheKey`、読み出しは cache 層 `fetchBytes` + 同じ `cacheKey`」
という線引きを採る。だが公開 API での再実装コストを実測すると、開けた側と塞いだ側で逆転している。

**開けた側（`prefetchHfFile.cacheKey`）の公開 API 等価実装 = 3 行**。
`prefetchHfFile` が cacheKey 経路でやることは、`resolveHfRevision`（公開・hf/mod.ts:108）→
`hfResolveUrl`（公開・hf/mod.ts:92）→ `prefetchUrl(url, { cacheKey, sha256, cacheName })`
（公開・mod.ts:614）だけで、固有の内部ロジックは `toSpec` の sha256 形式ガード
（hf/mod.ts:260-268、正規表現 1 本）しか無い。つまり **`cacheKey` を足さなくても下流は
3 行で同じことができた**。

**塞いだ側（読み出し）の再実装 = 30〜40 行 + 2 つの静かな罠**。`fetchResolvedFile`
（hf/mod.ts:228-253）が組み立てているものを呼び出し側が持ち込む必要がある:

| 再実装対象 | 参照 | コスト |
| --- | --- | --- |
| `buildValidate`（expectedBytes 長さ検査 → sha256 → カスタム validate の合成・順序） | hf/mod.ts:200-225 | 20 行強。順序も再現が要る |
| `sha256Hex`（非公開・tight-view 判定つき） | hf/mod.ts:168-193 | 15 行。素朴に書くとコピー 1 回ぶん劣化（AP-03） |
| `verifiedMarker = trustCachedSha256 ? spec.sha256 : undefined` | hf/mod.ts:244 | 1 行だが「印 = sha256 hex」という暗黙契約の知識が要る |
| `expectedBytes` を確保ヒントとして渡す | hf/mod.ts:242 | 1 行。忘れるとヒープピークが 2N |
| `decode: spec.decode` | hf/mod.ts:239 | 1 行 |
| `cacheName: "fetch-cache-hf"` の明示 | hf/mod.ts:60 vs mod.ts:149 | 1 行だが忘れると恒久ミス（AP-02） |
| `onProgress` の path 付与 | hf/mod.ts:245-247 | 1 行 |

なお ADR §5 の却下理由（「ファイル毎のキーを組み立てられる呼び出し側は resolve URL も自前で
組める」— 0006:77-79）は、そのまま `prefetchHfFile.cacheKey` にも当てはまる。同じ論拠が
片方だけを却下しており、論理としては非対称。

### 修正案

順に検討した 4 案の比較（評価軸は依頼のとおり: 下流実装コスト / API 表面積 / released 制約 /
撤回可能性）。

| 案 | 下流コスト | API 表面積 | released 制約 | 撤回可能性 |
| --- | --- | --- | --- | --- |
| (a) 現行（prefetch のみ） | 温め 0・読み出し 30〜40 行 | +1 フィールド | 追加なので可 | **不可（0.5.0 出荷後）** |
| (b) `HfFileSpec.cacheKey` | 温め 0・読み出し 0 | +1 フィールド（ただし `prefetchHfFile` で opts.cacheKey と二重入口＝曖昧） | 追加なので可 | 不可 |
| (c) HF 層に足さない | 温め 3 行・読み出し 30〜40 行 | +0 | — | — |
| (d) `sha256Hex` 相当 or `buildValidate` 相当を export | 読み出し 30→10 行程度 | +1 関数 | 追加なので可 | 不可 |

**推奨: (a) 維持 + (d) の最小版（sha256 hex ヘルパの export）を 0.5.0 に同梱、(b) は据え置き。**
根拠 3 点:

1. **(b) は入口が二重になる**。`prefetchHfFile` は `spec` と `opts` の両方を取るので、
   `HfFileSpec.cacheKey` を足すと `opts.cacheKey` と衝突する（どちらが勝つかという規約が
   増える）。この曖昧さは permanent surface として高くつく。要望が出てからでも
   **オプショナルフィールドの追加は非破壊**なので、遅らせるコストはゼロ。
2. **(c) は撤回として筋は通るが得が小さい**。取り除いても下流が 3 行書くだけで、代わりに
   「HF 層の温めだけは自前 URL 組み立て」という別の非対称が残る。表面積 +1 の対価としては
   現行のまま出す方が実利がある。
3. **(d) が非対称の実害（30〜40 行のうち最も間違えやすい 15 行）を直接消す**。合成順序や
   marker 契約と違い、sha256 hex 化は「正しく速く書くのが難しい」唯一の部分で、export の
   意味論も自明（バイト列 → 小文字 hex）。ADR 0006 §5 の線引き自体は変えずに済む。

### 対象 path:line

`docs/decisions/0006-cache-key-separation.md:69-80` / `src/hf/mod.ts:200-253` /
`src/hf/mod.ts:286-307`

### 根拠

上表のとおり実コード（hf/mod.ts の `buildValidate` / `fetchResolvedFile` / `prefetchHfFile`）
と公開 API（`resolveHfRevision` / `hfResolveUrl` / `prefetchUrl` / `fetchBytes`）を突合した
行数比較。ADR の却下論拠 0006:77-79 と採用側 0006:71-73 の対称性検査。

---

## AP-02 🟡W `cacheKey` 読み出し導線に `cacheName` の既定値差が明記されていない（恒久ミス + 二重ダウンロード）

### 概要（挙動・実害・発生条件）

`prefetchHfFile` の既定 cacheName は `"fetch-cache-hf"`（src/hf/mod.ts:60, 364）だが、
cache 層 `fetchBytes` の既定は `"fetch-cache"`（src/mod.ts:149, 346）。ADR §5 と
`HfPrefetchOptions.cacheKey` の doc（src/hf/mod.ts:295-297）と limitations の追記は
いずれも「読み出しは `fetchBytes` に**同じ `cacheKey`** を渡して行う」としか書いておらず、
`cacheName` にも触れる必要があることを書いていない。

発生条件: `prefetchHfFile(ref, file, { cacheKey })` で温め → `fetchBytes(url, { cacheKey })`
を `cacheName` 無指定で呼ぶ。実害: 名前空間が違うので**必ずミス**し、温めた数 GB を捨てて
network から取り直したうえ、別名前空間に二重に格納する。fail loud な経路が無く（キーは
http(s) なのでガードも通る）、動作としては「ただ遅い」だけなので気付きにくい。

### 修正案

ドキュメント修正のみで足りる（コード変更不要）。①`HfPrefetchOptions.cacheKey` の doc
（hf/mod.ts:295-297）の MUST に「`cacheName` も `"fetch-cache-hf"` を明示すること」を追記、
②ADR 0006 §5 と ③README の該当箇所（README.md の HF 節 `prefetchHfFile also takes cacheKey`
の bullet）に同旨。AP-01 の (d) を採るならヘルパ側に既定を寄せるのも可。

### 対象 path:line

`src/hf/mod.ts:60` vs `src/mod.ts:149` / `src/hf/mod.ts:290-298` /
`docs/decisions/0006-cache-key-separation.md:79-80` / `docs/limitations.md`（`HF 層の読み出し
API に cacheKey は無い` の項）

### 根拠

`DEFAULT_CACHE_NAME` が両モジュールに別値で定義されている（hf/mod.ts:60 = `"fetch-cache-hf"`、
mod.ts:149 = `"fetch-cache"`）。README には既定値差の記述自体はあるが（`clearCache` の注意
書き）、`cacheKey` 読み出し導線の文脈では言及されていない。

---

## AP-03 🟡W `sha256Hex` 相当が非公開のため、読み出し再実装で 2N → 3N の劣化が静かに入る

### 概要（挙動・実害・発生条件）

`sha256Hex`（src/hf/mod.ts:173-193）は `isTightView` 判定で「そのまま digest に渡せる view」の
ときコピーを作らない。コメントが明示するとおり、これで数 GB 級のピークが 3N → 2N になる
（hf/mod.ts:181-187）。この関数は非公開なので、`fetchBytes` + `cacheKey` で読む下流は自前で
sha256 検証を書くことになり、素朴な実装（`crypto.subtle.digest("SHA-256", new Uint8Array(bytes))`
や `bytes.buffer` を渡す）だと余計なコピーが 1 回復活する。

実害: 数 GB モデルで数 GB ぶんのヒープピーク増（ブラウザでは OOM 差になり得る）。発生条件:
ADR §5 が指示するとおりに読み出しを自前実装したとき。しかも**正しく動く**ので気付けない。

### 修正案

cache 層または HF 層に `sha256Hex(bytes: Uint8Array): Promise<string>` を export する
（AP-01 の (d) 最小版）。より踏み込むなら `hfFileValidate(spec: HfFileSpec): ValidateBytes |
undefined`（`buildValidate` の export）で合成順序ごと共有させる案もあるが、`HfFileSpec` の
契約（保存形 raw に対して走る等）を公開 API へ引き上げる分だけ表面積が増える。
追加はいずれも非破壊。

### 対象 path:line

`src/hf/mod.ts:168-193`（非公開の `isTightView` / `sha256Hex`）、
`src/hf/mod.ts:200-225`（非公開の `buildValidate`）

### 根拠

両関数とも `export` が付いておらず（`const sha256Hex = ...` / `const buildValidate = ...`）、
`src/hf/mod.ts` の公開 API は `isCommitSha` / `hfResolveUrl` / `resolveHfRevision` /
`fetchHfFile` / `prefetchHfFile` / `fetchHfFiles` と型のみ。最適化意図はコード内コメント
hf/mod.ts:181-187 に明記されている。

---

## AP-04 🟡W `CacheErrorContext` に失敗したキーが載らない（0.5.0 で足すのが最も安い）

### 概要（挙動・実害・発生条件）

`onCacheError` に渡る `url` は cacheKey 分離時も取得元 URL のまま（src/mod.ts:360, 377, 392,
419 が全て `url: requestUrl`）。ADR は Consequences で認知済み（0006:93-94）。

実害は限定的だが具体的にある: 汎用のキャッシュ監視・quota 対応（`op: "put"` 失敗時に
古いキーを evict する等）を書く側は、通知から**どのエントリが入らなかったか**を直接得られず、
呼び出し側で url → key の対応表を別途保持する必要がある。とくに single-flight 合流時は
leader の `onCacheError` しか呼ばれない（mod.ts:534 で leader の opts が使われる）ため、
合流者の url とも一致しない。

### 修正案

`CacheErrorContext` に `key?: string`（実効キー = `opts.cacheKey ?? requestUrl`）を足す。
**コールバック引数の型へのフィールド追加は消費側にとって完全に非破壊**（消費側は既存
フィールドしか読まない）。0.5.0 でキー空間という概念を導入する当のリリースで一緒に足すのが
最も筋が通る（後付けだと「0.5.0 では分からなかった」期間が残る）。実装は
`acquireAndDecode` 内の 4 箇所に `key: cacheKey` を足すだけ（cacheKey は mod.ts:347 で
既に算出済み）。

### 対象 path:line

`src/mod.ts:28-33`（型定義）、`src/mod.ts:360, 377, 392, 419`（発火 4 箇所）、
`docs/decisions/0006-cache-key-separation.md:93-94`

### 根拠

型 `CacheErrorContext = { op, url, error }` に key が無い（mod.ts:29-33）。発火側は全て
`url: requestUrl` で、`cacheKey` はローカル変数として同スコープに存在する（mod.ts:347）。

---

## AP-05 🟡W 反証: `fetch` DI の URL 書き換えで**同じキャッシュ意味論が今日でも得られる**（ADR に代替案として記載が無い）

### 概要（挙動・実害・発生条件）

依頼の反証責務「この分離は本当に必要だったか」を潰しておく。結論は
**capability としては不要・ergonomics と diagnostics としては妥当**。

`acquireAndDecode` は `fetchImpl(requestUrl, opts.init)`（src/mod.ts:398）を呼ぶだけなので、
下流は 0.4.0 時点でも次で content-addressed 化できた:

```ts
// キー = 合成 URL（第 1 引数）。取得元は DI した fetch が実 URL へ差し替える。
await fetchBytes("https://cache.example/sha256/1a2b…", {
  fetch: (input, init) => globalThis.fetch(manifest.sourceUrlFor(String(input)), init),
});
```

`prefetchUrl` も同じ形（fetch は mod.ts:663 で 1 回呼ぶだけ）なので温めも同様に可能。
`opts.fetch` の doc 自身が「テスト・**カスタム輸送用**」（mod.ts:143, 579）と明記しており、
用法として想定外でもない。single-flight・self-heal・marker も全て合成 URL 側で成立する。

その上で `cacheKey` が優れている点（＝撤回すべきでない理由）:

1. **診断の正直さ**: 迂回策だと HTTP エラーメッセージ（mod.ts:403-405）も `onCacheError.url`
   も合成 URL を報告し、「どこから落としに行って失敗したか」が消える。`cacheKey` は
   fetch/エラー側を取得元 URL のまま保つ（ADR 0006 §1 の設計意図、0006:36-38）。
2. **`init` / abort / 認証との干渉が無い**: 迂回策は呼び出し毎にクロージャを作り、URL 対応表を
   fetch 層へ持ち込む（責務の混線）。
3. **宣言的**: 「このエントリのキーはこれ」という主張がオプションとして型に出る。迂回策は
   同じ主張が fetch 実装の中に埋もれる。

ただし ADR 0006 の Context（0006:11-23）はこの代替案を検討対象として挙げていない。「必要
だった」ではなく「こちらの方が良い」であることが記録に残っていないのは、後日の再検討で
判断を誤らせ得る。

### 修正案

ADR 0006 の Context または新設「Alternatives considered」節に、`fetch` DI による URL 書き換えで
同等のキャッシュ意味論が得られること・それを採らなかった理由（診断の正直さ / 責務分離 /
宣言性）を 3〜4 行で追記する。コード変更は不要。**この追記は撤回判断そのものには影響しない**
（追記後も結論は「維持」）。

### 対象 path:line

`docs/decisions/0006-cache-key-separation.md:9-23`（Context に代替案の記載なし）、
`src/mod.ts:398`・`src/mod.ts:663`（DI した fetch が requestUrl を受け取る = 書き換え可能）、
`src/mod.ts:143`（「カスタム輸送用」の明示）

### 根拠

上記 file:line の実コード。迂回策の成立は静的読解による（推測ではなく制御フロー上の帰結だが、
実行して確かめてはいない — 実験はしていない旨を明記しておく）。

---

## AP-06 🔵L `cacheKey` が `string` のみ（`url` は `string | URL`）— 不一致だが急がない

`fetchBytes` / `prefetchUrl` の第 1 引数は `string | URL`（src/mod.ts:457, 615）で、
どちらも冒頭で `typeof url === "string" ? url : url.href` に正規化している（mod.ts:460, 618）。
一方 `cacheKey` は `string` のみ（mod.ts:65, 555, hf/mod.ts:299）。`URL` を組み立ててキーに
する下流は `.href` を自分で付ける必要があり、語彙として不揃い。

ただし: ①`isHttpUrl`（mod.ts:159-167）は `new URL(value)` で解釈するので、意味論は `URL`
インスタンスと等価であり機能差は無い。②`string` → `string | URL` への**拡張は後からでも
完全に非破壊**（引数型の共変拡大）。③`string` 限定は「キーは文字列である」という
キー空間の性質を型で言っているとも読める。よって 0.5.0 のブロッカーではない。観察として記録。

## AP-07 🟢S `cacheKey` のガード・キー空間・テストは ADR 記述と一致している

ADR §1 の「cache 側 4 箇所すべて」は実コードで確認できた: `cache.match`（mod.ts:369）/
`cache.delete`（mod.ts:389）/ `cache.put`（mod.ts:417）/ in-flight キー（mod.ts:506-508）。
network の `fetch` は `requestUrl`（mod.ts:398）。§3 の 2 つの fail loud ガードは
network に出る前（mod.ts:476-487 — `fetchImpl` 呼び出しの mod.ts:398 より手前）。
`prefetchUrl` 側も同様（mod.ts:630-635 が fetch の mod.ts:663 より手前）。
テストは cache 層に 8 本追加され、ヒット / self-heal / 別 URL 合流 / 非 http(s) / `cache:false` 併用 /
prefetch 格納 / prefetch marker を網羅している（src/mod.test.ts、`cacheKey:` で始まる
5 本 + `prefetchUrl: cacheKey` 3 本）。HF 層も素通し + 戻り値 url 不変を検証（src/hf/mod.test.ts:902-）。
省略時の挙動は全経路 `?? requestUrl` に落ちるため既存テストがそのまま回帰網になる。
