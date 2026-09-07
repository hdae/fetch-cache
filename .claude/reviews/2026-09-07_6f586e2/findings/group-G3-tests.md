---
id: G3
topic: テスト品質とテストギャップ（openCachedUrl / openHfFile — 区間読み）
files_reviewed:
  - src/mod.test.ts（L3176〜3516 追加分）
  - src/hf/mod.test.ts（L1399〜1511 追加分）
  - src/testing/mock_fetch.ts
  - src/core.ts（L1362〜1690 — テスト網羅の観点のみ）
  - src/hf/mod.ts（L496〜550 — テスト網羅の観点のみ）
date: 2026-09-07
model: opus (effort high)
---

## サマリ

依頼は「6f586e2（v0.7.0 → HEAD）で追加された区間読み API のテスト群を、品質とギャップの
観点で全件洗う」。\
追加テストは 16 本（cache 層 14 本 + HF 層 4 本 ※戦略ループ 2 本は 2 テストに展開）。\
土台の作りは良い: 乱数バイト列で offset の取り違えを潰し、戦略を `for` ループで両方通し、
`calls.length` で「network に出ない」契約を毎回縛り、`finally` で `caches.delete` している。\
DI（`failingCacheStorage` / 偽 `CacheStorage`）の使い方も既存テストの語彙どおりで、
「触れてはいけない `open`」で入口検査の位置を縛る書き方は良い設計。

一方で、**ADR 0012 が明示的に決めた事項のうち 4 つに回帰ガードが無い**（中断をチャンク境界で
見ること・既定フックの文言・非 Deno の既定戦略 "blob"・"blob" 戦略の signal）。\
特に中断テストは実測で「チャンクを 1 つも読まずに落ちている」ことを確認した（下の実測ログ）。\
テスト名とコメントが謳っている契約と、実際に赤にできる変異が食い違っている。

件数: **E 5 / W 10 / L 7**（計 22）。C は無し。

実測で確定した事実（このレビューで scratchpad の使い捨てスクリプトを `deno run` して取得）:

| 確かめたこと                                    | 結果                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| Deno 2.9.6 の `cache.match` body のチャンク長    | 一律 **65,536 バイト**（256 KiB → 4 チャンク / 4 MiB → 64 チャンク） |
| ⇒ RANGE_BYTES（256 KiB）の「チャンク跨ぎ」主張   | **成り立つ**（跨ぎは実際に通っている）                            |
| 中断テストが abort するタイミング                | `reader.read()` が **0 回**の時点（＝チャンク境界ではない）       |
| 空エントリ（0 バイト）の `cached.body`           | **null にならない**（空 stream）⇒ `body === null` 分岐は DI 専用   |
| `length 0` / `offset == size` の両戦略の一致     | 一致（blob / stream とも空配列 or 同一文言で throw）              |
| `globalThis.Deno` の削除・復帰                   | `configurable: true` ⇒ 非 Deno 既定のテストは書ける               |

---

## ファイル別 5 段階分類

