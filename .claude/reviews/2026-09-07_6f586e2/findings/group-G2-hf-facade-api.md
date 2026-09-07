---
id: G2
topic: HF 層・公開ファサード・API 表面（openHfFile / mod.ts の export / CLAUDE.md Layout）
files_reviewed:
  - src/hf/mod.ts
  - src/mod.ts
  - CLAUDE.md
  - src/hf/mod.test.ts
date: 2026-09-07
model: opus (effort high)
---

# G2 — HF 層・公開ファサード・API 表面

## サマリ

`openCachedUrl` / `openHfFile`（コミット 6f586e2、v0.7.0 → HEAD）の API 表面をレビューした。\
結論として **breaking は無く、キーの同一性・型の転送・JSR の slow types はいずれも問題なし**。\
指摘は文書ドリフトとテスト凍結の抜けに集中しており、実装のバグ（E / C）は 1 件も無い。

実挙動で確認できた事実（使い捨てスクリプトを名前空間 `probe-g2` で実行・実行後に削除）:

| 確認項目                                                     | 結果                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| `prefetchHfFile` で温めた内容キーを `openHfFile` が開けるか   | 開ける（`fetchHfFile` で温めた場合も同じ）                      |
| `ref.revision` 違い（未指定 / `refs/pr/1` / 40 桁 SHA）       | すべて同じエントリが開く（内容キーは revision 非依存）          |
| `ref.hubUrl` 違い（ミラー）                                   | 同じエントリが開く（内容キーは hubUrl 非依存）                  |
| `ref.kind` 違い（`dataset`）                                  | `undefined`（kind はキー要素なので設計どおり別エントリ）        |
| `expectedBytes: -1` / `1.5` / `into` 容量超過                 | `fetchHfFile` と同じ文言で throw（JSDoc の記述どおり）          |
| `read` の範囲外エラーに出る URL                               | `https://huggingface.co/o/n/resolve/**main**/s.bin`（未解決）   |
| `onCacheError` の `context.url`                               | `.../resolve/**dev**/s.bin`（ユーザが名乗った未解決 revision）  |

件数: **W 6 件 / L 7 件**（E・C は 0 件）。改善提案は L として区別した。

## ファイル別 5 段階分類

| ファイル                                 | 分類  | 根拠                                                                                                                            |
| ---------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/hf/mod.ts`（openHfFile / HfOpenOptions ほか） | **W** | 実装は正しく breaking も無いが、内部導管を列挙するコメントが更新漏れ（G2-01）・通知 op の列挙が不完全（G2-04）・ラベル URL が未解決 revision 入り（G2-05）。分岐そのものはテスト不在（G2-02 / G2-03） |
| `src/mod.ts`（export 追加 + module doc）  | **S** | 純粋な再エクスポート 3 件（`openCachedUrl` / `CachedEntry` / `OpenCachedOptions`）と module doc の追記のみ。状態も分岐も無く、`deno doc` の公開シグネチャも期待どおり |
| `CLAUDE.md`（Layout 更新）                | **L** | 公開ファサード・内部導管・HF 層の列挙は実装と完全一致（照合済み）。行幅だけ周囲から突出（G2-09）                                 |
| `src/hf/mod.test.ts`（openHfFile 4 本）   | **W** | network 非到達を `--allow-net` 不在で担保する設計は良い。ただし `onCacheError` 転送と `toSpec` の 2 分岐が未凍結（G2-02 / G2-03） |

参考（本グループの担当外・G1 の担当）: `src/core.ts`、`README.md`、`docs/limitations.md`、
`docs/decisions/0012`。G2-04 / G2-08 は core 側にも同じ根を持つため、対象行を併記した。

## 重要経路の ASCII 図（行番号は現行 HEAD）

書き込み 2 経路と読み出し 1 経路が **同じ `contentKey` 関数・同じ引数**でキーを作っていることが
この機能の要。3 経路とも `toSpec`（hf/mod.ts:324）を通ってから `contentKey`（hf/mod.ts:276）へ入る。

```
                     hf/mod.ts:324  toSpec(file)            ← 形式検査（sha256 / expectedBytes / into）
                              |
        +---------------------+---------------------+
        |                     |                     |
 fetchHfFile:364       prefetchHfFile:440      openHfFile:535
        |                     |                     |
 fetchResolvedFile:288        |                     |  536: sha256 未宣言なら throw
   url = hfResolveUrl         |  447: url = hfResolveUrl   543: url = hfResolveUrl
        ({...ref, revision,   |        ({...ref, revision, |        ({...ref, path})
          path})             |          path})            |    ↑ revision を解決しない
        |  ↑ 解決済み SHA     |    ↑ 解決済み SHA          |      → 既定 "main" のまま
        |                     |                     |            （エラー文言のラベル専用）
        v                     v                     v
  contentKey(ref, spec)  contentKey(ref, spec)  contentKey(ref, spec)   ← hf/mod.ts:276
   = ["hf", kind, repo, path, sha256]（revision も hubUrl も含まない）
        |                     |                     |
        v                     v                     v
 fetchBytesWithKey:290  prefetchUrlWithKey:449  openCachedUrlWithKey:544
        |                     |                     |
        +---------------------+---------------------+
                              v
                 core.ts:1599  storageKey = serializeKey(key)   ← 3 経路で同一文字列
                 core.ts:1633  cache.match(storageKey)
                 core.ts:1640  recorded = headers[x-fetch-cache-sha256]
                               ├ 一致            → 1658 で戦略選択 → CachedEntry
                               ├ 不一致（記録有）→ 1649 cache.delete（self-heal）→ undefined
                               └ 記録なし        → undefined（evict しない）

