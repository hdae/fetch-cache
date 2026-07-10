---
id: C
topic: release-pipeline
files_reviewed:
  - scripts/bump.ts
  - scripts/config_version.ts
  - scripts/release_tag.ts
  - scripts/release_tag.test.ts
  - scripts/verify_tag.ts
  - scripts/version_sync.test.ts
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
  - deno.json
  - deno.lock
  - .gitignore
date: 2026-07-10
model: opus
commit: b5ccf62
---

# Group C — version / release パイプライン

## サマリ

version の単一真実源（`deno.json`）と焼き込み `VERSION`（`src/mod.ts`）の二重管理を
drift ガードで守る設計。**中核の不変条件は堅い**: bump のコミットは deno.json と mod.ts を
**1 コミットにまとめ**、mod.ts の書換えが失敗したら commit 前に fail-loud で止まるため、
**版ズレした commit がパイプラインから生成される経路は無い**。drift は 3 段
（`version_sync.test.ts`＝CI / `verify_tag.ts`＝release / commit 原子性＝bump）で多重防御されている。
release.yml は tag 名を env 経由で渡し（script injection 耐性）、権限も最小（`contents:read` +
JSR OIDC 用 `id-token:write` のみ）で良質。

一方、**ガードの穴は「パイプラインの外周」に集中**する:

1. **bump の部分失敗で working tree が半 bump のまま放置**され（rollback なし）、素朴に
   `git add . && commit` すると**版ズレが commit され得る**（第二防御は CI の version_sync）。→ W-C-1
2. **`scripts/bump.ts` / `scripts/verify_tag.ts` が `deno task check` の型検査対象外**
   （どのテストからも import されず、`deno check` の列挙にも無い）。drift ガード本体の型エラーが
   CI を素通りし、bump/release 実行時に初めて落ちる。→ W-C-2
3. **release.yml は publish 前にテスト/`deno task check` を回さない**（`verify_tag` のみ）。
   red なコミットからでも GitHub Release を切れば JSR へ publish 可能。→ W-C-3
4. **Actions が SHA pin されていない**（`actions/checkout@v7`, `denoland/setup-deno@v2`）。OIDC
   publish 権限を持つ release ワークフローでは供給網リスク。加えて `checkout@v7` の実在は要確認。→ W-C-4
5. **`release_tag.test.ts` に prerelease 受理パス・境界テストが無い**（bump は prerelease を第一級で
   サポートするのにタグ検証側の該当テスト欠落）。→ W-C-5

Critical / Error（確実なバグ）は無し。最上位は Warning ×5。

## ファイル別分類

| File | 分類 | 要点 |
| --- | --- | --- |
| `scripts/bump.ts` | 🟡 W | 部分失敗で deno.json が dirty のまま rollback 無し（W-C-1）。CI 型検査対象外（W-C-2）。regex 脆さ=Low |
| `scripts/config_version.ts` | 🟢 S | `JSON.parse`。JSONC 化時の差し替えを comment 明記。version 空文字/非 string を throw で fail-loud |
| `scripts/release_tag.ts` | 🟢 S | 純関数・依存ゼロ。`v` prefix 厳格 + 完全一致。文字列等価なので prerelease も自然に扱える |
| `scripts/release_tag.test.ts` | 🟡 W | 主要 4 ケースのみ。prerelease 受理 / 境界（"v" 単独, 空, 前後空白）未カバー（W-C-5） |
| `scripts/verify_tag.ts` | 🔵 L | release 時 triple-check は良。ただし本体に unit test 無し + CI 型検査外（W-C-2 に含む） |
| `scripts/version_sync.test.ts` | 🟢 S | 実 VERSION vs 実 deno.json を比較。タウトロジーでなく fault injection で必ず落ちる真の drift 検出 |
| `.github/workflows/ci.yml` | 🟡 W | scripts/ が型検査されない（W-C-2）。Actions 未 pin（W-C-4）。権限最小・発火条件は妥当 |
| `.github/workflows/release.yml` | 🟡 W | publish 前に test/check なし（W-C-3）。Actions 未 pin（W-C-4）。env 経由 tag・最小権限は良 |
| `deno.json` | 🔵 L | `deno check` の列挙が exports を手写しで重複・scripts を含まない（W-C-2 の一因） |
| `deno.lock` | 🟢 S | @std/assert（テスト専用）+ 推移。runtime 依存ゼロと整合 |
| `.gitignore` | 🟢 S | `deno.lock.tmp` の無視あり。--no-lock 防御ナラティブと整合 |