| ファイル                              | 分類  | 根拠                                                                                                                     |
| ------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/mod.test.ts`（追加分 L3176-3516） | **E** | 失敗パス（`op: "delete"`）・境界（`length 0` / `offset == size`）・中断（チャンク境界）が未テスト。中断テストは名乗る契約を縛れていない |
| `src/hf/mod.test.ts`（追加分 L1399-1511）| **W** | 振る舞いはあるが未テスト（`onCacheError` 透過・`toSpec` の expectedBytes / into 検査・`prefetchHfFile` 温め経路）。失敗パスの欠落は cache 層側ほど深くない |
| `src/testing/mock_fetch.ts`           | **S** | 今回無変更。`mockFetch` の使い方は妥当。`chunkedResponse` は今回未使用（G3-11 の提案で使う先はここではなく偽 `Cache`）  |
| `src/core.ts`（L1362-1690・参照）     | **W** | 実装自体の欠陥は G3 の観点では見つからず（境界の挙動は実測で両戦略一致）。ただし未到達の分岐が複数残る（G3-02/03/04/05/06/14） |
| `src/hf/mod.ts`（L496-550・参照）     | **W** | 同上。JSDoc が明言する `toSpec` 検査の透過が未テスト（G3-13）                                                            |

---

## 指摘の詳細

### G3-01. stream 戦略の「チャンク境界での中断」を縛るテストを足すか？ [E/test-gap]

概要: ADR 0012 §2 は「`signal` は読み飛ばしのチャンクの切れ目で見る」と決めており、テストの
コメントも「その契約をここで凍結する」と書いている。\
だが実測では、このテストは `reader.read()` を **1 回も呼ばないまま**落ちている。\
機序は同期実行境界: `readFromStream` は `assertRange` → `signal?.throwIfAborted()`
（core.ts:1504-1505）まで同期で進み、`await cache.match(...)`（core.ts:1508）で呼び出し側へ
制御が戻る。テストはそこで `controller.abort(reason)` する（mod.test.ts:3337）ので、
再開後のループ 1 周目の先頭 `signal?.throwIfAborted()`（core.ts:1536）が即座に throw する。\
守っている目的は「offset に比例して長くなる読み飛ばしを、途中で打ち切れること」であって、
「呼ぶ前に abort 済みなら落ちること」ではない。

フォルト注入（この指摘の核）:

| 変異                                                              | 期待     | 実際 |
| ----------------------------------------------------------------- | -------- | ---- |
| core.ts:1536 の `signal?.throwIfAborted()` を削除                  | 赤になるべき | **緑のまま**（1505 が拾う） |
| core.ts:1505 の `signal?.throwIfAborted()` を削除                  | 赤になるべき | **緑のまま**（1536 が拾う） |
| 1536 をループ外（`while` の直前）へ移動 ＝ 途中中断を殺す変異      | 赤になるべき | **緑のまま** |

つまり「長い読み飛ばしを中断できる」という、この signal が存在する唯一の理由が未検証。

- a) 偽 `CacheStorage` でチャンクを 1 つずつ手で流す body を注入し、**2 チャンク目を止めた
  状態で abort** して reject を見る ★推奨 — ランタイムのチャンク長に依存せず、
  「境界で見る」だけを決定的に縛れる。既存の `failingCacheStorage` に `match` override を
  足す形で書けるので新ヘルパは要らない。
- b) 実 Cache のまま `RANGE_BYTES`（4 チャンク）を使い、`queueMicrotask` を挟んでから abort
  する — 何チャンク進んだ後かがランタイム任せで、跨ぎを保証できない。
- c) 現状維持（中断は「呼ぶ前に abort 済み」だけ保証）。

リスク: a) は偽 Cache を書くぶんテストが長くなる。ただし DI 前提の設計なので既存の語彙内。\
対象: src/mod.test.ts:3323-3350（テスト本体）/ src/core.ts:1536（縛れていない行）\
影響範囲: cache 層 stream 戦略の中断契約のみ。実装変更は不要（テスト追加のみ）。

引き継ぎ:

- ファイル: `src/mod.test.ts`（`openCachedUrl` 節の中断テストの直後）
- テスト名: `openCachedUrl: stream 戦略の read はチャンク境界で中断を見る（読み飛ばしの途中で止まる）`
- 縛る振る舞い: 1 チャンク消費後に abort すると、**残りのチャンクを引かずに** `signal.reason`
  で reject する。
- 作り方:
  1. `gate = Promise.withResolvers<void>()` を用意する。
  2. body を `new ReadableStream({ pull(c) { pulled++; ... } }, { highWaterMark: 0 })` で作り、
     2 チャンク目の `pull` で `gate.promise` を待たせる（`highWaterMark: 0` にしないと
     ストリーム構築時に先読みが 1 回走り、数え方がずれる — 実測済み）。
  3. `caches` に `{ open: () => Promise.resolve({ match: () => Promise.resolve(new Response(stream)) } as unknown as Cache), ... }` を DI（`openCachedUrl` が触るのは
     `open` / `match` だけ）。`read: "stream"` を明示する。
  4. `read(offset, length, { signal })` を呼び、2 チャンク目の `pull` に入ったことを
     **deadline 付きポーリング**（例 1 秒・`while (pulled < 2)` に期限を置く）で待ってから
     `controller.abort(reason)` → `gate.resolve()`。
  5. 観測値: `assertRejects` の戻りが `reason` と `assertStrictEquals`、かつ
     `pulled` が総チャンク数未満（＝最後まで読んでいない）。
- 検証手順: core.ts:1536 の `throwIfAborted` をループ外へ移すと赤、戻すと緑になることを確認する。
- 追加で 1 行: 既存テスト（3323）のコメントは「読み飛ばしの前で落ちる」実態に合わせて直す
  （現在の「中断はチャンクの切れ目で見る、という契約をここで凍結する」は事実と食い違う）。

---

### G3-02. self-heal の `delete` 失敗通知（`op: "delete"`）を縛るテストを足すか？ [E/test-gap]

概要: 記録ハッシュ不一致で evict する経路（core.ts:1646-1655）は、`cache.delete` が失敗したら
`onCacheError({ op: "delete" })` で通知して `undefined` を返す設計（ADR 0001 の縮退と同型）。\
この失敗パスを通すテストが 1 本も無く、`try`/`catch` ごと削っても（＝ delete の失敗が
そのまま呼び出し側へ漏れても）緑のまま。守っている目的は「区間読みは open の失敗を必ず
`undefined` へ畳む — 呼び出し側は `fetchBytes` へ落ちればよい」という契約。\
`fetchBytes` 側の `op: "delete"` は既存テストがあり（core.ts:760/792 の経路）、新経路だけが
穴になっている。

フォルト注入: core.ts:1648-1654 の `try`/`catch` を外す → 現状の全テストは緑のまま（誰も
delete を失敗させていない）。

- a) `failingCacheStorage({ delete: () => Promise.reject(...) })` で 1 本追加 ★推奨 —
  既存ヘルパがそのまま使え、`match` は実 Cache へ委譲されるので「記録あり・不一致」の
  前提を実エントリで作れる。
- b) 現状維持（実運用で delete が失敗するのは稀、と割り切る）。

リスク: 無し（テスト追加のみ）。\
対象: src/core.ts:1646-1655（未到達）/ src/mod.test.ts:3238-3257（不一致テスト本体）\
影響範囲: cache 層 open 経路の通知契約。

引き継ぎ:

- ファイル: `src/mod.test.ts`（3257 の直後）
- テスト名: `openCachedUrl: 記録不一致の evict に失敗しても undefined へ縮退し op:"delete" で通知する`
- 手順: `fetchBytes(URL_A, { fetch, sha256: BYTES_A_SHA256 })` で温める →
  `openCachedUrl(URL_A, { sha256: BYTES_B_SHA256, caches: failingCacheStorage({ delete: () => Promise.reject(new Error("delete failed")) }), onCacheError: push })`。
- 観測値: 戻りが `undefined` / `notified.map(c => c.op)` が `["delete"]` /
  `notified[0].url === URL_A` / **エントリは残っている**（`cache.match(URL_A)` が非 undefined
  ＝ 「消せなかった」ことが観測できる）。
- 検証手順: core.ts の `try`/`catch` を外すと `assertRejects` されない reject で赤になる。

---

### G3-03. "blob" 戦略の `signal` を縛るテストを足すか？ [E/test-gap]

概要: ADR 0012 §2 は「`"blob"` では呼び出し時に 1 回見るだけ」と決めており、実装も
core.ts:1478 に `signal?.throwIfAborted()` を置いている。だが `signal` を渡すテストは
stream 戦略の 1 本だけ（mod.test.ts:3323）で、**blob 戦略に signal を渡すテストがゼロ**。\
守っている目的は「戦略を切り替えても中断の契約が消えない」こと — ブラウザ既定は "blob"
なので、実利用の主戦場がこちら側であることに注意。

フォルト注入: core.ts:1478 を削除 → 全テスト緑のまま。

- a) 事前 abort 済み signal を両戦略へ渡す 1 本を追加 ★推奨 — 実測で両戦略とも
  `signal.reason`（`pre-aborted`）がそのまま出ることを確認済みなので、
  既存の戦略ループ（3291 の `for`）に相乗りできる。
- b) blob 戦略だけの単独テストを足す。
- c) 現状維持。

リスク: 無し。\
対象: src/core.ts:1478（未到達）/ src/mod.test.ts:3291-3321（戦略ループ）\
影響範囲: 両戦略の中断契約。

引き継ぎ:

- ファイル: `src/mod.test.ts`、既存の `for (const strategy of ["blob", "stream"] as const)`
  ブロック（3291）内、または新規の同型ループ。
- テスト名: `openCachedUrl: 呼び出し前に abort 済みの signal は入口で reject する（${strategy} 戦略）`
- 縛る振る舞い: `controller.abort(reason)` 済みの signal を `read` に渡すと、キャッシュを
  読む前に `reason` そのもので reject する。
- 観測値: `assertRejects` の戻りが `reason` と `assertStrictEquals`。stream 側は
  「`match` に到達していない」ことも縛れる（`failingCacheStorage({ match: () => { throw new Error("到達してはいけない") } })` を DI し、その文言が出ないこと）。
- 検証手順: core.ts:1478（blob）/ 1505（stream）をそれぞれ削ると、対応する戦略のケースだけが
  赤になる（1505 側は G3-01 の追加後に単独で赤にできる）。

---

### G3-04. `length 0` / `offset == size` の境界テストを足すか？ [E/test-gap]

概要: 区間読みの境界（`length === 0`、`offset === size`、`offset > size` で `length === 0`）は
両戦略でまったく別のコードを通る — blob は `offset + length > blob.size` の 1 本
（core.ts:1479）、stream は `while (skipped < offset || filled < length)` のループ条件
（core.ts:1534）で決まる。**どちらも未テスト**。\
守っている目的は「戦略を替えても呼び出し側から見た振る舞いが同じ」こと（ADR 0012 §2 が
`strategy` を診断用としか位置づけていないのは、観測可能な差が性能だけである前提に立つため）。

このレビューで実測した現状（両戦略とも一致・実装は正しい）:

| 呼び出し（本文 5 バイト） | blob                 | stream               |
| ------------------------- | -------------------- | -------------------- |
| `read(0, 0)`              | 空配列               | 空配列               |
| `read(5, 0)`              | 空配列               | 空配列               |
| `read(6, 0)`              | `本文 5 バイト` で throw | `本文 5 バイト` で throw |
| 本文 0 バイト・`read(0, 0)` | 空配列             | 空配列               |
| 本文 0 バイト・`read(0, 1)` | `本文 0 バイト` で throw | `本文 0 バイト` で throw |

⇒ **バグではない。回帰ガードが無いだけ**。stream 側は特に脆く、ループ条件を
`while (skipped < offset && filled < length)` などに変異させると `read(5, 0)` が
`本文 5 バイト` で throw に転ぶが、現状テストは全部緑のまま。

- a) 戦略ループの中に境界ケース表を 1 本追加 ★推奨 — 上表をそのままテーブル駆動にすれば
  6 ケースで両戦略を縛れる。空エントリは `cache.put(URL, new Response(new Uint8Array(0)))`
  で作れる（`fetchBytes` を通す必要は無い）。
- b) `read(0, 0)` だけ足す（最小）。
- c) 現状維持。

リスク: 無し。\
対象: src/core.ts:1479 / 1534 / 1517-1518（境界分岐）/ src/mod.test.ts:3291-3321\
影響範囲: 両戦略の区間契約。公開 API の観測可能な振る舞い。

引き継ぎ:

- ファイル: `src/mod.test.ts`
- テスト名: `openCachedUrl: 空区間と末尾ちょうどの境界は両戦略で同じ結果になる（${strategy} 戦略）`
- 縛る振る舞い: 上表のとおり。`length === 0` は範囲内なら空配列、範囲外（`offset > size`）なら
  他と同じ「範囲外」文言で throw。
- 使うヘルパ: 既存 `mockFetch` + `fetchBytes` で 5 バイトエントリ、空エントリは
  `caches.open(CACHE_NAME)` 経由の `cache.put` 直書き（既存 3264 と同じ書き方）。
- 検証手順: core.ts:1534 のループ条件を `&&` へ、または 1479 の `>` を `>=` へ変異させて
  赤になることを確認する。

---

### G3-05. `readFromStream` の `body === null` 分岐（core.ts:1515-1519）をテストするか、それとも実装から落とすか？ [E/dead-branch]

概要: この分岐は「body を持たない応答は 0 バイト」として扱う保険だが、**Deno の実 Cache では
到達しない**ことを実測した — 0 バイトのエントリを put しても `cached.body` は `null` に
ならず、空の `ReadableStream` が返る。したがって現状は「テストが無い」ではなく
「テストで通す手段が DI しか無い分岐」。\
守っている目的は fail-loud（0 バイト応答で無言の空配列を返さない）。ブラウザや将来の Deno が
`null` を返す可能性は消せないので、削るより縛るほうが筋。\
なお同じ `body: null` の偽 Response は mod.test.ts:3488 で **blob 戦略のテストに既に登場して
いる**（そちらは `blob()` を叩くので null 分岐は通らない）ので、材料は揃っている。

フォルト注入: 1515-1519 を丸ごと削除 → 全テスト緑のまま（`body!.getReader()` で
TypeError になる経路にも誰も入らない）。

- a) 偽 `match` が `body: null` の Response を返す stream 戦略テストを 1 本足す ★推奨 —
  2 ケース（`read(0, 0)` が空配列 / `read(0, 1)` が `本文 0 バイト` で throw）で分岐の
  両側を縛れる。
- b) 分岐を落として `body` を非 null 前提にする — Web 標準上 `Response.body` は
  204 / 304 等で null になり得るので、fail-loud 規約に照らして推奨しない。
- c) 現状維持（needs-human: 「実 Cache で到達しない保険をテストする価値」の判断はオーナー）。

リスク: a) は偽 Response の作りが実装依存（`headers` / `body` だけの部分実装）。既存
3486-3490 と同じ書き方なので新しい負債ではない。\
対象: src/core.ts:1515-1519 / src/mod.test.ts:3486-3490（流用元）\
影響範囲: stream 戦略のみ。

引き継ぎ:

- ファイル: `src/mod.test.ts`
- テスト名: `openCachedUrl: body を持たない応答は 0 バイト扱い（stream 戦略の保険分岐）`
- 作り方: `failingCacheStorage({ match: () => Promise.resolve({ headers: new Headers(), body: null } as unknown as Response) })` を DI（`read: "stream"`）。
  open 時も同じ Response が返るので `cached.body?.cancel()`（core.ts:1675）は no-op になる。
- 観測値: `entry.strategy === "stream"` / `await entry.read(0, 0)` が長さ 0 /
  `assertRejects(() => entry.read(0, 1), Error, "本文 0 バイト")`。
- 検証手順: 1515-1519 を削ると `body.getReader()` が TypeError になり赤。

---

### G3-06. 「バッファを確保できません」文言と `cause` の保持を assert するか？ [W/weak-assertion]

概要: `outOfRange` は `size === undefined` のとき文言を「`N バイトのバッファを確保できません`」
へ差し替え、元の `RangeError` を `cause` に残す（core.ts:1453-1468 / 1525-1529）。\
テスト（mod.test.ts:3310-3315）は `read(0, Number.MAX_SAFE_INTEGER)` に対して `"範囲外"` しか
assert しておらず、**この分岐に固有の情報を 1 つも見ていない**。しかも同じ行が blob 戦略でも
走るが、blob では `offset + length > blob.size` の通常分岐で落ちるため（実測確認済み）、
「確保できない」経路を通るのは stream のときだけ。コメントは「確保できない length も同じ
『範囲外』で出る」と両戦略の話のように書かれていて、実態とずれている。

フォルト注入: `failure.cause = error`（1527）を削除 → 緑。`size === undefined` の三項を
`本文 undefined バイト` に変異 → **緑**（`"範囲外"` は残るため）。

- a) stream 戦略のケースだけ `assertStringIncludes(error.message, "バッファを確保できません")`
  と `assertInstanceOf(error.cause, RangeError)` を足す ★推奨 — 1 行 2 行で分岐固有の情報を
  縛れる。
- b) 戦略ごとに期待文言を分けた表を作る。
- c) 現状維持。

リスク: 無し。\
対象: src/mod.test.ts:3310-3315 / src/core.ts:1525-1529\
影響範囲: stream 戦略のエラー文言のみ。

引き継ぎ: 既存テストの `await assertRejects(...)` の戻り値を受け、`strategy === "stream"` の
ときだけ上記 2 つを assert する。文言は実測済み:
`fetch-cache: 区間 [0, 9007199254740991) はエントリの範囲外です（9007199254740991 バイトのバッファを確保できません） (…)`。
併せて 3311-3313 のコメントを「stream 戦略でだけこの経路を通る」に直す。

---

### G3-07. 既定 `onCacheError`（`defaultOnOpenCacheError`）の文言を縛るテストを足すか？ [W/test-gap]

概要: ADR 0012 §4 は「既定フックの文言は取得系と分ける」を**明示的な決定**として書いている
（取得系の「network へ縮退します」をそのまま出すと縮退先を偽る）。実装は
core.ts:353-358 に別関数として存在するが、**この文言を見るテストが無い**。\
守っている目的は診断の正しさ — 「network へ縮退します」と出た利用者は network を疑う。

フォルト注入: core.ts:1600 の `?? defaultOnOpenCacheError` を `?? defaultOnCacheError` に
戻す（＝ ADR 0012 §4 の決定を丸ごと取り消す変異）→ **全テスト緑**。既定フックを叩く
テストが 1 本も無いため。

- a) `console.warn` を差し替えて 1 本追加 ★推奨 — `onCacheError` を渡さずに
  `caches: failingCacheStorage({ match: reject })` で open 経路を失敗させ、警告文言に
  `エントリ無しとして扱います` が含まれること／`network へ縮退します` が含まれないことを
  assert する。`try`/`finally` で `console.warn` を必ず戻す。
- b) `defaultOnOpenCacheError` を export してユニットテストする — 内部モジュールの export を
  増やすので推奨しない（ADR 0008 の「内部導管はテストと HF 層だけ」の趣旨に反する）。
- c) 現状維持（needs-human: 取得系 `defaultOnCacheError` の文言も同様に未テストなので、
  「既定フックの文言はテスト対象にしない」という既存方針かもしれない。オーナー確認で決まる）。

リスク: `console.warn` の差し替えは他テストへ漏れると全体を汚すので `finally` 必須。
テストは逐次実行（`--parallel` 禁止）なので競合は無い。\
対象: src/core.ts:353-358 / src/core.ts:1600 / docs/decisions/0012-open-cached-range-read.md:99-101\
影響範囲: 既定フックの文言のみ。実装変更なし。

引き継ぎ:

- ファイル: `src/mod.test.ts`
- テスト名: `openCachedUrl: 既定の通知は「エントリ無しとして扱います」（network へ縮退とは言わない）`
- 作り方: `const original = console.warn; const warned: string[] = []; console.warn = (...args) => { warned.push(String(args[0])); };`
  → `openCachedUrl(URL_A, { caches: failingCacheStorage({ match: () => Promise.reject(new Error("x")) }) })`
  → `finally { console.warn = original; await caches.delete(CACHE_NAME); }`
- 観測値: 戻りが `undefined` / `warned.length === 1` /
  `assertStringIncludes(warned[0], "エントリ無しとして扱います")` /
  `assertEquals(warned[0].includes("network へ縮退"), false)`。
- 検証手順: core.ts:1600 を `defaultOnCacheError` に戻すと赤。

---

### G3-08. 非 Deno ランタイムの既定戦略 "blob" を縛るテストを足すか？ [W/test-gap]

概要: ADR 0012 §2 の「既定は `globalThis.Deno` があれば "stream"、無ければ "blob"」は
2 分岐だが、テスト（mod.test.ts:3506）は Deno 側の 1 分岐しか見ていない。\
守っている目的は「ブラウザで blob（定数時間）、Deno で stream（ヒープを食わない）」という
性能特性の既定選択 — ブラウザ側が壊れても Deno のテストは緑のままになる。

フォルト注入: `defaultReadStrategy`（core.ts:1427-1428）を
`() => "stream"` に固定 → **緑のまま**（ブラウザ利用者は全員 stream に落ちて `read` ごとに
`match` し直す性能劣化になるが、CI では見えない）。

- a) `globalThis.Deno` を一時的に削除して既定が "blob" になることを見る 1 本を足す ★推奨 —
  実測で `Deno` は `configurable: true` なので `delete` → `Object.defineProperty` で復元できる。
  逐次実行前提（`--parallel` 禁止）なので他テストとは競合しない。
- b) `defaultReadStrategy` を DI 可能にする — 公開 API に露出しない内部関数のために配線を
  増やすので、Simplicity first に照らして推奨しない。
- c) 現状維持（needs-human: グローバルを触るテストを許すかはオーナー判断。禁止なら
  docs/limitations.md に「ブラウザ側の既定は CI で検証していない」を明記して閉じる）。

リスク: 復元に失敗すると以降の全テストが道連れになる。`try`/`finally` と
`Object.defineProperty(globalThis, "Deno", descriptor)` による厳密な復元が必須
（元の descriptor は `{ configurable: true, writable: false, enumerable: true }`）。\
対象: src/core.ts:1427-1428 / src/mod.test.ts:3506-3516\
影響範囲: 既定戦略の選択のみ。

引き継ぎ:

- ファイル: `src/mod.test.ts`（3516 の直後）
- テスト名: `openCachedUrl: Deno が無いランタイムの既定戦略は blob（ブラウザの遅延 Blob 前提）`
- 手順: `const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Deno")!;` を退避 →
  `delete (globalThis as Record<string, unknown>).Deno;` → `fetchBytes` で温めておいた
  エントリを `openCachedUrl(URL_A)` で開く → `assertEquals(entry.strategy, "blob")` →
  `finally { Object.defineProperty(globalThis, "Deno", descriptor); await caches.delete(CACHE_NAME); }`。
  ※温めは `delete` の**前**に済ませる（`fetchBytes` は `Deno` を見ないが、将来の実装変更に
  巻き込まれないように）。
