---
id: B
topic: hf-layer
files_reviewed:
  - src/hf/mod.ts
  - src/hf/mod.test.ts
  - src/testing/mock_fetch.ts
date: 2026-07-10
model: opus
commit: b5ccf62
scope: HuggingFace 層 + テストヘルパ（読み取り専用レビュー）
---

# Group B — HuggingFace 層 + テストヘルパ

## サマリ

HF 層は cache 層（`src/mod.ts`）の上に一方向で実装され、依存方向・レイヤー責務・
依存ゼロ規約はいずれも遵守（cache 層に HF 固有知識の漏れなし、テストヘルパは本体に
非 import、Web 標準 API のみ）。fail-loud 経路も概ね正しく throw する。設計の骨格は健全。

一方で **URL 構築が repo / revision / path をいずれも percent-encode せず、正規化も
しない**。通常フロー（可変 ref → SHA 解決 → SHA 固定 URL で取得）では revision が
常にクリーンな 40hex になるためキャッシュキーは安定するが、(1) `resolveHfRevision`
の API URL に生の `revision` が入るためスラッシュ入り ref（`refs/pr/1` 等）や `?`/`#`
を含む入力で URL 意味が壊れる、(2) 呼び出し側指定の `path` に `#`/`?` や非正準形が
あると別ファイル取得・キャッシュキー割れが黙って起きうる。いずれも「素の相対パス」
前提のコメントはあるが、失敗パスのテストが無く、実害の有無は HF の API 仕様に依存
（needs-human）。

テスト側は正常系と主要な検証失敗（sha256 / expectedBytes 不一致）を押さえているが、
**HTTP エラー分岐・ファイル取得の 404 伝播・HF 層 self-heal（破損キャッシュ再取得）
という失敗パス/看板機能が未カバー**。ヘルパ `mock_fetch.ts` は最小で堅実、直接の単体
テストは無いが全テストで間接的に酷使されており、忠実度の軽微な留保のみ。

確証のある実装バグ（E）・設計原則違反（C）は検出せず。指摘は Warning 5 件（コード 2 /
テスト 3）+ Low 情報。

## ファイル別分類

| File | 分類 | 主因 |
| --- | --- | --- |
| src/hf/mod.ts | 🟡 Warning | URL の encode/正規化欠如（W-B-1 revision/repo, W-B-2 path/hubUrl）。実害は HF 仕様依存で needs-human |
| src/hf/mod.test.ts | 🟡 Warning | 失敗パス未カバー: HTTP エラー分岐（W-B-3）・404 伝播/fail-loud（W-B-4）・HF 層 self-heal（W-B-5） |
| src/testing/mock_fetch.ts | 🔵 Low | 最小で堅実。単体テスト無しだが全テストで間接被覆。`_init` 無視・再利用時 body consume の忠実度留保のみ |

---

## 詳細指摘（Warning 以上）

### W-B-1 🟡 `resolveHfRevision` の API URL が revision / repo を encode しない
- path: `src/hf/mod.ts:84-88`（URL 組み立て）, 呼出契機 `:76-99`
- 症状: `url = ${hubUrl}/api/${API_SEGMENT[kind]}/${ref.repo}/revision/${revision}` は
  `ref.repo` と `revision` を生で文字列補間する。可変 ref がスラッシュを含む場合
  （`refs/pr/1`, `refs/convert/parquet` 等、HF で実在する ref 形式）URL は
  `.../revision/refs/pr/1` となり path セグメントが増える。`?`/`#`/空白を含むと
  それぞれ query / fragment 化して API 呼び出しが別物になる。
- 根本原因: revision を「不透明なパスセグメント」として扱う際の encode が無い。
  `hfResolveUrl`（`:60-67`）と違い、ここにはコメントによる正当化も無い。
