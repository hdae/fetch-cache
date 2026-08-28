# レンズ: リリース検品（0.4.0 利用者の移行と 0.5.0 パッケージの健全性）

- 対象: `/home/developer/workspace/fetch-cache` HEAD = c91e955（tag `v0.5.0` は HEAD を指す。working tree clean を確認）
- 比較対象: 0.4.0 = f2fd9c8（`git show f2fd9c8:src/mod.ts` / `:src/hf/mod.ts` を実読）
- 読んだもの: README.md / src/mod.ts / src/core.ts / src/hf/mod.ts / docs/limitations.md /
  docs/known-issues.md / docs/decisions/0006・0008 / deno.json / .github/workflows/\*.yml /
  scripts/\*.ts / CLAUDE.md / `git log --oneline ffc8bef..HEAD`（12 コミット）
- 制約遵守: 読み取りのみ。テスト実行なし（`deno task check` は回していない — 静的読解に基づく指摘）。

---

## 1. 指摘

### [severity: warning] src/core.ts:779 — 公開 JSDoc が撤去済みの `key` オプションを案内している

**機序**: `PrefetchUrlOptions.sha256` の JSDoc に
「以後 `fetchBytes` に同じ `key` と `sha256` を渡せばヒット時の再ハッシュも走らない」とある。
`PrefetchUrlOptions` は `src/mod.ts:41-50` で再公開される公開型なので、この本文はそのまま
JSR のドキュメントに載る。しかし公開 `key` オプションは 0.5.0 で撤去済み（ADR 0008 §1、
`FetchBytesOptions`（core.ts:60-150）に `key` は無い）。core.ts の他の `key` 言及
（6・152・665-666・840 行）は module doc と内部導管 `fetchBytesWithKey` /
`prefetchUrlWithKey` の doc で、これらは `exports` 外＝JSR docs に出ないため実害は無い。
779 行だけが公開面に残った文言ドリフト。

**実害**: 0.4.0 からの移行者が JSR の `prefetchUrl` ページを見て「`fetchBytes` に `key` を渡せ」
と読む → そんなオプションは無く、型エラーで詰まる。移行節（README:379-382）が
「そもそもキーを渡す手段は無い」と明言しているのと正面から食い違うため、
「README が古いのか JSDoc が古いのか」を利用者が判別できない。

**修正案**: 779 行を「以後 `fetchBytes` に同じ URL（HF 層では同じ spec）と `sha256` を渡せば
ヒット時の再ハッシュも走らない」に書き換える。0.5.0 では
prefetch と読み出しでキーが一致するのは「同じ URL／同じ HF spec」であることが条件なので、
そこを明示するのが正しい表現。

---

### [severity: warning] README.md:361-382 — 移行節に管理 API の**シグネチャ変更**（位置引数 → オプションオブジェクト）が無い

**機序**: 0.4.0 の管理 API は cacheName を**位置引数**で受けていた
（`git show f2fd9c8:src/mod.ts` 716 行 `clearCache(cacheName: string = "fetch-cache")`、
738 行 `listCachedUrls(cacheName: string = "fetch-cache")`）。0.5.0 は同名で
`clearCache(opts: CacheAdminOptions = {})`（core.ts:1051）/
`listCachedUrls(opts: CacheAdminOptions = {})`（core.ts:1155）へ変わり、第 1 引数の意味が
「名前空間名」から「`caches` DI を持つオプション」へ**入れ替わっている**。
移行節は「`cacheName` is gone」としか書かず、呼び出し形の変化に触れていない。
（`evictUrl` は 0.4.0 も第 2 引数がオブジェクトだったので、`{ cacheName }` を渡していた
コードは TS の余剰プロパティ検査で落ちる＝loud。問題は位置引数の 2 本。）

**実害**:
- TS 利用者: `clearCache("my-cache")` が「string は CacheAdminOptions に代入できない」という
  型エラーになるが、移行節に該当項目が無いため原因追跡が README では完結しない。
