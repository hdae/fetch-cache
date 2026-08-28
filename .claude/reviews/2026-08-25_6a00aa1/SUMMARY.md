# SUMMARY — cacheKey 差分レビュー（2026-08-25 @ 6a00aa1）

> **NOTE（2026-08-25 追記・裁定結果）**: 本レビューが対象とした `cacheKey: string` 実装
> （a4163d6..6a00aa1）は、オーナーとの設計議論の結果 **main から撤収**した
> （`reset --hard v0.4.0`。実装は `archive/cachekey-string-draft` ブランチに保全）。
> 0.5.0 は「配列 `key` + sha256 一級化 + cacheName 撤去」の breaking 再設計として作り直す。
> 本レビューの成果（特に IM-03 fragment 衝突・IM-01/AP-02 cacheName 導線・TS-002 検出力
> ギャップ）は再設計の入力として反映する。以下の要判断①〜③は再設計により**失効**。

このファイル単体で裁定可能なように書く（読者はコードベース未ロード前提）。

## 実施概要

- **モード**: A（フォーカス）。対象 = v0.4.0..HEAD の 3 コミット（a4163d6 feat cacheKey /
  4b9e0ed docs ADR 0006 + README + limitations / 6a00aa1 0.5.0 bump）。別セッションが実装した
  「キャッシュキーと取得元 URL の分離（`cacheKey`）」の ADR 整合・利便性・0.5.0 リリース可否の判定。
- **体制**: Find 4 レンズ（実装・並行性 / ADR・文書整合 / API 設計・利便性 / テスト品質）=
  opus medium ×3 + sonnet medium ×1 → 所見 26 件のうち W 以上 14 件を敵対検証
  （opus medium、閉じた評定 holds/refuted/uncertain、3 並列バッチ）。計 18 エージェント。
  ユースケース分析（HF/非 HF × 更新頻度の 6 パターン）はメインセッションで実施。
- **検証環境**: `deno task check` 緑（127 passed / 0 failed / 1 ignored）。TS-002 の検証では
  スクラッチ複製に対するミューテーションテストを実施（対象リポジトリは無変更）。
- **前回レビュー**: 2026-08-08_aef0d30。未消化項目（C-4 残余 / A-L1 / SHA pin ほか）は今回差分と
  独立 — ROADMAP に継続転記。
- **前提事実**: JSR 公開済み最新は **0.4.0**。v0.5.0 はローカルで bump 済み・**タグ未作成・未公開**。
  つまり `cacheKey` はまだリリースされておらず、入口ガードの強化・API 形の変更は今なら破壊ではない。

## 総評とリリース可否

- 🔴C / 🟠E は **0 件**。実装は ADR 0006 の宣言（cache 側 4 箇所 = `cacheKey ?? requestUrl`、
  fetch は常に取得元 URL、fail loud ガード 2 種、合流意味論、HF 層素通し）と**完全一致** —
  impl / docs / api の 3 レンズが独立に突合して同じ結論（IM-04, DC-7, AP-07）。single-flight の
  TOCTOU 不変条件（get→set 間 await なし）も維持（IM-05）。
- holds 9 件（W5 / L4）は全て**文書の縫い目**（cacheName 導線・前方ポインタ・旧表現の残存）か
  **テスト固定の欠落**で、コードの欠陥は 0。唯一の実装余地は fragment 付きキーの入口ガード
  （要判断②）で、未リリースの今なら無償で締められる。
- **判定: 要判断 3 件の裁定 + 修正パッケージ実施後、0.5.0 リリース可。** ADR 0006 を撤回すべき
  欠陥は見つからなかった（撤回可否の根拠は「ユースケース分析」節）。

## ユースケース分析（メインセッション。裁定①・文書追記の根拠）

cacheKey の価値軸は「HF かどうか」ではなく「URL と内容の対応の安定性」。

| | 内容不変・URL が動く | 内容不変・URL も不変 | 内容が更新される |
|---|---|---|---|
| HF | **A**: revision 追従（本命 = 下流 hub 層） | **C**: SHA ピン止め → 不要 | **B**: 更新ファイル → 不要（キーが毎回変わるだけ） |
| 非 HF | **D**: ミラー切替（合流・共有が効く）/ **E**: 署名付き URL（正規化キーで初めてキャッシュ可能） | versioned URL → 不要 | **F**: latest 系 → cacheKey では解けない（manifest 駆動なら hash キーで自然解決） |

