---
id: A
topic: cache-layer
files_reviewed:
  - src/mod.ts
  - src/mod.test.ts
date: 2026-07-10
model: opus
---

# Group A — cache 層レビュー（src/mod.ts / src/mod.test.ts）

## サマリ（総評 + 件数）

cache 層本体（`fetchBytes` / `evictUrl` / `clearCache` / `listCachedUrls`）は**設計意図が明確で堅い**。
Cache API の body 一回性（読み切った bytes から `new Response(bytes)` を作り直して put）・
validate 成功後にのみ put（不正物を残さない）・self-heal の evict→フォールスルーが線形で
無限ループしない・`??` の正しい使用（`cache: false` を潰さない）・Deno の `keys()` 欠落を
feature-detect して fail loud、いずれも正しい。**依存ゼロ MUST・fail loudly は本体では遵守**。

一方で「並行 fetchBytes の振る舞いが未テスト（かつ重複ダウンロード抑止が無い）」「`readBody` の
null-body 分岐が未テスト」という**分岐・並行を含むテスト不足（分類規約により最低 🟠）**、および
「cache 層の I/O 失敗が成功したダウンロードを巻き添えで throw させる ― 『cache は最適化であり
正しさの要件ではない』という明文設計と衝突」という設計判断案件（needs-human）がある。

件数: 🔴 Critical 0 / 🟠 Error 2 / 🟡 Warning 3 / 🔵 Low 4 / 🟢 Safe 一部。

| Sev | ID | 一行 |
| --- | --- | --- |
| 🟠 | E-A-1 | 同一 URL への並行 `fetchBytes` が未テスト + 重複 DL 抑止（single-flight）が無い |
| 🟠 | E-A-2 | `readBody` の `body === null` フォールバック分岐（L55-60）が全テストで未通過 |
| 🟡 | W-A-3 | cache I/O 失敗（open/match/put の throw）が成功 DL を巻き添えで throw ― 「cache は最適化」明文と衝突（needs-human） |
| 🟡 | W-A-4 | 失敗・境界パスのテスト欠落（self-heal 再取得も不正 / async validate / fetch 例外 / URL オブジェクト入力 / 正常ヒット時 validate 通過） |
| 🟡 | W-A-5 | content-length 既知時の短受信（truncation）を黙って受理（needs-human・by-design 可能） |
| 🔵 | L-A-6 | miss パスで `caches.open` を 2 回（L101, L126）― 軽微な重複 |
| 🔵 | L-A-7 | self-heal の裸 `catch {}`（L109-112）が validate エラーを無記録で破棄 ― 設計上許容 |
| 🔵 | L-A-8 | cache に put する `new Response(bytes)` は元 Response のヘッダを捨てる ― URL→bytes 契約上 by-design |
| 🔵 | L-A-9 | URL/文字列キーの正規化を Request 構築の一貫性に依存 ― put/match 同経路で安全 |

## ファイル別分類テーブル

| File | 分類 | 主因 |
| --- | --- | --- |
| src/mod.ts | 🟡 Warning | 本体ロジックは堅い。cache I/O 失敗の致命化（W-A-3, needs-human）、single-flight 不在（E-A-1 の振る舞い側）、null-body 分岐（E-A-2 の実装側） |
| src/mod.test.ts | 🟠 Error | 既存テストは t-wada スタイルで良質だが、並行（E-A-1）・null-body 分岐（E-A-2）・失敗/境界パス（W-A-4）が未カバー。分類規約「分岐・失敗パス・境界・並行を含むなら🟠」に該当 |

---

## 詳細指摘（Warning 以上）

### 🟠 E-A-1 — 同一 URL への並行 `fetchBytes` が未テスト + 重複ダウンロード抑止が無い
- **path**: src/mod.ts:100-129（fetch/put 経路）, src/mod.test.ts 全体（並行テスト不在）
- **症状**: 同一 `(cacheName, url)` に対する `fetchBytes` を並行に 2 本走らせると、両者とも
  cache miss を観測して**それぞれ network fetch する（二重ダウンロード）**。HF 層（src/hf/mod.ts:165）
  は大容量モデルを本 API 経由で取得するため、重複 DL の実害が大きい。
