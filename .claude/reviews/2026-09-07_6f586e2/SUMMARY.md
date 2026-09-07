---
title: レビュー SUMMARY — 区間読み（openCachedUrl / openHfFile、ADR 0012）の 0.8.0 リリース前検品
date: 2026-09-07
head: 6f586e2
prev_review: 2026-09-05_833e5bc（v0.7.0 リリース前検品。HEAD 833e5bc → 0.7.0 は 525c213 でタグ）
mode: A（差分: v0.7.0..HEAD = 6f586e2 の 1 コミット、+1,091 / −4 行）+ テスト品質横断 + 文書突合
reviewer: オーケストレータ = Fable 5.1（主セッション）/ ファンアウト 4 レッグ = Opus 5 effort high / 反証 35 レッグ = Opus 5 effort high
---

# レビュー SUMMARY — 区間読み（`openCachedUrl` / `openHfFile`）の 0.8.0 リリース前検品

このファイルだけで全裁定ができるように書いている。`findings/` は各レッグの作業ログ（裏付け）。

## 結果ダイジェスト

- **対象**: v0.7.0（JSR 公開済み 2026-09-05）以降の唯一のコミット 6f586e2 — 温め済みキャッシュエントリから区間だけを読む新 API `openCachedUrl`（汎用層）/ `openHfFile`（HF 層）。"blob" / "stream" の 2 戦略。追加のみ・minor（0.8.0 予定）。
- **機械検査（全て緑）**: `deno task check` 241 passed / 0 failed / 1 ignored（ignored は Cache `keys()` 非対応ランタイム向けの既存分岐）。`deno publish --dry-run` 成功。公開 API 表面の突合（`deno doc --json` を v0.7.0 と HEAD で比較）: 追加 6・削除 0・既存シグネチャ変更 0。
- **所見**: レビューレッグ 65 件（E 6 / W 29 / L 30）→ W 以上 35 件を全て独立レッグで反証 → **holds 34 / refuted 1 / uncertain 0**。反証後の重大度: **E 2 / W 11 / L 52**。
- **実装バグ 2 件（E）**:
  - **G1-01**: "stream" 戦略の `read` は毎回 `cache.match` し直すのに記録ハッシュを再確認しない。`sha256: A` で開いた後、並行する `fetchBytes(url, { sha256: B })` が self-heal（記録不一致のエントリを消して取り直す既存の自己修復）で同じキーへ内容 B を書くと、以後の `read` が **B のバイト列を黙って返す**（反証レッグが Deno で再現）。区間読みは実ハッシュを計算できないので下流は検出不能。fail-loud 規約違反。修正は 1 行 + テスト 1 本。
  - **G3-10（反証で W→E に格上げ）**: "stream" 戦略でバッファ確保（`new Uint8Array(length)`）が `cache.match` の**後**にあるため、確保失敗時に match 済みの body（応答本文ストリーム）が cancel されず、Cache のファイルハンドルが残る。既存テスト `read(0, Number.MAX_SAFE_INTEGER)` が現に 1 個漏らしている（`deno test --sanitize-resources` で赤）。修正は確保を match の前へ移すだけ。
- **W 11 件は全てテスト凍結の抜けと文書ドリフト**（実装は正しい）。最大は G3-01: 中断テストが「チャンク境界で中断を見る」契約を縛れていない（abort が最初のチャンクを読む前に届く構造で、ループ内の検査をループ外へ移す変異でも緑）。
- **要判断は 4 問**（2〜5）。最優先は **2**（`OpenCachedOptions.read` の名前 — リリース後は変えられない）。
- **隣接問題（対象外・報告のみ）**: `deno test --sanitize-resources` を付けると既存テスト 16 本が Cache 応答の body 未消費で赤になる（テスト側の `cache.match` → headers だけ読んで放置。ライブラリ側の self-heal 経路は cancel 済みを確認）。→ 要判断 5。

## 要判断（ユーザー裁定待ち）

### 1. 推奨案で進める一覧（承認語 1 つで一括・「1. OK、ただし 1-x は保留」で個別に外せる）

**実装修正（コミット 1: fix）**

* 1-1) **G1-01** `readFromStream` に期待 sha256 を渡し、再 match した応答の記録ハッシュ（`x-fetch-cache-sha256`）が期待と違えば body を cancel して throw する（文言案「開いた後にエントリが差し替わりました」。`sha256` 無しの生読みは不変）。\
  再現テスト: 温め → `openCachedUrl(url, { sha256: A, read: "stream" })` → `fetchBytes(url, { sha256: B })` で差し替え → `entry.read(0, 2)` が reject（現状は B の中身が返るので赤で始まる）。\
  ADR 0012 §4 / Consequences・limitations・`CachedEntry.read` の JSDoc に「消えた場合と同様、差し替わった場合も次の read が throw」を追記。
* 1-2) **G3-10** `readFromStream` のバッファ確保を `cache.match` より前へ移す（確保できない `length` は資源を 1 つも取らずに範囲外で落ちる）。\
  同時に確保失敗の `failure.cause = error` を `new Error(msg, { cause })` 形式へ（G1-09、同ファイル `normalizeUrl` と同じ書式）。\
  解放テスト: cancel を数える偽 body（既存 `lazyResponse` ヘルパを match ごとに新規生成）で「完走 / 末尾到達の範囲外 / 確保失敗 / 中断」の 4 経路とも body が解放されることを凍結（open 時の解放 1 回が基準）。現状は「確保失敗」だけ赤になる。

