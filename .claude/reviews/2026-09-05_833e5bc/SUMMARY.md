# レビュー SUMMARY — 再試行（ADR 0010）+ HF `expectedBytes` 上限（ADR 0011）の 0.7.0 リリース前検品

- 実施日: 2026-09-05 / HEAD: 833e5bc（v0.6.0 = d8e1742 以降の 8 コミット）/ 前回:
  `.claude/reviews/2026-09-02_3b13d16/` / モード: **A（差分）** — 差分 + テスト品質横断 + 文書整合 +
  リリース検品の 5 レンズ
- 配分: Workflow で Opus × 5（G1 retry 中核・G2 core 統合 = effort high / G3 HF 層と API 面・G4
  テスト品質・G5 文書とリリース = medium）→ Warning 以上 15 件を Opus（high）で 1 件ずつ反証
  （15 レッグ）。統合と最終突合はオーケストレータ（コード実読 + `deno eval` 実測）。
- CI: `deno task check` 緑（209 passed / 0 failed / 1 ignored）、`deno publish --dry-run` 成功
  （`src/retry.ts` 同梱・slow types 無し）。

## 結果ダイジェスト

| 重大度 | 件数（反証後） | 主なもの |
| --- | --- | --- |
| 🔴 Critical | 0 | — |
| 🟠 Error | 0 | — |
| 🟡 Warning | 5 | W1 `Retry-After` の数値系書式ミス（"1.5" / "+120"）が `Date.parse` で過去日付に化けて待機 0 ms の連打 / W2 `RetryPolicy` の数値が無検査で NaN が「守れない待機は再試行しない」の MUST を素通り（`maxRetries: NaN` は無限ループ）/ W3 テスト 2 本が退行時に赤ではなく 1〜5 時間ハング / W4 再試行に jitter が無く並列 fan-out が同期して打ち直す（設計軸）/ W5 汎用層でも既定の待機上限が無い（ADR 0010 §2 の by-design だが「最大 31 秒」の文書が不正確） |
| 🔵 Low | 27 | 文書の取りこぼし（上限超過時の応答の説明・GET/HEAD 限定が README に無い・prefetch の「成功 → throw」遷移 2 種・接尾辞は最終ステータスに関わらず付く）、テストギャップ 9 件、小粒の設計メモ |

**ブロッカー無し**。再試行の中核契約（retries 会計・timer / abort リスナーの所有権・`onRetry` は
待機の前・中断は `signal.reason`・GET / HEAD 限定・`setTimeout` 上限超えは再試行しない）は
全経路で成立し、lost wakeup / 二重解決 / ダングリング timer は await 境界の位置から棄却
（G1 が証明・オーケストレータが `retry.ts:87-102` を実読で確認）。`maxBytes` の差し込みは既存の
不変条件（`into` 容量検査より先・キャッシュヒット側不変・エラー文言の先頭不変・内部型の非露出）
を壊していない。**公開 API は追加のみで `deno task bump minor`（0.7.0）が妥当**。指摘は
「**入力の端**（off-spec な `Retry-After`・不正な policy 値）」「**文書が実装と半歩ずれた箇所**」
「**新機能の契約を凍結するテストの不足**」に集中。

要判断は **2 件**（下記 2・3）。最優先は 2（jitter を入れるか — 入れない場合も ADR に判断を残す）。

## 要判断（ユーザー裁定待ち）

### 1. 推奨案で進める一覧（承認語 1 つで一括・個別に外せる）

コード（`src/retry.ts` / `src/core.ts`）:

- 1-1) **W1 / G1-01**: `parseRetryAfter` で `Date.parse` に渡す前に英字始まり（RFC 9110 の HTTP-date
  3 形式は全て曜日名で始まる）以外を「指示なし」へ落とす。副作用: 現在 `Date.parse` が受理して
  いる ISO-8601（off-spec）も「指示なし」扱いになる。凍結テストは "1.5" / "+120" / "-5" / "1,5" の
  表駆動で `delayMs` が `baseDelayMs` 系列になること。
