# ROADMAP — v0.5.0 リリース時点の見送り事項

裁定済み（2026-08-28 オーナー）: いずれも 0.5.0 には入れない。

## 0.6.0 候補（機能）

- **revalidate（条件付き GET）**: ADR 0008 §4 で予約のみ。Cache API のヘッダ全置換制約・
  Vary・single-flight 合流者の鮮度非決定を含む専用 ADR が必要。
- **HF 層「sha256 後付け」の内容キー移送**（優先度: 中 / 発生は spec 更新後の初回 1 回）:
  spec に sha256 を後から足すとキーが resolve URL → 内容キーへ変わり、現状は 1 回再 DL。
  内容キー miss 時に resolve URL キーの既存エントリを読み、ハッシュ検証して内容キーへ
  put する「migration 読み出し」で network ゼロにできる（backfill と同じコスト構造）。
- **寿命軸（TTL / LRU / last-used GC）**: ADR 0006 §3 でスコープ外宣言済み。

## 品質・小粒（レビュー由来の見送り）

- backfill TOCTOU の窓縮小（put 直前の re-match — 現状は limitations に last-writer-wins を
  文書化のみ）/ 合流者（leader sha256 無し × 合流者有り）の backfill / 管理 API has→open の
  並行 clearCache 競合（空名前空間の再作成）/ readBody body===null 経路の buffer 解放
  （2N ピーク・0007 由来の既存挙動）/ README サンプルの runnable 化・prefetch 読み出し側
  materialize の注記強化 / 0.4.0 期の予約 origin 直書きエントリの管理導線（極小エッジ）。
- テストギャップ残（第 1 回レビュー TS-006/007/009・TS-010〜014）: crypto.subtle 不在 /
  keys() 未実装ランタイムの evict・listKeys / fetchBytes 転送中断 / 診断性リファクタ等。

## 再検討トリガ

- LFS 型 2 層モデル（裸 sha256 キー CAS）: repo 単位掃除・GC 要件が「sha リスト + GC」へ
  収束したら再評価（design-study/ の 3 レッグ結論を前提に）。
- 「安定キーで有界ストレージ」要求が実在したら、汎用 `key` の復活ではなく専用オプションで
  （ADR 0008 §1）。