- 全パターンで設計は破綻しない（不要パターンでは使わなければ完全不変）→ **撤回理由なし**。
- D / E は ADR・README に書かれていない正当ユースケース。特に E は「キーは内容ハッシュ由来で
  ある必要がない（同一キー = 内容同一の主張さえ守れば正規化 URL でよい）」ことを示す。
- footgun は「内容可変ファイル + 安定キー」（E の誤用）。`validate` があれば self-heal が救い、
  無ければ古い内容を恒久的に掴む → limitations 追記候補。
- HF 層非対称（ADR §5）が刺さるのはパターン A のみで、A の主体 = manifest を持つ下流 =
  `fetchBytes` 直呼びできる層。線引きは条件付きで妥当（裁定①参照）。

## 要判断（3 件）

### ① prefetchHfFile.cacheKey を維持するか撤去するか [W/設計・**締切あり**]

**概要**: ADR 0006 §5 は「HF 層は温め（`prefetchHfFile`）にだけ cacheKey の口を開け、読み出し
（`fetchHfFile` / `fetchHfFiles`）には開けない」と線を引いた。検証の結果（AP-01 uncertain/L）:
§5 の却下論拠「ファイル毎のキーを組める呼び出し側は resolve URL も自前で組める」は温め側にも
そのまま当てはまり（prefetchHfFile の cacheKey 経路は公開 API 3 行で等価実装可能）、論理として
は片方だけを却下する形になっている。一方、読み出し再実装の負担は 15〜25 行程度（当初申告の
30〜40 行は反証済み。3N ヒープ劣化の懸念 AP-03 も反証済み — fetchBytes が渡す bytes は常に
tight view なので素朴な `crypto.subtle.digest` で損しない）。**この選択肢は 0.5.0 出荷後は
撤回不可（released API になる）— 今が最後の裁定機会。**
**修正案**:
- a) ★ **維持 + 読み戻し導線の文書修正**（cacheName 明記 — 実施パッケージ 1 に含む）。
  根拠: ①害が無い（使わなければ完全不変・テスト済み）のに出荷直前に動く機能を消す作業リスクを
  取る価値が無い ②IM-01/AP-02 の罠は文書修正で塞がり、主利用者はオーナー自身の下流（導線文書が
  機能する関係）③温め側は streaming + sha256 逐次検証 + 印焼き + revision 解決 + sha256 形式
  ガード + path 付き進捗の合成点で、1 呼び出しに包む価値が読み出し側より実際に大きい ④将来
  読み出し側（HfFileSpec.cacheKey 等）に口を開ける場合も自然に整合する。
- b) 撤去（ADR §5 の論理を首尾一貫させる案）。利点: 下流は cache 層（`prefetchUrl` +
  `hfResolveUrl`）に統一され、**cacheName 既定が両層で揃い IM-01 の罠が構造的に消える**。
  欠点: 実装 + テスト + 文書済みの機能の削除作業・ADR §5 の書き直し。
- (d) sha256 hex ヘルパの export は今回**見送り推奨**（非破壊で後から追加可能・要望駆動で十分。
  ヒープ根拠は反証済みで純粋な utility 追加になるため）。
**リスク**: a) 残余リスクは「文書を読まず cacheName 不一致で prefetch が無駄になる」（無言・
ただ遅いだけ。恒久ミスにはならない — 読み出し側で正しく再格納される）。b) 差分の手戻り。
**対象**: src/hf/mod.ts:287-380（HfPrefetchOptions.cacheKey / prefetchHfFile）
**影響範囲**: a) 文書 5 箇所のみ。b) hf/mod.ts + hf/mod.test.ts + ADR 0006 §5 + README + limitations。
**裁定**: a で進める / b に切り替える

### ② fragment 付き cacheKey の扱い [W/実装ガード — IM-03]