- 影響範囲: `fetchHfFile` / `fetchHfFiles` は可変 ref を必ずここへ通す（`:188`,`:201`）。
  スラッシュ ref を指定したユーザは 404 相当で失敗（fail-loud なので黙認ではないが、
  正当な入力が使えない）。SHA / 単純ブランチ・タグ（`main`,`v1.0`）では無害。
- 留保（needs-human / 推測）: HF の revision API がスラッシュ ref に対し
  `encodeURIComponent`（`refs%2Fpr%2F1`）を要求するか、生スラッシュを受けるかは
  実装挙動依存で未確認。**要求するなら本件は E（正当入力で確実に壊れる）へ格上げ**。
  まず「HF がスラッシュ ref をどう受けるか」を確定させる必要がある。
- 修正案（候補）:
  - (a) revision セグメントのみ `encodeURIComponent(revision)`。ただしスラッシュ ref を
    HF が `%2F` で受ける前提が要る。`repo`（`owner/name`）はスラッシュが構造要素なので
    セグメント分割 encode（`repo.split("/").map(encodeURIComponent).join("/")`）が要検討。
  - (b) 当面 scope 外なら `docs/limitations.md` に「revision はスラッシュ非対応、
    encode 前提」を明記し、`isCommitSha` 相当で早期に不正 revision を fail-loud で弾く。
  - どちらにせよ「素の補間」を仕様として固定するなら hfResolveUrl 同様の WHY コメントが必要。
- 追加すべきテスト: `resolveHfRevision({repo, revision:"refs/pr/1"})` の期待 URL を
  assert（encode 方針を仕様として固定）。少なくとも「スラッシュ ref をどう組むか」を
  1 本のテストで凍結する。

### W-B-2 🟡 `hfResolveUrl` が path / hubUrl を encode・正規化しない（別ファイル取得・キャッシュキー割れ）
- path: `src/hf/mod.ts:60-67`, コメント `:58`
- 症状: `path` を生で末尾補間。`path` に `#` を含むと（例 `a#b.bin`）
  組んだ文字列 `.../resolve/SHA/a#b.bin` は fetch/Request の URL 解析で fragment
  `#b.bin` が落ち、実際には `.../resolve/SHA/a` を取得する＝**別ファイルを黙って取得**。
  `?` を含めば以降が query 化。さらに非正準 path（先頭 `./`,`/`,`//`, 末尾空白）は
  正規化されず、同一ファイルを指す別表記が別キャッシュキーになり重複ダウンロード。
- 根本原因: `:58` の「path は URL エンコードしない前提（HF のパスは素の相対パス）」は
  スペース等が Request/URL 層で一貫正規化される点では妥当だが、`#`/`?` の意味変化と
  正準化欠如までは免責していない。fail-loud 原則（不正な組み立てを黙って通さない）に反する。
- 影響範囲: `hubUrl` も同様に生補間（`:61,:64`）。query 付き hubUrl（プロキシ等）で
  同種の破壊。ただし本ライブラリは自前で `?download=true` 等を付けない設計なので、
  正常入力ではキャッシュキーは SHA 固定で安定（＝設計上の良い点）。破壊は「異常 path」時のみ。
- 留保: HF のファイル名に `#`/`?` が現れる頻度は低く、実害確率は低め（推測）。
  ただし「別ファイルを黙って取得」は fail-loud 違反として質が悪い。
- 修正案（候補）:
  - (a) path をセグメント分割し各セグメントを `encodeURIComponent`
    （`path.split("/").map(encodeURIComponent).join("/")`）。`#`/`?`/空白は %xx 化され
    別ファイル取得を防止。既存テストの期待 URL は変わらない（英数字パスは不変）。
  - (b) 最小対応として `#`/`?` を含む path を early throw（fail-loud）。
  - いずれも `:58` のコメントを実装と一致させて更新。
- 追加すべきテスト: `hfResolveUrl({repo, path:"a#b.bin"})` / `path:"a b.bin"` の期待 URL、
  および先頭 `/`・`//` の扱いを assert（正準化/encode 方針を凍結）。

