---
id: A
topic: cache 層（src/mod.ts）深掘り — streaming prefetch / 通過中 sha256 検証 / 検証済みマーカー / 受信バッファ事前確保
files_reviewed:
  - src/mod.ts
date: undefined  # ← オーケストレータ側のテンプレート変数が未展開のまま渡された（出力先パスも同様: "undefined/findings/group-A-cache.md"）
model: Opus 5 (claude-opus-5[1m])
range: v0.3.1..HEAD
---

# Group A — cache 層（src/mod.ts）レビュー

## サマリ

総評: **リリース可（ブロッカー無し）**。差分の中核主張はいずれも実装で追跡でき、成立している。

- ADR 0005 §5 の「**不正な印付きエントリが構造的に生まれない**」は、既定経路（`globalThis.fetch` /
  Deno の Cache API）では**成立**。印は put 前の Response 構築時に焼かれ、不一致は `flush` の
  `controller.error()` で stream ごと落ち、`cache.put` が reject してエントリが成立しない
  （`deno task check` で 110 passed / 0 failed を実測。テスト
  `prefetchUrl: sha256 不一致は put ごと reject させ、エントリを成立させない` が凍結済み）。
  唯一の穴は「`response.body` のチャンクは enqueue 後に書き換えられない」という**暗黙不変条件**に
  依存している点で、DI した `fetch`（公開オプション）次第では破れる（A-1）。
- 「1 チャンク stream で組む `cache.put` は従来の `new Response(bytes)` と公開挙動同一」（ADR 0005 §2）は
  **実測で確認**（Deno 2.9.4 で往復させ、格納後の headers `[]` / status 200 / bytes が両形で完全一致）。
- 受信バッファ事前確保（§1）は超過・不足・不正値・確保失敗の 4 分岐すべてに凍結テストがあり、
  tight view 契約（`bytes.buffer` zero-copy 前提）も全経路で保たれている（証明は「深掘り観点 3」節）。
- 並行性は具体的失敗形状（lost wakeup / TOCTOU / self-deadlock / spurious wakeup）を一つずつ
  当てたが、**新規の破れは無い**（「深掘り観点 1」節に棄却の根拠を列挙）。

件数: **C 0 / E 0 / W 3 / L 3**（W 以上は下の詳細指摘、L は「軽微な所見」節）。

## ファイル別分類

| path | grade | 理由 |
| --- | --- | --- |
| `src/mod.ts` | **W** | バグ・設計原則違反は無い。ただし ①中核主張が公開オプション（DI した `fetch`）越しでは暗黙不変条件に依存（A-1） ②ADR が明示的に置いた「保険 delete」分岐が未テスト（A-2） ③single-flight 合流者が新オプションを無視する事実が limitations.md の一覧から漏れている（A-3）。 |

担当ファイルは `src/mod.ts` のみ（漏れゼロ）。`src/sha256.ts` / `src/hf/mod.ts` は他グループ担当のため、
本レビューでは *`src/mod.ts` から見た契約面*（`createSha256` の `update`/`hex` の呼び方、HF 層が渡す
`verifiedMarker` / `sha256` の整合）だけを参照した。

---

## 詳細指摘

### A-1 — 通過中検証の健全性が「body チャンクは enqueue 後に書き換わらない」という暗黙不変条件に依存する（W）

