# Limitations — 意図的な制約（by-design）

バグではなく設計判断による制約。変更する場合は該当 ADR（docs/decisions/）を差し替えること。

## cache 層

- **single-flight なし**: 同一 URL への並行 `fetchBytes` は合流せず、それぞれ network に出る
  （二重ダウンロード）。put は last-writer-wins で内容同一のため整合性は壊れない
  （検証済み: .claude/reviews/2026-07-10_b5ccf62 verify-A V1）。in-flight 合流は今後の
  バージョンで導入予定（ユーザー判断 2026-07-10）。それまでの重複抑止は呼び出し側の責務。
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
