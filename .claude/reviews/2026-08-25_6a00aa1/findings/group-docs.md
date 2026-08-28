# group-docs — ADR・文書整合レビュー（v0.4.0..HEAD / 6a00aa1）

対象: `docs/decisions/0006-cache-key-separation.md` を軸に、ADR 0002 / 0004 / 0005・
`docs/limitations.md`・`README.md`・JSDoc（`src/mod.ts` / `src/hf/mod.ts`）の整合。

## 総括

ADR 0006 が宣言した挙動は**実装と全て一致**しており、実装にあって ADR に無い挙動も見つから
なかった（DC-7）。指摘は全て文書側の整合・網羅の問題で、リリースブロッカーではないが
4 件は 0.5.0 と同時に直す価値がある。

---

## 🟡W DC-1 — ADR 0002 / 0004 に前方ポインタが無く、単独で読むと旧前提のまま

**概要**: 0006 は 0002 の「キャッシュキーは URL のみ（ヘッダ非依存）」
（`docs/decisions/0002-request-init-passthrough.md:17`）と 0004 の「合流キーは
`(cacheName, URL)`」（`docs/decisions/0004-single-flight-raw-sharing.md:16`）を
**条件付き（`cacheKey` 未指定時のみ）に降格**させたが、0002 / 0004 側に注記が一切ない。
0006 のヘッダも「関連: 0002（キャッシュキーは URL のみ）/ 0004（合流キー）」
（`0006:5-7`）と書くだけで、**部分的に上書きしたことを宣言していない**。

**実害・発生条件**: ADR は「なぜそう決めたか」を単体で引くための文書であり、
`docs/limitations.md:10` や JSDoc は更新済みなのに ADR 本文だけが旧記述で残る。今後
`DECIDED: docs/decisions/0002` を辿った実装者・レビュアが「キーは URL のみ」を不変条件と
誤読し、`cacheKey` を考慮しない変更を入れる余地が残る（MADR 運用上は superseded 系の
リンクを双方向に張るのが定石）。

**修正案**:
- `0002` の該当バレット直後と `0004` の決定 1 直後に 1 行:
  `NOTE: 0.5.0 で [0006](0006-cache-key-separation.md) が部分的に上書き（cacheKey 指定時はキー/合流キーがそのキーになる）。`
- `0006` のヘッダを `関連:` から `部分的に上書き: 0002（Decision §1）/ 0004（決定 1）` +
  `関連: 0005` へ分離する。

**対象**: `docs/decisions/0002-request-init-passthrough.md:17` /
`docs/decisions/0004-single-flight-raw-sharing.md:16` /
`docs/decisions/0006-cache-key-separation.md:5-7`

---

## 🟡W DC-2 — `cacheKey` × `verifiedMarker`（0005 の印）の危険側が ADR 0006 / limitations に無い

**概要**: ADR 0006 §4 は 0005 との相互作用を**利得だけ**記している —
「印は cacheKey 側のエントリに乗る … 全経路で全量ハッシュが 1 回も走らない（0005 §5 の性質が
そのまま分離後も成立する）」（`0006:61-67`）。裏面が書かれていない: `cacheKey` を誤った
（内容の違う）エントリに `sha256` 付き prefetch で印を焼き、同じ印で `fetchBytes` すると
**`validate` が完全に省かれる**ため（`src/mod.ts:369-372` の印一致判定）、self-heal
（`src/mod.ts:386-393`）が一度も走らず汚染が恒久化する。

**実害・発生条件**: 下流の manifest が誤ったキーを与えた場合（0006 Consequences が
「ヒットも合流も誤った内容を配る」と認めているケース）に、`verifiedMarker` を併用していると
**回復手段が evictUrl / clearCache の手動操作しか無くなる**。ADR 0005 §5 は
「**印の健全性を呼び出し側の行儀に依存させない**」ことを設計の要としてチャンク複製まで
入れた経緯があり、0006 はその依存（キーの正しさ = 呼び出し側の主張）を新たに持ち込む。
方針として妥当でも、0005 の要件と真正面から交差する以上、明記されていないのは記述漏れ。

**修正案**: `0006` の Consequences に 1 項追加 —
「`verifiedMarker` / `trustCachedSha256` と併用すると、誤ったキーで載った内容は
`validate` が省かれるため self-heal で回復しない（0005 §5 の『印は以後の検証を丸ごと
省かせる』が、キーの正しさという新しい前提に乗る）」。`docs/limitations.md` の `cacheKey`
バレット（23-29 行）にも同趣旨を 1 文。

**対象**: `docs/decisions/0006-cache-key-separation.md:61-67, 84-94` /
`docs/limitations.md:23-29` / 根拠実装 `src/mod.ts:369-372, 386-393`

---

## 🟡W DC-3 — `evictUrl` / `listCachedUrls` がキー空間で動くことが JSDoc・limitations に無い