- **概要（挙動の言葉 + 発生条件）**
  `prefetchUrl` の通過中検証は、`transform` で `hasher.update(chunk)` を呼んだ**同じ Uint8Array
  インスタンス**をそのまま `controller.enqueue(chunk)` で下流（`cache.put`）へ渡す。ハッシュ対象と
  格納対象が同一オブジェクトである以上、「enqueue 後にそのバイト列が書き換わらない」ことが
  ハッシュ＝格納内容の等価性の前提になっている。
  `globalThis.fetch` の body はチャンク毎に新しいバッファを生むためこの前提は満たされるが、
  `opts.fetch` は **公開オプション**であり JSDoc も「テスト・カスタム輸送用」と用途を広く取っている
  （src/mod.ts:507）。固定長スクラッチバッファを使い回す ReadableStream を返すカスタム輸送
  （ファイル読み出しを自前 stream 化した実装などで起こりうる）を渡すと、`update` 済みの内容と
  `cache.put` が最終的に書いた内容が食い違い、**「sha256 の印が付いているのに中身が違うエントリ」**が
  成立しうる。印は以後 `verifiedMarker` / `trustCachedSha256` で検証を丸ごと省かせるため、
  汚染は self-heal では回復せず**恒久化する**（印が付いていない汚染は読み出し時に必ず検出される）。
  Streams 仕様は非 BYOB の enqueue について「所有権を渡す」ことを規範的に要求していないので、
  これは「実装の慣習に支えられて偶然アトミックな区間」に当たる。

  ```
  prefetchUrl (sha256 指定時) の 1 チャンクの流れ — src/mod.ts:628-646
  ┌──────────────┐   chunk (同一インスタンス)   ┌───────────────┐
  │ response.body│ ─────────┬─────────────────▶ │ TransformStream│
  └──────────────┘          │                   │  :630 transform│
      ▲ カスタム fetch が   │  L631 loaded += chunk.byteLength
      │ ここで同じバッファを │  L632 hasher.update(chunk)   ← ここでハッシュ確定
      │ 次チャンクへ再利用   │  L634 controller.enqueue(chunk) ← 同じ実体を下流へ
      └─────────────────────┘                   └───────┬───────┘
                                                        │ (非同期に消費)
                                          L650 cache.put ▼  ← 書かれるのは「今の」中身
                             L636-643 flush: hex() 一致なら印ごと成立
  ```

  なお `fetchBytes` 側の蓄積経路（src/mod.ts:205 `chunks.push(value)`）も同じ前提に立っており、
  そちらは v0.1.0 からの既存挙動（本差分の新設ではない）。ただし本差分で新設された
  `expectedBytes` 事前確保経路は `buffer.set(value, loaded)`（src/mod.ts:202）で**即コピー**するため、
  皮肉にも既定経路のこの脆さは差分によって**改善**している。**新たに危険になったのは
  「印を焼く」prefetch 経路だけ**である、というのが本指摘の要点。

- **修正案**
  1. ★**`PrefetchUrlOptions.fetch` の JSDoc に `MUST NOT` を 1 行追加する**
     （「body のチャンクは enqueue 後に書き換えてはならない — 通過中ハッシュと格納内容の
     同一性がこれに依存する」）。加えて ADR 0005 §5 の「構造的に生まれない」主張に
     「ただし `fetch` DI が仕様どおり振る舞う限り」という但し書きを付す。
     コスト 0・実行時オーバーヘッド 0 で、暗黙不変条件を明示不変条件へ昇格させる。
  2. `transform` で `hasher.update(chunk)` の前に `chunk.slice()` を取り、コピーを下流へ流す
     （または逆にハッシュ側をコピーする）。**非推奨**: 全チャンクの複製は
     「ヒープに載せない」という本機能の存在理由そのものを毀損する（チャンク単位なのでピークは
     小さいが、GC 圧が数 GB ぶん増える）。
  3. 何もしない（現状維持）。カスタム輸送は上級者向けであり、実際に踏むには
     「バッファ再利用 stream」＋「sha256 指定」＋「印を信じる読み出し」の 3 つが揃う必要がある、と
     割り切る。

- **リスク**: 案 1 はゼロリスク（文書のみ）。案 2 は性能退行と ADR との齟齬。案 3 は
  「恒久化する汚染」の経路を未文書のまま残す。
- **対象**: `src/mod.ts:628-646`（transform/flush）・`src/mod.ts:507`（`fetch` オプションの JSDoc）・
  `docs/decisions/0005-…md:111-117`（構造的主張）
- **影響範囲**: 既定経路（`globalThis.fetch`）を使う下流（yomi / sbv2-web）には**現状影響なし**。
  影響するのは `opts.fetch` を差し替える利用者のみ。