**テスト補完（コミット 2: test）— 全て追加のみ、既存 assertion は変えない**

* 1-3) **G3-01** "stream" の中断をチャンク境界で縛る: 偽 CacheStorage が `highWaterMark: 0` の手動 pull body（複数チャンク、2 チャンク目で gate 停止）を返し、2 チャンク目に入ってから abort → `signal.reason` で reject し、読んだチャンク数が総数未満であることを assert。\
  既存テスト（mod.test.ts:3331 付近）のコメント「チャンクの切れ目で見る契約をここで凍結」は実態（match 待ちの間に来た abort を拾う）に書き換える。
* 1-4) **G3-02** 記録不一致の self-heal で `cache.delete` が失敗しても `undefined` を返し、`onCacheError` に `op: "delete"` が届くこと。
* 1-5) **G3-03** "blob" 戦略に abort 済み signal を渡すと `read` が入口で `signal.reason` で reject すること（現状 `signal?.throwIfAborted()` を消しても緑）。
* 1-6) **G3-04 / G1-05 / G3-20** 境界テーブルに `(0, 0)` / `(size, 0)` / `(size − 1, 1)` を、範囲外テーブルに `(size + 1, 0)` を追加（両戦略で回す。長さと中身の両方を assert）。
* 1-7) **G3-05 / G1-04 / G4-06** body が `null` の応答を DI（`failingCacheStorage` の match 差し替え）して "stream" で `read(0, 0)` = 空配列、`read(0, 1)` = 「本文 0 バイト」で throw を凍結。\
  文言・制御フローは据え置き（準拠ランタイムでは body null ⟺ 0 バイトなので正しい）。JSDoc と ADR §4 に「"stream" は `response.body` を要求する。body を持たないランタイムでは "blob" を使う」を 1 文追記。
* 1-8) **G3-06** 確保失敗の文言「バッファを確保できません」と `cause` に実行環境の `RangeError` が入ることを assert（現状は「範囲外」しか見ていない）。
* 1-9) **G3-07** 既定の通知フック（`defaultOnOpenCacheError`）の文言「エントリ無しとして扱います」を `console.warn` 差し替えで凍結（取得系の「network へ縮退します」と混ざらないこと）。
* 1-10) **G3-08** 非 Deno ランタイムの既定戦略 "blob": `globalThis.Deno` の descriptor を退避 → delete → `strategy` を変数へ退避 → `finally` で `Object.defineProperty` 復元 → **復元後に** assert（削除窓の中で assert が失敗すると `@std/assert` が `Deno` 参照で ReferenceError になるため、この順序が必須 — 反証レッグ実測）。
* 1-11) **G3-09** 予約 origin ガードのテスト（mod.test.ts:1008）に `openCachedUrl` / `openCachedUrlWithKey` を追加（現状 `normalizeUrl` を外しても緑）。
* 1-12) **G3-11** 偽 match が 3 チャンクの body を返す DI テストで、チャンク跨ぎの読み飛ばしと充足をランタイム非依存で凍結（Deno 2.9.6 は 64 KiB 刻みなので現行 256 KiB テストも跨いでいるが、実装依存）。
* 1-13) **G3-12 / G2-03** `openHfFile` の `onCacheError` が cache 層へ透過すること（`read` / `caches` は透過テスト済み）。
* 1-14) **G3-13 / G2-02** `openHfFile` で `expectedBytes` 負 / `into` 容量不足が `toSpec` で `fetchHfFile` と同文言で throw すること（JSDoc が明言している挙動の凍結）。
* 1-15) **G3-14** `size` と `slice` が食い違う偽 Blob を DI して "blob" の短返りガード（「〜バイトしか返しませんでした」）を凍結。
* 1-16) **G3-15** `prefetchUrl` / `prefetchHfFile` で温めたエントリを `openCachedUrl` / `openHfFile` で開けること（温めの 2 経路目）。
* 1-17) **G1-06** 同一ハンドルからの並行 `read`（`Promise.all` で異なる区間 4 本、両戦略）と、"stream" の read 中に `cache.match` が失敗しても縮退せず throw し `onCacheError` が呼ばれないこと。
* 1-18) **G3-16 / G3-19 / G3-21** `finally` の `caches.delete` が無い 2 テストに追加 / テスト名「区間読みは検証系オプションを持たない」を内容（配列キーと入口検査）に合わせて改名 / `openHfFile` の `kind` 違いは別エントリ・`hubUrl` 違いは同一エントリになること。

**文書修正（コミット 3: docs）**

