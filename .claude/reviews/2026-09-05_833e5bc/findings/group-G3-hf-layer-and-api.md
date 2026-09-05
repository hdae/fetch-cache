---
id: G3
topic: HF 層と公開 API 面（src/hf/mod.ts / src/mod.ts / deno.json）
files_reviewed:
  - src/hf/mod.ts
  - src/mod.ts
  - deno.json
  - src/core.ts（maxBytes / retry の受け側だけ・G1/G2 と重複部分は参照のみ）
  - src/retry.ts（公開型と待機規則だけ・実装本体は G1 の担当）
  - README.md / docs/limitations.md / docs/decisions/0010 / 0011（主張と実装の突合）
date: 2026-09-05
model: opus
---

# G3 — HF 層と公開 API 面

## サマリ

`retry` / `onRetry` の透過は 4 入口すべてで漏れが無く、`maxBytes` の 2 経路も
ADR 0011 の記述どおりに実装されている。\
公開 API 面は追加のみで、`deno doc` で確認した限り v0.6.0 のシグネチャ・戻り値・エラー文言の
先頭はすべて不変（内部型 `RetryOutcome` / `FetchBytesWithKeyOptions` /
`PrefetchUrlWithKeyOptions` / `maxBytes` は公開面に出ていない）。\
一方で「既定 ON になった再試行」と「`prefetchHfFile` が新たに `expectedBytes` を見ること」は
どちらも下流から観測できる挙動変更で、前者は `fetchHfFiles` の並列 fan-out と組み合わさると
jitter 無しの同期再試行になる。ここが今回いちばん実害に近い。

件数: 全 8 件（🟠 Error 0 / 🟡 Warning 3 / 🔵 Low 5 / 🔴 Critical 0）。

## ファイル別分類

| ファイル | 判定 | 理由 |
| --- | --- | --- |
| `src/hf/mod.ts` | 🟡 Warning | 透過・上限・入口検査は正しい。並列 fan-out × jitter 無し再試行（G3-01）と prefetch の新しい失敗経路（G3-02）が残る |
| `src/mod.ts` | 🟢 Safe | 型 2 つの再公開のみ。`VERSION = "0.6.0"` は未 bump = 未リリース状態として正しい |
| `deno.json` | 🟢 Safe | `src/**/*.ts` が `src/retry.ts` を含み、`src/**/*.test.ts` / `src/testing/**` が除外される。`deno check .` 無出力・publish dry-run 成功（オーケストレータ実行） |
| `src/core.ts`（G3 視点のみ） | 🟢 Safe | キャッシュヒット経路の `readBody` は `maxBytes` を渡していない（core.ts:726-733）= ADR 0011 §2 を満たす |
| `src/retry.ts`（公開型のみ） | 🔵 Low | `RetryContext` に HF 層の `path` が無い（G3-04）。`url` で識別は可能 |
| `README.md` / `docs/limitations.md` | 🔵 Low | 「prefetch は `into` を使わない」の文言が `toSpec` の容量検査と食い違う（G3-07） |

## 観点ごとの確認結果（指摘に至らなかったもの）

**1. `retry` / `onRetry` の透過網羅 — 漏れなし。**\
4 入口すべてで revision 解決とファイル取得の両方へ渡っている。

| 入口 | revision 解決 | ファイル取得 |
| --- | --- | --- |
| `fetchHfFile` | hf/mod.ts:363-364 | hf/mod.ts:304-305（`fetchResolvedFile` 経由） |
| `fetchHfFiles` | hf/mod.ts:477-478 | hf/mod.ts:304-305（各ファイルが同一 `opts` で通る） |
| `prefetchHfFile` | hf/mod.ts:439-440 | hf/mod.ts:452-453（`prefetchUrlWithKey`） |
| `resolveHfRevision` | hf/mod.ts:186-192（自身が `fetchWithRetry` を呼ぶ） | — |

**4. キャッシュヒット経路の不変性 — 満たしている。**\
`maxBytes` を受け取る `readBody` の呼び出しは network 経路（core.ts:805-812、第 7 引数
`opts.maxBytes`）だけで、キャッシュヒット側（core.ts:726-733）は第 6 引数 `"cache"` までしか
渡していない。よって既存の過大エントリは従来どおり読み出してから `buildValidate`
（hf/mod.ts:250-259）で落ち、self-heal に乗る。