- 1-2) **W2 / G1-02 / G2-07**: `fetchWithRetry` の入口で policy を検査し、要求の前に throw する
  （`sha256` / `expectedBytes` の形式検査と同じ fail loud）— `maxRetries` は 0 以上の安全整数、
  `baseDelayMs` / `maxDelayMs` は 0 以上の有限数。文言は `fetch-cache: retry.<field> は … で指定して
  ください: <値> (<url>)`。凍結テストは `maxDelayMs: NaN` / `maxRetries: NaN` で `calls.length === 0`。
  NOTE: 検査位置が `fetchWithRetry` なのでキャッシュヒットで決着する呼び出しでは throw しない
  （network に出る直前で落ちる）。
- 1-3) **G1-06**: 1-2 の検査に `statuses` も含め、各要素を 400〜599 の整数に限定する（2xx を入れると
  成功応答を捨てて打ち直す誤設定を入口で弾く）。外すなら 1-2 だけ残す。
- 1-4) **G2-03**: body が null のランタイム向け経路（`readBody` と `prefetchUrlWithKey` の 2 か所）で
  `maxBytes` 判定を `onProgress` の前へ移す（stream 経路と同じく、超過した `loaded` を進捗に流さない）。

テスト（既存テストは触らない・追加のみ。各 1 本・小）:

- 1-5) **W3 / G1-03 / G4-01**: `retry.test.ts:156`（maxDelayMs）と `:341`（既 aborted）に
  `retry.test.ts:316-322` と同じ `Promise.race` の deadline（2 秒）を入れる。ヘルパ化して 3 本で共有。
- 1-6) **G4-03**: `into` 6 バイト + `expectedBytes` 6 + 4 バイト × 3 の応答で、文言が「受信が申告 6
  バイトを超えた」で `IntoCapacityError` ではないこと（ADR 0011 の順序 MUST の凍結）。
- 1-7) **G4-11**: `retry: false` の 503 が初回で throw する（41a7842 で消えた観測点の復元。新規ケース）。
- 1-8) **G4-06**: `maxRetries: 0` と `statuses: []` で `calls.length === 1`・`onRetry` 未発火。
- 1-9) **G4-05**: `cache: false` + HEAD が再試行される（`calls.length === 2`）。
- 1-10) **G4-10**: `prefetchUrl` 側の文言末尾に「（再試行 1 回の後）」が付く。
- 1-11) **G4-09**: single-flight の合流者が leader の再試行を待ち、合流者の `retry: false` / `onRetry` は
  使われない（`calls.length === 2`・合流者の `onRetry` 0 回）。
- 1-12) **G4-08**: HF の `expectedBytes: 0` — 空 body で成功（長さ 0）・1 バイトで「申告 0 バイトを超えた」。
- 1-13) **G4-04**: body が null の経路の上限（`fetchBytesWithKey` / `prefetchUrlWithKey` に `maxBytes: 2`
  で 5 バイト → 「（5 バイト）」= 「以上」の付かない確定値で reject、prefetch はエントリ不成立）。
- 1-14) **G5-02 / G1-05④**: 1 回目 `Retry-After: 0` → 2 回目 `Retry-After: 2592000`（上限超え）で、
  2 回目の応答が返り `retries === 1`・文言末尾が「（再試行 1 回の後）」（1-16 の記述の凍結）。
- 1-15) **G3-03**: 429 → 404 の順で来ると 404 の文言に接尾辞が付く（1-21 の記述の凍結）。

文書（README は英語・JSDoc / docs は日本語）:

- 1-16) **G5-02**: `setTimeout` 上限超えで再試行を止めたとき返るのは「そのラウンドの応答」で、それまでの
  再試行回数は文言末尾に残る — ADR 0010 §2（:53-54）/ limitations（:47-48）/ `retry.ts` JSDoc
  （:138-142）の「最初の応答」「従来の文言」を訂正（GET / HEAD 以外の非再試行だけが「最初の応答」）。
