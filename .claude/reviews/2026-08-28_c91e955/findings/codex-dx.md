[severity: error] README.md:40 — `evict(["hf", kind, repo])` では repo 全体を削除できない  
機序: `sha256` 付きファイルだけが配列内容キーになり、`sha256` のない `config.json` などは SHA 固定 URL キーになる（`src/hf/mod.ts:199`）。`evict` は配列キーしか対象にせず、README.md:284/346 の「prefix で旧エントリ／repo 全体を削除」という説明と食い違う。 / 利用者への実害: ③で削除件数が返っても URL キーと過去 revision の config が残り、「全部消してディスクを空けた」と誤認する。大きな未ハッシュファイルなら容量も残る。 / 修正案: 「sha256 付き HF エントリだけを削除」と説明を限定し、`listCachedUrls` と `evictUrl` を使う URL キー側の削除手順を併記する。repo 全削除を契約にするなら両キー空間を扱う公開導線が必要。

[severity: error] README.md:97 — `recheck` の self-heal は並行呼び出しでは保証されない  
機序: 通常の取得が先に single-flight の leader になると、後から来た `{ recheck: true }` は joiner になり、共有された raw を再ハッシュするだけである。失敗しても `src/core.ts:743` の joiner 経路は evict・再取得せず throw する。この例外は `docs/limitations.md:15` にはあるが、README の「never need to evict」「self-heals」という無条件の説明と矛盾する。 / 利用者への実害: ④で通常読出しと診断が重なると、診断側は破損を検出して落ちる一方、通常側は記録ハッシュを信じて破損バイトを受け取り、破損エントリも残る。数 GB の読出しほど合流時間が長く踏みやすい。 / 修正案: `recheck` 呼び出しを既存 flight に合流させない、または joiner の検証失敗後に evict・leader として再試行する。現仕様を維持するなら README の保証を leader に限定し、並行取得停止後の evict・再試行手順を明記する。

[severity: warning] deno.json:20 — README が参照する設計・制約文書が publish 対象外  
機序: `publish.include` は README/LICENSE/deno.json/src のみで、README が繰り返しリンクする `docs/limitations.md` と ADR 0005〜0008を含まない。 / 利用者への実害: JSR パッケージ内容だけを参照する利用者は、single-flight の例外、prefetch の制約、breaking migration の根拠へ到達できない。とくに上記 `recheck` の限定は README 本文から分からない。 / 修正案: `docs/**/*.md` を publish 対象へ追加するか、README のリンクを公開リポジトリ上の絶対 URL にする。

[severity: warning] README.md:324 — streaming prefetch 後の「読出し」は全量 materialize のまま  
機序: prefetch が省メモリなのは Cache Storage へ書く段階だけで、`fetchHfFile` は必ず単一 `Uint8Array`、`fetchHfFiles` は `Promise.all` で全ファイルを同時に返す（`src/hf/mod.ts:360`）。 / 利用者への実害: ①で各 shard が ArrayBuffer 上限を超える場合は読出し不能であり、上限未満でも複数 GB を一括読出しすると OOM になり得る。README.md:194 に Chromium 上限の記述はあるが、HF の推奨例との関係が示されていない。実害は shard サイズとランタイム依存で、確信度は中。 / 修正案: HF 例の直下で「prefetch は読出し時の全量 materialize を解消しない」と明記し、可能な利用系では `fetchHfFile` を逐次処理する例を示す。単一 shard が上限を超える構成は 0.5.0 の公開読出し API では扱えないと明示する。

[severity: warning] src/hf/mod.ts:103 — 末尾 `/` 付き `hubUrl` が二重スラッシュ URL になる  
機序: `hubUrl` を正規化せず `${hubUrl}/...` と連結し、revision API 側も同様である（`src/hf/mod.ts:124`）。 / 利用者への実害: ミラー URL を自然な `https://mirror.example/` 形式で渡すと `https://mirror.example//api/...` および `//owner/repo/...` になり、正規化しないプロキシでは 404、sha256 なしでは別 URL キーとして重複保存になる。サーバが正規化する場合は発現しない。 / 修正案: `hubUrl` の末尾 `/` を正規化してから両 URL を構築するか、少なくとも JSDoc に「末尾 `/` 不可」を明記する。

[severity: low] src/core.ts:779 — 撤去済みの公開 `key` オプションが JSDoc に残っている  
機序: `PrefetchUrlOptions.sha256` の説明は「`fetchBytes` に同じ `key` を渡す」と案内するが、0.5.0 の `FetchBytesOptions` と `PrefetchUrlOptions` に `key` は存在せず、公開ファサードにも keyed 関数はない。 / 利用者への実害: 汎用 CDN 用コードで `{ key, sha256 }` を試して型エラーになり、URL と HF 内容キーのどちらが共有条件なのか迷う。 / 修正案: 汎用 API は「同じ URL と sha256」、HF 層は「ライブラリが生成する同じ内容キー」と書き分ける。

[severity: low] README.md:77 — 完全性・HF のサンプルがそのままでは動かない  
機序: `"1a2b…"`／`"…"` は 64 桁小文字 hex の入口検査で必ず reject され、README.md:318 の `MODEL_FILES` も未定義である。 / 利用者への実害: サンプルをコピーした初回利用者は network 前の sha256 エラーまたは型検査エラーになり、導入失敗と誤読する。 / 修正案: 実在する小さな fixture URL と正しい digest を使う runnable example にするか、コードブロックを明示的に擬似コードと表示して `MODEL_FILES` の完全な定義を置く。

問題なし確認リスト

- ①の基本導線は `resolveHfRevision` で一度だけ固定 SHA を得て、各 spec を逐次 `prefetchHfFile`、同じ spec を `fetchHfFile`／`fetchHfFiles` へ渡せば同じ内容キーにヒットする。
- ②は `fetchHfFile({ repo, revision: "main" }, "config.json")` で毎回現在 SHA を解決し、revision 固定 URL ごとに保存されるため、branch 更新後に古い config が同じキーへ固着しない。
- ④は競合がない場合、sha256 付きファイルの `recheck: true` が実バイトを再ハッシュし、不一致なら evict・再取得する。明示的な再取得も、内容キーなら `evict`、URL キーなら解決済み `hfResolveUrl` に対する `evictUrl` の後で取得すれば構成できる。
- ⑤の versioned CDN URL は `prefetchUrl(url, { sha256 })` と `fetchBytes(url, { sha256 })` でキーと記録ハッシュが一致する。
- `src/mod.ts` は内部 keyed 関数を再公開せず、`deno.json` も `.` と `./hf` だけを exports に載せており、撤去した公開 key の迂回導線はない。
- HF prefetch が `expectedBytes`／`validate` を使わないこと、sha256 なし prefetch と read の間で revision を固定する必要、0.4.0 からの記録ハッシュ信頼既定の反転は JSDoc／limitations／migration に明記されている。

総評

現状の 0.5.0 は publish 見送りを推奨する。  
repo 全削除と `recheck` self-heal の README 上の保証が、公開 API の実挙動を上回っている。  
キー設計、revision 固定、sha256 付き prefetch/read の基本導線自体は一貫している。  
error 2 件の契約修正と、publish 文書・大容量制約の明確化後ならリリース可能と判断する。