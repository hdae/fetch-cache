---
id: G5
topic: 文書整合とリリース検品（ADR 0010 / 0011・README・limitations・CLAUDE.md・公開 JSDoc・deno.json・workflows）
files_reviewed:
  - README.md
  - docs/limitations.md
  - docs/known-issues.md
  - docs/decisions/0010-retry-after-rate-limit.md
  - docs/decisions/0011-hf-expected-bytes-bound.md
  - CLAUDE.md
  - src/mod.ts（モジュール doc / 型再公開）
  - src/hf/mod.ts（公開 JSDoc）
  - src/core.ts（公開 JSDoc のみ）
  - src/retry.ts（公開型 JSDoc / モジュール doc）
  - deno.json
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
date: 2026-09-05
model: opus
---

## サマリ

v0.6.0..HEAD（8 コミット）の文書は、実装に対して概ね正確に着地している。\
ADR 0010 / 0011 は既存 ADR（0007 / 0009）と同じ書式（日付 / 状態 / 関連 / Context / Decision /
Consequences）で揃っており、数値（既定 `[429, 503]` / `maxRetries: 5` / `baseDelayMs: 1000` /
1+2+4+8+16 = 31 秒 / `2**31 - 1` ms ≒ 24.8 日）はすべて実装と一致する。\
リリース検品も問題なし: `deno.json` の version は 0.6.0 のまま、`src/mod.ts` の `VERSION` も
0.6.0 で drift 無し、`scripts/` と `.github/workflows/` は今回無変更で `src/retry.ts` 追加の影響を
受けない（publish include は `src/**/*.ts` で新モジュールを自動的に拾う）。

一方で、**同じ挙動を説明する 3 か所（ADR / limitations / JSDoc）が実装と食い違う記述を 1 件**、
**README にだけ抜けている制約を 1 件**、**limitations の一覧が更新漏れ**を 1 件見つけた。いずれも
コードのバグではなく、下流が文書どおりに実装すると読み違える種類の齟齬。

件数: 全 7 件（🟠 Error 0 / 🟡 Warning 3 / 🔵 Low 4 / 🔴 Critical 0）。

## ファイル別分類

| ファイル | 判定 | 理由 |
| --- | --- | --- |
| README.md | 🟡 Warning | 再試行節に「GET / HEAD 限定」が無く、機能一覧の "a `429` or `503` is retried automatically" が実装より広い（G5-03）。HF 節の打ち切り説明に body null 経路の但し書きが無い（G5-04） |
| docs/limitations.md | 🟡 Warning | 合流者が受け取らないオプション一覧に `retry` / `onRetry` が入っていないのに再試行項が「上の single-flight 項」を参照（G5-01）。setTimeout 上限超過時の「従来の文言で throw」が不正確（G5-02） |
| docs/decisions/0010-retry-after-rate-limit.md | 🟡 Warning | §2「最初の応答をそのまま返し」が実装と食い違う（G5-02）。Retry-After の解釈範囲が実装より狭く書かれている（G5-06） |
| docs/decisions/0011-hf-expected-bytes-bound.md | 🔵 Low | Consequences のエラー文言引用が実文言と 1 文字ずれ・arrayBuffer 経路の変種が未記載（G5-05）。それ以外（§1〜§3・表・body null 注記）は実装と一致 |
| docs/known-issues.md | 🟢 Safe | 今回の差分から新規の未解決問題は生じていない（打ち切れない body null 経路・上限超過の待機は by-design として limitations / ADR 側に着地済み） |
| CLAUDE.md | 🟢 Safe | Layout の `src/retry.ts` 記述（内部モジュール・3 呼び出し点・公開は 2 型だけ）は `src/retry.ts:1-11` / `src/mod.ts:52-54` / `src/hf/mod.ts:37-44` と一致 |
| src/mod.ts | 🔵 Low | モジュール doc「取得系はいずれも 429 / 503 を既定で再試行する」は非 GET を含意しうる（G5-03 と同根） |
| src/hf/mod.ts | 🟢 Safe | `HfFileSpec.expectedBytes` / `HfFetchOptions.retry` / `prefetchHfFile` の NOTE はいずれも実装と一致 |
| src/core.ts（公開 JSDoc） | 🟢 Safe | 合流者の非採用オプション一覧に `retry` / `onRetry` が入っており（`src/core.ts:855-857`）、こちらが正 |
| src/retry.ts（JSDoc） | 🟡 Warning | 関数 doc「どちらも最初の応答をそのまま返し」が上限超過ケースで不正確（G5-02） |
| deno.json | 🟢 Safe | version 0.6.0（未 bump）・exports 不変・publish include が `src/**/*.ts` で retry.ts を含む |
| .github/workflows/ci.yml | 🟢 Safe | 無変更。`deno task check` 一発で新テストも回る |
| .github/workflows/release.yml | 🟢 Safe | 無変更。tag == deno.json.version の検証 → `deno publish`（OIDC）で前回と同じ |