- 1-17) **G5-03**: README の再試行節（:329-331）と `src/mod.ts` モジュール doc に「再試行は GET / HEAD
  だけ。他の method は `cache: false` 経由でしか network に出ず、429 / 503 でも初回で throw」を明記。
- 1-18) **G5-01**: limitations の single-flight 項（:10-11）の「合流者が受け取らないオプション」一覧へ
  `retry` / `onRetry` を追加（`core.ts:855-857` の JSDoc と同文に）。
- 1-19) **W5 / G2-01（3 = a の場合）**: limitations（:50）と ADR 0010 Consequences（:87）の「恒久的に
  503 を返すサーバに対しては既定で最大 31 秒」に「`Retry-After` が無ければ」の限定を付け、
  `Retry-After` 付きなら「指示 × 最大 5 回が累積する（`Retry-After: 3600` なら 5 時間）」を明記。
- 1-20) **G3-02 / G5-07 / G2-11**: ADR 0011 Consequences 第 1 項「失敗の内容は変わらず時刻だけが早くなる」
  に例外 2 つを追記 — ①温め側 spec の `expectedBytes` が実長より小さく、読み出し側 spec が同じ宣言を
  持たない場合、v0.6.0 で成功していた `prefetchHfFile` が throw する ②形式不正（負・非整数）の
  `expectedBytes` は prefetch でも要求前に throw する（v0.6.0 は無視して成功）。limitations の
  prefetch 項にも 1 文。リリースノートに behavior change として載せる。
- 1-21) **G3-03 / G2-06**: README（:331-333）と ADR 0010 §4 の接尾辞条件を「再試行が 1 回以上走った後の
  HTTP エラーは、最終ステータスが 429 / 503 でなくても末尾に付く」へ訂正。
- 1-22) 小粒: G5-04 README の HF 節に「body が stream で読めないランタイムでは打ち切れず全量後に判定」
  / G5-05 ADR 0011 の文言引用を実文言（`）` と `(url)` の間の空白・「以上」無しの変種）に合わせる /
  G5-06 ADR 0010 §2 と JSDoc の `Retry-After` 解釈を 1-1 後の実装（曜日名で始まる HTTP-date のみ）に
  合わせる / G1-07 `baseDelayMs` の JSDoc を「再試行の通算回数で 2 倍ずつ（`Retry-After` に従った
  回も数える）」へ / G3-08 limitations に「`expectedBytes: 0` は妥当な申告（0 バイトファイル）で、
  確保ヒントとしてだけ無視される」/ G2-09 limitations の single-flight 項に「leader の `init.signal`
  による中断も取得失敗として合流者全員へ伝播する（合流者自身の signal は効かない）」/ G2-10
  再試行項に「self-heal で evict した後の再取得も再試行を通るので、その待機中エントリは存在しない」。
- 1-23) **2 = a の場合**: ADR 0010 に「jitter を入れない」判断と理由を 1 段落追記。

リリース:

- 1-24) `deno task check` 緑 → `deno task bump minor`（0.7.0）→ リリースノート（英語・💥 無し・✨ / 🐛 /
  📝 + behavior changes を明記・Full Changelog）→ 独立レッグ 2 本（主張突合 + 両方向網羅）→
  **ノートを SendUserFile でチャットへ送付**。タグ `v0.7.0` と GitHub Release はオーナーが Web UI で
  作成（release.yml が JSR へ publish）。

### 2. 並列取得の再試行が同期する問題（thundering herd）を 0.7.0 でどう扱いますか？ [Warning / 設計]

