---
id: G4
topic: 文書と実装の突合（README / ADR 0012 / limitations / CLAUDE.md / JSDoc / known-issues）
files_reviewed:
  - README.md
  - docs/decisions/0012-open-cached-range-read.md
  - docs/limitations.md
  - docs/known-issues.md
  - CLAUDE.md
  - src/core.ts（JSDoc: CachedEntry / OpenCachedOptions / openCachedUrl / openCachedUrlWithKey / defaultReadStrategy）
  - src/hf/mod.ts（JSDoc: モジュール doc / HfOpenOptions / openHfFile）
  - src/mod.ts（モジュール doc）
date: 2026-09-07
model: opus (effort high)
---

## サマリ

0.8.0（`openCachedUrl` / `openHfFile`）の文書 4 者（README / ADR 0012 / limitations.md /
JSDoc）を実装へ突合した。\
**主要な挙動主張は 24 件中 22 件が holds**（記録ハッシュの文字列比較だけで判定・不一致は
evict・記録なしは evict せず undefined・network に出ない・既定戦略は Deno なら "stream"・
length ちょうど / 短い戻りは throw・範囲外は throw・"stream" の signal はチャンク境界 /
"blob" は 1 回・ハンドルはスナップショットではない・HF は sha256 必須で無宣言は throw）。\
README の 2 つのコードブロックは実際に型として通ることを確認した（実 import で
`deno check` 済み）。公開文書への開発履歴の漏れも無い。

破れたのは **`onCacheError` の `op` 語彙** で、`open` 経路は自己修復の delete 失敗でも通知
するのに JSDoc / README / ADR は「open / match」としか書いていない（G4-01）。加えて
`blob()` 失敗が `op: "match"` を名乗ることはテストで凍結済みなのにどの文書にも無い
（G4-02）。残りは「書かれていない」型の抜け（`caches` の無いランタイム・ハンドル寿命・
中断粒度）と、`"stream"` の `body === null` 仮定が README 自身の body-null ランタイム記述と
食い違う 1 件（G4-06・needs-human）。

件数: **W 7 件 / L 9 件（E・C は 0 件）**。うち needs-human 1 件（G4-06）。\
`docs/known-issues.md` は**追記不要**と判定した（区間読みの穴はいずれも by-design で
limitations.md 側が正しい置き場。理由は横断所見 ④）。

## ファイル別 5 段階分類

| ファイル | 分類 | 根拠 |
| --- | --- | --- |
| README.md | **W** | 主張は概ね holds だが、Runtime support（L652-665）が新 API 未反映（G4-03）・ハンドル寿命の記述欠落（G4-04）・折り返し崩れ（G4-08） |
| docs/decisions/0012-open-cached-range-read.md | **W** | Decision / Consequences は実装と一致。§4 の `op` 語彙が不完全（G4-01 / G4-02）、§1 スニペットが型として通らない（G4-11）、§5 の「参照もされない」が実挙動とずれる（G4-16） |
| docs/limitations.md | **W** | 区間読み 3 項目は全て holds。中断粒度（G4-05）と `caches` 無しランタイム（G4-03）の by-design が未記載 |
| docs/known-issues.md | **S** | 変更なし。今回の差分で追記すべき「未解決問題」は無い（横断所見 ④） |
| CLAUDE.md | **L** | Layout の列挙は実装と一致（`openCachedUrl` / `openCachedUrlWithKey` / `openHfFile` の 3 か所）。行幅だけ既存規約から外れる（G4-09） |
| src/core.ts（JSDoc 範囲） | **W** | `OpenCachedOptions.onCacheError`（1413）の「open / match」が delete 通知（1649）と食い違う（G4-01）。`body === null` の 0 バイト断定（1515）が未文書・未テスト（G4-06） |
| src/hf/mod.ts（JSDoc 範囲） | **W** | `openHfFile` の主張（network 非依存・toSpec 共通検査・backfill 後に開ける）は全て holds。`HfOpenOptions.onCacheError`（504）が G4-01 と同じ文言 |
| src/mod.ts（モジュール doc） | **S** | 追記 3 行（19-21）の主張は全て実装どおり。再公開の型（`CachedEntry` / `OpenCachedOptions`）も揃っている |

## 主張の着地一覧（チェック観点 1）