- 検証手順: `defaultReadStrategy` を `() => "stream"` に固定すると赤。

---

### G3-09. 予約 origin ガードの入口列挙に `openCachedUrl` を足すか？ [W/test-gap]

概要: `openCachedUrlWithKey` は入口で `normalizeUrl`（core.ts:1598）を通しており、これが
予約 origin `https://fetch-cache.invalid/` のガードと URL 正規化を兼ねる。\
既存テスト（mod.test.ts:1008-1015）は「予約 origin は取得元 URL に使えない」を
`fetchBytes` / `prefetchUrl` / `evictUrl` の 3 入口で列挙しているが、**新しい公開入口である
`openCachedUrl` が加わっていない**。\
守っている目的はキー空間の分離 — 予約 origin 配下は配列キー（HF 内容キー等）の直列化結果
なので、URL 入口から素通しで読めてはいけない。

フォルト注入: core.ts:1598 を `const requestUrl = String(url);` に変異 → 全テスト緑のまま。
その状態では `openCachedUrl("https://fetch-cache.invalid/v1/...")` で HF 内容キーのエントリを
URL 入口から開けてしまう（読み取りのみだが、ADR 0008 が撤去した「利用者がキーを指定する口」の
復活に等しい）。

- a) 既存テスト（1008）の列挙に `openCachedUrl(reserved)` を 1 行足す ★推奨 —
  ガード契約は「全入口で同じ」なので、列挙が真実源であるべき。大文字表記のテスト
  （1057）にも同様に足す。
