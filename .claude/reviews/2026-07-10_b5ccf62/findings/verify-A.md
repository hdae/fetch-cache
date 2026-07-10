# verify-A: 敵対的検証結果（V1–V4）

対象: commit b5ccf62 / Deno 2.8.3 実測 + 仕様一次参照。
実験 E1–E6 は本セッションの scratchpad で Deno 2.8.3 上で実行（スクリプト要旨は各節に記載）。

---

## V1: E-A-1 安全側主張「並行 fetchBytes は二重 DL・二重 put になるが corruption は起きない」

**総合 verdict: holds / severity: Safe**（二重 DL・二重 put は実在するコスト。corruption 経路は仕様・実装・実測の三面で否定）

前提の確認（二重 DL・二重 put が起きること自体）: `src/mod.ts:102`（match）から `:127`（put）まで複数の
await を跨ぐため、並行 2 呼び出しは両方 miss を観測して両方 fetch・両方 put する。in-flight dedup は無い。
なお 1 呼び出しで `caches.open` が 2 回走る（`src/mod.ts:101` と `:126`）。

### V1(a) put×put 競合で部分書き込み・混合内容 → **起きない: holds（安全側）**

- **仕様保証**: SW spec `Cache.put` は「Set bodyReadPromise to the result of **reading all bytes** from reader.
  Note: This ensures that ... we have a **full buffered copy** of the body」→ body 全読了の
  fulfillment 後にのみ Batch Cache Operations を起動。Batch Cache Operations は
  「**Try running the following substeps atomically**」+ 例外時 backupCache へ全ロールバック
  （w3c.github.io/ServiceWorker #cache-put / #batch-cache-operations-algorithm）。
  → 各 put はリスト操作として原子的。2 つの put のどちらが勝つか（順序）は未規定だが、勝った方は必ず完全 body。
- **Deno 実装**（v2.8.3 `ext/cache/sqlite.rs`）: put は body ファイルを `flush()`+`sync_all()`（L270-271）
  **完了後に** `INSERT OR REPLACE`（L273-277, L395）。body ファイル名は `hash(url + now.as_nanos())`
  （L245-249）で put 毎に別ファイル → 並行 put は別ファイルへ書き、row 上書きは SQLite の
  `Arc<Mutex<Connection>>` で直列化・単文原子。`UNIQUE(cache_id, request_url)`（L110）で row は常に 1 本。
- **実測 E1**: 同一 URL へ 1MiB×2 内容違いの並行 put を 20 回 → 混合/部分 0 回、常にどちらか一方の完全内容
  （A:7 / B:13）。
- 留保 2 点（いずれも実装挙動依存・実害は corruption でない）:
  1. Deno は REPLACE/delete で旧 body ファイルを消さない（L374 `TODO(@satyarohith): remove the response
     body from disk`）→ 二重 put 毎に orphan ファイルが残る**ディスクリーク**（`caches.delete(cacheName)`
     の `remove_dir_all` まで滞留）。E-A-1 の副作用として一行言及の価値あり（Low）。
  2. 理論穴: 2 put が同一ナノ秒に開始すると body_key 衝突 → 同一ファイルへ交錯書き込み。別 op dispatch が
     同一 `as_nanos()` を引く必要があり実際上到達不能（負値: 実測 20/20 で非発現）。

### V1(b) put 中の match が「存在するが body が途中」の Response を返す → **返さない: holds（安全側）**

- **仕様保証**: 上記の通り put のエントリ追加は body 全読了後の原子的 batch 内。仕様の Note は
  「An implementation could optimize by **streaming directly to disk** rather than memory」と実装最適化を
  許すが、可視化は batch 時点。部分 body の match 可視は仕様上あり得ない。
- **Deno 実装**: match は SQLite row → ファイル open（sqlite.rs L299-357）。row は body fsync 後にしか
  存在しない（V1(a)）ので、row が見えた時点でファイルは完成済み。ファイル NotFound は row を
  best-effort delete して `None`（L344-355）= self-heal 側に倒れる。
- **実測 E2**（streaming body の put を 1 チャンク送信・未 close で 200ms 停止させ match）:
  - 既存エントリ無し → mid-put match = `undefined`、完了後 = 完全 body `[1,1,1,2,2,2]`
  - 既存エントリ有り → mid-put match = **旧完全エントリ** `[9,9]`、完了後 = 新完全 body
  - 部分 body は一切観測されず。

### V1(c) validate 併用時の evict×put 交錯で終端状態異常 → **無い: holds（安全側）**