| # | 主張（出典） | 実装 | 判定 |
| --- | --- | --- | --- |
| 1 | "stream" の signal はチャンク境界で見る（README:315-316 / ADR §2 / core.ts:1372-1374） | core.ts:1536（ループ先頭）+ 1505（入口） | holds |
| 2 | "blob" は呼び出し時に 1 回だけ見る（README:316-318 / ADR §2） | core.ts:1478 | holds |
| 3 | 記録なし → undefined・evict しない（README:326-328 / ADR §3 表 / limitations:158） | core.ts:1640-1656（`recorded !== null` のときだけ delete） | holds |
| 4 | 記録と不一致 → evict → undefined（同上） | core.ts:1641-1650 | holds |
| 5 | open 失敗 → undefined + onCacheError（README:332-333 / ADR §4） | core.ts:1626-1630 | holds |
| 6 | read 失敗 → そのまま throw（同上） | core.ts:1509-1513（match 結果が undefined）/ match の reject は非捕捉 | holds |
| 7 | HF は sha256 必須・無宣言は throw（README:335-339 / ADR §5 / limitations:162-164） | hf/mod.ts:536-541 | holds |
| 8 | 既定戦略は Deno なら "stream"（README:313-314 / ADR §2 / limitations:165-167） | core.ts:1427-1428 | holds |
| 9 | read は length ちょうど・短い戻りは throw（README:318-320 / ADR §1） | core.ts:1485-1491（blob）/ 1534-1551（stream はループ条件上短く返せない） | holds |
| 10 | 範囲外は throw（同上） | core.ts:1479-1481（blob.size）/ 1540（末尾到達） | holds |
| 11 | ハンドルはスナップショットではない（ADR Consequences / limitations:170-172 / core.ts:1575-1580） | core.ts:1509-1513（stream は消えたら throw）/ 1668-1672（blob は保持） | holds |
| 12 | 2 値以外の `read` は入口で throw（ADR §2 / core.ts:1400-1401 の JSDoc） | core.ts:1611-1619 | holds |
| 13 | `validate` / `decode` / `recheck` / `into` を持たない（ADR §3 / limitations:152-154 / README:328-330） | `OpenCachedOptions`（core.ts:1385-1420）は 4 項目のみ | holds |
| 14 | network に出ない（全文書） | core.ts に fetch 呼び出し無し（hf 側も resolveHfRevision を呼ばない） | holds |
| 15 | 温めは fetchBytes / prefetchUrl / fetchHfFile / prefetchHfFile と同じキー空間（hf JSDoc:526） | hf/mod.ts:544（`contentKey`）= 288-290 / 449 と同一式 | holds |
| 16 | toSpec の形式検査は共通で走る（hf JSDoc:523-526） | hf/mod.ts:535 → 324-351（sha256 / expectedBytes / into 容量） | holds |
| 17 | README の `entry?.read(...)` 例が型として通る | 実 import で `deno check` 済み（両ブロックとも緑） | holds |
| 18 | onCacheError の op は「open / match」（core:1413 / hf:504 / README:332 / ADR §4） | core.ts:1649 が `op: "delete"` を通知 | **refuted → G4-01** |
| 19 | `blob()` 失敗の op（どの文書にも記載なし） | core.ts:1665 が `op: "match"`（mod.test.ts:3483-3504 で凍結） | **未文書 → G4-02** |
| 20 | `caches` の無いランタイムでの挙動（README:660-665 の一覧） | core.ts:1623 が undefined（prefetch のような throw ではない） | **未文書 → G4-03** |
| 21 | "stream" の本文長は末尾到達時の消費バイト数（ADR §4） | core.ts:1515-1519 は body null を無条件に 0 バイトと断定 | **uncertain → G4-06** |
| 22 | `ref.revision` は解決も参照もされない（ADR §5） | hf/mod.ts:543 → hfResolveUrl が URL に埋め込み、onCacheError の `url` にも出る | 表現ずれ → G4-16 |
| 23 | 実測値（117 / 300 / 326 ms・0.2〜0.9 ms・RSS +517 MiB・137 回 42 秒） | コードから検証不能 | uncertain（G4-13・一覧のみ） |
| 24 | README と ADR の数値の一致 | 117 ms / 300 ms は同条件で一致。ADR 表の Chrome 行だけ対象サイズ表記が無い | holds（注記 G4-13） |

## 重要経路の ASCII 図（実コード行番号付き）

