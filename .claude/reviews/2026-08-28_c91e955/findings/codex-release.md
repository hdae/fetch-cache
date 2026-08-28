## 1) 指摘

[severity: error] README.md:381 — `cacheName` による分割を `evictUrl` / `evict` へ移行することはできない

機序: 0.5.0 には公開 `key` 指定がなく、`evict` の prefix はライブラリが生成した HF 配列キーの管理専用である。`evictUrl` も単一 URL の削除にすぎず、任意の名前空間分割を代替しない。  
実害: 複数アプリ・テナント・認証領域を `cacheName` で隔離していた利用者には書き換え先がない。型検査を介さない JavaScript では旧 `cacheName` が黙って無視され、全呼び出しが `"fetch-cache"` に合流して、同一 URL の内容混同や認証済みデータの誤共有を起こし得る。  
修正案: 「一般用途の partitioning には代替 API がない」と明記し、必要なら 0.4.0 継続・別 `CacheStorage` 実装・URL 自体による分離を案内する。分割を正式に支援するなら、公開 API を追加してからリリースする。

[severity: warning] README.md:367 — 旧管理 API の引数変更・削除範囲・旧カスタム名前空間の後始末が不足している

機序: 0.4.0 の `clearCache(cacheName)`、`listCachedUrls(cacheName)`、`evictUrl(url, { cacheName })` は、0.5.0 では `{ caches }` を取る別シグネチャになった。また新しい `clearCache()` は汎用 URL エントリと新 HF エントリをまとめて削除する。旧 `"fetch-cache-hf"` 以外のカスタム名前空間も0.5.0から一切参照されない。  
実害: TypeScript 利用者はビルドエラーになる一方、旧 JavaScript の `clearCache("custom")` は文字列を options として受けて固定 `"fetch-cache"` を削除し、意図した旧名前空間を残す。引数なしの既存コードも、0.4.0 より広い範囲を削除する。カスタム名前空間はディスク上に孤児化する。  
修正案: 管理 API の before/after 表を追加し、旧名前空間の一回限りの処理は `caches.delete(oldName)`、新固定領域の操作は引数なしまたは `{ caches }` と明示する。`clearCache()` / `listCachedUrls()` の対象範囲拡大も警告する。

[severity: warning] README.md:371 — `verifiedMarker` は `sha256` に完全には吸収されていない

機序: 0.4.0 の `verifiedMarker` は任意文字列を受け、マーカー一致時にはカスタム `validate` 全体を省略した。`trustCachedSha256: true` も `expectedBytes` とカスタム検証まで省略した。0.5.0 の `sha256` は64桁小文字 hex に限定され、省略されるのは組み込み SHA-256 再計算だけで、`validate` / `expectedBytes` は毎回走る。  
実害: 任意マーカーを単純に `sha256` へ改名すると入口で throw する。旧 SHA 検証用 `validate` を残したまま `sha256` を追加すると、記録 trust のつもりでも毎ヒット再ハッシュし、数 GB 資産で性能問題が残る。任意の高価な検証を省く用途には移行先自体がない。  
修正案: 実 SHA の検証だけだった場合は「`validate` と `verifiedMarker` を削除して `sha256` へ」、旧既定の毎回検証を維持する場合は「`sha256` + `recheck: true`」、任意検証の場合は「`validate` を残すが省略 API はない」とケース別に示す。

[severity: warning] README.md:361 — `expectedBytes` の観測可能な変更が移行節にない

機序: 0.4.0 は明示 `expectedBytes` の事前確保失敗もチャンク経路へ縮退したが、0.5.0 は `src/core.ts:117-120` のとおり body 読み出し前に throw する。README 本文には記載があるものの、移行節にはない。  
実害: 単一 `ArrayBuffer` 上限を超える値、または実体より過大な誤った値を渡していたコードは、以前より早く失敗し、後者は以前成功していた場合でも失敗し得る。大容量資産を扱う下流が移行節だけでは必要な prefetch・分割化を判断できない。  
修正案: 移行節にこの変更を追加し、巨大ファイルには `prefetchUrl` / `prefetchHfFile`、誤ったヒントには値の修正・省略を案内する。

[severity: warning] README.md:374 — 旧ヘッダ付きエントリに対する prefetch の再ダウンロード経路が移行節から読み取れない

機序: `fetchBytes(..., { sha256 })` は旧ヘッダを「記録なし」として実ハッシュ・backfill する一方、`prefetchUrl(..., { sha256 })` はバイトを読めないため、`src/core.ts:884-895` で旧エントリを削除してネットワークから温め直す。移行節は前者だけを説明している。  
実害: 0.4.0 で温めた multi-GB エントリに、アップグレード後まず prefetch を行うと、利用者の予想に反して全量再ダウンロードされる。取得失敗時には削除済みの旧エントリも失われる。  
修正案: 「verified read = `fetchBytes` は backfill」「`prefetchUrl` / `prefetchHfFile` は新記録がない旧エントリを削除して再取得」と分岐を明記する。

[severity: warning] deno.json:19 — README が参照する設計文書が JSR 配布物から除外される

機序: `publish.include` は README・LICENSE・deno.json・`src/**/*.ts` だけで、`docs/**` と `.github/workflows/release.yml` を含まない。一方、README は limitations、ADR 0005〜0008、release workflow を相対リンクしている。  
実害: JSR 配布物では移行判断や信頼境界の根拠となる文書を参照できず、README の相対リンクが配布内容と整合しない。特に breaking release の補足資料が欠落する。  
修正案: `docs/**/*.md` を publish 対象へ追加し、workflow も含めるか、README のリンクを GitHub の絶対 URL に変更する。