- b) `openCachedUrl` 節に独立したテストを新設する。
- c) 現状維持。

リスク: 無し。\
対象: src/mod.test.ts:1008-1015 / src/mod.test.ts:1057 / src/core.ts:1598\
影響範囲: 公開入口のガード列挙。

引き継ぎ: 1011-1013 の並びへ
`await assertRejects(() => openCachedUrl(reserved), Error, "予約");` を追加（`openCachedUrl`
は既に mod.test.ts:17 で import 済み）。大文字表記テスト（1057-）にも同型で 1 行。
検証手順: core.ts:1598 の `normalizeUrl` を外すと両方が赤。

---

### G3-10. body の解放（`cancel`）を縛るテストを足すか？ [W/test-gap]

概要: この実装は 3 か所で body を明示解放している — 記録不一致で捨てるとき
（core.ts:1645）、stream 戦略で開いた直後（core.ts:1675）、`readFromStream` の
`finally`（core.ts:1553）。コメントは「途中で止めた body は接続 / ファイルハンドルを保持し
続けるため必ず解放する」と目的を書いているが、**解放されたことを観測するテストが無い**。\
守っている目的はリソースリークの防止（長時間動く下流の decode ループが主用途なので、
1 トークンごとに未解放の body が積むと致命的）。

フォルト注入: 1553 の `finally` ブロックを削除 → 現行テストは緑のまま（`assertRejects` する
中断テストでも、cancel されないままの reader は誰も見ていない）。

