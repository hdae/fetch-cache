# 0012 — 温め済みエントリの区間読み（`openCachedUrl` / `openHfFile`）

- 日付: 2026-09-07
- 状態: 採用
- 関連: [0001](0001-cache-io-degrade-with-notification.md)（cache I/O 失敗の縮退と通知）/
  [0006](0006-cache-control-redesign.md)（記録ハッシュ・キー規則）/
  [0008](0008-remove-public-key-and-backfill-record.md)（記録の backfill・内部導管）/
  [0009](0009-into-caller-buffer.md)（呼び出し側バッファ。読み出しの RAM を削る先行策）

## Context

下流（WebGPU 推論スタック）の埋め込み表は、層ごとの表を token 順（token-major）に並べた
safetensors で、253 MB × 9 本の shard に分かれて配布されている。decode は 1 token 進むごとに
その token の**1 行だけ**（8,960 バイト + スケール 140 バイト）を読む。

`fetchBytes` はキャッシュヒットしたエントリを常に全量読み出す（`cached.arrayBuffer()`、
`into` 指定時は body を器へ流し切る）ため、1 行の読みに 253 MB の読み出しが要る。実測は
Chrome 152 / macOS で 117 ms、Linux で 300 ms。加えて 253 MB の Blob / バッファが毎回
LRU を押し出すため追い出し連鎖が起き、自然文 400 token の生成では 137 回・合計およそ 42 秒が
読み出しに消えた。

読み出し側で回避する手は無い。Range 要求は効かず（Chrome 152 実測: `cache.match` は
`Range` ヘッダ付き Request を渡しても **200 で全量**を返す。`Accept-Ranges` の有無に依らない）、
呼び出し側が `caches` を直接読めばキー規則の複製と記録ハッシュ検査の素通りになる
（ADR 0009 Context と同じ理由で、この層の内側にしか置けない）。

区間だけを読む手段は**ランタイムで性格が違う**（2026-09-07 実測。対象は上記と同じ 253 MB の
shard エントリ 1 本 — Deno 列の「256 MiB」も同じ規模の実測値）:

| 操作                                      | Chrome 152                       | Deno 2.9                                         |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------ |
| `cache.match(url)` → `response.blob()`    | 0.2〜0.9 ms（遅延ハンドル）      | 全量読み込み（256 MiB で 326 ms・RSS +517 MiB）  |
| `blob.slice(offset, +8960).arrayBuffer()` | 0.1〜0.3 ms                      | 0.05 ms（materialize 済みなので当然）            |
| body stream の offset までの読み飛ばし    | 1〜99 ms（offset に比例）        | 17 / 51 / 76 ms（offset 1 MB / 128 MB / 256 MB） |
| 全量 `arrayBuffer()`                      | 117 ms（macOS）/ 300 ms（Linux） | 131 ms                                           |

ブラウザの `Blob` はディスク上のエントリへの遅延ハンドルなので区間読みが定数時間で済む。
Deno の `blob()` は全量をヒープへ載せるので、同じ手が最悪手になる。

## Decision

### 1. 「開く」と「読む」を分ける新 API を足す（`fetchBytes` は変えない）

```ts
const entry = await openCachedUrl(url, { sha256 }); // 無ければ undefined
if (entry === undefined) throw new Error("not cached");
const row = await entry.read(offset, 8960); // length ちょうど / 足りなければ throw
```

- 戻り値は `CachedEntry | undefined` = `{ read, strategy }`。`read` は毎回**新しい**
  `Uint8Array` を返す（`length` ちょうど。短い戻りは fail loud）。
- **network には出ない**。`undefined` は「キャッシュに無い」であって「取ってくる」ではない。
  温めるのは呼び出し側の責任（`fetchBytes` / `prefetchUrl`）— この API を fetch にすると
  「1 行読むつもりが 253 MB のダウンロードだった」が起こりうる。
- 実装は `src/core.ts` に置き、配列キーの注入導管 `openCachedUrlWithKey` は
  `fetchBytesWithKey` / `prefetchUrlWithKey` と同じ扱い（HF 層とテスト専用 — ADR 0008 §1）。

### 2. 戦略は 2 つ。既定はランタイムで選び、`strategy` で強制できる

- **"blob"**: 開く時に `cache.match` → `response.blob()` を 1 回だけ取り、`read` は
  `blob.slice(offset, offset + length).arrayBuffer()`。
