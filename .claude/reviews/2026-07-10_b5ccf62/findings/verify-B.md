# verify-B: 「URL 未エンコードは欠陥」所見の敵対的検証

対象: `src/hf/mod.ts`（W-B-1: resolveHfRevision の revision 未エンコード / W-B-2: hfResolveUrl の path・revision 未エンコード）
検証日: 2026-07-10（huggingface.co への実測 6 リクエスト: 軽量 GET/HEAD のみ）

---

## W-B-1: resolveHfRevision（src/hf/mod.ts:84-86）revision 未エンコード

**verdict: holds** / **severity: Error**（現状の Critical 相当主張なら過大、Warning なら過小）

### 根拠

1. **HF サーバー実測（実装挙動・2026-07-10）** — 未エンコード slash revision は API ルーティングで 404:
   - `GET https://huggingface.co/api/models/openai-community/gpt2/revision/refs%2Fpr%2F1` → **200**
   - `GET https://huggingface.co/api/models/openai-community/gpt2/revision/refs/pr/1` → **404**
   - （改名リダイレクト交絡を除くため正準リポ名で確認。旧名 `gpt2` でも encoded=307 / unencoded=404 で同傾向）
2. **公式 Python 実装（huggingface_hub/src/huggingface_hub/hf_api.py:3300, 3371, 3511, main ブランチ）**:
   ```python
   f"{self.endpoint}/api/models/{repo_id}/revision/{quote(revision, safe='')}"
   ```
   `safe=''` なので `/` も `%2F` にエンコードされる。datasets / spaces / kernels も同形。
3. **公式 JS 実装（huggingface.js/packages/hub/src/lib/paths-info.ts:97-98）**:
   ```ts
   const url = `${hubUrl}/api/${repoId.type}s/${repoId.name}/paths-info${revision ? `/${encodeURIComponent(revision)}` : ""}`
   ```
4. **slash 入り revision は第一級入力**（HF 公式 docs「HF URIs」）: revision の許容値は
   「Branch, tag, commit SHA, or **special ref (`refs/pr/N`, `refs/convert/...`)**」。さらに
   「any other branch/tag name containing `/` **must be URL-encoded** (`feature%2Ffoo`)」と明記。
   dataset の parquet 自動変換（`refs/convert/parquet`）・PR 取得（`refs/pr/N`）・`feature/xxx`
   ブランチはいずれも slash 入りで、エッジケースではない。

### 主張の訂正（部分反証）

- **`?` 入り revision は branch/tag として存在不可能**。git-check-ref-format（仕様）は refname に
  `space ~ ^ : ? * [ \` を禁じる。よって「`?` 入り ref で壊れる」は現実の ref では起きない
  （ユーザーのゴミ入力でのみ発生し、その場合も 404 → loud throw）。
- **`#` は git refname 的には合法**だが HF 上の branch 名として稀。`#` 入り revision（例 `v1#beta`）は
  fetch が fragment を落とすため `v1` として解決され、`v1` が実在すると**黙って別 revision の sha を返す**
  silent 系が理論上ある（唯一の silent 経路、発生確率は低い）。
- slash ケースの failure mode は **loud**（404 → src/hf/mod.ts:89-93 で throw）。データ破損・キャッシュ汚染は
  ない（解決失敗はキャッシュ前）。よって Critical ではなく **Error**（第一級の revision 形式が全滅する機能欠陥）。

### 仕様保証 vs 実装挙動

- 「HF が `%2F` を要求する」は **huggingface.co ルーティングの実装挙動**（実測 + HF docs の記述で裏付け。
  API 契約としての保証文書はない）。正直な留保: HF サーバーが将来 `refs/pr/N` を eager にマッチする可能性は
  ある（huggingface_hub 自身の URL *パーサ* は eager マッチする）が、公式クライアント 2 系統が揃って
  エンコード形を出力しており、エンコード側が正準。

---

## W-B-2: hfResolveUrl（src/hf/mod.ts:60-67）path / revision 未エンコード

**verdict: holds**（機構は成立。ただしサブ主張 2 点を訂正 — 範囲は主張より狭い）/ **severity: Warning**

### 成立する部分

1. **`#` 入り path → fragment 落ち（仕様保証）**: RFC 3986 §3.5（fragment は dereference 前に分離され
   サーバーへ送られない）、RFC 9112 の request-target（origin-form = absolute-path [ "?" query ]、fragment の
   居場所がない）、WHATWG Fetch（request URL は exclude-fragment で直列化）。
   `config#v2.json` → 実リクエストは `.../config`。`config` が実在すれば**黙って別ファイル取得**、
   なければ 404（loud）。さらに Cache API のマッチも fragment を無視するため、`config#v2.json` と
   `config#v3.json` が**同一キャッシュキーに衝突**する（2 個目は 1 個目のバイト列を silent に返す）。
2. **特殊文字入り path は HF 上に実在し得る（公式が明言）**: huggingface_hub installation docs が
   「filepaths on the Hub can have special characters (e.g. `path/to?/my/file`)」と例示。
   HF URIs docs も「Special characters in the path (spaces, `#`, ...) are **percent-encoded**」
   （`to_url()` の正準形）と明記。
3. **公式 Python 実装（huggingface_hub/src/huggingface_hub/file_download.py:278-279, main ブランチ）**:
   ```python
   url = constants.HUGGINGFACE_CO_URL_TEMPLATE.format(
       repo_id=repo_id, revision=quote(revision, safe=""), filename=quote(filename)
   )
   ```
   `quote(filename)` は既定 `safe="/"` — slash 構造を保ち `# ? % space` をエンコード。所見の修正案と一致。
