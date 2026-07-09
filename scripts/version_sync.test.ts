// version 焼き込みの drift 検出（dev/CI）: 公開エントリ `.`（src/mod.ts）が export する VERSION が
// deno.json の version と一致するか。deno task bump が deno.json と mod.ts を同時更新するが、
// 手動編集による drift をここで fail-loud にする（公開 VERSION が実バージョンとズレるのを防ぐ）。
import { VERSION } from "../src/mod.ts";
import { readVersion } from "./config_version.ts";

Deno.test("version 焼き込み: 公開 VERSION == deno.json.version", async () => {
  const declared = await readVersion("./deno.json");
  if (VERSION !== declared) {
    throw new Error(
      `公開 VERSION(${VERSION}) が deno.json の version(${declared}) と不一致。` +
        `deno.json を単一の真実源に保ち、deno task bump で同期すること。`,
    );
  }
});