- **並行性の実スケジューリング粒度での証明**（推測ではなく scheduling model からの導出）:
  - C1: `await caches.open`（L101）で suspend → C2: 同じく suspend。
  - 両者 `await cache.match(requestUrl)`（L102）→ **どちらも `undefined`（miss）を観測**（TOCTOU:
    最初の put が完了する前に両者が match を終える）。
  - 両者 `await fetchImpl(requestUrl)`（L116）→ **network 2 回**（lost dedup）。
  - 両者 `await cache.put(...)`（L127）→ **二重書き込み**。
  - **corruption は起きないことの証明**: `cache.put` は仕様上 1 回が「一致エントリ削除→追加」の
    atomic な Batch Cache Operations であり、2 本の put は直列化されて last-writer-wins で
    エントリ 1 個に収束。両 bytes は同一内容（同一 URL の同一サーバ応答）なので観測結果は不変。
    → **整合性は保たれる。問題は correctness ではなく重複 DL の浪費と未テスト**。
- **根本原因**: in-flight（single-flight）マップが無い。`fetchBytes` は毎回独立に miss→fetch→put を
  実行し、進行中の同一キー要求を合流させる仕組みを持たない。
- **修正案**:
  - (a) `Map<cacheName+"\0"+url, Promise<Uint8Array>>` の in-flight テーブルで single-flight 化し、
    進行中要求へ合流（settle 後に必ず delete）。並行境界を `await` の実挿入点で慎重に設計する
    （lost-wakeup を避けるため、map への登録は最初の `await` より前＝同期区間で行う）。
  - (b) 最小案として「本 API は同一 URL 並行呼び出しをデデュープしない（重複 DL しうる）」を
    docs/limitations.md に明文化し、dedup は呼び出し側責務とする。
  - いずれを採るかは needs-human（ライブラリの責務境界の判断）。
- **追加すべきテスト**:
  - `Promise.all([fetchBytes(URL,{cacheName,fetch}), fetchBytes(URL,{cacheName,fetch})])` で
    `calls.length` を検証（現状 = 2。single-flight 導入後 = 1）。両戻り値の同一性も assert。
  - 並行 self-heal（両者が破損ヒット→両者 evict→取り直し）の収束（最終エントリ 1 個・無限ループ無し）。

### 🟠 E-A-2 — `readBody` の `body === null` フォールバック分岐が全テストで未通過
- **path**: src/mod.ts:55-60（null-body 分岐）, src/mod.test.ts（未カバー）
- **症状**: `readBody` は `response.body === null` のとき `arrayBuffer()` フォールバック＋
  onProgress を**1 回だけ**発火する別経路を持つ（L56-60）。全テストは `mockFetch(() => new Response(BYTES_A))`
  か `chunkedResponse(...)` を使い、いずれも `.body` が非 null の ReadableStream になるため、
  **この分岐は一度も実行されない**。分類規約「分岐…を含むなら 🟠」に該当。
- **到達性（実 runtime で現実的か）**: 現実的。204 No Content・HEAD 応答・`new Response()` /
  `new Response(null)` では `.body === null` になり、この経路（空 bytes・onProgress 1 回・空を put）が
  本番で発火しうる。振る舞い（per-chunk ではなく単発 onProgress、loaded=length）が streaming 経路と
  異なるため、回帰の観測点として価値がある。
- **根本原因**: 分岐追加時にテストが追随していない。mock が streaming body しか生成しない。
- **修正案（テスト側のみ・本体変更不要）**: null-body を返せる mock 経路を testing に足す
  （例: `new Response(null)` を返すハンドラ、または `nullBodyResponse(bytes)` ヘルパ）。
- **追加すべきテスト**:
  - body=null（例 `new Response(BYTES_A.buffer)` ではなく明示的に null body）→ 戻り bytes 正当・
    onProgress が **1 回**（`{loaded, total}`）・キャッシュ round-trip 成立。
  - 空応答（204 相当、bytes.length===0）が空エントリとして put/match されること。

