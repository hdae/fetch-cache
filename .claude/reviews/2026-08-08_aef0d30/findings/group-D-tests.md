---
id: D
topic: テスト品質横断（v0.3.1..HEAD の新規・変更テスト）
files_reviewed:
  - src/mod.test.ts（追加分: streaming prefetch / 事前確保 / 検証済みマーカー）
  - src/hf/mod.test.ts（追加分: prefetchHfFile / trustCachedSha256 / expectedBytes）
  - src/sha256.test.ts（新規）
  - src/testing/mock_fetch.ts（無変更・忠実度のみレビュー）
date: undefined
model: Sonnet 5 (claude-sonnet-5)
---

# サマリ

`deno test -A --coverage` は 110 passed / 0 failed / 1 ignored（既存の Deno 2.8 検出テスト。
本差分と無関係）。行 96.2% / 分岐 92.9%。全体としてテストの書きぶりは高品質: タウトロジー・
`toBeTruthy` 相当・private 詳細への固執は見当たらず、失敗パス（HTTP エラー・転送中断・put 失敗・
sha256 不一致・非 GET・open 失敗）を一つずつ個別テストで丁寧に踏んでいる。モック fidelity も
高い — `caches` は実物の Cache API を毎テスト固有名前空間で使い（プロジェクト規約どおり）、
`fetch` のモックも本物の `ReadableStream` / `Response` を返すため streaming 経路（body stream /
cancel / TransformStream 素通し / cache.put へのstream 渡し）は実体で踏まれている。

一方で **新規コードの分岐カバレッジに 2 件の実測ギャップ**（W）を検出した。いずれも「バグの
確証」ではなく「安全側の分岐/ガードが自動テストで一度も踏まれていない」というカバレッジ欠落
であり、needs-human ではなく実測（`deno coverage --detailed`）で確証済み。

- 件数: W 2 件、L 1 件（横断所見にのみ記載）。E / C は無し。

# ファイル別分類

| ファイル | 分類 | 理由 |
| --- | --- | --- |
| src/sha256.test.ts | S | 独立オラクル（native 一括 digest との差分）＋既知テストベクタで「実装同士の共倒れ」を明示的に回避。境界サイズ×ランダム分割×空チャンク×hex()非破壊性まで踏む。設計意図がコメントで明快。修正不要。 |
| src/mod.test.ts（追加分） | W | 全体設計は堅牢（D-D-2 参照）だが、ADR 0005 §5 の「印だけ付いた不正エントリを作れない」という設計の要である保険分岐が完全に未カバー（D-1）。 |
| src/hf/mod.test.ts（追加分） | L | prefetchHfFile 経路の新規テストは分岐・失敗パスとも手厚い（sha256 不一致 / 既存エントリ / trustCachedSha256 opt-in・既定）。`HfPrefetchOptions.caches` の受け渡しだけ未検証（横断所見参照）だが単純パススルーで分岐を持たないためリスクは低い。 |
| src/testing/mock_fetch.ts | S | 本差分での変更は無いが、streaming prefetch のテストが本物の `ReadableStream` / 実 Cache API に依拠しており、モックに起因する実環境との乖離は見当たらない。 |

# 詳細指摘

## D-1: prefetch の sha256 不一致「保険」削除分岐が自動テストで一度も実行されていない

- 概要: `prefetchUrl` の sha256 不一致時、通常は `cache.put` 自体が reject してエントリが
  残らない。ADR 0005 §5 はこれに加えて「stream の error を無視して put が解決してしまう
  Cache 実装」に備えた保険 —— `cache.delete` してから `integrityError` を throw する分岐
  （`src/mod.ts:662-665`）—— を設計の中核に据えている（「不正な印付きエントリが構造的に
  生まれない」という保証はこの保険込みで初めて成立する）。`deno test --coverage` の実測
  （`deno coverage /tmp/cov --detailed --include='src/mod.ts'`）でこの 2 行が red（0 回実行）
  であることを確認した。既存の「sha256 不一致は put ごと reject させ、エントリを成立させない」
  テスト（`src/mod.test.ts:438-459`）は Deno の実 Cache 実装が素直に reject する経路しか
  踏んでおらず、put が解決してしまうケースを模擬していない。
