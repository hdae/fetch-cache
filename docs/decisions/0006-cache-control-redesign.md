# 0006 — キャッシュ制御 API の再設計: 配列 `key`・sha256 記録ハッシュ・`cacheName` 撤去

- 日付: 2026-08-25
- 状態: 採用（2026-08-25 オーナー承認。0.5.0 として実装）
- NOTE: リリース前に [0008](0008-remove-public-key-and-backfill-record.md) が一部を改定:
  §1 の公開 `key` と §4 の `HfFileSpec.key` は撤去（§5 の粒度ポリシーは表現不能化で解消）、
  §2 の「記録の書き足しはしない」は backfill 採用へ反転、Consequences のテスト隔離は
  「ファイル間も逐次（--parallel 禁止）」へ訂正。
- 関連: [0002](0002-request-init-passthrough.md)（キー = URL の出発点）/
  [0004](0004-single-flight-raw-sharing.md)（合流キー）/
  [0005](0005-streaming-prefetch-and-verified-marker.md)（印・streaming prefetch）/
  [0007](0007-explicit-expected-bytes-fail-loud.md)（明示 expectedBytes の fail loud）

## Context

このライブラリの実態は「応答をキャッシュする」ではなく**「キャッシュをコントロールする」**で
あり、制御には 4 つの軸がある: **キー**（何をもって同一とするか）/ **鮮度**（いつ network に
出ずヒットを信じるか — ノーヒント・304・HashSum の 3 モード）/ **完全性**（バイトは壊れて
いないか）/ **寿命**（エントリはいつ死ぬか）。

実案件で起きていた問題は「HuggingFace の README 更新だけで revision（コミット SHA）が動き、
バイト不変のファイルまで再ダウンロードになる」。第一次対応の `cacheKey: string`（取得元 URL
とキーの分離。旧 0006、未リリースのまま撤収 — `archive/cachekey-string-draft`）は機構として
は正しかったが、レビューで構造的な穴が出た: キーが「http(s) の絶対 URL」強制であるため
fragment を Cache API が黙って剥がしてキーが衝突する（合流キーは剥がさないため cache と合流で
判定が食い違う）、層間の既定 `cacheName` 食い違い（"fetch-cache" / "fetch-cache-hf"）が読み
戻し導線を静かに壊す、等。いずれも「キーの直列化を呼び出し側が所有している」ことに起因する。

さらにオーナー要求として ①事前に分かっている SHA-256 でファイル不変を検証したい ②手元の
バイトがその SHA-256 だと分かっていれば再ダウンロードも再ハッシュもスキップしたい ③キャッシュ
の際限ない膨張を抑えたい（寿命）、がある。0.4.0 は公開済みだが、本再設計は **breaking を許容
して 0.5.0 として出す**（オーナー決定。下流 yomi / sbv2-web はオーナー管理）。

## Decision

### 1. キーは配列 — `key?: readonly (string | number | boolean)[]`

`fetchBytes` / `prefetchUrl` に `key` を追加する（省略時は従来どおり URL がキー = 完全互換の
既定）。直列化はライブラリが所有する:

```
https://fetch-cache.invalid/v1/ + key.map(el => encodeURIComponent(JSON.stringify(el))).join("/")
```

- **単射**: 要素毎の JSON 化で `"1"`（文字列）と `1`（数値）を区別し、percent-encode で
  `/` 入り文字列とセグメント境界の衝突（`["a","b/c"]` vs `["a/b","c"]`）を排除する。
- **可逆**: split → decode → `JSON.parse` で元の配列へ完全復元できる（`listKeys` が配列の
  まま返せる。DevTools の Cache Storage でもキーが読める）。
- ホストは RFC 2606 予約 TLD の `fetch-cache.invalid` — 実在 URL と衝突し得ない。`/v1/` は
  直列化方式を将来変えたときの識別子。
- **オブジェクト要素は拒否**（throw）。決定的直列化にはキー順の正準化規約が要り、コストに
  見合わない。要素型の拡張は後からでも非破壊。
- **丸ごと JSON をハッシュ化する案は不採用**: 不可逆になり `listKeys` が意味を失い、
  プレフィックス操作（§3）が不可能になる。
- URL 強制・fragment・正規化の問題クラスは直列化の所有権移動により**構造的に消滅**する
  （旧レビュー IM-03 の根治）。
