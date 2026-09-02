# Limitations — 意図的な制約（by-design）

バグではなく設計判断による制約。変更する場合は該当 ADR（docs/decisions/）を差し替えること。

## cache 層

- **single-flight は cache 有効の GET のみ**（0.3.0 で導入 — DECIDED: docs/decisions/0004）。
  `cache: false` の並行呼び出しは合流せずそれぞれ network に出る（「毎回取りに行く」意図と
  非 GET の非冪等性を尊重。put は last-writer-wins で内容同一のため整合性は壊れない）。
  合流キーはストレージキー（URL / HF 内容キー）のみで、**合流者の `fetch` / `caches` /
  `init` / `onCacheError` / `expectedBytes` は使われない**（取得は先行呼び出しのオプションで
  走る。認証ヘッダ違いを区別しないのはキャッシュキーがヘッダ非依存の設計と同じ割り切り）。
  記録ハッシュを焼くのも leader の `sha256` だけ（合流者は記録を見ず、常に自分の
  `sha256` / `validate` / `decode` を保存形 raw に適用する安全側）。取得失敗は合流全員へ
  伝播する。**self-heal が走るのはキャッシュヒット経路（leader）だけ** — 合流者側の検証
  失敗はその呼び出しの throw に留まり evict しない（合流者が evict すると leader が今格納
  した正常エントリを消し得るため。検証条件の違う並行呼び出しを混ぜる運用では注意）。
- **非 GET はキャッシュ非対応**: Cache API は GET しか格納できない。cache 有効 + 非 GET は
  fail-loud に throw する（`cache: false` で素の fetch は可）。POST 応答のキャッシュは
  スコープ外（DECIDED: docs/decisions/0002）。
- **キャッシュキーはヘッダ非依存（認証非対応）**: キーは URL（HF 層は内容キー）のみで、
  `init` のヘッダはキーに影響しない。認証付きで取得した bytes は、以後認証なしの呼び出しでも
  ヒットする（ローカル単一ユーザーのキャッシュとしては妥当。DECIDED: docs/decisions/0002）。
  呼び出し側がキーを指定する公開オプションは無い（0.5.0 で撤去 — DECIDED:
  docs/decisions/0008）。
- **`loaded` と `content-length` の突合はしない**: Fetch 仕様上 Content-Length は信頼できず
  （Content-Encoding 越しでは解凍後サイズと不一致が正常）、突合は誤検知バグになる。真の
  切断は stream エラーで throw 済み。整合性検証は `validate`（HF 層の sha256 /
  expectedBytes）に委譲する。
- **`expectedBytes` / content-length は確保ヒントであって検証ではない**（DECIDED:
  docs/decisions/0005）。受信バッファを事前確保して RAM ピークを 1N に抑えるためだけに使い、
  申告と実受信がずれても取得は落とさない（超過なら蓄積経路へ、不足なら実長へ詰め直す）。
  長さの検証がしたいなら `validate`（HF 層の `expectedBytes`）で行う。
- **確保そのものが落ちたときだけは申告の出どころで扱いが割れる**（DECIDED:
  docs/decisions/0007）。呼び出し側が `expectedBytes` を**明示**していてそのサイズを確保
  できなければ、受信を始める前に body を cancel して throw する（蓄積経路も終端で同じ長さの
  連結バッファを要求するため、縮退しても全量 DL 後に同じ理由で落ちるだけ＝帯域を捨てる）。
  content-length 由来の確保失敗は従来どおり「ヒント無し」へ縮退する（サーバ申告は信頼せず、
  実受信が上限に収まるなら取得は成立するため）。形式不正の申告（非整数・0 以下）も従来どおり
  確保を試みる前に「ヒント無し」へ落ちる。
- **`into` の戻り値は次に同じバッファへ書くまでしか有効でない**（DECIDED:
  docs/decisions/0009）。バッファは呼び出し側の所有で、戻り値も `validate` / `decode` に渡る
  保存形 raw もそのバッファを指す view（`decode` 併用時はバッファに保存形・戻り値は decode
  結果）。容量不足は縮退しない（network は打ち切ってキャッシュしない・キャッシュヒットは
  throw するがエントリは消さず network へも縮退しない・`expectedBytes` が容量を超える申告は
  network に出る前に throw）。single-flight の合流者は leader のバッファを共有せず、leader は
  合流者がいるときだけ共有前に 1 回コピーする（合流者の `into` へは写す）。prefetch は `into`
  を見ない。`fetchHfFiles` の複数 spec に同じバッファを渡すと戻り値同士が上書きし合う
  （逐次の `fetchHfFile` で使う）。
- **`prefetchUrl` の検証は `sha256` 指定時のみ・縮退はしない**（DECIDED:
  docs/decisions/0005 §5）。body をそのまま cache へ流すためバイト列を手元に持てず、
  `validate` フックは走らせられない。唯一の例外が `sha256`（64 桁小文字 hex）で、指定時は
  通過中に逐次ハッシュして突合し、一致したものだけがエントリとして成立する（同時に記録
  ハッシュが焼かれる）。**未指定なら未検証バイトが一時的にキャッシュへ載る**（読み出し時の
  self-heal で evict されるので恒久化しない）。`caches` 不在・open 失敗・HTTP エラー・転送
  中断・put 失敗（quota 等）・sha256 不一致はすべて throw する（手元にバイトが無く「続行」に
  意味が無いため。ADR 0001 の縮退契約は `fetchBytes` 専用）。
