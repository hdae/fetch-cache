import { assertEquals } from "@std/assert";
import { checkReleaseTag } from "./release_tag.ts";

Deno.test("checkReleaseTag: v<version> 完全一致は ok で bare version を返す", () => {
  assertEquals(checkReleaseTag("v0.2.0", "0.2.0"), {
    ok: true,
    version: "0.2.0",
  });
});

Deno.test("checkReleaseTag: prerelease タグも完全一致で受理し bare version を返す", () => {
  // bump は premajor|preminor|prepatch|prerelease を第一級サポートする（bump.ts）。
  assertEquals(checkReleaseTag("v0.2.0-rc.1", "0.2.0-rc.1"), {
    ok: true,
    version: "0.2.0-rc.1",
  });
});

Deno.test("checkReleaseTag: v プレフィックス欠落は fail", () => {
  const result = checkReleaseTag("0.2.0", "0.2.0");
  assertEquals(result.ok, false);
});

Deno.test("checkReleaseTag: 境界（v 単独・空文字・前後空白）はすべて fail", () => {
  assertEquals(checkReleaseTag("v", "0.2.0").ok, false); // bare が空。
  assertEquals(checkReleaseTag("", "0.2.0").ok, false); // v 欠落分岐。
  assertEquals(checkReleaseTag("v0.2.0 ", "0.2.0").ok, false); // 空白は等価でない。
  assertEquals(checkReleaseTag(" v0.2.0", "0.2.0").ok, false); // 先頭空白は v 欠落扱い。
});

Deno.test("checkReleaseTag: 大文字 V は通さない（慣習に厳格）", () => {
  const result = checkReleaseTag("V0.2.0", "0.2.0");
  assertEquals(result.ok, false);
});

Deno.test("checkReleaseTag: version 不一致は fail", () => {
  const result = checkReleaseTag("v0.1.0", "0.2.0");
  assertEquals(result.ok, false);
});