注: core.ts:1598 requestUrl は「エラー文言と onCacheError の表示用」だけに使われ、
    実際の読み出し先は 1599 の storageKey（= 内容キー）。openHfFile 経路ではこの 2 つが
    別物であることが G2-05 の論点。
```

---

## 指摘の詳細

### 1. 内部導管を列挙するコメントに `openCachedUrlWithKey` を足すか？ [W/文書ドリフト]

概要: `src/hf/mod.ts:20-21` のコメントは「配列キーの注入導管（fetchBytesWithKey /
prefetchUrlWithKey）は内部モジュールにだけある」と 2 本だけを列挙している。\
今回 3 本目の `openCachedUrlWithKey` を同ファイルの import（hf/mod.ts:30）へ追加し、`CLAUDE.md:12`
の Layout も 3 本に更新したのに、**同じファイルのこのコメントだけが 2 本のまま**残った。\
このコメントは「なぜ HF 層が `*WithKey` を呼ぶのか（公開 `key` は 0.5.0 で撤去された）」を説明する
唯一の在処で、次に導管が増えたとき同じ更新漏れが再発する。

- a) コメントの括弧内を `fetchBytesWithKey / prefetchUrlWithKey / openCachedUrlWithKey` の 3 本へ
  そろえる ★推奨 — CLAUDE.md と import はすでに 3 本なので、この 1 行で 3 か所が一致する。差分 1 行・
  リスクゼロ。
- b) 括弧内の列挙をやめ「配列キーの注入導管（`*WithKey`）は内部モジュールにだけある」と数を持たない
  表現にする — 将来の追加で腐らないが、どれが導管かを別途 grep する必要が出る。
- c) 現状維持 — CLAUDE.md が真実源だから、という整理も成り立つ。

リスク: なし（コメントのみ）。

対象: `src/hf/mod.ts:20-21`（比較対象: `src/hf/mod.ts:30`、`CLAUDE.md:11-13`）

影響範囲: コメントのみ。動作・公開 API に影響なし。

引き継ぎ: `src/hf/mod.ts` の 20 行目 `// 配列キーの注入導管（fetchBytesWithKey /
prefetchUrlWithKey）は内部モジュールにだけある` の括弧内に `/ openCachedUrlWithKey` を足す。\
検証は `rg -n 'openCachedUrlWithKey' src/hf/mod.ts CLAUDE.md` が import・コメント・Layout の 3 か所
（hf/mod.ts で 2 件、CLAUDE.md で 1 件）を返すこと。

---

### 2. 「読み出しに使わない `expectedBytes` / `into` でも `toSpec` が throw する」をテストで凍結するか？ [W/テスト不在]

概要: `openHfFile` の JSDoc（hf/mod.ts:521-526）は「`expectedBytes` / `validate` / `decode` /
`into` は読み出しには使わない。**ただし `toSpec` の形式検査は `fetchHfFile` と共通で走る**ので、
負・非整数の `expectedBytes` や `into` に収まらない `expectedBytes` は、読み出しに使われないまま
同じ文言で throw する」と、利用者から見て驚きのある挙動を明示的に契約として書いている。\
実挙動もそのとおり（probe で確認済み: `expectedBytes: -1` → `fetch-cache: expectedBytes は 0 以上の
整数で指定してください: -1 (s.bin)`、`into: Uint8Array(8)` + `expectedBytes: 99` →
`fetch-cache: into の容量 8 バイトに収まりません（expectedBytes 99 バイト） (s.bin)`）。\
しかし `src/hf/mod.test.ts` の openHfFile 4 本が凍結しているのは `sha256` 未宣言 throw と
`sha256` 形式不正 throw の 2 分岐だけで、**`expectedBytes` と `into` の 2 分岐は未凍結**。\
守っている目的は「申告の食い違いはどの入口から入っても同じ扱い」という入口間の一貫性で、
将来 `openHfFile` から `toSpec` 呼び出しを外して sha256 検査だけをインライン化しても、いまのテストは
全部緑のまま通る（sha256 分岐は残るため）。

なお本プロジェクトの分類規約「分岐 / 失敗パス / 境界を含む未テスト → E」を厳格に読むと E だが、
同じ `toSpec` 呼び出しの sha256 分岐は openHfFile 経由で凍結済みで、コード自体は正しい（凍結の穴
だけ）ため W に留めた。昇格するかはオーケストレータの判断に委ねる。

- a) `src/hf/mod.test.ts` の既存テスト「openHfFile: sha256 の無い spec は throw する」へ 2 件の
  `assertRejects` を足す ★推奨 — 既存テストが `toSpec` 由来の throw を集めた場所で、追加は 2 ブロック・
  キャッシュ操作も不要（形式検査は cache に触る前に落ちる）。テスト名は「toSpec の検査は openHfFile
  でも走る」の意味を含む形へ寄せる。
- b) 独立した 1 本を新設し、名前で「読み出しに使わない項目でも入口検査は走る」を表明する — 意図は
  読み取りやすいが、`caches.delete` の finally を持つブロックがもう 1 つ増える。
- c) 現状維持 — JSDoc と ADR 0012 §3 の記述に委ねる。

リスク: なし（テスト追加のみ。実装は変更しない）。

対象: `src/hf/mod.ts:521-526`（契約）/ `src/hf/mod.ts:535`（`toSpec` 呼び出し）/
`src/hf/mod.test.ts:1438-1459`（凍結が足りていないテスト）

影響範囲: テストのみ。

引き継ぎ: 機序 — `openHfFile` は 535 行目で `toSpec(file)` を最初に呼び、`toSpec`（hf/mod.ts:324-352）
の 3 つのガード（sha256 hex / expectedBytes 安全整数・非負 / into 容量）が読み出し前に全部走る。\
テスト仕様 — `openHfFile({ repo: REPO }, { path: "a.bin", sha256: BYTES_SHA256, expectedBytes: -1 })`
が `assertRejects(..., Error, "0 以上の整数")`、`{ ..., expectedBytes: 99, into: new Uint8Array(8) }`
が `assertRejects(..., Error, "into の容量")` で落ちること。\
検証手順 — テストは固定名前空間 "fetch-cache" を共有するため逐次実行が前提（`deno task check`）。
追加前に一度 `into` の分岐が本当に openHfFile から届くことを確認するなら、対象の 2 行の
`throw` へ一時的に印を入れて落ちることを見るのが早い（コミットには残さない）。

---

### 3. `HfOpenOptions.onCacheError` の透過をテストで凍結するか？ [W/テスト不在]

概要: `HfOpenOptions` が cache 層へ転送する項目は `read` / `onCacheError` / `caches` の 3 つ
（hf/mod.ts:544-549）。`src/hf/mod.test.ts:1461-1497` の透過テストは `read`（`strategy` が
"blob" になることで証明）と `caches`（spy の `open` が呼ばれることで証明）の 2 つを凍結しているが、
**`onCacheError` だけ凍結が無い**。\
`onCacheError` の行（hf/mod.ts:547）を落とすと、cache I/O 失敗の通知が呼び出し側へ届かず既定の
`console.warn`（core.ts:353 `defaultOnOpenCacheError`）へ落ちるだけになる — 縮退先が `undefined`
である以上、呼び出し側は「温まっていない」と「cache が壊れている」を区別できなくなるが、テストは
全部緑のまま通る。ADR 0001 の「縮退 + 通知」の通知側が静かに外れる形。

- a) 既存の透過テストへ、故障注入した `CacheStorage`（`open` が reject）と `onCacheError` スパイを
  足して 3 項目そろえる ★推奨 — 同じテスト内で spy 用 `CacheStorage` を組む型は既にあり、
  `open: () => Promise.reject(new Error("boom"))` に差し替えるだけで足りる。`context.op === "open"`
  と戻り値 `undefined` を同時に凍結できる。
- b) cache 層側（`mod.test.ts:3352` の `openCachedUrl: caches.open 失敗は …`）で足りているとみなし、
  HF 層は転送 3 項目のうち 2 つの凍結でよしとする — 転送漏れそのものは検出できない。
- c) 現状維持。

リスク: なし（テスト追加のみ）。

対象: `src/hf/mod.ts:547`（転送）/ `src/hf/mod.test.ts:1461-1497`（凍結が 2/3）

影響範囲: テストのみ。

引き継ぎ: 機序 — `openCachedUrlWithKey`（core.ts:1593）は `opts.onCacheError ??
defaultOnOpenCacheError` を使い、`cacheStorage.open` の失敗（core.ts:1628）・`cache.match` の失敗
（core.ts:1635）・self-heal の `cache.delete` の失敗（core.ts:1649）・`cached.blob()` の失敗
（core.ts:1665）で呼ぶ。\
テスト仕様 — `open` が必ず reject する `CacheStorage` を渡し、`openHfFile(..., { caches: broken,
onCacheError: spy })` が `undefined` を返し、`spy` が `{ op: "open" }` で 1 回だけ呼ばれること。\
検証手順 — 逐次実行（`deno task check`）。故障注入する `CacheStorage` は `globalThis.caches` に
触らない実装にすること（名前空間の後始末が不要になる）。

---

### 4. `onCacheError` の通知 op に `delete` を書き足すか？ [W/文書ドリフト]

概要: `HfOpenOptions.onCacheError` の JSDoc（hf/mod.ts:504）は「cache I/O 失敗（**open / match**）の
通知」と 2 つだけを列挙し、cache 層の `OpenCachedOptions.onCacheError`（core.ts:1413-1417）と
ADR 0012 §4 も同じく open / match（+ blob）しか挙げていない。\
実装は open 経路から **`op: "delete"` でも通知する** — 記録ハッシュが期待と食い違ったときの self-heal
（core.ts:1641-1650）で `cache.delete` が失敗した場合。`CacheErrorContext["op"]`（core.ts:30）は
`"open" | "match" | "put" | "delete"` なので型としては到達可能な値。\
守っている目的は「縮退したことを必ず知らせる」（ADR 0001）で、通知を分岐して扱う呼び出し側
（例: `op` で warn / error を出し分ける実装）が `delete` を想定外として落としうる。\
ついでに、`cached.blob()` の失敗が `op: "match"` として報告される点（core.ts:1663-1666）も、`op` の語彙
としては blob 化と match の区別が付かない — 診断上は「open した後の materialize 失敗」と
「match そのものの失敗」を区別できたほうがよい（こちらは core 側の判断・G1 の担当）。

- a) hf / core 両方の JSDoc を「open / match / delete（self-heal）」へそろえ、ADR 0012 §4 にも
  self-heal の delete 失敗が通知されることを 1 文足す ★推奨 — 文書だけの変更で、`op` の型を
  読んだ利用者との食い違いが消える。実装は触らない。
- b) a) に加えて `cached.blob()` の失敗に専用の `op` を足す — `CacheErrorContext["op"]` の union へ
  値を追加するのは**公開型の拡張**なので、既存の網羅 switch を書いた下流を壊しうる（v0.1.0 以降は
  breaking 不可）。0.8.0 では見送るべき。
- c) 現状維持 — self-heal の delete 失敗は稀（match が通った直後の delete）という整理。

リスク: a) はなし。b) は公開 union の拡張で breaking になりうるため非推奨。

対象: `src/hf/mod.ts:504` / `src/core.ts:1413-1417`（core は G1 担当）/
`docs/decisions/0012-open-cached-range-read.md:97-99` / 実装は `src/core.ts:1641-1650`

影響範囲: JSDoc と ADR のみ。

引き継ぎ: 機序 — `openCachedUrlWithKey` は記録ハッシュが期待と不一致かつ記録が存在する場合だけ
`cache.delete(storageKey)` を試み（core.ts:1641-1650）、その失敗を `onCacheError({ op: "delete" })`
で通知して `undefined` を返す（削除できなくても縮退先は同じ）。\
検証手順 — 文書変更なので、`rg -n 'op: "delete"' src/core.ts` が open 経路の 1 か所を返すことと、
`CacheErrorContext` の union（core.ts:30）に `delete` があることの 2 点で機械的に裏が取れる。

---

### 5. `openHfFile` のエラー・警告に出す URL ラベルを、未解決 revision 入りのままにするか？ [W/診断]

概要: `openHfFile` は revision を解決しない（それが ADR 0012 §5 の中核）。そのため
`hfResolveUrl({ ...ref, path: spec.path })`（hf/mod.ts:543）が作る URL は **`ref.revision` 未指定なら
必ず `.../resolve/main/<path>`**、指定していればユーザが名乗った文字列がそのまま入る。\
この URL は cache 層へ `requestUrl` として渡り（core.ts:1598）、**エラー文言と `onCacheError` の
`context.url` に出る唯一の識別子**になる。実測（probe）:

- 範囲外: `fetch-cache: 区間 [0, 99) はエントリの範囲外です（本文 8 バイト）
  (https://huggingface.co/o/n/resolve/main/s.bin)` — 実際に取得された URL は
  `.../resolve/aaaa…（解決済み SHA）/s.bin` で、この URL では取得していない。
- 通知: `revision: "dev"` を名乗って開くと `context.url` は `.../resolve/dev/s.bin` になる。
  格納された中身は `dev` と何の関係もない（キーは内容キー）。

期待していた状態は「エラーに出る URL を辿れば対象を特定できる」で、破れ方は 2 つ:
① その URL では取得していない（可変 ref なら upstream が動いた後は**別内容**を指しうる）、
② その URL は保存キーでもないので `evictUrl(その URL)` は静かに何もしない（内容キーの掃除は
`evict(["hf", kind, repo, path, sha256])`）。`path` は入っているので「どのファイルか」は分かるが、
revision 部分だけが実態を伴わない主張になっている。ADR 0012 §5 は「エラー文言のラベルにだけ使う」と
明記しており**意図どおり**だが、その意図がエラー文言そのものからは読めない。

- a) `openHfFile` が渡す URL から revision の主張を消す — 例えば `hfResolveUrl` を使わず
  `${hubBase(ref.hubUrl)}/${RESOLVE_PREFIX[kind]}${ref.repo}/${encodePath(spec.path)}` のような
  「resolve セグメントを持たない識別ラベル」にする ★推奨 — 誤誘導の根（存在しない resolve URL を
  名乗ること）が消え、`path` による識別は保たれる。ADR 0012 §5 の「ラベルにだけ使う」という決定を
  変えず、ラベルの中身だけを実態に合わせる。ADR に 1 文追記が要る。
