// インクリメンタル SHA-256（FIPS 180-4）の純 TS 実装（内部モジュール — 公開 API ではない）。
//
// なぜ自前実装か: WebCrypto の `crypto.subtle.digest` は一括専用で、バイト列を手元へ
// materialize しない経路（streaming prefetch）では使えない。**実行時依存ゼロ MUST** の下で
// 「通過中のハッシュ」を得るには純 TS の逐次実装を持つしかない。
//
// 使いどころは `prefetchUrl` の通過中検証だけ。materialize 済みバイト列（`fetchBytes` の既定
// 経路・HF 層の validate）は従来どおり native の一括 digest を使う — そちらの方が約 4 倍速く
// （開発機実測: 純 TS 212 MB/s / native 810 MB/s）、置き換える理由が無い。prefetch 側は
// 回線律速（下流実測 10〜84 MB/s）なので、純 TS の速度で十分に足りる
// （DECIDED: docs/decisions/0005）。

/** FIPS 180-4 の丸め定数（最初の 64 素数の立方根の小数部 先頭 32bit）。 */
// deno-fmt-ignore — 4 語 x 16 行の表として読む（1 行 1 語に展開されると照合できない）。
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 初期ハッシュ値 H(0)（最初の 8 素数の平方根の小数部 先頭 32bit）。 */
// deno-fmt-ignore — 上と同じく表として読む。
const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const BLOCK_BYTES = 64;

const rotr = (word: number, bits: number): number =>
  (word >>> bits) | (word << (32 - bits));

/**
 * 64 バイトブロック 1 個を圧縮して state を更新する。`schedule` は使い回しのスクラッチ
 * （ブロック毎の確保を避ける）。中間値は int32 として扱い、加算結果は `>>> 0` で mod 2^32 へ
 * 畳む（加数は高々 5 個 = 2^35 未満なので double で厳密に表現できる）。
 *
 * スクラッチは `update` と `hex()` で共有してよい: schedule[0..15] は毎回ブロックから全上書き
 * され、16..63 はそこから導かれるので、前のブロックの内容が持ち越されることはない。
 */
const compress = (
  state: Uint32Array,
  schedule: Uint32Array,
  block: Uint8Array,
  offset: number,
): void => {
  for (let index = 0; index < 16; index++) {
    const at = offset + index * 4;
    schedule[index] = (block[at] << 24) | (block[at + 1] << 16) |
      (block[at + 2] << 8) | block[at + 3];
  }
  for (let index = 16; index < 64; index++) {
    const previous = schedule[index - 15];
    const recent = schedule[index - 2];
    const sigma0 = rotr(previous, 7) ^ rotr(previous, 18) ^ (previous >>> 3);
    const sigma1 = rotr(recent, 17) ^ rotr(recent, 19) ^ (recent >>> 10);
    schedule[index] =
      (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) >>> 0;
  }

  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];
  for (let index = 0; index < 64; index++) {
    const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const choose = (e & f) ^ (~e & g);
    const temp1 = (h + sum1 + choose + K[index] + schedule[index]) >>> 0;
    const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (sum0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }

  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
  state[4] = (state[4] + e) >>> 0;
  state[5] = (state[5] + f) >>> 0;
  state[6] = (state[6] + g) >>> 0;
  state[7] = (state[7] + h) >>> 0;
};

/** 逐次ハッシュのハンドル。`hex()` は状態を消費しないので、途中経過としても呼べる。 */
export type Sha256Hasher = {
  /**
   * チャンクを取り込む（分割位置は結果に影響しない）。
   *
   * MUST: 呼び出しから戻った時点でチャンクへの参照を保持しない（端数は内部バッファへ複製
   * 済み）。呼び出し側は戻った後にそのバッファを再利用・transfer してよい — `prefetchUrl`
   * の通過中検証は update の直後に同じ領域を先へ流すため、この性質が load-bearing。
   */
  update: (chunk: Uint8Array) => void;
  /**
   * ここまでに取り込んだバイト列のダイジェストを小文字 hex で返す。パディングは複製した
   * 状態に対して行うため、呼んだ後も `update` を続けられる（何度呼んでも同じ値）。
   */
  hex: () => string;
};

/** インクリメンタル SHA-256 を開始する。 */
export const createSha256 = (): Sha256Hasher => {
  const state = INITIAL_STATE.slice();
  const schedule = new Uint32Array(64);
  // 64 バイトに満たない端数の保留バッファ（`pending` バイトぶんが有効）。
  const partial = new Uint8Array(BLOCK_BYTES);
  let pending = 0;
  let totalBytes = 0;

  const update = (chunk: Uint8Array): void => {
    totalBytes += chunk.length;
    let offset = 0;
    if (pending > 0) {
      const take = Math.min(BLOCK_BYTES - pending, chunk.length);
      partial.set(chunk.subarray(0, take), pending);
      pending += take;
      offset = take;
      if (pending < BLOCK_BYTES) return;
      compress(state, schedule, partial, 0);
      pending = 0;
    }
    while (offset + BLOCK_BYTES <= chunk.length) {
      compress(state, schedule, chunk, offset);
      offset += BLOCK_BYTES;
    }
    if (offset < chunk.length) {
      partial.set(chunk.subarray(offset), 0);
      pending = chunk.length - offset;
    }
  };

  const hex = (): string => {
    // 0x80 + 0 埋め + 8 バイトのビット長。端数が 56 バイト以上なら 2 ブロックに跨る。
    const tail = new Uint8Array(pending < BLOCK_BYTES - 8 ? 64 : 128);
    tail.set(partial.subarray(0, pending));
    tail[pending] = 0x80;
    // ビット長は 2^32 を超えうるので上位/下位に分けて書く（下位は ToUint32 が mod 2^32 を
    // 取るのでそのまま、上位は bytes * 8 / 2^32 = bytes / 2^29）。
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(totalBytes / 0x20000000));
    view.setUint32(tail.length - 4, (totalBytes * 8) >>> 0);

    // 状態は複製して畳む（`hex()` を呼んでも取り込みを続けられる）。
    const finalState = state.slice();
    for (let offset = 0; offset < tail.length; offset += BLOCK_BYTES) {
      compress(finalState, schedule, tail, offset);
    }
    let digest = "";
    for (const word of finalState) digest += word.toString(16).padStart(8, "0");
    return digest;
  };

  return { update, hex };
};
