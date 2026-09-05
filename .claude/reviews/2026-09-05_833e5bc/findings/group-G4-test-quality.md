---
id: G4
topic: テスト品質横断（retry.test.ts 全体・mod.test.ts / hf/mod.test.ts / testing の差分）
files_reviewed:
  - src/retry.test.ts
  - src/mod.test.ts（v0.6.0..HEAD の差分のみ）
  - src/hf/mod.test.ts（v0.6.0..HEAD の差分のみ）
  - src/testing/mock_fetch.ts（差分なしを確認）
date: 2026-09-05
model: opus
---

# G4 — テスト品質横断

## 総評

追加された 27 本（retry.test.ts 20 / mod.test.ts 2 / hf/mod.test.ts 5）は、いずれも「赤にする実装行」を\
1 つ以上特定できた。t-wada スタイルの観点でも契約側を縛っており、実装の内部構造に依存した\
assertion（private 関数の直呼び・呼び出し順の覗き見）は 1 件も無い。\
tautological なテスト（実装を壊しても緑のままになるもの）は見つからなかった。\
既存 assertion の改変は 3 か所（`503` → `500` の fixture 差し替え 2 件と、それに伴う\
`assertRejects` の文言 1 件）で、いずれも「503 が既定で再試行対象になった」という挙動変更への\
正当な追従であり、弱体化ではない。

一方で、**赤にならずハングする**テストが 1 本（retry.test.ts:341）、\
**Deno 2.8 で落ちる**テストが 1 本（hf/mod.test.ts:1282）ある。どちらも「実装が壊れたときに\
CI が壊れたと分かる」性質を損なうもので、Warning とした。\
残りはカバレッジ欠落 8 件で、いずれも実装は正しいが「壊しても緑」の窓が空いている。

件数: Critical 0 / Error 0 / Warning 3 / Low 8（合計 11）。

## ファイル別分類

| ファイル | 判定 | 理由 |
| --- | --- | --- |
| src/retry.test.ts | 🟡 Warning | 20 本すべて赤にする実装行を特定できたが、既 aborted のテスト（341）に deadline が無く、`sleep` の早期 return を壊すと赤ではなく 1 時間ハングする。加えて HEAD / `maxRetries: 0` / `statuses: []` / 未来の HTTP-date が未カバー。 |
| src/hf/mod.test.ts（差分） | 🟡 Warning | 上限テスト 4 本 + 形式検査 1 本はいずれも有効（打ち切り位置を `supplied()` で観測しており、境界の off-by-one も捕まる）。ただし 1282 行の `listKeys` が Deno 2.8 で throw する（他のテストは `runtimeHasCacheKeys` で分岐している）。`into` × 上限の順序 MUST が未凍結。 |
| src/mod.test.ts（差分） | 🟡 Warning | 汎用層の非上限性・保険 delete の文言凍結ともに有効。既存 assertion の 503→500 差し替えは正当だが、「`retry: false` の 503 が即失敗する」というカバレッジだけ復元されていない。 |
| src/testing/mock_fetch.ts | 🟢 Safe | 今回差分なし（`git diff v0.6.0..HEAD -- src/testing/` は空）。新規テストは共有ヘルパを増やさず、`lazyChunks` / `FOUR` を hf/mod.test.ts 内のローカルに置いており妥当（`chunkedResponse` は先読みするので打ち切りを観測できない）。 |

補足（観点 4・7 の結論）:

- **サニタイザ無効化はゼロ**。`sanitizeOps` / `sanitizeResources` / `sanitizeExit` の指定は\
  リポジトリ全体で 0 件。`ignore:` は 7 か所すべて `runtimeHasCacheKeys`（Cache.keys() の\
  feature-detect）による分岐で、`.skip` の放置は無い。
- **`1 ignored` の正体**は src/mod.test.ts:2908 の `ignore: runtimeHasCacheKeys`\
  （Deno 2.8 以前で `listKeys` が throw することを縛るテスト。2.9 では対象外）。既存・妥当。
- **副次的な収穫**: retry.ts の `sleep` が abort 時に `clearTimeout` を呼ばない退行は、\
  retry.test.ts:297 が終わった時点で 3,600,000ms の timer が残るため Deno の op サニタイザが\
  拾う。明示 assertion は無いが実質カバーされている。

---

## 詳細指摘