## 詳細指摘

### G5-01 🟡 limitations の「合流者が受け取らないオプション」一覧に `retry` / `onRetry` が無い

**質問**: 合流者の非採用オプションの正本は limitations の single-flight 項でよいか。だとすれば
`retry` / `onRetry` をそこへ足すか。

**概要**: `src/core.ts:855-857` の JSDoc は合流者が受け取らないものとして
`fetch` / `caches` / `init` / `onCacheError` / `expectedBytes` / `retry` / `onRetry` を列挙する。\
一方 `docs/limitations.md:10-11` の一覧は v0.6.0 のまま `expectedBytes` で止まっており、
`retry` / `onRetry` が入っていない。\
にもかかわらず再試行項（`docs/limitations.md:51-52`）は「合流者の `retry` / `onRetry` は使われない
（… — 上の single-flight 項）」と、その一覧を参照している。\
最終コミット 833e5bc の題は「合流者が受け取らないオプションの一覧に retry / onRetry」だが、実際に
触れたのは `src/core.ts` と README で、limitations の一覧は据え置かれている。\
守っている目的は「合流者に効かないオプションの完全な一覧を 1 か所で読めること」。参照先が不完全だと、
`retry` 以外に効かないものを探した読者が誤った完全性を得る。

**選択肢**:

- a) ★ `docs/limitations.md:10-11` の一覧へ `retry` / `onRetry` を追記し、再試行項の末尾（51-52 行）は
  参照だけに縮める（正本 1 か所・重複記述なし）。
- b) 再試行項の記述を残したまま一覧にも追記する（重複するが読み口はどちらからでも完結）。
- c) 現状維持（再試行項に書いてあるので実害は小さいと見る）。

**リスク**: a) は文言修正のみでコード影響なし。c) は次にオプションが増えたとき同じ漏れを誘発する。

**対象**: `docs/limitations.md:10-11`（一覧）・`docs/limitations.md:51-52`（参照元）・
`src/core.ts:855-857`（正しい一覧）

**影響範囲**: 文書のみ。

**引き継ぎ**: 10-11 行の強調範囲（`**合流者の … は使われない**`）の中へ
`` / `retry` / `onRetry` `` を足すだけ。`deno fmt` の proseWrap は preserve なので行幅は手で整える。

### G5-02 🟡 setTimeout 上限超過時の「最初の応答」「従来の文言」が実装と食い違う

**質問**: 上限超過で再試行を止めたときの応答は「最初の応答」か「そこまでの最後の応答」か。文言に
`（再試行 N 回の後）` が付き得ることを文書へ書くか。

**概要**: `src/retry.ts:169-175` は、`maxDelayMs` 適用後の待機が `MAX_TIMER_MS` を超えるとループを
抜けて `{ response, retries: attempt }` を返す。ここで `response` は**そのラウンドの応答**であり、
`retries` は**それまでに実際に行った再試行回数**。したがって
「1 回目 429（Retry-After: 1）→ 待って再試行 → 2 回目 429（Retry-After: 2592000）」のような応答列では、
返るのは 2 回目の応答で `retries === 1`、呼び出し点（`src/core.ts:798-802` ほか）の文言は
`fetch-cache: HTTP 429 Too Many Requests (url)（再試行 1 回の後）` になる。\
ところが 3 か所の文書は「最初の応答」「従来の文言」と書いている:

- `docs/decisions/0010-retry-after-rate-limit.md:53`「最初の応答をそのまま返し」
- `docs/limitations.md:47-48`「応答をそのまま返して従来の文言で throw し」
- `src/retry.ts:139-141`「どちらも最初の応答をそのまま返し」

GET / HEAD 以外という**もう一方の非再試行ケース**では確かに「最初の応答」「従来の文言」で正しい
（ループへ入らない — `src/retry.ts:151-156`）。2 つのケースを 1 文にまとめたことで、上限超過側だけ
説明が実装より狭くなっている。\
守っている目的は「下流はエラー文言の先頭一致で判別している」という互換の約束（ADR 0010 §4）。先頭は
確かに不変だが、「従来の文言」＝末尾も含めて同一、と読むと突合の実装を誤る。

**選択肢**:

- a) ★ 3 か所とも「そのラウンドの応答をそのまま返す（それまでの再試行回数は文言の末尾に残る）」へ
  直す。retry.ts の JSDoc は 2 ケースを分けて書く。
- b) 実装を文書へ寄せる（上限超過時は `retries: 0` を返す）。ただし実際に待って再試行した事実を
  握り潰すことになり、fail loud の趣旨に反する。
- c) 現状維持（先頭一致は保たれるので実害なしと見る）。

**リスク**: a) は文書のみ。b) は挙動変更で、`onRetry` を数えた呼び出し側との辻褄が合わなくなる（非推奨）。

**対象**: `src/retry.ts:139-141`・`src/retry.ts:175`・`docs/decisions/0010-retry-after-rate-limit.md:53`・
`docs/limitations.md:47-48`

**影響範囲**: 文書 + JSDoc（JSR のドキュメントに出る）。コード変更なしを推奨。

**引き継ぎ**: `src/retry.ts:175` が `return { response, retries: attempt }` である事実がすべて。
`attempt` はその時点までに完了した再試行数で、0 とは限らない。

### G5-03 🟡 README に「再試行は GET / HEAD だけ」が書かれていない

**質問**: README の再試行節へ method 制限を 1 文足すか、`cache: false` の説明（Auth & abort 節）側へ
置くか。

**概要**: 実装は `src/retry.ts:55-56, 151-156` で、`init.method` が GET / HEAD 以外なら再試行そのものを
行わない。`cache: false` を渡せば任意の method を通せる設計（ADR 0002）なので、これは利用者が実際に
踏み得る分岐である。\
`docs/limitations.md:41-43` と ADR 0010 §1（`docs/decisions/0010-retry-after-rate-limit.md:33-38`）は
明記しているが、README にはどこにも無い:

- `README.md:46-49`（機能一覧）「a `429` or `503` is retried automatically」— 無条件に読める。
- `README.md:329-331`（再試行節）は再試行しないものとして接続エラー・受信途中の切断・その他の
  4xx / 5xx を数え上げているが、method の話が無い。読者はこの列挙を網羅と受け取る。
- `src/mod.ts:15-16` のモジュール doc「取得系はいずれも 429 / 503 を既定で再試行する」も同様に広い。

守っている目的は「冪等でない要求をライブラリが黙って打ち直さない」ことで、実装は正しい。文書だけが
過大保証になっている。

**選択肢**:

- a) ★ `README.md:329-331` の列挙へ「and anything that is not a GET or HEAD (you can send other
  methods with `cache: false`)」を足す。1 文で済み、`cache: false` の説明（`README.md:294-296`）とも
  結び付く。
- b) 機能一覧（46-49 行）側に "GET / HEAD" と書き足す。目に付くが、一覧が長くなる。
- c) `src/mod.ts:15-16` の JSDoc だけ直す（JSR の doc は正確になるが README は残る）。