- 不正エントリの「復活」は構造的に不可能: put されるのは常に `await opts.validate?.(bytes)` 成功後の
  bytes のみ（`src/mod.ts:124-127`）。put 経路に不正物は乗らない（validate が**決定的**である限り —
  これは利用者契約で、非決定的 validate ではこの保証は崩れる）。
- 「正エントリが消える」: あり得るのは一時遷移のみ。
  ```
  B: match(壊) → val✗ → delete → fetch → put(正)
  A: match(壊) → val✗(遅) ────────────────→ delete   ← B の正エントリを削除
                                             → fetch → put(正)  ← 終端は正エントリ
  ```
  A の delete（`src/mod.ts:111`）が B の put 後に着地しても、A は続けて fetch→validate→put するため
  終端状態は「正エントリ」。A の fetch/validate が失敗した場合のみ「エントリ無し」で throw（fail loud）
  → 次回再取得。**終端状態は {正エントリ, 無し} の二値で、不正が残存する終端は存在しない**。
  キャッシュ喪失は「キャッシュ=最適化」の設計上、正しさに影響しない。
- op 単位の原子性（delete が put の内部に割り込まない）は V1(a)(b) の根拠（仕様の atomic batch /
  Deno の SQLite 直列化）で担保。
- NOTE（本所見のスコープ外・一行のみ）: `clearCache` を fetchBytes と並走させた場合、`src/mod.ts:126` の
  open が名前空間を再作成する／Deno では削除済み cache_id へ orphan row を挿す（FK 未強制）等の挙動が
  あるが、いずれも「エントリが静かに消える」側で corruption ではない。

---

## V2: W-A-5「content-length 既知時に loaded != total の短受信を黙って受理するのは欠陥」

**総合 verdict: refuted / severity: Safe が適正**（現設計 = total は advisory・整合性は validate、が正しい。
loaded==total 強制はむしろ誤検知バグを作る）

### 反証仮説 leg1「gzip 透過解凍で content-length は転送（圧縮）サイズを指したまま残る」

- **ブラウザ: holds（仕様保証）**。Fetch spec の HTTP-network fetch 本文:
  「Set bytes to the result of handling content codings given codings and bytes.
  **This makes the `Content-Length` header unreliable to the extent that it was reliable to begin with.**」
  — 解凍は body 側にのみ適用され、header list から Content-Length を除去するステップは仕様に存在しない。
- **さらに強い点（仕様保証）**: CORS-safelisted response-header name は
  `Cache-Control` `Content-Language` **`Content-Length`** `Content-Type` `Expires` `Last-Modified` `Pragma`
  のみ。**`Content-Encoding` は含まれない** → cross-origin では「圧縮サイズの content-length は見えるのに
  gzip であることは検出不能」。つまり「Content-Encoding が無いときだけ equality を強制」という緩和版すら
  ブラウザでは実装不能。loaded==total 強制は健全な gzip 応答を fail させる誤検知バグになる。
- **Deno: refuted（実装挙動依存）**。実測 E5（raw TCP サーバで `content-encoding: gzip` +
  `content-length: 35`（圧縮サイズ）を返却）: Deno 2.8.3 の fetch は自動解凍し、
  `headers.get("content-length")` = **null**、`content-encoding` = **null**、body は解凍後 59B。
  → Deno ではヘッダごと消えるため誤検知は起きないが、検査自体も不発（`readTotal` が undefined を返す）。
  どちらの挙動でも「equality 強制が有益」にはならない。

### 反証仮説 leg2「identity 転送の truncation は fetch がエラーにする（黙認は発生しない）」

- **holds（仕様保証 + 実測）**。
  - Fetch spec: stream の正常 close は「if the bytes transmission for response's message body is
    **done normally**」の場合のみ。それ以外の終了は
    「**Otherwise, if stream is readable, error stream with a TypeError**」。
  - HTTP 側の裏付け: RFC 9112 §8「If the sender closes the connection ... before the indicated number of
    octets are received, the recipient **MUST consider the message incomplete**」、
    HTTP/2 は RFC 9113 §8.1.1 で content-length と DATA 総和の不一致は malformed → stream error MUST。
  - **実測 E6**（`content-length: 100` 宣言・50B 送信で FIN）: Deno 2.8.3 は `reader.read()` が
    50B 読了後に **throw**（"error reading a body from connection"）→ `readBody`（`src/mod.ts:65`）が
    reject → fetchBytes 全体が reject。黙って短受信成功にはならない。
  - 正直な留保を 1 点: ブラウザ側の「truncation → TypeError」は "done normally" 判定を HTTP 層に委譲した
    仕様保証であり、歴史的には黙認する実装バグが存在した（例: 旧 Firefox の Content-Length 不一致検出欠如）。
    現行主要実装（Chrome の ERR_CONTENT_LENGTH_MISMATCH 等）は仕様通り error 側。残余は実装挙動依存。