### W-B-3 🟡 `resolveHfRevision` の HTTP エラー分岐（404/401/gated）が未テスト
- path: 対象コード `src/hf/mod.ts:89-93`（`!response.ok` → throw）/ テスト不在
- 症状: `mod.test.ts` は「sha が無い」（`:85-92`）は押さえるが、`!ok`（404 nonexistent
  repo / 401 private / 403 gated）で throw する分岐のテストが無い。fail-loud の中核分岐が未検証。
- 根本原因: 失敗パスのテスト不足。
- 追加すべきテスト: `mockFetch(() => new Response("x",{status:404,statusText:"Not Found"}))`
  で `resolveHfRevision` が reject し、message に `HTTP 404` と URL を含むことを
  `assertRejects` + `assertStringIncludes` で検証。
- 補足（横断）: 現状 401/403（private/gated）は汎用 HTTP エラーに丸められる。認証
  ヘッダを付ける口が無い（後述 横断所見）ため gated repo は原理的に取得不可。テストは
  「fail-loud で throw する」ことの凍結で十分だが、gated 専用メッセージ化は別途要判断。

### W-B-4 🟡 ファイル取得失敗（404）の伝播・`fetchHfFiles` の fail-loud が未テスト
- path: 対象 `src/hf/mod.ts:196-214`（Promise.all, `:195-198` の「1 つでも失敗で全体 reject」）
  / cache 層 throw は `mod.ts:116-121` / テスト不在
- 症状: `fetchHfFiles` テスト（`mod.test.ts:167-198`）は未知 URL に 404 を返すハンドラを
  持つが、実際に 404 を踏ませて reject することを assert していない（404 は使われない）。
  doc の看板「どれか 1 つでも失敗したら全体が reject（fail loud）」が未検証。
  `fetchHfFile` 単体の 404 伝播も未テスト。
- 根本原因: 失敗パスのテスト不足（タウトロジーではないが、正常系のみ）。
- 追加すべきテスト:
  - `fetchHfFiles({repo}, {a:"a.bin", b:"missing.bin"})` で b が 404 を返すハンドラ →
    全体が reject し message に `HTTP 404` を含むことを検証。
  - あわせて「失敗時、成功した a がキャッシュに残るか否か」の観測（Promise.all は
    他の put を止めないため a は残りうる）を仕様として 1 本で凍結。
- 補足: `fetchHfFile` が可変 ref（`revision` 省略=main）で「解決 → 取得」を 1 呼び出しで
  行う正常経路も直接テストが無い（現状は `fetchHfFiles` 経由でのみ間接被覆）。上記に
  `fetchHfFile({repo}, "a.bin")` の解決→取得フロー（api 1 + resolve 1 の calls 検証）を
  1 本追加すると単体経路も凍結できる。

### W-B-5 🟡 HF 層の self-heal（破損キャッシュ → validate 拒否 → evict → 再取得）が未テスト
- path: 配線 `src/hf/mod.ts:131-154`（buildValidate）→ `fetchResolvedFile:165-173` が
  `validate` として fetchBytes へ渡す / 実行は `mod.ts:100-113`(cache hit 側 validate→evict) /
  テスト不在
- 症状: module doc（`hf/mod.ts:5-7`）と `buildValidate` の doc（`:127-130`）が掲げる
  「`expectedBytes`/`sha256` はキャッシュヒット側にも効き、破損キャッシュは self-heal」
  という **HF 層の看板挙動が未検証**。cache 層（group A）側でヒット時 validate は
  テストされうるが、HF 層の buildValidate 配線が正しく self-heal を駆動する保証が無い。
- 根本原因: 統合失敗パスのテスト不足。タウトロジー回避のため fault injection（壊れた
  バイト列を事前に cache へ put）で検証すべき。