- a) 偽 body（`cancel` を数える `ReadableStream`）を DI して、①中断時 ②充足時 ③範囲外
  throw 時 の 3 とも `cancel` が 1 回呼ばれることを縛る ★推奨 — G3-01 の偽 Cache と
  同じ材料を共有できるので、2 本まとめて書くのが効率的。
- b) `Deno.test` のリソースサニタイザに任せる — Cache API 由来の body がサニタイザに
  載るかは未確認（needs-human: `deno test` の実行はこのレビューの行動範囲外）。載っていた
  としても「どの解放が効いたか」は分からない。
- c) 現状維持。

リスク: 無し（テスト追加のみ）。\
対象: src/core.ts:1645 / 1553 / 1675\
影響範囲: リソース解放の契約。

引き継ぎ:

- ファイル: `src/mod.test.ts`
- テスト名: `openCachedUrl: stream 戦略は read を抜けるとき必ず body を解放する（中断・充足・範囲外）`
- 作り方: `let cancelled = 0;` を閉じ込めた
  `new ReadableStream({ pull(c) {...}, cancel() { cancelled++; } })` を返す偽 `match` を DI。
  1 テスト内で ①`read` を完走 ②`read` を範囲外で throw ③（G3-01 と併せるなら）中断、の順に
  呼ぶ。
- 観測値: 各呼び出しの後で `cancelled` が 1 ずつ増える。
- 検証手順: 1553 の `finally` を外すと ①③ が赤。

---

### G3-11. チャンク跨ぎを「ランタイム任せ」から「決定的」に変えるか？ [W/fragile-coverage]

概要: `RANGE_BYTES`（256 KiB）のコメントは「単一チャンクに収まらない大きさにして、stream
戦略の『チャンクをまたぐ読み飛ばし』を実際に通す」と主張している。\
**この主張は現時点では正しい** — 実測で Deno 2.9.6 の `cache.match` body は一律 65,536 バイト
刻みで返り、256 KiB は 4 チャンクになる。テストの読み位置
（`[128*1024-5, 4096]` はチャンク 2 の途中から境界を跨ぐ、`[len-8, 8]` は 3 チャンク読み飛ばし）
も実際に跨ぎを通る。\
ただし**跨ぎは実装詳細に依存していて、テストは強制していない**。Deno がチャンク長を変えて
1 チャンクで全量を返すようになると、テストは緑のまま黙って跨ぎの網羅を失う（＝ カバレッジの
サイレント劣化）。守っている目的は「offset / length がチャンク境界と無関係に正しい」こと。

- a) 偽 `Cache` の `match` で 3 バイト刻みのチャンク列（`chunkedResponse` と同型の作り）を
  返し、境界跨ぎを決定的にした 1 本を足す ★推奨 — 実 Cache のテストは残したまま、
  「跨ぎ」だけを実装非依存に固定できる。読み位置はチャンク境界の直前・直後・跨ぎを
  網羅する 5 ケース程度で足りる。
- b) コメントを「Deno 2.9 では 64 KiB 刻みなので跨ぐ（実装依存）」と正直に書き換えるだけ。
- c) 現状維持。

リスク: a) の偽 Cache は `read` ごとに新しい Response を返す必要がある（stream 戦略は
`read` の度に `match` する）。作り忘れると 2 回目の `read` が「消費済み body」で落ちる。\
対象: src/mod.test.ts:3183-3193（RANGE_BYTES の定義とコメント）/ src/core.ts:1534-1550\
影響範囲: stream 戦略の跨ぎ網羅。

引き継ぎ:

- ファイル: `src/mod.test.ts`
- テスト名: `openCachedUrl: stream 戦略はチャンク境界を跨いで読み飛ばし・詰めができる`
- 作り方: 元バイト列 `new Uint8Array([0..19])` を 3 バイトずつ 7 チャンクに割り、
  `match: () => Promise.resolve(chunkedResponse(chunks.map(c => c.slice())))` を返す偽 Cache を
  DI（毎回 `slice()` で新しい `Uint8Array<ArrayBuffer>` を作り、`chunkedResponse` の
  `readonly Uint8Array<ArrayBuffer>[]` に合わせる）。`read: "stream"` を明示。
- 観測値: `[0,3]`（チャンクぴったり）/ `[2,2]`（跨ぎ 1 回）/ `[1,11]`（跨ぎ 4 回）/
  `[17,3]`（末尾ぴったり）/ `[18,3]`（範囲外 → `本文 20 バイト`）の 5 ケースが
  それぞれ元バイト列の `subarray` と一致 / 最後だけ throw。