```
openHfFile(hf/mod.ts:530)
  535 toSpec ─ sha256/expectedBytes/into の形式検査（fetchHfFile と共通）
  536 spec.sha256 無し → throw          … README:335-339 / ADR §5 / limitations:161-164  [holds]
  543 hfResolveUrl（revision はラベル）  … ADR §5「参照もされない」は表現ずれ            [G4-16]
  544 openCachedUrlWithKey(contentKey)
        │
        ▼
openCachedUrlWithKey(core.ts:1593)
  1598 normalizeUrl / 1604 sha256 形式検査 / 1611-1619 read 値検査（"blob"|"stream" 以外は throw）
  1623 caches 無し ────────────────► undefined      … 文書なし                        [G4-03]
  1625 open 失敗 ─ onCacheError{op:"open"}(1628) ► undefined
  1632 match 失敗 ─ onCacheError{op:"match"}(1635) ► undefined
  1638 match 無し ─────────────────► undefined
  1640 recorded = headers[x-fetch-cache-sha256]
       ├ sha256 未指定 ──────────────► 開く（無検証の生読み）  … README に記載なし      [G4-12]
       ├ recorded === sha256 ────────► 開く
       ├ recorded !== sha256（記録あり）
       │    1646 cache.delete → 失敗時 onCacheError{op:"delete"} … 文書に無い op       [G4-01]
       │                                └────► undefined
       └ recorded === null（記録なし）─► undefined（evict しない）                     [holds]
  1658 strategy = opts.read ?? defaultReadStrategy()(1427)
       ├ "blob"  1663 cached.blob()
       │           失敗 → onCacheError{op:"match"} ► undefined … op が未文書           [G4-02]
       │         read = readFromBlob(1470)
       │           1477 assertRange → 1478 signal 1 回 → 1479 size 比較 → 1482 slice
       │           1485 短い戻り → throw                                               [holds]
       └ "stream" 1676 開く時の body を cancel
                 read = readFromStream(1496)
                   1508 cache.match（消えていれば 1509-1513 で throw）        [holds]
                   1515 body === null → 「0 バイト」と断定                             [G4-06]
                   1523-1529 確保失敗 → 範囲外へ読み替え
                   1534 ループ: 1536 signal / 1540 done → 範囲外 throw
```

## 指摘の詳細

### 1. `openCachedUrl` 経路の `onCacheError` が `op: "delete"` も通知することを、文書 3 か所に書き足しますか [W / 文書ドリフト（refuted）]

概要: 文書は「開く時の cache I/O 失敗は open / match」と宣言しているが、実装は記録ハッシュ
不一致の self-heal で `cache.delete` に失敗したときも同じフックへ `op: "delete"` を流す。\
`op` で分岐している呼び出し側（`CacheErrorContext.op` は公開型）は、文書どおりに
`"open" | "match"` だけを想定すると未知の op を取りこぼす。\
発生条件: `sha256` 指定 × 記録不一致 × `cache.delete` が reject（quota / storage 破損）。\
守っている目的: 「無言では握り潰さない」（ADR 0001）通知契約の**観測可能な語彙**を文書と
一致させること。

- a) 3 か所（`OpenCachedOptions.onCacheError` / `HfOpenOptions.onCacheError` / ADR 0012 §4）を
  「open / match / delete」に直し、README:332-333 にも delete を含める ★推奨 —
  実装の観測可能な挙動が正で、文書だけの修正で閉じる（追加コスト最小・破壊的変更なし）
- b) 併せて self-heal delete 失敗のテストを 1 本足す（現状この分岐は未テスト — `open` 経路の
  失敗注入テストは mod.test.ts:3352 / 3370 / 3483 の 3 本で、delete 失敗が無い）
- c) 現状維持 — 公開型 `CacheErrorContext.op` は 4 値のままなので実害は「文書が不完全」に留まる

リスク: a) は文言のみで挙動不変。b) は `failingCacheStorage` に delete 注入を足すだけだが、
テスト追加はコード側グループの範囲と重複しうる。

対象: src/core.ts:1413（JSDoc）/ src/core.ts:1649（実装）/ src/hf/mod.ts:504（JSDoc）/
docs/decisions/0012-open-cached-range-read.md:97-99 / README.md:332-333

影響範囲: 文書のみ（a）。呼び出し側の `onCacheError` 実装の分岐網羅性に影響。

引き継ぎ: 機序 — `openCachedUrlWithKey` は記録不一致のとき `cache.delete(storageKey)` を
try で囲み、失敗を `onCacheError({ op: "delete", ... })` で通知して `undefined` を返す
（core.ts:1644-1656）。`fetchBytes` 側の同型処理（core.ts:760 / 792）も delete を通知する
ので、語彙自体は層をまたいで一貫している。文書だけが取り残されている。\
テスト仕様 — 「記録不一致 × delete が reject」で `onCacheError` に `op: "delete"` が 1 回届き、
戻り値は `undefined`（エントリは残る）。検証手順 — 修正後 `deno task check`（逐次）。

