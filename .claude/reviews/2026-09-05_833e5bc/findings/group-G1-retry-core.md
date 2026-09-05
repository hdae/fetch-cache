---
id: G1
topic: 再試行の中核（`src/retry.ts` の会計・タイマ所有権・Retry-After 解釈と `src/retry.test.ts` の読み合わせ）
commit: 833e5bc
files_reviewed:
  - src/retry.ts
  - src/retry.test.ts
  - src/core.ts（呼び出し点 785-804 / 1216-1233 のみ）
  - src/hf/mod.ts（呼び出し点 166-207 / 429-484 のみ）
  - src/mod.ts（型再公開 52-54）
  - src/testing/mock_fetch.ts
  - docs/decisions/0010-retry-after-rate-limit.md
  - docs/limitations.md
  - README.md
date: 2026-09-05
model: opus
---

## サマリ

再試行の中核 — ①`retries` の会計（成功時 0 / 使い切り時 = `maxRetries` / 非対象・非 GET・待機
超過時は 0 でも「その時点の attempt」）②`sleep` の timer とリスナーの所有権 ③`onRetry` を待機の
前に 1 回だけ呼ぶこと ④待機の中断が `signal.reason` で返ること — は**すべて実装どおりに成立して
おり、ADR 0010 / README / JSDoc の主張とも一致する**。特に懸念していた `sleep` の lost wakeup
（`signal.aborted` 検査から `addEventListener` までの間に abort が割り込む窓）と、reject 後に
resolve が走る二重解決は、**どちらも成立しないことを await 境界の位置から証明した**（後述
「証明 1」「証明 2」）。`clearTimeout(undefined)` も到達不能で、リークもダングリングも無い。

欠陥は「入力の端」に集中する。最大のものは `Retry-After` の**書式ミスが `Date.parse` の寛容さで
過去日付に化け、「指示なし → baseDelayMs」ではなく「0 ms で即時打ち直し」になる**点（G1-01）で、
実測で確認した（`"1.5"` → 2001-01-05、`"+120"` → 0120-01-01、`"-5"` → 2001-05-01）。rate limit 中の
サーバへ既定 5 回を無待機で連打するので、このモジュールが存在する理由そのものを裏返す。次に
`RetryPolicy` の数値に一切の形式検査が無く、`NaN` が `delayMs > MAX_TIMER_MS` ガードを素通りして
同じ 0 ms 連打になる（G1-02）。同じリリースで `HfFileSpec.expectedBytes` の形式不正を要求前に
弾いた（`5e2a2ad`）のと非対称である。

テスト側は 20 本が的確に分岐を押さえているが、**2 本は対象実装が壊れたとき赤ではなく約 1 時間
ハングする**（G1-03）。CLAUDE.md が名指しで避けよと書いている失敗形で、同ファイル
`retry.test.ts:316` には既に deadline の定型がある。

| 重大度       | 件数 |
| ------------ | ---- |
| 🔴 Critical  | 0    |
| 🟠 Error     | 0    |
| 🟡 Warning   | 4    |
| 🔵 Low       | 5    |
| 🟢 Safe      | —    |

---

## ファイル別分類

| ファイル | 判定 | 根拠 |
| --- | --- | --- |
| `src/retry.ts` | 🟡 Warning | 会計・所有権・中断は全経路で正しい（証明 1〜3）。欠陥は入力の端に限る: ①`Retry-After` の数値系書式ミスが `Date.parse` で日付に化ける（G1-01・`retry.ts:67-69`） ②`RetryPolicy` の数値無検査で `NaN` が MUST ガードを素通り（G1-02・`retry.ts:169-175`） ③jitter が無く並列 N 本が同期して打ち直す（G1-04・`retry.ts:169-172`） ④`statuses` に成功系を入れると成功応答を捨てて打ち直す（G1-06・`retry.ts:164`） ⑤指数の肩が Retry-After 由来の再試行も数える（G1-07・`retry.ts:170`）。 |
| `src/retry.test.ts` | 🟡 Warning | 20 本すべてに「赤にできる実装行」が実在し、tautological なものは 1 本も無い（後述「テスト ↔ 実装行の対応」）。ただし ①2 本が破壊時にハングする（G1-03・`retry.test.ts:156` / `:341`） ②待機完了時のリスナー解除・失敗応答の body 解放・`maxRetries: 0`・`attempt > 0` での待機超過・指数側への `maxDelayMs` 適用が未凍結（G1-05）。 |
| `src/core.ts`（呼び出し点のみ） | 🟢 Safe | `retrySuffix(retries)` の連結（`core.ts:800-802` / `core.ts:1229-1231`）は v0.6.0 の文言（`git show v0.6.0:src/core.ts` の 716 / 1111 行）に**末尾追加のみ**で、先頭一致で判別している下流を壊さない。`!response.ok` 前の `response.body?.cancel()` も v0.6.0 から不変。 |
| `src/hf/mod.ts`（呼び出し点のみ） | 🟢 Safe | `resolveHfRevision`（`hf/mod.ts:186-200`）が cache 層と同一の 1 本・同一の文言組み立てを通る。`retry` / `onRetry` の透過は 5 箇所（`hf/mod.ts:304-305` / `363-364` / `439-440` / `453-454` / `477-478`）すべてで対称。 |
| `src/mod.ts` | 🟢 Safe | 公開面は `RetryContext` / `RetryPolicy` の 2 型のみ（`mod.ts:52-54`）で、実装モジュールは `exports` 外。ADR 0010 §4 の宣言どおり。 |
| `src/testing/mock_fetch.ts` | 🟢 Safe | 差分ゼロ。`handler` が呼び出し毎に新しい `Response` を組み立てる限り、再試行時の body cancel（`retry.ts:177`）と干渉しない — 本差分のテストは全てその形。 |
| `docs/decisions/0010-retry-after-rate-limit.md` | 🔵 Low | 実装と一致する（§2 の `baseDelayMs * 2 ** (attempt - 1)` は 1 始まりの `attempt` 基準で、0 始まりの `retry.ts:170` と同値）。「解釈できない値は undefined へ落とす」（§2）だけが実態と食い違う（G1-01）。 |
| `docs/limitations.md` | 🔵 Low | 再試行節（39-52 行）は対象・method・上限・MAX_TIMER・合流者を正確に列挙。待機総量に上限が無いことと合流者が自分の signal で抜けられないことの**合成**だけが未記載（G1-08）。 |
| `README.md` | 🟢 Safe | 298-341 行の記述は実装と一致する（既定値・倍々・`onRetry` は待機の前・abort は `signal.reason`・上限超過は uncounted かつ `onRetry` なし・先頭文言不変）。 |