---

## 詳細指摘（Warning 以上）

### W-C-1 — bump 部分失敗で deno.json が dirty のまま放置され、版ズレ commit の罠になる
- **path**: `scripts/bump.ts:58-100`（特に 68-72, 81-86, 97-100）
- **症状**: `deno bump-version`（58-67）が deno.json を書いた**後**の各失敗分岐——
  `after === before`（68-72）、mod.ts の VERSION 行 regex 不一致（81-86）、`git commit` 失敗
  （97-100）——で `Deno.exit(1)` するが、**既に書換え済みの deno.json を元に戻さない**。
  結果、working tree は「deno.json だけ新版・mod.ts 旧版・未コミット」の**半 bump 状態**で停止する。
- **根本原因**: deno.json の書換え（副作用）と、その巻き戻し責務が対になっていない。fail-loud では
  あるが self-cleanup が無い。次回 bump は clean-tree ガード（38-54）が弾くので**連鎖はしない**が、
  利用者が状況を誤読して `git add . && git commit` すると**版ズレが commit される**（唯一の後段防御は
  CI の `version_sync.test.ts`）。パイプライン自身は不正 commit を作らない＝Critical ではないが、
  「手動 commit を誘発する罠」という意味で堅牢性の穴。
- **修正案**:
  1. bump-version 直後に deno.json を stage（`git add deno.json`）し、以降の失敗分岐で
     `git checkout -- deno.json src/mod.ts` を実行して原状復帰してから exit する、または
  2. **順序を反転**して「(a) 新版を算出 → (b) mod.ts と deno.json を両方メモリ上で用意 → (c) 両方書く
     → (d) 失敗時は両方 restore」と、書込みを最後にまとめ書込み失敗の窓を最小化する。
  3. 最低限、失敗メッセージに復旧手順（`git checkout -- deno.json`）を明示する fail-loud 強化。
- **追加テスト**: bump.ts の副作用を持つため統合テスト。tmp git repo を作り (i) mod.ts の VERSION 行を
  わざと壊した状態で bump → 非 0 exit **かつ deno.json が復元されている**こと、(ii) 正常系で
  deno.json と mod.ts が同一版・1 commit・他ファイル非混入、を assert。regex 置換ロジックは
  純関数に切り出して（下記 Low）単体テスト可能にする。

### W-C-2 — drift ガード本体（bump.ts / verify_tag.ts）が CI の型検査対象外
- **path**: `deno.json:13`（check タスク）, `.github/workflows/ci.yml:22`, 対象 `scripts/bump.ts` /
  `scripts/verify_tag.ts`
- **症状**: `deno task check` の型検査は `deno check src/mod.ts src/hf/mod.ts` と
  `deno test`（＝テストの推移グラフ）のみ。**どのテストも `bump.ts` / `verify_tag.ts` を import しない**
  ため（grep 済み: import 元 0 件）、この 2 本は `deno lint` だけで**型検査されない**。型エラーは CI を
  素通りし、`deno task bump` 実行時（ローカル）・release の `verify_tag` 実行時（本番・手遅れ）に初めて
  落ちる。drift を守る当のガード自身が最も緩く守られている。
- **根本原因**: 型検査対象を「テスト経由の推移グラフ + 手写しの entrypoint 列挙」に依存させており、
  import.meta.main 型の孤立スクリプトが漏れる。加えて `deno check` の列挙（`deno.json:13`）は exports
  マップ（`deno.json:5-8`）を手写し重複しており、export 追加時も追随しない派生値の二重管理。
- **修正案**: check タスクに `deno check scripts/*.ts`（または最低限 `scripts/bump.ts scripts/verify_tag.ts`）
  を追加。理想は entrypoint 列挙をやめ、`deno check` にディレクトリ/glob を渡して exports との手写し重複を
  解消する。