- b) URL はそのままにして、`openHfFile` の JSDoc と `docs/limitations.md` の HF 節に「エラーに出る
  URL は表示用のラベルで、取得元でも保存キーでもない（revision は未解決）」を明記する — 変更が
  文書だけで済み、ADR の決定にも触れない。ただし警告ログだけを見た人には届かない。
- c) 現状維持 — ADR 0012 §5 が既にそう決めており、`fetchHfFile` でも URL とキーは別物（内容キー）と
  いう非対称は元からある、という整理。

リスク: a) はエラー文言の**書式変更**。既存テストは openHfFile のエラー内 URL を照合していないので
赤にはならないが、下流がログを grep している可能性はゼロではない（公開 API の型・関数名は不変なので
breaking ではない）。b) / c) はリスクなし。

対象: `src/hf/mod.ts:541-543`（ラベル生成と根拠コメント）/ 表示先は `src/core.ts:1598`,
`1433-1450`（区間の不正）, `1453-1468`（範囲外）, `1628 / 1635 / 1649 / 1665`（通知）/
決定は `docs/decisions/0012-open-cached-range-read.md:112-114`

影響範囲: `openHfFile` 経由のエラー文言と `onCacheError` の `context.url` のみ。`openCachedUrl` を
直接使う経路は URL がそのままキーなので影響なし。

