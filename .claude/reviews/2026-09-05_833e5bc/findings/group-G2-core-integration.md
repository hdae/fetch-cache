---
id: G2
topic: cache 層への統合（src/core.ts の差分と周辺・src/mod.ts）
files_reviewed:
  - src/core.ts
  - src/mod.ts
  - src/mod.test.ts（凍結内容の確認のみ）
  - src/retry.ts / src/hf/mod.ts（呼び出し関係の確認のみ・担当外）
date: 2026-09-05
model: opus
---

# G2 — cache 層への統合

## 総評

再試行（`fetchWithRetry`）と受信上限（`maxBytes`）の cache 層への差し込みは、既存の不変条件を
壊していない。\
確認できた事実は 4 つ。①`readBody` の引数追加で既存 2 呼び出し点の位置引数はずれていない
（v0.6.0 と突合済み）②内部導管の型（`FetchBytesWithKeyOptions` /
`PrefetchUrlWithKeyOptions`）も `RetryOutcome` も公開面に漏れていない ③エラー文言の先頭は
すべて不変で、保険 delete の `" SHA-256 不一致"`（先頭空白込み）も v0.6.0 と 1 文字違わない
④上限判定は `into` の容量検査より先に走り、超過チャンクを器へ書く前に打ち切る。\
一方で、既定 ON になった再試行の**待機設計**に 2 件の設計上の穴がある。既定の待機上限が無い
ことと、待機に jitter（ばらつき）が無いことで、ADR 0010 が動機に挙げた「数十本の shard が
Hub の 429 を踏む」場面でこそ効きが悪くなる。どちらもコードは仕様どおりで、判断はオーナー
案件（要判断 1・2）。

件数: 🔴 0 / 🟠 0 / 🟡 2 / 🔵 9（うち 3 件は文書のみ）

なお当初「leader の `maxBytes` が合流者の成功を奪う」を疑ったが、**撤回する** —
`acquireAndDecode` は共有の**前**に leader 自身の `checkAndDecode`（= `buildValidate` の
長さ厳密一致）を通す（core.ts:816）ので、超過応答は v0.6.0 でも leader の validate が
フライトごと落としていた。上限が変えるのは打ち切り時刻とエラー文言だけで、合流者の成否は
変わらない。ADR 0011 の「失敗の内容は変わらず、時刻だけが早くなる」は `fetchHfFile` 経路
については正しい（`prefetchHfFile` の 1 ケースだけ例外 — G2-11）。

## ファイル別分類

| ファイル | 判定 | 理由 |
| --- | --- | --- |
| src/core.ts | 🟡 Warning | 統合そのものは健全（引数ずれ無し・文言互換・上限判定の順序も意図どおり）。既定 ON の再試行に待機上限と jitter が無い点だけが設計判断として残る（G2-01 / G2-02）。他は文言組み立て・進捗発火・引数個数の小粒 |
| src/mod.ts | 🟢 Safe | 追加は `export type { RetryContext, RetryPolicy }` の 1 行と `@module` の 2 文のみ。内部型（`*WithKeyOptions` / `RetryOutcome`）は再公開されておらず、`maxBytes` は公開オプションから到達不能 |
| src/mod.test.ts | 🔵 Low | 上限超過時の保険 delete 文言（`prefetch の受信バイト上限の超過に加え`）を凍結しているのはこのファイルだけで妥当。`retry` の既定 ON に伴う fixture 差し替え（503 → 500）も意図が注記付きで残っている |

## 詳細指摘

### 🟡 G2-01 — 既定 ON の再試行に既定の待機上限が無い（汎用層でも最長 ~24.8 日待つ）

**再試行の既定に待機上限（`maxDelayMs`）を置きますか。それとも README の推奨に留めますか。**