- **追加テスト**: 直接のテストより CI 設定の是正が本筋。回帰防止として「型エラーを含む scripts が
  `deno task check` を落とす」ことを一度手で確認（fault injection）。

### W-C-3 — release は publish 前にテスト/`deno task check` を回さない
- **path**: `.github/workflows/release.yml:29-36`（`verify_tag` → `deno publish` のみ）
- **症状**: release は `release: published` で発火し、`verify_tag`（tag==version==VERSION の drift 検証）と
  `deno publish` だけを実行する。**fmt / lint / test（mod.test.ts 等の挙動テスト）を回さない**。
  GitHub Release は任意の commit/tag から作成できるため、**CI（`deno task check`）に通っていない・
  テストが red なコミットからでも JSR へ publish され得る**。`deno publish` は published グラフの型検査と
  slow-types 検査はするが、テストは実行しない。
  - NOTE: drift ガード**そのもの**は `verify_tag` が release でも検証するので、この穴は「挙動テスト全般が
    publish のゲートになっていない」点であり、版ズレ publish は防げている。よって Critical ではなく Warning。
- **根本原因**: release ジョブが CI 成功に依存（`needs:` / 再実行）していない。
- **修正案**（いずれか）:
  1. release ジョブの publish 前ステップに `deno task check` を追加（`--allow-read` 付き。simplest）。
  2. CI を reusable workflow 化し release から `needs`/`uses` で再利用して二重メンテを避ける。
  3. tag が main 到達済み commit を指すことの検証を足す（任意 commit からの release を抑止）。
  推奨は 1（依存ゼロ・追加 action 不要で最小）。
- **追加テスト**: ワークフロー構成のため act 等での dry-run を手順化。最低限、赤いテストを含む状態で
  publish がブロックされることを一度確認。

### W-C-4 — GitHub Actions が SHA pin されておらず供給網露出（かつ `checkout@v7` の実在は要確認）
- **path**: `.github/workflows/ci.yml:16-17`, `.github/workflows/release.yml:21-22`
  （`actions/checkout@v7`, `denoland/setup-deno@v2` — 両ファイル共通）
- **症状**: すべての Action が**可変の major タグ**参照。release.yml は **`id-token:write`（JSR OIDC）** を
  持つため、`checkout` / `setup-deno` タグが乗っ取られると**OIDC トークン奪取や悪性コード publish** の
  経路になり得る（供給網リスク）。グローバル規約が名指しする「pin されてない action への露出」に該当。
- **[needs-human]**: `actions/checkout@v7` の**タグ実在を確認**。当方の知識時点（2026-01）では
  `actions/checkout` の最新は v4 系で、**v7 は未確認**。もし v7 が未公開タグなら action 解決に失敗し
  **CI・release が両方即失敗**する（この場合は Warning ではなく実害 Error）。プロジェクト日付 2026-07 まで
  に v5–v7 が出ている可能性は否定できないため、`gh api repos/actions/checkout/tags` 等で実在確認を要する。
  `denoland/setup-deno@v2` は実在（v2 系）。
- **根本原因**: 可変タグ参照。SHA pin 未採用。
- **修正案**: 各 action を**フルコミット SHA に pin**（`actions/checkout@<sha> # v4.x` 形式でコメント併記）。
  Dependabot / `pinact` 等で更新運用。SHA pin は「v7 実在」問題も同時に解消する（存在する commit を直接指す）。
- **追加テスト**: 該当なし（設定監査）。CI の初回 run が green であることで解決確認。

### W-C-5 — `release_tag.test.ts` に prerelease 受理・境界ケースが無い
- **path**: `scripts/release_tag.test.ts:4-24`（対象実装 `scripts/release_tag.ts:15-35`）
- **症状**: テストは (完全一致 ok / `v` 欠落 fail / 大文字 `V` fail / version 不一致 fail) の 4 本。
  一方 `bump.ts` は `premajor|preminor|prepatch|prerelease`（`scripts/bump.ts:7-15`）を**第一級で
  サポート**し、リリースは `v0.2.0-0` の形を取り得る。**prerelease タグの受理パス**
  （`checkReleaseTag("v0.2.0-0","0.2.0-0")` が ok を返し bare を返す）が**一度も検証されていない**。
  また境界（tag `"v"` 単独＝bare 空 → 不一致 fail / 空文字 tag / 前後空白 `"v0.2.0 "`）も未カバー。
  失敗系は `result.ok === false` のみ assert し、返る error 文言や version は検証していない。