### G4-01 🟡 Warning — 既 aborted のテストに deadline が無く、退行時に赤ではなく 1 時間ハングする

**質問文**: retry.test.ts:341 のテストへ、297 と同じ deadline レースを入れますか？

**概要**\
`sleep`（src/retry.ts:87-90）は「signal が既に aborted なら待たずに `signal.reason` で reject\
する」早期 return を持つ。これを消すと、`addEventListener("abort", …)` は**既に dispatch 済みの\
signal では二度と発火しない**ため、`setTimeout(3_600_000)` がそのまま満了を待つ。\
retry.test.ts:341 のテストは `retry-after: "3600"` を返す mock を使い、`onRetry` の中で同期に\
abort している（356 行）ので、この退行が起きたときテストは**失敗せず 1 時間ブロックする**。\
Deno.test には既定のタイムアウトが無く、CI は「赤」ではなく「ハング」になる。\
これは CLAUDE.md の「同期待ちのポーリングには必ず deadline を置く（期限なしだと赤ではなく\
ハングする）」が守ろうとしている性質そのもので、隣の 297 行のテストは実際に deadline\
（315-322 行）を入れている。両者で扱いが割れている。

**選択肢**
- a) ★ 297 と同じ `Promise.race` + 2 秒 deadline を 341 にも入れる（片方だけ持っている非対称を消す）。
- b) `retry-after` を短く（例 5000ms）してハング時間を有限にする — ただし「待たずに」の主張が\
  弱まり、5 秒待って緑になる可能性が残るので推奨しない。
- c) 現状維持（ハングの可能性を受け入れる）。

**リスク**: a) はテストコードが数行増えるだけ。挙動側への影響なし。

**対象**: src/retry.test.ts:341-364（deadline 無し）／ 対照は src/retry.test.ts:315-322\
／ 赤にする実装行は src/retry.ts:87-90。

**影響範囲**: テストのみ。

**引き継ぎ**: 341 のテストは併せて `assertEquals(calls.length, 1)` も足すとよい。\
テスト名は「待たずに reject する」だが、現状 fetch が 1 回で止まったことを観測していない\
（`assertStrictEquals(error, reason)` だけ）。297 は 334 行で同じ assertion を持っている。

---

### G4-02 🟡 Warning — hf/mod.test.ts の新規テストが `listKeys` を無条件に呼び、Deno 2.8 で落ちる

**質問文**: hf/mod.test.ts:1282 の `listKeys` 行は削除しますか、それとも `runtimeHasCacheKeys`\
相当の分岐を hf 側にも用意しますか？

**概要**\
`listKeys` は `Cache.keys()` 未実装のランタイム（Deno 2.8 以前）で fail loud に throw する\
仕様（docs/limitations.md「ランタイム」節）。mod.test.ts はこれを踏まえ、`keys()` に依存する\
テストを `ignore: !runtimeHasCacheKeys` で分岐している（mod.test.ts:109-113 の feature-detect と\
1065 / 2924 / 2942 / 2986 / 3077 / 3097 の 6 か所）。\
今回 hf/mod.test.ts へ新設された「prefetchHfFile: 受信が expectedBytes を超えたら throw し、\
エントリを成立させない」は、`listKeys` を hf/mod.test.ts へ**新規に import**（16 行）して\
1282 行で無条件に呼ぶ。hf/mod.test.ts には feature-detect も `ignore` 分岐も無いため、\
Deno 2.8 ではこのテストだけがランタイム由来で赤くなる（テスト対象の欠陥ではないのに）。\
しかもこの assertion は直後の 1283-1287 行（`cache.match(contentKeyUrl(...))` が undefined）に\
包含されており、**全ランタイムで動く方の assertion が既に同じことを言っている**。

**選択肢**
- a) ★ 1282 行を削除する（`cache.match` の assertion が同じ主張を全ランタイムで担う）。
- b) mod.test.ts と同じ feature-detect を hf/mod.test.ts にも置き、`ignore` でテストごと分岐する\
  — ただし上限の主張まで 2.8 で落ちるので過剰。
- c) テストを 2 本に割り、`listKeys` を使う側だけ `ignore` する。

**リスク**: a) で失われる情報は無い（内容キー空間に残っていないことは `cache.match` で足りる）。

**対象**: src/hf/mod.test.ts:16（import 追加）・1282（無条件呼び出し）／\
対照は src/mod.test.ts:109-113・2924。