**5. 型の再公開 — 同一物。**\
`hf/mod.ts:30-46` は `../retry.ts` から import した `RetryContext` / `RetryPolicy` を
そのまま `export type` している。`src/mod.ts:54` も同じ `./retry.ts` からの再公開なので、
`.` と `./hf` の同名型は同一宣言を指す（構造的等価ではなく実体が同じ）。

**7. JSR 公開面 — 問題なし。**\
`deno doc src/mod.ts` / `deno doc src/hf/mod.ts` の出力に現れる型・関数は v0.6.0 から
`type RetryContext` / `type RetryPolicy`（両エントリ）と `HfFetchOptions` /
`HfPrefetchOptions` / `FetchBytesOptions` / `PrefetchUrlOptions` のプロパティ追加のみ。\
`RetryOutcome`・`FetchBytesWithKeyOptions`・`PrefetchUrlWithKeyOptions`・`maxBytes` は
どこにも出ていない。明示戻り値型も全公開関数に付いており slow types は無い
（`deno check .` 無出力）。

## 重要な経路（実コード行）

```
fetchHfFiles(ref, files, opts)                                  hf/mod.ts:465
  ├─ specs = names.map(toSpec)                                  hf/mod.ts:473
  │    ├─ sha256 形式検査 …………………………………………………………………… :321-325
  │    ├─ expectedBytes 形式検査（Number.isSafeInteger / < 0）… :328-335  ← 新規
  │    └─ into 容量検査（expectedBytes > into.length）…………… :336-345
  │       ※ この 3 つは network より前（可変 ref の解決 API にも出ない）
  ├─ resolveHfRevision(ref, {fetch, init, retry, onRetry})       hf/mod.ts:474-479
  │    └─ fetchWithRetry(...)                                    hf/mod.ts:186-192
  │         └─ 429/503 → sleep(delay) → 再要求  retry.ts:162-186
  │              delay = min(Retry-After ?? base*2**attempt, maxDelayMs)  retry.ts:169-172
  │              ★ jitter 無し（G3-01）
  └─ Promise.all( names.map(fetchResolvedFile) )                 hf/mod.ts:480-487
       └─ fetchBytesWithKey(url, contentKey, {                   hf/mod.ts:285
            expectedBytes: spec.expectedBytes,   ← 確保ヒント     :293
            maxBytes:      spec.expectedBytes,   ← 受信上限（新） :297
            retry, onRetry                                        :304-305
          })
            └─ network 経路のみ readBody(..., "network", maxBytes) core.ts:805-812
                 └─ チャンク境界で loaded+len > maxBytes → cancel+throw core.ts:495-504
            └─ キャッシュヒット経路 readBody(..., "cache")          core.ts:726-733
                 └─ maxBytes を渡さない = 従来どおり（ADR 0011 §2）

prefetchHfFile(ref, file, opts)                                  hf/mod.ts:430
  ├─ toSpec(file)   ← into 容量検査もここで走る（prefetch は into を使わないのに）:435 / G3-07
  ├─ resolveHfRevision(..., retry, onRetry)                      hf/mod.ts:436-441
  └─ prefetchUrlWithKey(url, contentKey, { sha256, maxBytes: spec.expectedBytes, retry, onRetry })
                                                                 hf/mod.ts:444-457
       └─ TransformStream で loaded > maxBytes → controller.error → put ごと reject
                                                                 core.ts:1286-1292
```

## 詳細指摘

### G3-01 🟡 Warning — `fetchHfFiles` の並列 fan-out が jitter 無しで同期再試行する

**`fetchHfFiles` が起こす rate limit に対して、ライブラリ自身が同期した再試行の波を作って
よいか？**

