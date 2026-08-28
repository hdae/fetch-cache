# レビュー: テスト品質（ffc8bef「キャッシュ制御 API 再設計」/ v0.4.0..HEAD）

対象: `src/mod.test.ts`（85 本登録・うち 1 本 ignored）と `src/hf/mod.test.ts`（42 本登録）。
読み取り専用レビュー（コード変更なし）。照合元は `docs/decisions/0006-cache-control-redesign.md`
と `docs/decisions/0007-explicit-expected-bytes-fail-loud.md`、実装は `src/mod.ts` / `src/hf/mod.ts`。

実測（このレビュー中に実行、Deno 2.9.4）:

- `deno test --allow-read` → `139 passed | 0 failed | 1 ignored`（内訳は登録数で
  mod 85 / hf 42 / sha256 6 / scripts/release_tag 6 / scripts/version_sync 1）。
- `deno test --allow-read --parallel` → **完走しない**（TS-001。フルスイートでは
  `src/hf/mod.test.ts:443` が pending のまま無限ハング、mod+hf の 2 ファイルだけなら
  `112 passed | 14 failed`）。

分類別件数: 🔴 0 / 🟠 1 / 🟡 8 / 🔵 5 / 🟢 4。

---

## 指摘

### TS-001（🟠）: 固定名前空間の共有 + 無期限ポーリングで、並列実行すると「落ちる」ではなく「永久にハングする」

- **概要**: 0.5.0 で隔離規約が「テスト毎ユニーク cacheName」→「固定名前空間 `"fetch-cache"` を
  使い、テスト毎に `finally` で `caches.delete("fetch-cache")`」へ変わった（ADR 0006
  Consequences `docs/decisions/0006-cache-control-redesign.md:149-151`、
  `src/mod.test.ts:25-27` / `src/hf/mod.test.ts:17-18`）。両テストファイルが同じ固定名前空間を
  共有するため、隔離は「ファイル内逐次」ではなく **「ファイル**間**も逐次」** に依存している。
  ADR の但し書き（「ファイル内逐次実行が前提」）はこの前提を過小に書いている。
  さらに悪いことに、`src/hf/mod.test.ts:448-453` の同期待ちが**期限を持たない**:

  ```ts
  const awaitACached = async (): Promise<void> => {
    const cache = await caches.open(CACHE_NAME);
    while ((await cache.match(urlA)) === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  ```

  他ファイルの `caches.delete(CACHE_NAME)` が割り込むとこのループは永久に抜けず、テストは
  赤にならずスイートごと停止する（CI ならジョブのタイムアウトまで焼く）。
- **発生条件 / 実測**: `deno test --allow-read --parallel` を実行 → 7 分以上完了せず、SIGINT で
  `The following tests were pending: fetchHfFiles: 1 ファイルの失敗で全体が reject し、成功分の
  キャッシュは残る => ./src/hf/mod.test.ts:443:6` と報告された。`src/hf/mod.test.ts` 単独 +
  `--parallel` は `42 passed`（＝並列そのものではなくファイル間干渉が原因）。mod + hf の 2 ファイル
  並列では `112 passed | 14 failed`（例:
  `fetchBytes: ミスで fetch 1回、2回目はキャッシュヒットで fetch 0回`、
  `fetchHfFile: 破損キャッシュは sha256 で検知され再取得される（self-heal）`、
  `fetchHfFile: revision 切り替えで内容が違えば別エントリとして共存する（ピンポンしない）`）。
  タイミング次第で「大量赤」にも「無限ハング」にもなる。