**概要**: 入口ガード `isHttpUrl` は scheme しか見ないため `https://…#<sha256>` 形の cacheKey が
素通りするが、Cache API はキーの fragment を**黙って剥がして**格納・照合する（Deno 実測:
`put(…#alpha)` 後の `match(…#beta)` が true）。content-addressed キーの自然形の一つ
「実 URL + `#<hash>`」を採ると**全 revision が 1 エントリに潰れ、古い内容が新しいキーで無言
ヒットする**（この層は内容を検証しない・self-heal も効かない）。さらに single-flight の合流
キーは生文字列なので fragment を**保持**し、「cache では同一・合流では別」という ADR 0006 §2 が
明示的に避けたはずの非対称が発生する。ADR §3 の「格納できない指定は入口で弾く」宣言の抜け穴。
**修正案**:
- a) ★ **ガード強化 + キー正規化**: fragment 付きは fail loud に throw（§3 と同じ様式・同じ
  理由 =「指定どおりのキーにならない」）し、あわせて `cacheKey = new URL(cacheKey).href` へ
  正規化してから全 4 箇所 + 合流キーに使う（cache 内部の Request 正規化と合流キー空間が完全に
  一致し、大文字スキーム等の非対称も消える）。cacheKey は未リリースなので破壊ではない。
  実装 ~5 行 + テスト 1 本。
- b) 文書明記のみ（「fragment はキーに含まれない」を ADR §3 + limitations に追記）。
  ADR 自身が否定した「気付けない失敗」を残すため非推奨。
**リスク**: a) 正規化により格納キーが渡した文字列と字面レベルで変わり得る（例: ホスト小文字化）
が、Cache API 内部と同じ正規化なので観測面（match / evictUrl / listCachedUrls）は全て一貫する。
**対象**: src/mod.ts:159-167（isHttpUrl）、:475-487 / :629-635（ガード 2 箇所）
**影響範囲**: src/mod.ts + mod.test.ts + ADR 0006 §3 追記。
**裁定**: a で進める / b にとどめる

### ③ CacheErrorContext.key?: string の追加可否 [L/API 追加 — AP-04]

**概要**: onCacheError の通知は 4 箇所とも `url: requestUrl`（取得元）で、cacheKey 分離時に
「どのキーの cache 操作が失敗したか」は通知から直接分からない。ADR 0006 Consequences が明示的に
受容済みの宣言済み挙動であり欠陥ではない。任意フィールド `key?: string`（実効キー）の追加は
完全に非破壊で、入れるなら「キー空間を導入する当のリリース」の今が意味論的に一番きれい。
**修正案**: a) ★ **見送り**（YAGNI — 下流はキーを自分で生成しており url→key 対応を既に持つ。
要望が出たら後から非破壊で追加可能）/ b) 0.5.0 に同梱（実装 4 行 + 型 + doc）。
**対象**: src/mod.ts:28-33（CacheErrorContext）
**裁定**: a 見送り / b 同梱

## 裁定不要 — 承認後に一括実施する修正パッケージ

すべて文書・テストのみ（②a 採用時のみコード ~5 行が加わる）。

1. **cacheName 導線の明記**（IM-01 = AP-02、holds/W ×2 — 今回の最重要文書修正）:
   prefetchHfFile の既定 cacheName は "fetch-cache-hf"、fetchBytes の既定は "fetch-cache" で、
   文書の読み戻し手順「fetchBytes に同じ cacheKey を渡す」に**そのまま従うと必ず別名前空間を
   引き、温めた数 GB が無駄になる**（無言・二重格納・印も効かない）。読み戻し導線 5 箇所
   （src/hf/mod.ts:295-297 / :339-341、ADR 0006 §5、docs/limitations.md:30-33、
   README.md:331-336）に「cacheName（既定 "fetch-cache-hf"）も揃えること」を追記。
2. **再入禁止 MUST NOT のキー単位化**（IM-02、holds/W）: src/mod.ts:84-86・:297 と
   ADR 0004:40 の「同一 (cacheName, URL)」を「同一 (cacheName, キー = cacheKey ?? URL)」へ。
   同一 cacheKey・別 URL の再入は throw ではなく**無言ハング**なので誤読を残さない。
3. **ADR 前方ポインタ**（DC-1、holds/L）: 0002 / 0004 の該当記述直後に「0.5.0 で 0006 が部分的に
   上書き」の NOTE 1 行、0006 ヘッダの「関連」を「部分的に上書き: 0002 / 0004」+「関連: 0005」へ分離。