**リスク**: いずれも文書のみ。放置した場合の実害は「POST で再試行されると思った利用者が rate limit で
落ちる理由を掴めない」こと。

**対象**: `README.md:46-49`・`README.md:329-331`・`src/mod.ts:15-16`（実装は `src/retry.ts:151-156`）

**影響範囲**: README（英語）+ 公開 JSDoc。

**引き継ぎ**: limitations の該当文（41-43 行）をそのまま英訳すれば足りる。

### G5-04 🔵 README の「チャンク境界で打ち切る」に body null 経路の但し書きが無い

`README.md:423-429` は HF 層の `expectedBytes` を "cut off at the chunk that crosses it and throws
right there" と説明する。`response.body` が null のランタイム（`src/core.ts:469-475` と
`src/core.ts:1261-1268` の arrayBuffer フォールバック）では打ち切れず、全量受信後に長さで判定する。
ADR 0011 は最終コミット 833e5bc でこの但し書きを Consequences（`docs/decisions/0011-hf-expected-bytes-bound.md:76-78`）へ
足したが、README には反映されていない。実害は小さい（帯域節約が効かないだけで失敗の内容は同じ）が、
README の 1 文に "(on runtimes without a streaming `response.body` the check still happens, but only
after the full transfer)" 相当を添えると整合する。

### G5-05 🔵 ADR 0011 のエラー文言引用が実文言と一致しない

`docs/decisions/0011-hf-expected-bytes-bound.md:66-67` は
`fetch-cache: 受信が申告 {maxBytes} バイトを超えた（{n} バイト以上）({url})` と引用するが、実装
（`src/core.ts:393-398`）は `…（${received} バイト以上） (${requestUrl})` で `(` の前に半角空白が入る。
また arrayBuffer 経路（`atLeast === false`）では `（{n} バイト）` と「以上」が付かない変種になる
（`src/core.ts:472-474`・`src/core.ts:1264-1267`）。文言で突合する下流が出たときに効くので、ADR の
引用を実文言へ合わせるか、変種があることを 1 節書き足すのが望ましい。

### G5-06 🔵 ADR 0010 の Retry-After 解釈が実装より狭く書かれている

ADR 0010 §2（`docs/decisions/0010-retry-after-rate-limit.md:44-47`）と `src/retry.ts:58-62` は
「delta-seconds と HTTP-date の 2 形式」と書くが、実装は `Date.parse(trimmed)`
（`src/retry.ts:67`）なので ISO 8601 など HTTP-date 以外の日時表記も受理する。仕様上サーバが送るのは
HTTP-date なので実害は無く、寛容な方向の乖離。「`Date.parse` が解釈できる日時表記」と書けば実装と
一致する（文書が実装より狭い側の齟齬なので低優先）。

### G5-07 🔵 リリース検品: 0.7.0（minor）で妥当。ただし 1 件だけ「成功 → throw」の遷移がある

- `deno.json:3` = `0.6.0`、`src/mod.ts:30` の `VERSION` = `"0.6.0"` で drift 無し。リリース時は
  `deno task bump minor`（→ 0.7.0）で 1 コミット同期 → `v0.7.0` タグの GitHub Release、という
  `README.md:607-615` の手順がそのまま使える。`scripts/` は version の単一真実源だけを見るので
  `src/retry.ts` の追加による影響は無い。
- semver: 公開 API は追加のみ（`FetchBytesOptions.retry` / `onRetry`、`PrefetchUrlOptions` 同、
  `HfFetchOptions` / `HfPrefetchOptions` 同、型 `RetryPolicy` / `RetryContext`）で、既存シグネチャの
  変更・削除は無い。既定挙動の変化（429 / 503 を待って取り直す・失敗が最大 31 秒遅くなる・エラー文言の
  末尾に `（再試行 N 回の後）`）は minor で許容される範囲。
