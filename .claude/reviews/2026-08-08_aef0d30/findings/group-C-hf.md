---
id: C
topic: HF 層（src/hf/）— streaming prefetch / 通過中 sha256 検証 / 検証済みマーカーの配線
files_reviewed:
  - src/hf/mod.ts
  - src/hf/mod.test.ts
range: v0.3.1..HEAD (aef0d30)
date: 2026-08-08  # 指示された date プレースホルダが `undefined` のまま渡ってきたため実日付を記入
model: Opus 5 (opus, subagent)
---

## サマリ

総評: **リリースブロッカー無し（E / C ゼロ）**。cache 層への配線は 3 本とも正しく、
前回 E-B-1 で凍結した percent-encode 契約も新経路で維持されている（`hfResolveUrl` を
`fetchResolvedFile` と完全に同一の呼び出し形で共有 — src/hf/mod.ts:231 と :315）。
`trustCachedSha256` は既定 false で released API の挙動を 1 バイトも変えず、
`HfFileSpec` にはフィールド追加すら無いので型互換も保たれている。テストは
prefetch → trustCachedSha256 の一気通貫（digest 呼び出し 0 回）まで凍結できており、
設計意図（ADR 0005 §5）が実測で裏取りされている。34 tests / 0 failed（実行確認済み）。

残る指摘はすべて **契約の非対称・ドキュメントのドリフト・API 形の最終確認**であり、
うち C-3 だけは「新規 API を released する前の最後の機会」という意味でリリース前に
裁定しておく価値がある。

件数: C=0 / E=0 / W=4 / L=2

## ファイル別分類

| path | 判定 | 理由 |
| --- | --- | --- |
| src/hf/mod.ts | W | 配線・URL 契約・型互換は正しい。ただし sha256 の形式契約が層間で非対称（C-1）、`prefetchHfFile` が `HfFileSpec` の一部を黙って捨てる（C-2）、新規 API の戻り値が revision を返さない（C-3）。 |
| src/hf/mod.test.ts | W | 新経路の主要挙動（解決 1 回 / 印の一気通貫 / 不一致で不成立 / 既存で false / init・onProgress 転送）は凍結済み。前回 E-B-1 の URL encode 契約と形式不正 sha256 の挙動が prefetch 経路で未凍結（C-4）。 |

## 詳細指摘

### C-1 (W) — sha256 の「64 桁小文字 hex」契約が fetch 経路と prefetch 経路で非対称

**概要**: 同じ `HfFileSpec.sha256` を渡しても、`prefetchHfFile` は network に出る前に
形式エラーで即 throw するのに対し、`fetchHfFile` は形式検証を一切せず「全量ダウンロード →
ハッシュ計算 → 不一致 throw」で落ちる。発生条件は「64 桁小文字 hex 以外の sha256 申告」
（大文字 hex・`sha256:` 接頭辞付き・空文字・前後空白）。HF の LFS メタデータは小文字だが、
manifest を人手で作る下流（yomi / sbv2-web）や、将来 `sha256FromHub`（.claude/future-work.md）
で外部由来の値を流し込む経路では現実的にゆれる。

さらに悪いのは **繰り返しコスト**: 大文字 hex を `fetchHfFile` に渡すと、キャッシュヒット
→ validate 拒否 → evict → network 再取得 → validate 拒否 → throw という self-heal 経路を
毎回フルで回る。数 GB 級では「呼ぶ度に GB を捨てる」挙動になり、しかもエラーメッセージ
（`SHA-256 不一致: <actual> != <declared>`）は 2 つの値が case 違いなだけであることを
明示しない。

```
                       spec.sha256 = "ABCD…" (大文字 64 桁)
                                 |
        +------------------------+------------------------+
        |                                                 |
  prefetchHfFile (mod.ts:319)                       fetchHfFile (mod.ts:241/212)
        |                                                 |
  prefetchUrl (../mod.ts:560)                       buildValidate — 形式検査なし
  /^[0-9a-f]{64}$/ でガード                                |
        |                                          network 全量 DL (数 GB)
   network 前に throw                                      |
   "64 桁の小文字 hex で指定してください"           sha256Hex(bytes) → 小文字 hex
        |                                                 |
      即失敗（安い）                                 不一致 throw（毎回 GB を捨てる）
```