---

## 重要な経路の図（実コード行番号付き）

### `fetchWithRetry` の 4 つの return と `retries` の値（`src/retry.ts:144-187`）

```
fetchWithRetry(fetchImpl, url, init, policy, onRetry)
 │
 ├─[151-156] policy === false  ||  method ∉ {GET, HEAD}
 │            → return { response: 1回目, retries: 0 }        ……… ①opt-out / 非冪等
 │
 ├─[157-161] statuses / maxRetries / baseDelayMs / maxDelayMs を解決、attempt = 0
 │
 └─[162] while (true)
      │
      [163] response = await fetchImpl(url, init)
      │
      ├─[164-166] status ∉ statuses  ||  attempt >= maxRetries
      │            → return { response, retries: attempt }    ……… ②決着 / 使い切り
      │              （成功初回 = 0、使い切り = maxRetries）
      │
      [167]  retryAfter = headers.get("retry-after") ?? undefined
      [169]  delayMs = min( parseRetryAfter(retryAfter) ?? base * 2**attempt ,
      [171]                 maxDelayMs ?? Infinity )
      │
      ├─[175] delayMs > MAX_TIMER_MS (2**31-1)
      │            → return { response, retries: attempt }    ……… ③守れない待機
      │              （body は cancel しない = 呼び出し点が cancel して throw）
      │
      [176]  attempt += 1                     ← ここで初めて 1 始まりになる
      [177]  await response.body?.cancel()    ← 失敗応答の接続を先に解放
      [178]  notifyRetry(onRetry, { attempt, delayMs, retryAfter, ... })  ← 待機の「前」
      [185]  await sleep(delayMs, init?.signal ?? undefined)  ← ここで throw すると④
      └───── ループ先頭へ                                     ……… ④中断（reject）
```

`retries` は ①③で「その時点の attempt（③は加算前 = 待機を諦めた回は数えない）」、②で
「実際に待って打ち直した回数」。呼び出し点は `retrySuffix(retries)`（`retry.ts:126-127`）で
0 のときだけ空文字にするので、①③と「初回で決着」は**文言まで v0.6.0 と同一**になる。

### `sleep` の 3 経路と所有権（`src/retry.ts:78-103`）

```
sleep(delayMs, signal)
 │
 ├─[83-86] signal === undefined
 │           setTimeout(resolve, delayMs)  ← clear しない。await 済み = 発火後に進むので
 │           return                            未解決 op は残らない（Deno サニタイザ無罪）
 │
 ├─[87-90] signal.aborted（= onRetry 内で同期 abort された等）
 │           reject(signal.reason); return    ← 待たない。addEventListener もしない
 │                                              （aborted 後に付けたリスナーは永久に発火しない）
 │
 └─[93-102] 通常経路 ── ここから [102] まで await が 1 つも無い（＝不可分）
       [93]  let timer = undefined
       [94]  onAbort = () => { clearTimeout(timer); reject(signal.reason) }
       [98]  timer = setTimeout(() => { removeEventListener; resolve() }, delayMs)
       [102] addEventListener("abort", onAbort, { once: true })

     完了時: timer 発火 → [99] リスナーを外す → [100] resolve
     abort 時: [95] timer を消す → [96] reject（once:true でリスナーは自動除去）
```

**証明 1（lost wakeup は無い）**: `[87]` の `signal.aborted` 検査から `[102]` の登録までは
同期コードのみで、`await` も `then` も挟まらない。JS の実行モデルでは他のタスク（`abort()` の
呼び出し）がこの区間に割り込めないため、「検査を通ったあとリスナー登録前に abort される」窓は
存在しない。

