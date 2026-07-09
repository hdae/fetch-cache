import { assertEquals } from "@std/assert";
import { checkReleaseTag } from "./release_tag.ts";

Deno.test("checkReleaseTag: v<version> 完全一致は ok で bare version を返す", () => {
  assertEquals(checkReleaseTag("v0.2.0", "0.2.0"), {
    ok: true,
    version: "0.2.0",
  });
});

Deno.test("checkReleaseTag: v プレフィックス欠落は fail", () => {
  const result = checkReleaseTag("0.2.0", "0.2.0");
  assertEquals(result.ok, false);
});

Deno.test("checkReleaseTag: 大文字 V は通さない（慣習に厳格）", () => {
  const result = checkReleaseTag("V0.2.0", "0.2.0");
  assertEquals(result.ok, false);
});

Deno.test("checkReleaseTag: version 不一致は fail", () => {
  const result = checkReleaseTag("v0.1.0", "0.2.0");
  assertEquals(result.ok, false);
});