### 🟡 W-A-3 — cache I/O 失敗が成功したダウンロードを巻き添えで throw する（「cache は最適化」明文と衝突）
- **path**: src/mod.ts:101（`caches.open`）, :102（`cache.match`）, :126-127（`caches.open`/`cache.put`）
- **症状**: cache 層の I/O が throw すると `fetchBytes` 全体が reject する。とくに **miss パスの
  L124 で validate を通過し正当な bytes を得た後、L127 の `cache.put` が失敗（quota 超過等）すると、
  ダウンロード自体は成功しているのに呼び出し側はエラーを受け取り bytes を失う**。read 側（L102 の
  `cache.match` throw）も同様に、network へ縮退できるのに全体が落ちる。
- **設計との衝突（正直な留保）**: docstring（src/mod.ts:7, :89）と README:106 は「キャッシュは
  最適化であり正しさの要件ではない」と明文化している。この原則に照らせば、**cache の read/write 失敗は
  network 縮退で吸収すべき**で、成功 DL を落とすのは原則違反寄り。一方、CLAUDE.md の fail-loudly
  規約（黙殺禁止）とは真正面から対立する ― ここは「無言の握り潰し」ではなく「握り潰すべきか否か」の
  設計判断そのもの。
- **根本原因**: 「cache 失敗＝最適化の失敗（非致命）」と「fail loud（黙殺禁止）」の間に明文ポリシーが無く、
  既定の `await` 伝播に委ねている。
- **修正案（構造化選択・needs-human）**:
  - put 失敗: 「bytes は返す＋put 失敗をユーザ可視チャネル（onError コールバック等）で通知」＝
    最適化失敗を握り潰さずに致命化もしない中間路（CLAUDE.md「許可+通知(推奨)」型）。
  - match/open 失敗: network フォールスルーへ縮退（＋通知）。
  - あるいは現状維持（fail loud 優先）を DECIDED として ADR 化。
  - **無言の握り潰しにしない**のが hinge。put を握り潰すなら必ず通知経路をセットで設計する。
- **needs-human**: どのポリシーを採るか（致命化 / 縮退+通知 / 現状維持）は要判断。
- **追加すべきテスト**: cache を DI 可能にするか put/match を throw させる差し込みで、
  「put throw 時に bytes を返す（or 通知が飛ぶ）」「match throw 時に network 縮退」を固定。
  現状 Cache API は DI されておらず失敗注入不能 ＝ この観点は現アーキでは**テスト困難**（明示）。

### 🟡 W-A-4 — 失敗・境界パスのテスト欠落
- **path**: src/mod.test.ts 全体
- **症状**: 主要ハッピーパスと代表分岐は良くカバーされているが、以下の**失敗・境界**が未カバー:
  1. **self-heal で再取得した bytes も validate 落ち** → L124 が throw して伝播する（無限ループしない）
     ことの固定。現状 self-heal テスト（L53-75）は再取得が成功する系のみ。
  2. **async（Promise 返し）validate**。本体は L107/L124 で `await opts.validate(bytes)` するため
     reject も拾う設計だが、Promise 版が未検証。
  3. **network 例外**（`fetchImpl` が reject）が握り潰されず伝播すること（L116）。HTTP 非 2xx は
     テスト済み（L149-164）だが transport 例外は未テスト。
  4. **URL オブジェクト入力**（`fetchBytes(new URL(...))` / `evictUrl(new URL(...))`）の分岐
     （L95, L142）が未通過 ― 文字列入力しかテストしていない。
  5. **正常ヒット時に validate が通過して network に出ない**系（L105-108 の成功側）。self-heal の
     失敗側は固定されているが、成功側の「ヒット bytes を validate 通過で返す」は未固定。
- **根本原因**: 失敗系・境界系のテスト設計が未着手。
- **修正案 / 追加すべきテスト**: 上記 1–5 を各 `Deno.test` で追加（いずれもネットワーク非依存、
  mockFetch + ユニーク cacheName + finally caches.delete を踏襲）。とくに 1 は fault-injection 的で
  タウトロジーにならない（validate を常に throw させ、calls.length===1・最終 reject を assert）。

### 🟡 W-A-5 — content-length 既知時の短受信（truncation）を黙って受理
- **path**: src/mod.ts:38-44（readTotal）, :61-77（streaming 読み取り、loaded 未検証）
- **症状**: content-length=7 を宣言しつつサーバがクリーンに 5 bytes で閉じた場合、`loaded` は 5 で
  止まり `total=7` のまま、**5 bytes をそのまま返し put する**（loaded===total の照合が無い）。