- **引き継ぎ（実装者向け）**: 案 1 を採るなら、`PrefetchUrlOptions.fetch` の JSDoc（現行 1 行）に
  MUST NOT を足すだけ。テストは書けない（テストで再現するには規約違反 stream を自作することになり、
  それは「壊れた入力を凍結する」テストになってしまう — 契約は文書側に置くのが正しい）。
- **裁定（閉じた選択肢）**: **①案 1（JSDoc + ADR に但し書き）** / ②案 2（チャンク複製） /
  ③案 3（現状維持・記録もしない）。
- **needs-human**: **はい**。実測した障害ではなく仕様レベルの論証であり、どこまでを契約として
  書き下すかは設計判断。

### A-2 — ADR が明示的に置いた「保険 delete」分岐に到達するテストが無い（W）

- **概要**
  ADR 0005 §5 は「念のため put が解決してしまった場合（stream の error を無視する Cache 実装）に
  備えてエントリを削除してから throw する保険も置く」と明記し、実装も src/mod.ts:660-665 にある。
  しかし現行テストで到達するのは **put が reject する側（Deno の実挙動）だけ**で、
  `integrityError !== undefined && put が resolve` の分岐は一度も実行されない。
  つまり「ブラウザ実装が Deno と違った場合の最後の砦」が、**未検証のまま出荷される**。
  この分岐が壊れていた場合の帰結は A-1 と同じ「印付きの汚染エントリが恒久化」であり、
  保険としては最も落としてはいけない側。
  （テスト基盤は既に揃っている: `src/mod.test.ts:31-57` の `failingCacheStorage` は
  `put` だけを差し替えられるので、「stream を最後まで読んでから error を握り潰し、
  自前で正常エントリを書く put」を注入すれば 10 行程度で凍結できる。）

- **修正案**
  1. ★**`failingCacheStorage({ put })` で「stream の error を無視して resolve する Cache」を注入し、
     `prefetchUrl` が (a) `SHA-256 不一致` で throw し (b) エントリが残っていないことを assert する
     テストを 1 本足す。**
  2. 保険コードごと削除して「Deno / 仕様準拠実装では put が reject する」に一本化する。
     **非推奨**: ADR が意図的に置いた多層防御を、検証の手間を理由に外すことになる。
  3. 現状維持（未テストのまま残す）。ADR 本文に「この分岐はブラウザ実機でのみ意味を持ち、
     自動テストは Deno のみ（docs/limitations.md）」と注記だけ足す。

- **リスク**: 案 1 はゼロリスク（テスト追加のみ）。案 2 は防御を 1 枚剥がす。案 3 は据え置き。
- **対象**: `src/mod.ts:660-665` / `src/mod.test.ts:31-57`（注入基盤）/
  `docs/decisions/0005-…md:114-116`
- **影響範囲**: 実行時挙動の変更なし（テストのみ）。リリース可否をブロックはしない。
- **引き継ぎ**: 注入する put は「渡された `response.body` を最後まで読み（error を catch して握る）、
  `real.put(request, new Response(<読めたぶん>, { headers: response.headers }))` を実行して resolve」
  という形にすると、印が付いたまま resolve する最悪ケースを正確に模せる。assert は
  ①`assertRejects(..., "SHA-256 不一致")` ②`assertEquals(await cache.match(URL), undefined)` の 2 点。
- **裁定**: **①テストを 1 本追加** / ②保険コードを削除 / ③現状維持 + ADR 注記のみ。
- **needs-human**: いいえ（①が明らかに妥当）。

### A-3 — single-flight 合流者が `verifiedMarker` / `expectedBytes` を黙って無視する事実が limitations.md に無い（W）