**修正案**:
1. ★ `toSpec`（src/hf/mod.ts:252-253）に形式ガードを 1 本置き、`fetchHfFile` /
   `fetchHfFiles` / `prefetchHfFile` の全入口で同じ形式契約を適用する。cache 層と同じ
   正規表現・同じ「64 桁の小文字 hex」文言に、HF 層の `spec.path` を添えて throw する。
   非破壊性: 大文字 hex は現状も **必ず** 失敗するので、成功していた呼び出しは 1 つも
   失敗に変わらない（エラーの種類と発生タイミングが早くなるだけ）。
2. `buildValidate` の比較を case-insensitive（`actual !== spec.sha256.toLowerCase()`）に
   する。**非推奨** — `prefetchUrl` 側は大文字を受け付けないため、prefetch では失敗し
   fetch では成功する新たな非対称を生む。さらに印（`verifiedMarker`）は文字列一致比較
   （../mod.ts:335-336）なので、大文字申告で焼いた印と prefetch が焼く小文字の印が
   一致せず、`trustCachedSha256` が黙って効かなくなる（性能だけが静かに劣化する）。
3. 現状維持 + `HfFileSpec.sha256` の JSDoc（src/hf/mod.ts:39-44）に「64 桁小文字 hex 以外は
   常に不一致になる」と明記するだけ。

**リスク**: 案 1 は「throw のタイミングが早まる」以外の挙動変化が無く、released API の
成功経路には触れない。案 2 は上記のとおり印の静かな失効を招くため退ける。

**対象**: src/hf/mod.ts:212-219（`buildValidate` の sha256 比較）/ src/hf/mod.ts:252-253
（`toSpec`）/ 対照は src/mod.ts:559-564（cache 層の形式ガード）。

**影響範囲**: `fetchHfFile` / `fetchHfFiles` / `prefetchHfFile` の入口。下流は現状も
大文字 hex では動いていないため、実質的な破壊は無い。

**引き継ぎ**: `toSpec` は現在 `string | HfFileSpec` の正規化しかしていないので、そこに
`if (spec.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(spec.sha256)) throw …` を足すのが
最小差分（`prefetchHfFile` は src/hf/mod.ts:314 で、`fetchHfFile` は :268 で、`fetchHfFiles`
は :348 で `toSpec` を通るため 1 箇所で全入口を覆える）。cache 層の重複ガードは
`prefetchUrl` の単独利用者のために残す。テストは「大文字 hex を `fetchHfFile` に渡すと
network に出る前に throw する（`calls.length === 0`）」で凍結できる。

**裁定**: (a) `toSpec` に形式ガードを追加する ★ / (b) JSDoc への明記だけで現状維持 /
(c) 何もしない。

---

### C-2 (W) — `prefetchHfFile` が `HfFileSpec` を丸ごと受け取りながら `expectedBytes` / `validate` を黙って捨てる（JSDoc の記述もずれている）

**概要**: `prefetchHfFile` は `spec.sha256` だけを cache 層へ転送し（src/hf/mod.ts:319）、
`spec.expectedBytes` / `spec.validate` / `spec.decode` は読まない。`decode` は読み出し時の
関心なので落ちて当然、`validate` はバイト列が手元に無いので構造的に不可能（ADR 0005 §5）。
問題は **`expectedBytes` と JSDoc の食い違い**。src/hf/mod.ts:293-295 は

> `expectedBytes` は sha256 一致がバイト同一を含意するので実質包含されるが〜

と書くが、これが成り立つのは `spec.sha256` **がある**ときだけ。`{ path, expectedBytes }`
（sha256 なし）の spec を渡すと、prefetch は完全な無検証格納になり、宣言した長さは
どこでも照合されない。発生条件は「sha256 を持たず expectedBytes だけ持つファイルを
prefetch する」— manifest が size しか持たない下流では普通に起きる形。

実害は「200 OK で返る短い HTML エラーページ（プロキシ・認証壁）がそのまま無検証で
キャッシュに載る」ケース。self-heal で恒久化はしないが、`prefetchHfFile` の JSDoc を
読んだ利用者は「長さは見てくれている」と誤読しうる。

**修正案**:
1. ★ JSDoc を実態に合わせる（`spec.sha256` がある場合のみ包含であること、`expectedBytes`
   単独では prefetch 経路で一切照合されないことを明記）。ドキュメント修正のみ・非破壊。