- 修正案（テスト仕様。実装ではなくオーケストレータ向けの追加テスト案）:
  1. ★推奨: `PrefetchUrlOptions.caches` に、`put` を「渡された Response の body を空読みして
     常に resolve する」カスタム `CacheStorage`（`failingCacheStorage` 相当の overrides で
     `put: async (req, res) => { await res.body?.getReader().read(); }` 等、stream の
     `controller.error()` を無視して読み切る実装）を注入し、`sha256` 不一致を起こす。
     観測値: (a) `prefetchUrl` が `mismatch` エラーで reject する、(b) 実際に `cache.delete`
     が呼ばれたこと（delete をスパイして呼び出し回数 1 を確認）、(c) 最終的に
     `cache.match(url)` が `undefined` を返す（保険が効いてエントリが残らない）。
  2. 代替: `cache.delete` 自体もスパイし、削除が「put 成功後・throw 前」の順で呼ばれることを
     確認する（`保険`という設計意図＝put 成功を前提にした後始末であることを固定する）。
- リスク: 未対応のまま放置すると、保険分岐に将来デグレ（例: `await cache.delete` を消して
  `throw integrityError` だけ残すリファクタ）が入ってもテストは気づかない。ブラウザの
  `CacheStorage.put` がstream の `error()` を無視する実装であった場合（ADR 0005 の
  Consequences 節が「未検証」と明記している領域）、この保険が唯一の防波堤になる。
- 対象 path:line: `src/mod.ts:662-665`（保険分岐の実装）、`src/mod.test.ts:438-459`（現状の
  最も近いテスト。put が素直に reject する経路のみ）。
- 影響範囲: `prefetchUrl` / `prefetchHfFile`（後者は前者の薄いラッパなので同じ穴を継承）。
  公開 API の破壊的変更は不要（テスト追加のみ）。
- 引き継ぎ: `PrefetchUrlOptions.caches` は既存の `failingCacheStorage`（`src/mod.test.ts:32-53`）
  と同型の overrides パターンで注入できる。`put` の overrides 内で渡された `Response` の
  body を確実に「エラーを無視して読み切る」実装にすること（`Response.body` を
  `getReader().read()` ループで最後まで読む。`controller.error()` された stream は
  `read()` が reject する可能性があるため、`try/catch` で握って「無視する Cache 実装」を
  模擬する必要がある — ここが本テストの技術的な肝）。
- 裁定: 閉じた選択肢 — ①このテストを追加する（推奨。数行で書け、ADR の中核保証を固定できる）
  / ②「Deno では到達しない防御的分岐」として明示的に未検証のまま known-issues.md か
  limitations.md に追記して許容する / ③何もしない（非推奨 — 設計文書が「構造的に生まれない」
  と言い切っている保証の裏付けが無いまま残る）。

## D-2: `expectedBytes` の不正値ガード（負数・0・非整数・NaN）が一度も実行されていない

- 概要: `allocateHint`（`src/mod.ts:156-161`）の入口ガード
  `if (!Number.isSafeInteger(size) || size <= 0) return undefined;` は、`FetchBytesOptions
  .expectedBytes`（呼び出し側が直接渡せる公開値）や content-length パースの不正値から
  「ヒント無し＝蓄積経路」へ安全に落とすための唯一の分岐だが、実測カバレッジで完全に
  未実行（`deno coverage --detailed --include='src/mod.ts'` で `src/mod.ts:157` が red）。
  既存の「確保できないほど巨大な申告」テスト（`src/mod.test.ts:178-191`, content-length =
  `Number.MAX_SAFE_INTEGER`）は `Number.isSafeInteger` を通過して `try { new Uint8Array(size)
  } catch` 側の RangeError 分岐を踏んでおり、このガード節とは別の防御線を検証している
  （両方とも「取得を落とさない」結論は同じだが、通るコードパスが違う）。
- 修正案（テスト仕様）:
  1. ★推奨: `fetchBytes(URL_A, { cacheName, fetch, expectedBytes: -1 })` で
     `chunkedResponse([...])` を読み、正常に完走し `isTightView` かつ内容一致することを
     確認する（負数）。同様に `expectedBytes: 0` と `expectedBytes: 1.5`（非整数）の 2 系列も
     追加する（`SIZES` 的な配列で 1 テストにまとめてよい）。
  2. content-length ヘッダに `"-1"` や `"abc"`（非数値）を渡す経路も、`readTotal` が
     `Number.isFinite(total) && total >= 0` で弾く既存ガード（`src/mod.ts` 内、本差分の
     変更対象外）と合流するため、こちらは D-2 の対象外（別ガードで別途保護されている）。
- リスク: このガードが壊れる（例えば `size <= 0` を `size < 0` に書き間違えて `expectedBytes:
  0` が `new Uint8Array(0)` を確保してしまう、など）degenerate なリグレッションを自動テストが
  検出できない。実害は軽微（`new Uint8Array(0)` 自体はクラッシュしないため「取得を落とさない」
  という上位契約は壊れにくい）が、ドキュメント（JSDoc: 「非整数・負・巨大すぎて RangeError」を
  「ヒント無しに落とす」と明言）と実装の対応がテストで固定されていない。