- **正直な留保（by-design 可能・needs-human）**: content-length は本体で「進捗の任意情報」
  （src/mod.ts:38 コメント）と明言され、整合性は `validate`（HF 層の sha256 / expectedBytes、
  src/hf/mod.ts:128-129）に委譲する設計。したがって「validate 無しで短受信を受理」は**設計上の
  委譲であって黙殺とは言い切れない**。ただし本 lib はダウンロード整合性を扱うため、既知 total との
  無償の照合を捨てるのは fail-loud 観点で惜しい。
  - なお **abrupt な接続断は `reader.read()` が reject** して readBody で throw する（fail loud 済み）。
    黙って通るのは「Content-Length 過大宣言＋クリーン close」という狭い runtime 依存ケースのみ（推測:
    HTTP/1.1 実装依存で fetch 層が別途エラーにする可能性もある）。
- **根本原因**: total（既知時）と loaded の突合が無い。
- **修正案**: `total !== undefined && loaded !== total` を fail-loud にする硬化を検討（validate とは
  独立の安価なガード）。採否は needs-human（「content-length は任意情報」設計を上書きするか）。
- **追加すべきテスト**: `content-length: "7"` を宣言しつつ 5 bytes だけ流す chunkedResponse で
  期待挙動（現状: 受理 / 硬化後: throw）を固定。

---

## 重要フロー — `fetchBytes` のデータフロー（実コード行番号併記）

```
fetchBytes(url, opts)                                    src/mod.ts:91
  requestUrl = string|URL→href                           :95   (URLオブジェクト分岐 未テスト → W-A-4④)
  fetchImpl = opts.fetch ?? globalThis.fetch             :96
  useCache  = (opts.cache ?? true) && caches!=undefined  :97   (?? で cache:false を保持 ✓)
  cacheName = opts.cacheName ?? DEFAULT                  :98
     │
     ├─ useCache? ──yes─► caches.open(cacheName)          :101  ┐ 並行時 両者ここで suspend
     │                     cache.match(requestUrl)        :102  ┘ → 両者 miss 観測(TOCTOU) → E-A-1
     │                        │
     │        ┌──HIT (cached!=undefined) ──:103
     │        │    bytes = Uint8Array(cached.arrayBuffer())      :104  (body 一回消費 ✓)
     │        │    validate===undefined? ─yes─► return bytes     :105  (正常ヒット未テスト → W-A-4⑤)
     │        │    try  await validate(bytes) ─ok─► return bytes :107-108
     │        │    catch{}  cache.delete(requestUrl)  ───────────:109-112
     │        │        （破損 self-heal: 線形フォールスルー・無限ループ無し ✓ / エラー無記録 → L-A-7）
     │        │             │
     │        └──MISS───────┤
     │                      ▼
     └──useCache=false──────►  response = await fetchImpl(requestUrl)      :116
                                 │  (network 例外は伝播 ✓ 未テスト → W-A-4③)
                                 ├─ !response.ok ─► throw "HTTP {status}…"  :117-121  (fail loud ✓ 済テスト)
                                 ▼
                              bytes = readBody(response, onProgress)        :122
                                 ├─ body===null ─► arrayBuffer + onProgress×1  :55-60  (分岐 未テスト → E-A-2)
                                 └─ else stream getReader→per-chunk onProgress :61-77
                                       (loaded vs total 未突合 → W-A-5)
                                 ▼
                              await validate?.(bytes)                       :124  (put 前に検証 ✓)
                                 └─ throw ─► 伝播（不正物は put しない ✓ 済テスト L77-100）
                                 ▼
                              useCache? caches.open→cache.put(new Response(bytes))  :125-128
                                       （open 二度目 → L-A-6 / put 失敗が致命 → W-A-3 / ヘッダ破棄 → L-A-8）
                                 ▼
                              return bytes                                  :129
```

不変条件（本体で成立しているもの、確認済み）:
- **不正物を絶対にキャッシュしない**: put（:127）は validate 通過（:124）の後段にのみ存在。miss パスで
  validate が throw すれば put へ到達しない。self-heal の evict（:111）も put とは別経路。→ 構造的に保証。
- **self-heal は有界**: evict 後は線形にフォールスルー→ network 1 回→ validate 再評価。ループ構文が
  無いため再取得物が不正でも throw で終端（無限ループ不能）。