2. cache 層 `PrefetchUrlOptions` に `expectedBytes`（**検証として**の長さ照合）を足し、
   通過中の `loaded` と突合して不一致なら sha256 不一致と同じ経路で put を潰す。
   TransformStream は既に `loaded` を数えている（src/mod.ts:627-634）ので実装は数行。
   ただし **docs/limitations.md:24-27 の「expectedBytes は確保ヒントであって検証ではない」
   という凍結済みの契約に真っ向から反する** ため、同じ名前で意味を変えるなら ADR 0005 の
   改訂が要る（別名 `verifyBytes` にするなら衝突しない）。cache 層マターなので本グループ
   の範囲外 — 提案のみ。
3. `prefetchHfFile` が `spec.validate` / `spec.expectedBytes` を検知したら「prefetch では
   走らない」と throw する。**非推奨** — 「spec を使い回して温める」という一番自然な
   使い方を潰す。

**リスク**: 案 1 はゼロリスク。案 2 は既存契約の再定義を伴うためリリース前に入れるなら
ADR 込み、入れないなら future-work 行き（`sha256FromHub` の構想が `size` を
`expectedBytes` に流用する前提で書かれているので、そちらと同時に裁定するのが自然）。

**対象**: src/hf/mod.ts:293-295（JSDoc）/ src/hf/mod.ts:317-326（転送している項目）/
docs/limitations.md:24-27・28-35（既存契約）。

**影響範囲**: 案 1 は docs のみ。案 2 は cache 層の公開 API 追加（後方互換）。

**引き継ぎ**: 案 1 の最小差分は `prefetchHfFile` の JSDoc NOTE を
「`spec.sha256` がある場合に限り `expectedBytes` は実質包含される。sha256 を宣言しない
prefetch は完全な無検証格納であり、`expectedBytes` も `validate` も走らない
（docs/limitations.md の TOCTOU 窓そのもの）」へ書き換えること。docs/limitations.md の
HF 層節にも 1 行足すのが望ましい。

**裁定**: (a) JSDoc + limitations の記述修正だけで閉じる ★ / (b) cache 層に長さ検証を
新設して HF 層から転送する（ADR 0005 改訂込み） / (c) future-work（paths-info 実装）へ
まとめて先送り。

---

### C-3 (W) — `prefetchHfFile` の戻り値が `boolean` のみで、解決した revision を呼び出し側へ返さない（新規 API の形の最終確認）

**概要**: `prefetchHfFile` は可変 ref を内部で解決する（src/hf/mod.ts:310-313）が、
戻り値は「取得したか」の boolean だけで、**どの SHA を温めたのかを呼び出し側が知る手段が
無い**。`prefetchHfFile({repo}, spec)`（ref = "main"）→ その後
`fetchHfFile({repo}, spec)` と呼ぶと、後者が再解決した SHA が prefetch 時と違えば
URL が変わってキャッシュは丸ごとミスし、**数 GB が `fetchBytes` 経路（全量ヒープ）で
再ダウンロードされる** — この機能が存在する理由（モバイルの RAM 超過クラッシュ）に
そのまま逆戻りする。発生条件は「可変 ref のまま prefetch し、温めと読み出しの間に
upstream の main が動く」。確率は低いが、起きたときの被害は機能の目的そのもの。

JSDoc（src/hf/mod.ts:300-303）と README:265-283 は「`resolveHfRevision` で 1 回解決してから
SHA を渡せ」と正しく誘導しているが、**規約ではなく作法**なので型では守られない。
`prefetchHfFile` が revision を返せば、正しい使い方が戻り値をそのまま次へ渡すだけになる。

**修正案**:
1. ★ 現状維持 + 誘導の強化。JSDoc の NOTE を「可変 ref で呼ぶと prefetch と後続の
   `fetchHfFile` で revision がずれうる（ずれたら丸ごと再取得になる）」という **リスクの
   明示**に格上げする。`prefetchUrl` の boolean と対称な単純さを保てる。
2. 戻り値を `{ fetched: boolean; revision: string; url: string }` に変える。**released 後は
   不可能な変更**なので、やるならこのリリースが最後の機会。誘導が型に落ちる代わりに、
   cache 層 `prefetchUrl`（boolean）との対称性を失い、「温めたか」を見るだけの呼び出しが
   冗長になる。
3. `prefetchHfFile` を SHA 固定 revision 専用にする（`isCommitSha(revision)` が false なら
   throw）。**非推奨** — 単発 prefetch の利便を落とすうえ、`fetchHfFile` は可変 ref を
   受けるので層内で契約が割れる。

**リスク**: 案 2 だけが破壊的（ただし未リリースの新規 API なので今なら無コスト）。
案 1・3 はリリース後も選べる／選べないの差がある点が判断材料。