- **概要**
  `docs/limitations.md:10-13` は「合流者の `fetch` / `caches` / `init` / `onCacheError` は使われない」と
  列挙するが、本差分で追加された 2 オプションも同じく**合流者側では一切効かない**:
  - `expectedBytes`: 受信は leader の `readBody` で走るため（src/mod.ts:371）、合流者の申告は無視される。
    影響は性能のみ・無害。
  - `verifiedMarker`: 合流者は `existing.promise` から raw を受け取り
    `validateAndDecode(raw, opts)` を `verified` 既定 false で呼ぶ（src/mod.ts:456-457）ため、
    **読み出し側としては安全側**（常に自分の validate を走らせる — mod.ts:95-96 の JSDoc どおり）。
    問題は**書き込み側**で、印を焼くのは leader だけ（src/mod.ts:378）。
    → **「`verifiedMarker` 付きの呼び出しが合流者になると、印がどこにも焼かれない」**。
    どの呼び出しが leader になるかは到着順という非決定要因で決まるため、
    「印を付けたつもりが付いていない → 起動毎に数 GB の再ハッシュが走り続ける」という
    **黙って効かない最適化**になる。実害は性能だけだが、原因が非決定的で下流からは極めて追いにくい。
  - 具体的な踏み方: 下流が同一 URL に対し「`trustCachedSha256: true` の本命呼び出し」と
    「オプション無しの別経路呼び出し」を並行で投げると、後者が leader になった回で印が焼かれない。

- **修正案**
  1. ★**`docs/limitations.md` の合流者・未使用オプション一覧に `expectedBytes` / `verifiedMarker` を
     追記し、「`verifiedMarker` は leader の値だけが焼かれる（＝合流者になると印が付かない）」を
     明記する。** 併せて `fetchBytes` JSDoc の single-flight 節（src/mod.ts:403-405）の
     「合流者の fetch / caches / init / onCacheError は使われない」も同じ 2 つを含めて更新。
  2. `InflightEntry` に leader の `verifiedMarker` を持たせ、合流者の指定と食い違ったら
     `console.warn` する。**非推奨**: 正しさに影響しない事象のためだけに合流点へ状態を増やす
     （「派生状態を独立に持たない」方針とも相性が悪い）。
  3. 合流者の `verifiedMarker` で put をやり直す。**強く非推奨**: N バイトの再 put を伴い、
     ADR 0005 Consequences が明示的に見送った機構そのもの。

- **リスク**: 案 1 はゼロリスク。案 2 は複雑度の追加。案 3 は released API の合流契約（ADR 0004）に触る。
- **対象**: `src/mod.ts:448-458`（合流経路）/ `src/mod.ts:375-385`（印を焼くのは leader のみ）/
  `docs/limitations.md:10-13`
- **影響範囲**: 実行時挙動の変更なし（文書のみ）。ただし下流の「起動時ハッシュ 0 回」という
  期待値に直結するため、リリースノート級の情報。
- **引き継ぎ**: limitations.md の cache 層 1 項目目（single-flight）の括弧内列挙に 2 語足すだけで足りる。
  「非決定的に leader が決まる」ことまで書くのが要点で、単に「使われない」だけだと
  性能が出ない現象と結び付かない。
- **裁定**: **①limitations.md + JSDoc に追記** / ②合流時に warn / ③現状維持。
- **needs-human**: いいえ。

---

## 軽微な所見（L — 指摘だが対応必須ではない）

- **A-L1 `prefetchUrl` の `open` / `match` 失敗だけ素の runtime エラーが漏れる**
  （`src/mod.ts:572`, `src/mod.ts:576`）。prefetch の他の失敗面（非 GET / sha256 形式不正 /
  caches 不在 / HTTP エラー / put 失敗 / sha256 不一致）は全て `fetch-cache:` プレフィックスと URL を
  含む整形済みメッセージなのに、この 2 つだけランタイム由来の生エラーがそのまま出る。
  fail loud という点では正しい（握り潰していない）が、診断性は一段落ちる。
  併せて JSDoc の fail-loud 列挙（`src/mod.ts:532-533`）にも `match` 失敗が入っていない。
  → 対応するなら try/catch で `cause` 付きラップに揃える（挙動は不変）。