**影響範囲**: Deno 2.8 での `deno task check` の可否のみ。CI が 2.9+ 固定なら顕在化しない\
（needs-human: 実際に 2.8 で回す運用があるかはオーナー判断）。

**引き継ぎ**: `contentKeyUrl` は同ファイル内のヘルパ。1283-1287 行はそのまま残す。

---

### G4-03 🟡 Warning — `into` と受信上限の**判定順序 MUST** を縛るテストが無い

**質問文**: ADR 0011 の「上限判定は `into` の容量検査より先」を凍結するテストを 1 本足しますか？

**概要**\
src/core.ts:493-504 には「MUST: `into` の容量検査より先に判定する — 超過は器不足ではなく\
申告違反として報告されるべき（ADR 0011）」というコメント付きで `maxBytes` 判定が置かれ、\
その直後（505-514 行）に `IntoCapacityError` の分岐がある。ADR 0011 §2 も同じことを明記している。\
ところがこの順序を観測するテストが無い。\
現行の HF テストで `into` と `expectedBytes` を同時に渡すのは hf/mod.test.ts:1117（`expectedBytes`\
が `into.length` を超える＝`toSpec` が入口で弾く経路）だけで、**受信中に両方の条件が同時に成立する**\
ケースが無い。したがって 493-504 行のブロックを 514 行の後ろへ移しても、全テストは緑のままになる。\
`toSpec` が `expectedBytes <= into.length` を保証しているため両方が同時に成立するのは\
「器も申告も 6 バイト、実受信が 8 バイト」のような形に限られるが、これは path 取り違えや\
upstream 差し替えで実際に起きる形であり、そのときの文言が `into の容量 6 バイトに収まりません`\
になると原因の特定を誤らせる（器を大きくしても直らない）。

**選択肢**
- a) ★ hf/mod.test.ts に 1 本足す（下記テスト仕様）。
- b) 見送り、ROADMAP へ（前回 ROADMAP の G3-07〜13 と同じ「`into` 周辺のテストギャップ」束）。

**リスク**: 実装は現状正しいので、a) は退行防止のみ。コストは小。

**対象**: src/core.ts:493-514（順序の MUST）／ ADR docs/decisions/0011-hf-expected-bytes-bound.md §2。

**影響範囲**: テストのみ。

**引き継ぎ（テスト仕様）**
- ファイル: `src/hf/mod.test.ts`（`lazyChunks` の直後）
- 縛る振る舞い: 受信が申告を超え、かつ器の容量も超えるとき、報告されるのは**申告違反**であること。
- 手順: `into = new Uint8Array(new ArrayBuffer(6))`、`spec = { path: "model.onnx", expectedBytes: 6, into }`、\
  応答は `lazyChunks([FOUR(), FOUR(), FOUR()])`（4 バイト × 3）。
- 観測値: `error.message` に `受信が申告 6 バイトを超えた` を含み、`into の容量` を**含まない**こと。\
  `supplied() === 2`（3 チャンク目は要求されない）。`error.name !== "IntoCapacityError"`。
- 赤にする実装行: src/core.ts:495（この if を 514 行の後ろへ動かすと `IntoCapacityError` が先に出て赤）。

---

## 低（改善提案・カバレッジ欠落）

いずれも「実装は正しいが、壊しても緑になる窓」。テスト仕様は実装者がそのまま書ける密度で示す。

### G4-04 🔵 Low — `body === null` 経路の上限判定（2 か所）が未カバー

`maxBytes` を持つテストは src/mod.test.ts:2677 の 1 件だけで、そこは stream 経路。\
src/core.ts:473-475（`fetchBytes` の arrayBuffer フォールバック）と src/core.ts:1266-1268\
（`prefetchUrl` の同フォールバック）はどちらのテストも通らず、削除しても緑のままになる。\
ADR 0011 の Consequences 末尾と、コミット 833e5bc が追記した「body null 経路の注記」が\
主張している挙動（打ち切れないので受信後に長さで判定する）が未凍結。

- ファイル: `src/mod.test.ts`（`bodilessResponse` ヘルパが 1894-1900 行にある）
- 縛る振る舞い: body を持たない応答でも上限超過は同じ文言で throw し、`prefetch` 側は\
  エントリを作らないこと。