引き継ぎ: 機序 — 543 行目の `hfResolveUrl({ ...ref, path: spec.path })` は `ref.revision ?? "main"` を
埋める（hf/mod.ts:158）。cache 層はこの文字列を表示専用に持ち回り、読み出し先は 544 行目の
`contentKey(ref, spec)` を直列化した内容キー（core.ts:1599）。両者が一致しないのはこの経路だけ。\
テスト仕様（a) を採る場合）— `openHfFile({ repo, revision: "dev" }, spec)` で開いたハンドルの
範囲外 read が投げる文言に `"/resolve/"` が含まれないこと、かつ `spec.path` は含まれること。
b) を採る場合はテスト不要（文書のみ）。\
検証手順 — 逐次実行（`deno task check`）。挙動確認は使い捨てスクリプトで足りる（本レビューでも
`caches` を DI して固定名前空間を避ける方法で確認した）。

---

### 6. ROADMAP G3-05（`HfResolveOptions` の名前付き公開型化）を 0.8.0 に同乗させるか？ [W/API 表面]

概要: 前回レビュー（2026-09-05、`.claude/reviews/2026-09-05_833e5bc/ROADMAP.md`）の G3-05 は
「`resolveHfRevision` の opts を名前付き公開型 `HfResolveOptions` にする（追加のみ・下流がラッパを
書けるように）」で、着手タイミングは **「次の HF 層 API 変更に同乗」**。\
今回の差分は HF 層に公開関数 1 本（`openHfFile`）と公開型 1 本（`HfOpenOptions`）を足しており、
この発火条件を満たしている。しかし G3-05 は未着手のまま。\
結果として `./hf` の options 型は **`HfFetchOptions` / `HfPrefetchOptions` / `HfOpenOptions` の 3 本が
名前付き公開型で、`resolveHfRevision` の第 2 引数だけが無名インライン型**（hf/mod.ts:173-180）という
非対称が、今回 1 本増えたぶんだけ目立つ形で残った。無名のままだと下流が
`Parameters<typeof resolveHfRevision>[1]` のような書き方でしか型を掴めない。