**対象**: src/hf/mod.ts:305-327（シグネチャと revision 解決）/ src/hf/mod.ts:300-303
（NOTE）/ README.md:265-283。

**影響範囲**: 案 2 は `prefetchHfFile` の公開シグネチャ（下流は未使用 — v0.3.1 に存在
しないため破壊対象ゼロ）。

**引き継ぎ**: 案 2 を採るなら `prefetchUrl` は boolean のままで良い（cache 層は revision の
概念を持たない）。HF 層だけが「解決」という副産物を持つので、そこを返すのは層の責務として
一貫する。`fetchHfFile` / `fetchHfFiles` は戻り値が bytes なので同種の変更は不要。

**needs-human**: 「revision がずれる確率 × 被害」の重み付けはプロダクト判断（下流 yomi /
sbv2-web が可変 ref で prefetch する運用をするか）。レビュアーからは決められない。

**裁定**: (a) 現状維持 + JSDoc をリスク明示へ格上げ ★ / (b) 戻り値を
`{ fetched, revision, url }` に変える（今回が最後の機会） / (c) SHA 固定専用にする。

---

### C-4 (W) — 新経路（prefetchHfFile）で URL encode 契約と形式不正 sha256 の挙動が凍結されていない

**概要**: 前回レビュー E-B-1 の修正で凍結した percent-encode 契約
（revision 丸ごと encode / path はセグメント毎）は `hfResolveUrl` の単体テスト
（src/hf/mod.test.ts:56-67）で守られており、`prefetchHfFile` は同じ関数を同じ形で呼ぶ
（src/hf/mod.ts:315）ので **実装上は維持されている**。しかし prefetch 経路には
「特殊文字を含む path / slash 入り ref で、実際に叩かれる URL が encode 済みである」ことを
凍結するテストが無い（既存の prefetch テストはすべて `model.onnx` + `main`/SHA）。
将来 `prefetchHfFile` が URL 組み立てを内製化する（例: paths-info 対応で `hfResolveUrl` を
経由しなくなる）リグレッションを検出できない。

同様に、C-1 の非対称（大文字 hex が prefetch では即エラー・fetch では全量 DL 後エラー）も
HF 層のテストで固定されていない。cache 層には
`prefetchUrl: 形式不正の sha256 は network に出る前に fail loud`（src/mod.test.ts:1351-1363）
があるが、HF 層から流したときに `spec.sha256` がそのまま渡ることは未凍結。

**修正案**:
1. ★ 2 本追加する。
   - `prefetchHfFile: revision / path は encode されて network に渡る` —
     `mockFetch` の `calls` に `.../resolve/refs%2Fpr%2F1/sub%20dir/a%23b.bin` が
     出ることを assert（既存 :812-835 の init 転送テストと同じ骨格で書ける）。
   - `prefetchHfFile: 形式不正の sha256 は network に出る前に throw する` —
     `calls.length === 0` と `"64 桁の小文字 hex"` を assert（C-1 の案 1 を採るなら
     `fetchHfFile` 側も同じ assert で 1 本足す）。
2. 現状維持（`hfResolveUrl` の単体テストで十分と判断する）。

**リスク**: 追加のみ・既存 assert に触れない。ネットワークにも出ない（`mockFetch` DI）。

**対象**: src/hf/mod.test.ts:677-835（prefetch 群）/ 対照は src/hf/mod.test.ts:56-67
（encode 契約の凍結）と src/mod.test.ts:1351-1363（cache 層の形式ガード）。

**影響範囲**: テストのみ。

**引き継ぎ**: `mockFetch` は `calls`（URL 文字列配列）と `inits` を返すので、
`assertEquals(calls[1], "https://huggingface.co/owner/name/resolve/refs%2Fpr%2F1/…")` の形で
直接凍結できる。可変 ref を使うので mock は `/api/` 分岐（`Response.json({ sha: SHA })`）を
持たせること。

**裁定**: (a) テスト 2 本を追加する ★ / (b) 現状維持。

---

### C-5 (L) — `sha256Hex` の no-copy 最適化は「コピー 0」ではない（WebCrypto が仕様上 1 コピー取る）