**概要**\
`fetchHfFiles` は全ファイルを `Promise.all` で同時に取得する（hf/mod.ts:480-487）。
Hub がその同時要求を rate limit と判定して各要求へ 429 + 同じ `Retry-After` を返すと、
全ファイルの待機は `retry.ts:169-172` で同じ値に決まり、`sleep` 後に**同一時刻へ揃って**
再要求が飛ぶ。`Retry-After` が無い場合も `baseDelayMs * 2 ** attempt` は決定的なので、
やはり全ファイルが 1, 2, 4, 8, 16 秒の同じ点で揃う。乱数の混入は `src/retry.ts` のどこにも
無い。\
守っている目的は ADR 0010 の「サーバの指示どおり待つ」で、`Retry-After` に勝手な散らしを
入れない判断自体は正しい。問題は**指示が無いときの指数バックオフ**にも散らしが無いこと、
そして**並列度を選んだのが呼び出し側ではなくライブラリ**（`fetchHfFiles` は並行度を露出して
いない）ことの組み合わせで、rate limit を踏んだ N 本が N 本のまま何度も同時に戻る。\
`fetchHfFile` を逐次で使う限りこの形は出ない。`fetchHfFiles` を数十 shard で使う下流
（ADR 0010 Context 1 が挙げている用途そのもの）でだけ効く。

**選択肢**\
a) ★ `RetryPolicy` に `jitter?: boolean`（既定 true、`Retry-After` 由来の待機には適用しない）
を追加し、バックオフ由来の待機にだけ full jitter（`random() * delay`）を掛ける。追加のみで
破壊的変更にならず、ADR 0010 の「指示は指示どおり」も保てる。\
b) `Retry-After` 由来の待機にも上限付きの散らし（例 `delay + random()*min(delay, 1000)`）を
足す。指示の解釈を変えるので ADR 0010 §2 の改訂が要る。\
c) 何もせず、ADR 0010 Consequences と docs/limitations.md に「`fetchHfFiles` の並列取得は
同期した再試行になる／散らしたいなら `fetchHfFile` を逐次で使うか `retry` を自前で分ける」と
明記する。

**リスク**\
a) は既定挙動が乱数依存になるため、既存テスト（`src/retry.test.ts` の待機時間アサーション）が
決定性を失う。`jitter: false` を渡してテストを書ける形にすること。\
c) だけだと、Hub 側から見た挙動は改善しない。

**対象**: `src/retry.ts:169-172`（待機の決定）、`src/hf/mod.ts:480-487`（並列 fan-out）\
**影響範囲**: `fetchHfFiles` を複数 shard で使う下流（yomi / sbv2-web の想定用途）。
`fetchHfFile` / `prefetchHfFile` の逐次利用には影響しない。\
**引き継ぎ**: `RetryPolicy` へのプロパティ追加 + `fetchWithRetry` の `delayMs` 計算 1 か所の
変更で足りる。`parseRetryAfter` が値を返したかどうかで分岐すればよい（現状 `??` で潰れて
いるので、`const instructed = parseRetryAfter(retryAfter)` を先に取り出す形へ整理する）。

### G3-02 🟡 Warning — `prefetchHfFile` が `expectedBytes` を見るようになったことで、従来成功していた温めが失敗しうる

**「宣言を超える応答は従来も必ず失敗していた」という ADR 0011 の前提は、温めと読み出しで
同じ spec を使う場合にしか成り立たない。これを minor リリースの許容範囲とみなすか？**

**概要**\
v0.6.0 の `prefetchHfFile` は spec から `sha256` しか見なかった（`git show
v0.6.0:src/hf/mod.ts` の `prefetchUrlWithKey` 呼び出しに `expectedBytes` は無い）。
HEAD は `maxBytes: spec.expectedBytes` を渡す（hf/mod.ts:448）。\
ADR 0011 Consequences は「宣言を超える応答は従来も必ず失敗していた（`prefetchHfFile` は
読み出し時の self-heal）」と書いているが、これは**読み出し側の spec にも `expectedBytes` が
入っている場合**の話。温めるときのマニフェスト（`expectedBytes` 入り）と読むときの spec
（`expectedBytes` 無し、または `sha256` だけ）が違う下流では、v0.6.0 では温めも読み出しも
成功していた経路が、HEAD では**温めの時点で throw する**。`prefetchHfFile` は縮退しない
契約なので、この throw はそのまま起動失敗になる。\
守っている目的（確定した失敗のために数 GB を捨てない）は正しく、宣言が実長とずれている時点で
下流のマニフェストが古いのは事実。ただし「失敗の内容は変わらず時刻だけが早くなる」という
ADR の主張は上記の非対称ケースでは成り立たず、**新しい失敗**である。