[severity: low] src/core.ts:779 — 公開 JSDoc が撤去済みの `key` オプションを案内している

機序: root から再公開される `PrefetchUrlOptions.sha256` の JSDoc が「`fetchBytes` に同じ `key` と `sha256` を渡す」と記述しているが、公開 `fetchBytes` / `prefetchUrl` に `key` は存在しない。  
実害: JSR API docs を頼る利用者が存在しないオプションを指定して型エラーになる。  
修正案: 公開 API については「同じ URL と `sha256`」、HF 内部経路については「同じライブラリ生成内容キー」と書き分ける。

[severity: low] src/core.ts:248 — 0.4.0 の予約 origin URL エントリが0.5.0から管理不能になる

機序: 0.4.0 は `https://fetch-cache.invalid/...` も通常の URL キーとして受け入れたが、0.5.0 は origin 全体を拒否し、`listCachedUrls` からも除外する。`/v1/` 以下では、形によって `listKeys` に誤分類されるか復元エラーになる。  
実害: 発生条件は custom fetch 等に限定されるが、該当する永続エントリは `fetchBytes` / `evictUrl` / 通常の一覧から到達できず、`clearCache` または生の Cache API でしか処理できない。  
修正案: 移行節に予約 origin の導入と直接削除手順を記載する。

[severity: low] docs/decisions/0006-cache-control-redesign.md:120 — 0008 で撤回済みの API と backfill 方針が本文では現行形のまま残る

機序: 冒頭の注記は supersede を示しているが、本文は `HfFileSpec.key` を上書き可能とし、`docs/decisions/0006-cache-control-redesign.md:147` では記録を追加せず毎ヒット再計算すると断言する。現在の API・0008・実装はいずれも逆である。  
実害: セクションへの直接リンクや本文だけを読む利用者が、存在しない API を使ったり、旧エントリの性能特性を誤認したりする。  
修正案: 該当段落の直前にも「0008 により撤回」と明示し、現行挙動へのリンクを置く。現行仕様書として扱うなら本文自体を更新する。

[severity: low] docs/decisions/0008-remove-public-key-and-backfill-record.md:80 — `cacheKey` が0.4.0に存在したという記述が事実と異なる

機序: 実際の v0.4.0 公開型には `cacheKey` がなく、README.md:379 も「never shipped」としている。`cacheKey: string` は未リリースの設計稿だった。  
実害: 0.4.0 利用者が存在しない廃止 API の移行作業を探すことになり、README と ADR のどちらを信頼すべきか曖昧になる。  
修正案: 「未リリースの旧0006案の `cacheKey: string`」へ訂正する。

## 2) 「問題なし」確認リスト

- `cache`、`validate`、`decode`、`onProgress`、`onCacheError`、`init`、`fetch`、`caches` の基本シグネチャと役割は維持されている。
- 既定 trust の穴は README.md:89-99 と docs/limitations.md:63-69 で、格納後の改竄・ビット腐敗を検出できないこと、`recheck: true` が旧来の毎ヒット検証相当であることまで明示されている。カスタム `validate` / `decode` が記録一致時も走る説明も実装と一致する。
- 旧 `"fetch-cache"` の通常 URL エントリはそのまま再利用される。新 `sha256` 指定時は旧ヘッダを信頼せず、実ハッシュ一致なら新ヘッダを backfill、不一致なら evict・再取得する実装になっている。
- 旧既定 HF 名前空間 `"fetch-cache-hf"` は0.5.0から開かれず、HF エントリが miss・再取得になることと一回限りの削除手順は README に記載されている。
- `deno.json` の公開 export は `.` と `./hf` のみで、`src/core.ts` は配布に必要な内部ファイルとして含まれるが、対応する `jsr:` subpath はない。`fetchBytesWithKey` / `prefetchUrlWithKey` もファサードから漏れていない。
- 公開関数のシグネチャに内部専用関数・内部専用型の露出はない。core 由来の公開型は root から再公開され、HF 公開型が参照する型も root 側で公開されている。再公開元には、上記 stale 文言を除いて API JSDoc が存在する。
- `deno.json` version、`src/mod.ts` の `VERSION`、HEAD、ローカルタグ `v0.5.0` はすべて `0.5.0` / `c91e955` で一致する。release workflow は check 後に event tag・deno.json・公開 VERSION を照合してから publish する構成である。
- breaking な `0.4.0 → 0.5.0` を minor とするのは、major version 0 の開発段階であり、通常の `^0.4.0` 依存が `0.5.0` を自動採用しないことから semver 上妥当である。
- docs/limitations.md と CLAUDE.md の固定名前空間、記録 trust、公開 key 撤去に関する現行記述は実装と一致する。

## 3) 総評

公開ファサード、内部モジュール境界、旧通常 URL エントリの安全な移行、バージョン・タグ・workflow の整合には致命的な実装問題を認めない。  
ただし `cacheName` 利用者には実在しない移行先を提示しており、旧管理 API・検証オプションの書き換えも不足しているため、下流は README の移行節だけでは安全に更新できない。  
配布対象から参照文書が落ちる問題と公開 JSDoc／ADR の残骸も、breaking release の検品として修正が必要である。  
したがって現タグのままの publish は不可と判断し、移行表・配布設定・文書矛盾を修正してから 0.5.0 を再検品すべきである。