- 検証手順: core.ts:1543 の `Math.min(offset - skipped, chunk.length)` を
  `offset - skipped` に変異させると跨ぎケースだけ赤になる（現行テストでは 256 KiB の
  実チャンクでも赤にできるが、跨ぎが 1 チャンクに退化した瞬間に検出力が消える）。

---

### G3-12. `openHfFile` の `onCacheError` 透過を縛るテストを足すか？ [W/test-gap]

概要: `HfOpenOptions` は `read` / `onCacheError` / `caches` の 3 項目を cache 層へ転送する
（hf/mod.ts:544-549）。テスト（hf/mod.test.ts:1461）は `read` と `caches` の 2 つは
「透過したこと」を観測しているが、`onCacheError` は誰も見ていない。\
守っている目的は「HF 層は cache 層の通知契約を素通しする」こと（フックを落とすと利用者は
既定の `console.warn` に落ちて、失敗を握られたように見える）。

フォルト注入: hf/mod.ts:547 の `onCacheError: opts.onCacheError` を削除 → 全テスト緑のまま。

- a) `caches: failingCacheStorage({ match: reject })` + `onCacheError: push` で 1 本追加 ★推奨。
- b) 既存の透過テスト（1461）に相乗りさせる — そちらは成功経路なので `onCacheError` は
  呼ばれず、相乗りできない。分けるのが正しい。
- c) 現状維持。

リスク: 無し。\
対象: src/hf/mod.ts:544-549 / src/hf/mod.test.ts:1461-1497\
影響範囲: HF 層のオプション転送。

引き継ぎ:

- ファイル: `src/hf/mod.test.ts`（1497 の直後）
- テスト名: `openHfFile: cache 読出し失敗は undefined へ縮退し onCacheError を透過する`
- 手順: `openHfFile({ repo: REPO }, { path: "a.bin", sha256: BYTES_SHA256 }, { caches: failingCacheStorage({ match: () => Promise.reject(new Error("storage broken")) }), onCacheError: c => notified.push(c) })`。
  ※`failingCacheStorage` は現在 `src/mod.test.ts` のローカル定義なので、HF 側にも同型の
  最小ラッパを置くか、`src/testing/` へ移す（G3-22 参照）。
- 観測値: 戻りが `undefined` / `notified.map(c => c.op)` が `["match"]` /
  `notified[0].url` が `hfResolveUrl({ repo: REPO, path: "a.bin" })`（＝ 内容キーではなく
  ラベル用の resolve URL が入ることを併せて凍結できる）。
- 検証手順: hf/mod.ts:547 を削ると `notified` が空で赤。

---

### G3-13. `openHfFile` の `toSpec` 検査（`expectedBytes` 負 / `into` 容量不足）を縛るテストを足すか？ [W/doc-drift]

概要: `openHfFile` の JSDoc（hf/mod.ts:527-531）は「spec の**形式検査（`toSpec`）は
`fetchHfFile` と共通で走る**ので、負・非整数の `expectedBytes` や `into` に収まらない
`expectedBytes` は、読み出しに使われないまま同じ文言で throw する」と明言している。\
テストが見ているのは `sha256` の形式検査（hf/mod.test.ts:1455）だけで、
`expectedBytes` 系の 2 つは未検証 = **ドキュメントが実装より先行している状態**。\
守っている目的は「申告の食い違いはどの入口から入っても同じ扱い」という一貫性。

フォルト注入: hf/mod.ts:536 の `toSpec(file)` を `typeof file === "string" ? { path: file } : file`
に置き換える（＝ 検査を素通し）→ `sha256: "zz"` のケースだけ赤になり、
`expectedBytes: -1` / `into` 容量不足は緑のまま通ってしまう。

- a) 既存の throw テスト（1438）に 2 ケース追加 ★推奨 — 1 行ずつで済む。
- b) 現状維持し、JSDoc から `expectedBytes` / `into` の記述を削る — 実装は実際に検査して
  いるので、記述を消すほうが実態から遠ざかる。推奨しない。

リスク: 無し。\
対象: src/hf/mod.ts:527-531（JSDoc の主張）/ src/hf/mod.ts:536 / src/hf/mod.test.ts:1438-1459\
影響範囲: HF 層の入口検査。

引き継ぎ:

- ファイル: `src/hf/mod.test.ts`、既存テスト `openHfFile: sha256 の無い spec は throw する`
  の中（名前が合わなくなるので `openHfFile: spec の形式検査は fetchHfFile と共通で走る` へ
  分割するのが望ましい）。
- 追加ケースと観測値:
  - `{ path: "a.bin", sha256: BYTES_SHA256, expectedBytes: -1 }` →
    `assertRejects(..., Error, "0 以上の整数")`
  - `{ path: "a.bin", sha256: BYTES_SHA256, expectedBytes: 8, into: new Uint8Array(4) }` →
    `assertRejects(..., IntoCapacityError)`（既存 HF テストと同じ語彙。`into.length` と
    `expectedBytes 8 バイト` が文言に出る）
- 検証手順: hf/mod.ts:536 の `toSpec` を素通しにすると 2 ケースとも赤。

---

### G3-14. `readFromBlob` の短返りガード（core.ts:1487-1491）を縛るか、落とすか？ [W/dead-branch]

概要: 「範囲内なのに短い = Cache / Blob 実装の異常」を fail loud に落とすガード。
正常な Blob 実装では到達しないので**現状は完全に未到達**。\
守っている目的は「欠けたバイト列を黙って返さない」こと（区間読みは検証を持たないので、
この 1 本が唯一の長さ保証）。

フォルト注入: 1487-1491 を削除 → 緑のまま。

- a) 偽 Blob（`size` は大きいのに `slice().arrayBuffer()` が短い列を返す）を返す偽 Response を
  DI して 1 本足す ★推奨 — `blob()` を叩くのは core.ts:1663 の 1 か所なので、
  `{ headers: new Headers(), body: null, blob: () => Promise.resolve(fakeBlob) }` で通せる。
- b) 現状維持（needs-human: 「実装異常に対する保険をテストする価値」の判断。G3-05 と同じ
  性質の問いなので、まとめて 1 つの方針として決めるのが筋）。

リスク: 偽 Blob は `size` / `slice` / `arrayBuffer` の部分実装になるので、Blob の型に対する
キャストが要る（既存 3486 の偽 Response と同じ手法）。\
対象: src/core.ts:1487-1491\
影響範囲: blob 戦略のみ。

引き継ぎ: テスト名 `openCachedUrl: blob が要求より短く返したら fail loud に落ちる（blob 戦略）`。
偽 Blob は `{ size: 100, slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(3)) }) } as unknown as Blob`。
観測値: `assertRejects(() => entry.read(0, 10), Error, "3 バイトしか返しませんでした")`。