* 1-19) **G2-01** 内部導管を列挙するコメント（hf/mod.ts:20-21・core.ts の対応箇所）に `openCachedUrlWithKey` を追加。
* 1-20) **G2-04 / G4-01** `onCacheError` の通知 `op` 一覧（`OpenCachedOptions.onCacheError` JSDoc・ADR 0012 §4・limitations）に self-heal の `delete` を追加（実装は通知している）。
* 1-21) **G4-03** `caches` の無いランタイムでは `undefined`（エラーではない）を README Runtime support / limitations に追記。
* 1-22) **G4-04** README に「開いたハンドルはスナップショットではない（"stream" は消えると throw、"blob" は開いた時点の Blob を読み続ける）」を追記（ADR / limitations / JSDoc にはあり README だけ無い）。
* 1-23) **G4-05** limitations に中断の粒度（"stream" はチャンク境界・"blob" は呼び出し時 1 回・**open は中断できない**）を追記。
* 1-24) **G4-08 / G4-09 / G2-09** README:316-320 の折り返し崩れ、CLAUDE.md:12 の行幅（約 114 桁）を整える。
* 1-25) **G4-11** ADR 0012 §1 のスニペットを型が通る形に（`entry` が `undefined` の分岐を入れる）。
* 1-26) **G4-12 / G4-15** README に「`sha256` 省略 = 記録の有無に依らず開く無検証の生読み」「負・非整数の `offset` / `length` は throw」を追記。
* 1-27) **G4-14** README の HuggingFace 節から `openHfFile` の説明へ相互参照を足す。
* 1-28) **G4-16 / G2-05** ADR §5「`ref.revision` は解決も参照もされない」を「解決しない。ラベル URL にだけ現れる」へ。`openHfFile` JSDoc と limitations HF 節に「エラー・通知に出る URL は表示用ラベル（取得元でも保存キーでもない。`evictUrl(そのURL)` は効かず `evict(内容キー)` が正）」を 1 文。
* 1-29) **G1-13** `openCachedUrl` は single-flight（同一 URL の取得を 1 本に束ねる既存機構）に参加せず、進行中の `fetchBytes` があっても待たずに `undefined` を返すことを JSDoc / limitations に明記。
* 1-30) **G2-08 / G4-13** `OpenCachedOptions` に型レベル JSDoc（`deno doc --lint` の missing-jsdoc 解消）/ ADR 0012 の実測表の Chrome 行にエントリサイズを併記。
* 1-31) **G1-07** limitations / ADR の「消えれば次の read が throw」を「`evictUrl` / `evict` / self-heal は throw する。`clearCache` 後は保持中の Cache オブジェクトの寿命がランタイム依存（Deno は throw、ブラウザは未実測）」へ書き分け。

**リリース手順（上記が閉じてから）**

* 1-32) `deno task check` 緑 → `deno task bump minor`（0.8.0、1 コミット）→ リリースノート確定（草稿 `RELEASE_NOTES_0.8.0.md` を裁定結果へ更新）→ 独立レッグ 2 本（主張突合 + 両方向網羅）→ ノートを SendUserFile で送付。タグ・Release・push はユーザー。

### 2. `OpenCachedOptions.read`（戦略の強制オプション）の名前を、公開前に `strategy` へ変えますか？ [L / 公開 API 命名 — リリース後は変更不可]

**概要**: 戦略を指定するオプションが `read: "blob" | "stream"`、戻り値の同じ情報が `entry.strategy`、区間を読むメソッドが `entry.read(...)`。同じ語 `read` が「戦略の選択」と「読む操作」の両方を指し、戻り値側とは名前が食い違う（G1-12）。v0.7.0 以降は公開 API の breaking が不可なので、直すなら 0.8.0 に載る前の今だけ。守っている目的は「利用者が迷わない API 表面」。
* a) `strategy` へ改名 ★推奨 — 戻り値 `entry.strategy` と対になる / メソッド名 `read` との衝突が消える / 入口のエラー文言が「strategy は "blob" / "stream" のどちらか」と自己説明になる。`HfOpenOptions.strategy` も同時に。
* b) `read` のまま — 「stream で読む / blob で読む」と読めなくはない。変更コストゼロ。
**リスク**: a) は core.ts / hf/mod.ts / テスト / README / ADR 0012 / limitations / リリースノート草稿の置換（機械的、`rg 'read: "'` で全件拾える）。
**対象**: src/core.ts:1400-1412（`OpenCachedOptions.read`）/ src/hf/mod.ts:498-505（`HfOpenOptions.read`）
**影響範囲**: 上記 2 型と入口検査（core.ts:1610-1618）、テスト約 10 か所、文書 4 面。
**引き継ぎ**: 改名はコミット 1（fix）に含める。エラー文言は `fetch-cache: strategy は "blob" / "stream" のどちらかで指定してください: <値> (<url>)`。既存テストの文言照合 `'"blob" / "stream"'` はそのまま通る。

### 3. "blob" 戦略で `response.blob()` が失敗したときの `onCacheError` の `op` ラベルをどうしますか？ [L / 診断品質]

**概要**: `onCacheError` は失敗した Cache API 操作を `op: "open" | "match" | "put" | "delete"` で伝える。`blob()` の失敗は `cache.match` 自体は成功した後に起きるが、現状 `op: "match"` を名乗る（G1-03 / G4-02、テストで凍結済み・文書には無い）。守っている目的は「どこで壊れたかを伝える唯一の口」の正確さ。
* a) 現状の割り当てを文書化する ★推奨 — `OpenCachedOptions.onCacheError` JSDoc・ADR 0012 §4・limitations に「"blob" 戦略の `blob()` 失敗も `op: "match"` で通知する」と明記。型を触らないのでゼロリスク。
* b) `CacheErrorContext.op` に `"blob"` を追加 — 診断は正確になるが、コールバック引数の union を広げるので、`op` を網羅 switch（`never` 検査つき）している下流はコンパイルエラーになる。採るなら yomi / sbv2-web の `onCacheError` 実装を先に確認。
**リスク**: b) は型レベルの breaking の可能性。a) は無し。
**対象**: src/core.ts:29-33（`CacheErrorContext`）/ src/core.ts:1660-1667（blob() の catch）
**影響範囲**: a) 文書 3 面。b) 上記 + mod.test.ts:3500 の期待値 `["match"]` → `["blob"]` + 下流確認。
**引き継ぎ**: a) はコミット 3（docs）に同乗。