### 2. `blob()` 失敗が `op: "match"` を名乗ることを ADR 0012 §4 と JSDoc に明記しますか [W / 文書ドリフト（未文書の観測可能値）]

概要: ADR §4 は「開く時（`cacheStorage.open` / `cache.match` / "blob" の `blob()`）の失敗は
miss と同じ `undefined` へ縮退し `onCacheError` で通知する」と 3 つの失敗点を列挙するが、
`blob()` 失敗がどの `op` を名乗るかは書いていない。実装は `op: "match"` を使い、それを
テストが凍結している（= 事実上の契約）。\
発生条件: `read: "blob"`（ブラウザ既定）で `Response.blob()` が reject。\
守っている目的: 通知は診断のためにあり、`op` は失敗点の識別子。識別子が文書に無いと
「match が失敗したのか blob 化が失敗したのか」を利用者が切り分けられない。

- a) ADR §4 に 1 文（「`blob()` の失敗は本文取得の一部として `op: "match"` で通知する」）を足し、
  `OpenCachedOptions.onCacheError` の JSDoc にも同じ 1 句を添える ★推奨 —
  テストで凍結済みの値を文書化するだけで、挙動も型も変わらない
- b) `CacheErrorContext.op` に `"blob"` を足す — 公開型の union 拡張は下流の網羅 switch を
  壊しうる（0.1.0 以降リリース済み・`exhaustive` な分岐を書いている下流には breaking）
- c) 現状維持 — テストが唯一の真実源のままになる

リスク: b) は公開型の破壊的変更になりうるので採らない。a) は無リスク。

対象: src/core.ts:1663-1666（実装）/ src/core.ts:1413-1417（JSDoc）/
docs/decisions/0012-open-cached-range-read.md:96-99 / src/mod.test.ts:3483-3504（凍結テスト）

影響範囲: 文書のみ。

引き継ぎ: 機序 — `blob()` は match で取った `Response` の本文取得なので、実装は「読出しの
失敗 = match 系」とまとめている。判断自体は妥当（op を増やすと公開型が壊れる）。文書化で
閉じるのが正。

### 3. `caches` の無いランタイム（Node.js 等）で区間読みが `undefined` を返すことを README / limitations に足しますか [W / 文書の抜け]

概要: README「Runtime support」は API ごとの縮退表（`fetchBytes` は素の fetch・
`evictUrl` / `evict` / `clearCache` は false / 0・`listCachedUrls` / `listKeys` は `[]`・
`prefetchUrl` / `prefetchHfFile` だけは throw）を持ち、**この一覧が縮退契約の真実源**として
機能している。今回追加の `openCachedUrl` / `openHfFile` だけが載っていない。\
実装は「エントリ無し」= `undefined`（core.ts:1623）で、`prefetchUrl` 型（throw）ではない。\
発生条件: Node.js / `caches` を持たない実行環境。\
守っている目的: 「キャッシュは最適化であって正しさの要件ではない」という縮退方針の一覧性。
一覧に無い API は「throw するのか undefined なのか」を試して確かめるしかない。

- a) Runtime support の段落（README:660-665）に `openCachedUrl` / `openHfFile` を追記し、
  limitations.md の区間読み項目にも「`caches` が無ければ常に `undefined`」を 1 句添える ★推奨 —
  既存一覧の粒度に合わせるだけで、記述位置も自明
- b) README だけに足す（limitations は ADR 0012 の射程外として据え置き）
- c) 現状維持 — 実装は `undefined` で一貫しており、実害は問い合わせコストのみ

リスク: 無し（文言のみ）。

対象: README.md:652-665 / docs/limitations.md:161-164 / src/core.ts:1620-1623

影響範囲: 文書のみ。Node.js で `./hf` を使う下流（`openHfFile` は sha256 未宣言なら
`caches` の有無に関わらず throw する点も併記すると誤解が減る — hf/mod.ts:536 が
`caches` 検査より手前）。

引き継ぎ: 機序 — `openCachedUrlWithKey` は `opts.caches ?? globalCaches()` が undefined なら
即 `undefined` を返す（core.ts:1620-1623。コメントも「エラーではない」と明記）。
`openHfFile` は sha256 無しの throw（hf/mod.ts:536-541）が先に走るので、Node.js での挙動は
「sha256 あり → undefined / sha256 なし → throw」の 2 分岐になる。README にはこの 2 分岐を
1 文で書けば足りる。