---

### G3-15. `prefetchUrl` / `prefetchHfFile` で温めたエントリを開くテストを足すか？ [W/test-gap]

概要: ADR 0012 §1 と両 API の JSDoc は「温めるのは呼び出し側の責任（`fetchBytes` /
`prefetchUrl`）」「温めは `fetchHfFile` / `prefetchHfFile` の担当で、どちらも同じ内容キーへ
書くのでそのまま開ける」と、**prefetch 経路を対等な温め手段として約束している**。\
だが追加テストの温めは `fetchBytes` / `fetchBytesWithKey` / `fetchHfFile` / 手 put の 4 通りで、
**prefetch 系が 1 本も無い**。\
守っている目的は「取得系 2 種 × 区間読み」の結合契約 — 特に prefetch は記録ハッシュを焼く
経路が `fetchBytes` と別（body を流し切ってから put する）なので、`sha256` 付きで開ける
かどうかは別途縛る価値がある。

フォルト注入: 直接の変異は指しにくい（両者は同じ `cache.put` を使う）ため、これは
「回帰の検出」ではなく「約束の検証」寄りの指摘。将来 prefetch 側のヘッダ焼き込みが変われば
区間読みが黙って `undefined` に転ぶ。

- a) cache 層 1 本 + HF 層 1 本を足す ★推奨。
- b) cache 層だけ足す。
- c) 現状維持。

リスク: 無し。\
対象: docs/decisions/0012-open-cached-range-read.md:51-52 / src/hf/mod.ts:519-521\
影響範囲: 温め経路の結合。

引き継ぎ:

- `src/mod.test.ts`: テスト名 `openCachedUrl: prefetchUrl で温めたエントリも sha256 付きで開ける`。
  `prefetchUrl(URL_A, { fetch, sha256: BYTES_A_SHA256 })` → `openCachedUrl(URL_A, { sha256: BYTES_A_SHA256 })`
  → `read(0, BYTES_A.length)` が `BYTES_A` / `calls.length === 1`（open / read は network に
  出ない）。
- `src/hf/mod.test.ts`: テスト名 `openHfFile: prefetchHfFile で温めた内容キーもそのまま開ける`。
  `prefetchHfFile({ repo: REPO }, { path: "a.bin", sha256: BYTES_SHA256 }, { fetch })` →
  `openHfFile(...)` → `read(1, 2)` が `BYTES.subarray(1, 3)` / `calls.length` が
  prefetch の 2 回から増えないこと。

---

### G3-16. `finally` の `caches.delete` が無いテスト 2 本を揃えるか？ [L]

`openCachedUrl: caches.open 失敗…`（src/mod.test.ts:3352-3368）と
`openCachedUrl: read の不正値は入口で throw する`（src/mod.test.ts:3419-3446）は
`try`/`finally` を持たず `caches.delete(CACHE_NAME)` もしない。\
現状はどちらも固定名前空間へ**書き込まない**ので汚染は起きない（確認済み）。ただし
CLAUDE.md の「テスト毎に finally で `caches.delete`」から外れており、後で 1 行足したときに
汚染が黙って入る。提案: 他 14 本と同じ `try`/`finally` を被せる（2 行ずつ）。

---

### G3-17. `blob()` 失敗の通知 `op` が `"match"` である割り当てを文書化するか？ [L]

`cached.blob()` の失敗は `onCacheError({ op: "match", ... })` として通知される
（src/core.ts:1665）。`CacheErrorContext.op` は `"open" | "match" | "put" | "delete"` の
4 値（src/core.ts:30）なので `"blob"` は無く、割り当て自体は妥当。\
テスト（src/mod.test.ts:3483-3505）はこの割り当てを凍結しているが、ADR 0012 §4 も JSDoc も
「`blob()` の失敗が `op: "match"` として届く」とは書いていない。`op` で分岐する利用者から
見ると意外なので、`OpenCachedOptions.onCacheError` の JSDoc に 1 文足すのが安い。

---

### G3-18. ROADMAP G3-05（`HfResolveOptions` の名前付き公開型化）の発火条件が満たされた [L]

前回レビュー（2026-09-05）で「次の HF 層 API 変更に同乗」として ROADMAP 送りになった項目。\
本コミットは HF 層に `openHfFile` と **名前付き公開型 `HfOpenOptions`**（src/hf/mod.ts:498）を
追加しており、HF 層の公開 API が実際に変わった＝同乗の機会が来ている。\
一方 `resolveHfRevision` の第 2 引数は今も匿名インライン型のまま（src/hf/mod.ts:173-180）で、
`HfFetchOptions` / `HfPrefetchOptions` / `HfOpenOptions` と並ぶと不揃い。追加のみ・非 breaking。\
提案: 0.8.0 に同乗して `export type HfResolveOptions = { fetch?; init?; retry?; onRetry? }` を
切り出し、`resolveHfRevision` のシグネチャをそれに差し替える（採否はオーナー）。

---

### G3-19. テスト名と内容の乖離: `openCachedUrlWithKey: …区間読みは検証系オプションを持たない` [L]

src/mod.test.ts:3386。名前が謳う「検証系オプションを持たない」は型で保証済みで、
このテストは 1 つも assert していない（実際に見ているのは ①配列キーで開ける ②URL キー側とは
分離している ③`sha256` の形式検査 ④区間の非整数・負の検査 の 4 つ）。\
提案: 名前を `openCachedUrlWithKey: 配列キーのエントリを開き、キー空間は URL 側と分かれる`
へ寄せ、③④ は入口検査のテスト（3419）側へ移すと 1 テスト 1 関心になる。

---

### G3-20. `assertRange` の未踏み組み合わせ [L]

src/core.ts:1433-1446 の条件は 4 項の OR。テストが踏むのは `offset < 0`（3412）と
`!Number.isSafeInteger(length)`（3413）の 2 つで、`length < 0` と
`!Number.isSafeInteger(offset)` は未踏（文言は同一なので実害は小さい）。\
提案: 既存の 2 行の並びに `entry.read(1.5, 1)` と `entry.read(0, -1)` を足す（実測で
どちらも `0 以上の整数` で落ちることを確認済み）。

---

### G3-21. `openHfFile` の repo kind / hubUrl 差の未テスト [L]

内容キーは `["hf", kind, repo, path, sha256]`（kind を含む）だが、`openHfFile` のテストは
既定 kind（`model`）のみ。`fetchHfFile` 側には kind 別のテストがあるので、
「`fetchHfFile({ kind: "dataset" })` で温めたものが `openHfFile({ kind: "dataset" })` で開き、
`kind` を変えると `undefined`」の 1 本があるとキー一致の契約が閉じる（優先度は低い）。

---