**概要**: 待機は `Retry-After` の値、無ければ `baseDelayMs * 2 ** attempt` で、乱数成分が無い
（`src/retry.ts:169-172`）。`fetchHfFiles` は全 spec を `Promise.all` で同時に取りに行く
（`src/hf/mod.ts:480-484`）ので、Hub が rate limit を返すと N 本が同じ待機を取り、次の波も同じ
形で届く。反証レッグの実測（30 本並列・429 固定）では各波の広がりが 1〜5 ms のまま拡大せず、
既定 `maxRetries: 5` なら 30 本 × 6 波 = 180 要求が波ごとに同期する。ADR 0010 が動機に挙げた
「1 モデル = 数十本の要求」そのものの形で脱相関が無い。\
ただし反証レッグ 3 本の見立ては割れた（G2-02 holds/warning・G1-04 holds/low・G3-01 refuted/low）。
共通する事実: ①同期した群れは再試行が作るのではなく**初回の fan-out に既にある**（wave 0 の
広がりが 5 ms）— jitter が直すのは「429 の後に同じ波形を繰り返す」ぶんだけで、429 を誘発する
最初の波は変わらない。根治は `fetchHfFiles` の並行度上限。②delta-seconds と指数バックオフは
到着のばらつきをそのまま保存し、完全に揃うのは HTTP-date 形式のときだけ。③Hub の 429 が
「瞬間同時数」ではなく「時間窓クォータ」なら、jitter を足しても全本が窓明けに揃うだけで効果は薄い
（未計測）。④正しさの不変条件は壊れず、最悪でも v0.6.0 と同じ fail loud の throw に戻る。

- a) ★ **今回は入れない。ADR 0010 に「jitter を入れない」判断と理由（上記①〜③）を 1 段落残し、
  `fetchHfFiles` の並行度上限（公開 API 追加）を ROADMAP に置く** — 理由: ①症状側の手当てで根治
  （並行度上限）とは別物 ②Hub の rate limit 方式が未計測で効果を見積もれない ③既定 ON の jitter は
  文書化した 1 / 2 / 4 / 8 / 16 秒と `RetryContext.delayMs` の観測値を変え、凍結テストも書き換えに
  なる。オーナー方針「実利用のフィードバックが溜まるまで着手保留」とも整合。
- b) **opt-in の jitter を追加**（`RetryPolicy.jitter?: boolean` 既定 false。バックオフ由来の待機だけに
  equal jitter = 半分固定 + 半分乱数、`Math.min` の前に掛けて `maxDelayMs` / `MAX_TIMER_MS` の契約を
  保つ）— 既定挙動は変えない。指示由来（`Retry-After`）には掛けないので、HTTP-date で完全同期する
  場面には効かない。
- c) **既定 ON の jitter** — 文書の数値・凍結テストを書き換える。0.7.0 の「追加のみ」から外れる。

**リスク**: a) は挙動を変えない。b) c) は乱数を持ち込むため待機時間の凍結テストが決定的でなくなる
（`Math.random` の DI が要る）。\
**対象**: `src/retry.ts:169-172` / `src/hf/mod.ts:480-484` / `docs/decisions/0010-retry-after-rate-limit.md:40-47`\
**影響範囲**: `fetchHfFiles` の並列取得と、呼び出し側が自前で並列にした `fetchBytes` / `prefetchUrl`。\
**引き継ぎ**: b) を採るなら `parseRetryAfter` の戻り値を `instructed` に取り出し、`undefined` のとき
だけ `base * 2 ** attempt` に jitter を掛ける。`fetchWithRetry` に `random: () => number = Math.random`
の内部引数を足してテストから固定値を注入する。並行度上限は `HfFetchOptions.concurrency?: number`
（既定 = 無制限 = 現状）として別 ADR で扱う。

### 3. 既定で待機上限（`maxDelayMs`）を置かない判断（ADR 0010 §2）を、0.7.0 でも維持しますか？ [Low / 設計]

