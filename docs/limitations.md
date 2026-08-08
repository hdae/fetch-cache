# Limitations — 意図的な制約（by-design）

バグではなく設計判断による制約。変更する場合は該当 ADR（docs/decisions/）を差し替えること。

## cache 層

- **single-flight は cache 有効の GET のみ**（0.3.0 で導入 — DECIDED: docs/decisions/0004）。
  `cache: false` の並行呼び出しは合流せずそれぞれ network に出る（「毎回取りに行く」意図と
  非 GET の非冪等性を尊重。put は last-writer-wins で内容同一のため整合性は壊れない）。
  合流キーは (cacheName, URL) のみで、**合流者の `fetch` / `caches` / `init` /
  `onCacheError` / `expectedBytes` / `verifiedMarker` は使われない**（取得は先行呼び出しの
  オプションで走る。認証ヘッダ違いを区別しないのはキャッシュキーが URL のみの設計と同じ
  割り切り）。印を焼くのも leader の `verifiedMarker` だけで、合流者の指定は読み出し
  （ヒット時に検証を省くかの判定）・書き込み（焼く印の内容）とも使われない。取得失敗は
  合流全員へ伝播する。
- **非 GET はキャッシュ非対応**: Cache API は GET しか格納できない。cache 有効 + 非 GET は
  fail-loud に throw する（`cache: false` で素の fetch は可）。POST 応答のキャッシュは
  スコープ外（DECIDED: docs/decisions/0002）。
- **キャッシュキーは URL のみ（認証非対応）**: `init` のヘッダはキーに影響しない。認証付きで
  取得した bytes は、以後認証なしの呼び出しでもヒットする（ローカル単一ユーザーのキャッシュ
  としては妥当。DECIDED: docs/decisions/0002）。
- **`loaded` と `content-length` の突合はしない**: Fetch 仕様上 Content-Length は信頼できず
  （Content-Encoding 越しでは解凍後サイズと不一致が正常）、突合は誤検知バグになる。真の
  切断は stream エラーで throw 済み。整合性検証は `validate`（HF 層の sha256 /
  expectedBytes）に委譲する。
- **`expectedBytes` / content-length は確保ヒントであって検証ではない**（DECIDED:
  docs/decisions/0005）。受信バッファを事前確保して RAM ピークを 1N に抑えるためだけに使い、
  申告と実受信がずれても取得は落とさない（超過なら蓄積経路へ、不足なら実長へ詰め直す）。
  長さの検証がしたいなら `validate`（HF 層の `expectedBytes`）で行う。
- **`prefetchUrl` の検証は `sha256` 指定時のみ・縮退はしない**（DECIDED:
  docs/decisions/0005 §5）。body をそのまま cache へ流すためバイト列を手元に持てず、
  `validate` フックは走らせられない。唯一の例外が `sha256`（64 桁小文字 hex）で、指定時は
  通過中に逐次ハッシュして突合し、一致したものだけがエントリとして成立する（同時に検証済み
  マーカーが焼かれる）。**未指定なら未検証バイトが一時的にキャッシュへ載る**（読み出し時の
  self-heal で evict されるので恒久化しない）。`caches` 不在・open 失敗・HTTP エラー・転送
  中断・put 失敗（quota 等）・sha256 不一致はすべて throw する（手元にバイトが無く「続行」に
  意味が無いため。ADR 0001 の縮退契約は `fetchBytes` 専用）。
- **prefetch が見る検証指定は `sha256` だけ**（DECIDED: docs/decisions/0005 §5）。
  `prefetchHfFile` に `spec.expectedBytes` / `spec.validate` を渡しても prefetch では
  使われない（バイト列を手元に持たないため。どちらも `fetchHfFile` で読み出すときには
  通常どおり効く）。
- **prefetch は既存エントリを検証しない**（DECIDED: docs/decisions/0005 §5）。
  `prefetchUrl` / `prefetchHfFile` はエントリがあれば network に出ない（`prefetchUrl` は
  false、`prefetchHfFile` は `fetched: false` を返す）ため、
  `sha256` を渡しても既存の内容は照合されない（温める API であって検査する API ではない）。
  既存の内容を疑うなら `fetchBytes`（self-heal 付き）か `evictUrl` を使う。
- **`prefetchUrl` は single-flight の対象外**（DECIDED: docs/decisions/0005）。合流契約
  （ADR 0004）は leader の保存形 raw を共有することが本体で、streaming の leader は raw を
  持たない。同一 URL の並行 prefetch はそれぞれ network に出る（内容同一の
  last-writer-wins で整合性は壊れない）。
- **検証済みマーカーはローカル格納を信頼する opt-in**（`verifiedMarker` /
  HF 層 `trustCachedSha256`。DECIDED: docs/decisions/0005）。既定はヒット毎の全量検証で不変。
  印は「保存時に validate を通った」という自己申告であり、格納後の改竄・ビット腐敗は検出
  できない。印が付くのは opt-in で network 取得したエントリと `sha256` 付き prefetch が
  通したエントリだけで、既存エントリ・無検証 prefetch が書いたエントリ・single-flight の
  合流者は通常どおり検証する。
- **prefetch 由来の印は sha256 の一致だけを主張する**（DECIDED: docs/decisions/0005 §5）。
  `fetchBytes` 側の印は `validate` 全体の通過を意味するが、prefetch はハッシュしか計算して
  いない。HF 層で `spec.validate`（カスタム検証）を宣言しつつ `trustCachedSha256: true` で
  読むと、そのカスタム検証は prefetch 済みエントリのヒットで省かれる（sha256 一致 = バイト
  同一なので、実害は宣言そのものが食い違っていた場合に限られるという判断）。
- **decode 後（利用形）はキャッシュしない**: cache に入るのは常に保存形 raw で、`decode` は
  毎呼び出し実行される（storage 節約と引き換えの CPU コスト。トレードオフの選択は
  呼び出し側 — DECIDED: docs/decisions/0003）。また `validate` は decode 併用時も保存形
  raw に対して走る（利用形側の検証は decode 内で throw する）。

## HF 層

- **`fetchHfFiles` の部分キャッシュ**: 1 ファイルの失敗で全体が reject するが、成功済み
  ファイルのキャッシュ書込みは取り消されない（リトライは即ヒット。テストで凍結済み）。
- **prefetch の複数ファイル版は無い**（DECIDED: docs/decisions/0005 §5）。`prefetchHfFile`
  のみを提供する。数 GB 級の並列 prefetch は帯域の奪い合いにしかならないため、並行度の選択は
  呼び出し側に残す（`resolveHfRevision` で 1 回解決 → `revision` に SHA を渡して必要な順に
  呼ぶ）。
- **revision 解決は HF の実装挙動依存**: `/api/{kind}/{repo}/revision/{ref}` が
  `{"sha": …}` を返すのは仕様保証ではない（応答に sha が無ければ throw）。

## ランタイム

- **Deno 2.8 以前では `listCachedUrls` が throw**: `Cache.keys()` 未実装のため、実在
  エントリを空一覧と偽らず fail-loud に throw する。Deno 2.9+ は `keys()` 実装済みで
  `listCachedUrls` も動く（`fetchBytes` のキャッシュ・`evictUrl` / `clearCache` は
  全バージョンで動く）。
- **自動テストは Deno のみ**: ブラウザ実環境での CI は無い（ランタイム対応表のブラウザ挙動は
  Web 標準仕様に依拠）。