- **"stream"**: `read` の度に `cache.match` → `body.getReader()` で offset まで読み飛ばし、
  length ぶん集めたら `cancel()`。開きっぱなしの reader は前方にしか進めない（offset を
  戻せない）ので毎回開き直す。
- 既定は `globalThis.Deno` があれば "stream"、無ければ "blob" — 上の表がそのまま根拠。
  `strategy` を戻り値に出すのは、どちらで読んでいるかが性能特性を決めるため（診断用）。
  2 値以外の `strategy` は入口で throw する（`sha256` の形式検査と同じ扱い）— 黙って既定へ
  落とすと「"blob" のつもりが "stream"」が性能差としてしか現れず、原因に辿り着けない。
- `options.signal` は "stream" の読み飛ばし（チャンクの切れ目）で見る。中断すると
  `reader.cancel()` して `signal.reason` で reject する。読み飛ばしが offset に比例して
  長くなるランタイムでのみ意味があるので、"blob" では呼び出し時に 1 回見るだけ。

### 3. 検証は記録ハッシュの文字列比較だけ。全量の検証は `fetchBytes` の責務

`sha256` を渡したときの判定は `fetchBytes` のヒットと同じ **`x-fetch-cache-sha256` との文字列
比較**で、バイト列は読まない（区間読みで実ハッシュは計算できない）。

| 状態                        | 挙動                                                     |
| --------------------------- | -------------------------------------------------------- |
| 記録あり・期待と一致        | 開く                                                     |
| 記録あり・期待と不一致      | 内容が変わったものとして self-heal（evict）→ `undefined` |
| 記録なし・`sha256` 指定あり | **`undefined`**（evict はしない）                        |
| `sha256` 指定なし           | 記録の有無に依らず開く（検証なしの生読み）               |

記録なしを `undefined` にするのは、実ハッシュを計算できない以上「検証済み」を名乗れないため。
evict しないのは中身が正しい可能性が十分にあるからで、先に `fetchBytes` を 1 回通せば実ハッシュ
突合 → backfill（ADR 0008 §2）で記録が付き、以後はここで開ける。

`validate` / `decode` / `recheck` / `into` は**持たない**:

- `validate` / `recheck` は全量を前提にした検査で、区間読みでは走らせようがない。
- `decode` は「保存形 → 利用形」の変換であり、区間読みが相手にするのは保存形 raw だけ
  （解凍後のバイト列に対する offset は保存形の offset と一致しない）。
- `into` は「呼び出し毎の確保をゼロにする」ための口（ADR 0009）。区間読みが確保するのは
  1 行ぶん（数 KB）で、削る対象が無い。

### 4. cache I/O 失敗は open と read で扱いが割れる

開く時（`cacheStorage.open` / `cache.match` / "blob" の `blob()`）の失敗は miss と同じ
`undefined` へ縮退し、`onCacheError` で通知する（ADR 0001 の縮退と同型 — 呼び出し側は
`fetchBytes` へ落ちればよい）。ただし**既定フックの文言は取得系と分ける**: この API は
network に出る口を持たず、縮退先は「エントリ無し」なので、ADR 0001 の「network へ縮退します」
をそのまま出すと縮退先を偽ることになる。`read` 中の失敗は縮退先が無い（呼び出し側は既に
「開けた」と思っている）のでそのまま throw する。範囲外（`offset + length` が本文長を超える）も
throw で、本文長は "blob" なら `blob.size`、"stream" なら末尾到達時の消費バイト数で判定する。
"stream" はバッファの確保が本文長の判定より先に来るため、**確保できない `length` も範囲外
として同じ文言で落とす**（素通しすると実行環境の RangeError がそのまま漏れ、"blob" と
食い違う）。

通知の `op` は失敗点の識別子で、観測できるのは **3 種**: `cacheStorage.open` の失敗が
"open"、`cache.match` の失敗と "blob" の `blob()` の失敗が "match"、記録ハッシュ不一致の
self-heal で `cache.delete` に失敗した場合が "delete"。`blob()` の失敗を "match" にまとめる
のは、それが match 済み応答の本文取得であり縮退の扱いも同じだからで、
`CacheErrorContext["op"]` に `"blob"` を足すと公開 union の拡張（網羅 switch を書いた下流を
壊す breaking）になる。self-heal の delete が失敗しても縮退先は変わらない（`undefined`）—
消せなかったことを黙らせないための通知で、次の `fetchBytes` が取り直せばそこで上書きされる。

