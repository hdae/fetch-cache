# 設計検討ブリーフ: sha256 有無による二戦略完全分離（Design R）

対象リポジトリ: /home/developer/workspace/fetch-cache（@hdae/fetch-cache — Deno/ブラウザ両対応、
Web 標準のみ・実行時依存ゼロ MUST・fail loudly。0.4.0 は JSR 公開済みで下流 yomi / sbv2-web が
依存。0.5.0 は未リリースで、コミット ffc8bef に「配列 key」再設計が実装済み・テスト 139 緑）。

オーナーの問題意識（原文要旨）: 「一番の失敗は sha256 が指定されている場合と指定されていない
場合のケースをしっかり分けなかったこと。戦略を完全に別にすべきだった。sha256 指定時は 1:1 で
対応付けられ、URL は SHA256 にヒットしなかった場合の取得元。それ以外は 304 に頼り、URL が
キャッシュのキーになる。ほぼリブートになっても OK」。

## 現行 0.5.0（ffc8bef）の要約

- `fetchBytes(url, opts)`: `key?: CacheKey`（配列。単射直列化して予約 origin
  `https://fetch-cache.invalid/v1/` 配下の合成 URL に格納）、無指定なら URL がキー。
- `sha256` は**キーと直交**する完全性オプション: DL 時検証 + `x-fetch-cache-sha256` ヘッダに記録、
  ヒット時は記録との文字列比較のみ（既定 trust）、`recheck: true` で再ハッシュ。破損は
  evict → network の self-heal。
- 鮮度: 未実装。`revalidate`（条件付き GET）は「将来のフラグ」として予約のみ（ADR 0006）。
- 管理 API: `evict(prefix)` / `listKeys(prefix)`（配列プレフィックス、セグメント境界厳密）、
  `evictUrl` / `listCachedUrls` / `clearCache`。
- HF 層: `spec.sha256` あり → 既定キー `["hf", kind, repo, path, sha256]`（revision 跨ぎで
  ヒット・共存）。無し → SHA 固定 resolve URL がキー。`spec.key` で上書き可 — ここに
  「内容識別を含まない安定キー + sha256 = ピンポン / sha256 無し = stale 固着」という
  **文書化必須の脚砲**が存在する（ADR 0006 §5）。
- その他インフラ: single-flight（join キー = ストレージキー）、streaming prefetch（純 TS
  incremental sha256 で通過中検証）、readBody（ADR 0007: 明示 expectedBytes の確保失敗は
  body cancel + throw）、`cache: false` はキャッシュ完全バイパス。

## Design R（リブート案）: 二つの戦略を型で分ける

**Mode A — 内容モード（sha256 指定時）**
- ストレージキー = sha256 そのもの（例: `https://fetch-cache.invalid/v1/sha256/<hex>`）。
  URL は「ミスしたときの取得元」に降格。1 内容 = 1 エントリ（URL・repo・ミラー横断で dedup）。
- 完全性: DL 時にハッシュ検証してから格納（キー自体が記録なので `x-fetch-cache-sha256`
  ヘッダは不要になる）。ヒット時は既定 trust、`recheck` で再ハッシュ。
- 鮮度: 概念ごと消滅（内容は不変。更新 = 呼び出し側が別の sha256 を渡す）。
- 取得元メタデータ（最後に取得した URL 等）はエントリのヘッダに焼けば一覧・デバッグに使える。

**Mode B — URL モード（sha256 無し）**
- ストレージキー = URL（現行と同じ）。
- 鮮度: HTTP セマンティクス。`revalidate` で条件付き GET（stored ETag/Last-Modified →
  If-None-Match）→ 304 なら手元を返す、200 なら上書き。オーナーの 3 モード整理
  （ノーヒント / 304 / HashSum）のうちノーヒント = B1、304 = B2（フラグ）、HashSum = Mode A。
- 完全性: `validate` / `expectedBytes` のみ（ハッシュ同一性は無い）。

**共通で消えるもの**: 公開 `key` オプション・配列キー直列化一式・`listKeys/evict(prefix)`・
`HfFileSpec.key`・キー粒度ポリシー文書（§5 の脚砲は**構造的に消滅** — ピンポンも stale 固着も
表現不能になる）。
**残るもの**: single-flight・readBody/ADR 0007・self-heal・recheck・streaming prefetch
（Mode A は通過中ハッシュ検証して hash キーへ格納）・HF resolve 層・decode/validate/
expectedBytes・onProgress/onCacheError・DI（fetch/caches）。
**HF 層**: sha256 あり → Mode A（キーは裸の sha256。repo/path すら不要 = クロス repo dedup）。
無し → SHA 固定 resolve URL で Mode B1（不変 URL なので revalidate 不要）。
**管理 API 案**: `evictSha256(hash)` / `evictUrl(url)` / `clearCache()` /
`listCached(): { mode, key, sourceUrl?, storedAt? }[]`（メタデータヘッダ起点）。

## Design C（参考・折衷）: リブートせず収束

現行基盤の上で公開 `key` を撤去し、sha256 指定時の既定キーを `["sha256", <hex>]` に変え、
revalidate を実装する。エンドポイントは R とほぼ同じだが、汎用配列キー機構が内部に残る
（simplicity-first 的には死んだ一般性）。

## 制約・評価軸

- Web 標準のみ / Cache API が土台（2 エントリ書き込みのトランザクションは無い）。
- テストはネットワーク禁止（fetch DI）。fail loudly（縮退は self-heal と onCacheError のみ）。
- 下流 2 プロジェクトは 0.4.0 API から移行する（0.5.0 が breaking なのは既定路線）。
- オーナーの用途の主戦場: HF の数 GB モデルファイル（sha256 は LFS メタデータで既知）。
  1 GiB 分割運用。起動毎の全量ハッシュ回避が重要。
- 将来軸: lifecycle（未使用 1 週間で削除等の GC）が ADR 予定。CAS + メタデータは GC と好相性か。