- 観測値: `fetchBytesWithKey(URL_A, undefined, { fetch, maxBytes: 2 })` が\
  `受信が申告 2 バイトを超えた（5 バイト）`（`以上` が**付かない**＝確定値）で reject。\
  `prefetchUrlWithKey` 側は同文言で reject し、`cache.match(URL_A)` が undefined。
- 赤にする実装行: src/core.ts:473 / src/core.ts:1266。

### G4-05 🔵 Low — HEAD の再試行が未カバー

`isRetriableMethod`（src/retry.ts:55-56）は `GET` / `HEAD` を許す。retry.test.ts:268 は POST が\
再試行されないことを縛るが、HEAD が**再試行される**ことを縛るテストが無いので、\
`method === "GET"` だけに縮めても全テストが緑になる。

- ファイル: `src/retry.test.ts`
- 手順: `fetchBytes(URL_A, { fetch, cache: false, init: { method: "HEAD" }, retry: { baseDelayMs: 0 } })`、\
  mock は `failThenBytes(1, 429, { "retry-after": "0" })`。
- 観測値: `calls.length === 2`、`seen.length === 1`。
- 赤にする実装行: src/retry.ts:56（`|| method === "HEAD"` を落とすと赤）。

### G4-06 🔵 Low — `maxRetries: 0` と `statuses: []` の境界が未カバー

`attempt >= maxRetries`（src/retry.ts:164）と `statuses.includes(...)`（同行）の境界。\
`maxRetries: 0` は「既定で有効だが 0 回」という opt-out の別表現で、`retry: false` とは\
経路が違う（`retry: false` は 151-156 行で早期 return）。どちらも 1 回で決着することを縛りたい。

- ファイル: `src/retry.test.ts`
- 観測値: `retry: { maxRetries: 0 }` と `retry: { statuses: [] }` のそれぞれで\
  `calls.length === 1`、`onRetry` 未発火、文言に `再試行` を含まない。
- 赤にする実装行: src/retry.ts:164。

### G4-07 🔵 Low — 未来の HTTP-date（正の待機になる方向）が未カバー

retry.test.ts:117 は**過去**の HTTP-date だけを渡し `delayMs === 0` を見る。\
`parseRetryAfter` の HTTP-date 分岐（src/retry.ts:67-69）を `return 0` に潰しても緑のままになる\
（`Math.max(0, …)` の下限だけが縛られ、差分計算そのものは縛られていない）。

- ファイル: `src/retry.test.ts`
- 手順: `retry-after` に `new Date(Date.now() + 3_600_000).toUTCString()`、\
  `retry: { maxDelayMs: 0 }` を併用して実待機を 0 にする。
- 観測値: **flaky 回避のため厳密値ではなく範囲**で見る — `onRetry` を 2 本用意するのではなく、\
  `maxDelayMs` を渡さない別ケースで `seen[0].delayMs` が\
  `3_500_000 < delayMs <= 3_600_000` に入ることだけを見て、待機自体は abort で抜ける\
  （297 行のパターンを再利用する）。秒未満の丸めが入るので等値比較は書かないこと。
- 赤にする実装行: src/retry.ts:69。

### G4-08 🔵 Low — HF の `expectedBytes: 0`（受理される境界）が未カバー

`toSpec` は `< 0` を弾き 0 は受理する（src/hf/mod.ts:329-334）。0 は `maxBytes: 0` として\
そのまま渡る（src/hf/mod.ts:297 / 448）ので、`maxBytes !== undefined` の判定が\
`if (maxBytes)` のような真偽値判定へ退行すると 0 が黙って無効化される。\
その退行を捕まえるテストが無い。

- ファイル: `src/hf/mod.test.ts`
- 観測値: ①`expectedBytes: 0` + 空 body（`new Response(new Uint8Array())`）は成功し\
  `bytes.length === 0` ②`expectedBytes: 0` + 1 バイト以上の body は\
  `受信が申告 0 バイトを超えた` で reject。
- 赤にする実装行: src/core.ts:495 / src/core.ts:1286（`!== undefined` を truthy 判定へ変えると赤）。

### G4-09 🔵 Low — single-flight 合流者と再試行の関係が未凍結

ADR 0010 Consequences と docs/limitations.md（39-52 行）は「合流者は leader の再試行をそのまま待つ」\
「合流者の `retry` / `onRetry` は使われない」と主張しているが、テストが無い。\
mod.test.ts には合流者のオプション不使用を縛る系譜（295 / 1830 / 1861 / 2128 行）があるので、\
同じ形で 1 本足せる。