- a) 0.8.0 に同乗させる ★推奨 — 追加のみ（`export type HfResolveOptions = { fetch?; init?; retry?;
  onRetry? }` を定義し、`resolveHfRevision` のシグネチャをその型へ置き換え、`export type {}` へ足す）。
  実引数の形は 1 バイトも変わらないので既存呼び出しは無影響、テストの追加も不要。ROADMAP が名指しした
  条件がまさに今回で、次の機会がいつ来るか読めない。
- b) 0.8.0 は「区間読みの追加のみ」に絞り、G3-05 は ROADMAP へ継続 — リリース単位の意味が
  きれいに保てる。ただし発火条件を満たしたまま持ち越すことになる。
- c) 現状維持（ROADMAP から落とす） — 下流からラッパの要望が出ていない、という整理も可能。

リスク: a) は追加のみで breaking なし。ただし公開型が 1 本増えるので、`deno doc --lint` の
`missing-jsdoc` を増やさないよう型に JSDoc を付けること（G2-08 参照）。

対象: `src/hf/mod.ts:171-181`（`resolveHfRevision` の無名 opts）/ 対比は `src/hf/mod.ts:214`
（`HfFetchOptions`）, `375`（`HfPrefetchOptions`）, `498`（`HfOpenOptions`）/
出典 `.claude/reviews/2026-09-05_833e5bc/ROADMAP.md:14`

