import { assertEquals } from "@std/assert";
import { createSha256 } from "./sha256.ts";

/** native の一括 digest（差分テストの真実源）。 */
const nativeHex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
};

/**
 * 決定的 PRNG（xorshift32）。分割位置とデータをランダムに散らしつつ、落ちたテストを
 * そのまま再現できるようにする（Math.random だと失敗ケースが再現しない）。
 */
const xorshift32 = (seed: number): () => number => {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
};

const pseudoRandomBytes = (
  size: number,
  seed: number,
): Uint8Array<ArrayBuffer> => {
  const random = xorshift32(seed);
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    bytes[index] = Math.floor(random() * 256);
  }
  return bytes;
};

// ブロック境界（64）とパディング境界（55/56 = 長さフィールドが同じブロックに収まる限界）を跨ぐ
// サイズを含める。100003 は 2 ブロック以上 + 端数の実寸ケース。
//
// NOTE: 長さフィールドの上位 32bit を使う領域（> 512MiB）はここに入れていない — 600MiB の
//       突合には ~600MB の RAM と数秒かかり、毎回のテストに載せる価値が無いため。実装時に
//       単発で native と突合して一致を確認済み（本命の用途が数 GB のモデルである以上、
//       この境界を変更したら同じ突合をやり直すこと）。
const SIZES = [0, 1, 55, 56, 63, 64, 65, 119, 127, 128, 1000, 100003];

Deno.test("createSha256: ランダムな分割で update しても native の一括 digest と一致する", async () => {
  for (const size of SIZES) {
    const bytes = pseudoRandomBytes(size, size + 1);
    const expected = await nativeHex(bytes);

    // 一括 update（分割なし）。
    const whole = createSha256();
    whole.update(bytes);
    assertEquals(whole.hex(), expected, `size=${size} 一括`);

    // ランダムな分割位置での逐次 update。
    for (let trial = 0; trial < 8; trial++) {
      const random = xorshift32(size * 1000 + trial + 1);
      const hasher = createSha256();
      let offset = 0;
      while (offset < size) {
        const take = 1 + Math.floor(random() * (size - offset));
        hasher.update(bytes.subarray(offset, offset + take));
        offset += take;
      }
      assertEquals(hasher.hex(), expected, `size=${size} trial=${trial}`);
    }
  }
});

Deno.test("createSha256: 1 バイトずつ・空チャンク混じりでも一括結果と一致する", async () => {
  const bytes = pseudoRandomBytes(200, 7);
  const expected = await nativeHex(bytes);
  const hasher = createSha256();
  for (const byte of bytes) {
    hasher.update(new Uint8Array(0)); // 空チャンクは状態を進めない。
    hasher.update(new Uint8Array([byte]));
  }
  assertEquals(hasher.hex(), expected);
});

Deno.test("createSha256: hex() は状態を消費せず、途中経過は prefix のダイジェストになる", async () => {
  const bytes = pseudoRandomBytes(300, 11);
  const hasher = createSha256();
  hasher.update(bytes.subarray(0, 100));
  const prefix = hasher.hex();
  assertEquals(prefix, await nativeHex(bytes.slice(0, 100)));
  assertEquals(hasher.hex(), prefix); // 何度呼んでも同じ。
  hasher.update(bytes.subarray(100));
  assertEquals(hasher.hex(), await nativeHex(bytes)); // hex() 後も継続できる。
});

Deno.test("createSha256: 既知のテストベクタと一致する（実装同士の共倒れ検出）", () => {
  const empty = createSha256();
  assertEquals(
    empty.hex(),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  const abc = createSha256();
  abc.update(new TextEncoder().encode("abc"));
  assertEquals(
    abc.hex(),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