**選択肢**\
a) ★ ADR 0011 Consequences と docs/limitations.md へ 1 行足す:「温めと読み出しで spec が
違う場合（温め側にだけ `expectedBytes` がある場合）、v0.6.0 では成功していた温めが
失敗しうる」。挙動は変えず、リリースノートで下流へ明示する。\
b) `prefetchHfFile` では `expectedBytes` を見ない（v0.6.0 の挙動へ戻す）。ADR 0011 §3 の
判断を取り消すことになるので、帯域節約の主眼（数 GB の prefetch）を失う。\
c) `HfPrefetchOptions` に opt-out（例 `boundByExpectedBytes?: boolean`）を足す。追加のみだが、
「上限を渡してよいのは検証を持つ層だけ」という ADR 0011 §2 の設計条件を呼び出し側へ漏らす。

**リスク**\
b) は ADR 0011 の主目的を失う。c) はオプションが 1 つ増え、設計の意図が薄まる。
a) は挙動を変えないので下流が踏むまで気づけない — ただし踏んだときのエラー文言
（`fetch-cache: 受信が申告 N バイトを超えた（M バイト以上） (url)`）は原因を名指しできている。

**対象**: `src/hf/mod.ts:444-448`、`docs/decisions/0011-hf-expected-bytes-bound.md`
Consequences 第 1 項\
**影響範囲**: `prefetchHfFile` に `expectedBytes` 入り spec を渡している下流のみ。
`fetchHfFile` / `fetchHfFiles` は従来も全量後に落ちていたので実質不変。\
**引き継ぎ**: a) なら ADR の Consequences 第 1 項に但し書きを 1 文足すだけ。下流
（yomi / sbv2-web）が `prefetchHfFile` へ `expectedBytes` を渡しているかは本リポジトリからは
確認できない — **needs-human**。

### G3-03 🟡 Warning — HTTP エラー文言の末尾変化が下流に安全かは本リポジトリからは確定できない

**`（再試行 N 回の後）` の付加を「先頭一致だから安全」と断じてよいか？**

**概要**\
再試行が 1 回でも走ると、3 呼び出し点すべてのエラー文言に `（再試行 N 回の後）` が付く
（hf/mod.ts:196-200、core.ts:800-804 / core.ts:1228-1232）。ADR 0010 §4 は「下流は先頭一致で
判別している」を根拠に文言互換としているが、その根拠は本リポジトリの中に無い（下流の
コードもテストもここには無い）。完全一致・`endsWith`・`$` 付き正規表現で判定している下流が
あれば、429 / 503 を踏んだときにだけ静かに分岐が外れる。\
守っている目的は「再試行したことを診断可能にする」ことで、末尾に足す設計自体は妥当。
確定していないのは下流の突合方式だけ。\
なお `resolveHfRevision` の HTTP エラーだけでなく、その直後の
`revision 解決応答に sha が無い`（hf/mod.ts:204）には `retrySuffix` が付かない — これは
再試行後に 200 を返した応答なので付けようが無く、設計として正しい（G3-08 で文言の一貫性だけ
別に触れる）。

**選択肢**\
a) ★ リリース前に下流 2 本（yomi / sbv2-web）の `"fetch-cache: HTTP "` 突合箇所を実際に
grep し、先頭一致であることを確認したうえで ADR 0010 §4 の根拠をその確認結果へ差し替える。\
b) 文言を変えず、リリースノートに「429 / 503 の場合だけ末尾に `（再試行 N 回の後）` が付く」
と明記して下流へ確認を委ねる。\
c) 再試行回数をメッセージではなく `Error` のプロパティ（例 `cause` か独自フィールド）へ
移し、文言を完全に不変にする。破壊的ではないが、`Error` サブクラスを公開面に足すかの判断が
必要になる。

**リスク**\
c) は「クラスは非公開」という既存方針（`IntoCapacityError` は `error.name` で判別させている
— docs/limitations.md）と整合させる設計が要る。

