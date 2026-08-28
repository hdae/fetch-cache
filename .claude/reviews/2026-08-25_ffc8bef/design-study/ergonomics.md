## 評定

**Design R: 条件付き推奨 / 確信度 中**

条件は 2 つ。① Mode B に「強制再取得して格納」経路（`reload` 相当）を定義すること ② Mode A の管理 API（`listCached` のメタデータ + repo 単位掃除の代替手順）を設計に含めること。この 2 つが無いと、下のケース 6・7 が現行 API より明確に書きにくくなる。

さらに本レッグの中心的な所見: **ケース 1・2・3・5 では R と現行の呼び出し側コードが 1 文字も変わらない**。差が出るのは管理系（6・7）と、現行にある病理経路（後述）だけ。つまり「二戦略分離」は主戦場の呼び出しエルゴノミクスをほとんど改善しない — 改善の実体は「既定キーを内容キーに倒す」＋「公開 `key` を消す」＋「revalidate を実装する」であり、これは Design C でも同じである。**R と C はエルゴノミクスの観点では区別がつかない**（区別が要るなら別観点で決めるべき）。

---

## ケース別の書き比べ

### 1. HF モデルファイル（sha256 既知）

```ts
// 現行 0.5.0 / Design R — 完全に同一
const bytes = await fetchHfFile(
  { repo: "org/model" },
  { path: "model.safetensors", sha256: SHA, expectedBytes: 1_234_567_890 },
);
```

現行は内部で `["hf","model",repo,path,sha256]`（hf/mod.ts:208-212）、R は裸の sha256 に格納する。呼び出し側に差は無い。滲む違和感は「`sha256` がキーに効くのか完全性に効くのかが型から読めない」こと — 現行では `key` と `sha256` が直交オプションとして並んでおり、JSDoc（mod.ts:71-77）で初めて「両方に効く」と分かる。R はそれが型で決まる。

### 2. HF（sha256 無し、revision "main"）

```ts
// 現行 / R — これも同一
const cfg = await fetchHfFile({ repo: "org/model" }, "config.json");
```

どちらも SHA 固定 resolve URL がキー。R は「Mode B1（不変 URL なので revalidate 不要）」と説明が付くだけで挙動も記述も同じ。

### 3. 汎用の不変アセット（versioned URL + sha256 既知）

```ts
// 現行
const wasm = await fetchBytes("https://cdn.example.com/pkg/1.4.2/app.wasm", { sha256: SHA });
// Design R — 同一の呼び出し、キーだけ URL → sha256 に変わる
const wasm = await fetchBytes("https://cdn.example.com/pkg/1.4.2/app.wasm", { sha256: SHA });
```

R の利得は「1.4.3 で中身が同一なら再 DL ゼロ」。実利得だが CDN の versioned URL では稀。**R の代償はここに出る**: 呼び出し側は URL を渡したのに、そのエントリは URL では消せなくなる（`evictUrl` は URL キーのエントリしか消さない — mod.ts:926-935）。現行は `evictUrl(同じ URL)` が素直に効く。

### 4. 可変 URL の manifest.json（鮮度が欲しい）

```ts
// 現行 0.5.0 — 鮮度機構が無い。毎回全量取り直すしかない
await evictUrl(MANIFEST_URL);
const manifest = JSON.parse(new TextDecoder().decode(await fetchBytes(MANIFEST_URL)));
// （evictUrl を省くと最初の内容に永久固着する）

// Design R（Mode B）
const manifest = JSON.parse(
  new TextDecoder().decode(await fetchBytes(MANIFEST_URL, { revalidate: true })),
);
```