- **修正案**（3 点。①は単独でも価値がある）:
  1. **ポーリングに deadline を付けて fail loud にする**（ハング → 明示失敗への変換）。
     `src/hf/mod.test.ts:448-453` を
     「`const deadline = performance.now() + 2000;` を持ち、超過したら
     `throw new Error("a.bin が期限内にキャッシュされなかった（前提が崩れている）")`」に変える。
     正常時の実測待ち時間は 1 ループ程度（テスト全体で 76ms 未満）なので 2 秒でも十分に緩い。
     これは実装ではなくテストの同期機構の修正なので「アサーションを緩める」には当たらない。
  2. **「`--parallel` を付けてはならない」を機械的に読める場所へ明記する**。現状の担保は
     `deno.json` の `check` タスクに `--parallel` が無いことだけで、根拠はテストファイル内の
     コメントにしかない。`deno.json` の `check` タスク近傍（もしくは CLAUDE.md の Commands 節）
     に「MUST NOT: `deno test --parallel`（固定名前空間 `fetch-cache` を全テストが共有するため）」
     を置き、ADR 0006 Consequences の文言も「ファイル間も逐次」へ直す。
  3. **共有面積を縮める（任意）**: `fetchBytes` / `prefetchUrl` / HF 層は `caches` を DI できるので、
     テスト用に「`open(name)` を per-test のユニーク名へ読み替える CacheStorage ラッパ」を
     `src/testing/` に足せば、取得系テストは名前空間を共有しなくなる。ただし
     `evict` / `listKeys` / `listCachedUrls` / `clearCache` / `evictUrl` は DI 口を持たない
     （`src/mod.ts:926-1043` はグローバル `caches` 直参照）ため、管理 API のテストは共有のまま
     残る＝並列化の完全な解にはならない。①②を先に、③は必要になったときで良い。
- **対象**: `src/hf/mod.test.ts:443-482`（特に 448-453）/ `src/mod.test.ts:25-27` /
  `deno.json`（`tasks.check`）/ `docs/decisions/0006-cache-control-redesign.md:149-151`
- **根拠**: 上記の実行結果（SIGINT の pending 報告・2 ファイル並列の 14 failed）。
  `src/mod.ts:172`（`DEFAULT_CACHE_NAME = "fetch-cache"` の固定）と
  `src/mod.ts:926-1043`（管理 API に `caches` DI が無いこと）。

### TS-002（🟡）: 「expectedBytes は content-length より優先される」テストは優先順位を判別できない（実質トートロジー）

- **概要**: `src/mod.test.ts:1270-1281` は `expectedBytes: 6` + `content-length: "3"` を与えて
  結果が `[1,2,3,4,5,6]` であることだけを見る。しかし **content-length が勝つ実装でも同じ結果に
  なる**: 事前確保が 3 バイトだと 2 チャンク目で申告超過 → 蓄積経路へ落ち
  （`src/mod.ts:325-335`）、`chunks = [buffer.subarray(0,3), 使い回しチャンク]` を最後に連結して
  やはり `[1,2,3,4,5,6]` を返す。このテストが落ちるのは「ヒントが一切効かない」場合だけで、
  それは既に `src/mod.test.ts:1209`（expectedBytes）と `1219`（content-length）が見ている。
  名前が主張する「優先順位」は 1 本も凍結されていない。
- **実測**: 実装をそのまま呼び、`expectedBytes` を渡さず `content-length: "3"` だけにした場合
  （＝優先順位が逆転した実装が通る経路）の戻り値は `[1,2,3,4,5,6]` で、現行アサーションと
  一致した（差が出ない＝判別不能）。
- **修正案**: 使い回しバッファの書き換えを **2 チャンク目の progress の後にもう一度**行ってから
  `close()` する（蓄積経路は参照を保持したまま最後に連結するので、この書き換えが結果に漏れる）。
  `fetchWithReusedChunks`（`src/mod.test.ts:1179-1203`）に「2 回目の progress を待って
  `reused.set([7,8,9])` してから close する」モードを足し、
  `expectedBytes: 6, contentLength: "3"` で `[1,2,3,4,5,6]` を期待する形にする。
  実測で判別性を確認済み: 同じ手順で `expectedBytes: 6` → `[1,2,3,4,5,6]` /
  `expectedBytes` 無し（content-length のみ）→ `[1,2,3,7,8,9]`。
- **対象**: `src/mod.test.ts:1270-1281`（＋ヘルパ `src/mod.test.ts:1179-1203`）
- **根拠**: `src/mod.ts:293-310`（`expectedBytes` 分岐と content-length 分岐）、
  `src/mod.ts:325-335`（申告超過時の蓄積経路引き継ぎ）、上記実測。

### TS-003（🟡）: 直列化の「可逆」（`listKeys` が要素の型ごと復元する）が凍結されていない