- **A-L2 サーバ申告の content-length がそのまま確保サイズになる新しい面**（`src/mod.ts:187-188`）。
  従来 content-length は進捗表示にしか使われていなかったが、本差分で**確保の副作用**を持つように
  なった。実測（Deno 2.9.4 / Linux）では `new Uint8Array(3_000_000_000)` が成功しつつ RSS 増分は
  0MB（lazy commit）で、書き込むのは実受信ぶんだけ・余りは `buffer.slice(0, loaded)` で捨てられる
  （`src/mod.ts:210-212`）ため、**実害はアドレス空間の予約に留まる**。確保失敗は
  `allocateHint`（`src/mod.ts:156-163`）が握って蓄積経路へ落とす。よって現状は L 止まり。
  ただし「content-length は信頼しない」という明文方針（docs/limitations.md:20-23）に対し、
  *確保という一面でだけは信頼している*ことは記録に値する（32bit 環境では RangeError → 縮退で吸収）。

- **A-L3 ヒント経路の細かなドリフト 2 件**
  ① `hint = expectedBytes ?? total`（`src/mod.ts:187`）のため、`expectedBytes` に不正値
  （負・非整数・0）を渡すと content-length ヒントへは**フォールバックしない**。JSDoc は
  「省略時は content-length をヒントに使う」としか書いておらず、「不正値時」は未定義。性能のみ。
  ② README.md:157-160 の "A wrong hint costs nothing — the download simply falls back to the
  chunked path." は不足側（hint > 実受信）では不正確で、実際は蓄積経路ではなく
  `buffer.slice(0, loaded)`（`src/mod.ts:211`）で一時的に 2N を踏む。文言を
  「超過なら蓄積経路・不足なら実長へ詰め直し」に揃えると実装と一致する。

---

## 深掘り観点への回答（証明 / 棄却）

### 観点 1 — prefetch × single-flight × fetchBytes の相互作用（並行性）

`prefetchUrl` は `inflight` Map に一切触れない（`src/mod.ts:542-667` に `inflight` の参照なし）。
よって以下を個別に判定した。

- **self-deadlock: 棄却。** `fetchBytes` の `validate` / `decode` から `prefetchUrl` を呼んでも
  合流点が無いので自己合流しない（`fetchBytes` 同士の自己デッドロック — ADR 0004 の既知の罠 — は
  prefetch には存在しない）。むしろ prefetch は「decode 内から呼んでも安全な唯一の取得 API」。
- **TOCTOU（leader 登録）: 棄却（既存の不変条件が維持されている）。** `src/mod.ts:472-477` は
  `acquireAndDecode(...)` を呼んでから `inflight.set` する順序だが、`acquireAndDecode` は async 関数で
  最初の `await`（`cacheStorage.open`）で必ず中断して呼び出し元へ制御を返すため、
  `inflight.get`（:447）から `inflight.set`（:477）までに**他タスクの実行機会は一度も無い**
  （同期実行区間）。本差分はこの区間に await を持ち込んでいない。コメント（:460-461）の MUST は生きている。
- **lost wakeup: 棄却。** `finally` での `inflight.delete`（:472-476）後に到着した呼び出しは新規 leader に
  なるだけ。settle 済み promise に合流した呼び出しも正しい raw を受け取る（`await` は解決済みでも成立）。
- **spurious wakeup: 非該当**（条件変数的な待機構造を持たない）。
- **prefetch の put と fetchBytes の put の競合（last-writer-wins の成立条件）: 成立。**
  両者とも Response を**丸ごと差し替える**（body もヘッダも自前で組む — `src/mod.ts:235-245` /
  `src/mod.ts:646`）ため、`(バイト列, 印)` の組は常に単一の書き手に由来し、
  **「印だけ古い / バイトだけ新しい」という裂けた状態は原理的に作れない**。
  どちらが最後に勝っても組として整合する。逆順（prefetch が後勝ち）でも同じ。
  → limitations.md:40-43 の「内容同一の last-writer-wins で整合性は壊れない」は、
  内容が同一でなくても（サーバ側が差し替わっていても）**組の整合という意味では**成立する、
  というのが実装から読める強めの結論。
- **読み出し側のスナップショット整合: 成立。** `src/mod.ts:333-338` は同一の `cached` Response から
  ヘッダ（印）とバイト列を読むので、印と中身が別エントリ由来になることはない。