- 対象 path:line: `src/mod.ts:156-161`（未カバーのガード節）。
- 影響範囲: `fetchBytes` の `expectedBytes` オプションおよび HF 層 `HfFileSpec.expectedBytes`
  経由の全呼び出し（`src/hf/mod.ts:238` で素通し）。
- 引き継ぎ: `src/mod.test.ts` の「受信バッファの事前確保」セクション（既存の
  `fetchWithReusedChunks` ヘルパを流用可）に、`expectedBytes: -1 / 0 / 1.5 / NaN` を渡して
  `chunkedResponse` から読み切れることを確認するテストを 1 本追加すれば十分（新ヘルパ不要）。
- 裁定: 閉じた選択肢 — ①テスト追加（推奨。数行） / ②优先度低として known-issues 化せず
  現状維持（D-1 より実害が軽微なため許容範囲内という判断もあり得る）。

# 横断所見

- **HF 層 `prefetchHfFile` の `caches` パススルー未検証**（L）: `src/hf/mod.test.ts` に
  `caches:` オプションを注入するテストが 1 件も無い（`grep -n "caches:" src/hf/mod.test.ts`
  でヒット無しを確認）。ただし `prefetchHfFile`（`src/hf/mod.ts:104-126`）は
  `caches: opts.caches` を素通しするだけで分岐を持たず、下層の `prefetchUrl` 側では
  `caches` 注入によるエラー系（open 失敗・put 失敗）が `src/mod.test.ts` で個別に厚く
  検証済みのため、実害リスクは低いと判断し独立の W にはしなかった。気になる場合は
  `HfPrefetchOptions.caches` を `failingCacheStorage` 相当で注入し `prefetchUrl` 側まで
  エラーが伝播することを 1 本だけ足す形で十分（新規のテスト設計は不要）。
- **single-flight × 新オプション（`verifiedMarker` / `expectedBytes`）の組み合わせは
  未テスト**だが、コードを読む限り既存の single-flight 契約（leader の opts が保存を制御し、
  合流者は raw を受け取って各自 validate/decode を適用し直す — `src/mod.ts:303, 457`）を
  そのまま継承しており、新オプションが合流者側で誤って有効化される経路は無いことをコード
  読解で確認済み（`src/mod.ts:457` の合流者側 `validateAndDecode(raw, opts)` は `verified`
  引数を渡さないため常に `false` — 合流者は必ず検証する。これは
  `docs/limitations.md` の「single-flight の合流者は通常どおり検証する」と整合）。
  needs-human ではなく実装読解で確証済みのため、指摘としては計上しない（テストで固定する
  価値はあるが、優先度は D-1/D-2 より低い）。
- **モック fidelity（担当範囲 2 の結論）**: 本差分のテストは `caches` に実物の Cache API
  （テスト毎ユニーク名前空間 + 後始末）を使い、`fetch` モック（`mockFetch` /
  `chunkedResponse` / `manualStream`）も本物の `Response` / `ReadableStream` を返す。
  `prefetchUrl` の TransformStream 素通し・`body.cancel()`・`cache.put` への stream 渡しは
  すべて実体の Web 標準 API 上で実行されており、「モックだから通るが実環境で違う」形状の
  乖離は検出しなかった。唯一 D-1 で指摘した「stream の error を無視する Cache 実装」だけは
  Deno の実 Cache API が示さない挙動のため、意図的にモックで注入しない限り検証しようがない
  （＝ D-1 はモック不足ではなく設計上必然的にモックでしか踏めない分岐）。
- **重要コードパス（sha256 不一致 → put reject → エントリ不成立）の実コード行**:

  ```
  prefetchUrl()
    ├─ TransformStream.flush()                    src/mod.ts:395-402
    │    actual !== expectedSha256
    │    └─ controller.error(integrityError) ─┐
    │                                          │ stream error
    ├─ await cache.put(requestUrl, stored)  <──┘             src/mod.ts:409
    │    │
    │    ├─ (Deno 実測: put が reject) ─────► catch (error)   src/mod.ts:410-418
    │    │                                    integrityError!==undefined
    │    │                                    └─ throw integrityError（テスト済み: D-1 対象外の経路）
    │    │
    │    └─ (仮に put が resolve してしまったら) ─► 保険分岐    src/mod.ts:419-424 ← D-1（未テスト）
    │                                             cache.delete → throw
  ```