R が圧倒的に素直。ただし前述のとおりこれは**二戦略分離の成果ではなく revalidate 実装の成果**で、C でも同じ 1 行になる。実装側の注意（HTTP 接地）: 現行 `storableResponse`（mod.ts:368-378）は元レスポンスのヘッダを一切引き継がず `new Response(body)` を作るので、ETag/Last-Modified は**今は保存されていない**。R では明示的に写し取る必要がある（ADR 0006 §2 も前提として書いている）。さらに RFC 9111 §4.3.4 は 304 受領時に格納ヘッダの更新を要求するが、Cache API には部分更新が無く `Cache.put` はエントリ全置換なので、ヘッダ更新には N バイトの再 put が要る。manifest 級なら無害、GB 級エントリに `revalidate` を許すなら「ヘッダ更新は諦める」と明記すべき（＝ Mode B に GB 級を載せない設計判断を文書化する必要がある）。

### 5. 起動前の streaming prefetch → 読み出し

```ts
// 現行（sha256 あり）
const revision = await resolveHfRevision(ref);
for (const f of FILES) await prefetchHfFile({ ...ref, revision }, f, { onProgress });
const parts = await fetchHfFiles({ ...ref, revision }, FILES); // ヒット・再ハッシュ無し

// Design R — 同一（キーが sha256 になるので revision の受け渡しは実は不要になる）
const revision = await resolveHfRevision(ref);
for (const f of FILES) await prefetchHfFile({ ...ref, revision }, f, { onProgress });
const parts = await fetchHfFiles(ref, FILES);
```

現行でも `sha256` があれば内容キーなので `revision` の引き回しは不要（ヒットする）。**が、`sha256` の無いファイルが 1 つでも混ざると必要になる** — その 1 ファイルだけ resolve URL キーなので、prefetch と fetch の間に revision が動くと GB を捨てる。現行はこの「混在時にだけ引き回しが要る」条件分岐を呼び出し側が頭で保持する必要がある。R では同じ危険が Mode B ファイルに残るが、`ref` と Mode の対応が型で見えるぶん判断しやすい。

**R がここで明確に勝つ病理**が 1 つある。現行では `prefetchUrl` を `sha256` **無し**で温めてから `fetchBytes` に `sha256` を渡すと、記録ハッシュが無いエントリになり、ADR 0006 の Consequences（144 行目）と mod.ts:520-524 のとおり「一致しても記録は書き足さない」ため**毎ヒット全量再ハッシュが永続する**。数 GB では致命的で、しかもコードは動くので気づけない。R ではキー = ハッシュなのでこの組み合わせが構造的に表現できない（オーナー要求③に対して R の方が強い）。

### 6. 強制再取得（キャッシュ無視・結果は格納）

```ts
// 現行 — cache:false は「格納もしない」バイパス（mod.ts:488-490, 557）なので使えない。
// しかも HF の既定キー式を呼び出し側で再現する羽目になる:
await evict(["hf", "model", repo, path, SHA]);
const bytes = await fetchHfFile({ repo }, { path, sha256: SHA });

// Design R（Mode A）— そもそも「強制再取得」が不要になる
const bytes = await fetchHfFile({ repo }, { path, sha256: SHA }, { recheck: true });
// 壊れていれば不一致 → self-heal で取り直し。壊れていなければ再 DL する理由が無い。
```

現行の違和感の正体は明確で、**内部の既定キー生成式（hf/mod.ts:208-212）が管理 API 側に公開されていない**こと。「消す」ために呼び出し側が `["hf", kind, repo, path, sha256]` を手で組み立てるのは、キー直列化をライブラリが所有するという ADR 0006 §1 の主旨と矛盾している。R の Mode A はこれを綺麗に解消する。

**逆に R が書けなくなるのは Mode B の強制再取得**。`sha256` の無い manifest を「今すぐ確実に取り直して格納」したい場合、R の語彙には `revalidate`（304 を受け入れる＝取り直さないかもしれない）しか無い。`evictUrl` → `fetchBytes` の 2 段は現行と同じで残る。これが条件①。

### 7. 「このモデルのキャッシュを消す」

```ts
// 現行 — 要求そのものが 1 行になる。現行 API 最大の勝ち筋
await evict(["hf", "model", "org/model"]);

// Design R — マニフェストを持っている場合（オーナーの実運用はこれ）
for (const f of MODEL_FILES) await evictSha256(f.sha256);
for (const f of NO_SHA_FILES) await evictUrl(hfResolveUrl({ repo, revision, path: f.path }));

// マニフェストを持っていない場合（過去バージョンの掃除）— メタデータ走査に落ちる
for (const e of await listCached()) {
  if (e.mode === "sha256" && e.sourceUrl?.includes("/org/model/")) await evictSha256(e.key);
}
```

