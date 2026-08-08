# Limitations — 意図的な制約（by-design）

バグではなく設計判断による制約。変更する場合は該当 ADR（docs/decisions/）を差し替えること。

## cache 層

- **single-flight は cache 有効の GET のみ**（0.3.0 で導入 — DECIDED: docs/decisions/0004）。
  `cache: false` の並行呼び出しは合流せずそれぞれ network に出る（「毎回取りに行く」意図と
  非 GET の非冪等性を尊重。put は last-writer-wins で内容同一のため整合性は壊れない）。
  合流キーは (cacheName, URL) のみで、**合流者の `fetch` / `caches` / `init` /
  `onCacheError` は使われない**（取得は先行呼び出しのオプションで走る。認証ヘッダ違いを
  区別しないのはキャッシュキーが URL のみの設計と同じ割り切り）。取得失敗は合流全員へ
  伝播する。
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
- **`prefetchUrl` は検証せず、縮退もしない**（DECIDED: docs/decisions/0005）。body を
  そのまま cache へ流すためバイト列を手元に持てず、`validate` を走らせられない。検証は
  読み出し時（`fetchBytes`）の self-heal に一本化する＝**未検証バイトが一時的にキャッシュへ
  載る**（次の読み出しで evict されるので恒久化しない）。`caches` 不在・open 失敗・HTTP
  エラー・転送中断・put 失敗（quota 等）はすべて throw する（手元にバイトが無く「続行」に
  意味が無いため。ADR 0001 の縮退契約は `fetchBytes` 専用）。
- **`prefetchUrl` は single-flight の対象外**（DECIDED: docs/decisions/0005）。合流契約
  （ADR 0004）は leader の保存形 raw を共有することが本体で、streaming の leader は raw を
  持たない。同一 URL の並行 prefetch はそれぞれ network に出る（内容同一の
  last-writer-wins で整合性は壊れない）。
- **検証済みマーカーはローカル格納を信頼する opt-in**（`verifiedMarker` /
  HF 層 `trustCachedSha256`。DECIDED: docs/decisions/0005）。既定はヒット毎の全量検証で不変。
  印は「保存時に validate を通った」という自己申告であり、格納後の改竄・ビット腐敗は検出
  できない。印が付くのは opt-in で network 取得したエントリだけで、既存エントリ・
  `prefetchUrl` が書いたエントリ・single-flight の合流者は通常どおり検証する。
- **decode 後（利用形）はキャッシュしない**: cache に入るのは常に保存形 raw で、`decode` は
  毎呼び出し実行される（storage 節約と引き換えの CPU コスト。トレードオフの選択は
  呼び出し側 — DECIDED: docs/decisions/0003）。また `validate` は decode 併用時も保存形
  raw に対して走る（利用形側の検証は decode 内で throw する）。

## HF 層

- **`fetchHfFiles` の部分キャッシュ**: 1 ファイルの失敗で全体が reject するが、成功済み
  ファイルのキャッシュ書込みは取り消されない（リトライは即ヒット。テストで凍結済み）。
- **revision 解決は HF の実装挙動依存**: `/api/{kind}/{repo}/revision/{ref}` が
  `{"sha": …}` を返すのは仕様保証ではない（応答に sha が無ければ throw）。

## ランタイム

- **Deno 2.8 以前では `listCachedUrls` が throw**: `Cache.keys()` 未実装のため、実在
  エントリを空一覧と偽らず fail-loud に throw する。Deno 2.9+ は `keys()` 実装済みで
  `listCachedUrls` も動く（`fetchBytes` のキャッシュ・`evictUrl` / `clearCache` は
  全バージョンで動く）。
- **自動テストは Deno のみ**: ブラウザ実環境での CI は無い（ランタイム対応表のブラウザ挙動は
  Web 標準仕様に依拠）。