src/hf/mod.ts:181-184 のコメントは「全量コピーしない — 数 GB 級ではコピー 1 回が一時 RAM を
倍増させる」と書くが、`crypto.subtle.digest` は仕様上 data の **コピーを取ってから**
Promise を返す（"get a copy of the bytes held by the buffer source"）。したがってこの変更が
削るのは 2 回あったコピーのうち 1 回であり、キャッシュヒット経路の一時ピークは
`new Uint8Array(await cached.arrayBuffer())`（N）+ digest 内部コピー（N）= **2N のまま**。
ADR 0005 の "2N → 1N" は明示的に「network 経路の JS ヒープ」に限った主張（ADR 0005:137）
なので矛盾はしておらず、読み出し経路の 2N を消す手段は `trustCachedSha256`（= digest を
そもそも呼ばない）として既に用意されている。**指摘は「コメントが得られた効果を過大に
読ませうる」という一点のみ**で、実装は正しい。

**needs-human**: 上記は W3C WebCrypto の仕様文言に基づく推論であり、Deno / 各ブラウザの
実装が本当に内部コピーを取るかは未実測（RSS 実測は取っていない）。実測で確認するなら
512MiB の bytes に対する `crypto.subtle.digest` 前後の RSS 差分を見ること。

**対象**: src/hf/mod.ts:181-184（コメント）/ src/hf/mod.ts:168-170（`isTightView`）。
判定は L（挙動は正しく、コメントの表現の問題）。

---

### C-6 (L) — `prefetchHfFile` は既存エントリがあっても必ず revision 解決リクエストを出す

可変 ref で呼ぶと、キャッシュが完全に温まっていても毎回 `/api/…/revision/{ref}` を叩く
（src/hf/mod.ts:310-313 → 解決してからでないと URL が定まらないため構造上不可避）。
オフライン起動時は「全ファイルがキャッシュ済みなのに prefetch が throw する」ことを
意味する。`fetchHfFile` も同じ構造（src/hf/mod.ts:264-267）なので新規の劣化ではなく、
JSDoc / README とも「SHA を 1 回解決して渡せ」と誘導済み。判定 L（既知構造の再確認）。

**対象**: src/hf/mod.ts:310-313 / src/hf/mod.ts:264-267。

---

## 横断所見

- **配線 3 本はすべて正しい**（深掘り観点 1 への回答）:
  `spec.sha256 → prefetchUrl.sha256`（src/hf/mod.ts:319）、
  `trustCachedSha256 → fetchBytes.verifiedMarker`（src/hf/mod.ts:241、`=== true` の明示比較で
  truthy 誤爆なし。`spec.sha256` 未宣言なら `undefined` に落ちるので印は焼かれない）、
  `spec.expectedBytes → fetchBytes.expectedBytes`（src/hf/mod.ts:239、確保ヒントとしてのみ）。
  取り違え・条件の食い違いは無い。prefetch が焼く印と `trustCachedSha256` が期待する印が
  **同一の `spec.sha256` 文字列**である点が一気通貫の要で、テスト（src/hf/mod.test.ts:708-738）が
  digest 呼び出し 0 回でこれを凍結している。
- **公開 API 互換（深掘り観点 5）**: `HfFileSpec` はフィールド追加すら無し、`HfFetchOptions`
  への `trustCachedSha256?: boolean` は optional 追加で既定 false 相当、追加 export は
  `prefetchHfFile` / `HfPrefetchOptions` のみ。v0.3.1 の型に対して構造的後方互換。
  `deno test src/hf/mod.test.ts` = 34 passed / 0 failed（実行確認済み）。
- **`HfPrefetchOptions` と `HfFetchOptions` の構造的互換に注意**: `HfFetchOptions` 型の変数を
  そのまま `prefetchHfFile` に渡すと TS の余剰プロパティ検査は効かず（フレッシュな
  オブジェクトリテラルではないため）通ってしまい、`trustCachedSha256` と `onCacheError` が
  黙って無視される。どちらも prefetch では意味を持たない（前者は読み出し時のオプション、
  後者は縮退しない設計）ので実害は無いが、README の例が両者を別々に書いているのは正しい。
  指摘化はしない（情報共有のみ）。
- **前回 W-C-4（Actions SHA pin）**: 未対応のまま。指示どおり再指摘はしない（現状報告のみ）。
- **findings 出力先の異常**: 指示された出力パスが
  `undefined/findings/group-C-hf.md`（テンプレート変数 `undefined` が未展開）だったため、
  リポジトリ直下に `undefined/` ディレクトリを作って書き出している
  （`/home/developer/workspace/fetch-cache/undefined/findings/group-C-hf.md`）。
  本来は `.claude/reviews/<日付>_<短縮ハッシュ>/` 配下が規約（sop-review）。
  **オーケストレータ側で移動 or 削除すること**（git 追跡外の掃除が必要）。