- ファイル: `src/mod.test.ts`
- 手順: gate 付き mock で 1 回目 429（`retry-after: "0"`）→ 2 回目 200。leader は\
  `onRetry` あり、合流者は `retry: false` + `onRetry` ありで同 URL を並行呼び出し。
- 観測値: 両者とも `BYTES_A` を得る／`calls.length === 2`（合流者は独自に network に出ない）／\
  合流者の `onRetry` は 0 回・leader の `onRetry` は 1 回。
- 赤にする実装行: src/core.ts:788-794（合流前に leader のオプションで `fetchWithRetry` を呼ぶ配線）。

### G4-10 🔵 Low — `prefetchUrl` 側の「再試行 N 回の後」文言が未カバー

`retrySuffix` の適用点は 2 か所（src/core.ts:801 と src/core.ts:1230）。\
retry.test.ts:195 は `fetchBytes` 側だけを縛っており、1230 行の `retrySuffix(retries)` を\
消しても緑のまま。prefetch の再試行テスト（retry.test.ts:465）は成功系のみ。

- ファイル: `src/retry.test.ts`
- 観測値: `prefetchUrl(URL_A, { fetch, retry: { maxRetries: 1, baseDelayMs: 0 } })` が\
  `fetch-cache: HTTP 429 …` で始まり `（再試行 1 回の後）` を含む message で reject、\
  `calls.length === 2`。
- 赤にする実装行: src/core.ts:1230。

### G4-11 🔵 Low — fixture 差し替え（41a7842）で「503 の即失敗」を縛る点が 1 つも残っていない

`git show v0.6.0:src/mod.test.ts` と比べると、削除された既存 assertion は 3 つだけで\
（`"HTTP 503"` × 2 と 503 fixture 2 か所）、いずれも 500 へ置換されている。判定は\
**挙動変更に伴う正当な追従**: 503 は既定で再試行対象になったため、503 のままだと\
「1 回で落ちる」前提の `calls.length` assertion が壊れ、実時間で 31 秒待つテストになる。弱体化ではない。\
ただし副作用として、`retry: false` を渡したときの 503 即失敗はどのテストでも観測されなくなった\
（retry.test.ts:203 の opt-out ケースは 429 のみ）。既定 `[429, 503]` の 503 側は\
retry.test.ts:80 が再試行方向だけを縛っている。

- 提案: retry.test.ts:203 の opt-out ケースを 503 に替える（429 側は同テストの前半・175 行・\
  268 行などで十分に縛られている）。コスト極小。
- 赤にする実装行: src/retry.ts:148（`policy === false` の早期 return）。

### G4-12 🔵 Low — 汎用層の新規テストは既存テストとほぼ同型（重複ではないが差分が細い）

src/mod.test.ts:1495 の新テストは、直前 1478 行の「申告を超えて届いたら蓄積経路へ落ちて全量を返す」\
と assertion が同一で、違いは申告の出どころだけ（content-length ヘッダ vs 明示 `expectedBytes`）。\
両者は readBody の中で同じ蓄積経路へ合流するため、実装上の分岐は\
「確保に `expectedBytes` を使う」497-462 行付近だけになる。\
それでも ADR 0011 の互換の主張（汎用層の申告は上限にならない）を名指しで凍結する価値はあるので\
**削除は推奨しない** — コメント（1496-1497 行）が意図を説明できている。記録のみ。

---

## 重要な経路の ASCII 図

再試行 1 周（実コード行番号: src/retry.ts）と、各テストが赤にする行の対応。