### 残余の「短受信が黙って成立する」ケースの棚卸し → いずれも equality 強制が誤動作する側

1. lying server が `Transfer-Encoding: chunked` と `Content-Length`（嘘値）を併送 → chunked 枠組みで
   **完全な** body が届き正常終了、content-length だけ不一致。equality 強制はここで**完全なデータを拒否**する。
2. DI した custom fetch / テスト mock（`src/mod.test.ts:104-107` 自身が `content-length: 7` を手書き）→
   合成 Response の content-length は任意で、輸送保証と無関係。
3. 真の truncation は上記 leg2 の通り stream error で既に fail loud。

**結論**: 「短受信の黙認」に実害のある到達経路はほぼ無く、到達可能な残余ケースでは equality 強制の方が
誤検知を生む。整合性検証は validate（hf 層の expectedBytes/sha256, `src/hf/mod.ts:131-154`）に委譲する
現設計が正。修正不要（total が advisory であることの doc 注記は MAY）。

---

## V3: W-A-3「cache I/O 失敗が成功ダウンロードを巻き添えにするのは『キャッシュは最適化』の明文と矛盾」

**verdict: holds（設計テンションとして事実）/ severity: Warning が適正 / 要ユーザー判断**

事実面の確定:

- 巻き添えの実在: `src/mod.ts:126-127` の `caches.open`/`cache.put` の throw は、DL・validate 完了済みの
  `bytes`（`:122-124`）を破棄して fetchBytes 全体を reject する。また `:101-102` の open/match の throw は
  ダウンロード開始前にブロックする（こちらは素の fetch へ degrade する選択肢がある窓）。
- 厳密な読みの留保: `src/mod.ts:6-7, 88-89` の明文は「**caches が無い**ランタイムではフォールバック＝
  キャッシュは最適化」であり、文言の射程は API 不在時に限定。「cache I/O 失敗時も最適化として扱う」は
  明文ではなく**原則からの敷衍**。CLAUDE.md の Fail loudly は「破損・不正データ」対象で、インフラ故障は
  どちらの規約にも明確には割り当てられていない → 純粋な設計判断でありユーザー裁定が必要、という
  W-A-3 の位置づけは妥当。

### (a) ブラウザで cache.put は QuotaExceededError を実際に throw するか → **する（仕様保証）**

SW spec Batch Cache Operations に明文:
「If the cache write operation in the previous two steps failed due to **exceeding the granted quota
limit, throw a QuotaExceededError**」。加えて実装挙動依存の throw（バックエンド破損時の
UnknownError/AbortError 等）も既知。private browsing の低 quota で put 失敗は現実的に起きる。

### (b) Deno の caches が throw する現実的条件（v2.8.3 ext/cache/sqlite.rs、実装挙動依存）

- `storage_open`: cache ディレクトリ `create_dir_all` 失敗（L67-72, L150: 権限・read-only FS）、
  SQLite open/exec 失敗（破損 `cache_metadata.db`）。
- `put`: body ファイルの `File::create`/`poll_write`/`flush`/`sync_all` の I/O エラー
  （L253-271: **ENOSPC（ディスクフル）**・EACCES）、`INSERT OR REPLACE` 失敗。
- `match`: body ファイル open の NotFound **以外**のエラー（L356: 権限等）。NotFound は self-heal
  （row 削除 → None、L346-355）で throw しない。

### (c) 「握りつぶし+通知」を Web 標準のみで実現する選択肢と、3 案の帰結

| 案 | 帰結（2-3 行） |
| --- | --- |
| fail-loud 維持（現状） | quota 超過・ディスクフルという**環境起因**の事象で、取得自体は成功したデータを失う。呼び出し側は原因不明の失敗として再試行し、また同じ put で死ぬ（キャッシュ不能環境では恒久障害化）。「caches 不在なら動くのに、caches が壊れていると動かない」という非対称が残る。 |
| 握りつぶし + 通知フック（`onCacheError?: (e) => void` 等） | データは返り、キャッシュ劣化（次回再 DL）のみ。通知はコールバック（依存ゼロ）か EventTarget（Web 標準）で実現でき、規約の依存ゼロ MUST と両立。既定 no-op にすると「静かな握りつぶし」に退化する点だけが設計上の弱点（既定 console.warn との併用で緩和可）。 |
| 握りつぶし + console.warn | 実装最小で fail-silent は回避。ただし console は仕様上 side-effect 無保証・プログラム的に捕捉不能で、ライブラリとしては行儀が悪い（利用側でミュート/収集ができない）。恒久故障（毎回 warn）を検知する経路がない。 |