R の構造的な弱点。ⓐ repo 単位というスコープ概念が Mode A に存在しない ⓑ 同一 repo のファイルが sha256 有無で 2 つのキー空間に分かれるため、あらゆる管理操作が 2 ループになる ⓒ `sourceUrl` フィルタは正しくない: Mode A の売りである cross-repo dedup により 1 エントリが複数 repo の実体を兼ねうるので、「最後に取得した URL」で消すと他 repo がまだ必要とするエントリを消す（あるいは取り逃す）。正確にやるには参照カウントが要るが、ブリーフ自身が認めるとおり Cache API に 2 エントリ跨ぎのトランザクションは無いので、**refcount は安全に実装できない**。CAS の掃除は本質的に GC（LRU / last-used）であって「名前による削除」ではない — これは将来の lifecycle ADR と正面からぶつかる論点なので、R を採るなら「repo 単位掃除は提供しない、掃除は sha リスト指定 + GC」と明言する覚悟が要る（条件②）。

なお現行の `evict(prefix)` にも同型の危険はある: 内容キーは `hubUrl` を含まないので、ミラー跨ぎで共有されたエントリを片方の repo 名で消せてしまう。ただし影響は「消えすぎて再 DL」だけで、R の cross-repo dedup ほど広くはない。

---

## オーナー要求への適合

| 要求 | 現行 0.5.0 | Design R | 判定 |
| --- | --- | --- | --- |
| ①既知 SHA256 での変更チェック | 内容キーで達成。ただし呼び出し側が `key` を安定キーに上書きするとピンポン／stale 固着（ADR 0006 §5 の脚砲。文書化で防ぐしかない） | 表現不能 = 構造的に達成。revision を行き来しても両内容が共存 | **R 優位** |
| ②DL 破損検知 | materialize は native digest（mod.ts:423-430）、streaming は純 TS 逐次で put ごと潰す（mod.ts:872-901） | 同一機構を継承 | **引き分け** |
| ③一致時の再 DL・再ハッシュ回避 | 記録ハッシュの文字列比較で達成。ただし「記録なしエントリは毎ヒット再ハッシュ」の永続病理あり（ケース 5） | キー存在自体が証明。病理が表現不能。`x-fetch-cache-sha256` ヘッダも不要になる | **R 優位** |

3 要求すべてで R は現行以上（②は同等）。**要求適合の観点では R に反対する理由は無い。**

---

## 総合: どちらが素直か

**主戦場（ケース 1・2・3・5）では引き分け — コードが同一だから。管理系（6・7）では現行 API の `evict(prefix)` が素直で、R は掃除の語彙を作り直す必要がある。病理の作りにくさでは R。**

総合評は「R 寄りの引き分け」。R の価値はコードが短くなることではなく、**間違った書き方が型で表現できなくなること**にある（`key` + `sha256` の組み合わせ爆発が消える、記録なしエントリが消える）。これはエルゴノミクスではなく安全性の利得で、しかも Design C でも大半が得られる。

したがって本観点からの推奨は: R の**意味論**（sha256 有無で戦略が変わることを型に出す、公開 `key` を撤去する）を採り、リブートの規模はケース 6・7 の管理 API を設計してから決める。管理 API の解が「listCached + evictSha256 + GC」に収束するなら R、「プレフィックス操作を残したい」なら C の方が既存基盤を活かせる。

（推測と明記: 「マニフェストを持たない過去モデルの掃除」がオーナーの実運用でどれくらい起きるかは本レッグでは検証していない。yomi / sbv2-web がモデル一覧をコードに持っているなら R のケース 7 の弱点はほぼ実害無しで、その場合は R を無条件推奨に格上げできる。ここが評定を「条件付き」に留めている最大の未知数。）