**概要**\
`retry` は省略時に有効で（core.ts:788-794 / 1218-1224）、`maxDelayMs` を渡さない限り
`Retry-After` の指示どおり待つ（retry.ts:169-172）。上限は `setTimeout` が扱える
`2**31 - 1` ms（≒24.8 日）だけで、これは「守れない待機は再試行しない」ためのガードであって
待機時間の上限ではない（retry.ts:175）。\
つまり `Retry-After: 2000000`（約 23 日）を返す応答 1 つで、素の
`await fetchBytes(url)` が 23 日間解決しない。その間このフライトは `inflight` に載ったまま
なので同一キーの後続呼び出しは全員合流して一緒に待ち、`into` を使っていれば
`buffersInUse` にバッファを握り続ける（core.ts:1060-1065）。`init.signal` を渡していない
呼び出しには中断手段が無い（retry.ts:83-86 の signal なし経路は `setTimeout` のみ）。\
守っている目的は正しい — ADR 0010 §2 の「長い待機ほど『その時間待たなければ通らない』を
意味するので勝手に短く切らない」は Hub のような協調的なサーバに対しては妥当な判断。\
食い違うのは**適用範囲**で、`fetchBytes` / `prefetchUrl` は任意 origin に対する汎用 API
であり、根拠に挙げた「Hub の指示」が成り立たない相手（設定ミスのリバースプロキシ、
悪意ある origin、`Retry-After` を秒ではなく分で書いたサーバ）にもこの既定が適用される。
v0.6.0 では同じ応答が即 throw だったので、ブラウザのタブが週単位で pending の promise を
抱える経路は存在しなかった。

**選択肢**

- a) ★ 既定 `maxDelayMs` を置く（例 60_000）。`Retry-After` がそれを超えるときは
  「切り詰めて再試行」ではなく現在の `MAX_TIMER_MS` 超過と同じ扱い（再試行せず応答を返す）
  にすると、「短く切って打ち直すのは呼び出し側の明示的選択」という ADR 0010 §2 の筋を保った
  まま、既定の最悪待機が有限になる。
- b) 待機の**累計**に上限を置く（例: 合計 120 秒を超える再試行はしない）。1 回ごとの指示は
  尊重しつつ全体の停止時間を縛れるが、`RetryPolicy` に概念が 1 つ増える。
- c) 現状維持 + README / limitations に「公開 origin 以外へ向けるときは `maxDelayMs` を
  渡すこと」を明記する。コード変更ゼロだが、既定の危険は既定のまま残る。

**リスク**\
a) は挙動変更（`Retry-After: 300` の 429 が現在は 5 分待って成功するが、既定 60 秒では
再試行せず throw になる）。Hub の rate limit で分単位の指示が来る運用があるなら既定値の
選定に実測が要る。c) はリリース済み API の既定を据え置くので互換リスクゼロ。

**対象**\
src/core.ts:788-794（`fetchBytes` の呼び出し点）/ src/core.ts:1218-1224（`prefetchUrl` の
呼び出し点）/ src/retry.ts:169-175（待機の算出と上限）/ docs/decisions/0010 §2

**影響範囲**\
`retry` を明示していない全呼び出し（= 既定の全経路）。HF 層は `HfFetchOptions.retry` /
`HfPrefetchOptions.retry` からそのまま透過するので同じ。

**引き継ぎ**\
a) を採るなら `retry.ts` の `DEFAULT_MAX_DELAY_MS` を足し、`maxDelayMs` 未指定時に
`Math.min(..., DEFAULT_MAX_DELAY_MS)` ではなく「既定上限を超える指示は
`return { response, retries: attempt }`」に倒す（`maxDelayMs` を明示したときだけ切り詰めて
再試行、という §2 の非対称をそのまま保つため）。ADR 0010 §2 に「既定の上限を置かない」と
書いてあるので ADR 側の追記が必須。

### 🟡 G2-02 — 待機に jitter が無く、並列取得が同時に目覚めて 429 を再生産する

**再試行の待機にばらつき（jitter）を入れますか。**