**証明 2（二重解決・ダングリングは無い）**: 完了経路は `[99]` でリスナーを外してから resolve
するので、以後 `onAbort` は呼ばれない。abort 経路は `[95]` で timer を消すので、以後 resolve は
起きない。両者が同一 macrotask で競合することもない（timer コールバックと `abort()` の
イベント配送は別タスク）。仮に競合しても Promise の settle は冪等。

**証明 3（`clearTimeout(undefined)` は到達不能）**: `timer` は `[98]` で確定してから `[102]` で
リスナーが登録される。`onAbort` が呼ばれうるのは登録後だけなので、`onAbort` の中で `timer` が
`undefined` であることはない。`[93]` の初期化は TDZ 回避（相互参照する 2 つの束縛を作るため）で
あって、実行時の分岐ではない。

---

## 詳細指摘

### G1-01 🟡 Warning — `Retry-After` の数値系書式ミスが `Date.parse` で過去日付に化け、0 ms 即時打ち直しになる

**質問**: `Retry-After: 1.5` のような「秒として書こうとして失敗した値」を、現状の「0 ms で即時
再試行」から JSDoc どおりの「指示なし → `baseDelayMs`」へ寄せますか。それとも `Date.parse` に
渡す前段のガードを入れず、実挙動のほうに合わせて文書を直しますか。

**概要**:
`parseRetryAfter`（`src/retry.ts:63-70`）は ①`/^\d+$/` に一致すれば delta-seconds ②そうでなければ
`Date.parse` ③`NaN` なら `undefined`、という 3 段構えで、JSDoc（`retry.ts:58-62`）と ADR 0010 §2 は
「どちらとしても解釈できない値は undefined =『指示なし』へ落とす」と宣言している。しかし V8 の
`Date.parse` は仕様が要求する形式（ISO 8601）以外を**実装依存で寛容に**解釈する。Deno（V8）で
実測した結果:

| ヘッダ値 | `/^\d+$/` | `Date.parse` の解釈 | `parseRetryAfter` の返り値 |
| --- | --- | --- | --- |
| `"1.5"` | 不一致 | 2001-01-05T00:00:00Z | `0`（過去なので `Math.max(0, …)`） |
| `"+120"` | 不一致 | 0120-01-01T00:00:00Z | `0` |
| `"-5"` | 不一致 | 2001-05-01T00:00:00Z | `0` |
| `"1,5"` | 不一致 | 2001-01-05T00:00:00Z | `0` |
| `"soon"` / `"1e3"` / `"120abc"` / `"12.0"` | 不一致 | `NaN` | `undefined`（意図どおり） |

（検証コマンド: `deno eval` で `Date.parse` を直接叩いた。`"1.5"` は「2001 年 1 月 5 日」、
`"+120"` は「西暦 120 年」として解釈される。）

結果、`delayMs` は `baseDelayMs`（既定 1000）ではなく **0** になる。`0 > MAX_TIMER_MS` は偽なので
再試行は走り、`sleep(0)` は 1 macrotask で戻る。既定 `maxRetries: 5` なら、rate limit を返して
いるサーバへ**待ち時間ゼロで 5 連打**する。ADR 0010 が「fail loud の趣旨とは別物」と言って
実装した機能が、書式ミス 1 つで「rate limit 中のサーバを叩き続ける」挙動へ反転する。

**守っている目的**: サーバの書式ミスで取得を落とさない（＝ `undefined` へ落として既定の待機規則へ
委ねる）こと。現状は「落とさない」は守れているが「既定の待機規則へ委ねる」が守れていない。

**発生条件**: `Retry-After` に小数・符号付き・カンマ区切りの数値が入ること。RFC 9110 は非負整数の
秒か HTTP-date しか認めないが、`Retry-After: 1.5` は実装ミスとして現実に観測される部類の値。
HF Hub がこれを返すという確証は無い（**needs-human**: 実サーバでの発生可能性は未確認）。

**選択肢**:
- a) ★ `Date.parse` に渡す前に「HTTP-date の形は必ず英字で始まる」ことを使って弾く:
  `if (!/^[A-Za-z]/.test(trimmed)) return undefined;` を `retry.ts:67` の直前に置く。RFC 9110 の
  3 形式（IMF-fixdate / RFC 850 / asctime）はすべて曜日名か月名で始まるので偽陰性は無い。
  代償は ISO 形式（`"2099-01-01"`。RFC 違反だが V8 は解釈する）を受け付けなくなること。
- b) 数値として読める値を先に弾く: `if (Number.isFinite(Number(trimmed))) return undefined;` を
  同位置に置く。`"1.5"` / `"+120"` / `"-5"` を潰しつつ ISO 形式は残るが、`"1,5"` は残る。
- c) 現状維持し、JSDoc（`retry.ts:58-62`）と ADR 0010 §2 を「delta-seconds として不正な値は
  `Date.parse` の解釈に委ねる（多くは過去日付 = 0 ms 待機になる）」へ書き換える。

**リスク**: a) は 1 行・既存テスト（`"soon"` / HTTP-date / delta-seconds）に影響しない。ISO 形式を
返すサーバがあれば 0 ms 即時ではなく `baseDelayMs` になるだけで、退行としては安全側。b) は
`"1,5"` を取り逃す。c) は実装を変えないが、「無待機 5 連打」が仕様として固定される。