### 4. 「開いたハンドルはスナップショットではない」を README にも書きますか [W / 文書の抜け（README のみ欠落）]

概要: ADR 0012 Consequences（124-126）・limitations.md:170-172・`openCachedUrl` の JSDoc
NOTE（core.ts:1575-1580）は 3 者とも「"stream" はエントリが消えると次の read が throw、
"blob" は消えた後も読める」を書いているが、**英語 README だけが無言**。README は下流の
一次読者向け文書で、この差は「evict 後に古いバイト列が読めてしまう」という観測可能な
振る舞いの差なので、知らずに書くと `evict` 後の再取得漏れになる。\
発生条件: 開いたハンドルを保持したまま `evict` / `clearCache` / self-heal が走る運用
（下流の decode ループはまさにハンドルを長期保持する）。\
守っている目的: 「この層は Cache 実装の性質を隠さない」という ADR 0012 の立場を、
利用者が読む場所で宣言すること。

- a) README の区間読み節の末尾（L333 の直後）に 2 文足す（"stream" は throw / "blob" は
  開いた時点の Blob を読み続ける） ★推奨 — ADR / limitations に既にある文の英訳で、
  重複は増えるが README 単体で誤用を防げる
- b) 1 文に圧縮して「A handle is not a snapshot」だけ書き、詳細は ADR 0012 リンクへ送る
- c) 現状維持 — limitations.md（日本語）を読む下流だけが知る状態が続く

リスク: a) は G4-10（同一事実の 5 重化）を悪化させる。b) が折衷。

対象: README.md:301-339（節全体）/ docs/limitations.md:170-172 / src/core.ts:1575-1580 /
docs/decisions/0012-open-cached-range-read.md:123-126

影響範囲: 文書のみ。

引き継ぎ: 機序 — "stream" は read ごとに `cache.match`（core.ts:1506）し、消えていれば
「開いた後にエントリが消えました」で throw（1508-1513）。"blob" は open 時に取った `Blob`
を閉包で保持する（1663-1672）ので、エントリ削除後も `slice()` が成功する。テストは
mod.test.ts:3448（stream）/ 3467（blob）で両方凍結済み。

### 5. 中断（`signal`）の粒度と「open は中断できない」ことを limitations.md に足しますか [W / 文書の抜け]

概要: `read` の `signal` はチャンク境界でしか見ない（"stream"）／ slice の前に 1 回だけ
見る（"blob"）— これは README:315-318 と ADR §2 にあるが、**limitations.md（by-design 制約の
一覧）には中断の話が 1 行も無い**。さらにどの文書にも書かれていないのが「`openCachedUrl`
自体は `signal` を取らない」ことで、`read: "blob"` を Deno で強制すると open が全量
materialize（ADR 実測 326 ms / RSS +517 MiB）する間、中断する口が無い。\
発生条件: 長い読み飛ばしを持つ read の中断（documented）／ Deno で "blob" を明示した open
（undocumented）。\
守っている目的: limitations.md が「バグではなく設計判断」の単一の索引であること
（CLAUDE.md の Docs 規約）。

- a) limitations.md の区間読み 3 項目に 4 つ目として「中断は read のチャンク境界まで。
  進行中の 1 チャンク読みと open 自体は中断できない」を足す ★推奨 —
  索引としての完全性が戻り、README/ADR との重複は 1 行で済む
- b) `OpenCachedOptions` に `signal` を足す（open の中断を可能にする・追加のみで非破壊） —
  ただし 0.8.0 の scope 拡大になり、"blob" の `blob()` を実際に中断できるかはランタイム依存
- c) 現状維持 — README と ADR には書いてあるので、limitations だけが不完全

リスク: b) は「中断できるように見えて `blob()` が止まらない」半端な口になる危険がある
（`Response.blob()` に中断口が無い）。まず a) で明文化するのが安全。

対象: docs/limitations.md:165-172 / README.md:315-318 / src/core.ts:1478（blob 1 回）/
src/core.ts:1536（stream チャンク境界）/ src/core.ts:1593-1600（open に signal 引数なし）

影響範囲: 文書のみ（a）。b) を採ると公開 API の追加。

引き継ぎ: 機序 — `readFromStream` は `await reader.read()` の**前**に
`signal?.throwIfAborted()` を置く（core.ts:1536）ので、1 チャンクの読み出しが長引く場合は
その完了まで中断が届かない。`readFromBlob` は slice の前に 1 回（1478）。open 側
（`openCachedUrlWithKey`）は signal を受け取らない。