"stream" のバッファ確保は `cache.match` より**前**に置く。後ろに置くと、確保に失敗したときに
match 済みの body を解放しないまま抜けて Cache のファイルハンドルが残る（確保できない
`length` はどの本文にも収まらない要求なので、資源を 1 つも取らずに範囲外で落とすのが正しい。
実行環境の生の `RangeError` は `cause` に残す — 診断用）。

"stream" は `read` の度に `match` し直すので、**開いた時点の照合は次の `read` には効かない**。
`sha256` を渡して開いた場合は記録ハッシュも `read` ごとに再照合し、開いた時点と食い違えば
body を cancel して throw する（並行する `fetchBytes` の self-heal が同じキーへ別内容を書く
経路があり、区間読みは実ハッシュを計算できないので下流では検出できない — エントリが消えた
場合と同じ fail loud に揃える。"blob" は開いた時点の Blob を持つので元から差し替えの影響を
受けない）。

"stream" は `response.body` を要求する。Cache 応答が body を持たないランタイムでは、中身の
あるエントリも「本文 0 バイト」と判定されて範囲外で落ちるので、そこでは "blob" を使う
（既定はブラウザ側が "blob" なので、該当するのは "stream" を明示した呼び出しだけ）。

### 5. HF 層は内容キー専用 — `sha256` 無しは throw

`openHfFile(ref, file, opts)` は `spec.sha256` があるときだけ開ける。無い spec のキーは
revision 入りの resolve URL で、その revision を解決するには network が要る — §1 の「この API は
network に出ない」を破るので、**黙って解決せず throw する**。`sha256` があれば内容キー
`["hf", kind, repo, path, sha256]` は revision 非依存で、`ref.revision` は**解決しない** —
キーにも入らず読み出し先も変えず、エラー文言と `onCacheError` の `url` に出す表示用のラベル
URL（`.../resolve/<revision>/<path>`。省略時は "main" のまま）にだけ現れる。その URL は
取得元でも保存キーでもないので、開いたエントリを消すのは `evictUrl(そのラベル URL)` ではなく
`evict(["hf", kind, repo, path, sha256])`。

## Consequences

- **非 breaking**（新規 API の追加のみ）。既存の呼び出しは 1 行も影響を受けない。
- 下流の decode ループは「1 token = 1 行の読み」になり、全量読みと LRU の追い出し連鎖が消える。
  ただし **Deno（"stream"）では読み飛ばしのコストが offset に比例して残る** — shard 末尾の行は
  先頭の行より高い。定数時間の区間読みはブラウザの遅延 Blob に依存した性質であって、Web 標準の
  保証ではない（`Range` は Cache API に効かないことが Chrome 152 で実測済み）。
- 開いたハンドルはエントリのスナップショットではない。"stream" は `read` の度に `match` し直す
  ので、並行する `evictUrl` / `evict` / self-heal でエントリが消えれば次の `read` が throw
  する。`sha256` を渡して開いた場合は記録ハッシュも `read` ごとに再照合するので、消えずに
  **差し替わった**（同じキーへ別内容が書かれた）場合も同じく throw する。
  **`clearCache` だけはランタイム依存** — 名前空間ごと消しても保持中の `Cache` オブジェクトが
  生き続けるかは実装次第で、Deno 2.9 は以後の `match` が `undefined` になる（＝ throw）が、
  ブラウザは未実測。"blob" は開いた時点の Blob を持ち続けるので、どの経路で消えても
  読み続けられる（どちらの挙動も Cache 実装の性質そのままで、この層は隠さない）。
- 「区間読みは検証しない」という穴が新設される。記録ハッシュは保存時の全量に対する主張であり、
  区間読みはそれを引き継ぐだけで、読んだ区間そのものは照合できない。疑う運用は `fetchBytes`
  （`recheck`）で全量を読み直す — docs/limitations.md に明記する。
- 検証系オプションを持たないぶん、この API は `fetchBytes` の置き換えにはならない。用途は
  「温め済みの巨大エントリから小さな区間を何度も引く」だけで、全量が要るなら `fetchBytes` が
  正しい（README の使い分けもその形で書く）。