影響範囲: `./hf` の公開型が 1 本増える。実装・実行時挙動は不変。

引き継ぎ: 機序 — 現在の `opts` は `{ fetch?: typeof globalThis.fetch; init?: RequestInit;
retry?: RetryPolicy | false; onRetry?: (context: RetryContext) => void }` のインライン型
（hf/mod.ts:173-180）。既存 3 本の options 型と同じく型宣言を `resolveHfRevision` の直前へ置き、
各プロパティの JSDoc（現状のコメント 2 本）をそのまま移す。`export type {}` ブロックではなく
`export type HfResolveOptions = {...}` の形が既存 3 本と同じ流儀。\
検証手順 — `deno check .` が通ること、`deno doc --no-lock src/hf/mod.ts` に `HfResolveOptions` が
出ること、`deno doc --no-lock --lint src/mod.ts src/hf/mod.ts` の `missing-jsdoc` 件数が 7 件から
増えていないこと。

---

## L（改善提案・確認事項）

- **G2-07 [L] 型の転送は漏れなし（確認済み）**: `HfOpenOptions`（`src/hf/mod.ts:498-508`）は
  `OpenCachedOptions`（`src/core.ts:1385-1420`）の `sha256` を除く 3 項目（`read` / `onCacheError` /
  `caches`）を過不足なく転送している（`src/hf/mod.ts:544-549`）。`sha256` は `spec.sha256` から入る
  設計どおり。`init` / `fetch` / `retry` / `onRetry` を持たないのも「network に出ない」契約と整合。
  JSDoc の書式だけ兄弟型とわずかに非対称で、`onCacheError` の説明に既存 2 本が付けている
  「（cache 層へそのまま渡す）」が無く、既定フックの文言が取得系（`network へ縮退します`）と違う
  （`エントリ無しとして扱います`）ことも書かれていない。一文足すと親切。