### 4. 前回 ROADMAP の G3-05（`resolveHfRevision` のオプション型を公開型 `HfResolveOptions` にする）を 0.8.0 に同乗させますか？ [L / スコープ]

**概要**: 前回 ROADMAP は「次の HF 層 API 変更に同乗」を着手条件にしていた。今回 `openHfFile` の追加でその条件が満たされた（G2-06 / G1-14 / G3-18 / G4-07 の 4 レッグが独立に指摘）。内容は src/hf/mod.ts:173-180 のインライン型に名前を付けて export するだけ（追加のみ・挙動不変・下流がラッパを書けるようになる）。
* a) 同乗させる ★推奨 — 条件が満たされた今が最小コスト（型 1 つ・JSDoc 1 つ・`./hf` の export 1 行・README の型一覧 1 行）。リリースノートに 1 項目。
* b) 見送る（ROADMAP 継続） — レビュー依頼の範囲外という理由で。次の HF 層変更まで持ち越し。
**リスク**: a) は無し（名前だけの追加）。
**対象**: src/hf/mod.ts:171-181
**影響範囲**: src/hf/mod.ts・README の型一覧・リリースノート。
**引き継ぎ**: a) ならコミット 1 とは別に `feat(hf): HfResolveOptions を公開` の 1 コミット。

### 5. `deno test --sanitize-resources` で赤になる既存テスト 16 本（Cache 応答の body 未消費）をどう扱いますか？ [隣接問題 / テスト衛生]

**概要**: G3-10 の裏取りで資源サニタイザを付けて全テストを回したところ、今回の差分由来 1 本（G3-10 で修正）に加えて **0.7.0 以前からの 16 本**が「`CacheResponseResource` が閉じられていない」で赤になる。内訳はテスト側が `cache.match(...)` で応答を取り headers だけ見て body を放置しているパターン（mod.test.ts に 39 か所）。ライブラリ側の self-heal 経路（core.ts:731）は cancel 済みで、ライブラリのリークは今回の G3-10 以外に見つかっていない。守っている目的は「長時間動く下流でハンドルを溜めない」（ADR 0012 の主用途）。
* a) 0.8.0 は先に出し、次タスクで 16 本を直して `deno.json` の test task に `--sanitize-resources` を常設する ★推奨 — 差分外・テスト側の問題で利用者影響が無い。常設すれば今後の body 解放漏れ（G3-10 型）を横断的に赤にできる。
* b) 0.8.0 前に直す — リリースが 1 タスクぶん遅れる。
* c) 直さない（ROADMAP 低）。
**リスク**: a) の間、ライブラリ側の解放漏れは 1-2 のテストだけが守る。
**対象**: src/mod.test.ts / src/hf/mod.test.ts の `cache.match(` 後に body を消費しない箇所（一覧は `.claude/reviews/2026-09-07_6f586e2/sanitize-resources.log`）。
**影響範囲**: テストのみ + deno.json の task 1 行。
**引き継ぎ**: 16 本のテスト名は本ファイル末尾「隣接問題」に転記。修正は `await cached.body?.cancel()` か `arrayBuffer()` で消費する。

参考の優先度感: 2 > 1-1 = 1-2 > 3 > 4 > 5。

## 検証パス評定（反証レッグ → オーケストレータ最終突合）

各所見の「レビューレッグの重大度 → 反証レッグの verdict / 重大度」。refuted は取り下げ、L は反証対象外（レビューレッグの評価のまま）。

