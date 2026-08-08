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
// NOTE: 長さフィールドの上位 32bit を使う領域（>= 512MiB）はここには入れず、末尾の golden
//       vector テストで凍結する（native と突合するには全量を手元に確保する必要があり、
//       この差分テストの形では 512MB の確保が要るため。golden なら update の使い回しで
//       ピーク RAM 64KiB に収まる）。
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

Deno.test("createSha256: update から戻った後にチャンクを書き換えても結果は変わらない（非保持契約）", async () => {
  // `prefetchUrl` の通過中検証は update の直後に同じ領域を先へ流す（そこから先は複製・
  // transfer で書き換わりうる）。update が参照を握っていたらハッシュが壊れるので、
  // 「戻った時点で保持しない」を凍結する。64 の倍数でない長さ = 端数が保留バッファへ載る
  // 経路（参照を持ち越すなら最も起こりやすいのがここ）。
  const bytes = pseudoRandomBytes(100, 23);
  const expected = await nativeHex(bytes.slice());
  const hasher = createSha256();
  hasher.update(bytes);
  bytes.fill(0xaa);
  assertEquals(hasher.hex(), expected);
});

// 総入力長のビット長 encode は 512MiB 以上でのみ上位 32bit が非ゼロになる（sha256.ts の
// `view.setUint32(tail.length - 8, ...)`）。本命の用途（数 GB のモデル）は必ずこの領域を踏むが、
// 上の差分テストは最大 100003 バイトなので「上位語を 0 に落とす」変異を素通しさせてしまう。
// **ここが上位語の唯一の凍結点。** +1 バイトは端数ブロックのパディングも同時に踏ませるため。
//
// golden は純 TS 実装からは導かない（自身から導くとタウトロジーになる）。再導出手順:
// 64KiB のパターン（byte[index] = index % 251）を 8192 回 + 先頭 1 バイト、計 512MiB+1 バイトを
// 1 本の配列へ連結し、`crypto.subtle.digest("SHA-256", whole)` へ一括で通してここへ焼き直す
// （全量確保に ~512MB 必要なので単発スクリプトで実行する。node:crypto の逐次 update でも
// 同値を確認済み）。テスト側は同じパターンを update で使い回すのでピーク RAM は 64KiB、
// 実行時間は ~2.4 秒。
Deno.test("createSha256: 512MiB+1 バイト（長さフィールド上位 32bit が非ゼロ）が golden と一致する", () => {
  const PATTERN_BYTES = 64 * 1024;
  const pattern = new Uint8Array(PATTERN_BYTES);
  for (let index = 0; index < PATTERN_BYTES; index++) {
    pattern[index] = index % 251;
  }
  const hasher = createSha256();
  for (let count = 0; count < 8192; count++) hasher.update(pattern); // 8192 * 64KiB = 512MiB
  hasher.update(pattern.subarray(0, 1));
  assertEquals(
    hasher.hex(),
    "4e00324d395fbace943f10e147aae8e6ef95924a9e3559e9002f9ba7a9db36b7",
  );
});