- **G2-08 [L] `OpenCachedOptions` に型レベル JSDoc が無い**: `deno doc --no-lock --lint src/mod.ts
  src/hf/mod.ts` の `missing-jsdoc` が 6 件（`FetchBytesOptions` `src/core.ts:66` /
  `PrefetchUrlOptions` `src/core.ts:1081` / hf の 4 型 `src/hf/mod.ts:53 / 55 / 66 / 214`）から **7 件**へ増えた
  （追加分は `OpenCachedOptions` `src/core.ts:1385`）。既存 2 本と同じパターンなので新規の逸脱では
  ないが、`HfOpenOptions` 側には型 JSDoc がある非対称。**slow types の指摘は 0 件**で、公開 API の
  戻り型はすべて明示されており JSR 公開の制約は満たしている（`openCachedUrl` / `openHfFile` とも
  `Promise<CachedEntry | undefined>` を明示）。
- **G2-09 [L] `CLAUDE.md:12` の行幅**: 約 114 桁で、周囲の Layout 行（約 90 桁以下）から突出している。
  `deno.json` の `fmt.proseWrap: "preserve"` により `deno fmt --check` は通るため赤にはならない。
  `openCachedUrlWithKey` を足した際に折り返しを直さなかったもの。`（公開 `key` は 0.5.0 で撤去 —` から
  次行へ送ると周囲と揃う。
- **G2-10 [L] sha256 未宣言エラーが 1 行 239 バイト（表示幅およそ 150 桁）**: `src/hf/mod.ts:538` のテンプレートリテラルは
  ライブラリ中で最長のエラー文言。内容（なぜ throw するか）は fail loud の観点で妥当だが、
  ソース行としては fmt が折れない 1 行になっている。文言を変えずに改行を入れる（テンプレートリテラル
  内の改行はメッセージに入るので不可 → 連結にする）か、現状維持かの選択。優先度は低い。
- **G2-11 [L] ROADMAP G3-07 のズレが 1 段深まった**: G3-07 は「『prefetch は `into` を使わない』の
  3 か所（JSDoc / README / limitations）に『容量検査だけは全入口で共通に走る』を添える」。今回
  `openHfFile` の JSDoc（`src/hf/mod.ts:521-526`）だけがその注記を持つ形になり、`prefetchHfFile` の
  JSDoc（`src/hf/mod.ts:424-425`）は「`spec.validate` と `spec.into`（呼び出し側バッファ）は渡しても
  prefetch では使われない」のままで、共通の容量検査に触れていない。同じ `toSpec` を通る 3 入口の
  記述がそろっていない状態。G3-07 を 0.8.0 で消化すると 3 か所が一致する。
- **G2-12 [L] ROADMAP G3-06 の入口が 1 つ増えた**: 「`expectedBytes` の拒否文言『0 以上の整数』を
  判定条件（安全整数）に揃える」は未着手のまま、`openHfFile` が同じ文言を出す 3 つ目の入口になった
  （probe 実測: `fetch-cache: expectedBytes は 0 以上の整数で指定してください: 1.5 (s.bin)` — 1.5 は
  「0 以上」を満たすのに拒否される）。文言修正の影響範囲が 1 入口ぶん広がっただけで、新たな欠陥では
  ない。