- **概要**: ADR 0006 §1 は単射だけでなく **可逆**（split → decode → `JSON.parse` で完全復元。
  `listKeys` が配列のまま返せる）を決定している（`docs/decisions/0006-cache-control-redesign.md:43-44`）。
  テスト側は単射性（`src/mod.test.ts:907-929`。`["a","b/c"]` / `["a/b","c"]` / `["1"]` / `[1]` /
  `[true]` / 非 ASCII を投入して「エントリ数が衝突しない」ことだけを確認）と、
  `listKeys` の復元（`src/mod.test.ts:1882` の `[["app","models","a"]]` 等）に分かれており、
  **文字列以外の要素・`/` 入り要素・非 ASCII が `listKeys` で往復するか**は 1 本も見ていない。
  `"1"`（文字列）と `1`（数値）が復元で取り違えられても、現行テストは全て緑のまま。
- **修正案**: 単射テストで投入している 7 種のキーをそのまま `listKeys()` で読み戻し、
  `JSON.stringify` でソートして厳密一致させる 1 本を足す（`keys()` 実装ランタイム限定なので
  `ignore: !runtimeHasCacheKeys` を付ける）。期待値はテスト側のリテラル配列そのもの。
  実測では Deno 2.9.4 の Cache API が `%22...%2522%22` 等の percent-encoding を保存するため
  この往復は現状成立する（＝これは回帰ガードであり、既存バグの摘発ではない）。
- **対象**: `src/mod.test.ts:907-929`（単射のみ）/ `src/mod.test.ts:1870-1887`（文字列のみ復元）
- **根拠**: `src/mod.ts:206-213`（`serializeKey`）、`src/mod.ts:216-226`（`deserializeKey`）、
  `docs/decisions/0006-cache-control-redesign.md:43-44`。

### TS-004（🟡）: 「記録が無いエントリは一致しても記録を書き足さない」が凍結されていない

- **概要**: ADR 0006 §2 は「記録が無いエントリは native digest で 1 回計算して突合する
  （**一致でも記録の書き足しはしない** — N バイトの再 put を要するため）」と明記している
  （`docs/decisions/0006-cache-control-redesign.md:71-73`）。対応する
  `src/mod.test.ts:1044-1063` は「network に出ない」ことしか見ておらず、ヒット後にエントリへ
  記録ヘッダが**付いていない**ことも `cache.put` が走らないことも確認していない。
  書き足す実装に変わっても（数 GB 級では毎ヒットで再 put という重大な性能退行）テストは緑。
- **修正案**: `src/mod.test.ts:1044-1063` のヒット直後に
  `assertEquals((await cache.match(URL_A))!.headers.get(SHA_HEADER), null)` を追加。
  併せて put 回数 0 を直接見るなら、`failingCacheStorage`（`src/mod.test.ts:38-64`）に
  「put を数えて実体へ委譲する」オーバーライドを渡して `putCalls === 0` を assert する
  （`caches` DI は `fetchBytes` にあるので追加 API は不要）。
- **対象**: `src/mod.test.ts:1044-1063`
- **根拠**: `src/mod.ts:515-536`（ヒット成功時は put 経路へ入らない）、
  `docs/decisions/0006-cache-control-redesign.md:71-73`。

### TS-005（🟡）: 旧ヘッダ `x-fetch-cache-verified` を読まないこと（0.5.0 の破壊的移行の中核）が凍結されていない

- **概要**: ADR 0006 Consequences は「旧ヘッダ `x-fetch-cache-verified` は読まない（記録なし扱い）」
  を breaking の一項目として明記している（`docs/decisions/0006-cache-control-redesign.md:142-144`）。
  実装は単に旧ヘッダを参照しないだけ（`src/mod.ts:359` の `SHA_HEADER` のみ）で、
  テストは 0 本。旧ヘッダを読む実装に戻る／互換のつもりで読み足す事故が起きても検出できない。
  これは性能ではなく**安全側の意味論**（旧印は「validate 全体の通過」を意味していたので、
  sha256 の記録として解釈すると未検証バイトを恒久的に信頼することになる）に関わる。
- **修正案**: `x-fetch-cache-verified: <BYTES_A_SHA256>` ヘッダ付き・中身は別物（`[9,9,9]`）の
  エントリを直接 put し、`fetchBytes(URL_A, { sha256: BYTES_A_SHA256, fetch })` が
  **self-heal して `BYTES_A` を返す**（＝旧ヘッダを記録として信じない）ことと network 1 回を
  assert する 1 本。`src/mod.test.ts:1012-1042`（新ヘッダで信頼する側）と対になる。