| ID | 所見（レビューレッグ） | 反証 verdict / 重大度 | 内容 |
| --- | --- | --- | --- |
| G1-01 | E | holds / E | "stream" 戦略の read が再 match 時に記録ハッシュを再確認せず、差し替わったエントリを黙って返す |
| G1-02 | W | refuted / L | "blob" 戦略の open は確保失敗（RangeError）も miss へ縮退させる（同じ原因が readFromStream では throw） |
| G1-03 | W | holds / L | blob() の失敗を op: "match" として通知するので、診断で「match は成功したのに match 失敗」と読める |
| G1-04 | W | holds / L | readFromStream の body === null 分岐が未凍結（Deno では到達可能・ライブラリ経路では到達不能） |
| G1-05 | W | holds / L | length === 0 と「1 チャンク内に収まる読み」の境界が未凍結（"blob" と "stream" で経路が大きく違う） |
| G1-06 | W | holds / W | 並行 read と「read 中の cache.match 失敗が縮退しないこと」が未凍結 |
| G1-07 | W | holds / L | 「clearCache でエントリが消えれば次の read が throw」はブラウザでは成立しない可能性がある（needs-human） |
| G1-08 | L | —（L は反証対象外） | "stream" は本文長を知る前に length ぶんを確保するので、小さいエントリへ巨大な length を投げると確保だけが先に走る |
| G1-09 | L | —（L は反証対象外） | failure.cause = error は new Error(msg, { cause }) 形式に揃えたい |
| G1-10 | L | —（L は反証対象外） | CachedEntry.read の戻り型は Uint8Array<ArrayBuffer> まで絞れる |
| G1-11 | L | —（L は反証対象外） | outOfRange のメッセージ内の offset + length は安全整数の和で桁落ちしうる |
| G1-12 | L | —（L は反証対象外） | OpenCachedOptions.read（戦略名）と CachedEntry.read（関数）が同名で読みにくい |
| G1-13 | L | —（L は反証対象外） | openCachedUrl は single-flight に参加しないことが文書に無い |
| G1-14 | L | —（L は反証対象外） | ROADMAP G3-05（HfResolveOptions）の発火条件が満たされた（担当外・記録のみ） |
| G2-01 | W | holds / L | 内部導管を列挙するコメントに openCachedUrlWithKey が足されていない（同一ファイル内の文書ドリフト） |
| G2-02 | W | holds / W | 「読み出しに使わない expectedBytes / into でも toSpec が throw する」がテストで凍結されていない |
| G2-03 | W | holds / L | HfOpenOptions の転送 3 項目のうち onCacheError だけ透過テストが無い |
| G2-04 | W | holds / L | onCacheError の通知 op 列挙に self-heal の delete が抜けている（JSDoc / ADR 0012 §4 の双方） |
| G2-05 | W | holds / L | openHfFile がエラー・警告に出す URL ラベルが未解決 revision 入りで、取得元でも保存キーでもない |
| G2-06 | W | holds / L | 前回 ROADMAP G3-05（HfResolveOptions の名前付き公開型化）の同乗条件が今回発火している |
| G2-07 | L | —（L は反証対象外） | HfOpenOptions の転送は漏れなし（確認済み）。JSDoc の書式だけ兄弟型とわずかに非対称 |
| G2-08 | L | —（L は反証対象外） | OpenCachedOptions に型レベル JSDoc が無く deno doc --lint の missing-jsdoc が 6→7 件に増えた（slow types は 0 件） |
| G2-09 | L | —（L は反証対象外） | CLAUDE.md:12 の行幅が周囲から突出（約 114 桁 vs 周囲 90 桁以下） |
| G2-10 | L | —（L は反証対象外） | sha256 未宣言エラーのテンプレートリテラルが 1 行 239 バイト（ライブラリ最長） |
| G2-11 | L | —（L は反証対象外） | ROADMAP G3-07（prefetch の into 記述に共通の容量検査を添える）のズレが 1 段深まった |
| G2-12 | L | —（L は反証対象外） | ROADMAP G3-06（expectedBytes 拒否文言と安全整数判定の不一致）の入口が 1 つ増えた |
| G2-13 | L | —（L は反証対象外） | CachedEntry に「何を開いたか」の識別情報が無く HfPrefetchResult と非対称 |
| G3-01 | E | holds / W | stream 戦略の中断テストがチャンク境界での中断を縛れていない（実測でチャンク 0 個読みのまま落ちる） |
| G3-02 | E | holds / W | self-heal の delete 失敗通知（op: "delete"）が未テスト — try/catch を外しても全テスト緑 |
| G3-03 | E | holds / W | "blob" 戦略に signal を渡すテストがゼロ（core.ts:1478 を削除しても緑） |
| G3-04 | E | holds / L | length 0 / offset == size / offset > size(length 0) の境界が両戦略とも未テスト |
| G3-05 | E | holds / W | readFromStream の body === null 分岐（core.ts:1515-1519）が未到達 — 実 Cache では到達不能で DI 専用 |
| G3-06 | W | holds / L | 「バッファを確保できません」文言と cause の保持が未 assert（"範囲外" しか見ていない） |
| G3-07 | W | holds / L | 既定 onCacheError（defaultOnOpenCacheError）の文言が未テスト — ADR 0012 §4 の決定に回帰ガードが無い |
| G3-08 | W | holds / W | 非 Deno ランタイムの既定戦略 "blob" が未テスト（defaultReadStrategy を () => "stream" 固定にしても緑） |
| G3-09 | W | holds / W | 予約 origin ガードの入口列挙に openCachedUrl が加わっていない（normalizeUrl を外しても緑） |
| G3-10 | W | holds / E | body の解放（cancel）3 か所が未観測 — readFromStream の finally を外しても緑 |
| G3-11 | W | holds / W | チャンク跨ぎの網羅がランタイム実装依存（主張自体は実測で成立するが、テストが強制していない） |
| G3-12 | W | holds / L | openHfFile の onCacheError 透過が未テスト（read / caches だけ観測している） |
| G3-13 | W | holds / W | openHfFile の JSDoc が明言する toSpec 検査（expectedBytes 負 / into 容量不足）が未テスト |
| G3-14 | W | holds / L | readFromBlob の短返りガード（core.ts:1487-1491）が未到達 |
| G3-15 | W | holds / L | prefetchUrl / prefetchHfFile で温めたエントリを開くテストが 1 本も無い |
| G3-16 | L | —（L は反証対象外） | finally の caches.delete が無いテストが 2 本ある（規約から外れている） |
| G3-17 | L | —（L は反証対象外） | blob() 失敗の通知 op が "match" である割り当てが未文書化 |
| G3-18 | L | —（L は反証対象外） | ROADMAP G3-05（resolveHfRevision の opts を HfResolveOptions へ）の発火条件が満たされた |
| G3-19 | L | —（L は反証対象外） | テスト名と内容の乖離: 「区間読みは検証系オプションを持たない」を何も assert していない |
| G3-20 | L | —（L は反証対象外） | assertRange の 4 項 OR のうち 2 項が未踏 |
| G3-21 | L | —（L は反証対象外） | openHfFile の repo kind / hubUrl 差によるキー一致が未テスト |
| G3-22 | L | —（L は反証対象外） | 偽 CacheStorage のボイラープレートが 3 種に増えた（src/testing/ へ畳める） |
| G4-01 | W | holds / L | onCacheError が op: "delete" も通知することが文書 4 か所のどこにも無い（refuted） |
| G4-02 | W | holds / L | blob() 失敗が op: "match" を名乗ることがテストで凍結済みなのに未文書 |
| G4-03 | W | holds / L | caches の無いランタイムで区間読みが undefined を返すことが README Runtime support / limitations に無い |
| G4-04 | W | holds / W | 「開いたハンドルはスナップショットではない」が英語 README にだけ無い |
| G4-05 | W | holds / L | 中断（signal）の粒度と「open は中断できない」ことが limitations.md に無い |
| G4-06 | W | holds / L | "stream" の body === null を「0 バイト」と断定してよいか（needs-human） |
| G4-07 | W | holds / L | ROADMAP G3-05（HfResolveOptions の名前付き公開型化）の発火条件が満たされた |
| G4-08 | L | —（L は反証対象外） | README:316-320 の折り返しが崩れている |
| G4-09 | L | —（L は反証対象外） | CLAUDE.md:12 だけ行幅が突出 |
| G4-10 | L | —（L は反証対象外） | 同じ事実が 5 か所に重複しており将来のドリフト源 |
| G4-11 | L | —（L は反証対象外） | ADR 0012 §1 のスニペットが型として通らない |
| G4-12 | L | —（L は反証対象外） | README に「sha256 省略 = 無検証の生読み」が無い |
| G4-13 | L | —（L は反証対象外） | 実測値は検証不能（uncertain 一覧）＋ ADR 表の Chrome 行にサイズ表記が無い |
| G4-14 | L | —（L は反証対象外） | README の HF 節から openHfFile への相互参照が無い |
| G4-15 | L | —（L は反証対象外） | 区間指定の形式検査（負・非整数は throw）が公開文書に無い |
| G4-16 | L | —（L は反証対象外） | ADR §5「ref.revision は解決も参照もされない」が実挙動と表現ずれ |