**対象**: `src/hf/mod.ts:196-200`、`src/retry.ts:126-127`、
`docs/decisions/0010-retry-after-rate-limit.md` §4\
**影響範囲**: 下流のエラーハンドリング分岐。429 / 503 を踏んだときにだけ現れるため、
通常テストでは検出されない。\
**引き継ぎ**: 下流リポジトリでの `rg 'fetch-cache: HTTP'` が確認手段。**needs-human**
（本リポジトリからは判定不能）。

### G3-04 🔵 Low — `RetryContext` に `path` が無く、`onProgress` と非対称

`onProgress` は HF 層で `{ ...progress, path }` を付けて渡す（hf/mod.ts:299-301 /
449-451）が、`onRetry` は `retry.ts` の `RetryContext`（`url` / `status` / `attempt` /
`delayMs` / `retryAfter`）をそのまま素通しする（hf/mod.ts:305 / 453）。\
実害は小さい: `fetchHfFiles` の並列取得でも `context.url` は
`{hub}/{repo}/resolve/{sha}/{path}` なのでファイルは一意に特定でき、revision 解決の再試行は
`/api/{kind}/...` で区別できる。ただし呼び出し側は URL を percent-decode して自分の
`path` へ戻す必要があり、`onProgress` で `path` が来るのに `onRetry` では来ないのは
API として揃っていない。\
追加のみで解消できる（HF 層で `onRetry: (context) => onRetry({ ...context, path: spec.path })`
とし、`./hf` から `HfRetryContext = RetryContext & { path: string }` を公開する）。ただし
`resolveHfRevision` 由来の通知には `path` が無いため、HF 層の `onRetry` を
`RetryContext | HfRetryContext` の合併にするか `path?: string` にするかの判断が要る
（`fetchHfFiles` では 1 つの `onRetry` に両方が届く — hf/mod.ts:478 と :305）。\
**対象**: `src/retry.ts:26-35`、`src/hf/mod.ts:236-237` / `:305` / `:453`

### G3-05 🔵 Low — `resolveHfRevision` の opts が無名インライン型のまま 4 フィールドに増えた

`deno doc src/hf/mod.ts` は
`resolveHfRevision(ref: HfRepoRef, opts: { fetch?; init?; retry?; onRetry?; })` と展開する。
名前が無いので下流はこの型を直接参照できず、ラッパを書くときは
`Parameters<typeof resolveHfRevision>[1]` を使うしかない。v0.6.0 では 2 フィールドで済んで
いたが、今回 `retry` / `onRetry`（どちらも公開型 `RetryPolicy` / `RetryContext` を含む）が
増えて、名前が無いことの不便さが実務的になった。\
`export type HfResolveOptions = { … }` を足して `opts: HfResolveOptions = {}` に置き換える
のは純粋な追加で、既存の呼び出しも壊れない。\
**対象**: `src/hf/mod.ts:166-176`

### G3-06 🔵 Low — `expectedBytes` の拒否文言が判定条件（安全整数）と一致していない

判定は `!Number.isSafeInteger(spec.expectedBytes) || spec.expectedBytes < 0`
（hf/mod.ts:328-331）だが、文言は
`expectedBytes は 0 以上の整数で指定してください`（hf/mod.ts:333）。
`2 ** 53`（= 9007199254740992）は 0 以上の整数だが安全整数ではないので throw され、
利用者は文言どおりの値を渡したのに拒否されたように読める。JSDoc 側は
「**0 以上の安全整数**」と正しく書いてある（hf/mod.ts:69-71）ので、文言だけが薄い。\
`0 以上の安全整数（Number.MAX_SAFE_INTEGER 以下）で指定してください` 程度で揃う。
9 PB 級の申告は現実には来ないため実害はほぼ無い。\
**対象**: `src/hf/mod.ts:328-335`

### G3-07 🔵 Low — 「prefetch は `into` を使わない」という文言と、`prefetchHfFile` から飛ぶ `IntoCapacityError` が食い違う