### 観点 2 — 印が付く経路 / 付かない経路の網羅

| # | 経路 | 印 | 実装 |
| --- | --- | --- | --- |
| 1 | `fetchBytes` network 取得 + `verifiedMarker` 指定（validate/decode 成功後） | **付く** | `src/mod.ts:374-378` |
| 2 | `prefetchUrl` + `sha256` 一致 | **付く** | `src/mod.ts:607-609, 646` |
| 3 | `fetchBytes` network 取得・`verifiedMarker` 未指定 | 付かない（既存の印も put で消える＝安全側） | `src/mod.ts:378` |
| 4 | `prefetchUrl`（`sha256` 未指定） | 付かない | `src/mod.ts:607-609` |
| 5 | single-flight 合流者 | 付かない（leader のみが焼く → **A-3**） | `src/mod.ts:456-457` |
| 6 | キャッシュヒットで検証を通した既存エントリ | 付かない（再 put しない方針 — ADR 0005 Consequences） | `src/mod.ts:343-347` |
| 7 | `prefetchUrl` で既存エントリあり（false 返し） | 付かない（network に出ない） | `src/mod.ts:576-580` |
| 8 | `prefetchUrl` + `sha256` 不一致 | エントリごと不成立 | `src/mod.ts:636-643, 649-665` |

**ADR 0005 §5 の中核主張の判定**: 「印は put 前に焼く」（:607-609 で Response 構築時）・
「不一致は `controller.error()` で stream ごと落とす」（:642）・「保険の delete」（:663）の 3 点は
すべて実装に存在し、既定経路では**成立**。ただし保険 delete は未実行経路（**A-2**）、
主張の前提に暗黙不変条件がある（**A-1**）。
さらに重要な補強として、**印ヘッダはサーバ応答から引き継がれない** — `fetchBytes` / `prefetchUrl` の
どちらも格納 Response のヘッダを自前で組み立てる（`src/mod.ts:242-244` / `:607-609, 646`）ため、
悪意あるサーバが `x-fetch-cache-verified` を送り込んで検証をスキップさせることはできない。
これは ADR に明記されていないが、印機構の安全性にとって本質的な性質なので記録しておく。

### 観点 3 — 受信バッファ事前確保（tight view 契約の証明）

`readBody`（`src/mod.ts:175-220`）の全出口が `buffer` 全体を占める tight view を返すことを確認:

| 出口 | 条件 | tight か |
| --- | --- | --- |
| `:183-185` | `body === null` | `new Uint8Array(arrayBuffer)` → tight ✓ |
| `:211` 前段 | 確保成功 & `loaded === buffer.length` | 確保サイズ = 実長 → tight ✓ |
| `:211` 後段 | 確保成功 & 不足（`loaded < buffer.length`） | `buffer.slice(0, loaded)` が新バッファを確保 → tight ✓（一時的に 2N を踏む — A-L3②） |
| `:213-219` | ヒント無し / 確保失敗 / 超過フォールバック | `new Uint8Array(loaded)` → tight ✓ |

超過フォールバック（`:196-200`）は `chunks.push(buffer.subarray(0, loaded))` で途中までを引き継ぐため
**バイト列の欠落も重複も無い**（超過を検知したチャンク自身は `:205` で改めて push される）。
`buffer.subarray` はビューなので確保済みバッファが最終連結まで生存するが、超過ケースの hint は
定義上「実受信より小さい」ので追加ピークは小さい。
進捗との整合: `loaded += value.length` → `onProgress`（`:206-207`）は分岐前後で同一のため、
`expectedBytes` の有無で進捗の値が変わらない（テスト `expectedBytes は content-length より優先される`
ほか 4 本で凍結済み）。不正値・確保失敗は `allocateHint`（`:156-163`）が `undefined` に落として吸収する。

### 観点 4 — 1 チャンク stream で組む `cache.put` の意味論

