# 0009 — 呼び出し側バッファへの読み込み（`into`）

- 日付: 2026-09-02
- 状態: 採用
- 関連: [0004](0004-single-flight-raw-sharing.md)（single-flight の raw 共有）/
  [0005](0005-streaming-prefetch-and-verified-marker.md)（`expectedBytes` の導入）/
  [0007](0007-explicit-expected-bytes-fail-loud.md)（縮退先の無い失敗は fail loud）

## Context

下流（WebGPU 推論スタック）は数百 MiB の shard を数十本、**逐次**読んで GPU へ書き、書き終えた
バイト列はすぐ捨てる。`fetchBytes` は呼び出し毎に新しいバッファを作る — network 側は
`expectedBytes` の事前確保、キャッシュヒット側は `Response.arrayBuffer()` — ので、捨てた
バッファの回収は GC 任せになり、ピークは shard 数本ぶん積み上がる（下流の Deno 実測: ピーク ≈
1.05GB + 最大 shard × 3。同じ読み手をローカルファイル経路で「最大 shard 長のバッファ 1 本を
再利用」に変えた実測はピーク ≈ 0.45GB + 最大 shard × 1 で、確保とゼロ埋めと GC の往復が消えて
ロード時間も半分になった）。

これは取得層の外側では直せない。キャッシュのキー規則・記録ハッシュ・self-heal はこの層の
内側にあり、呼び出し側が `caches` を直接読めばキー規則の複製と完全性検査の素通りになる。
ストリームを返す口も無い。

## Decision

### 1. `into` — 呼び出し側が確保したバッファへ読む（`FetchBytesOptions` / `HfFileSpec`）

network 受信もキャッシュ読出しも `into` の先頭へ直接書き、戻り値はその prefix view
（`into.subarray(0, n)`）。`expectedBytes` の事前確保はこのバッファで置き換わり、呼び出し毎の
確保がゼロになる。キャッシュヒットは `arrayBuffer()` ではなく body stream を読んで書き込む
（`into` 指定時だけ — 無指定の経路はバイト単位で従来どおり）。

バッファの**所有権は呼び出し側**にある: 戻り値（と `validate` / `decode` に渡る保存形 raw）は
バッファを指す view で、次に同じバッファへ書くまでに使い終えるのが契約。`decode` 併用時は
バッファに保存形 raw が入り、戻り値は decode 結果（別バッファ）。`prefetchUrl` /
`prefetchHfFile` は無関係（バイト列を手元に持たない）。HF 層はファイル毎の器なので
`HfFileSpec` 側に置く（`expectedBytes` と同じ側）。

### 2. 容量不足は縮退させず fail loud

「実バイト数 > `into.byteLength`」は呼び出し側の申告ミスで、縮退先が無い（呼び出し側の器の
外に書く先は無く、蓄積経路へ落とせば契約〈戻り値 = 器の view〉が壊れる）。0007 と同じ判断で
遅らせずに落とす:

- network: 超過を検知したチャンクで受信を打ち切り（body を cancel）、キャッシュしない。
- キャッシュヒット: throw するが**エントリは消さない**（破損ではない）し、network へも
  **縮退しない**（cache I/O の失敗ではない）。ヒット経路の 2 つの catch はこの例外だけ
  素通しする。
- `expectedBytes > into.byteLength` は必ず容量不足になる申告なので、network に出る前に throw。

### 3. single-flight の合流者へ leader のバッファは渡さない

leader が `into` を使うと、共有する保存形 raw は leader の呼び出し側が所有するメモリを指す。
そのまま合流者へ渡すと、leader の呼び出し側が次の取得で同じバッファへ書いた瞬間に合流者の
手元が書き換わる（合流者の sha256 / validate は非同期で、書き換え前に終わる保証が無い）。
合流者が**いるときだけ**、leader は共有前に raw のコピーを切る（合流者ゼロならコピーしない —
逐次読みの主用途ではコピーは一度も起きない）。コピーは leader の呼び出し側へ制御が戻る前に
同期で終わるので、コピー元の上書きは起きない。合流者側が `into` を持つなら、共有 raw を自分の
バッファへ写して契約を守る（容量不足は 2. と同じ）。

### 4. sha256 は view のまま digest する

`into` の prefix view は buffer 全体を占めない。WebCrypto の `digest` は部分ビューをそのまま
受け付ける（ハッシュ対象は view の範囲）ので、旧「tight view でなければコピー」を
「SharedArrayBuffer 背面のときだけコピー」へ緩める。数 GB 級でコピー 1 回ぶんが効く。

## Consequences

- **非 breaking**（オプションの追加のみ）。`into` を渡さない呼び出しの挙動は不変。
- 戻り値の寿命が「次の書き込みまで」になるのは `into` 指定時だけの契約（docs/limitations.md）。
- ヒット経路が stream 読みになる分、Deno / ブラウザの Cache 実装が body を stream で返すか
  （全量を一度 materialize しないか）で RAM 効果の大きさが変わる。これは実装挙動で仕様保証では
  なく、効果の実測は下流（karume）の研究記録に置く。
- 合流者ぶんのコピーは「`into` を使う leader に合流者がいる」ときだけ発生する 1 回きりで、
  従来（合流者ゼロでもコピー無し・合流者ありでも共有）と比べて悪化するのはこの組み合わせだけ。