4. **limitations 旧表現**（DC-4、holds/L）: :12-13 の「キャッシュキーが URL のみの設計と同じ
   割り切り」→ ヘッダ非依存を根拠にした表現へ、:19 見出し「キャッシュキーは URL のみ」→
   「キーにヘッダは入らない（認証非対応）」へ。
5. **ADR 0006 に Alternatives 追記**（AP-05、holds/L）: fetch DI の URL 書き換えで 0.4.0 でも
   同等意味論が得られた事実と、採らなかった理由（診断の正直さ = HTTP エラー / onCacheError /
   進捗警告が取得元 URL を保つ・宣言性・fetch 層へ対応表を持ち込まない）を 3〜4 行。
6. **テスト 1 本**（TS-002、holds/W）: prefetchUrl の sha256 不一致「保険 delete」が cacheKey 側に
   向くことの固定。**ミューテーションテストで cacheKey→requestUrl 取り違えが現行 127 テストを
   全通過することを実証済み** — 検出力ギャップは実在。非準拠 Cache fake（stream error 握り潰し）+
   cacheKey + 不一致 sha256 で、印付き不正エントリがキー側にも取得元側にも残らないことを assert。
7. **ユースケース由来の文書追記**（メインセッション分析）: README / ADR に「キーは内容ハッシュ
   由来である必要はない」（署名付き URL の正規化キー = パターン E）とミラー合流（パターン D）を
   1〜2 行、limitations に「内容可変ファイルに安定キーを使う場合 validate 必須（無いと古い内容を
   恒久的に掴む）」を 1 文。
8. optional（採否は実施時に判断・低コスト）: evictUrl / listCachedUrls の JSDoc にキー空間 1 行
   （DC-3 残余）、「caches 不在でも合流だけはキー空間で効く」の limitations 1 行（IM-07）。

## 検証で取り下げた指摘（refuted 4 件）

| ID | 主張 | 反証理由 |
|---|---|---|
| DC-2 | cacheKey × 印で汚染が恒久化する記述漏れ | 機序不成立: prefetch の印 = 格納バイト列の真の sha256 が構造保証され、印一致 = 内容一致。誤 marker は cacheKey と独立の既文書化領域（0005 §4） |
| DC-3 | evictUrl の silent no-op が fail-loud の穴 | limitations:24 に evict のキー空間は記載済み。delete の false は「エントリ無し」の正確な報告で黙殺ではない |
| AP-03 | sha256Hex 非公開で下流再実装が 3N ヒープ化 | fetchBytes の bytes は常に tight view — 素朴な digest 直渡しで isTightView 真枝と同一経路。コピーは発生しない |
| TS-001 | fetchBytes の cacheKey×印の書込み直交テスト欠落 | キー選択と印付与は独立 2 引数で、各々既存テストが単独検出する。組合せでのみ壊れる失敗形が存在しない |

## 観察事項（L/S — 対応不要。詳細は findings/）

IM-04〜06（4 箇所一致 / TOCTOU 維持 / onCacheError 一貫の確認）、IM-07（caches 不在でも合流は
キー空間 — 上記 optional）、IM-08（合流者への伝播エラーは leader の URL — 合流契約の帰結）、
IM-09（URL 正規化と put/match の整合を実測確認）、DC-5（HfFetchOptions.init の「URL のみ」は
現状正しい）、DC-6（README の verifySha256 未定義は既存流儀）、AP-06（cacheKey が string のみ —
後から string|URL へ非破壊拡張可）、AP-07（ガード・キー空間・テストの ADR 一致）、TS-003
（onCacheError.url 契約の専用テスト無し — 低優先で ROADMAP へ）。

## 次回レビューの観点

- 修正パッケージ実施コミットの差分確認（特に②a 採用時の正規化がらみのテスト）。
- cacheKey 実運用開始後の下流フィードバック（キー命名規約・cacheName 運用・E パターンの利用有無）。

## モデル配分メモ

opus medium（finder 3 + verifier 14）で十分機能。sonnet medium の tests レンズが TS-002 という
有効打（唯一のテスト系 holds/W）。TS-002 verifier が自発したスクラッチ複製ミューテーション
テストは検出力主張の裏取りとして高価値 — 次回のテスト系検証でも指示に含める価値あり。