### 6. "stream" 戦略の `body === null` を「0 バイト」と断定してよいか、判断してください [W / 実装と文書の食い違い・needs-human]

概要: `readFromStream` は `cached.body === null` を無条件に「本文 0 バイト」と扱い、
`offset + length > 0` なら「範囲外（本文 0 バイト）」で throw する（core.ts:1515-1519）。\
ところが README:514-517 は「本文をストリームとして渡せないランタイム（`response.body` が
null で全量フォールバックが読む）」の存在を**明示的に前提**しており、`readBody` にはその
ための `arrayBuffer()` フォールバックがある（core.ts:479-499）。この 2 者を突き合わせると、
body-null ランタイムで `read: "stream"` を使った場合、**中身のあるエントリが「本文 0 バイト」
として範囲外エラーになる**（エントリは正常なのにエラー文言が嘘をつく）。\
確認したこと: Deno 2.9.6 では 0 バイトのエントリでも `cache.match` の `body` は非 null
（自作プローブで確認。ユニーク名前空間を使い削除済み）— つまりこの分岐は Deno では
到達せず、到達するのは「Cache 応答が stream を持たないランタイム」だけ。\
守っている目的: fail loud 規約（誤ったバイト列より正しいエラー）と、エラー文言が事実を
述べること。

- a) 文書側で閉じる: ADR §4 と JSDoc に「"stream" は `response.body` を要求する。body を
  持たないランタイムでは "blob" を使うこと」を明記し、コード側は 0 バイト断定をやめて
  「この戦略は使えない」旨の専用 throw にする ★推奨 — 誤った本文長を名乗らないので
  診断可能。既定はブラウザ = "blob" なので実害範囲は明示指定のみ
- b) `readBody` と同じ `arrayBuffer()` フォールバックを `readFromStream` に足す —
  「全量を載せない」という戦略の存在意義を裏切るので、載せるなら "blob" と同じであり、
  黙って全量を読むのは性能特性の偽装になる
- c) 現状維持（= 0 バイト断定）— body-null ランタイムは実在しないという判断を明文化する
  必要がある（現状はコメント「body を持たない応答は 0 バイト」だけが根拠）

リスク: a) はコード変更を伴う（文言 1 本の追加）。c) を採るなら README:514-517 の
body-null 前提との整合を取る文（「Cache 応答の body-null は取得経路だけの話」）が要る。

対象: src/core.ts:1515-1519 / src/core.ts:479-499（readBody の対応する分岐）/
README.md:514-517 / docs/decisions/0012-open-cached-range-read.md:101-106

影響範囲: `read: "stream"` を明示した呼び出しのみ（既定は Deno のみ stream で、Deno は
body 非 null を確認済み）。この分岐は**テストも無い**（mod.test.ts:3483 の body:null 偽物は
"blob" 経路専用）。

引き継ぎ: 何を確かめれば決まるか — ① 対象とする実行環境（README の Runtime support は
ブラウザ / Deno / Node.js）のうち、Cache 応答が body-null になり得るものが実在するか
（README:514-517 はそれを前提に書かれている＝プロジェクトの現在の立場は「実在する」）。
② 実在するなら a)（fail loud な専用エラー）、実在しないなら c)（前提を文書化し、
README:514-517 との棲み分けを 1 文で書く）。テスト仕様 — a) を採るなら
「body:null を返す偽 CacheStorage + `read:"stream"` で read → 『この戦略は body が必要』の
文言で throw」を 1 本。

### 7. ROADMAP G3-05（`HfResolveOptions` の名前付き公開型化）を 0.8.0 に同乗させますか [W / 発火した見送り事項]

概要: 前回レビュー（2026-09-05）の ROADMAP は G3-05 の着手タイミングを
「**次の HF 層 API 変更に同乗**」と定めている。今回の差分は HF 層の公開 API 変更
（`openHfFile` + 名前付きオプション型 `HfOpenOptions` の新設）なので、条件が満たされた。\
現状 `resolveHfRevision` の opts だけが無名インライン型のまま 4 フィールド
（fetch / init / retry / onRetry）を持ち、同じ層で `HfFetchOptions` / `HfPrefetchOptions` /
新設 `HfOpenOptions` が名前付き公開型という**非対称**が残る。下流はラッパの引数型を書けない。\
守っている目的: 公開 API の一貫性と、追加のみ（非破壊）で済むうちに揃えること。

