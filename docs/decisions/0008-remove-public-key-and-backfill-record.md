# 0008 — 公開 `key` オプションの撤去・記録ハッシュの backfill・レビュー修正の採否

- 日付: 2026-08-28
- 状態: 採用（2026-08-28 オーナー承認。0.5.0 リリース前に 0006 実装（ffc8bef）へ適用）
- 関連: [0006](0006-cache-control-redesign.md)（本 ADR が一部を改定する）/
  [0005](0005-streaming-prefetch-and-verified-marker.md)（記録の意味論）

## Context

0006 実装後のレビュー（`.claude/reviews/2026-08-25_ffc8bef/`）と並行して、オーナーから
「sha256 の有無で戦略を完全分離する再設計（キー = 裸 sha256 の内容モード + URL キー + 304 の
URL モード。ほぼリブート）」の検討要求が出た。3 レッグの設計検討（redteam / steelman /
ergonomics、同ディレクトリ `design-study/`）は次の点で収束した:

- 主戦場（HF 取得・prefetch）の呼び出しコードはリブート案と現行で**同一** — 便益の実体は
  「公開 `key` の撤去」と「revalidate の実装」だけで、どちらも現行基盤の上で取れる。
- リブート案固有の要素は損な取引: 裸 sha256 キーは repo 単位の掃除・将来の GC
  （last-used 記録）を塞ぎ（Cache API はヘッダのみの更新ができず、メタデータ更新 =
  N バイト全量再 put）、sha256 有無で 2 つのキー空間に分かれると管理操作がすべて 2 重になる。
- 違和感の根は「公開 `key` オプションが二つの鮮度戦略を混ぜられること」（0006 §5 の
  ピンポン / stale 固着は文書化でしか防げない脚砲）であり、配列キーの直列化機構そのもの
  ではない（レビューで単射性・可逆性は突き崩せなかった）。

## Decision

### 1. 公開 `key` / `HfFileSpec.key` を撤去する（breaking・0.5.0）

- `FetchBytesOptions.key` / `PrefetchUrlOptions.key` / `HfFileSpec.key` を削除する。
  キャッシュキーは **URL（既定）か、ライブラリが生成する HF 内容キー
  `["hf", kind, repo, path, sha256]`** の 2 種だけになり、0006 §5 の脚砲
  （安定キー × revision 切替のピンポン / stale 固着）は**表現不能**になる。
- 実装は `src/core.ts`（deno.json `exports` に載せない内部モジュール）へ移し、配列キーの
  注入導管 `fetchBytesWithKey` / `prefetchUrlWithKey` は HF 層とテスト専用にする。
  `src/mod.ts` は公開 API の再公開ファサード。**MUST: `core.ts` を `exports` へ追加しない**
  （型に無いだけの隠しオプションにしない — モジュール境界が撤去の実体）。
- `evict(prefix)` / `listKeys(prefix)` は公開のまま（HF 内容キーの掃除導線。
  `evict(["hf", "model", repo])` で repo 単位、`[]` で配列キー全部）。`CacheKey` 型も
  この 2 API の語彙として公開に残る。
- 「安定キーで有界ストレージにしたい」将来要求が実在したら、その時に**専用オプション**
  （例: 明示の `boundedKey`）として意味論を分けて再導入する — 汎用 `key` の復活はしない。

### 2. 記録ハッシュの backfill（0006 §2 の「書き足さない」を改定）

記録ヘッダの無いエントリ（無検証 prefetch 由来・旧版）を `sha256` 付きで読むと、0006 §2 の
「一致しても記録は書き足さない」により**毎ヒット全量再ハッシュが恒久化**する（数 GB で致命的、
かつコードは動くので気づけない — 設計検討 ergonomics レッグの発見）。改定:

- 記録なしエントリの実ハッシュが期待 `sha256` に一致したら、**同じバイト列 + 記録ヘッダで
  再 put する**（backfill）。1 回きりの N バイト再 put で以後のヒットは文字列比較だけになる
  （毎ヒット全量ハッシュより明確に安い）。put 失敗は他の cache I/O と同じく縮退 + 通知
  （ADR 0001）— backfill できなくても返す結果は変わらない。
- 記録が**ある**エントリの意味論は不変: 期待と一致 = trust、不一致 = evict → network
  （self-heal）。0005 の「印付き不正エントリは構造的に生まれない」も不変（backfill は
  いま実ハッシュで検証したバイト列にしか記録を焼かない）。

### 3. レビュー指摘の採否（実装はこの ADR とセットの一連のコミット）

- **採用（正当性）**: 予約 origin ガードと single-flight キーの URL 正規化統一（大文字表記の
  ガードすり抜け・表記違い二重フライトの根治）/ 記録不一致ヒットの short-circuit
  （materialize + 再ハッシュせず即 self-heal — 0006 §2 の文字列比較のみ判定を実装に反映）/
  prefetch の既存エントリ検査に記録突合を追加（記録 ≠ 期待なら削除して温め直し）/
  HF 全入口で spec 検査（`toSpec`）を revision 解決より前へ / prefetch 保険 delete の
  失敗黙殺をやめる / `deserializeKey` の復元値型検査 / 進捗リスナー通知の snapshot 反復。
- **採用（非破壊追加）**: 管理 API 5 本（`evict` / `listKeys` / `evictUrl` /
  `listCachedUrls` / `clearCache`）への `caches` DI 追加。
- **文書化で対応**: `validate` の非破壊 MUST / self-heal は leader 経路のみ /
  prefetch の「温めたエントリはそのままヒット」は sha256 無し spec では revision 固定が条件。
- **テスト隔離の訂正（0006 Consequences の補強）**: 固定名前空間はテスト**ファイル間**でも
  共有される — `deno test --parallel` は禁止（逐次実行が前提。同期待ちポーリングには
  deadline を置く）。

### 4. `revalidate`（条件付き GET）は 0.6.0 へ

0006 §2 の予約は維持するが 0.5.0 では実装しない。304 は Cache API のヘッダ全置換制約
（RFC 9111 §4.3.4 のヘッダ更新に N バイト再 put が要る）・`Vary` の扱い・single-flight
合流者の鮮度非決定を抱え、独立 ADR の重さがある。

## Consequences

- breaking（0.5.0 移行メモに追記）: 0.4.0 の `cacheKey: string` 系にも 0006 実装の `key`
  にも相当するものが無くなる。キー分離が必要だった用途は HF 層（内容キー自動）へ、それ以外は
  URL キー + `sha256` で表現する。
- 記録 backfill により「ヒット経路は読み取り専用」ではなくなる（記録なし × `sha256` 指定の
  組み合わせでのみ書く）。
- `src/core.ts` の追加でエントリポイントが「公開ファサード（mod.ts）+ 内部実装（core.ts）」の
  2 層になる。公開 JSDoc は core.ts 側の定義に書き、mod.ts は再公開のみ。