- **body 一回性**: ヒット側は fresh な `cached` を都度 match して 1 回だけ arrayBuffer 消費。miss 側は
  読み切った bytes から `new Response(bytes)` を作り直して put ＝ 消費済み body を put しない。

「await を 1 つ挿すだけで壊れる偶然アトミック」区間の名指し:
- **:102 match と :127 put の間は非アトミック**。この窓に別呼び出しが割り込むのが E-A-1 の TOCTOU。
  現状は「重複 DL・last-writer-wins・内容同一」で corruption には至らないが、**将来この窓の間に
  『別内容を返す fetch』や『put 前提の後続処理』を足すと即座に整合性が壊れる**。single-flight を
  入れないなら、この非アトミック性を limitations として固定しておくべき。

---

## 横断所見

1. **依存ゼロ MUST**: 遵守。fetch / caches / crypto（本体では未使用）/ Uint8Array / TextEncoder 等の
   Web 標準のみ。実行時 import ゼロ。テストのみ `@std/assert`（規約通り publish 除外・deno.json:27）。→ 🟢
2. **fail loudly**: 本体は概ね遵守。self-heal の `catch {}`（:109-112）は CLAUDE.md が明文で認める
   「破損キャッシュのみ evict→取り直し」の正規経路なので黙殺には当たらない（L-A-7 は telemetry 皆無の
   指摘に留める）。唯一のグレーは W-A-3（cache I/O 失敗の扱い）で、これは黙殺ではなく「握り潰すべきか」の
   未決ポリシー ＝ needs-human。
3. **型安全性**: `??` を一貫使用（:96-98、`cache:false` を潰さない）。`as` は feature-detect の
   `as Partial<CacheWithKeys>`（:159）のみで、直後に型ガード `cache is CacheWithKeys`（:159-160）で
   正当化 ＝ 濫用なし。`Uint8Array<ArrayBuffer>` の明示ジェネリクスも整合。null/undefined 混在なし
   （undefined 一貫、optional プロパティ）。→ 🟢
4. **Deno/ブラウザ差**: `keys()` 欠落を feature-detect（:156-181）して fail loud、`typeof caches` で
   ランタイム有無を判定、put は `new Response(bytes)`（status 200・非 disturbed body）で Deno の put 制約
   （非 2xx / disturbed body 拒否）を構造的に回避。実装挙動依存ではなく仕様に沿った回避 ＝ 妥当。
   テストは `runtimeHasCacheKeys` プローブ（test:14-19）で keys 有無を実行時分岐し、両ランタイムで
   決定的 ＝ 良い設計。
5. **テスト規約遵守**: 全テストが `uniqueCacheName()`（crypto.randomUUID）でユニーク cacheName を採り、
   `finally { caches.delete }` で後始末、fetch は必ず DI ＝ ネットワーク非依存を徹底。mock 忠実度も良好
   （URL 記録・毎回 fresh Response で body 再利用バグを回避）。**弱点は失敗/境界/並行のカバレッジ**
   （E-A-1, E-A-2, W-A-4）で、これがテストファイルを 🟠 に押し上げている。
6. **VERSION 焼き込み**: `export const VERSION = "0.1.0"`（:14）は deno.json:3 と一致。mod.ts 側の
   表現はプレーンな文字列定数で問題なし（deno.json との drift ガードは scripts 担当範囲）。→ 🟢
7. **API 一貫性（軽微）**: `clearCache(name)` / `listCachedUrls(name)` は名前空間を第一引数の位置引数、
   `evictUrl(url, {cacheName})` はオプション経由 ― 操作対象（名前空間 vs URL）が異なるため許容範囲だが、
   将来のオプション拡張を見越すなら統一を検討してもよい（Low 未満・報告のみ）。

### needs-human 明示
- W-A-3（cache I/O 失敗ポリシー: 致命化 / 縮退+通知 / 現状維持）
- W-A-5（content-length 既知時の短受信ガードを入れるか＝「任意情報」設計の上書き可否）
- E-A-1 の**振る舞い側**（single-flight を lib 責務にするか、limitations 明文化に留めるか）。
  ※ E-A-1 / E-A-2 の**テスト追加**自体は判断不要（そのまま補完すべき）。