**対象**: `src/retry.ts:63-70`（`parseRetryAfter`）/ `src/retry.ts:58-62`（JSDoc）/
`docs/decisions/0010-retry-after-rate-limit.md:42-44` / `README.md:316-318`。

**影響範囲**: 3 呼び出し点すべて（`core.ts:788` / `core.ts:1218` / `hf/mod.ts:186`）。既定で有効な
経路なので、`retry` を書いていない下流にも及ぶ。

**引き継ぎ**: a) を採るなら、テスト `retry.test.ts:137-154`（`"soon"`）の隣に `"1.5"` のケースを
足して `delayMs === baseDelayMs` を凍結すること。現状の実装では `delayMs === 0` になるため、
ガードを入れる前に書けば赤で始まる（fault injection として機能する）。

---

### G1-02 🟡 Warning — `RetryPolicy` の数値に形式検査が無く、`NaN` が MAX_TIMER_MS ガードを素通りして 0 ms 連打になる

**質問**: `RetryPolicy` の数値フィールド（`baseDelayMs` / `maxDelayMs` / `maxRetries`）に、同じ
リリースで `HfFileSpec.expectedBytes` へ入れたのと同じ「要求の前に形式で弾く」検査を入れますか。

**概要**:
`retry.ts:157-160` は `??` で既定値を補うだけで、値域を一切見ない。`NaN` を渡した場合の伝播は
こうなる:

1. `maxDelayMs: NaN` → `Math.min(x, NaN)` は **`NaN`**（`retry.ts:169-172`）。
2. `NaN > MAX_TIMER_MS` は **偽** → `retry.ts:175` の早期 return を素通りする。
3. `sleep(NaN, …)` → `setTimeout(fn, NaN)` は遅延を 0 に丸める → **無待機で打ち直す**。
4. `onRetry` には `delayMs: NaN` が渡る（`retry.ts:182`）。

`baseDelayMs: NaN` でも 3・4 は同じ（`Retry-After` が無いときのみ）。つまり `retry.ts:173-174` が
`MUST:` と明記して守っている不変条件「守れない待機は再試行しない」が、`NaN` 1 個で無効化される。
`Retry-After: 2592000`（30 日）を返すサーバに対して、`maxDelayMs: NaN` を渡した呼び出しは
「30 日待つ」でも「打ち直さない」でもなく「無待機で 5 連打」になる。

他の値域も無検査のまま挙動が定まっている（実害は小さいが契約に書かれていない）:

| 入力 | 実際の挙動 |
| --- | --- |
| `maxRetries: 0` | 初回応答をそのまま返す（`retry: false` と同じ・`retry.ts:164`） |
| `maxRetries: -1` | 同上（負でも `attempt >= maxRetries` が初回で真） |
| `maxRetries: 2.5` | **3 回**再試行する（`attempt` が 3 になって初めて `>= 2.5`） |
| `baseDelayMs: -1000` | `setTimeout` が 0 に丸める（無待機） |
| `statuses: []` | 何も再試行しない |

**守っている目的**: 「不正な申告を黙って握り潰さない」（CLAUDE.md の fail loudly）。同じ差分の
`5e2a2ad` は `HfFileSpec.expectedBytes` の負・非整数を **network に出る前に throw** へ変えており
（`src/hf/mod.ts:326-331`）、`core.ts:362` / `core.ts:449` にも同種の形式検査がある。`RetryPolicy`
だけが無検査で、しかも黙って安全でない側（連打）へ倒れる。

**発生条件**: `retry: { maxDelayMs: Number(env.RETRY_CAP) }` のように外部入力から組み立てて
`NaN` が入ること。型（`number`）は `NaN` を弾かない。

**選択肢**:
- a) ★ `fetchWithRetry` の入口（`retry.ts:157-160` の直後）で `Number.isFinite` + 非負を検査し、
  破れたら throw する（`fetch-cache: retry.maxDelayMs が不正です（…）`）。要求を 1 本も出す前に
  落ちるので、`expectedBytes` の検査と同じ「network に出る前に throw」になる。
- b) ガードだけ塞ぐ最小手当て: `retry.ts:175` を `if (!(delayMs <= MAX_TIMER_MS)) return …;` へ
  反転する（`NaN` が真になり、守れない待機と同じ扱い = 打ち直さない）。1 文字級の変更で連打は
  消えるが、`delayMs: NaN` の通知や `maxRetries: 2.5` は残る。
- c) 現状維持し、JSDoc（`retry.ts:14-23`）に値域（有限・非負・`maxRetries` は整数）を明記する。

**リスク**: a) は公開型に対する実行時検査の追加 = 既に `NaN` を渡している下流があれば新規 throw
（v0.6.0 に `retry` は無いので**新規 API のみが対象**、後方互換の破壊にはならない）。b) は
挙動が「静かに打ち直さない」なので、原因が分からないまま失敗する。c) は実装コスト 0。