- JS 利用者（`npx jsr add` 経由の bundler / Node.js プロジェクトは JS もあり得る）:
  `clearCache("fetch-cache-hf")` が**エラーにならず** `opts.caches` が undefined として扱われ、
  意図と違う既定名前空間 `"fetch-cache"` を消す。旧 HF 名前空間を消したつもりで、
  現行キャッシュを丸ごと飛ばす（数 GB の再ダウンロード）方向に静かに外れる。

**修正案**: 移行節に 1 項目追加する。例:
「**Admin APIs take an options object now.** `clearCache(cacheName)` /
`listCachedUrls(cacheName)` の位置引数は廃止。`clearCache()` /
`listCachedUrls()`（テスト用に `{ caches }` を渡せる）へ置き換え、
旧名前空間の削除は `caches.delete("fetch-cache-hf")` を直接呼ぶこと。」

---

### [severity: warning] README.md:219-240 — 「Everything at once: `clearCache()`」が 0.4.0 からの移行者には嘘になる

**機序**: `clearCache`（core.ts:1051-1057）は固定名前空間 `"fetch-cache"`（core.ts:154）だけを
削除する。0.4.0 の HF 層は既定名前空間が `"fetch-cache-hf"` だった
（`git show f2fd9c8:src/hf/mod.ts` 60 行）ので、0.4.0 で溜めたモデルは `clearCache()` では
一切消えない。移行節（README:367-370）には `caches.delete("fetch-cache-hf")` の案内があるが、
Cache management 節（README:219-240）の「Everything at once」からその制約への参照が無い。

**実害**: 「容量が苦しいので全消しする」という最も自然な導線（`clearCache()`）が、
0.4.0 から上げたユーザに対してだけ**最大の占有分（HF の数 GB モデル群）を残す**。
消えたと思って再ダウンロードすると、旧名前空間ぶんと合わせて二重に容量を食う。
なお 0.4.0 でも `clearCache()`（既定 `"fetch-cache"`）は HF 名前空間を消さなかったので
挙動自体の退行ではないが、0.5.0 の「名前空間は内部固定 1 個」という説明
（README:367-368）が「もう 1 個しか無い」と読めるぶん、誤解は 0.5.0 でむしろ強くなる。

**修正案**: Cache management 節の `clearCache()` 行に一行注記を足す
（「0.4.0 で作られた `"fetch-cache-hf"` は対象外 — 移行節を参照」）。README:239 のコメントを
`// Everything this version manages (the fixed "fetch-cache" namespace):` に直すだけでも可。

---

### [severity: warning] README.md:83-87 — 記録ハッシュ backfill が「N バイト全量の再 put」であることが利用者に見えない

**機序**: 記録なしエントリを `sha256` 付きで読むと、実ハッシュ突合の後に
`cache.put(storageKey, storableResponse(cachedBytes, opts.sha256))`（core.ts:571-578）で
**同じバイト列を丸ごと書き直す**。README は "the record is backfilled" とだけ書き、
ADR 0008 §2 が明記している「1 回きりの N バイト再 put」というコストが公開文書に出ていない。
0.4.0 由来のエントリはすべて記録なし（旧ヘッダ `x-fetch-cache-verified` は読まない —
core.ts:380-383、テストで凍結: src/mod.test.ts:1294）なので、**移行直後の初回読み出しで
必ずこの経路に入る**。

**実害**: 4GB モデルの初回 0.5.0 読み出しで「4GB の read + native digest + 4GB の書き戻し」が
走る。① 起動が体感で止まる、② quota 逼迫時は put が失敗して `onCacheError`（既定
`console.warn`）が出るだけで理由が分からない、③ docs/known-issues.md が記録している
Deno の「put 上書きで旧 body ファイルが orphan」に正面から当たり、4GB のディスクリークが
1 回発生する。どれも「なぜ今これが起きたのか」を利用者が推測できない。

