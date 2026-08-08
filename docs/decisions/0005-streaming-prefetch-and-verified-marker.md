# 0005 — 巨大アセットの RAM ピーク削減: 事前確保・streaming prefetch・検証済みマーカー

- 日付: 2026-08-08
- 状態: 採用
- 関連: [0001](0001-cache-io-degrade-with-notification.md)（cache I/O 縮退）/
  [0004](0004-single-flight-raw-sharing.md)（single-flight は raw 共有）

## Context

数 GB 級のモデルを取得する下流（WebGPU 推論スタック）から、モバイルブラウザがダウンロード
途中（約 80%）で RAM 超過クラッシュするという報告があった。当時の実装では 1 ファイルにつき
JS ヒープを最大 2N 使っていた。

- 受信: チャンクを配列に溜め、最後に `new Uint8Array(loaded)` を確保して連結する
  → 連結の瞬間に N + N。
- 保存: `cache.put(url, new Response(bytes))` の `new Response(bytes)` が全量コピーする
  （Deno 2.9.4 実測: 512MiB の Response 生成だけで RSS が +512MiB）→ ここでも N + N。

加えて「キャッシュヒット毎に sha256 を全量再計算する」（ADR 0038 相当の下流方針）ため、
起動毎に数 GB のハッシュ計算が走っていた。

## Decision

### 1. 受信バッファの事前確保（既定経路・非破壊）

サイズが分かるときは 1 本の `Uint8Array` を先に確保し、チャンクを直接書き込む。サイズ源は
新オプション `FetchBytesOptions.expectedBytes`（HF 層は `HfFileSpec.expectedBytes` を
そのまま転送）、無ければ content-length。

- **申告は確保ヒントであって検証には使わない**。超過して届いたら従来の蓄積経路へ落ち、
  不足していたら実長へ詰め直す。「`loaded` と content-length を突合しない」という既存方針
  （docs/limitations.md）は維持する — ヒントが外れても取得は落とさない。確保自体に失敗する
  申告（巨大な content-length 等）も同様に蓄積経路へ落とす。
- 戻り値は常に buffer 全体を占める tight view（下流の `bytes.buffer` zero-copy 前提を壊さない）。

### 2. 保存 Response は 1 チャンクの stream で組む

`new Response(bytes)` の全量コピーを避けるため、`bytes` を 1 チャンクだけ流す
`ReadableStream` として `cache.put` に渡す（Deno 2.9.4 実測で RSS 増分が +512MiB → +4MiB）。
格納内容・格納後の読み出しは完全に同じで、公開挙動の変化は無い。1 と合わせて network 経路の
ヒープを 1N に保つのが目的。

### 3. streaming prefetch（新規 export `prefetchUrl`）

network 応答の body を**そのまま `cache.put` へ流す**新 API を追加する。全量を JS ヒープに
載せないので、数 GB のアセットでもヒープ使用はチャンク数個ぶんで済む。既存 `fetchBytes` の
意味論は 1 バイトも変えない（追加 export のみ）。設計判断は 3 点:

- **(a) 検証しない = 未検証バイトが一時的にキャッシュへ載る（TOCTOU）**。prefetch は
  バイト列を手元に持たないため `validate` を走らせられない。検証は読み出し側
  （`fetchBytes` の validate → 失敗なら evict → 取り直し = self-heal）へ一本化する。
  汚染は self-heal で解消するので恒久化しない。この選択の代わりに「通過中のインクリメンタル
  sha256」を持てば未検証バイトを一度も置かずに済むが、**実行時依存ゼロ MUST** の下では純 TS
  実装を抱える必要があり（実測で native の約 1/5 の速度）、下流はどのみち検証時点で全量
  バッファを作るため、そこに native の一括 digest を当てる方が速い。よって不採用。
  なお「明らかに違う物」を書く前に弾きたい呼び出し側は、`init` に渡す fetch 実装側で
  受信バイトを監視すればよい（転送中断は put の reject としてそのまま伝播する）。
  **→ 2026-08-08 に §5 で撤回**（純 TS の逐次 sha256 を採用し、opt-in の通過中検証を入れた）。