**refuted 1 件の取り下げ理由（G1-02）**: 「"blob" 戦略の `blob()` が確保失敗（RangeError）しても miss へ縮退するのは非対称」という所見。反証レッグの実測で、Deno 2.9.6 では 300 MiB の `blob()` は成功し、`new Uint8Array(1e12)` で初めて RangeError、実際にメモリを枯らすと catch 不能なプロセス死になるため「catch できる RangeError で縮退する」経路は現実に到達しない。かつ `readFromStream` の確保失敗は「呼び出し側が申告した長さ」の失敗で軸が違う。修正不要。

**オーケストレータ最終突合（反証結果への上書き）**:
- G3-10 の W→E 格上げを採用（反証レッグが実装バグを発見。`--sanitize-resources` で主セッションでも再現: 「openCachedUrl: 範囲外の区間は throw する（stream 戦略）」が赤）。
- G3-01 / G3-02 / G3-03 / G3-05 の E→W 格下げを採用（実装は正しく、欠けているのは凍結）。
- G4-06 の a)（body 必須の専用 throw）は反証レッグの指摘（body null かつ真に 0 バイトのエントリは Deno でも作れる）を採り、制御フロー据え置き + 文書 1 文（1-7）に落とした。
- G1-12（`read` の命名、L）は「リリース後は変更不可」という時間軸の理由で要判断 2 へ格上げした。

## 実施概要

- **モード**: A（差分レビュー）。差分は v0.7.0（525c213）..HEAD（6f586e2）の 1 コミット。前回レビュー（2026-09-05_833e5bc）の未消化項目は全て「実利用フィードバック待ち」の ROADMAP で、今回発火したのは G3-05 だけ（要判断 4）。
- **レンズ**: G1 cache 層実装（正しさ・並行性・資源所有・fail-loud）/ G2 HF 層 + ファサード + API 表面 / G3 テスト品質 + ギャップ（フォルト注入の思考実験 + Deno 実測）/ G4 文書 4 面（README / ADR 0012 / limitations / JSDoc）の主張突合。
- **モデル配分**: ファンアウト 4 本 = `opus` effort `high`（差分が core ↔ hf ↔ facade を跨ぎ、G1 が並行性と資源所有を含むため policy のエスカレーション条件に該当。フェーズ内で effort を揃えてキャッシュ共有）。反証 35 本 = `opus` effort `high`（同じ理由）。合計 39 レッグ・約 359 万トークン・25 分。Pass2 の追加派遣は不要と判断: 反証で uncertain が 0、E/C の集中も無し。
- **レッグへの制約**: 読み取り専用・自分の findings ファイルのみ書き込み・`deno test` / `deno task` 禁止（固定名前空間の並列ハング対策）・実験は scratchpad の使い捨てスクリプトで専用 Cache 名前空間を使い終了時に削除。主セッションが `deno task check` / `deno publish --dry-run` / API 表面突合 / サニタイザ実行を担当。
- **CI 状況**: 修正前 `deno task check` 緑（241 passed）。修正後（b7fdb54）緑（262 passed / 0 failed / 1 ignored）、`deno publish --dry-run` 成功、公開 API 表面は追加 8（openCachedUrl / CachedEntry / OpenCachedOptions / openHfFile / HfOpenOptions / HfResolveOptions + hf の CachedEntry 参照）・削除 0。