**概要**: `retry` は省略時に有効で、`maxDelayMs` を渡さない限り `Retry-After` の指示どおり待つ。
上限は `setTimeout` が扱える `2**31 - 1` ms（≒ 24.8 日）だけで、これは「守れない待機は再試行
しない」ためのガードであって待機時間の上限ではない。反証レッグの実測: `Retry-After: 2000000`
（約 23 日）を返す応答 1 つで、素の `await fetchBytes(url)` は 23 日間解決しない。その間フライトは
`inflight` に載ったままなので同一キーの後続呼び出しは全員合流して一緒に待ち、`into` 使用時は
`buffersInUse` にバッファを握り続ける。`init.signal` を渡していない呼び出しに中断手段は無い。
さらに上限が掛かるのは 1 回の待機だけで、同じヘッダが毎回返れば `maxRetries` 分（既定 5）が
累積する — `Retry-After: 3600` を返し続ける恒久 503 なら合計 5 時間。\
ADR 0010 §2 はこれを**明示的に選んでいる**（「既定の上限を勝手に決めないのは、長い待機ほど
その時間待たなければ通らないことを意味し、短く切れば再試行を消費するだけになるため」）。破損・
不正データは生まれず、`retry: false` / `maxDelayMs` / `init.signal` のいずれでも回避できる。
ただし文書の「恒久的に 503 を返すサーバに対しては既定で最大 31 秒」（limitations:50 / ADR:87）は
`Retry-After` が無い場合にしか成り立たず、そこだけは不正確。

- a) ★ **現状維持（ADR 0010 §2 どおり）+ 文書の限定と累積の明記（1-19）** — 理由: ①HF Hub 向けの
  主用途では指示どおり待つのが正しく、短く切る既定は再試行を無駄に消費する側へ倒す ②回避手段が
  3 つあり不可逆な壊れ方をしない ③ADR が 3 日前に明示した判断で、新しい事実は「累積」だけ。
- b) **汎用層（`fetchBytes` / `prefetchUrl`）だけ既定 `maxDelayMs`（例 60 秒）を置き、HF 層は無制限の
  まま** — 任意 origin へ向く汎用層と Hub 専用の HF 層で既定を分ける。層で既定が違う複雑さが増える。
- c) **待機の累計に上限を置く**（例 `maxTotalDelayMs`）— 新オプション。累積の問題だけを塞ぐ。

**リスク**: a) は挙動を変えない。b) c) は ADR 0010 §2 の反転または新オプションで、0.7.0 の追加のみ
リリースに載せるには重い。\
**対象**: `src/retry.ts:169-175` / `docs/limitations.md:39-52` / `docs/decisions/0010-retry-after-rate-limit.md:40-47, 87-88`\
**影響範囲**: `retry` を省略した全呼び出し（下流 yomi / sbv2-web を含む）。\
**引き継ぎ**: b) を将来採るなら `fetchWithRetry` に既定 policy を注入する口を足し、cache 層と HF 層で
別の既定を渡す。c) なら `attempt` ループに累計を持たせ、超えたら 1-16 と同じ「そのラウンドの応答を
返す」経路へ。

参考の優先度感: 2 > 1-1 / 1-2 / 1-5 > 1-16〜1-21 > 残り。

## 検証パス評定（反証レッグ → オーケストレータ最終突合）

