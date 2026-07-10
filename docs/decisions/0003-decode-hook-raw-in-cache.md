# 0003 — decode フック（保存形 ≠ 利用形）: cache は raw・validate は raw 契約のまま

- 日付: 2026-07-10
- 状態: 採用

## Context

yomi（辞書ローダ）からのフィードバック。gzip（~6.4MB）を取得してキャッシュにも gzip の
まま保存したい（storage 節約）が、検証は解凍後に対して行うため、「validate 内で gunzip →
戻り値は gzip のままなので呼び出し側でもう一度 gunzip」と同じ解凍が 2 回走っていた。
原案は「`decode` を追加し、**validate は decode 後**のバイト列に走る」だった。

## Decision

`FetchBytesOptions.decode?: (raw: Uint8Array) => Uint8Array | Promise<Uint8Array>` を追加
する。ただし原案から 1 点変更し、**validate は従来どおり保存形 raw に対して走る**
（decode の前）。

- cache に入るのは常に保存形 raw。戻り値だけが decode 適用後（省略時は raw = 完全互換）。
- 経路は両側とも `validate(raw) → decode(raw)` の順で、一つの共有実装
  （`validateAndDecode`）に固定する。
- **decode の throw は破損扱い**で validate と同じ縮退経路に乗る: キャッシュヒット側は
  evict → network 再取得（self-heal）、network 側はそのまま throw（decode 不能物は
  キャッシュしない）。利用形側の検証（解凍後の magic / CRC 等）は decode 内で throw する。
- decode は raw を破壊的に変更してはならない（MUST NOT — decode 成功後にその raw を
  `cache.put` するため、変更すると壊れた内容がキャッシュされる）。
- HF 層は `HfFileSpec`（ファイル毎）に `validate` / `decode` を持つ。built-in
  （expectedBytes → sha256）→ カスタム validate の順に合成し、いずれも raw に照合する。
- gzip 用の `decodeGzip`（DecompressionStream・依存ゼロ）を同梱する。

## 却下した代替案

- **validate を decode 後に走らせる（原案）**: HF の `sha256` / `expectedBytes` は Hub の
  LFS メタデータ由来＝**保存形 raw の属性**なので、validate が decoded に走ると decode 併用
  時に必ず不一致になる。回避すると「built-in は raw・カスタムは decoded」という層をまたぐ
  二重契約が生まれる。raw 契約なら yomi の要件（解凍 1 回・検証一本化）も decode 内 throw で
  同等に満たせる。
- **`decode` をジェネリック `<T>` にして任意型を返す**: cache は raw 保存なので decode は
  毎呼び出し走り、`T` にしても性能利得が無い。型面の複雑化だけが残るため bytes → bytes に
  限定（パースは呼び出し側で戻り値に 1 回）。

## Consequences

- 「保存形のまま cache・利用形を返す」が 1 フックで完結し、解凍の二重実行が消える。
- validate の公開契約（README 記載）が無変更のまま、decode が直交に合成できる。
- decoded 形はキャッシュしないため decode は毎呼び出し実行される（CPU と storage の
  トレードオフは呼び出し側の選択 — docs/limitations.md）。
- 将来 single-flight を入れても、合流後に各呼び出しが自分の decode を適用する形で直交する。