**概要**\
待機は `Retry-After` の値、無ければ `baseDelayMs * 2 ** attempt` で、乱数成分が無い
（retry.ts:169-172）。同じ相手へ並列に出ている N 本の要求は、同じヘッダ値／同じ
バックオフ列を得るので**同時刻に一斉に目覚める**。\
発生条件はこのライブラリの主用途そのもの。`fetchHfFiles` は全 spec を `Promise.all` で
並列取得し（hf/mod.ts:480-484）、`prefetchUrl` は single-flight の対象外なので同一 URL でも
合流しない（core.ts の prefetch 節・limitations.md:113-116）。ADR 0010 の Context が
挙げる「1 モデルの読み込みが数十本の要求になる」状況で 429 を踏むと、30 本が 1 秒後に
同時再送 → また 429 → 2 秒後に同時再送、と rate limit を自分で再生産する。既定
`maxRetries: 5` なら 1 モデルあたり最大 180 要求が同期して届く。\
守っている目的は「サーバの指示どおり待つ」で、これは正しい。欠けているのは
「同時に来ないようにする」側で、rate limit 対策としては両輪。

**選択肢**

- a) ★ バックオフ側にだけ full jitter を入れる（`delay = random() * baseDelayMs * 2**attempt`）。
  `Retry-After` の指示は変えない（指示より早く打つことになるため）。標準的な作法で、
  ヘッダ無しの 503 群には確実に効く。
- b) `Retry-After` にも小さな上振れ jitter を足す（`delay + random() * baseDelayMs`）。指示
  より遅く待つだけなので指示違反にならず、Hub の 429（`Retry-After` 付き）にも効く。
  a) と併用可。
- c) 現状維持。呼び出し側が `maxRetries` を絞るか並列度を落とすことで回避する、と
  limitations に書く。

**リスク**\
a) / b) とも待機が非決定的になる。既存の `retry.test.ts` は待機時間を固定値で見ている箇所が
あるため、アサーションを範囲へ緩めると「待機が正しく計算されている」ことの凍結が弱くなる。
jitter を `fetchWithRetry` の内部引数（既定 `Math.random`）として注入可能にし、テストでは
恒等な関数を渡す方が既存アサーションを 1 つも書き換えずに済む。

**対象**\
src/retry.ts:169-172（待機の算出）/ src/core.ts:1218-1224（single-flight 外の prefetch
呼び出し点）/ src/hf/mod.ts:480-484（`fetchHfFiles` の並列 fan-out）/ docs/decisions/0010 §2

**影響範囲**\
並列取得を行う全経路（`fetchHfFiles`・複数 `prefetchHfFile`・呼び出し側の並列
`fetchBytes`）。単発呼び出しには影響しない。

**引き継ぎ**\
実装は `fetchWithRetry` 内 1 行だが、「依存ゼロ MUST」の観点では `Math.random()` は Web 標準
なので問題ない。決定的テストのために `RetryPolicy` に公開オプションを増やすのは避け、
`fetchWithRetry` の引数（内部シグネチャ）に jitter 関数を足す方向が公開面を汚さない。

## 🔵 Low（改善提案・文書）