- 追加すべきテスト: ユニーク cacheName の cache に SHA 固定 URL で「壊れたバイト列」を
  `cache.put` → `fetchHfFile({repo,revision:SHA}, {path, sha256:正しい値}, {fetch})` で
  正しい BYTES が返り、fetch が 1 回呼ばれ（再取得された）、cache が正しい内容に置換
  されたことを検証。`expectedBytes` 版も 1 本。

---

## src/testing/mock_fetch.ts（🔵 Low — 情報/ 継続注視）

堅実で最小。テスト専用（publish 除外は `deno.json:26-29` で確認）、本体からの import 無し
（grep 済み）。`chunkedResponse` は group A（`mod.test.ts`）で使用され dead code ではない。
以下は Warning に満たない留保（現状フローでは無害、将来の忠実度メモ）:

- L-B-a: `mockFetch` は第 2 引数 `_init` を捨てる（`:16`）。現状 fetch 呼出は全て単一引数
  GET（`mod.ts:116`, `hf/mod.ts:88`, `fetchResolvedFile` 経由）なので method/headers を
  検証したいテストは書けないが実害なし。将来 auth ヘッダ等を DI で検証したくなったら
  `_init` を calls に含める拡張が要る。
- L-B-b: `Promise.resolve(handler(url))`（`:19`）は handler が同期 throw すると fetchImpl
  自体が同期 throw する（本物の fetch は reject を返す）。テストは依存していないが忠実度の留保。
- L-B-c: 再利用時 body consume — ハンドラが「クロージャに捕捉した単一 Response」を返すと
  2 回目の消費で失敗しうる。現行テストは毎回 `new Response(...)` を handler 内で生成する
  ため無害（`hf/mod.test.ts:96,171,202` 等）。仕様として「handler は呼出毎に fresh Response を
  返すこと」を doc へ 1 行明記すると誤用を防げる（推奨だが必須でない）。
- 良い点: `uniqueCacheName`（`:42`）で cacheName ユニーク性を担保し、後始末は各テストの
  `finally { caches.delete }` が行う（`hf/mod.test.ts` 全 cache テストで遵守を確認）。
  ネット非依存・実 Cache API 使用の規約に整合。

---

## 重要フロー: HF ダウンロードの URL 構築 → cache 層呼び出し（行番号併記）

```
fetchHfFile(ref, file, opts)                                   hf/mod.ts:183
  └─ resolveHfRevision(ref, {fetch})                           hf/mod.ts:76
       ├─ isCommitSha(revision)? → passthrough（network 無し）  hf/mod.ts:81 / 51
       └─ GET {hub}/api/{API_SEGMENT[kind]}/{repo}/revision/{revision}
       │                                                        hf/mod.ts:84-88
       │        ▲ revision / repo が RAW（未 encode）  …… W-B-1
       │        ├─ !response.ok → throw "HTTP {status} ({url})" hf/mod.ts:89-93  ← 未テスト W-B-3
       │        └─ json.sha (string & 非空) else throw          hf/mod.ts:94-98
       └─ 返り値 = 不変 SHA
  └─ fetchResolvedFile(ref, SHA, spec, opts)                   hf/mod.ts:157
       ├─ url = hfResolveUrl({...ref, revision:SHA, path})     hf/mod.ts:163 / 60-67
       │        ▲ path / hubUrl が RAW（未 encode/正規化）…… W-B-2（#/? で別ファイル・キー割れ）
       ├─ validate = buildValidate(spec)  (expectedBytes/sha256) hf/mod.ts:131-154 / 165-173
       └─ fetchBytes(url, {cache:true, cacheName, validate, onProgress, fetch})
                                                                hf/mod.ts:165-173 → mod.ts:91
            ├─ cache.match(url) hit → validate → 失敗なら evict→再取得(self-heal)
            │                                                    mod.ts:100-113  ← HF 配線未テスト W-B-5
            ├─ GET url; !ok → throw HTTP {status}               mod.ts:116-121  ← HF 伝播未テスト W-B-4
            ├─ readBody + onProgress({...progress, path})       mod.ts:122 / hf:169-172
            └─ validate(bytes) ok → cache.put(url, Response)    mod.ts:123-128（不正物は put しない）

fetchHfFiles(ref, files, opts)                                 hf/mod.ts:196
  └─ resolveHfRevision(ref) を 1 回だけ（SHA 共有）             hf/mod.ts:201  （テスト済 :167-198）
  └─ Promise.all( names.map → fetchResolvedFile(ref, SHA, spec) )  hf/mod.ts:204-211
        └─ 1 つでも reject → 全体 reject（fail loud）           hf/mod.ts:195 doc ← 未テスト W-B-4
```