### G3-22. `failingCacheStorage` の置き場所 [L]

`failingCacheStorage`（src/mod.test.ts:46-72）は cache 層テストのローカル定義だが、
HF 層でも同型のフォールト注入が要る（G3-12）。今回追加された偽 `CacheStorage` は
mod.test.ts に 2 種（3354 の `brokenCaches`・3421 の `untouchableCaches`）、
hf/mod.test.ts に 1 種（1467 の `spyCaches`）と計 3 つのほぼ同じボイラープレートが増えた。\
提案: `src/testing/` に `cacheStorageStub({ open?, match?, delete? })` を 1 つ置いて
3 種を畳む（`src/testing/` は publish 対象外なので依存ゼロ規約に抵触しない）。
0.8.0 に必須ではないので、G3-12 を実装するときに同乗させるのが安い。

---

## 重要経路の ASCII 図（実コード行番号付き）

```
openCachedUrlWithKey (core.ts:1593)
 ├─ normalizeUrl(url)                       1598  ← 予約 origin ガード  【未テスト G3-09】
 ├─ sha256 形式検査 → throw                 1604  ✔ mod.test.ts:3407
 ├─ read 値検査 → throw                     1611  ✔ mod.test.ts:3419
 ├─ globalCaches() === undefined → undefined 1623 【未テスト・needs-human（グローバル差替が要る）】
 ├─ cacheStorage.open 失敗 → op:"open"      1628  ✔ mod.test.ts:3352
 ├─ cache.match 失敗    → op:"match"        1635  ✔ mod.test.ts:3370
 ├─ cached === undefined → undefined        1639  ✔ mod.test.ts:3230
 ├─ sha256 と記録の突合                     1643
 │   ├─ 記録あり・不一致 → body.cancel      1645 【cancel 未観測 G3-10】
 │   │                   → cache.delete     1650  ✔ mod.test.ts:3238
 │   │                   → delete 失敗      1652 【未テスト G3-02】★
 │   └─ 記録なし → evict せず undefined     1656  ✔ mod.test.ts:3259
 ├─ strategy = opts.read ?? default          1658
 │   ├─ Deno あり → "stream"                1427  ✔ mod.test.ts:3506
 │   └─ Deno なし → "blob"                  1428 【未テスト G3-08】
 ├─ "blob": cached.blob()                   1663
 │   └─ blob() 失敗 → op:"match"            1665  ✔ mod.test.ts:3483
 └─ "stream": cached.body.cancel()          1675 【cancel 未観測 G3-10】

readFromBlob (core.ts:1470)
 ├─ assertRange                             1477  ✔（4 項中 2 項のみ G3-20）
 ├─ signal.throwIfAborted                   1478 【未テスト G3-03】★
 ├─ offset+length > blob.size → throw       1479  ✔ mod.test.ts:3300
 │     └─ length 0 / offset==size の境界          【未テスト G3-04】★
 └─ 短返りガード                            1487 【未到達 G3-14】

readFromStream (core.ts:1496)
 ├─ assertRange                             1504  ✔
 ├─ signal.throwIfAborted（入口）           1505  ✔ ただし 1536 と相互に隠し合う G3-01
 ├─ cache.match → undefined → throw         1509  ✔ mod.test.ts:3448
 ├─ body === null 分岐                      1515 【未到達（実 Cache では null にならない）G3-05】★
 ├─ new Uint8Array(length) 失敗 → 範囲外    1524  ✔ ただし文言・cause 未 assert G3-06
 ├─ ループ                                  1534
 │   ├─ signal.throwIfAborted（境界）       1536 【実質未テスト G3-01】★
 │   ├─ done → 範囲外（skipped+filled）     1540  ✔ mod.test.ts:3302
 │   ├─ 読み飛ばし（跨ぎ）                  1542  ✔ ただしランタイム依存 G3-11
 │   └─ 詰め（跨ぎ）                        1547  ✔ 同上
 └─ finally reader.cancel()                 1553 【未観測 G3-10】

openHfFile (hf/mod.ts:534)
 ├─ toSpec(file)                            536  ✔ sha256 のみ / expectedBytes・into 未テスト G3-13
 ├─ spec.sha256 === undefined → throw       537  ✔ hf/mod.test.ts:1438
 ├─ hfResolveUrl（ラベル用）                544  ✔ revision 非依存 hf/mod.test.ts:1427
 └─ openCachedUrlWithKey へ転送             545
     ├─ sha256   ✔ / read ✔ 1490 / caches ✔ 1493
     └─ onCacheError                        547 【未テスト G3-12】★
```

（★ = 実装のどの変異でも赤にならない箇所）

---

## 横断所見

1. **「凍結する」と書いたコメントが凍結できていない箇所が 2 つある**（G3-01 の中断、
   G3-11 の跨ぎ）。どちらも主張自体は今の実装・今のランタイムでは正しいが、テストが
   その性質を**強制していない**ため、実装やランタイムが変わった瞬間に黙って検出力を失う。
   コメントで契約を宣言するときは「その契約を壊す変異で赤になるか」を 1 度書き下すと
   同型の穴が塞げる。
2. **ADR の決定と回帰ガードの対応表が無い**。ADR 0012 は §1〜§5 で 12 個ほどの決定を
   しているが、うち 4 つ（中断の粒度・既定フックの文言・非 Deno の既定戦略・
   HF 層の `onCacheError` 透過）はテストが 1 本も無い。ADR ごとに「この決定を守る
   テストはどれか」を 1 行で書く運用にすると、今回のような取りこぼしが構造的に減る
   （sop-curator へ回す価値がある提案）。
3. **失敗パスの網羅に偏りがある**。`open` / `match` / `blob()` の失敗は丁寧に縛られている
   一方、`delete` の失敗と body の解放という「後始末側」が空。前者は縮退の入口なので
   目に付きやすく、後者は成功しても何も起きないので見落としやすい、という非対称。
4. **偽 `CacheStorage` のボイラープレートが 3 種に増えた**（G3-22）。今回追加した
   テストの半分近くが同じ 5 メソッドの委譲を書き直している。`src/testing/` に 1 つ置けば
   今後の DI テストが 3 行で書けるようになる。
5. **実測で確定した外部依存の性質は、コメントに日付と数値ごと残すと後で効く** — ADR 0012 の
   Context 表（Chrome 152 / Deno 2.9 の実測）は良い前例。今回のチャンク長
   「Deno 2.9.6 で 65,536 バイト固定」も同じ形で残す価値がある（G3-11 の b 案）。
6. `deno task check` の `deno test --allow-read`（deno.json:16）に `--allow-net` が無いことは
   確認済みで、hf/mod.test.ts:1414-1415 の「network に出れば権限エラーで落ちる」という
   主張は正しい。`calls.length` の据え置きと二重に縛られていて良い作り。