| ID | 内容 | 対象 |
| --- | --- | --- |
| G2-03 | null-body 経路は上限超過の**直前**に `onProgress` を発火する（stream 経路は超過チャンクを通知しない）。進捗表示が上限超えの値を 1 回受け取ってから throw する非対称。順序を入れ替えれば揃う | core.ts:471-475 / 1263-1268 |
| G2-04 | 保険 delete の文言を `label` の先頭空白（`" SHA-256 不一致"`）で組んでいる。既存文言の凍結という意図は正しくコメントもあるが、3 つ目の事由を足す実装者が空白要否を間違えやすい。`label` を「`の` の後に続く完全な句」として持たせるか、テンプレートを事由ごとに持つ方が安全 | core.ts:1250 / 1311 / 1340 |
| G2-05 | `readBody` の位置引数が 7 個になり、`maxBytes` を渡すために `intoSource: "network"` を明示させられている（既定値と同じ値の明示）。追加のたびに呼び出し点が長くなり、`expectedBytes` / `maxBytes` は同じ `number \| undefined` なので取り違えを型で防げない。options オブジェクト化の候補 | core.ts:427-435 / 805-813 |
| G2-06 | HTTP エラー文言に `（再試行 N 回の後）` が付く。先頭一致は不変（ADR 0010 §4 で意図済み）だが、完全一致や `$` 終端の正規表現で照合している下流は壊れる。リリースノートに 1 行必要 | core.ts:800-803 / 1229-1232 |
| G2-07 | `RetryPolicy` の値が無検査。`baseDelayMs: NaN` は `delayMs` を NaN にし、`NaN > MAX_TIMER_MS` が false なので**待たずに 5 連打**する。`maxRetries: -1` は黙って無効化。`sha256` / `expectedBytes` を形式で弾く fail loud 規約と非対称（G1 と重複する可能性あり） | retry.ts:157-175 |
| G2-08 | 内部導管の `maxBytes` は cache 層では無検査で、正当性は HF 層 `toSpec` の形式検査（hf/mod.ts:327-335）に依存している。負値なら全応答が「申告 -1 バイトを超えた」で落ちる。境界で `Number.isSafeInteger(maxBytes) && maxBytes >= 0` を assert しておくと、導管の利用者が増えたときに壊れない | core.ts:210-220 / 1109-1116 |
| G2-09 | 合流者は leader の `init.signal` による abort 理由をそのまま受け取る（core.ts:968 で `shared.reject`）。既存挙動だが、再試行で待機窓が最大数日に伸びたので「身に覚えのない `AbortError`」を踏む確率が上がった。limitations の合流者項に 1 行（合流者は leader の中断にも巻き込まれる）が要る | core.ts:788-794 / 968 / retry.ts:185 |
| G2-10 | self-heal（破損ヒット → `cache.delete` → network 再取得）の再取得も再試行を通る（core.ts:775-780 → 788）。仕様どおりだが、**evict 済みで再取得中**の状態が数十秒〜数日続きうる点は v0.6.0 と違う（当時はフライト 1 回ぶん）。他タブ・他プロセスの読み出しはその間 miss になる。limitations の再試行項に 1 行 | core.ts:775-780 / 788-794 |
| G2-11 | ADR 0011 Consequences の「失敗の内容は変わらず、時刻だけが早くなる」は `prefetchHfFile` の **sha256 無し + `expectedBytes` 宣言**のケースには当てはまらない。従来は超過応答をそのまま格納して `fetched: true` を返していた（読み出し時の self-heal 待ち）が、現在は throw する。limitations.md:102-106 には書かれているので、ADR 側 Consequences の 1 行修正で足りる | core.ts:1286-1293 |

## 重要な経路（実コード行番号付き）

### `fetchBytes` の network 経路（再試行 + 受信上限）

```
fetchBytesWithKey (core.ts:983)
  ├ method ガード (993)              cache 有効 + 非 GET → throw
  ├ sha256 形式 / crypto.subtle (1016)
  ├ expectedBytes > into.length (1033) → IntoCapacityError
  │    ↑ HF は expectedBytes == maxBytes を渡すので maxBytes <= into.length が入口で確定
  ├ buffersInUse.add(into.buffer) (1060)   ← 再試行の待機中もここを握り続ける（G2-01）
  └ runFlight (875)
       ├ cache:false → acquireAndDecode 直行 (882)
       ├ inflight 合流 (899-923)     合流者は leader の再試行を待つだけ
       │                             （合流者の retry / onRetry / maxBytes は不使用）
       └ leader (927-974)
            └ acquireAndDecode (681)
                 ├ cache.open / match / 鮮度判定 (696-771)   ← 再試行は絡まない
                 ├ self-heal delete (775-780)                ← 消してから下へ落ちる（G2-10）
                 ├ fetchWithRetry (788)  429/503 → Retry-After 待ち → 再要求
                 │     └ 非 ok で確定 (795) → body.cancel → HTTP {status} … （再試行 N 回の後）
                 └ readBody (805, maxBytes = opts.maxBytes)
                      while (490)
                        ├ [1] maxBytes 超過 (495) → reader.cancel → 受信が申告 N バイトを超えた
                        ├ [2] into/buffer 容量 (506)  ← [1] の後（ADR 0011 の MUST）
                        └ [3] buffer.set / chunks.push (521-524) → onProgress (526)
```

判定順 [1] → [2] → [3] が要点。超過チャンクは器へ書かれず、進捗も発火しない。
HF のテスト（`supplied() === 2`）が「3 チャンク目を要求しない」ことを凍結している。