- **対象**: `src/mod.test.ts`（sha256 節、1012-1063 の近傍）
- **根拠**: `src/mod.ts:359`・`src/mod.ts:508`（読むのは `SHA_HEADER` のみ）、
  `docs/decisions/0006-cache-control-redesign.md:142-144`。

### TS-006（🟡）: `crypto.subtle` 不在の fail loud が未凍結（テスト可能であることは実測済み）

- **概要**: ADR 0006 §2 と JSDoc（`src/mod.ts:96`）は「crypto.subtle が無いランタイムでは throw」を
  決めており、実装は入口ガード `src/mod.ts:637-641` にある。テストは 0 本。sha256 の形式ガード
  （`src/mod.test.ts:1140-1153`）と同じ「network に出る前に落とす」入口ガードなのに、片方だけ
  凍結されている。
- **修正案**: `Object.getOwnPropertyDescriptor(globalThis, "crypto")` を退避し、
  `Object.defineProperty(globalThis, "crypto", { value: { subtle: undefined }, configurable: true })`
  で差し替えて `fetchBytes(URL_A, { sha256, fetch })` が
  `"crypto.subtle が利用できない"` で reject し `calls.length === 0` であることを確認、
  `finally` で descriptor を復元する 1 本。実測で `globalThis.crypto` は
  `configurable: true`（accessor descriptor）で、この手順が期待どおり
  `fetch-cache: crypto.subtle が利用できないため sha256 検証ができません (...)` を投げることを
  確認済み。既存の `spyDigest`（`src/hf/mod.test.ts:641-658`）と同じ「グローバル差し替え + finally 復元」
  の作法に揃う。
- **対象**: `src/mod.test.ts`（sha256 節）/ 実装 `src/mod.ts:637-641`
- **根拠**: 上記実測、`docs/decisions/0006-cache-control-redesign.md:61-62` および `src/mod.ts:96`。

### TS-007（🟡）: `Cache.keys()` 未実装ランタイムの fail loud が `listCachedUrls` だけ・しかも常時 ignored

- **概要**: ADR 0006 §3 は「`keys()` 未実装ランタイム（Deno 2.8 以前）では **`evict` / `listKeys` は**
  fail loud に throw する」と決めている（`docs/decisions/0006-cache-control-redesign.md:101-102`）。
  テストは `listCachedUrls` の 1 本だけ（`src/mod.test.ts:1854-1868`）で、しかも
  `ignore: runtimeHasCacheKeys` により Deno 2.9.4 では**必ず ignored**（これが「1 ignored」の正体）。
  新設の `evict` / `listKeys`（`src/mod.ts:986-998` / `1005-1024`、いずれも `requireKeys`
  `src/mod.ts:953-960` を通る）には 0 本。ADR が明文で決めた縮退禁止が、実行される形でも
  対応表としても埋まっていない。
- **修正案**: 二択をオーナー判断に上げる（どちらでも良いが放置は避ける）。
  (a) `evict(["x"])` / `listKeys()` について同じ `ignore: runtimeHasCacheKeys` ガードで 2 本足し、
  「決定 ⇔ テスト」を 1:1 にする（Deno 2.9+ では実行されないが、対応表としては埋まる。
  前提として名前空間が存在する状態を作ること — 名前空間が無いと `src/mod.ts:989`/`1008` の
  早期 return に吸われて throw まで届かない）。
  (b) Deno 2.9+ 前提（ADR 0006 §3 でオーナー確認済み）を根拠に 3 本とも撤去し、
  `docs/limitations.md` の記述へ一本化する。
- **対象**: `src/mod.test.ts:1854-1868`（唯一の ignored）/ 実装 `src/mod.ts:953-960, 986-998, 1005-1024`
- **根拠**: `deno test --allow-read` の実測（`1 ignored` は当該テスト）、
  `docs/decisions/0006-cache-control-redesign.md:101-102`。

### TS-008（🟡）: HF 既定キーが `hubUrl` を含まない（ミラー跨ぎで共有）ことと `kind` を含むことが未凍結