- **根本原因**: サポート済み機能（prerelease）に対するテスト網羅の欠落。実装自体は文字列等価なので
  prerelease でも正しく動く見込みだが、**テストが仕様として固定していない**＝将来 regex 化等の変更で静かに
  壊れ得る。
- **修正案 / 追加テスト**: 以下を追加——
  - `checkReleaseTag("v0.2.0-rc.1","0.2.0-rc.1")` → `{ok:true, version:"0.2.0-rc.1"}`（受理 + bare 返却）。
  - `checkReleaseTag("v","0.2.0")` → fail（bare 空）。
  - `checkReleaseTag("","0.2.0")` → fail（`v` 欠落分岐）。
  - `checkReleaseTag("v0.2.0 ","0.2.0")` → fail（前後空白は等価でない）。
  - 成功系で返り `version` の完全一致も assert（現状 `ok` しか見ていないケースの補強）。

---

## 重要フロー — bump → commit → tag → CI verify → publish ライフサイクル

```
[開発者] deno task bump <inc>
  bump.ts:31-35   引数検証（INCREMENTS 7種以外/未指定 → exit 2, usage）           ── 入力ガード
  bump.ts:38-54   clean-tree ガード（deno.json/src/mod.ts に未コミット変更 → exit 1）── 混入防止
  bump.ts:56      readVersion() before                     [config_version.ts:6-19]
  bump.ts:58-67   deno bump-version -c ./deno.json <inc>  ← ★deno.json を書換え（副作用）
  bump.ts:68-72   readVersion() after / after===before → exit 1（★deno.json は書換え済のまま）─ W-C-1
  bump.ts:76-87   src/mod.ts の VERSION 行を surgical 置換 / 不一致 → exit 1（★deno.json dirty 放置）─ W-C-1
  bump.ts:90-100  git commit deno.json src/mod.ts（両者を1コミット・原子的）★版ズレ commit を作らない要
        │
        ▼
[オーナー・手動]  git tag v<version> && git push（bump.ts:4 の規約。script では tag/push しない）
        │
        ├───────────────► push/PR で発火 ─────────► CI（ci.yml:3-6）
        │                                            └ deno task check（deno.json:13）
        │                                               ├ fmt --check / lint（scripts 含む）
        │                                               ├ deno check src/mod.ts src/hf/mod.ts
        │                                               │   ✗ bump.ts / verify_tag.ts は型検査されない ─ W-C-2
        │                                               └ deno test（version_sync.test.ts=drift 検出／
        │                                                            release_tag.test.ts）
        ▼
[オーナー]  GitHub Release を published（tag v<version>）
        │
        ▼  release.yml:7-9 発火（release: published）
  release.yml:29-32  verify_tag.ts "$TAG"（env 経由=injection 耐性）
        │            verify_tag.ts:20-25  VERSION(mod.ts) == version(deno.json) 検証（release 時 drift 再検査）
        │            verify_tag.ts:26-30  checkReleaseTag: tag == v<version>  [release_tag.ts:15-35]
        │            ✗ ここまでで fmt/lint/test は未実行（red コミットでも到達し得る）─ W-C-3
        ▼
  release.yml:35-36  deno publish（OIDC / id-token:write）→ JSR @hdae/fetch-cache
                     published グラフ = src/**/*.ts − tests − testing（deno.json:19-30）
                     runtime 依存ゼロ（src は @std/assert を import しない・grep 済み）✓
```

多重防御マトリクス（版ズレ検出の層）:

| drift 種別 | bump 原子性 | version_sync（CI） | verify_tag（release） |
| --- | --- | --- | --- |
| deno.json ≠ mod.ts VERSION | ○（1 commit・不一致で commit 前 exit） | ○（`version_sync.test.ts:7-15`） | ○（`verify_tag.ts:20-25`） |
| tag ≠ deno.json version | —（tag は手動） | — | ○（`release_tag.ts:26-34`） |
| 手動半 bump commit（W-C-1 経由） | ✗（罠を作る） | ○（唯一の後段防御） | ○ |