**概要**: ADR Consequences（`0006:88-89`）と README（`README.md:208-210`）には
「キー空間で引く」と書かれているが、**API 本体の JSDoc**（`src/mod.ts:774-777` の
`evictUrl`「指定 URL のキャッシュエントリを削除する」/ `src/mod.ts:808-814` の
`listCachedUrls`「キャッシュ済み URL 一覧を返す」）と `docs/limitations.md` には記述が無い。

**実害・発生条件**: `cacheKey` 利用者が取得元 URL を `evictUrl` に渡すと、`cache.delete`
（`src/mod.ts:788`）が単に `false` を返す — **throw も警告もない silent no-op** で、
「evict したつもりが残っている」に気付けない。本プロジェクトの fail-loud 方針
（CLAUDE.md / ADR 0001）に対する数少ない穴であり、しかも IDE 上で最初に読まれるのは
README ではなく JSDoc。

**修正案**: 両 JSDoc に 1 行ずつ —
「`cacheKey` を使った場合、対象はキー空間（取得元 URL では引けない。DECIDED:
docs/decisions/0006）」。`docs/limitations.md` の `cacheKey` バレットにも同文を追加。

**対象**: `src/mod.ts:774-777, 808-814` / `docs/limitations.md:23-29`

---

## 🟡W DC-4 — limitations の single-flight バレットに旧「URL のみ」前提の括弧書きが残存

**概要**: 同一バレット内で更新が片側だけ入っている。10 行目は
「合流キーは (cacheName, `cacheKey` ?? URL) のみで」へ更新済みなのに、12-13 行目の括弧書きは
「認証ヘッダ違いを区別しないのは**キャッシュキーが URL のみの設計**と同じ割り切り」と
旧前提を根拠に据えたまま。また 19 行目のバレット見出し
「**キャッシュキーは URL のみ（認証非対応）**」も、本文（21-22 行）が
「切り離したい場合は `cacheKey` を使う」と打ち消しているのに見出しだけ断定形で残る。

**実害・発生条件**: 同じ文書の同じ節が「キーは URL のみ」と「キーは `cacheKey` ?? URL」を
併記する形になり、読み手が本文か見出しかどちらを規範と取るかで判断が割れる。実装への影響は
無いが、limitations は「意図的な制約」の規範文書なので断定の取り残しはコストが高い。

**修正案**: 12-13 行を「認証ヘッダ違いを区別しないのは**キーがヘッダ非依存**な設計と同じ
割り切り」へ。19 行の見出しを「**キーにヘッダは入らない（認証非対応）**」等、`cacheKey`
導入後も真である表現へ。

**対象**: `docs/limitations.md:10-13, 19-22`

---

## 🔵L DC-5 — `HfFetchOptions.init` の「キャッシュキーは URL のみ」は現状のまま正しい

`src/hf/mod.ts:143-144` の「キャッシュキーは URL のみ（docs/limitations.md）」は、HF 層の
読み出し API（`HfFetchOptions`）に `cacheKey` の口が無い（ADR 0006 §5）以上、この API に
対しては**事実として正しい**。ドリフトではないので修正不要と判断。ただし参照先
`docs/limitations.md:19` の同名バレットは条件付きになったため、DC-4 で見出しを直すなら
この一文も「キーにヘッダは入らない」へ揃えると読み手の混乱が減る（任意）。

## 🔵L DC-6 — README の `verifySha256` 未定義は新規ドリフトではない

`README.md:191` の `validate: verifySha256` は未定義識別子だが、v0.4.0 時点の
`README.md:139` が既に同じプレースホルダ流儀（読者が用意する検証関数）で使っており、
本差分が持ち込んだ問題ではない。README 全体で名前付きプレースホルダを導入する方針なら
別タスク（`// your own sha256 check` のコメントを 1 行足すだけで解消）。

## 🟢S DC-7 — ADR 0006 の宣言と実装は全て一致（突合結果）

| ADR 0006 の宣言 | 実装 |
| --- | --- |
| §1 cache 側 4 箇所が `cacheKey ?? requestUrl` | `src/mod.ts:369`(match) / `389`(delete) / `417`(put) / `506-508`(in-flight key) |
| §1 `onCacheError.url` は取得元のまま | `src/mod.ts:360, 377, 392, 419` すべて `url: requestUrl` |
| §2 同一 `cacheKey` の別 URL は合流 | `src/mod.ts:506-508`（キーに URL が入らない） |
| §3 http(s) ガード / `cache: false` 併用禁止 | `src/mod.ts:475-487`（`isHttpUrl` は `src/mod.ts:159-169`） |
| §4 prefetch は match / put / 保険 delete をキーで | `src/mod.ts:656, 738, 751`。ガードは `630-635` |
| §5 `HfPrefetchOptions.cacheKey` 素通し・結果欄は増やさない | `src/hf/mod.ts:365` / `315`（`url` は取得元のまま） |

実装にあって ADR に無い挙動は検出できなかった。`cacheKey` ガードが非 GET 判定より後に
置かれている点（非 GET ガード `src/mod.ts:462-470` → `cacheKey` ガード `475-487`）は ADR が順序を規定していないため差異ではない。