- 「同一キーを名乗ること = 内容同一という呼び出し側の主張であり、この層は検証しない」
  「同一キーの並行呼び出しは取得元が違っても合流する」という意味論は旧 0006 から維持。
  合流キーは直列化後のキー URL 文字列そのもの（`cacheName` 連結が消え、U+0000 区切りも不要に）。
  合流者のオプションが使われない制約・`caches` DI が合流を分割しない点は従来どおり
  （docs/limitations.md）。`cache: false` と `key` の併用は矛盾として throw（旧 0006 §3 踏襲）。

### 2. `sha256` の一級化と記録ハッシュ — 鮮度判定からハッシュ計算を消す

`fetchBytes` / `prefetchUrl` に `sha256?: string`（64 桁小文字 hex。形式不正は network に
出る前に throw）を追加し、`verifiedMarker` / HF 層 `trustCachedSha256` を廃止して吸収する。

- **保存時**: network 取得物を検証（materialize 経路は native `crypto.subtle.digest`、
  streaming prefetch は純 TS 逐次 — 0005 §5 の分担そのまま）し、通過したバイト列にだけ
  **記録ハッシュヘッダ `x-fetch-cache-sha256`** を焼いて格納する。不一致は throw して
  キャッシュしない（prefetch は stream error で put ごと落とす + 保険 delete — 0005 の
  「印付き不正エントリは構造的に生まれない」を維持）。
- **ヒット時**: 期待 `sha256` と記録ハッシュの**文字列比較のみ**（ハッシュ計算ゼロ）。
  一致 → 採用。不一致 → 内容が変わったものとして self-heal（evict → 取得元から取り直し →
  同じキーへ上書き）。記録が無いエントリ（旧版・無検証 prefetch 由来）は native digest で
  1 回計算して突合する（一致でも記録の書き足しはしない — N バイトの再 put を要するため。
  0005 と同じ判断）。
- **`recheck?: boolean`（既定 false）**: true でヒット時に実バイトを再ハッシュし記録と突合
  する。既定で再検証しないのは「ローカル単一ユーザーの格納を信頼する」判断（0002 の認証
  スタンスと同型）: 格納後の故障は大半が miss として現れ（追い出し・書込み中断）、
  「誤ったバイトが成功ヒットする」に至るのはビット腐敗・実装バグ級のまれな事象のみ。
  疑う運用だけが opt-out する。`recheck` は `sha256` 必須（単独指定は throw）。
  0.4.0 の既定（ヒット毎全量検証）からの**意味論反転**であり、breaking として明記する。
- **カスタム `validate` は常に走る**（記録ハッシュは sha256 の再計算だけを省く）。0005 §4 の
  「印は validate 全体の通過を意味する / prefetch 印は sha256 のみ」という二義性は、印の
  意味を「記録された sha256」に一本化することで解消する。
- 鮮度の将来変種として `revalidate?: boolean`（ETag / Last-Modified の条件付き GET。
  保存時に元レスポンスの当該ヘッダをエントリへ写し取る前提。値は不要 — フラグのみ）を
  同じフラットな置き場に予約する。**0.5.0 では実装しない**。`sha256` との併用は throw。

### 3. `cacheName` 撤去 — 名前空間はキー接頭辞、管理はプレフィックス操作

Cache Storage の名前空間は内部固定 1 個（`"fetch-cache"`）にし、`cacheName` オプションを
全 API から外す。名前空間分けは `["app-name", ...]` のようにキー先頭要素で行う。層別の既定
名前空間（"fetch-cache-hf"）も消え、旧レビュー IM-01 の読み戻し罠が構造的に消滅する。

管理 API は次の形に置き換える:

- `evict(prefix: Key): Promise<number>` — **常にプレフィックス意味論**（完全キーはそれ自身と
  子孫に一致する）。`Cache.keys()` で列挙して復元・前方一致・削除。
- `listKeys(prefix?: Key): Promise<Key[]>` — 配列キーのエントリのみ（直列化を復元して返す）。
- `evictUrl(url)` / `listCachedUrls()` — URL キーのエントリ用（合成 origin を除外）。
  `cacheName` 引数は消える。
- `clearCache(): Promise<boolean>` — 内部名前空間ごと全消去。
- `keys()` 未実装ランタイム（Deno 2.8 以前）では `evict` / `listKeys` は fail loud に throw
  （`listCachedUrls` の既存 limitation と同じ扱い。Deno 2.9+ 前提で問題なしとオーナー確認済み）。

寿命（TTL / LRU sweep）は本 ADR のスコープ外 — 記録ハッシュと同じエントリメタデータ様式の上に
後続 ADR で設計する。それまでの掃除手段はプレフィックス evict。