- **唯一の注意点**: `prefetchHfFile` に `expectedBytes: -1` / `1.5` のような形式不正を渡す呼び出しは、
  v0.6.0 では**成功していた**（prefetch は `expectedBytes` を一切見なかった）。HEAD では `toSpec`
  （`src/hf/mod.ts:326-335`）が要求の前に throw する。読み出し（`fetchHfFile`）ではどのみち長さ不一致で
  落ちる申告なので破壊的変更とまでは言えないが、リリースノートには behavior-change として載せるべき。
- 併せて `fetchHfFile` 経路も、宣言超過の応答は全量受信後の長さ不一致から**受信途中の別文言**へ変わる。
  文言で分岐している下流があれば影響する（先頭 `fetch-cache: ` は不変）。

## 重要な経路の ASCII 図（再試行の合流点・実行番号は HEAD の実コード行）

```
   fetchBytes (cache 経路 / cache:false)          prefetchUrl              resolveHfRevision
   src/core.ts:785-793                            src/core.ts:1217-1223    src/hf/mod.ts:186-192
              |                                          |                          |
              +------------------+-----------------------+--------------------------+
                                 v
                    src/retry.ts:144 fetchWithRetry(fetchImpl, url, init, policy, onRetry)
                                 |
        policy === false または method が GET / HEAD 以外  --> retry.ts:151-156
                                 |                            初回応答 + retries:0 で即返す
                                 v
        retry.ts:162  while(true)  ── fetchImpl(url, init)  … retry.ts:163
                                 |
        対象ステータス外 or attempt >= maxRetries --------> retry.ts:164-166 return {response, attempt}
                                 |
        delayMs = min(parseRetryAfter(ヘッダ) ?? base*2**attempt, maxDelayMs ?? Inf)  … retry.ts:169-172
                                 |
        delayMs > 2**31-1 -------------------------------> retry.ts:175 return {response, attempt}
                                 |                          ※ attempt は 0 とは限らない（G5-02）
        attempt += 1 → body.cancel → onRetry → sleep(signal 中断可)  … retry.ts:176-185
                                 |
                                 +--> ループ先頭へ
                                 v
   呼び出し点で !response.ok なら従来文言 + retrySuffix(retries)
   src/core.ts:795-804 / src/core.ts:1224-1233 / src/hf/mod.ts:193-202
```

## 横断所見

- **文書の骨格は健全**: ADR 0010 / 0011 は既存 ADR（0007:1-6・0009:1-9）と同じヘッダ書式で、`関連`
  も相互リンクが実在ファイルを指す。CLAUDE.md の Docs / Layout も更新済み。`docs/known-issues.md` は
  今回の差分で追加すべき項目が無い（打ち切れない body null 経路・上限超過の非再試行はいずれも
  by-design として limitations / ADR に着地済み）。
- **旧 ADR の陳腐化は見つからなかった**: ADR 0005 §5 に「prefetch が見るのは sha256 だけ」に相当する
  断定文は存在せず（`docs/decisions/0005-…:96-143` を確認）、`expectedBytes` への言及
  （0005:133-138）は印の意味の話で今回の変更と衝突しない。0007 / 0009 の `expectedBytes` 記述はいずれも
  汎用層＝確保ヒントの文脈で、ADR 0011 §1 が明示的に不変と宣言した契約と一致する。
- **前回 ROADMAP（2026-09-02_3b13d16）との関係**: 見送り項目（G2-04(b) / 2(a) の緩和 / G3-07〜20 /
  G1-12・13 / G4-12・14）はいずれも `into` と合流の話で、今回の差分は抵触も解消もしていない。
- **齟齬の出方に共通の型がある**: 今回の 3 件（G5-01 / G5-02 / G5-03）はすべて「同じ事実を 3 か所
  （ADR・limitations・JSDoc/README）へ書く」運用で、1 か所だけ更新が届かなかったもの。次に再試行系を
  触るときは、`retry` / `onRetry` / 上限超過の 3 語を 4 ファイル（README・limitations・ADR 0010・
  retry.ts）で grep して差分を突き合わせるのが確実。