4. **revision 側（公開 API として）**: `hfResolveUrl` は export された公開 API で、可変 slash ref を直接
   渡すと 404（実測: `/resolve/refs%2Fpr%2F1/README.md` → 307→**200**（final URL は PR の sha
   `81fd1d6e...` を含む resolve-cache）に対し、`/resolve/refs/pr/1/README.md` → **404**。
   ファイル実在下でのルーティング失敗を証明）。

### 訂正するサブ主張（部分反証）

- **「非正準 path でキャッシュキー割れ」は概ね不成立**。cache キーは `cache.match(url文字列)` →
  Request 構築時に WHATWG URL 正規化（dot-segment 除去、space→`%20`、非 ASCII→UTF-8 %エンコード）を通る
  ため、`a/./b` と `a/b`、`fi le` と `fi%20le` は**同一キーに収束**する。現実のキー事故は `#` 衝突
  （上記 1）のみで、「非正準ゆえに割れる」方向の主張は誤り。
- **内部フローでは revision 半分は無害化済み**: `fetchHfFile` / `fetchHfFiles` は必ず
  `resolveHfRevision` → 40 桁 hex SHA を `fetchResolvedFile`（src/hf/mod.ts:163, 188, 201）に渡すため、
  ライブラリ主経路の resolve URL の revision に slash は入らない。壊れるのは `hfResolveUrl` 直接利用時のみ。
- **公式 huggingface.js も path をエンコードしていない**（file-download-info.ts:54-58, main ブランチ）:
  ```ts
  const url = `${hubUrl}/${...}${repoId.name}/${params.raw ? "raw" : "resolve"}${revision ? `/${encodeURIComponent(revision)}` : ""}/${params.path}`
  ```
  → 現実装は出荷中の公式クライアント 1 系統と同挙動であり「明白な欠陥」より「公式クライアント間でも
  割れている共有の穴」。加えて src/hf/mod.ts:58 の docstring が「path は URL エンコードしない前提」と
  **意図として明文化**している（ただしその根拠「HF のパスは素の相対パス」は上記 2 の公式記述と矛盾し
  事実として弱い）。
- 発生頻度: `#`/`?` 入り filename は Hub 上で稀。大半の failure shape は loud（404）。
  silent 系は「`#` 切断後の path が偶然実在」+「sha256/expectedBytes 未指定」が重なった場合のみ
  （validate 指定時は self-heal 側で検出される）。

### severity 判定

機構は仕様保証レベルで成立し silent-wrong-data の形が 1 つある一方、要求される入力が稀・公式 JS も同挙動・
主経路の revision は SHA 固定 — 総合で **Warning**（修正推奨。Error とするには主経路での発生条件が弱い）。

---

## 推奨修正形（両所見共通）

```ts
// resolveHfRevision (src/hf/mod.ts:84-86)
const url = `${hubUrl}/api/${
  API_SEGMENT[kind]
}/${ref.repo}/revision/${encodeURIComponent(revision)}`;

// hfResolveUrl (src/hf/mod.ts:64-66)
const encodedPath = ref.path.split("/").map(encodeURIComponent).join("/");
return `${hubUrl}/${
  RESOLVE_PREFIX[kind]
}${ref.repo}/resolve/${encodeURIComponent(revision)}/${encodedPath}`;
```

- **revision → `encodeURIComponent`**: huggingface.js と完全一致、Python `quote(safe="")` と意味的に一致。
  差分は `! * ' ( )`（Python はエンコード、ECMAScript はしない）のみで、huggingface.js が同差分のまま
  同一サーバーで運用実績あり — 実害なし。40 桁 hex SHA には恒等変換なので、内部フロー（SHA 固定 URL）の
  キャッシュキーは修正前後で不変。
- **path → `split("/").map(encodeURIComponent).join("/")`**: Python `quote(filename)`（safe="/"）と
  意味的に一致（slash 構造保持、`# ? % space` を無害化）。契約は「path は生文字列」
  （事前エンコード済み入力は二重エンコードされる）— huggingface_hub と同一契約。docstring の
  「エンコードしない前提」記述の更新が必要。
- **repo は絶対にエンコードしない（確認済み）**: Python はテンプレートに `repo_id` を生で埋める
  （file_download.py:278）、JS も `repoId.name` を生で使用。`owner/name` の slash はルーティング構造で、
  `owner%2Fname` にすると壊れる。
- **キャッシュキー移行問題は無視可（確認済み）**: プロジェクト CLAUDE.md「未リリースなので migration /
  後方互換 shim は書かない。breaking change は可」。かつ主経路キー（SHA + 通常 path）は恒等変換で不変、
  最悪でも 1 回の再ダウンロード。
- **テスト影響**: 既存アサーション（src/hf/mod.test.ts:20-45, 62, 72, 105 等）はすべてエンコード不変な
  入力のため緑のまま。`refs/pr/1` / `#` 入り path のケースを追加すべき（既存テストの書き換え不要）。

## 参照

- huggingface_hub `file_download.py` L278-279 / `hf_api.py` L3300, 3371, 3511 / `constants.py` L69
  （raw.githubusercontent.com, main, 2026-07-10 取得）
- huggingface.js `packages/hub/src/lib/file-download-info.ts` L54-58 / `paths-info.ts` L97-98（同上）
- HF docs「HF URIs」: https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_uris
  （special ref の第一級扱い / `feature%2Ffoo` エンコード必須 / path 特殊文字の percent-encode）
- HF docs「Installation」:「path/to?/my/file」特殊文字 filename の実在例
- RFC 3986 §3.5 / RFC 9112 §3.2（request-target）/ WHATWG Fetch（exclude-fragment 直列化）
- 実測: huggingface.co への GET/HEAD 6 回（encoded 200/307→200、unencoded 404、2026-07-10）