補足: 握りつぶす場合も窓で扱いを分けられる — `:101-102`（読み側）の失敗は「miss 扱い」、
`:126-127`（書き側）の失敗は「握りつぶし+通知」。読み側の握りつぶしは self-heal（`:111` evict）まで
スキップしないよう注意が要る。

---

## V4: 「HTTP 非 2xx throw 時に response.body を cancel しないのは Deno でリソースリーク」

**verdict: holds / severity: Low が適正**（実リソース保持は Deno で実証可能。ただし影響はエラー経路の
頻度に比例し、本ライブラリの用途では限定的）

- 対象: `src/mod.ts:116-121` と `src/hf/mod.ts:88-93`。非 ok throw 時に body を consume も cancel もしない。
- **Deno（実測・実装挙動依存)**: 実 fetch の未消費 body はリソースとして残る。実験 E4b:
  ローカル `Deno.serve` への実 fetch を未消費で放置 → サニタイザ有効時に
  「**A fetch response body was created during the test, but not consumed** ... `await resp.body.cancel()`」
  で FAIL（実測）。Deno docs（runtime/test/sanitizers）も I/O リソースは「自動 GC されない」と明言 →
  接続はプールへ返らず、少なくとも即時には解放されない。GC ファイナライザによる遅延回収の有無は未確認
  （**uncertain**）。実害: 非 2xx を大量に踏むループ（例: HF 404 プローブ）でソケット・リソースの滞留。
  1 行の cancel で消せるコストとしては十分見合う。
- **ブラウザ（実装挙動依存）**: 仕様に「未消費 body の解放」規定は無い。実装は Response の GC で
  接続を解放し、小さな 404 body は既に受信バッファ済みのことが多い → 実害は接続再利用の一時阻害程度で軽微。
- **cancel 導入時の注意**:
  1. `response.body` は null があり得る → `response.body?.cancel()`。
  2. throw より**前に** await し、cancel 自体の reject が HTTP エラーを覆い隠さないよう
     `try { await response.body?.cancel(); } catch { /* HTTP エラーを優先 */ }` 形にする
     （un-awaited の reject は unhandled rejection になるため放置も不可）。
  3. 本経路では stream は未 lock・未 disturbed なので通常 reject しない（Streams 仕様上 reject するのは
     locked 時 TypeError と underlying source の cancel 失敗のみ）。
- **現テストがサニタイザに落ちない理由は二重**（両方実測で確認）:
  1. **mock の Response はリソース非依拠**: `mockFetch` は `new Response("missing", {...})`
     （`src/mod.test.ts:151-152`）で、body は JS 内メモリの合成 stream。リソーステーブルに実体が無いので
     漏れるものが無い。実測: サニタイザ**強制 ON**（`DENO_TEST_SANITIZE_OPS=1
     DENO_TEST_SANITIZE_RESOURCES=1 deno test --allow-read`）でも本プロジェクト全 26 テスト green。
  2. **Deno 2.8 からリソース/op サニタイザは既定 OFF**: 対照実験で、素の `Deno.open` リーク・実 fetch
     未消費 body・タイマーリークの 3 種とも既定では green、明示 ON で FAIL（実測）。
     つまり仮に実ネットワークのテストがあっても既定設定では検出されない。

---

## 実験一覧（Deno 2.8.3 / 全て loopback または no-network）

| ID | 内容 | 結果 |
| --- | --- | --- |
| E1 | 同一 URL 並行 put（1MiB×2 内容違い）×20 回 → match 検査 | 混合/部分 0、常に片方の完全内容 |
| E2 | streaming put を途中停止し match（既存無し/有り） | undefined / 旧完全エントリのみ。部分 body 非観測 |
| E4 | 合成 Response 未消費（mock 同型）+ sanitizer ON | green（リソース非依拠の証明） |
| E4b | 素の file リーク / 実 fetch body 未消費 + sanitizer ON | 両方 FAIL（"not consumed" メッセージ実測） |
| E4c | 既定設定でタイマー/リソースリーク | 全て green（Deno 2.8 既定 OFF の証明） |
| E5 | gzip + content-length（圧縮サイズ）を raw TCP で返却 | Deno は解凍し **content-length/encoding ヘッダを削除** |
| E6 | content-length:100 宣言・50B 送信で FIN | `reader.read()` が throw（黙認されない） |