### 4. HF 層 — revision は取得の関心、キャッシュは内容の関心

- **既定キー**: `spec.sha256` があるとき `["hf", kind, repo, path, sha256]`。
  README 更新だけの revision bump（同内容 = 同キー = ヒット）も revision 切り替え（内容毎に
  エントリが共存）も再ダウンロードしない。`hubUrl` はキーに含めない — 同一内容ならミラーを
  跨いでエントリと合流を共有するのは content-addressed の意図どおり。
  `sha256` が無いときは従来どおり **SHA 固定 resolve URL がキー**（鮮度シグナルが無い以上、
  安定キーにすると stale を恒久的に掴むため。revision 毎にエントリが溜まる点は従来と同じで、
  掃除は寿命軸の管轄）。
- **`HfFileSpec.key?: Key`** で上書き可能（ファイル毎指定なので `fetchHfFile` /
  `fetchHfFiles` / `prefetchHfFile` の 3 API で一貫する。旧 0006 §5 が悩んだ「複数ファイル
  API にオプションレベル単一キーが合わない」問題は置き場所で解消）。
- `trustCachedSha256` は廃止（§2 の既定 trust + `recheck` に吸収。既定の反転を migration に
  明記）。`HfFetchOptions.cacheName` も廃止。それ以外の HF 公開 API（`resolveHfRevision` /
  `hfResolveUrl` / `isCommitSha` / `HfPrefetchResult` 等)は不変。

### 5. キー粒度はポリシーである（文書化必須の注意含む）

| キー                                            | revision bump（内容不変） | revision 切り替え      | ストレージ           |
| ----------------------------------------------- | ------------------------- | ---------------------- | -------------------- |
| revision 入り（URL キー / sha256 無し HF 既定） | 再取得                    | 共存                   | revision 毎に増える  |
| 安定キー（`[..., path]`）+ `sha256`             | ヒット                    | **上書き（ピンポン）** | path 毎 1 個（有界） |
| 内容キー（`[..., path, sha256]` = HF 既定）     | ヒット                    | 共存                   | 使った内容の数だけ   |

**MUST 文書化**: キーに内容識別（sha256 要素等）を入れない安定キー運用では、revision の
指定変更が**同一エントリの上書き**になる — 行き来すると毎回再取得（ピンポン）。有界ストレージ
と引き換えの性質であり、バグではない。docs/limitations.md・`HfFileSpec.key` の JSDoc・
README のキー粒度表に記載する。

## Consequences

- **breaking（0.5.0。移行メモを README に置く）**:
  - `cacheName` 全廃 — 旧名前空間 `"fetch-cache"` の URL キーエントリはそのまま生きるが、
    `"fetch-cache-hf"` は参照されなくなる（`caches.delete("fetch-cache-hf")` を推奨）。
  - `verifiedMarker` / `trustCachedSha256` 廃止 → `sha256` + `recheck`。**既定が「ヒット毎
    全量検証」から「記録ハッシュを信頼」へ反転**。旧ヘッダ `x-fetch-cache-verified` は読まない
    （記録なし扱い → 期待 sha256 があれば 1 回だけ再ハッシュされ、以後は…記録は足されない
    ため毎ヒット計算になる。数 GB 級は取り直しか prefetch での温め直しを推奨）
    〔この括弧内は 0008 §2 で改定 — 一致した初回読み出しで記録を backfill するため
    再ハッシュは 1 回のみ・取り直し不要〕。
  - HF 既定キーの変更により旧エントリはヒットしなくなる（キャッシュなので実害は再取得のみ）。
- 純 TS sha256（src/sha256.ts）は引き続き streaming prefetch 専用。materialize 経路は native。
- HF 層の `buildValidate` から sha256 部分が消え、cache 層の `sha256` へ委譲される
  （expectedBytes の長さ検証とカスタム validate の合成だけが残る）。
- テストの隔離規約が変わる: 「テスト毎ユニーク cacheName + `caches.delete`」→
  「固定名前空間を使い、テスト毎に finally で `caches.delete("fetch-cache")`」
  （ファイル内逐次実行が前提。`deno test` の並列化を導入するならここを見直す）。
- 旧レビュー（.claude/reviews/2026-08-25_6a00aa1/）の教訓を実装要件として持ち込む:
  IM-03（fragment）は設計で消滅するが直列化の単射性テストを置く、TS-002 相当
  （prefetch 保険 delete がキー側に向く）の固定テストを新実装でも必ず書く。