**対象**: `src/retry.ts:157-160`（既定値の解決）/ `src/retry.ts:169-175`（`Math.min` と MUST ガード）
/ `src/retry.ts:14-23`（`RetryPolicy` の JSDoc）/ 対比: `src/hf/mod.ts:326-331`。

**影響範囲**: `retry` を明示的に渡す呼び出しのみ（既定値経路は常に有限値）。

**引き継ぎ**: a) を採るなら検査は `fetchWithRetry` の中で 1 回（3 呼び出し点それぞれに置かない）。
文言は既存の形式不正 throw（`hf/mod.ts` の `expectedBytes` / `sha256`）に揃え、`(${url})` を末尾に
付けること。テストは `retry.test.ts` に「`maxDelayMs: NaN` は network に出る前に throw」1 本で足りる。

---

### G1-03 🟡 Warning — 2 本のテストは対象実装が壊れると赤ではなく約 1 時間ハングする

**質問**: `retry.test.ts:156` と `:341` に、同ファイル `:316-322` と同じ deadline の定型を入れますか。

**概要**:
CLAUDE.md は「同期待ちのポーリングには必ず deadline を置く（期限なしだと赤ではなくハングする）」
と明記しており、`retry.test.ts:316-322` にはその定型（2 秒で reject する `Promise.race`）がある。
しかし `retry-after: "3600"`（実時間 1 時間）を fixture に使う残り 2 本には deadline が無く、
それぞれが凍結している実装行を壊すと**赤ではなく実時間の待機**に落ちる:

| テスト | 壊す行 | 壊したときの挙動 |
| --- | --- | --- |
| `retry.test.ts:156`「`maxDelayMs` は Retry-After の指示も上限で切る」 | `retry.ts:169-172` の `Math.min` から `maxDelayMs` を落とす | `delayMs = 3_600_000` → **実時間 1 時間の `sleep`** の後にようやく assert が赤 |
| `retry.test.ts:341`「既に aborted の signal では待たずに reject する」 | `retry.ts:87-90` の早期 return を消す | 既に aborted の signal に `addEventListener("abort", …)` を付けても**永久に発火しない**（DOM の仕様どおり）ので、`clearTimeout` が呼ばれず 1 時間のタイマが満了する。しかも満了後は `resolve` してループが続くため、既定 5 回で**実質 5 時間** |

Deno にはテスト単位の既定タイムアウトが無いので、CI ではハングとして現れる。逐次実行（本
プロジェクトの前提）なので、後続の全テストが止まる。

**守っている目的**: 「破壊したら有限時間で赤くなる」というテストの基本契約。ハングは原因の特定が
赤より一段難しく、他のテストを巻き添えにする。

**発生条件**: 上記実装行の退行時のみ（現状のコードでは発生しない）。

**選択肢**:
- a) ★ 2 本とも `retry.test.ts:316-322` の `Promise.race` + `clearTimeout(deadline)` 定型へ揃える
  （2 秒）。テストヘルパへ切り出せば 3 本で共有できる。
- b) fixture の `"3600"` を「上限に掛かることは分かるが実待機は短い」値へ縮める（例
  `retry-after: "5"` + `maxDelayMs: 0`）。`:156` は目的を保ったまま最悪 5 秒で赤になる。ただし
  `:341` は「待たずに reject する」ことの証明に長い待機が要るので、b) では守れない。
- c) 現状維持（退行時のみの問題で、通常の緑では顕在化しない）。

**リスク**: a) はテストコードが 2 本ぶん膨らむ（既に 1 本で採っている形なので一貫性は増す）。
b) は `:341` を救えない。c) は退行時に CI が止まる。

**対象**: `src/retry.test.ts:156-173` / `src/retry.test.ts:341-364` / 既存の定型
`src/retry.test.ts:316-322`。

**影響範囲**: テストのみ（製品コードに影響なし）。

**引き継ぎ**: a) を採るなら deadline は「assert より先に reject する」形（`Promise.race` の
第 2 要素）でなければ意味がない。`finally` の `clearTimeout(deadline)` を落とすと今度は
サニタイザが未解決 timer を検出して別の理由で赤くなるので、`:316-338` をそのまま雛形にすること。

---

### G1-04 🟡 Warning — jitter が無く、並列 N 本が同一の `Retry-After` で同期して打ち直す（needs-human）

**質問**: ADR 0010 が動機に挙げた「1 モデル = 数十本の要求」の状況で、再試行の待機に jitter を
入れますか。それとも「サーバの指示どおり待つ」を優先して入れない判断を ADR に明記しますか。

**概要**:
`delayMs` は完全に決定的である（`retry.ts:169-172`）。`fetchHfFiles` は全ファイルを
`Promise.all` で**並列**取得し（`src/hf/mod.ts:477-484`）、各要求が自前で `fetchWithRetry` を通る。
Hub が rate limit を返す状況では N 本が**ほぼ同時に** 429 を受け、**同じ `Retry-After` 値**を
読み、**同じ時刻に**打ち直す。429 の原因が同時要求数そのものである以上、揃った打ち直しは再び
429 を招きやすい（thundering herd）。`Retry-After` が無い経路でも `baseDelayMs * 2 ** attempt` は
全本で同一なので同じ形になる。

