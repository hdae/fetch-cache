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
  伝播する — leader の `into` 容量不足もここに含まれ、器が十分な（あるいは `into` を渡して
  いない）合流者まで落ちる（合流者側の容量不足だけがその呼び出しに留まる）。
  **self-heal が走るのはキャッシュヒット経路（leader）だけ** — 合流者側の検証
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
  長さの検証がしたいなら `validate`（HF 層の `expectedBytes`）で行う。**例外は HF 層だけ** —
  `HfFileSpec.expectedBytes` は検証を持つ層の宣言なので受信の上限としても働き、超過した時点で
  打ち切って throw する（DECIDED: docs/decisions/0011。汎用層 `FetchBytesOptions` の契約は
  ヒントのまま不変で、上限を渡す口は内部導管にしか無い）。
- **再試行するのはステータスで見える rate limit / 一時的な不能だけ**（DECIDED:
  docs/decisions/0010）。既定の対象は 429 / 503 で、接続エラー・受信途中の切断・その他の
  4xx / 5xx は 1 回目でそのまま throw する（成功に転じる根拠が無いため）。**`maxDelayMs` を
  渡さない限り `Retry-After` の指示どおり待つ** — 上限を勝手に決めないのは、長い待機ほど
  「その時間待たなければ通らない」ことを意味し、短く切れば再試行を消費するだけになるため。
  恒久的に 503 を返すサーバに対しては既定で最大 31 秒（1+2+4+8+16）待ってから落ちる。急ぐ
  呼び出しは `maxRetries` / `maxDelayMs` を絞るか `retry: false` を渡す。合流者（single-flight）
  の `retry` / `onRetry` は使われない（取得は leader のオプションで走る — 上の single-flight 項）。
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
  結果）。prefetch は `into` を見ない。
- **`into` は逐次にしか渡し回せない**（DECIDED: docs/decisions/0009 §5）。同じバッファを
  **並行**する呼び出しへ渡すと入口で throw する（`fetchBytes` 直呼び・非 await の並行
  `fetchHfFile`・`fetchHfFiles` の同一器・合流者の写し先まで cache 層の入口 1 箇所で弾く。
  判定はバッファ同一性で、互いに素な部分ビューでも並行なら弾かれる）。`fetchHfFiles` は全
  spec を並列取得するので、spec 毎に別のバッファを渡すか逐次の `fetchHfFile` を使う。
  型（`Uint8Array<ArrayBuffer>`）を素通りした SharedArrayBuffer 背面も同じ入口で弾く。
  ガードが守っているのは記録の信頼モデル（docs/decisions/0005 §5 / 0006 §2）で、並行受信が
  同じ領域へ交互に書くと、sha256 検証（digest は呼び出し時点のコピーを取る）と `cache.put`
  （器をその時点の中身で読む）の間に他方の書き込みが入り、**記録ハッシュは正しいのに中身が
  違うエントリ**が成立しうる — 既定（`recheck: false`）は記録の文字列比較で信じるので
  self-heal では回復せず、`evictUrl` / `evict` / `clearCache` まで壊れたバイトが返り続ける。
- **`into` の容量不足は縮退しない fail loud**（DECIDED: docs/decisions/0009 §2）。network は
  超過チャンクで受信を打ち切ってキャッシュしない。キャッシュヒットは throw するがエントリは
  消さず network へも縮退しない。`expectedBytes` が容量を超える申告は request の前に throw
  する（HF 層は `toSpec` で revision 解決より前）。判別は `error.name === "IntoCapacityError"`
  （クラスは非公開）。**throw した後のバッファの内容は未定義**（失敗前に読めたぶんが先頭から
  書き込まれている）ので、「失敗したなら前回の内容が残っている」前提のリカバリは書けない。
  **エントリ側がバッファより大きい場合も同じ例外**になり、破損ではないので self-heal しない
  （何度呼んでも同じ throw。回復は `evictUrl` / `evict` か、`into` 無しで 1 回読む）。
- **`into` で消えるのは呼び出し毎の受信・戻り値バッファの確保だけ**（DECIDED:
  docs/decisions/0009）。次の 4 つは残る: ①合流者がいるフライトでは共有前に保存形 raw を
  1 回全長コピーするのでそのフライトだけピークが 2N になり、この確保が落ちるとダウンロード・
  検証・`cache.put` が全て成功した後でも throw する（再試行はキャッシュヒット）②
  `response.body` が null のランタイムは一度全量を materialize してから器へ写す ③キャッシュ
  ヒット側の RAM 効果は Cache 実装が body を stream で返すか（全量を materialize しないか）に
  依存する — 実装挙動であって仕様保証ではない ④`sha256` 併用時は WebCrypto の `digest` が
  仕様上バイト列のコピーを取る。
- **single-flight の合流者は leader のバッファを共有しない**（DECIDED: docs/decisions/0009
  §3）。leader は合流者がいるときだけ共有前に 1 回コピーし、合流者の `into` へはそのコピーを
  写す。leader の容量不足は取得失敗として**フライト全員へ伝播する**（上の single-flight 項）。
- **`prefetchUrl` の検証は `sha256` 指定時のみ・縮退はしない**（DECIDED:
  docs/decisions/0005 §5）。body をそのまま cache へ流すためバイト列を手元に持てず、
  `validate` フックは走らせられない。唯一の例外が `sha256`（64 桁小文字 hex）で、指定時は
  通過中に逐次ハッシュして突合し、一致したものだけがエントリとして成立する（同時に記録
  ハッシュが焼かれる）。**未指定なら未検証バイトが一時的にキャッシュへ載る**（読み出し時の
  self-heal で evict されるので恒久化しない）。`caches` 不在・open 失敗・HTTP エラー・転送
  中断・put 失敗（quota 等）・sha256 不一致はすべて throw する（手元にバイトが無く「続行」に
  意味が無いため。ADR 0001 の縮退契約は `fetchBytes` 専用）。
- **prefetch が見る spec は `sha256` と `expectedBytes` だけ**（DECIDED: docs/decisions/0005
  §5・0011）。`expectedBytes` は**上限としてだけ**効く — 超過した時点で stream を error に
  して put ごと潰す（エントリは成立しない）が、**不足は検出しない**（長さの厳密一致は
  `fetchHfFile` で読み出すときの担当）。`spec.validate` / `spec.into` は prefetch では
  使われない（バイト列を手元に持たないため。どちらも読み出し時には通常どおり効く）。
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