**修正案**: README の当該段落に一文
（"the backfill re-writes the entry once (N bytes), so the first read of a 0.4.0-era multi-GB
entry pays one extra write — after that every hit is a string comparison"）を足す。
docs/limitations.md の記録ハッシュ項（63-69 行）にも backfill のコストが書かれていないので、
そちらにも 1 行入れると known-issues の orphan 項と繋がる。

---

### [severity: warning] README.md:150,186,187,200,217,245,364,365 / .github への 426 — JSR 上で README の相対リンクが全滅する

**機序**: `deno.json` の `publish.include` は
`["README.md", "LICENSE", "deno.json", "src/**/*.ts"]` で、`docs/` も `.github/` も
**パッケージに含まれない**。README は `docs/limitations.md` へ 3 本、
`docs/decisions/000{5,6,7,8}` へ 5 本、`.github/workflows/release.yml` へ 1 本、
合計 9 本の相対リンクを張っている。JSR のパッケージページは README をパッケージ内容の
文脈で描画するため、これらは存在しないパスを指す。

**実害**: JSR（README:431-432 が「Full API documentation is available on JSR」と誘導している
一次導線）でリンクが 404 になる。参照先はどれも「なぜこう振る舞うか」の説明
（縮退契約・`expectedBytes` の fail loud・移行の根拠 ADR）で、リリース直後にこそ踏まれる。
※ JSR の相対リンク解決の詳細挙動はネットワークに出られないため実測していない — 「壊れる」の
確度は高いが**未検証**。少なくとも `docs/` を publish していない以上、
パッケージ内解決では確実に外れる。

**修正案**: どちらか。
(a) README のリンクを GitHub の絶対 URL（`https://github.com/<owner>/fetch-cache/blob/main/docs/...`）へ
置換する（`docs/` を配布物に入れずに済む・ADR は開発文書という位置づけとも整合）。
(b) `publish.include` に `docs/**/*.md` を足す（配布サイズ増と引き換えにリンクが閉じる）。
現行の位置づけ（ADR は内部意思決定記録）からは (a) を推す。

---

### [severity: low] docs/decisions/0006-cache-control-redesign.md:146-148 — Consequences が backfill 前の旧仕様を推奨として残している

**機序**: 冒頭 NOTE（5-8 行）は「§2 の『記録の書き足しはしない』は backfill 採用へ反転」と
正しく訂正しているが、Consequences の当該箇所は訂正の射程外で、
「記録は足されないため毎ヒット計算になる。数 GB 級は取り直しか prefetch での温め直しを推奨」
という**現行実装（core.ts:566-579）と真逆の記述と、それに基づく作業指示**が生きている。

**実害**: 移行手順を ADR まで遡って確認する人（オーナー / 下流 yomi・sbv2-web の作業者）が、
不要な数 GB の取り直し・prefetch 温め直しを段取りに入れる。読み手が「NOTE は §2 の話で
Consequences は別」と読むと矛盾に気づけない。

**修正案**: 148 行を
「旧ヘッダ `x-fetch-cache-verified` は読まない（記録なし扱い → 期待 sha256 があれば 1 回だけ
再ハッシュし、記録を backfill する（0008 §2）。取り直しは不要）」へ差し替える。

---

### [severity: low] README.md:416-423 — Releasing 節の `bump` サブコマンド一覧が実装より狭い

**機序**: README は `deno task bump <patch|minor|major>` しか示さないが、
`scripts/bump.ts:7-15` は `major|minor|patch|premajor|preminor|prepatch|prerelease` の 7 種を
受け付け、CLAUDE.md:27-28 も `pre*` を明記している。

**実害**: 小（リリース手順の網羅性のみ）。ただし 0.5.0 は breaking なので、
下流検証のために `0.6.0-rc.1` 相当を切りたくなる場面が現実にあり、README だけを見ると
その導線が無いと誤解する。`verify_tag.ts` / `release_tag.ts` は完全一致比較なので
prerelease タグでもそのまま通る（`v0.6.0-rc.1` 可）。

**修正案**: README:417 のコード例の下に `deno task bump prerelease  # 0.5.0 -> 0.5.1-rc.0` を
1 行足す（または `<patch|minor|major|pre*>` と表記を CLAUDE.md に合わせる）。