ADR 0010 は §2 で待機の決め方を論じているが、jitter には触れていない。README（301-341 行）にも
記述は無い。

**守っている目的**: 再試行が「rate limit を抜ける」ために働くこと。同期した打ち直しは、待った
ぶんだけ遅くなって同じ壁に当たる = 再試行回数を消費するだけになりうる。

**発生条件**: 並列度 ≥ 2 で rate limit に当たること。下流（yomi / sbv2-web）が shard を並列で
取っているかは未確認 — **needs-human**。`fetchHfFiles` は並列だが、`prefetchHfFile` の JSDoc
（`hf/mod.ts:427-429`）は「並行度の選択は呼び出し側に委ねる。数 GB 級では逐次が望ましい」と
書いており、逐次運用なら実害は無い。

**選択肢**:
- a) full jitter: `delayMs = Math.random() * capped`。herd を最もよく崩すが、`Retry-After` の
  指示より**短く**待つ場合が出るので、ADR 0010 §2 の「指示どおり待つ」と正面から衝突する。
- b) ★ 上乗せ jitter: `Retry-After` 由来のときだけ `capped + Math.random() * jitterMs`（既定
  0〜1000 ms 程度）とし、指示より短くはしない。`RetryPolicy.jitterMs` で 0 にできるようにすれば
  既存の決定的テスト（`delayMs` を直接 assert している 6 本）は `jitterMs: 0` で維持できる。
- c) 現状維持し、ADR 0010 に「jitter を入れない理由（指示どおり待つことを優先・並行度は
  呼び出し側の選択）」を 1 段落追記する。

**リスク**: a) はサーバの指示を破る。b) は公開型 `RetryPolicy` にフィールドが 1 つ増える（追加
のみなので破壊的ではない）ほか、`onRetry` の `delayMs` が非決定的になり、下流のログ比較に影響。
c) は実装ゼロだが、並列運用で再試行が効かない可能性が残る。

**対象**: `src/retry.ts:169-172`（決定的な待機の算出）/ `src/hf/mod.ts:477-484`（`Promise.all` の
並列取得）/ `docs/decisions/0010-retry-after-rate-limit.md:40-47`。

**影響範囲**: HF 層の複数ファイル並列取得を使う下流。単発取得には影響しない。

**引き継ぎ**: b) を採るなら jitter は `MAX_TIMER_MS` 判定（`retry.ts:175`）の**前**に足すこと
（足した結果が上限を越える経路を作らない）。既存テストのうち `delayMs` を数値で assert して
いるのは `retry.test.ts:65-71` / `:94` / `:110` / `:130` / `:149` / `:169` / `:262` の 7 箇所で、
すべて `jitterMs: 0` の明示が要る。

---

### G1-05 🔵 Low — 未凍結の分岐 5 点（テストギャップ）

現在の 20 本は主要分岐を押さえているが、次は「壊しても緑のまま」である。

1. **待機完了時のリスナー解除**（`retry.ts:99` の `removeEventListener`）。消しても、`once: true`
   のリスナーは発火しないまま残るだけで、Deno のサニタイザは**未解決 op（timer）しか見ない**ので
   検出しない。実害は `AbortSignal` を長命に使い回す呼び出しでのリスナー蓄積（再試行 1 回につき
   1 個）。凍結するなら「`signal` を渡して 3 回再試行させ、完了後にリスナーが 0 であること」を
   直接見る手段が無いため、`AbortSignal` を包んだスパイ（`addEventListener` / `removeEventListener`
   を数える薄い実装）を DI する形になる。
2. **失敗応答の body 解放**（`retry.ts:177`）。`chunkedResponse`（`testing/mock_fetch.ts:32-43`）で
   429 を返し、再試行後に `body.locked` / cancel 済みであることを見れば凍結できる。
3. **`maxRetries: 0`**（`retry.ts:164` が初回で真になる経路）。`retry: false` と同じ結果になる
   ことが未確認。
4. **`attempt > 0` での待機超過**（`retry.ts:175`）。現行テスト（`:229`）は初回で超過する形だけ。
   「2 回再試行したあとに 30 日の `Retry-After` が来る」ケースで `retries: 2` = 文言
   `（再試行 2 回の後）` になることが未凍結で、README の "uncounted" の意味（超過した回だけを
   数えない）が実装で保証されていない。
5. **`maxDelayMs` が指数バックオフ側にも効くこと**（`retry.ts:169-172` の `Math.min` は
   `Retry-After` 無しの経路も通る）。現行テスト（`:156`）は `Retry-After` 有りの側だけ。

**対象**: `src/retry.test.ts` 全体 / `src/retry.ts:99` / `:164` / `:175` / `:177`。

---

### G1-06 🔵 Low — `statuses` に成功系ステータスを入れると、成功応答を捨てて打ち直す