キャッシュキーの一意性: 取得 URL は常に `{hub}/{prefix}{repo}/resolve/{SHA}/{path}` で
revision は解決済み不変 SHA。ライブラリは query を一切付けないため、正常入力では
キャッシュキーは SHA ベースで安定（＝重複ダウンロードしにくい良い設計）。割れる余地は
**呼び出し側 path の非正準形/特殊文字のみ**（W-B-2）。

---

## 横断所見

- 依存方向 ✅: `hf/mod.ts:12` が `../mod.ts` のみ import。cache 層に HF 固有知識なし
  （`mod.ts` に hf 語彙なし）。一方向・narrow interface を維持。🟢 相当。
- 依存ゼロ ✅: `crypto.subtle`（`hf/mod.ts:110-125`）・`fetch` のみ。実行時依存なし。
  `@std/assert` はテスト専用（`deno.json:9-11`）。
- fail-loud ✅（主要経路）: sha 欠落（`:95-98`）/ HTTP エラー（`:89-93`, `mod.ts:117-121`）/
  crypto.subtle 不在（`:111-115`）/ 検証不一致（`:141-152`）で throw。`response.json()` の
  `as { sha?: unknown }`（`:94`）は境界での最小 cast で、直後に型ガードで fail-loud。
  Zod 不採用は依存ゼロ規約と整合（適切）。
- 型安全 ✅: `as` は境界の不可避 3 箇所のみ（`:94` json, `:203` Object.keys, `:213`
  fromEntries）で各々コメント付き。`any`/`@ts-ignore` 無し（grep 済）。`export` 型は
  明示。`??` 使用（`||` 誤用なし）。
- 認証の欠如（要判断 / needs-human）: private/gated repo 用の Authorization ヘッダを
  渡す口が無い。401/403 は汎用 HTTP エラーに丸められ取得不可。`fetch` DI でユーザが
  自前ヘッダ付き fetch を注入すれば回避可能なので「設計上の意図的制約」の可能性が高い
  → `docs/limitations.md` 候補として要判断（バグではない）。
- `fetchResolvedFile` は `cache:true` 固定（`:166`）で HF 層からキャッシュ無効化不可。
  SHA 固定 URL は不変ゆえ妥当な設計判断だが、明示コメントは無い（Low）。
- コメント vs 実装: 概ね一致。ただし `hf/mod.ts:58` の「path は encode しない前提」は
  `#`/`?`/正準化の落とし穴まで免責しておらず、W-B-2 の対応時に更新が必要。
- dead code / 未使用 export / 後方互換 glue: 検出なし。`chunkedResponse` は group A で使用。
  hack マーカー（TODO/FIXME/HACK 等）0 件（grep 済）。
- テスト規約: ネット非依存（全て DI fetch）・実 Cache API + ユニーク cacheName + finally
  後始末を全 cache テストで遵守。t-wada スタイル（`Deno.test` の記述的タイトルで振る舞いを
  記述）。不足は失敗パス（W-B-3/4/5）。既存 assertion にタウトロジーは見当たらない
  （sha256/expectedBytes 不一致は fault injection 的で妥当）。