- **G2-13 [L] `CachedEntry` に対象の識別情報が無い**: `prefetchHfFile` は `HfPrefetchResult`
  （`src/hf/mod.ts:393-400`）で `revision` / `url` を返して「何を温めたか」を呼び出し側へ渡すのに、
  `openHfFile` の戻り値は `{ read, strategy }` だけで「何を開いたか」を持たない。複数 shard の
  ハンドルを配列で持つ利用側は、失敗時にエラー文中の URL を読むしかない（G2-05 と同じ根）。
  公開型への項目追加は breaking ではないので将来の余地はあるが、いま必要という証拠は無い —
  実利用フィードバック待ちとして ROADMAP 送りが妥当。

## 横断所見

1. **キーの同一性は完全に担保されている（チェック観点 1）**。`fetchHfFile` / `prefetchHfFile` /
   `openHfFile` の 3 経路が同じ `contentKey(ref, spec)`（`src/hf/mod.ts:276-279`）を同じ引数で呼び、
   `openHfFile` だけが `contentKey` の第 1 引数に**解決前の `ref`** を渡すが、`contentKey` は
   `revision` を参照しないため結果は完全に同一。probe で revision 3 通り・hubUrl 2 通りすべてが同じ
   エントリを開くことを実測した。`kind` が違うと開けないのはキー定義どおり（設計意図）。
2. **breaking は無い（チェック観点 5）**。`git diff v0.7.0..HEAD -- 'src/*.ts' 'src/hf/*.ts'
   ':!*.test.ts'` の削除行は **0 行**（追加 406 行のみ）。既存の公開関数・型・エラー文言のプレフィックス
   （`fetch-cache: `）はいずれも無変更で、`deno doc` の既存シグネチャも一致。0.8.0 を minor（追加のみ）
   として出す前提は成り立つ。
3. **エラー語彙は既存と揃っている（チェック観点 7）**。新規文言はすべて `fetch-cache: ` プレフィックス
   付きで、`sha256` の形式検査は既存とまったく同じ文（`64 桁の小文字 hex で指定してください`）を
   `toSpec` の共有で再利用している。`openHfFile` 固有の文言（`sha256 の宣言が必要です`）だけが新語で、
   末尾の `(${spec.path})` は HF 層の既存 3 文言と同じ体裁。
4. **`CLAUDE.md` の Layout は実装と完全一致（チェック観点 8）**。`src/mod.ts` の値エクスポート 9 本 +
   `VERSION`、`src/hf/mod.ts` の値エクスポート 7 本、`src/core.ts` の内部導管 3 本を 1 件ずつ照合した
   結果、列挙漏れも余剰も無い。残るのは行幅（G2-09）だけ。
5. **今回の指摘は「実装は正しいが、契約の在処が JSDoc 1 か所に偏っている」に収束する**。
   G2-02（toSpec の共通検査）・G2-04（通知 op）・G2-05（ラベル URL）はいずれも、JSDoc には書いてある
   か、ADR には書いてあるか、どちらにも書いていないかがばらついている。0.8.0 を出す前に
   「JSDoc / ADR 0012 / limitations.md / README の 4 面で、この API の驚きポイント（形式検査は走る・
   通知 op は 3 種・URL はラベル）が同じ粒度で書かれているか」を 1 回そろえるのが、いちばん費用対効果が
   高い。
6. **テストの設計は良い**。`src/hf/mod.test.ts:1415-1416` の「`openHfFile` は fetch の差し替え口を
   持たない — もし network に出れば `--allow-net` の無いこのテストは権限エラーで落ちる」という論法は、
   `deno.json:14` の `deno test --allow-read`（`--allow-net` 無し）と照合して**正しい**。ADR 0012 §1 の
   「network には出ない」という中核契約を、モック呼び出し数の照合ではなくランタイム権限で担保している
   のは強い凍結。この論法が成立し続けるかはテストタスクの権限フラグ次第なので、`deno.json` の
   `check` タスクに `--allow-net` を足す変更が将来入るときはこのコメントを見直す必要がある。

## needs-human

- **G2-05 の a) を採るか**: 「エラー文言の URL ラベルをどう見せるか」は、下流（yomi / sbv2-web）が
  ログをどう読んでいるかで最適解が変わる。確かめるべきは 1 点 — 下流が `fetch-cache:` の警告・エラーを
  文字列マッチで拾っている箇所があるか。無ければ a)、あれば b)（文書のみ）が安全。
- **G2-06 の可否**: G3-05 の同乗はオーナーのリリース方針（0.8.0 のスコープを「区間読みのみ」に
  絞るか）次第。技術的には追加のみで無リスク。