`retry.ts:164` は `statuses.includes(response.status)` だけを見ており、その値が「エラーである」
ことを要求しない。`retry: { statuses: [200] }` を渡すと、200 の応答が毎回 `body.cancel()`
（`retry.ts:177`）されたうえで `maxRetries + 1` 回取得され、最後の 1 本だけが返る。呼び出し点は
`response.ok` なので `retrySuffix` も出ず、下流からは「無駄に 6 回ダウンロードした」以外の兆候が
無い。`statuses` の JSDoc（`retry.ts:15`）は「再試行する HTTP ステータス」としか書いておらず、
「後で成功しうることがステータスで分かるものだけ」という ADR 0010 §1 の前提が型にも実行時にも
現れていない。呼び出し側のバグではあるが、fail loud の方針からは入口で弾く（`status >= 400` を
要求する）か、JSDoc に「4xx / 5xx のみを想定」と明記するのが筋。

**対象**: `src/retry.ts:15`（JSDoc）/ `src/retry.ts:164`（判定）/
`docs/decisions/0010-retry-after-rate-limit.md:29-33`。

---

### G1-07 🔵 Low — 指数の肩が `Retry-After` 由来の再試行も数える（JSDoc の読みとずれる）

`retry.ts:170` の指数は `2 ** attempt` で、`attempt` は**すべての再試行**（`Retry-After` に従った
ものを含む）を数える。したがって「1 回目は `Retry-After: 1` に従い、2 回目はヘッダ無し」という
応答列では、2 回目の待機は `baseDelayMs`（既定 1000）ではなく `baseDelayMs * 2` = 2000 になる。
`RetryPolicy.baseDelayMs` の JSDoc（`retry.ts:19`）は「Retry-After が無いときの **1 回目**の待機
ms。以後 2 倍ずつ」と書いており、「ヘッダ無しの 1 回目」と読むと食い違う。実装側の解釈（経過
時間全体に対する後退）にも理はあるので、直すなら JSDoc の側（「再試行の通算回数で 2 倍ずつ」）
が妥当。混在する応答列は現行テストに無い。

**対象**: `src/retry.ts:19`（JSDoc）/ `src/retry.ts:170`（指数）。

---

### G1-08 🔵 Low — 待機の総量に上限が無いことと「合流者は自分の signal で抜けられない」ことの合成が未記載

既定では `maxDelayMs` が無く、`Retry-After` の指示にそのまま従う（`retry.ts:160` / `:171`。ADR
0010 §2 の明示的な判断）。一方 single-flight の合流者は自分の `init`（= `AbortSignal`）が使われ
ない（`core.ts:855-858`、docs/limitations.md）。この 2 つが重なると、`Retry-After: 86400` を
1 本が踏んだとき、**合流した全呼び出しが 1 日ぶん、自分の signal では抜けられないまま待つ**。
leader 側は自分の signal で中断できるので回復手段が無いわけではないが、合流者から見ると
「abort できない無限待ち」に見える。limitations.md はこの 2 つを別項として正しく書いているが、
合成した帰結は書かれていない。文書 1 文の追記（「合流者は leader の待機を自分の signal で
打ち切れない — 長い `Retry-After` を踏むと合流者は待たされ続ける」）で足りる。

**対象**: `src/retry.ts:160`（`maxDelayMs` の既定なし）/ `src/core.ts:855-858`（合流者の
`init` / `retry` 不使用）/ `docs/limitations.md:39-52`。

---

### G1-09 🔵 Low — method 正規化の定型が 3 箇所に重複

`(opts.init?.method ?? "GET").toUpperCase()` が `core.ts:992`（cache 有効時の GET 検査）・
`core.ts:1168`（`prefetchUrl` の GET 専用検査）・`retry.ts:153`（再試行可否）の 3 箇所にある。
現状は 3 つとも同一で不整合は無く、`prefetchUrl` は GET 以外を先に throw するので
`isRetriableMethod` が実質常に真という関係も成立している。将来 1 箇所だけ直したときに
「キャッシュはできないが再試行はする」ような食い違いが生まれうるので、正規化だけを共有する
（`retry.ts` は内部モジュールなので、そこへ `normalizeMethod` を置いて 3 箇所が使う）余地がある。
Simplicity first の観点では現状維持も妥当。

**対象**: `src/core.ts:992` / `src/core.ts:1168` / `src/retry.ts:153`。

---

## テスト ↔ 実装行の対応（「そのテストが赤になる実装行」）

tautological なテスト・実装非依存のテストは**無かった**。20 本すべてに、壊すと結果が変わる行が
実在する。