- **(b) single-flight の対象外**。ADR 0004 の合流契約は「leader の保存形 raw を合流者へ
  渡す」ことが本体だが、streaming の leader は raw を持たない。合流させるなら「合流者は
  cache から各自 materialize する」へ意味論を変えることになり、`fetchBytes` の既存契約
  （合流者は leader と同じ raw インスタンスを受け取る）を released API のまま書き換えて
  しまう。prefetch は冪等（内容同一の last-writer-wins）で、重複しても正しさは壊れない
  ため、`cache: false` と同じ割り切りで**合流しない**方を採る。逐次利用（prefetch →
  後で fetchBytes）では既存エントリ検査で network に出ないので、実害は「同一 URL を並行
  prefetch した場合の二重 DL」だけ。
- **(c) put 失敗は縮退せず fail loud**。ADR 0001 の「put 失敗でもダウンロードを落とさない」は
  「手元に成功したバイト列がある」ことが前提であり、prefetch には手元にバイトが無い。
  キャッシュへの格納が唯一の仕事なので、失敗を握って成功を装うのは誤り。quota 超過も転送
  中断も `cache.put` の reject として現れるため、原因を `cause` に付けて throw し、呼び出し側は
  `fetchBytes` へフォールバックする（そちらは全量をヒープに載せる代わりに ADR 0001 の縮退が
  効く）。同じ理由で `caches` 不在・`open` 失敗・HTTP エラーも throw する。転送が途中で
  切れた場合、Deno 実測では `cache.put` が reject してエントリは成立しない（中途半端な
  エントリは残らない）。

### 4. 検証済みマーカー（opt-in）

`FetchBytesOptions.verifiedMarker` を指定すると、network 取得物の `validate` 通過後に
その文字列をキャッシュエントリのヘッダ（`x-fetch-cache-verified`）へ焼き、以後のヒットで
印が一致したときだけ `validate` を省く。HF 層は `HfFetchOptions.trustCachedSha256` で
`spec.sha256` を印として渡す。

- **既定挙動は不変**（未指定ならヒット毎に検証）。印を信じるかどうかは呼び出し側の選択。
- **信頼境界**: 印は「保存時に validate を通った」という自己申告に過ぎず、**ローカル格納を
  信頼する**という判断そのものである。格納後の改竄・ビット腐敗は印ごと書き換えられるので
  検出できない。だから既定にはしない。
- 印は「`validate` 全体の通過」を意味する（HF 層なら expectedBytes / sha256 / カスタム
  validate の全部）。同じ URL に別の検証ロジックを当てるなら印も変える。
- 印が付くのは「このオプション付きで network 取得して保存した」エントリだけ。既存エントリや
  `prefetchUrl` が書いた（未検証の）エントリには付かないので、そこでは通常どおり検証が走る
  （§5 で `prefetchUrl` の `sha256` 指定時のみ例外を追加）。single-flight の合流者も印を
  見ない（常に自分の validate を走らせる = 安全側）。

### 5. prefetch の通過中 sha256 検証（2026-08-08 追補。§3(a) の「検証しない」を撤回）

`prefetchUrl` に任意オプション `sha256`（64 桁小文字 hex）を追加し、指定時は body を素通し
する TransformStream の中でチャンク毎に**逐次ハッシュ**して flush で突合する。HF 層には
同じ口として `prefetchHfFile` を追加し、`HfFileSpec.sha256` があれば自動でこの経路に流す。

**なぜ §3(a) を撤回したか**: 当時は「純 TS 実装は native の約 1/5 で遅い」を不採用の理由に
挙げたが、比較の対象を取り違えていた。prefetch が律速されるのは回線であって CPU ではない
（下流実測 10〜84 MB/s に対し、純 TS の逐次実装は開発機実測 212 MB/s — native 一括は
810 MB/s）。つまり「native より遅い」ことは prefetch 経路では観測されない。一方で得られる
ものは大きい:

- **未検証バイトがキャッシュに載る窓（TOCTOU）が消える**。§3(a) が残した唯一の穴だった。
- **印を焼ける**ようになり、「prefetch で温める → 起動時に `fetchBytes` で読む」の全経路で
  全量ハッシュが 1 回も走らなくなる（従来は prefetch 分が無検証なので、初回読み出しで必ず
  数 GB を再ハッシュしていた）。

**不正な印付きエントリが構造的に生まれない**ことを設計の要にした。印（`x-fetch-cache-verified`
ヘッダ）は `cache.put` へ渡す Response の構築時点で焼き、ハッシュ不一致は `controller.error()`
で stream ごと落とす。put は必ず reject し、エントリは成立しない — 「印だけ先に付いた不正
エントリ」を作る手順が存在しない。念のため put が解決してしまった場合（stream の error を
無視する Cache 実装）に備えてエントリを削除してから throw する保険も置く。エラーは期待値と
実測値の両方を含め、cache I/O 失敗のラップメッセージには埋もれさせない（fetchBytes への
フォールバックは無意味 — 真実源側が違うため）。

**fetchBytes 側は native の一括 digest のまま**（変更なし）。あちらは materialize 済みの
tight view が手元にあり、そこへ native を当てるのが最速。純 TS 実装は「バイト列を手元へ
materialize しない経路」という制約が生む必要悪であり、置ける場所には置かない。

**印の意味が prefetch 経路だけ弱い**（判断つき）: §4 の印は「`validate` 全体の通過」を意味
するが、prefetch が焼く印は sha256 の一致だけを主張する。HF 層で `spec.validate`（カスタム
検証）を宣言しつつ `trustCachedSha256: true` で読むと、そのカスタム検証は prefetch 済み
エントリのヒットで省かれる。sha256 一致はバイト同一を含意するので実害は「宣言そのものが
食い違っていた場合」に限られると判断し、印を分けるより単純さを採った（`expectedBytes` も
同じ理由で実質包含される）。

`prefetchHfFiles`（複数ファイル版）は入れない: `fetchHfFiles` の存在意義は revision 解決の
共有と並列取得だが、prefetch の対象は数 GB 級であり並列化は帯域の奪い合いにしかならない。
`resolveHfRevision` で 1 回解決 → SHA 固定の `revision` で `prefetchHfFile` を必要な順に
呼べば、並行度の選択は呼び出し側に残る。

## Consequences

- network 経路の JS ヒープが 2N → 1N（1 と 2 の合わせ技）。`prefetchUrl` を使えば ~0 まで
  落とせる（`sha256` を渡せば検証込みで ~0 のまま）。
- 未検証バイトがキャッシュに載る窓は `sha256` 未指定の prefetch にだけ残る。その場合
  self-heal が唯一の回復手段なので、`validate` を読み出し側で必ず渡すことが前提になる。
- `sha256` 付き prefetch で温めたエントリは印付きなので、`verifiedMarker` /
  `trustCachedSha256` と組み合わせると「温める → 読む」の全経路で全量ハッシュが 1 回も
  走らない。逆に「初回 materialize の検証後に印だけ書き足す」機構は N バイトの再 put を
  伴うため今回も入れない（要望が出たら別途裁定）。
- 実行時依存ゼロのまま純 TS の SHA-256 実装（`src/sha256.ts`）を抱えることになった。正しさは
  native の一括 digest との差分テスト（境界サイズ × ランダム分割位置）で凍結している。
- ブラウザの `CacheStorage.put` が stream body を逐次ディスクへ書くかは未検証（本リポの自動
  テストは Deno のみ — docs/limitations.md）。Deno 2.9.4 では 512MiB の stream put で RSS
  増分 74MB を実測しており全量バッファはしない。ブラウザ実機で全量バッファする実装が
  あれば `prefetchUrl` の利得はその環境で消える（正しさは変わらない）。