- **prefetch が見る検証指定は `sha256` だけ**（DECIDED: docs/decisions/0005 §5）。
  `prefetchHfFile` に `spec.expectedBytes` / `spec.validate` を渡しても prefetch では
  使われない（バイト列を手元に持たないため。どちらも `fetchHfFile` で読み出すときには
  通常どおり効く）。
- **prefetch の既存エントリ検査は記録ハッシュ突合のみ（実バイトは検証しない）**（DECIDED:
  docs/decisions/0005 §5・0008）。`sha256` 指定時、既存エントリは記録ハッシュとの文字列
  比較で判定する — 一致なら network に出ない（`prefetchUrl` は false、`prefetchHfFile` は
  `fetched: false`）、記録なし / 不一致なら検証付きで温め直して置換する（温め直しが失敗した
  場合は既存エントリが残る）。**記録が一致しても実バイトそのものは照合しない**（温める API
  であって検査する API ではない）。既存の内容を疑うなら `fetchBytes` の `recheck` を使う。
- **`prefetchUrl` は single-flight の対象外**（DECIDED: docs/decisions/0005）。合流契約
  （ADR 0004）は leader の保存形 raw を共有することが本体で、streaming の leader は raw を
  持たない。同一 URL の並行 prefetch はそれぞれ network に出る（内容同一の
  last-writer-wins で整合性は壊れない）。
- **記録ハッシュの信頼は「ローカル単一ユーザーの格納を信頼する」既定**（DECIDED:
  docs/decisions/0006 §2。0.4.0 の「ヒット毎全量検証」から**既定が反転**した breaking）。
  記録は「このバイト列は保存時にこの sha256 と一致した」ことだけを主張し、格納後の改竄・
  ビット腐敗は検出できない（大半の格納後故障は miss として現れる。誤ったバイトの成功ヒットは
  ビット腐敗級のまれな事象のみ）。疑う運用は `recheck: true` で毎ヒット再ハッシュへ opt-out
  する。記録が省くのは sha256 の再計算だけで、カスタム `validate` と `decode` は記録一致の
  ヒットでも常に走る。
- **`sha256` 指定 × 記録なしエントリのヒットは書き込みを伴う（backfill）**（DECIDED:
  docs/decisions/0008 §2）。ヒット経路が同一バイト列 + 記録ヘッダで 1 回だけ再 put する
  （Cache API はヘッダのみの更新ができないため N バイトの再書き込み）。この put は並行する
  `evict` / `clearCache` / `prefetchUrl` と相互排他ではなく last-writer-wins — ハッシュ計算中
  に走った削除が巻き戻って見えることがある（失われるのは削除・温め直しの「新しさ」のみで、
  記録と内容の整合は常に保たれる）。
- **decode 後（利用形）はキャッシュしない**: cache に入るのは常に保存形 raw で、`decode` は
  毎呼び出し実行される（storage 節約と引き換えの CPU コスト。トレードオフの選択は
  呼び出し側 — DECIDED: docs/decisions/0003）。また `validate` は decode 併用時も保存形
  raw に対して走る（利用形側の検証は decode 内で throw する）。

## HF 層

- **`sha256` の無いファイルは `evict` / `listKeys` の射程外**（DECIDED:
  docs/decisions/0006 §4・0008）。内容キーになるのは `sha256` 宣言ファイルだけで、無宣言
  ファイルは SHA 固定 resolve URL がキー（URL キー空間）。repo 単位の掃除は
  `evict(["hf", kind, repo])`（宣言分）+ `listCachedUrls` を resolve URL 前方一致で絞って
  `evictUrl`（無宣言分）の 2 段になる。`HfFetchOptions.recheck` も宣言ファイル限定で、
  無宣言ファイルには効かない（黙って素通し — 疑うなら
  `evictUrl(hfResolveUrl({ ...ref, revision, path }))` で落として取り直す）。
- **`fetchHfFiles` の部分キャッシュ**: 1 ファイルの失敗で全体が reject するが、成功済み
  ファイルのキャッシュ書込みは取り消されない（リトライは即ヒット。テストで凍結済み）。
- **prefetch の複数ファイル版は無い**（DECIDED: docs/decisions/0005 §5）。`prefetchHfFile`
  のみを提供する。数 GB 級の並列 prefetch は帯域の奪い合いにしかならないため、並行度の選択は
  呼び出し側に残す（`resolveHfRevision` で 1 回解決 → `revision` に SHA を渡して必要な順に
  呼ぶ）。
- **revision 解決は HF の実装挙動依存**: `/api/{kind}/{repo}/revision/{ref}` が
  `{"sha": …}` を返すのは仕様保証ではない（応答に sha が無ければ throw）。

## ランタイム

- **Deno 2.8 以前では `listCachedUrls` / `listKeys` / `evict` が throw**: `Cache.keys()`
  未実装のため、実在エントリを空一覧と偽らず fail-loud に throw する。Deno 2.9+ は
  `keys()` 実装済みで全 API が動く（`fetchBytes` のキャッシュ・`evictUrl` / `clearCache` は
  全バージョンで動く）。
- **自動テストは Deno のみ**: ブラウザ実環境での CI は無い（ランタイム対応表のブラウザ挙動は
  Web 標準仕様に依拠）。