---

## 横断所見

### 良い設計（維持すべき点）
- **commit 原子性**: `git commit deno.json src/mod.ts`（`bump.ts:90-96`）が pathspec commit で両ファイルを
  束ね、mod.ts 置換失敗時は commit 前に exit するため、**版ズレ commit をパイプライン自身が生成しない**。
  中核不変条件は堅い。
- **injection 耐性**: `release.yml:30-32` は `tag_name` を `${{ }}` で run script へ直接展開せず **env 経由**
  で `"$TAG"` 参照＝script injection 耐性。良い実装。
- **最小権限**: `ci.yml:9-10`（`contents:read`）/ `release.yml:13-15`（`contents:read` + `id-token:write`）
  は各ジョブの canonical 最小セット。
- **publish 境界**: `deno.json:19-30` の include/exclude が `src/**/*.test.ts` と `src/testing/**` を除外。
  published entry（mod.ts / hf/mod.ts）は testing を import しない（grep 済み）ため、規約「src/testing/ は
  publish 対象外」「runtime 依存ゼロ」の両方が構造的に成立。scripts/ も include 外で publish されない。
- **fail-loud の徹底**: `config_version.ts:13-17`（version 非 string/空 → throw）、
  `verify_tag.ts` の三重検査、`bump.ts` の各 exit。握り潰し無し。
- **version_sync.test.ts はタウトロジーでない**: 実 export と実 deno.json を比較し、どちらかを弄れば必ず
  落ちる（fault injection 可能）真の drift 検出。

### Low（品質メモ・報告のみ、修正は任意）
- **L-C-a** `bump.ts:77-80` — VERSION 置換 regex `/export const VERSION = "[^"]*";/` は書式に敏感
  （型注釈付与・空白変更で不一致）。ただし `deno fmt --check`（`deno.json:13`）が scripts/src の書式を固定
  するため実害は小。非 global regex ゆえ**最初の 1 件のみ置換**するが、`export const VERSION` は識別子重複＝
  コンパイルエラーになるため二重定義は起き得ず問題化しない。置換ロジックを純関数化して W-C-1 のテストに
  乗せると堅牢。
- **L-C-b** `deno.json:13` — `deno check` の entrypoint 列挙が exports マップ（`deno.json:5-8`）の手写し重複。
  export 追加時に型検査対象へ自動追随しない派生値二重管理（W-C-2 と同根）。
- **L-C-c** `bump.ts:58-63` — 内側の `deno bump-version` サブプロセスは親の `--no-lock`（bump タスク定義,
  `deno.json:14`）を継承しない。deno.lock を書く挙動があれば、bump は deno.json/mod.ts のみ commit するため
  **deno.lock の変更が未コミットで残る**可能性。[推測] 版フィールドのみの surgical 更新なので lock を触らない
  見込みだが、`--no-lock` をサブプロセスにも付けると確実。要動作確認（needs-human・低優先）。
- **L-C-d** `bump.ts:7-15, 33` — `INCREMENTS` は 7 値を受理するが `CLAUDE.md:17` は
  `<patch|minor|major>` と記載。doc/impl 乖離（usage は 7 値表示）。実装が広い分には fail-loud なので実害無し。
  doc 側を prerelease 対応に合わせるか、doc を真実に合わせて更新推奨。
- **L-C-e** `.gitignore:1`（`deno.lock.tmp`）— `--no-lock` 防御ナラティブ（`verify_tag.ts:5-6`）と整合する
  無視エントリ。現状 tmp 生成箇所は本 group に無く、由来は needs-human（低優先の掃除候補）。

### needs-human（当環境で確証不可）
- `actions/checkout@v7` の**タグ実在**（W-C-4）。未公開なら CI/release 即失敗の Error に格上げ。
- `deno bump-version` サブプロセスの deno.lock 書込み有無（L-C-c）。
- `deno.lock.tmp` の生成主体（L-C-e）。