| 所見 | 反証 verdict / severity | オーケストレータ最終 | 根拠 |
| --- | --- | --- | --- |
| W1 G1-01 `Retry-After` 数値系書式ミス → 0 ms 連打 | holds / warning | **holds / warning** | `deno eval` で `Date.parse("+120")` = 0120-01-01、`"1.5"` = 2001-01-05 を実測（オーケストレータ独自）。`retry.ts:66-69` は regex 外を無条件に `Date.parse` へ渡す。反証レッグの e2e 再現: "1.5" で calls = 6・delays = [0,0,0,0,0]。JSDoc / ADR の「解釈できない値は指示なし」と逆 |
| W2 G1-02 / G2-07 policy 無検査 | holds / warning | **holds / warning** | `NaN > MAX_TIMER_MS` は偽で `retry.ts:175` を素通り（実測 B: 30 日の指示で 6 回連打・31 ms）。反証レッグが所見より悪い経路を発見: `maxRetries: NaN` は `attempt >= NaN` が恒偽で、`Retry-After: 0` 併用なら**無限ループ**（200 回で打ち切るまで返らず） |
| W3 G1-03 / G4-01 テストの deadline 不在 | holds / warning（G1-03）, holds / low（G4-01） | **holds / warning** | `retry.ts:87-90` を外すと既 aborted の signal に後付けしたリスナーは発火しない（実測）→ 3,600,000 ms × 5 回 = 約 5 時間後に赤。`retry.test.ts:156` は `Math.min` を外すと 1 時間。`deno test` にテスト単位のタイムアウト無し（`--help` で確認）。publish 対象外なので error ではない |
| W4 G2-02 / G1-04 / G3-01 jitter 不在 | holds / warning, holds / low, **refuted** / low | **設計軸として要判断 2 へ** | 3 レッグとも「乱数成分が無く同一 delayMs」の事実は一致。割れたのは欠陥か設計かの評価。G3-01 の refuted 根拠（初回 fan-out に既に同期・HTTP-date 以外は到着幅を保存・提案が headline 場面に効かない）を採り、バグではなく設計判断として提示 |
| W5 G2-01 既定の待機上限なし | holds / low | **holds / low（by-design）+ 文書欠陥 1 点** | ADR 0010 §2 が明示。反証レッグが累積（5 × 指示）を追加発見し、「最大 31 秒」の文書が限定無しで不正確 → 1-19 |
| G5-02 上限超過時の応答の説明 | holds / low | **holds / low（文書）** | `retry.ts:175` の `return { response, retries: attempt }` はそのラウンドの応答 + 加算済み `attempt`。オーケストレータ実読で確認。反証レッグの再現: 503(RA:0) → 503(RA:2592000) で `retries = 1`・文言末尾「（再試行 1 回の後）」 |
| G5-03 README に GET / HEAD 限定が無い | holds / low | **holds / low（文書）** | `grep -n 'GET\|HEAD' README.md` のヒットは 27 / 294 行のみ（キャッシュ可否の話）。再試行節に無い。実装は `retry.ts:55-56, 151-156` |
| G5-01 limitations の合流者一覧 | holds / low | **holds / low（文書）** | `limitations.md:10-11` は v0.6.0 と同文（`expectedBytes` まで）。同ファイル :51-52 には正しく書かれており、一覧側の取りこぼし |
| G3-02 prefetch の「成功 → throw」 | holds / low | **holds / low（文書 + リリースノート）** | 反証レッグが v0.6.0 と HEAD の両ソースで実測: 実体 200 B・温め spec `expectedBytes: 100`・読み出し spec 宣言なし → v0.6.0 は温めも読み出しも成功、HEAD は温めで throw。形式不正（-1 / 1.5）も prefetch では v0.6.0 成功 → HEAD throw |
| G3-03 接尾辞の互換 | holds / low | **holds / low（文書 + リリースノート）** | 429 → 404 の順で `retries = 1` のまま非対象ステータスで return（`retry.ts:164-165`）→ 404 の文言に接尾辞。オーケストレータ実読で確認。README / ADR の「429 / 503 の場合だけ」は不正確 |
| G4-02 hf テストの無条件 `listKeys` | holds / low | **holds / low → ROADMAP** | 反証レッグが前提を反証: `mod.test.ts` にも同種が 3 件（1634 / 1715 / 1779）あり「suite を Deno 2.8 で緑に保つ規約」は元から無い。CI は v2.x（2.9）で影響なし。規約を決めてから 4 件まとめて |
| G4-03 順序 MUST のテスト不在 | holds / low | **holds / low → 1-6** | 反証レッグが判定ブロックを後ろへ移した写しで実測: 原本「受信が申告 6 バイトを超えた」/ 移動後 `IntoCapacityError`。現行テスト 3 本は全て `into` 無しで判別できない |

