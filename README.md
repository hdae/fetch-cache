# @hdae/fetch-cache

A zero-dependency, URL-keyed download cache for Deno and browsers, built on the
Web Cache API.

Deno / ブラウザ両対応の「URL ベースの Cache API 付きダウンロード」ライブラリです。モデル・辞書のような
大きめのアセットを URL キーで Cache Storage に保存し、2 回目以降は network なしで返します。検証フック
（バイト数 / SHA-256 など任意の validate）はキャッシュ側にも効き、破損キャッシュは自動で捨てて真実源から
取り直します（self-heal）。HuggingFace Hub 向けの薄い層（`./hf`）も同梱しています。

## 特徴

- **依存ゼロ**: fetch / caches / crypto.subtle など Web 標準 API のみで動きます
- **URL がそのままキー**: `fetchBytes(url)` を呼ぶだけでキャッシュ・再利用。`cache: false` で素の
  fetch にも切り替えられます
- **検証と self-heal**: `validate` フックが network 取得物にもキャッシュ読出しにも適用され、不正物は
  キャッシュせず、破損キャッシュは evict して取り直します（fail loud）
- **進捗コールバック**: streaming 読み出しでチャンク毎に `onProgress` を発火します（`total` は
  content-length があるときだけ）
- **HuggingFace 層**: 可変 ref（`"main"` 等）を現在のコミット SHA に解決してから SHA 固定 URL で
  取得・キャッシュ。`expectedBytes` / `sha256` による整合性検証つきの複数ファイル並列取得も可能です
- **fetch は差し替え可能**: すべての取得関数が `fetch` の DI を受け付けます（テスト・カスタム輸送）

## インストール

```sh
deno add jsr:@hdae/fetch-cache
```

## 使い方

### 汎用層（`.`）

```typescript
import { fetchBytes } from "@hdae/fetch-cache";

// 1回目は network、2回目以降は Cache Storage から（URL がキー）。
const bytes = await fetchBytes("https://example.com/assets/model.onnx");

// キャッシュを使わない素の fetch。
const fresh = await fetchBytes(url, { cache: false });
```

### 進捗と検証（self-heal）

```typescript
const bytes = await fetchBytes(url, {
  onProgress: ({ loaded, total }) => console.log(loaded, total), // チャンク毎。ヒット時は呼ばれない。
  validate: (bytes) => {
    if (bytes[0] !== 0x4f) throw new Error("magic 不一致"); // throw = 不正。
  },
});
```

`validate` はキャッシュ読出しにも適用され、失敗したエントリは evict して network から取り直します
（self-heal）。network 取得物が失敗した場合はそのまま throw し、不正物はキャッシュに残しません。

### キャッシュ管理 API

```typescript
import { clearCache, evictUrl, listCachedUrls } from "@hdae/fetch-cache";

await evictUrl(url); // 指定 URL のエントリを削除（あったら true）。
await clearCache(); // 名前空間ごと削除（既定 "fetch-cache"）。
await listCachedUrls(); // キャッシュ済み URL の一覧。
```

### HuggingFace 層（`./hf`）

```typescript
import { fetchHfFile, fetchHfFiles } from "@hdae/fetch-cache/hf";

// 可変 ref（"main"）は現在のコミット SHA に解決してから SHA 固定 URL で取得・キャッシュ。
// SHA が変わらない限り 2 回目以降は network なし。revision に SHA を渡せば解決リクエストも出ません。
const model = await fetchHfFile(
  { repo: "owner/name" },
  { path: "model.onnx", sha256: "…", expectedBytes: 1234 },
  { onProgress: ({ path, loaded, total }) => console.log(path, loaded, total) },
);

// revision を 1 回だけ解決し、全ファイルを並列取得（名前→バイト列のマップで返る）。
const files = await fetchHfFiles(
  { repo: "owner/name", kind: "dataset", revision: "main" },
  {
    dict: "naist-jdic.jtd.gz",
    meta: { path: "meta.json", expectedBytes: 512 },
  },
);
files.dict; // Uint8Array
```

`expectedBytes` / `sha256` は汎用層の `validate` フックとして実装されているので、キャッシュヒット側にも
効きます（破損キャッシュは self-heal）。

NOTE: `resolveHfRevision` が使う `{hubUrl}/api/…/revision/{ref}` → `{"sha": …}` は HF API の実装挙動
依存で仕様保証ではありません（応答に sha が無ければ throw します）。

## ランタイム対応

| ランタイム | キャッシュ                                                        |
| ---------- | ----------------------------------------------------------------- |
| ブラウザ   | Cache Storage（origin 単位。Secure Context: https / localhost）   |
| Deno       | Cache Storage（ローカル永続）                                     |
| Node.js    | `caches` が無いためキャッシュをスキップし素の fetch（動作は同じ） |

キャッシュは最適化であり正しさの要件ではありません。`caches` が無いランタイムでは `fetchBytes` は素の
fetch にフォールバックし（`validate` は同様に適用）、`evictUrl` / `clearCache` は false、
`listCachedUrls` は `[]` を返します。

NOTE: 現行 Deno の Cache API は `Cache.keys()` を実装していないため、Deno では `listCachedUrls` だけは
throw します（実在するエントリを空一覧と偽らない fail loud。`fetchBytes` のキャッシュ・`evictUrl` /
`clearCache` は Deno でも動きます）。

## リリース / bump

バージョンの真実源は `deno.json` の `version` です。公開 `VERSION`（`src/mod.ts`）はその焼き込みコ
ピーで、`deno task bump` が両者を 1 コミットで同期します。drift は `scripts/version_sync.test.ts`
（`deno task check` に含む）と、リリース時の `scripts/verify_tag.ts` で fail-loud に検出します。

```sh
deno task bump patch   # 0.1.0 -> 0.1.1（deno.json + src/mod.ts を1コミット。tag/push はしない）
```

公開手順:

1. `deno task bump <patch|minor|major>` でバージョンを上げてコミット。
2. `git push` 後、`v<version>`（例 `v0.1.1`）タグで GitHub Release を作成。
3. Release の publish で [`release.yml`](.github/workflows/release.yml) が起動し、タグ ==
   `deno.json` の version を検証してから JSR に publish します（OIDC）。

## ライセンス

MIT（`LICENSE`）。