Deno 2.9.4 で `new Response(bytes)` と 1 チャンク stream の両方を `cache.put` → `cache.match` で
往復させ、**格納後の headers（両者とも `[]`）・status（200）・statusText（空）・type（default）・
バイト列がすべて一致**することを実測した。`new Response(BufferSource)` は Content-Type も
Content-Length も付与しないため、stream 版との差は無い。ADR 0005 §2 の「格納内容・格納後の
読み出しは完全に同じ」は**成立**（Deno 実測ベース。ブラウザは自動テスト対象外 —
docs/limitations.md のとおり）。

### 観点 5 — エラーパスと ADR 0001 の縮退境界

- `fetchBytes` 側は縮退契約を維持: put 失敗は `onCacheError` + 続行（`:380-384`）、
  match 失敗は miss 扱い（`:339-342`）、open 失敗はキャッシュ無し続行（`:321-325`）、
  self-heal の delete 失敗も続行（`:352-357`）。**本差分による変更なし**。
- `prefetchUrl` は `onCacheError` を**持たない**（`PrefetchUrlOptions` に無い）＝ ADR 0001 の縮退契約が
  prefetch へ漏れ出していないことを型レベルで担保している。良い境界の引き方。
- 不一致エラーが put のラップメッセージに埋もれない設計（`integrityError` の先出し — `:654`）も
  ADR どおり。ただし put が quota で reject しつつ同時に不一致でもあった場合、報告されるのは
  不一致だけになる（エントリは不成立なので実害なし・記録のみ）。
- HTTP エラー時の `body.cancel()`（`:585-589`）、既存エントリ時の `existing.body?.cancel()`（`:578`）は
  どちらもリソース解放として妥当。`.catch(() => {})` で後始末の失敗が本命エラーを覆わない。
- `body === null` フォールバック（`:613-623`）は put 前に throw するため保険 delete が不要という
  非対称を正しく実装している（コメントも明示）。この経路だけ全量がヒープに載るが、
  body が null になるのは空応答か body 非対応ランタイムに限られる。

---

## 横断所見

1. **`VERSION` は `0.3.1` のまま**（`src/mod.ts:22`）。新規 export（`prefetchUrl` / `PrefetchUrlOptions`）と
   新規オプション 2 つを含む差分なので、リリース時は `deno task bump minor` が必要
   （公開 API の追加のみで破壊的変更は無い＝ **minor が正しい**）。
   `deno.json` の `version` と `src/mod.ts` の `VERSION` を 1 コミットで同期する既存の仕組みに乗る。
2. **後方互換性: 破壊なし。** 既存 export のシグネチャ変更なし、追加オプションは全て任意で
   既定挙動不変（`verified` 既定 false / `expectedBytes` 未指定なら content-length ヒントのみ /
   put の Response 形式変更は上記のとおり公開挙動同一）。下流 yomi / sbv2-web はコード変更なしで
   0.3.1 と同じ挙動を得る。
3. **`deno task check` は全緑**（110 passed / 0 failed / 1 ignored、793ms）。fmt / lint / `deno check` も通過。
   ネットワークに出るテストは無く、fetch は全て DI（`src/testing/mock_fetch.ts`）、
   Cache API はユニーク cacheName + `finally` で後始末という規約どおり。
4. **実行時依存ゼロ MUST は維持**（`src/mod.ts:20` の import は同リポ内の `./sha256.ts` のみ）。
   純 TS SHA-256 を抱えた判断は ADR 0005 §5 に理由と撤回の経緯まで残っており追跡可能。
5. **引き継ぎ事項の現状**: single-flight（前回 E-A-1）は 0.3.0 で導入済みで本差分でも壊れていない
   （観点 1 参照）。Actions SHA pin（W-C-4）はユーザー判断済みのため再指摘しない（現状も未対応）。
6. **本ファイルの出力先パスが `undefined/findings/…` になっている**（オーケストレータのテンプレート
   変数 `${reviewDir}` 相当が未展開）。frontmatter の `date` も同様に `undefined`。
   リポジトリ直下に `undefined/` ディレクトリが作られているので、`.claude/reviews/<日付>_<hash>/` 等の
   正しい場所へ移動して削除すること（git 未追跡）。