## 実施概要

- モード A。対象 = v0.6.0..HEAD の 12 ファイル全件 + 読み合わせ用に `core.ts` / `hf/mod.ts` /
  `retry.ts` 全体。前回 ROADMAP（2026-09-02）の見送り事項は全て未着手で、今回の差分は抵触も解消も
  していない（5 レンズ全てが確認）。
- Pass2 = 所見ごとの反証（Warning 以上 15 件・Error 以上は 0 件のため 1 レンズずつ）。tier 上げの
  再派遣は無し — uncertain は 0 件で、割れた W4 は「欠陥か設計か」の評価差であり事実は一致。
- モデル配分メモ: Opus × 5 → Opus × 15。反証レッグが所見より悪い経路（`maxRetries: NaN` の無限
  ループ・待機の累積・prefetch の形式不正 throw）を 3 件追加発見しており、1 件 1 レッグの反証は
  費用対効果が高い。G1 と G2 の jitter / 上限の重複は次回レンズ統合の候補。
- オーケストレータの独自実測: `Date.parse` の寛容さ（W1）、旧 ADR（0005 / 0007 / 0009）に
  「prefetch は sha256 だけ見る」の古い断定が残っていないこと（grep で確認・G5 も同結論）。

## ファイル別分類（統合）

| ファイル | 判定 | 理由 |
| --- | --- | --- |
| `src/retry.ts` | 🟡 | 中核契約は全経路で成立（証明済み）。入力の端（off-spec `Retry-After`・不正 policy 値）が無防備 |
| `src/retry.test.ts` | 🟡 | 20 本全てに赤にする実装行が実在・tautological 無し。2 本に deadline 無し。境界 5 点が未凍結 |
| `src/core.ts` | 🟡 | 統合は不変条件を保つ。null-body 経路の `onProgress` 順序（1-4）と文書の取りこぼしのみ |
| `src/hf/mod.ts` | 🔵 | 透過は 4 入口で完全・`maxBytes` の 2 経路は ADR どおり。`RetryContext` に `path` が無い非対称（ROADMAP） |
| `src/mod.ts` | 🟢 | 型 2 つの再公開のみ |
| `src/mod.test.ts` / `src/hf/mod.test.ts` | 🔵 | 追加 7 本は有効。既存改変 3 か所は 503 → 500 の正当な追従（弱体化ではない）。`listKeys` 無条件呼び出し 1 件（既存 3 件と同類） |
| `README.md` | 🟡 | GET / HEAD 限定・接尾辞条件・body-null 但し書きの 3 点が実装より広いか狭い |
| `docs/limitations.md` | 🟡 | 合流者一覧・上限超過の説明・「31 秒」の限定の 3 点 |
| `docs/decisions/0010` | 🟡 | 上限超過時の応答（§2）・接尾辞条件（§4）・「31 秒」（Consequences）・`Retry-After` 解釈の幅 |
| `docs/decisions/0011` | 🔵 | Consequences 第 1 項の例外 2 つと文言引用の空白 |
| `CLAUDE.md` / `deno.json` / `scripts/` / `.github/` / `src/testing/` | 🟢 | 変更不要。リリース機構は健全 |

## 過去レビューからの進捗

前回 ROADMAP（2026-09-02: G2-04(b) 合流者のコピー削減 / 2(a) 台帳の範囲重なり判定 / G3-07〜20 の
テストギャップ）と 2026-08-28 の 0.6.0 候補（revalidate / HF sha256 後付け移送 / 寿命軸）は全て
未着手のまま継続。今回の再試行と上限は ROADMAP 外の新規要求で、既存見送りと抵触しない。
`buffersInUse` を握る時間が再試行の待機ぶん延びる（W5）ため、2(a) を将来入れるときの前提が少し変わる。

## アクションアイテム