## ファイル別分類（統合）

| ファイル | 分類 | 根拠 |
| --- | --- | --- |
| src/core.ts | 🟠 E | G1-01（差し替え後の "stream" read が別内容を返す）/ G3-10（確保失敗時の body 未解放）。区間算術・入口検査・self-heal との同型性は証明済み |
| src/mod.test.ts | 🟠 E | 12 本すべて実装を縛れているが、中断粒度・解放・境界・非 Deno 既定・予約 origin など 15 件の凍結抜け（G3-01〜15） |
| src/hf/mod.ts | 🟡 W | 実装バグ無し。内部導管コメントのドリフト（G2-01）・ラベル URL の説明不足（G2-05）・`HfResolveOptions` 同乗（G2-06） |
| src/hf/mod.test.ts | 🟡 W | `onCacheError` 透過・`toSpec` 検査・`kind` / `hubUrl` のキー一致が未凍結（G3-12 / 13 / 21） |
| README.md | 🟡 W | ハンドル非スナップショットの欠落（G4-04）ほか追記 5 点・折り返し崩れ |
| docs/decisions/0012-open-cached-range-read.md | 🟡 W | 差し替え未考慮（G1-01）・`op` 一覧の抜け・§1 スニペットの型・§5 の表現 |
| docs/limitations.md | 🟡 W | 中断粒度・caches 無し・single-flight 非参加・clearCache のランタイム差が無い |
| CLAUDE.md | 🔵 L | Layout は実装と完全一致。12 行目の行幅のみ |
| src/mod.ts | 🟢 S | 値 1・型 2 の再公開のみ。内部導管は非公開のまま（ADR 0008 §1 維持） |
| src/testing/mock_fetch.ts | 🟢 S | 変更なし・使い方は妥当 |
| docs/known-issues.md | 🟢 S | 追記不要（区間読みの穴は全て by-design で limitations が置き場） |

## 過去レビューからの進捗

- 2026-09-05_833e5bc の ROADMAP（優先度中 5 件・低 9 件）: 着手条件は全て「実利用フィードバック待ち」。今回の差分で発火したのは **G3-05（`HfResolveOptions`）** のみ → 要判断 4。G3-06（`expectedBytes` 拒否文言と安全整数判定の不一致）と G3-07（prefetch の `into` 記述）は `openHfFile` の追加で該当箇所が 1 つずつ増えた（ROADMAP に注記）。
- 2026-09-02_3b13d16 / 2026-08-28_c91e955 の ROADMAP: 変化なし（継続）。

## アクションアイテム・次回観点

- 裁定後: コミット 1 fix（1-1 / 1-2 / 要判断 2）→ コミット 2 test（1-3〜1-18）→ コミット 3 docs（1-19〜1-31 / 要判断 3）→（要判断 4 なら）feat(hf) → bump → ノート確定 → 独立レッグ 2 本で突合 → SendUserFile。
- 次回観点: (1) 資源サニタイザ常設（要判断 5）と、その上で `fetchBytes` / `prefetchUrl` 各経路の body 解放を横断で凍結 (2) ブラウザ実測（clearCache 後の保持 Cache の寿命・0 バイトエントリの body が null か・`Blob.slice` の定数時間）— ADR 0012 の前提はブラウザ側が未実測 (3) `body == null`（`undefined` を返す旧ランタイム）の扱いは readBody（0.7.0 既存）と readFromStream で共通の別件。
- 検査メソッドのメモ: 反証レッグに「専用 Cache 名前空間で `deno run` の実験可」を許すと、境界・チャンク長・資源テーブルまで実測で決着した（uncertain 0 の主因）。`--sanitize-resources` は主セッションで 1 回回すだけで実バグ 1 件と隣接問題 16 件を拾った — 次回から baseline に含める。

## 隣接問題（対象外・報告のみ）

`deno test --allow-read --sanitize-resources` で赤になる 0.7.0 以前からのテスト 16 本（全て `"CacheResponseResource" was created during the test, but not cleaned up`）:

- fetchHfFile: sha256 無しの既定キーは SHA 固定 resolve URL（従来どおり）
- fetchHfFile: sha256 一致で取得され、既定キーは内容キー（revision 非依存）になる
- fetchHfFile: kind はキーに含まれる（model と dataset は同一 repo/path/sha256 でも別エントリ）
- fetchHfFiles: 1 ファイルの失敗で全体が reject し、成功分のキャッシュは残る
- prefetchHfFile: 戻り値の revision / url が温めたエントリを指し、渡し回せば upstream が動いてもヒットする
- prefetchHfFile: spec.sha256 で内容キーに温まり、読み出しと無ハッシュで噛み合う
- sha256: network 取得を検証し、記録ハッシュをエントリへ焼く
- sha256: 無検証 prefetch → sha256 付き読み出しで記録が補完され、ヒットのまま
- sha256: 記録 ≠ 期待は実バイトが期待と一致していても evict して取り直す（判定は記録のみ）
- sha256: 記録 ≠ 期待は「内容が変わった」として同じキーを上書きする（安定キーのピンポン凍結)
- fetchBytes: 確保できないほど巨大な content-length でも取得は落とさず蓄積経路で完走する
- prefetchUrl: key + sha256 の記録はキー側に焼かれ、同じ key の読み出しに繋がる
- prefetchUrl: 記録なしエントリへの sha256 付き prefetch は検証付きで温め直す
- prefetchUrl: sha256 未指定なら記録は付かない（既定の無検証格納は不変）
- 再試行: prefetchUrl 経路も同じ 1 本を通る
- 再試行: prefetchHfFile 経路にも retry / onRetry が透過する

（17 本目「openCachedUrl: 範囲外の区間は throw する（stream 戦略）」は今回の G3-10 で修正対象。）

## 実施済み指摘の記録（裁定後に追記）

裁定（2026-09-07）: 1 全件・2a・3a・4a・5a。

| 所見 / 要判断 | commit | 内容 | 検証 |
| --- | --- | --- | --- |
| 要判断 2（a） | 0355251 `refactor` | `OpenCachedOptions.read` / `HfOpenOptions.read` → `strategy`。入口のエラー文言も「strategy は …」。README / ADR 0012 / テストを追従 | `deno task check` 緑（241） |
| G3-10 / G1-09 | d13dd23 `fix` | バッファ確保を `cache.match` より前へ。確保失敗の cause は `new Error(msg, { cause })`。テスト「完走 / 末尾到達 / 確保失敗 / 中断のどの経路でも取った body を手放す」（cancel / close を数える偽 Cache） | check 緑（242）。`--sanitize-resources --filter "範囲外の区間"` 2 passed（修正前は stream 側が赤） |
| G1-01 | 029255a `fix` | `readFromStream` に期待 sha256 を持ち回り、再 match の記録ハッシュ不一致で body を cancel して throw。テスト「記録ハッシュを毎回再照合し、開いた後に差し替わったエントリで throw する」（fetchBytes(sha B) の self-heal で差し替え → read が reject、sha B で開き直せる、無検証は現在値を読む） | check 緑（243）。修正前は B の中身が返る（反証レッグ実測） |
| 要判断 4（a） / G2-06 | 4921426 `feat(hf)` | `resolveHfRevision` のオプション型を `HfResolveOptions` として `./hf` から公開（追加のみ）。型で渡すテスト 1 本 | check 緑（244）。fmt 漏れを amend で修正（未 push） |
| 1-3 〜 1-18 | 0d2aff6 `test` | Opus レッグが 18 本追加（宣言 16・戦略ループで +2）。既存 assertion は不変（触ったのは中断テストのコメント・finally 補完 2 本・改名 1 本・テーブル行追加）。大文字予約 origin テストへの 1 行はオーケストレータが追加 | check 緑（262）。フォルト注入 14 変異すべて赤（src 複製で実施）。`--sanitize-resources --filter openCachedUrl` 32 passed / `openHfFile` 8 passed |
| 1-19 〜 1-31 / 1-7 文書側 / 要判断 3（a） | 0652e02 `docs` | Opus レッグが README / ADR 0012 / limitations / CLAUDE.md / JSDoc を同期（src はコメント行のみ — `git diff -U0` で非コメント行 0 を確認）。契約外の追加開示: openCachedUrl JSDoc の clearCache 記述も書き分けに揃えた（1-31 と同型）。`CachedEntry.read` JSDoc の形式検査 1 句はオーケストレータが追加 | `deno doc --lint` missing-jsdoc 7→6。README 例 2 本 + ADR §1 スニペットの deno check 通過 |
| 1-32 | b7fdb54 `chore(release)` | `deno task bump minor` → 0.8.0（deno.json + src/mod.ts）。verify_tag v0.8.0 OK / `deno publish --dry-run` 成功 | check 緑（262） |
| リリースノート | RELEASE_NOTES_0.8.0.md | 独立レッグ 2 本で突合（Opus high）: 主張 40 件 = holds 38 / refuted 1（limitations の指し先違い）/ uncertain 1（「無検証 prefetch」は単独では差し替えない）、両方向網羅 = missing 2（caches 無しランタイムの undefined・sha256 形式検査）/ phantom 2（同上 + clearCache の機構説明）。5 点をノートへ反映済み。内部事情の漏れ 0 | SendUserFile で送付済み |
| 要判断 5（a） | — | 0.8.0 後の次タスク（ROADMAP.md 優先度中に記載）。全体サニタイザは 17 失敗のまま = 既存 16 本 + 「範囲外の区間（stream）」の巻き添え 1 本（前のテストの漏れがこのテスト中に回収された、単独実行は緑） | — |