| # | テスト（`src/retry.test.ts`） | 赤になる実装行 | 実待機 |
| --- | --- | --- | --- |
| 1 | `:52` 429 + Retry-After は既定で 1 回待って取り直し | `retry.ts:43`（既定 statuses）/ `:66`（delta-seconds）/ `:176-184`（attempt と通知の中身） | 0 ms |
| 2 | `:80` Retry-After 無しは baseDelayMs から（503 も対象） | `retry.ts:43`（503）/ `:170`（`?? base`）/ `:167`（無ければ undefined） | 0 ms |
| 3 | `:100` 待機は 2 倍ずつ伸びる | `retry.ts:170`（`2 ** attempt`）/ `:176`（1 始まり） | 7 ms |
| 4 | `:117` HTTP-date は現在時刻との差（過去なら 0） | `retry.ts:67-69`（`Date.parse` と `Math.max`） | 0 ms |
| 5 | `:137` 解釈できない Retry-After は指示なし扱い | `retry.ts:68`（`NaN → undefined`） | 0 ms |
| 6 | `:156` maxDelayMs は Retry-After も切る | `retry.ts:171`（`maxDelayMs ?? Infinity`） | **壊すと 1 時間**（G1-03） |
| 7 | `:175` 使い切ったら従来文言 + 回数 | `retry.ts:164`（`attempt >= maxRetries`）/ `:126-127`（suffix）/ `core.ts:800-802` | 0 ms |
| 8 | `:203` 対象外ステータスと `retry:false` | `retry.ts:164`（includes）/ `:152`（`policy === false`） | 0 |
| 9 | `:229` MAX_TIMER 超過は待たずに返す（+ maxDelayMs で切れば再試行） | `retry.ts:175`（早期 return）/ `:169-172`（判定は上限適用**後**） | 0 ms |
| 10 | `:268` GET / HEAD 以外は再試行しない | `retry.ts:55-56` / `:153` | 0 |
| 11 | `:297` 待機中の abort は timer を消して reason で reject | `retry.ts:94-97`（`clearTimeout` はサニタイザ経由で検出）/ `:102`（登録） | 0 ms（2 秒 deadline 付き） |
| 12 | `:341` 既に aborted なら待たずに reject | `retry.ts:87-90`（早期 return） | **壊すと 1 時間以上**（G1-03） |
| 13 | `:366` onRetry の throw は隔離 + 警告 | `retry.ts:115-122`（try/catch と文言） | 0 ms |
| 14 | `:391` prefetchUrl も同じ 1 本を通る | `core.ts:1218-1224` | 0 ms |
| 15 | `:410` resolveHfRevision も同じ 1 本を通る | `hf/mod.ts:186-192` | 0 ms |
| 16 | `:433` HF の retry / onRetry は解決と取得の両方へ | `hf/mod.ts:304-305` / `:363-364` | 0 ms |
| 17 | `:465` prefetchHfFile へ透過 | `hf/mod.ts:439-440` / `:453-454` | 0 ms |
| 18 | `:488` fetchHfFiles へ透過（ファイル毎） | `hf/mod.ts:477-478` | 0 ms |
| 19 | `:522` statuses の差し替えは置換であって追加ではない | `retry.ts:157`（`?? DEFAULT_STATUSES`） | 0 ms |
| 20 | `:563` HF の `retry:false` は解決 API にも効く | `hf/mod.ts:190` / `retry.ts:152` | 0 |

実時間に依存するのは #3（1 + 2 + 4 = 7 ms）と #11（macrotask で abort → 2 秒の deadline）だけで、
どちらも flaky になる余地は小さい。他は `Retry-After: 0` / `baseDelayMs: 0` / `maxDelayMs: 0` で
実待機を消しており、`retry.test.ts:26-27` の MUST（実時間で待たない）は守られている。

---

## 横断所見

1. **`retries` の会計は 4 つの return すべてで README / ADR 0010 と一致する。** 特に「守れない
   待機」は `attempt` の加算前に return する（`retry.ts:175` → `:176`）ので、README の
   "uncounted and without an `onRetry` call" が字義どおり成立する。
2. **v0.6.0 からの観測可能な差分は 429 / 503 の応答時に限られる。** エラー文言は
   `git show v0.6.0:src/core.ts` の 716 / 1111 行と先頭一致で同一、末尾に
   `（再試行 N 回の後）` が付くのは `retries > 0` のときだけ（`retry.ts:126-127`）。
   `41a7842` が即失敗 fixture を 503 → 500 へ移したのは、この差分がテストに現れた正しい対処。
3. **`sleep` の `signal === undefined` 経路は Deno のサニタイザに掛からない**（`retry.ts:83-86`）。
   タイマを clear しないが、`sleep` を必ず `await` するので発火後にしか先へ進まず、テスト終了
   時点で未解決の op は残らない。テスト側の回避策は不要で、実際に何も置かれていない。
4. **`onRetry` の隔離文言は `onProgress` と対称**（`retry.ts:118-121` の「通知のみ中断・再試行は
   続行」 対 `core.ts:667` の「通知のみ中断・取得は続行」）。ADR 0004 の隔離方針と整合する。
5. **`init` を再試行の fetch に渡し続けることの帰結は安全側**。同じ `AbortSignal` を複数の fetch
   へ渡すのは仕様上問題なく（signal は消費されない）、`body` を持つ要求は非 GET/HEAD として
   再試行対象から外れる（`retry.ts:153`）ので、ストリーム body の二重消費は構造的に起きない。
   abort の reject 形も揃う: 待機中は `signal.reason`（`retry.ts:96`）、fetch 中は仕様どおり
   fetch が `signal.reason` で reject する。
6. **前回レビューの見送り事項（`.claude/reviews/2026-09-02_3b13d16/ROADMAP.md`）に抵触しない。**
   G2-04(b) / 2(a) / G3-07〜20 はいずれも `into` とバッファ台帳の話で、再試行の導入は
   `into` の使用中登録の**保持時間を延ばす**だけ（`retry` の待機ぶん）であり、判定条件を変えない。
   解消もしていない。
