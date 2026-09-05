# 0011 — HF 層の `expectedBytes` は受信の上限でもある（超過時点で打ち切る）

- 日付: 2026-09-05
- 状態: 採用
- 関連: [0005](0005-streaming-prefetch-and-verified-marker.md)（`expectedBytes` の導入 =
  確保ヒント）/ [0007](0007-explicit-expected-bytes-fail-loud.md)（確保失敗だけの例外）/
  [0009](0009-into-caller-buffer.md)（`into` の容量不足は fail loud）

## Context

`expectedBytes` は 2 つの層で名前が同じまま意味が違う。

| 層                         | 意味                     | 外れたときの挙動                             |
| -------------------------- | ------------------------ | -------------------------------------------- |
| 汎用層 `FetchBytesOptions` | 受信バッファの確保ヒント | 黙って吸収（超過は蓄積経路・不足は詰め直し） |
| HF 層 `HfFileSpec`         | バイト数の**検証**       | 不一致は throw（`buildValidate` 経由）       |

汎用層の「ヒントであって検証ではない」は意図的な契約で、Content-Encoding 越しの
content-length のように**正しくズレる**申告があるため変えられない（ADR 0005・
docs/limitations.md）。

一方 HF 層は宣言があれば全量受信後に長さの厳密一致を検証しており、**受信が宣言を超えた
時点で、その取得が失敗することは確定している**。にもかかわらず最後まで受け取ってから落として
いた。数 GB のモデルで path 取り違えや upstream の差し替えに当たると、確定した失敗のために
帯域を丸ごと使い切ることになる — ADR 0007 が「確保失敗を全量 DL 後に落とすのは帯域を捨てる
だけ」と判断したのと同じ構図である。

## Decision

### 1. 汎用層の契約は変えない

`FetchBytesOptions.expectedBytes` は確保ヒントのまま。公開オプションに上限は増やさない。

### 2. 内部導管にだけ `maxBytes` を足し、HF 層が宣言を渡す

`fetchBytesWithKey` / `prefetchUrlWithKey`（`exports` に載らない内部 API）へ
`maxBytes?: number` を追加し、HF 層が `HfFileSpec.expectedBytes` をそこへ渡す。上限を渡して
よいのは「超過が失敗であることを自分で検証している層」だけであり、その条件をモジュール境界で
表現する（呼び出し側が上限だけを渡して長さ検証を持たない、という状態を作れない）。

- **`fetchHfFile` 経路**: `readBody` がチャンクを書く前に `loaded + value.length > maxBytes`
  を判定し、超えていれば `reader.cancel()` して throw する。判定は `into` の容量検査より
  **先**（HF 層は `toSpec` で `expectedBytes <= into.length` を保証しているので、超過は器
  不足ではなく申告違反として報告されるべき）。キャッシュはしない。
- **`prefetchHfFile` 経路**: 通過中の TransformStream で数え、超過で stream を error にして
  `cache.put` ごと reject させる。表面化の優先順位は既存の sha256 不一致と同じで、汎用の
  「キャッシュ書込みに失敗」へ化けさせない。エントリは成立させない（stream の error を無視
  する Cache 実装向けの保険 delete まで既存と同じ）。
- **キャッシュヒット側は変えない**。エントリが宣言より大きい場合は従来どおり読み出してから
  検証で落ち、self-heal に乗る（既に手元にあるバイトを打ち切っても得られるものが無い）。

### 3. `prefetchHfFile` が spec から見る項目が 1 つ増える

従来は `sha256` だけだった（ADR 0005 §5）。`expectedBytes` が**上限としてだけ**加わる —
不足（宣言 > 実受信）は prefetch では検出しない。バイト列を手元に持たないという前提は
変わっておらず、`validate` / `into` は引き続き無視される。

## Consequences

- **失敗の内容は変わらず、時刻だけが早くなる**。宣言を超える応答は従来も必ず失敗していた
  （`fetchHfFile` は長さ不一致、`prefetchHfFile` は読み出し時の self-heal）。変わるのは
  「どこまで受け取ってから落ちるか」だけ。
- 文言は変わる: 超過は `fetch-cache: 受信が申告 {maxBytes} バイトを超えた（{n} バイト以上）
  ({url})`。全量後の `バイト数不一致: {実長} != {宣言}` は**不足のときだけ**出るようになる。
- 同じ名前 `expectedBytes` の意味が層で違うという既存の非対称は残る（むしろ HF 層側が
  「検証 + 確保ヒント + 上限」と厚くなる）。名前を分けるのは公開 API の破壊的変更になるため
  採らず、README / limitations に層ごとの表を残すことで賄う。
- 超過の判定はチャンク境界で行うため、報告する受信量は下限（「N バイト以上」）になる。
  正確な総量は最後まで受け取らないと分からず、それは打ち切る目的と矛盾する。