- **概要**: ADR 0006 §4 は「`hubUrl` はキーに含めない — 同一内容ならミラーを跨いでエントリと
  合流を共有するのは content-addressed の意図どおり」と明記している
  （`docs/decisions/0006-cache-control-redesign.md:111-112`）。実装は
  `src/hf/mod.ts:208-212` の `defaultKey` が `["hf", kind, repo, path, sha256]` を返す形。
  テストは revision 跨ぎ（`src/hf/mod.test.ts:269-285`）と内容違いの共存（287-313）は凍結しているが、
  **hubUrl 跨ぎ**（ミラー → 本家でヒット）は 0 本。同様に、キーに `kind` が入ること
  （`model` と `dataset` で repo/path/sha256 が同じでも衝突しない）も 0 本
  （テストヘルパ `contentKeyUrl`（`src/hf/mod.test.ts:42-43`）が `"model"` 固定なので、
  `kind` を落とす実装退行はヘルパごと素通しになる）。
- **修正案**: 2 本追加。
  (1) 同一 `spec = { path, sha256 }` で `hubUrl: "https://mirror.example"` → 既定 hub の順に
  `fetchHfFile` を呼び、2 回目が `calls.length` を増やさない（＝ミラー跨ぎヒット）ことを assert。
  (2) `kind: "dataset"` で取得したエントリが `keyUrl("hf","dataset",REPO,path,sha256)` 側に入り、
  `kind: "model"` の同一 repo/path/sha256 が**別エントリとして network に出る**ことを assert。
- **対象**: `src/hf/mod.test.ts:234-336`（既定キー節）/ 実装 `src/hf/mod.ts:208-212`
- **根拠**: `docs/decisions/0006-cache-control-redesign.md:109-112`、`src/hf/mod.ts:211`。

### TS-009（🟡）: `fetchBytes` の転送中断（body stream の error）が未凍結

- **概要**: 転送中断は `prefetchUrl` 側だけ凍結されている（`src/mod.test.ts:1436-1460`）。
  `fetchBytes` 側は `fetch` 自体の reject（`src/mod.test.ts:542-555`）はあるが、
  **body を読んでいる途中で stream が error になる**経路（数 GB のダウンロード中の回線断＝
  このライブラリの主用途で最も起きるやつ）は 1 本も無い。「部分バイト列をキャッシュに残さない」
  という契約は `src/mod.ts:548-567`（`readBody` 完了 → 検証 → 初めて `cache.put`）の順序に
  依存しており、順序が入れ替わる退行を検出できない。
- **修正案**: 1 チャンク enqueue 後に `controller.error(new Error("転送断"))` する Response を
  返す mock で `fetchBytes` が `"転送断"` で reject し、`cache.match(URL_A) === undefined`
  であることを assert する 1 本。実測で現行実装はこの通り（reject し、部分エントリ無し）。
- **対象**: `src/mod.test.ts`（fetchBytes 節、542-555 の近傍）
- **根拠**: `src/mod.ts:548-567`、上記実測。

### TS-010（🔵）: 真偽値へ潰すアサーションで失敗時の診断が落ちる

`assertEquals(<式>, true/false)` 形が 3 箇所ある: `src/mod.test.ts:437`
（`warns.some((w) => w.includes("onProgress"))`）、`src/mod.test.ts:1719`
（`error.message.includes("キャッシュ書込みに失敗") === false`）、`src/hf/mod.test.ts:679`
（`digest.args[0] === seenByValidate[0]`）。落ちたときに `false !== true` としか出ない。
それぞれ `assertStringIncludes` / `assertStrictEquals` へ置き換えれば実際の値が出る
（検証内容は等価なので挙動は変わらない）。

### TS-011（🔵）: `uniqueCacheName` の doc コメントが旧隔離規約のまま

`src/testing/mock_fetch.ts:45-47` の「テスト毎にユニークな cacheName（後始末は各テストが
`caches.delete` で行う）」は 0.5.0 で廃れた規約の記述。現在の唯一の用途は
`src/mod.test.ts:106-111` の `Cache.keys()` feature probe。コメントを実態
（「feature probe 用の使い捨て名前空間名」）へ寄せるか、probe 側へインライン化するのが素直。

### TS-012（🔵）: ADR 0007 の「`cause` に元の `RangeError` を残す」が未検証