- a) 0.8.0 に同乗（`export type HfResolveOptions = { fetch?; init?; retry?; onRetry? }` を
  切り出し、`resolveHfRevision` のシグネチャをそれに差し替え・`./hf` から再公開） ★推奨 —
  型の抽出だけで構造的互換（既存の呼び出しは無改変）・minor リリースの追加項目として自然・
  ROADMAP の発火条件そのもの
- b) 次の HF 層変更へ再送り（ROADMAP に「0.8.0 では見送り」と追記して発火条件を書き直す）
- c) 現状維持（ROADMAP を触らない）— 発火条件が満たされたまま放置されるので非推奨

リスク: a) は公開型が 1 つ増える（JSR の doc に載る）だけで挙動不変。型名は
`HfResolveOptions` で ROADMAP の指定どおり。

対象: src/hf/mod.ts:160-173（無名 opts）/ src/hf/mod.ts:497-505（新設 `HfOpenOptions`）/
.claude/reviews/2026-09-05_833e5bc/ROADMAP.md:14

影響範囲: `./hf` の公開型が 1 つ増える。既存呼び出し・テストは無改変で通る想定
（構造的部分型のため）。

引き継ぎ: 検証手順 — 型抽出後 `deno task check`（逐次実行。`--parallel` 禁止）で緑を確認。
`deno doc --no-lock` で `./hf` の公開面に `HfResolveOptions` が出ることを確認。

## L（改善提案 / 軽微）

8. **README:316-320 の折り返しが崩れている** — `The `"blob"` strategy has no such skip …` を
   足したときに前後を再折り返ししておらず、L318 が `slice and never during it. A read` で
   途切れる（他段落は 76 桁前後で揃う）。deno fmt は既存改行を維持するので check は緑のまま。
   段落を再折り返しするだけ。対象: README.md:316-320。

9. **CLAUDE.md:12 だけ行幅が突出** — 追記で `fetchBytesWithKey / prefetchUrlWithKey /
   openCachedUrlWithKey は HF 層とテスト専用（公開 `key` は 0.5.0 で撤去 —` の 1 行が他項目
   （〜95 桁）より明らかに長い。折り返し位置を 1 か所直すだけ。対象: CLAUDE.md:11-13。

10. **同じ事実が 5 か所に重複しており、将来のドリフト源になる** — 「`validate` / `decode` /
    `recheck` / `into` を持たない」「記録なしは undefined・evict しない」の 2 事実が
    ADR §3（0012:76-94）・limitations.md:152-160・README:322-333・core.ts:1385-1420・
    hf/mod.ts:510-529 の 5 か所に別文で書かれている。G4-01 の delete 漏れも「4 か所のうち
    3 か所だけ直せば済む」構造から生まれた。提案: limitations.md を単一真実源にし、
    JSDoc / README は 1 文 + リンクへ寄せる（0.8.0 では文言統一だけでも可）。

11. **ADR 0012 §1 のスニペットは型として通らない** — `const entry = await openCachedUrl(...)`
    の直後に `entry.read(...)`（戻り値は `CachedEntry | undefined`）。README:293-297 は
    `if (entry === undefined) throw` を挟んでおり、ADR 側だけガードが無い。md 内スニペットは
    `deno task check` の対象外なので緑のまま。対象: docs/decisions/0012:43-46。

12. **README に「`sha256` を省略すると記録の有無に依らず開ける（無検証の生読み）」が無い** —
    ADR §3 の表 4 行目と `OpenCachedOptions.sha256` の JSDoc（core.ts:1397）にはあり、
    テスト（mod.test.ts:3275-3279）も凍結している。README は常に `sha256` を渡す例しか
    示さないので、任意項目であることが伝わらない。1 文追記で足りる。対象: README.md:322-333。

13. **実測値は検証不能（uncertain 一覧・refuted ではない）** — 117 ms / 300 ms /
    0.2〜0.9 ms / 0.1〜0.3 ms / 326 ms / RSS +517 MiB / 131 ms / 17・51・76 ms /
    「137 回・およそ 42 秒」「253 MB × 9 本」「8,960 + 140 バイト」。README:303-304 と
    ADR:18-19 / 表 34 行目は同条件（Chrome 152、全量 arrayBuffer）で数値が一致しており、
    core.ts:1422-1426 の JSDoc（256MiB / RSS +517MiB・0.1〜0.3ms）も ADR 表と一致する。
    唯一の粗さは ADR 表の Chrome 行に対象サイズ表記が無いこと（Deno 行だけ「256 MiB」）と、
    「およそ 42 秒」が 137 × 300 ms（Linux 行）を指すのか macOS を指すのかが読み取れない
    こと。ADR 表のヘッダに「対象: 253 MB エントリ（Deno 行は 256 MiB）」を 1 行足すと閉じる。

