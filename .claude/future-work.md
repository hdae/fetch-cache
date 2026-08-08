# 将来実装のメモ（余力があれば）

## paths-info API による sha256 の自動取得（2026-08-08 起票・ユーザー裁定「将来的に実装」）

HF の `POST /api/{models|datasets|spaces}/{repo}/paths-info/{revision}` は、複数 path を
1 リクエストで問い合わせでき、**LFS ファイルなら `lfs.oid` = content sha256** と `size` を返す
（実測確認済み: hdae/anima-turbo の vae_decoder で manifest の sha256 と完全一致）。

構想:

- `fetchHfPathsInfo(ref, paths, opts)` — バッチでメタデータ取得（LFS: sha256 + size / 非 LFS:
  git oid のみで content sha256 は**無い**）。
- `prefetchHfFile` に opt-in（例 `sha256FromHub: true`）: spec に sha256 が無いとき paths-info
  から取得して通過中検証へ流し、`size` を `expectedBytes` にも流用。非 LFS は無検証 prefetch へ
  縮退（または fail loud を選択制に）。

設計メモ:

- **ヘッダ経路（`x-linked-etag`）は使わない**: 値は同じ sha256 だが 302 応答のヘッダであり、
  ブラウザの fetch はリダイレクト追跡後の最終応答しか見せない（302 のヘッダは読めない）。
  paths-info は素の 200 JSON なので全ランタイムで動く。
- **信頼境界**: サーバ申告のハッシュで検証するため、証明できるのは転送の完全性まで
  （配布者宣言のハッシュより弱い）。docs に明記すること。
- コストは 1 POST（TTFB ~0.7s）で GB 級 DL の前段としては誤差。
- 見積り: ~150 行 + テスト（Opus 1 波の半分程度）。

背景: karume は manifest に sha256 を持つため恩恵が無い（起票時の判断で karume 向けには
実装しない）。恩恵があるのは manifest を持たない素の利用者（yomi / sbv2-web 等）。

## 純 TS SHA-256（src/sha256.ts）の置換条件（2026-08-08 裁定「温存」）

WebCrypto の `crypto.subtle.digest` は全量一括専用で、streaming（update/finalize 型）は
Web 標準に存在しない — これが純 TS 実装を持つ唯一の理由（prefetch の通過中検証は全量を
ヒープに置けない）。**Web 標準に streaming digest が入ったら、純 TS を削除してそちらへ
置換する**のが正しい手。スループットは問題にならないことを実測済み（純 TS 212 MB/s ≫
prefetch 経路の実効下り 10〜84 MB/s — 常に回線律速）。materialize 済みバイト列の検証は
従来どおり native 一括（810 MB/s）を使い続けること。
