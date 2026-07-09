// CI: git タグ（v プレフィックス）が deno.json の version と一致するかを fail-loud 検証し、
// 成功時は bare version を stdout に1行だけ出力する（診断は stderr）。
//
// 呼び出し例: deno run --no-lock --allow-read scripts/verify_tag.ts "$TAG"
//   --no-lock は必須: jsr import が deno.lock を working tree に書き、直後の
//   deno publish（release）を dirty で落とすのを防ぐ二重防御。
import { checkReleaseTag } from "./release_tag.ts";
import { readVersion } from "./config_version.ts";
import { VERSION } from "../src/mod.ts"; // 公開エントリ `.` の焼き込み VERSION。

if (import.meta.main) {
  const tag = Deno.args[0];
  if (tag === undefined || tag === "") {
    console.error("usage: verify_tag.ts <tag>");
    Deno.exit(2);
  }
  const version = await readVersion();
  // 公開 VERSION が deno.json と drift していないか（version_sync.test.ts は dev/CI 側の同一ガード）。
  // release 時点でも fail-loud 検証する。
  if (VERSION !== version) {
    console.error(
      `::error::公開 VERSION(${VERSION}) が deno.json の version(${version}) と不一致（deno task bump で同期）`,
    );
    Deno.exit(1);
  }
  const result = checkReleaseTag(tag, version);
  if (!result.ok) {
    console.error(`::error::${result.error}`); // GitHub Actions アノテーション。
    Deno.exit(1);
  }
  console.log(result.version); // stdout は bare version のみ。
}
