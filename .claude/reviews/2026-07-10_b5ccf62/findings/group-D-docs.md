---
id: D
topic: docs-consistency
files_reviewed:
  - README.md
  - CLAUDE.md
  - LICENSE
  - src/mod.ts
  - src/hf/mod.ts
  - src/testing/mock_fetch.ts
  - deno.json
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
  - scripts/bump.ts
  - scripts/verify_tag.ts
  - scripts/config_version.ts
  - scripts/release_tag.ts
  - scripts/version_sync.test.ts
  - src/mod.test.ts
  - src/hf/mod.test.ts
  - .gitignore
date: 2026-07-10
model: sonnet
commit: b5ccf62
scope: README.md / CLAUDE.md / LICENSE と実装（src/*, deno.json, workflows, scripts）の突合（読み取り専用レビュー）
---

# Group D — ドキュメント整合（README / CLAUDE.md / LICENSE vs 実装）

## サマリ

README の主張はほぼ全て実装と一致し、意図的な「実装挙動依存で仕様保証ではない」旨の
ラベリング（HF revision 解決 API）も hf/mod.ts のコード内コメントとほぼ同一文言で
再掲されており、記述品質は高い。CLAUDE.md も Layout / Commands / Conventions を全項目
実地検証（`deno task check` 実行含む）した結果、乖離ゼロ。LICENSE も deno.json の
`license: "MIT"` と完全一致。

一方で 2 種類の実害級/中度の問題を検出した。

1. **README の TypeScript コード例 3 箇所（41, 47, 63 行目）が未定義変数 `url` を参照**
   しており、各コードブロックを単独でコピペすると `Cannot find name 'url'` でコンパイル
   ・実行に失敗する（E-D-1、🟠 Error 相当）。
2. **HF 層（`./hf`）のキャッシュ既定名前空間（`fetch-cache-hf`）が汎用層の既定
   （`fetch-cache`）と異なる**ことが README に一切書かれておらず、「キャッシュ管理 API」
   節の例をそのまま HF 層に適用すると期待通りに全消去できない（W-D-1）。ほか、
   ブラウザ向けインストール手順の欠落（W-D-2）、`fetchHfFiles` の部分キャッシュ副作用
   未記載（W-D-3）、path/revision の URL エンコード前提未記載（W-D-4、実装側の同種
   問題は group B が W-B-1/W-B-2 として既に指摘済みで相互補強）を Warning として検出。

`deno task check`（fmt --check + lint + deno check + `deno test --allow-read`）を実際に
実行し、26 passed / 0 failed / 1 ignored を確認。これにより CLAUDE.md の Commands 記述、
および README の「現行 Deno は `Cache.keys()` 未実装のため `listCachedUrls` は throw する」
という NOTE を実行時証跡付きで検証できた（`git tag -l` が空であることも「未リリース」
主張の裏付けとして確認済み）。

**verdict 内訳**（主張突合テーブル 45 行、README 35 + CLAUDE.md 10）: accurate 41 /
drifted 3 / stale 0 / unverifiable 1。

## ファイル別分類

| File | 分類 | 主因 |
| --- | --- | --- |
| README.md | 🟠 Error | E-D-1（コード例 3 箇所が未定義変数 `url` でコピペ即壊れ）。加えて W-D-1〜W-D-4 の情報欠落 |
| CLAUDE.md | 🟢 Safe | Layout / Commands / Conventions 全項目を実装・`deno task check` 実行で確認、乖離なし |
| LICENSE | 🟢 Safe | deno.json の `license: "MIT"` と完全一致、標準 MIT 全文 |

---

## 主張別突合テーブル（README.md）

| # | 主張 | README 行 | 実装 path:line | verdict | 備考 |
| --- | --- | --- | --- | --- | --- |
| 1 | パッケージ名 `@hdae/fetch-cache` | 1 | deno.json:2 | accurate | |
| 2 | 英語 tagline（zero-dependency, URL-keyed, Web Cache API） | 3-4 | src/mod.ts:1-9 | accurate | |
| 3 | 日本語説明（検証フック/self-heal/HF層概要） | 6-9 | src/mod.ts:1-9, src/hf/mod.ts:1-9 | accurate | |
| 4 | 特徴: 依存ゼロ（Web標準APIのみ） | 13 | src/mod.ts:9, deno.json:9-11（`@std/assert` はテスト専用import） | accurate | |
| 5 | 特徴: `fetchBytes(url)` でキャッシュ・再利用、`cache:false`で素fetch | 14-15 | src/mod.ts:91-130, 22-23, 97 | accurate | |
| 6 | 特徴: 検証と self-heal（不正物は非キャッシュ、破損はevict） | 16-17 | src/mod.ts:100-129 | accurate | mod.test.ts:53-100 で実証済み |
| 7 | 特徴: 進捗コールバック（totalはcontent-lengthがある時のみ） | 18-19 | src/mod.ts:17, 38-78 | accurate | |
| 8 | 特徴: HF層（可変ref→SHA解決、expectedBytes/sha256、並列取得） | 20-21 | src/hf/mod.ts:69-99, 127-154, 196-214 | accurate | |
| 9 | 特徴: 全取得関数が fetch DI を受け付ける | 22 | src/mod.ts:33,96; src/hf/mod.ts:78,87,106 | accurate | 使い方セクションに `{ fetch: ... }` の実例は無い（後述: 無い情報） |
| 10 | インストール `deno add jsr:@hdae/fetch-cache` | 26-28 | deno.json:2（name） | accurate | 構文は正しいが `git tag -l` が空＝未リリースにつき現時点では JSR 未公開で解決不能（時期依存の注記であり乖離ではない） |
| 11 | `import { fetchBytes } from "@hdae/fetch-cache"` | 35 | deno.json:5-8（exports "."）→ src/mod.ts | accurate | |
| 12 | `const bytes = await fetchBytes("https://…")` 戻り値 `Uint8Array` | 38 | src/mod.ts:91-94（`Promise<Uint8Array>`） | accurate | |
| 13 | `const fresh = await fetchBytes(url, { cache: false })` | 41 | src/mod.ts:19-23 | drifted | シグネチャ自体は正しいが `url` がこのコードブロック内で未宣言（E-D-1）。実装との不一致ではなく README 内部の自己矛盾 |
| 14 | 進捗/validate コードブロック全体 | 46-53 | src/mod.ts:29-31 | drifted | 型・意味は正しいが `url` 未宣言（E-D-1 継続）。かつ `fetchBytes` の import も本ブロック単体には無い（前セクションからの暗黙継続として許容範囲） |
| 15 | validate/self-heal 説明文（キャッシュ読出しにも適用、network失敗はthrowのみ） | 55-56 | src/mod.ts:83-89, 105-113, 124 | accurate | |
| 16 | `import { clearCache, evictUrl, listCachedUrls } from "@hdae/fetch-cache"` | 61 | src/mod.ts の該当export名 | accurate | |
| 17 | `await evictUrl(url)` — 削除、あったらtrue | 63 | src/mod.ts:136-143 | drifted | 型・意味は正しいが `url` 未宣言（E-D-1 継続） |
| 18 | `await clearCache()` 既定 `"fetch-cache"` | 64 | src/mod.ts:36, 149-154 | accurate | |
| 19 | `await listCachedUrls()` | 65 | src/mod.ts:169-181 | accurate | 現行Deno環境では必ずthrowする点はこの節単体では読み取れず、106〜112行目のNOTEで別途補足（後述） |
| 20 | `import { fetchHfFile, fetchHfFiles } from "@hdae/fetch-cache/hf"` | 71 | deno.json:5-8（exports "./hf"）→ src/hf/mod.ts | accurate | |
| 21 | `fetchHfFile(ref, file, opts)` シグネチャ・呼び出し例 | 75-79 | src/hf/mod.ts:183-190 | accurate | |
| 22 | `fetchHfFiles(ref, files, opts)` シグネチャ・戻り値・並列 | 82-89 | src/hf/mod.ts:196-214 | accurate | `files.dict` の型 `Uint8Array` も正しい |
| 23 | `expectedBytes`/`sha256` が汎用層の `validate` フックとして実装、キャッシュヒット側にも効く | 92-93 | src/hf/mod.ts:127-154 | accurate | |
| 24 | resolveHfRevision NOTE（実装挙動依存・sha無ければthrow） | 95-96 | src/hf/mod.ts:73-75, 94-97 | accurate | コード側コメントとほぼ同一文言で再掲、良い一貫性 |
| 25 | ランタイム表: ブラウザ＝Cache Storage（origin単位、Secure Context: https/localhost） | 100-102 | （本リポジトリ外・Web platform仕様） | unverifiable | Web標準の一般知識であり本コードでは検証不能。自動ブラウザテストも無い |
| 26 | ランタイム表: Deno＝Cache Storage（ローカル永続） | 103 | src/mod.ts 全体の `caches` 使用 | accurate | |
| 27 | ランタイム表: Node.js＝`caches`が無いためskipし素fetch | 104 | src/mod.ts:97, 140, 152, 172（`typeof caches !== "undefined"` feature-detect） | accurate | 実装は汎用フォールバックでNode固有分岐ではないが、前提（現行Node.jsにグローバル`caches`が無い）は妥当。自動テストは無し |
| 28 | caches無し環境: fetchBytesは素fetch（validate同様適用）、evictUrl/clearCacheはfalse、listCachedUrlsは`[]` | 106-108 | src/mod.ts:97, 116-124, 140, 152, 172 | accurate | |
| 29 | NOTE: 現行DenoはCache.keys()未実装のためlistCachedUrlsはthrow | 110-112 | src/mod.ts:156-181 | accurate | `deno task check` 実行で実証済み（該当テストが非ignoreでpass、Deno 2.8.3） |
| 30 | version真実源=deno.json、公開VERSIONは焼き込みコピー、bumpが1コミット同期 | 116-118 | deno.json:3, src/mod.ts:14, scripts/bump.ts全体 | accurate | |
| 31 | drift検出＝version_sync.test.ts（deno task checkに含む）＋verify_tag.ts | 117-118 | scripts/version_sync.test.ts, deno.json:13, scripts/verify_tag.ts | accurate | |
| 32 | `deno task bump patch` 例（0.1.0→0.1.1、1コミット、tag/pushはしない） | 120-122 | deno.json:3（version "0.1.0"）, src/mod.ts:14, scripts/bump.ts:89-103 | accurate | 現在の実バージョンと整合 |
| 33 | 公開手順1-3（bump→push→タグ→Release→release.yml起動→タグ検証→JSR publish OIDC） | 124-129 | .github/workflows/release.yml 全体, scripts/verify_tag.ts, scripts/release_tag.ts | accurate | |
| 34 | リンク `.github/workflows/release.yml` | 128 | .github/workflows/release.yml（実在確認済み） | accurate | |
| 35 | ライセンス MIT（LICENSE） | 133 | deno.json:4（`"license": "MIT"`）, LICENSE全文 | accurate | |

## 主張別突合テーブル（CLAUDE.md）

| # | 主張 | CLAUDE.md 行 | 実装 path:line | verdict | 備考 |
| --- | --- | --- | --- | --- | --- |
| a | Layout: src/mod.ts＝`.`エントリ（fetchBytes/evictUrl/clearCache/listCachedUrls/VERSION焼き込み） | 9-10 | src/mod.ts:14, 91, 136, 149, 169 | accurate | |
| b | Layout: src/hf/mod.ts＝`./hf`エントリ、cache層の上に実装 | 11 | src/hf/mod.ts:12（`import { fetchBytes } from "../mod.ts"`） | accurate | |
| c | Layout: src/testing/＝テスト専用mock fetchヘルパ（publish対象外） | 12 | deno.json:26-29（`publish.exclude: ["src/**/*.test.ts","src/testing/**"]`） | accurate | |
| d | Layout: scripts/＝version単一真実源+driftガード一式（bump/verify_tag） | 13 | scripts/bump.ts, verify_tag.ts, config_version.ts, release_tag.ts | accurate | |
| e | Commands: `deno task check`＝fmt(check)+lint+deno check+test | 17 | deno.json:13 | accurate | 実行して確認: 26 passed / 0 failed / 1 ignored |
| f | Commands: `deno task bump <patch\|minor\|major>`＝deno.json+src/mod.tsのVERSIONを1コミットで同期 | 18 | deno.json:14, scripts/bump.ts | accurate | |
| g | Conventions: 依存ゼロMUST（fetch/caches/crypto.subtle/TextEncoder等）、`@std/assert`はテスト専用 | 21-22 | deno.json:9-11, src/mod.ts:9, src/hf/mod.ts:111,116（crypto.subtle使用） | accurate | `TextEncoder` は例示のみで src では未使用（`scripts/bump.ts` に `TextDecoder` はあるが script側でありsrc外）。Low: 例示と実使用の軽微な不一致だが「等」の一例に過ぎず乖離とはしない |
| h | Conventions: ネットワークに出るテスト禁止・fetchはDI・Cache APIは実物+ユニークcacheName+後始末 | 24-25 | src/testing/mock_fetch.ts全体, src/mod.test.ts / src/hf/mod.test.ts の try/finally パターン全体 | accurate | |
| i | Conventions: Fail loudly（破損はevict→self-healが正規経路） | 27 | src/mod.ts:109-113, 156-181 | accurate | |
| j | Conventions: 未リリースなのでmigration/後方互換shimは書かない、breaking change可 | 29 | （リポジトリ状態） | accurate | `git tag -l` が空＝タグ無し。実際に未リリース状態と確認 |

---

## README に無いが必要な情報

実装（コードコメント含む）には存在するが README に記載が無い、利用者にとって重要な情報。

1. **HF層のキャッシュ既定名前空間が汎用層と異なる**（`src/hf/mod.ts:36` = `"fetch-cache-hf"` vs
   `src/mod.ts:36` = `"fetch-cache"`）。README「キャッシュ管理 API」節はこの分離に触れていない
   （→ W-D-1、詳細後述）。
2. **ブラウザ / Node.js 向けのインストール・import 手順が無い**。README のインストール節は
   `deno add jsr:...`（Deno専用）のみで、"Deno / ブラウザ両対応" を謳いながらブラウザ側の
   導入方法（バンドラ経由 / JSR npm互換 / CDN 等）が書かれていない（→ W-D-2）。
3. **`fetchHfFiles` の全体 reject 時に個別ファイルの部分キャッシュが残る副作用**が未記載
   （`src/hf/mod.ts:196-214`、`Promise.all` は失敗しても他の成功済みfetchのcache.put副作用を
   取り消さない）。README・コード両方にこの副作用の明示は無いが、利用者のリトライ設計に
   直結するため要注記（→ W-D-3）。
4. **HFのURL構築が repo/revision/path をエンコードしない前提**
   （`src/hf/mod.ts:58` コメント「path は URL エンコードしない前提」）。README には一切言及が
   無く、特殊文字を含む path/revision を渡した際の挙動が利用者に伝わらない（→ W-D-4。
   実装側の同種問題は group B が `W-B-1`/`W-B-2` として `src/hf/mod.ts:84-88` 等に既に指摘
   済みで、ドキュメント面からも独立に同じ懸念に到達）。
5. **`fetch` DI の具体例が使い方セクションに一切無い**。Features 箇条書き（README:22）で
   謳っているにもかかわらず、`{ fetch: customFetch }` を実際に渡すサンプルコードが無い
   （テストコードにのみ存在: `src/mod.test.ts`, `src/hf/mod.test.ts`）。
6. **`fetchBytes` の `cacheName` オプションの使用例が無い**（`src/mod.ts:20-21`）。
   `clearCache`/`listCachedUrls` の既定値説明にのみ間接的に現れるが、`fetchBytes` 呼び出し側で
   カスタム名前空間を指定する具体例は README に無い。
7. **`HfRepoRef` の既定値のうち `kind`（既定 `"model"`, `src/hf/mod.ts:20`）と `hubUrl`
   （既定 `"https://huggingface.co"`、ミラー差し替え可能, `src/hf/mod.ts:23-24`）が README に
   明示されていない**。特に `hubUrl` によるミラー差し替え機能自体が README のどこにも
   登場しない（Features・使い方いずれにも記載なし）。
8. **`isCommitSha` / `hfResolveUrl` / `resolveHfRevision` は公開export だが README で
   直接使う関数として紹介されていない**（`resolveHfRevision` はNOTE内で名前のみ言及）。
   revision を fetch なしで解決したいだけのユースケースに使える公開ユーティリティだが
   存在が伝わらない。
9. **`VERSION` export（`src/mod.ts:14`）が README に一切登場しない**。「リリース/bump」節で
   `src/mod.ts` の VERSION 焼き込みには触れているが、利用者が `import { VERSION }` で
   参照できる公開値であることは書かれていない。
10. **HTTPエラーメッセージの固定フォーマット**（`` fetch-cache: HTTP {status} {statusText}
    ({url}) ``、`src/mod.ts:117-121`, `src/hf/mod.ts:89-93`）が README に無い。エラーハンドリング
    でメッセージ文字列に依存したい利用者向けに有用（優先度低）。
11. **ブラウザの Cache Storage は容量圧迫時にブラウザ判断でエントリを LRU 的に破棄しうる**
    という一般的な制約への言及が無い。README冒頭は「モデル・辞書のような大きめのアセット」
    を想定用途として明言しており（README:7-8）、大容量キャッシュほど evictionの影響を
    受けやすいため、`navigator.storage.persist()` 等の永続化 API との関係を一言注記する価値が
    ある（コード側にも該当コメント無し。Web platform一般知識としての追記提案）。
12. **ブラウザから HuggingFace Hub への `fetch` が対象オリジンの CORS 設定に依存する**旨の
    注記が無い（コード側にも CORS 関連コメント無し、確認済み）。`./hf` 層をブラウザから
    使う際に問題化しうる外部要因のため、既知の制約として開示する価値がある。
13. **自動テストは `deno test` のみでブラウザ環境のテストは無い**（`deno.json:13`）。
    README のランタイム対応表は Deno / ブラウザ / Node.js を並列に扱っているが、実際に
    CI で検証されているのは Deno のみ（`.github/workflows/ci.yml:22`）。

---

## Warning 以上の詳細指摘

### E-D-1 🟠 README のコード例 3 箇所が未定義変数 `url` を参照（コピペで即壊れる）
- 該当箇所: README.md:41（`fetchBytes(url, { cache: false })`）, README.md:47
  （`fetchBytes(url, {...})`）, README.md:63（`evictUrl(url)`）
- 症状: いずれも独立した ```typescript フェンスコードブロックの中で `url` を宣言せず
  参照している。README.md:38 の直前の例では文字列リテラル `"https://example.com/..."`
  を直接渡しており `url` という変数は一度も定義されない。各ブロックを単独でコピペすると
  TypeScript コンパイルエラー（`Cannot find name 'url'`）ないし実行時 `ReferenceError` になる。
- 根本原因: 「使い方」節の各サブセクションが暗黙に前の例の文脈（`url` 変数が存在する体）を
  引き継ぐ書き方になっているが、見出し・コードブロックで区切られているため独立した例として
  読まれる。HFレイヤーの例（README:70-90）は自己完結しておりこの問題は無い＝汎用層の節
  だけがこの欠陥を持つ。
- 影響範囲: 「使い方」節全体（README.md:32-66）のうち3ブロック。ユーザーが最初に触る
  quick-start コードがそのまま動かない。
- 推奨: 各コードブロックの先頭で `const url = "https://example.com/assets/model.onnx";` 等を
  明示するか、1つの連続したコードブロックとして結合する。

### W-D-1 🟡 HF層の既定キャッシュ名前空間が汎用層と異なることが未記載
- 該当箇所: README.md:58-66（「キャッシュ管理 API」節）↔ src/mod.ts:36
  （`DEFAULT_CACHE_NAME = "fetch-cache"`）↔ src/hf/mod.ts:36
  （`DEFAULT_CACHE_NAME = "fetch-cache-hf"`）
- 症状: README の「キャッシュ管理 API」節は `evictUrl` / `clearCache` / `listCachedUrls` を
  汎用層のAPIとしてのみ紹介し、既定名前空間 `"fetch-cache"` を明記する（README:64）。
  一方 `fetchHfFile`/`fetchHfFiles` は内部で既定 `"fetch-cache-hf"` という別名前空間を使う
  （src/hf/mod.ts:157-174 の `fetchResolvedFile` が `cacheName: opts.cacheName ??
  DEFAULT_CACHE_NAME` で自身の `DEFAULT_CACHE_NAME` を使う）。
- 実害: 利用者が `await clearCache()` を「全キャッシュを消す」つもりで呼んでも、HF層経由で
  取得したファイルは `"fetch-cache-hf"` 名前空間に残ったままになる。同様に
  `listCachedUrls()` の既定呼び出しは HF ファイルを一覧に含めない。
- 推奨: 「キャッシュ管理 API」節または「HuggingFace 層」節に、既定名前空間が層ごとに
  分離されている旨（および HF層のキャッシュを掃除するには `clearCache("fetch-cache-hf")`
  等が必要な旨）を明記する。

### W-D-2 🟡 ブラウザ向けインストール手順の欠落
- 該当箇所: README.md:24-28（「インストール」節）
- 症状: README冒頭で "Deno / ブラウザ両対応" を明言（README:3-4, 6）しているにもかかわらず、
  インストール節は `deno add jsr:@hdae/fetch-cache` という Deno CLI 専用コマンドのみを示す。
  ブラウザ利用者がどうやってこのパッケージを取得・importすればよいか（バンドラ経由の
  `npx jsr add` 相当、CDN経由URL import等）が一切書かれていない。
- 推奨: ブラウザ/Node.js 向けの入手経路（JSR の npm互換インストールないしCDN例）を追記する。

### W-D-3 🟡 `fetchHfFiles` の部分キャッシュ副作用が未記載
- 該当箇所: README.md:81-89（`fetchHfFiles` 使用例）↔ src/hf/mod.ts:196-214
- 症状: `fetchHfFiles` は `Promise.all` で全ファイルを並列取得し、1つでも失敗すれば全体が
  reject する（hf/mod.ts:194-195のdocstringに明記）。しかしこれは「全て成功か全て失敗か」を
  意味しない。既に成功した個別ファイルは `fetchBytes` 内部の `cache.put`（src/mod.ts:125-128）
  によって既にキャッシュへ書き込まれた後で全体 reject が発生しうるため、失敗後の再試行時に
  一部ファイルだけ即キャッシュヒットする挙動になる。README にはこの非対称性の言及が無い。
- 推奨: 「HuggingFace 層」節に、`fetchHfFiles` が全体 reject 時でも成功済みファイルの
  キャッシュ副作用は取り消されない旨を一文追記する。

### W-D-4 🟡 path/revision の URL エンコード前提が未記載
- 該当箇所: README.md 全体（該当記載なし）↔ src/hf/mod.ts:58
  （`hfResolveUrl` コメント「path は URL エンコードしない前提（HF のパスは素の相対パス）」）
- 症状: `hfResolveUrl` / `resolveHfRevision` は `repo` / `revision` / `path` をエンコードせず
  生の文字列補間で URL を組み立てる。特殊文字（スラッシュを含む revision、`#`/`?`を含む
  path等）を渡すと意図しない URL・キャッシュキー分裂が起こりうるが、README にはこの前提の
  注記が全く無い。
- 相互補強: 同じコード箇所の実装リスクは group B のレビューが `W-B-1`（`src/hf/mod.ts:84-88`）
  ・`W-B-2`（path/hubUrl側）として既に指摘済み。ドキュメント側からも独立に同じ懸念に
  到達しており、実装修正とREADME追記の両方が必要な可能性が高い。
- 推奨: 「HuggingFace 層」節に、`repo`/`revision`/`path` は URL エンコードされない生の
  相対パスとして扱われる旨を注記する（実装側の対応要否は group B の指摘に委ねる）。

---

## README の現構成（見出しレベル付きアウトライン）

```
# @hdae/fetch-cache                                  (h1, README.md:1)
## 特徴                                               (h2, :11)
## インストール                                        (h2, :24)
## 使い方                                              (h2, :30)
### 汎用層（`.`）                                       (h3, :32)
### 進捗と検証（self-heal）                              (h3, :44)
### キャッシュ管理 API                                  (h3, :58)
### HuggingFace 層（`./hf`）                            (h3, :68)
## ランタイム対応                                       (h2, :98)
## リリース / bump                                     (h2, :114)
## ライセンス                                           (h2, :131)
```

ASCII図: 該当なし（README中に図表は無い。ランタイム対応の1つのMarkdownテーブルのみ）。

補足（英語化リライトに向けた構造メモ）: 冒頭の1文（README.md:3-4）のみ英語で、
タイトル行を除く残り全文（見出しラベル含む）が日本語。英語化リライト時は見出し
テキスト・表のヘッダ・全コメント文言まで含めて書き換え範囲になる点に留意。