---

### [severity: low] README.md:386-395 — Runtime support 表の Node.js 行「behavior unchanged」が `prefetchUrl` / `prefetchHfFile` を含んでいない

**機序**: 表と直後の段落は「`caches` の無いランタイムでは `fetchBytes` は素の fetch へ、
`evictUrl` / `evict` / `clearCache` は false / 0、`listCachedUrls` / `listKeys` は `[]`」と
縮退 API を列挙するが、`prefetchUrl`（core.ts:870-875）と `prefetchHfFile` は
`caches` 不在で **throw** する側であり、この列挙に出てこない。
Large assets 節（README:182-184）には書いてあるが、Runtime support 表だけを見る読み方だと拾えない。

**実害**: `npx jsr add` を案内している以上 Node.js 利用者は想定内で、
「まず prefetch で温めてから読む」という README 推奨のフロー（README:304-330）を
Node.js でそのまま書くと初手で throw する。fallback（`fetchHfFile`）は書いてあるので
回復可能＝low。

**修正案**: 段落末に
"（`prefetchUrl` / `prefetchHfFile` throw there instead — see Large assets）" を足す。

---

### [severity: low] src/hf/mod.ts:145-166,41-68 — `./hf` エントリが公開シグネチャで使う cache 層の型を再公開していない

**機序**: `HfFetchOptions.onCacheError`（`CacheErrorContext`）、`onProgress`（`FetchProgress`）、
`HfFileSpec.validate`（`ValidateBytes`）、`decode`（`DecodeBytes`）は
`import type { ... } from "../core.ts"`（18-26 行）で取り込むだけで、`./hf` からは
re-export されていない。これらは `.` エントリからは公開されている（src/mod.ts:41-50）。

**実害**: 小。`./hf` だけを使う利用者が
`const onErr: CacheErrorContext => void` に型注釈を書きたいとき、別エントリ
`@hdae/fetch-cache` からの import が必要になる（動作はする）。JSR の `./hf` ドキュメント上も
これらの型名がそのエントリ内で解決されない。0.4.0 も同じ構造だったので**退行ではない**。

**修正案**（任意・非破壊）: `src/hf/mod.ts` に
`export type { CacheErrorContext, DecodeBytes, FetchProgress, ValidateBytes };` を足す。
0.6.0 でよい。

---

### [severity: low] deno.json:1-10 — `description` フィールドが無い（JSR パッケージページの説明が空になる）

**機序**: `deno.json` は `name` / `version` / `license` / `exports` のみ。JSR は
`description` を任意フィールドとして拾ってパッケージ一覧・検索・OG に出す。

**実害**: 小（公開ページの体裁と検索性のみ。publish は通る）。
※ JSR が `deno.json` の `description` を採用する挙動は記憶ベース — **未検証**。

**修正案**: `"description": "Zero-dependency, URL-keyed download cache for Deno and browsers (Web Cache API), with sha256 integrity and a HuggingFace layer."` を追加。

---

### [severity: low] src/core.ts:1-8 — 「パッケージ利用者からは import 不能」は解決経路の話で、ファイルは配布物に含まれる

**機序**: `publish.include` は `src/**/*.ts` なので `src/core.ts` と `src/sha256.ts` は
tarball に入る。`exports` に無いため `jsr:@hdae/fetch-cache/src/core.ts` という
**モジュール解決は通らない**（npm 互換配布でも Node の exports で塞がれる）ので、
「内部導管 `fetchBytesWithKey` / `prefetchUrlWithKey` に公開経路は無い」という
ADR 0008 §1 の MUST は実質的に守られている。ただしファイル自体は JSR のファイルブラウザ /
生 URL では読める。

**実害**: 実害なし（意図的な API 隠蔽としては十分。ソースの秘匿を意図しているわけではない）。
コメントの「import 不能」という表現だけが実態よりわずかに強い。
※ JSR の非 exports サブパス解決が確実に失敗することはネットワーク未使用のため**未検証**。