```
fetchWithRetry(…)                                   retry.ts
  │
  ├─ policy === false or 非 GET/HEAD ──► 1 回で返す   :151-156 ← test:203(retry:false) / :268(POST)
  │                                                            ※HEAD の正方向は未カバー（G4-05）
  │
  └─ loop
       ├─ response = await fetchImpl(url, init)      :161
       ├─ statuses に無い or attempt >= maxRetries    :164     ← test:203(404) / :175(使い切り) / :522(statuses)
       │      └─► { response, retries: attempt } を返す         ※maxRetries:0 / statuses:[] は未カバー（G4-06）
       ├─ delayMs = min(parseRetryAfter ?? base*2^n, ← :169-172 ← test:100(2 倍) / :137(解釈不能) / :156(maxDelayMs)
       │               maxDelayMs ?? Infinity)                  ※未来の HTTP-date は未カバー（G4-07）
       ├─ delayMs > MAX_TIMER_MS ──► そのまま返す     :175      ← test:229
       ├─ attempt += 1 / body.cancel()               :176-177
       ├─ notifyRetry(onRetry, ctx)  ← 待機の「前」    :178-184  ← test:52(全フィールド) / :366(throw 隔離)
       └─ await sleep(delayMs, init?.signal)         :185
              ├─ signal.aborted なら即 reject          :87-90   ← test:341（★deadline 無し = G4-01）
              └─ timer + abort listener               :93-102  ← test:297（op サニタイザが clearTimeout 漏れを検出）
```

受信上限（実コード行番号: src/core.ts）と、テストの対応。

```
readBody(… maxBytes)                                 core.ts
  ├─ body === null ─► arrayBuffer 後に長さ判定        :473-475  ← 未カバー（G4-04）
  └─ stream 経路 while(read)
       ├─ loaded + value.length > maxBytes           :495      ← hf/mod.test.ts:1236（supplied()===2 で打ち切りを観測）
       │     └─ reader.cancel() → throw 申告違反       :496-504
       ├─ into 容量超過 → IntoCapacityError            :505-514  ← 順序 MUST が未凍結（G4-03）
       └─ …

prefetchUrlWithKey(… maxBytes)
  ├─ body === null ─► 長さ判定                        :1266     ← 未カバー（G4-04）
  └─ TransformStream.transform
       ├─ loaded > maxBytes → controller.error(…)     :1286-1293 ← hf/mod.test.ts:1265
       │     （hasher.update より前 = 上限側が優先）      :1300
       ├─ put 失敗 → streamFailure を優先して throw     :1324     ← hf/mod.test.ts:1281（汎用文言に化けない）
       └─ put 成功 + streamFailure → 保険 delete        :1330-1345 ← mod.test.ts:2647（label の取り違えを検出）
```

## 横断所見

1. **`onRetry` の全フィールド凍結は 1 本だけ**（retry.test.ts:65-71 の `assertEquals(seen, [{…}])`）。\
   ここが `url` / `status` / `attempt` / `delayMs` / `retryAfter` の 5 フィールドを一括で縛って\
   おり、他のテストは個別フィールドしか見ていない。この 1 本が消えるとフィールド名の\
   タイポが通ってしまうので、以後の改変時はここを起点にすること（指摘ではなく引き継ぎ）。
2. **時間依存は健全**。実待機があるのは retry.test.ts:100（1+2+4=7ms・意図的）と、\
   abort 系 2 本（297 は deadline 付き / 341 は G4-01）のみ。他はすべて `retry-after: "0"`\
   か `baseDelayMs: 0` / `maxDelayMs: 0` で実時間を消している。`Date.now()` 依存は\
   HTTP-date の 1 本だけで、60 秒過去を渡しているので flaky にならない。
3. **テスト規約（CLAUDE.md）の遵守**: 新規 27 本すべてが `opts.fetch` の DI を使い\
   ネットワークに出ない。固定名前空間 `"fetch-cache"` の後始末は、キャッシュに触る全テストが\
   `finally { await caches.delete(CACHE_NAME) }` を持つ。持たない 2 本\
   （retry.test.ts:410 の `resolveHfRevision` / hf/mod.test.ts:1076 の形式検査）は\
   どちらも要求前に throw する・cache を開かない経路で、`calls.length === 0` を自ら\
   assert しているため妥当。
4. **前回 ROADMAP（2026-09-02_3b13d16）との関係**: 今回の差分は G3-07〜13（`into` 周辺の\
   テストギャップ）を 1 件も解消していない（抵触もしていない）。逆に G4-03 が\
   同じ束へ 1 件追加される形になるので、着手するなら `into` 系としてまとめて扱うのが良い。
5. **`src/testing/uniqueCacheName`（mock_fetch.ts:45-47）の JSDoc が陳腐化している**\
   （「テスト毎にユニークな cacheName」は 0.6.0 以前の規約で、現在は Cache.keys() の\
   feature-detect probe 用にしか使われていない — mod.test.ts:109 が唯一の利用点）。\
   今回の差分外なので指摘ではなく記録。