### `prefetchUrl` の通過中経路（上限 → put → 保険 delete）

```
prefetchUrlWithKey (core.ts:1159)
  ├ 非 GET → throw (1169)
  ├ 既存エントリ検査 (1205-1214)   sha256 未指定 + エントリ有り → false（network に出ない）
  ├ fetchWithRetry (1218) → 非 ok (1225) → HTTP … （再試行 N 回の後）
  └ body の有無で分岐
       ├ null 経路 (1260):  emit (1263) → maxBytes 判定 (1266) → hasher (1269) → put
       │                    ※ この順なので上限超えの loaded が 1 回通知される（G2-03）
       └ stream 経路 (1280): TransformStream
              transform (1282)
                loaded += len (1283)
                ├ maxBytes 超過 (1286) → streamFailure{label:"受信バイト上限の超過"}
                │                        controller.error → return
                │                        （enqueue も hasher.update も emit も走らない）
                │                        → flush は呼ばれない = SHA 不一致より優先
                └ 通常: chunk.slice → hasher.update → emit → enqueue (1299-1304)
              flush (1306): sha256 不一致 → streamFailure{label:" SHA-256 不一致"}
       ↓
  cache.put (1320)
    ├ reject → streamFailure があればそれを投げる (1324)  ← 汎用「書込みに失敗」に化けない
    └ resolve（error を無視する実装）→ 保険 delete (1334)
          └ delete も失敗 → AggregateError「prefetch の{label}に加え、…」(1338-1341)
```

`" SHA-256 不一致"` の先頭空白がここで効いて v0.6.0 と同一文言になる（mod.test.ts で凍結）。
上限側は `prefetch の受信バイト上限の超過に加え` で、こちらも新規テストで凍結済み。

## 横断所見

- **公開面の漏れは無い**。`FetchBytesWithKeyOptions` / `PrefetchUrlWithKeyOptions` は
  core.ts でのみ `export` され、mod.ts（32-54 行）にも hf/mod.ts（39-46 行）にも現れない。
  core.ts 自体が deno.json の `exports` に無いのでパッケージ利用者から到達不能。
  `RetryOutcome` も同様に非公開で、公開されたのは `RetryContext` / `RetryPolicy` の 2 型のみ
  （mod.ts:54 と hf/mod.ts:39-46 が同じ `src/retry.ts` を指すので両エントリで同一型）。
- **位置引数のずれは無い**。`readBody` の呼び出しは 2 か所だけで（726 / 805）、v0.6.0 の
  同じ 2 か所と並びが一致する。cache 経路は `maxBytes` を渡さない（ADR 0011 §2 の
  「キャッシュヒット側は変えない」どおり）。
- **文言の後方互換**。v0.6.0 から変わったのは①HTTP エラーの末尾に付く
  `（再試行 N 回の後）`（0 回なら空文字なので完全一致）②保険 delete の AggregateError の
  事由部分（sha256 側は 1 文字も変わらない）の 2 つだけ。`exceededMaxBytes` は新規文言で、
  stream 経路は「以上」付き（下限報告）、null-body 経路は「以上」無し（実長）。
- **縮退契約（ADR 0001）との干渉は無い**。再試行は `fetchWithRetry` の中で完結し、
  `onCacheError` を呼ぶ 4 経路（open/match/put/delete）とは交差しない。cache ヒットで
  決着する呼び出しは再試行に一切触れない。
- **`maxBytes` が合流者へ効かないことは実害無し**（当初の疑いを撤回）。leader の
  `checkAndDecode`（core.ts:816）が共有前に走り、`buildValidate` の長さ厳密一致が
  フライトごと落とすため、上限の有無で合流者の成否は変わらない。
- **前回 ROADMAP との関係**。G2-04(b)（leader `into` × 合流者のコピー削減）と 2(a)（使用中
  バッファ台帳の緩和）はいずれも未着手のまま、今回の差分は抵触も解消もしていない。ただし
  台帳を握る時間が再試行ぶん延びる（G2-01）ので、2(a) を将来入れるときの前提は少し変わる。