**修正案**: 直さなくてよい。触るなら「`exports` に載せない＝公開の import 経路を持たない」へ
表現を寄せる程度。

---

## 2. 「問題なし」確認リスト

- **リリース整合（レンズ 5）**: `deno.json` version = `0.5.0`、`src/mod.ts:29` の
  `VERSION = "0.5.0"`、git tag `v0.5.0` = HEAD（c91e955）、working tree clean。
  `scripts/version_sync.test.ts` が dev/CI 側の drift ガード、`scripts/verify_tag.ts` が
  release 側で「公開 VERSION == deno.json」＋「タグ == v+version」を二重に fail loud で検査。
  `release.yml` は publish 前に `deno task check` を通し、`--no-lock` で deno.lock 汚染による
  dirty publish も防いでいる。OIDC 権限も最小（contents:read / id-token:write）。整合は取れている。
- **semver 判定（レンズ 5）**: 0.x での breaking を minor に載せるのは妥当。むしろ 0.x では
  `^0.4.0` が 0.5.0 に**マッチしない**ため、下流（yomi / sbv2-web）が明示的に上げない限り
  0.4.0 に留まる＝事故的な巻き込みが起きない。major 化（1.0.0）は「API を固定する」宣言に
  なるので、`revalidate`（ADR 0008 §4 で 0.6.0 送り）と寿命軸（TTL/LRU、ADR 0006 §3 で
  スコープ外）が未着地の現状では 0.5.0 が正しい選択。
- **JSR パッケージング（レンズ 4）**: `exports` は `.` と `./hf` の 2 本のみで `src/core.ts` は
  不在＝ADR 0008 §1 の MUST を満たす。`publish.exclude` が `src/**/*.test.ts` と
  `src/testing/**` を落としており、テスト専用の `@std/assert` と mock fetch は配布物に入らない
  （＝依存ゼロ MUST が配布面でも保たれる）。公開シグネチャに `core.ts` 固有の型が
  漏れている箇所は無く（公開型 8 本はすべて `src/mod.ts:41-50` で再公開済み）、
  slow types になる暗黙戻り値型の公開シンボルも見当たらない（`fetchBytes` /
  `prefetchUrl` / `evict` / `listKeys` / `evictUrl` / `listCachedUrls` / `clearCache` /
  `decodeGzip` / `isCommitSha` / `hfResolveUrl` / `resolveHfRevision` /
  `fetchHfFile` / `fetchHfFiles` / `prefetchHfFile` すべて明示戻り値型）。
  両エントリに `@module` doc がある。`LICENSE` は実在。
- **0.4.0 残骸との遭遇（レンズ 3）**: 実装から追った結果、驚きは無い。
  ① 旧 HF 名前空間 `"fetch-cache-hf"` は 0.5.0 のどのコードからも参照されない（孤立するだけ・
  整合性影響なし。容量については上の warning 参照）。
  ② 0.4.0 の汎用層エントリは同じ `"fetch-cache"` に URL キーで残り、0.5.0 からそのまま
  ヒットする。0.4.0 は生 URL 文字列を、0.5.0 は `new URL().href`（core.ts:235-255）を
  Cache API へ渡すが、Cache API 側も同じ URL パーサで正規化するため実キーは一致する。
  ③ 旧ヘッダ `x-fetch-cache-verified` は読まれず「記録なし」扱い（core.ts:533 は
  `x-fetch-cache-sha256` のみ参照）。これは安全側で、src/mod.test.ts:1294 が
  「旧ヘッダ付き・中身が別物のエントリを信じず取り直す」ことを凍結している。