`src/mod.test.ts:1346-1373` はメッセージ（要求サイズ・`ArrayBuffer`・URL）・未受信
（`pulled() === 0`）・body 解放・非キャッシュまで丁寧に見ているが、
`docs/decisions/0007-explicit-expected-bytes-fail-loud.md:30-32` が決めた
`cause` の保存（`src/mod.ts:303`）だけ抜けている。`assertEquals((error.cause as Error) instanceof RangeError, true)`
相当を 1 行足せば埋まる（prefetch 側は `error.cause` を既に見ている — `src/mod.test.ts:1453, 1476`）。

### TS-013（🔵）: 「content-length が無ければ蓄積経路で読み切る」は経路を判別していない

`src/mod.test.ts:1228-1239` は結果バイト列と tight view しか見ておらず、事前確保経路でも同じ結果に
なるため名前どおりの検証にはなっていない（ヒント源が無いので実際には蓄積経路以外あり得ない、
という意味では無害）。TS-002 と同じ「使い回しチャンク」手法で判別可能にするか、名前を
「ヒントが無くても全量を tight view で返す」へ弱めるのが正直。

### TS-014（🔵）: 小さめの未凍結点（優先度低・まとめて記載）

- `prefetchUrl` の既存エントリ検査（`cache.match`。`src/mod.ts:804`）が throw した場合の
  fail loud は未凍結（`open` 失敗は `src/mod.test.ts:1482-1497` で凍結済み）。
- 「記録を焼くのは leader の `sha256` だけ」（`src/mod.ts:589-591` の NOTE）は未凍結。
  leader が `sha256` 無し・合流者が `sha256` 有りのとき、エントリに記録が付かないこと
  （＝次回のヒットで再ハッシュされること）を見る 1 本があると、合流の安全側設計が固まる。
- `caches` が無いランタイムでの `key` 指定（`src/mod.ts:593-595`。素の fetch へ落ちつつ
  合流はキー空間で効く）は未凍結。グローバル `caches` の差し替えが必要なので TS-006 と同じ
  descriptor 退避手法が要る。
- `clearCache`（`src/mod.test.ts:1847-1852`）は URL キーのエントリしか置かずに消しているので、
  「配列キーのエントリも道連れにする」ことは見ていない（`caches.delete` 一発なので実装上は自明）。

### TS-015（🟢）: ゴールデン `keyUrl` / `contentKeyUrl` が実装から独立に再導出されている（循環なし）

`src/mod.test.ts:89-93` と `src/hf/mod.test.ts:35-43` はどちらも実装の `serializeKey` を呼ばず、
`"https://fetch-cache.invalid/v1/" + elements.map(e => encodeURIComponent(JSON.stringify(e))).join("/")`
をテスト側で組み立てている。直列化形式そのものが公開契約として凍結されており、
`src/mod.ts:206-213` を書き換えれば必ず落ちる。同様に `sha256HexOf`（`src/mod.test.ts:72-76` /
`src/hf/mod.test.ts:25-29`）も native digest で独立に期待値を作っており、実装の
`sha256HexNative` を借りていない。

### TS-016（🟢）: 「記録を信じる」の意味論が behavioral に凍結されている（トートロジーでない）

`src/mod.test.ts:1012-1042` は「記録ヘッダだけ一致させ中身は別物」というエントリを仕込み、
既定では**偽の中身がそのまま返る**（＝ハッシュを計算していないことの証明）／`recheck: true` では
self-heal する、という形で ADR 0006 §2 の意味論反転を外形から固定している。実装の内部状態を
覗かずに「計算していないこと」を示せており、この差分で最も危険な決定に対する最も強いテスト。
`src/mod.test.ts:1065-1100`（安定キーのピンポン）、`src/mod.test.ts:1669-1723`（非準拠 Cache への
保険 delete がキー側に向くこと）、`src/mod.test.ts:1725-1760`（通過中検証のチャンク隔離）も同種で、
ADR 0006 が実装要件として持ち込むよう指示した 2 本（単射性テスト・TS-002 相当の保険 delete。
`docs/decisions/0006-cache-control-redesign.md:152-154`）は
`src/mod.test.ts:907-929` と `src/mod.test.ts:1669-1723` として実在する。

### TS-017（🟢）: `spyDigest` の回数勘定は実装細部への固執ではない（1 箇所だけ結合が強い）