1. 裁定（2・3）→ 1 の一覧と併せて実装（コード → テスト → 文書の順でコミット分割）。
2. `deno task check` 緑 → `deno task bump minor`（0.7.0）→ リリースノート草案 → 独立レッグ 2 本で
   主張突合 + 両方向網羅 → ノートを SendUserFile → オーナーが GitHub Web でタグ `v0.7.0` + Release
   publish（release.yml が JSR へ publish）。
3. 次回観点: 「同じ事実を ADR・limitations・JSDoc・README の 4 か所に書く」運用の更新漏れが今回の
   文書指摘の全て（G5 横断所見）。再試行系を次に触るときは `retry` / `onRetry` / 上限超過の 3 語を
   4 ファイルで grep して突き合わせる。

## 実施済み指摘の記録（裁定後・2026-09-05）

裁定: 1 の一覧は全件承認（1-3 の `statuses` 範囲限定を含む）。2 = a)（jitter を入れず ADR 0010 §7
に判断を記録・並行度上限は ROADMAP へ）、3 = a)（既定の待機上限は置かず文書の限定と累積を明記）。

| commit | 内容 | 閉じた指摘 |
| --- | --- | --- |
| bbc90e5 | fix(retry): `parseRetryAfter` は英字始まり以外を `Date.parse` に渡さない（数値系の書式ミスは「指示なし」へ）。`RetryPolicy` は `fetchWithRetry` 入口で形式検査し要求前に throw（maxRetries: 0 以上の整数 / baseDelayMs・maxDelayMs: 0 以上の有限数 / statuses: 400〜599 の整数）。JSDoc（上限超過時の応答・baseDelayMs の倍化規則）も同期 | 1-1 (W1 / G1-01) / 1-2 (W2 / G1-02 / G2-07) / 1-3 (G1-06) / G1-07 / G5-06 の retry.ts 側 |
| 424af85 | fix: body が null の経路（readBody / prefetchUrlWithKey）で上限判定を onProgress より先に | 1-4 (G2-03) |
| 80bcb12 | test: 12 本追加 + 既存 3 本に `withDeadline`。全本でフォルト注入により赤化を実測（レッグ報告の対応表は `.claude/reviews/2026-09-05_833e5bc/` の Workflow journal） | 1-5 (W3 / G1-03 / G4-01) / 1-6 (G4-03) / 1-7 (G4-11) / 1-8 (G4-06) / 1-9 (G4-05) / 1-10 (G4-10) / 1-11 (G4-09) / 1-12 (G4-08) / 1-13 (G4-04) / 1-14 (G5-02 / G1-05④) / 1-15 (G3-03) |
| 2e5d5a4 | docs: README / limitations / ADR 0010（§2 訂正・§4 接尾辞条件・§6 形式検査・§7 jitter 不採用・Consequences の累積）/ ADR 0011（Consequences の例外 2 つ・文言引用）/ mod.ts モジュール doc | 1-16 (G5-02) / 1-17 (G5-03) / 1-18 (G5-01) / 1-19 (W5 / G2-01) / 1-20 (G3-02 / G5-07 / G2-11) / 1-21 (G3-03 / G2-06) / 1-22 (G5-04 / G5-05 / G5-06 / G3-08 / G2-09 / G2-10) / 1-23 (2 = a) / 3 = a |
| fb48975 | chore(release): 0.7.0 | 1-24（bump。リリースノートは `RELEASE_NOTES_0.7.0.md`、独立レッグ 2 本で突合） |
| 3f9e48e | docs: Retry-After の Date.parse 判定を「英字始まり」に表現統一（README / ADR 0010 §2 — リリースノート突合レッグの refuted 1 件） | 1-24 の検証で判明 |

未処理（ROADMAP へ）: 2 の根治（`fetchHfFiles` 並行度上限）/ 2(b) opt-in jitter / 3(b)(c) /
G3-04 / G3-05 / G4-02 / G2-08 / G2-04 / G2-05 / G1-09 / G3-06 / G3-07 / G1-05 ①②⑤ / G4-07。
