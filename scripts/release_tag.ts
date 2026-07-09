// リリースタグ（v プレフィックス付き）の検証ロジック（純関数・依存ゼロ）。
// タグ規約: git タグ / GitHub Release は `v<version>`（例 v0.2.0）。deno publish は
//           deno.json の version（bare）だけを見るため、タグ prefix は JSR 公開と独立。

export type TagCheck =
  | { ok: true; version: string }
  | { ok: false; error: string };

/**
 * タグが `v<configVersion>` と厳格一致するかを判定する。
 * - 先頭が小文字 `v` でなければ fail（慣習に厳格。bare タグや大文字 `V` を通さない）。
 * - `v` を除いた部分が deno.json の version と完全一致しなければ fail。
 * 成功時は bare version（アセット名や JSR 公開版に無変換で使える）を返す。
 */
export const checkReleaseTag = (
  tag: string,
  configVersion: string,
): TagCheck => {
  if (!tag.startsWith("v")) {
    return {
      ok: false,
      error:
        `タグ '${tag}' は v プレフィックスが必須です（例 v${configVersion}）`,
    };
  }
  const bare = tag.slice(1);
  if (bare !== configVersion) {
    return {
      ok: false,
      error:
        `タグ '${tag}'（=${bare}）が deno.json の version '${configVersion}' と一致しません`,
    };
  }
  return { ok: true, version: bare };
};