`src/hf/mod.test.ts:641-658` の digest 回数は、ADR が明文で決めた**分担**そのものを見ている:
materialize 経路は native・streaming prefetch は純 TS（ADR 0005 §5 / `src/mod.ts:388-405`）、
記録一致のヒットは 0 回（ADR 0006 §2）。「保存時 1 回」（686-699）、「recheck で 2 回」（701-717）、
「prefetch 経由は 0 回」（836-872）はいずれも外形からは観測できない性質で、
数え上げ以外に固定する手段が無い。差し替えは `finally` で必ず復元されている。
唯一 `src/hf/mod.test.ts:660-684`（digest に渡る view が validate の受け取る実体と同一）は
zero-copy 実装契約（`src/mod.ts:396-399` の MUST）への直接結合だが、これも「数 GB でコピーを
1 回増やさない」という明示の要求なので保持でよい（診断性のみ TS-010 を参照）。

### TS-018（🟢）: mock fetch の忠実度・ignored / skip の状況

`src/testing/mock_fetch.ts` は本物の `Response` を返すため body stream・headers・status の
再現度は実物そのもの（`chunkedResponse` で任意のチャンク分割、`lazyResponse`
（`src/mod.test.ts:1320-1344`）は `highWaterMark: 0` で先読みまで殺しており、
「受信を 1 バイトも始めていない」の観測が正しく成立している）。実測で
`new Response(bytes)` は content-length を持たない（`null`）ため、既定の mock 応答は
蓄積経路を通り、事前確保経路は明示テストだけが通る — 意図的で妥当な作り分け。
`.skip` の放置は 0 件、`ignore:` は 5 箇所すべて `runtimeHasCacheKeys`
（実行時 feature-detect）由来で、恒久的に ignored なのは TS-007 の 1 本だけ。

---

## 対応テストの無い ADR 決定（一覧）