- **既定反転の安全含意（レンズ 2）**: 反転が実際に効くのは HF 層の
  `sha256` 宣言ファイル（0.4.0 は `buildValidate` の中でヒット毎に全量再ハッシュしていた）。
  0.5.0 でその再ハッシュは消えるが、(a) 内容キー `["hf", kind, repo, path, sha256]` は
  sha256 自体をキーに含む、(b) 記録ハッシュは「保存時に実際に検証を通ったバイト列」にしか
  焼かれない（network 経路 core.ts:609-621、streaming 経路 core.ts:920-997 の
  stream error + 保険 delete、backfill 経路 core.ts:566-579 はいま実ハッシュした列にのみ）、
  (c) カスタム `validate` と HF の `expectedBytes` は記録一致ヒットでも常に走る
  （core.ts:455、hf/mod.ts:174-188）— の 3 点により、開く穴は
  「格納後のビット腐敗・改竄」だけに限定されている。docs/limitations.md:63-69 が
  この信頼境界を正確に書いており、opt-out（`recheck`）の導線も README:92-99 にある。
  汎用層については 0.4.0 に `sha256` オプションが**そもそも存在しない**ので、
  README:371-376 の "0.4.0 validated every hit" は HF 層の話として読めば正しい
  （汎用層のカスタム `validate` は 0.5.0 でも毎ヒット走るため、そちらに反転は無い）。
- **移行の実行可能性（レンズ 1）**: 撤去 3 種のうち `cacheName` / `verifiedMarker` /
  `trustCachedSha256` はいずれも README:367-376 に書き換え先がある
  （名前空間分割 → キー先頭要素 + `evict` プレフィックス、印 → `sha256` + `recheck`）。
  0.4.0 の全オプションを突き合わせた結果、**書き換え先が無いオプションは無い**
  （`FetchBytesOptions` / `PrefetchUrlOptions` / `HfFetchOptions` / `HfPrefetchOptions` /
  `HfFileSpec` の全フィールドを 0.4.0 と 1 対 1 で確認）。`prefetchHfFile` の戻り値
  `HfPrefetchResult` は 0.4.0 から不変で、移行節が触れていないのは正しい。
  非互換で移行節に落ちていたのは管理 API の呼び出し形だけ（上の warning）。
- **docs 相互矛盾（レンズ 6）**: ADR 0006 冒頭 NOTE（5-8 行）が 0008 による改定
  （§1 公開 key 撤去 / §4 `HfFileSpec.key` 撤去 / §2 backfill 反転 / テスト隔離訂正）を
  明示しており、`HfFileSpec.key` を語る 0006 §4・§5 は NOTE で射程に入っている。
  CLAUDE.md:42 のテスト隔離規約も 0008 §3 の訂正どおり。limitations.md は
  0.5.0 の実装（記録トラスト・prefetch の記録突合・明示 expectedBytes の fail loud）と一致。
  残っていた不整合は上記 low 1 件（0006 Consequences）のみ。

---

## 3. 総評（リリース可否）

**リリースはブロックされない**。バージョン・タグ・CI/CD・`exports` 境界・依存ゼロはすべて整合し、
0.4.0 残骸との遭遇も実装から追う限り「孤立するか、安全側に倒れて自己修復するか」のどちらかで、
データを壊す経路は見つからなかった。0.5.0 の中核（記録ハッシュのトラスト反転）も、
内容キー・保存時検証・validate 常時実行の三重で穴が「格納後の腐敗」に限定されており、
文書（limitations.md）の主張と実装が一致している。

一方で**指摘はすべて文書側に集中しており、しかも 0.4.0 からの移行者だけが踏む**という
質の悪さがある: 撤去済み `key` を案内する公開 JSDoc（JSR に載る）、位置引数が消えたことを
書いていない移行節、旧 HF 名前空間を消せない `clearCache()` を "Everything at once" と
呼ぶ節、初回読み出しで数 GB を書き戻す backfill の無告知、JSR で 404 になる 9 本の相対リンク。
下流が yomi / sbv2-web の 2 本だけでオーナー管理下にあるとはいえ、
publish 後の README/JSDoc 差し替えは再 publish（0.5.1）を要するため、
**warning 5 件は publish 前に潰すのが安い**（いずれも文言修正のみで、コード変更もテスト追加も不要）。
low 6 件は 0.6.0 に送ってよい。