14. **README の HF 節（466-535）から `openHfFile` への相互参照が無い** — `openHfFile` の説明は
    2 節前（README:335-349）にあり、HF 節の「How the cache key is chosen」の直後あたりに
    1 行のポインタがあると辿れる。対象: README.md:493-520。

15. **区間指定の形式検査（負・非整数は throw）が公開文書に無い** — `assertRange`
    （core.ts:1433-1451）は「区間は 0 以上の整数で指定してください」で落とし、テストも
    ある（mod.test.ts:3411-3413）が、README / ADR / limitations / JSDoc（`CachedEntry.read`）
    のいずれも「範囲外」しか触れていない。`CachedEntry.read` の JSDoc に 1 句足すのが最小。
    対象: src/core.ts:1367-1376。

16. **ADR §5「`ref.revision` は解決も参照もされない」は表現がずれている** — 実装は
    `hfResolveUrl({ ...ref, path })`（hf/mod.ts:543）で revision（既定 "main"）を URL に
    埋め込み、その URL はエラー文言だけでなく `onCacheError` の `context.url` にも出る。
    括弧内の補足（「エラー文言のラベルにだけ使う」）と本文が矛盾して読める。
    「キーには入らない（読み出し先は変わらない）／ URL は診断ラベルとしてのみ組み立てる」
    に言い換えるのが正確。対象: docs/decisions/0012:112-114 / src/hf/mod.ts:541-543。

## 横断所見

① **文書 4 者の骨格は健全** — ADR 0012 の Decision（§1〜§5）は 1 項目ずつ実装に着地し、
limitations.md の 3 項目・README の 1 節・JSDoc も同じ事実を述べている。0.7.0 レビューで
指摘された「文書が実装より先に進む」型のドリフトは今回は無く、破れたのは `onCacheError`
の `op` 語彙という**一段細かい層**だけだった（G4-01 / G4-02）。この 2 件に共通するのは
「通知の識別子は公開契約なのに、文書が失敗**点**だけを列挙して識別子を書かない」構造で、
`fetchBytes` 側の文書（core.ts:171-175）も同じ書き方をしている（そちらは 4 op 全てが実際に
使われるので実害が無いだけ）。

② **README の英語は既存節と揃っている** — "cache hit" / "self-heal" / "warm(ing)" /
"stored raw form" / "degrade" の語彙、`> [!NOTE]` を使わない散文体、ADR リンクの絶対 URL
（`https://github.com/hdae/fetch-cache/blob/main/docs/decisions/0012-...`）はいずれも既存に
一致。Features の箇条書きも「太字ラベル: 説明」の形と粒度（2〜4 行）を守り、位置も
「Memory-conscious downloads」と「Caller-owned buffers」という**読み出し RAM 系の隣**で妥当。
日本語の混入も無い（README:416 の既存 1 か所を除く）。

③ **公開文書への開発履歴の漏れは無い** — README / ADR 0012 / limitations に「レビュー」
「前回」「セッション」等の内部事情語は 0 件（限定的な既存 1 件は limitations:94 の
「前回の内容」で、これはリカバリ挙動の説明であって履歴ではない）。

④ **known-issues.md は追記不要と判定** — 候補は 3 つあったが、いずれも by-design で
limitations.md 側が正しい置き場: (i)「"blob" ハンドルが evict 後も生きる」= ADR
Consequences で「Cache 実装の性質をこの層は隠さない」と明示的に選択済み（limitations:170-172）、
(ii)「pending read 中の abort が届かない」= 中断粒度の設計（ADR §2）で、未記載なのは
limitations の索引だけ（G4-05 で対処）、(iii)「読み飛ばしコストが offset に比例」=
ランタイム特性として limitations:165-169 に記載済み。**唯一 known-issues 行きになりうるのは
G4-06**（body-null ランタイムでの誤った範囲外エラー）だが、実在性の判断（needs-human）が
先で、a) を採るなら fail loud な throw に変わるので known-issues ではなく limitations 行きに
なる。

⑤ **新規ヘルパの引数形状は ROADMAP G2-05 と同じ轍** — `readFromBlob`（5 引数）/
`readFromStream`（6 引数）はいずれも位置引数で、`requestUrl` が末尾という `readBody`
（7 引数・G2-05 で options 化が見送られた）と同じ構造。今回は範囲内の判断だが、次に引数が
増えるときは G2-05 と一緒に options 化するのが自然（コード側グループと重複しうるので
ここでは提案のみ）。