| ADR / 節 | 決定 | テスト | 備考 |
| --- | --- | --- | --- |
| 0006 §1 | 直列化は単射 | ✅ `src/mod.test.ts:907-929` | |
| 0006 §1 | 直列化は**可逆**（`listKeys` が型ごと復元） | ❌ | TS-003 |
| 0006 §1 | オブジェクト要素 / 空配列 / 非有限数値は throw | ✅ `src/mod.test.ts:931-959` | 非有限は実装追加分 |
| 0006 §1 | `cache: false` と `key` の併用は throw | ✅ `src/mod.test.ts:954-957` | |
| 0006 §1 | 予約 origin は取得元 URL に使えない | ✅ `src/mod.test.ts:961-968` | |
| 0006 §1 | 同一キーの並行呼び出しは取得元が違っても合流 | ✅ `src/mod.test.ts:886-905` | |
| 0006 §2 | 保存時に検証 → 記録ハッシュを焼く | ✅ `src/mod.test.ts:972-989` / `1592-1615` | |
| 0006 §2 | 不一致は throw・キャッシュしない | ✅ `src/mod.test.ts:991-1010` / `1647-1667` | |
| 0006 §2 | ヒットは記録との文字列比較のみ（既定 trust） | ✅ `src/mod.test.ts:1012-1042` / `src/hf/mod.test.ts:686-699` | |
| 0006 §2 | 記録なしエントリは実ハッシュで突合 | ✅ `src/mod.test.ts:1044-1063` | |
| 0006 §2 | 一致しても**記録は書き足さない** | ❌ | TS-004 |
| 0006 §2 | `recheck` は sha256 必須（単独は throw） | ✅ `src/mod.test.ts:1147-1151` / `src/hf/mod.test.ts:719-732` | |
| 0006 §2 | カスタム `validate` は常に走る | ✅ `src/mod.test.ts:1102-1120` | |
| 0006 §2 | 形式不正 sha256 は network 前に throw | ✅ `src/mod.test.ts:1140-1146` ほか | |
| 0006 §2 | `crypto.subtle` 不在は throw | ❌ | TS-006 |
| 0006 §2 | 旧ヘッダ `x-fetch-cache-verified` は読まない | ❌ | TS-005 |
| 0006 §2 | `revalidate` は予約のみ（0.5.0 未実装・sha256 併用は throw） | — | 実装にオプション自体が無く（`src/mod.ts:64-168`）併用が起き得ないため、テスト不要。ADR の「併用は throw」は実装時の宿題 |
| 0006 §3 | 名前空間は内部固定 1 個 | ✅ 全テストが `"fetch-cache"` を直接開いて突合 | |
| 0006 §3 | `evict` は常にプレフィックス意味論・件数を返す | ✅ `src/mod.test.ts:1889-1930` | |
| 0006 §3 | プレフィックスはセグメント境界で判定 | ✅ `src/mod.test.ts:1932-1949` | |
| 0006 §3 | `listKeys` は配列キーのみ / `listCachedUrls` は URL キーのみ | ✅ `src/mod.test.ts:1870-1887` | |
| 0006 §3 | 復元不能エントリは fail loud | ✅ `src/mod.test.ts:1951-1969` | |
| 0006 §3 | `clearCache` は名前空間ごと消す | ✅ `src/mod.test.ts:1847-1852` | 配列キー側は未確認（TS-014） |
| 0006 §3 | `keys()` 未実装ランタイムで `evict` / `listKeys` は throw | ❌ | TS-007（`listCachedUrls` のみ・常時 ignored） |
| 0006 §4 | sha256 ありの既定キーは `["hf", kind, repo, path, sha256]` | ✅ `src/hf/mod.test.ts:234-267` | `kind` の寄与は未確認（TS-008） |
| 0006 §4 | revision bump（内容不変）は再取得しない | ✅ `src/hf/mod.test.ts:269-285` | |
| 0006 §4 | revision 切り替えで内容が違えば共存 | ✅ `src/hf/mod.test.ts:287-313` | |
| 0006 §4 | `hubUrl` はキーに含めない（ミラー跨ぎ共有） | ❌ | TS-008 |
| 0006 §4 | sha256 無しは SHA 固定 resolve URL がキー | ✅ `src/hf/mod.test.ts:184-194` / `796-834` | |
| 0006 §4 | `HfFileSpec.key` で 3 API とも上書き可 | ✅ `src/hf/mod.test.ts:315-336` / `921-941` | `fetchHfFiles` 経由は未確認（軽微） |
| 0006 §5 | 安定キー + sha256 はピンポン（上書き） | ✅ `src/mod.test.ts:1065-1100` | |
| 0006 §5 | 内容キーは共存 / revision 入りキーは再取得 | ✅ `src/hf/mod.test.ts:287-313` / `796-834` | |
| 0006 Consequences | テスト隔離規約の変更（固定名前空間 + finally delete） | ⚠️ | TS-001（規約自体が並列で壊れる） |
| 0007 §1 | 明示 `expectedBytes` の確保失敗は受信前に throw・body cancel | ✅ `src/mod.test.ts:1346-1373` | `cause` のみ未確認（TS-012） |
| 0007 §2 | content-length 由来の確保失敗は縮退 | ✅ `src/mod.test.ts:1283-1297` | |
| 0007 §3 | 形式不正の申告は「ヒント無し」 | ✅ `src/mod.test.ts:1299-1314` | |

---

## 総評

この差分のテストは、0.5.0 で最も危険な決定（「記録ハッシュ一致なら中身を検査しない」という
既定の反転）を、記録だけ一致させた偽エントリで「計算していないこと」を外形から示す形で
凍結しており、ゴールデンなキー直列化・保険 delete のキー側・通過中チャンクの隔離まで含めて、
ADR 0006 が実装要件として名指しした項目はきちんと埋まっている — トートロジーや実装のなぞりは
ほぼ無く、質は高い。埋まっていないのは「決定は文章で書いたがテストに落ちていない」種類の穴で、
可逆性（`listKeys` の型復元）・記録を書き足さないこと・旧ヘッダを読まないこと・`crypto.subtle`
不在・`evict`/`listKeys` の `keys()` fail loud・`hubUrl` をキーに含めないこと、の 6 点が主。
いずれも 1 本ずつの追加で閉じられ、破壊的移行の意味論（TS-005）とミラー跨ぎ共有（TS-008）は
下流（yomi / sbv2-web）が実際に踏む経路なので優先度が高い。最も重いのは指摘そのものより
**隔離規約**で、固定名前空間の共有と期限なしポーリングが噛み合って `--parallel` を付けた瞬間に
「赤ではなく無限ハング」へ倒れる（実測）。まず `src/hf/mod.test.ts:448-453` に deadline を入れて
失敗が失敗として見える状態にし、`--parallel` 禁止を機械的に読める場所へ書き出すことを勧める。
