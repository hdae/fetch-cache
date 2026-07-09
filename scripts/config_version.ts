// deno.json から top-level version を読む dev/CI ヘルパ。
//
// NOTE: このファイルは配布パッケージ外（deno.json publish.include に scripts/ は無い）＝
//        src/ の実行時内容に影響しない。deno.json は素の JSON（コメント無し）なので JSON.parse で
//        読む。JSONC 化したら @std/jsonc の parse に差し替えること。
export const readVersion = async (
  configPath = "./deno.json",
): Promise<string> => {
  const parsed = JSON.parse(await Deno.readTextFile(configPath)) as {
    version?: unknown;
  };
  const version = parsed.version;
  if (typeof version !== "string" || version === "") {
    throw new Error(
      `${configPath} に string の version フィールドがありません`,
    );
  }
  return version;
};