`HfFileSpec.into` の JSDoc は「`prefetchHfFile` は見ない（バイト列を手元に持たない）」
（hf/mod.ts:108）、README は "`validate` / `into` are ignored while warming"、
docs/limitations.md も「`spec.validate` / `spec.into` は prefetch では使われない」と書く。\
しかし `prefetchHfFile` は `toSpec` を通る（hf/mod.ts:435）ので、
`{ into: 小さい器, expectedBytes: 大きい申告 }` を渡すと `IntoCapacityError`
（hf/mod.ts:340-344）が飛ぶ。器そのものは使われないが、器の**長さ**は温めの成否を左右する。\
この検査は v0.6.0 から `toSpec` にあり（`git show v0.6.0:src/hf/mod.ts` の 361 行目で
`prefetchHfFile` も `toSpec` を通していた）**今回入った差分ではない**が、今回 README と
JSDoc の当該行を書き換えているので、同じ機会に「`into` は温めでは書き込み先として使われない
（容量検査だけは全入口で共通に走る）」へ揃えるのが自然。\
**対象**: `src/hf/mod.ts:104-110` / `:336-345` / `:435`、`README.md`（"ignored while
warming" の行）、`docs/limitations.md`（「prefetch が見る spec は」の項）

### G3-08 🔵 Low — `expectedBytes: 0` は層ごとに 3 通りに扱われるが、どこにも書かれていない

`expectedBytes: 0` は今回の `toSpec` で**受理される**（`Number.isSafeInteger(0)` かつ
`0 < 0` は偽 — hf/mod.ts:328-331）。その先での扱いは 3 つに割れる。

| 使われ方 | 0 のときの挙動 | 場所 |
| --- | --- | --- |
| 受信バッファの確保ヒント | ヒント無し（`expectedBytes > 0` の条件を外れる） | core.ts:448-462 |
| 受信の上限 `maxBytes` | 上限 0 として効く（最初の非空チャンクで throw） | core.ts:495-504 |
| 長さの厳密一致 `buildValidate` | `bytes.length !== 0` で throw | hf/mod.ts:251-257 |

結果として「0 バイトのファイルを `expectedBytes: 0` で宣言する」は正しく動く（チャンクが
無いので上限に触れず、検証も通る）。壊れているところは無い。\
ただし ADR 0007 が「形式不正の申告（非整数・**0 以下**）は確保ヒント無しへ落ちる」と書いて
いるのに対し、ADR 0011 / `toSpec` は 0 を正当な申告として受理する — 同じ値が片方では
「形式不正」、もう片方では「妥当」と呼ばれている。docs/limitations.md か ADR 0011 に
「0 は妥当な申告（0 バイトファイル）で、確保ヒントとしてだけ無視される」の 1 行があると、
将来 `toSpec` の条件を `<= 0` へ「揃える」誤修正を防げる。\
**対象**: `src/hf/mod.ts:328-335`、`src/core.ts:448-462`、`docs/decisions/0011-hf-expected-bytes-bound.md` §2

## 横断所見

- **semver 分類（観点 8 の結論）**: 型・関数・戻り値の追加のみで、`deno doc` 上の既存
  シグネチャは v0.6.0 と一致する。よって **minor（0.7.0）** が妥当。ただし利用者が観測できる
  挙動変更が 3 つあり、リリースノートに列挙が必要:
  ①429 / 503 で既定 最大 31 秒（1+2+4+8+16）待ってから落ちるようになる（`retry: false` で
  従来どおり）②その場合エラー文言の末尾に `（再試行 N 回の後）` が付く（G3-03）
  ③`prefetchHfFile` が `expectedBytes` を上限として見るようになる（G3-02）。
- **前回 ROADMAP（2026-09-02_3b13d16）との関係**: 今回の差分は `into` 周りのコード経路を
  変えていない。ただし `readBody` に `maxBytes` 分岐が `into` 容量検査の**手前**へ入った
  （core.ts:495-504）ので、G3-10（「`into` があるとき `expectedBytes` が確保に使われない」の
  テスト）を書くときは `maxBytes` も同時に効く点に注意が要る。ROADMAP 項目の解消・抵触は
  いずれも無い。
- **依存ゼロ規約**: `src/retry.ts` は `setTimeout` / `AbortSignal` / `Response` のみ。
  違反なし。
- **テスト規約**: 追加テストは既存どおり固定名前空間 `"fetch-cache"` を使い finally で
  `caches.delete` している（`src/retry.test.ts:484` 等）。並列実行を要求する記述は増えて
  いない。
