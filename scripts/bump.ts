// `deno task bump <patch|minor|major>`: deno.json の version を組込み `deno bump-version` で
// surgical に更新（整形を保全）し、焼き込み src/mod.ts の VERSION も同じ版へ surgical 更新して、
// その2ファイルの変更を1コミットにする。deno.json（真実源）と VERSION を常に一致させる（drift 防止）。
// tag / push はしない（オーナーが実施。タグは v<version>）。
import { readVersion } from "./config_version.ts";

const INCREMENTS = [
  "major",
  "minor",
  "patch",
  "premajor",
  "preminor",
  "prepatch",
  "prerelease",
];

const run = async (cmd: string, args: string[]) => {
  const { code, stdout, stderr } = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
};

if (import.meta.main) {
  const increment = Deno.args[0];
  if (increment === undefined || !INCREMENTS.includes(increment)) {
    console.error(`usage: deno task bump <${INCREMENTS.join("|")}>`);
    Deno.exit(2);
  }

  // clean-tree ガード: deno.json / src/mod.ts に未コミット変更があると bump 以外が混ざる。fail loud。
  const status = await run("git", [
    "status",
    "--porcelain",
    "--",
    "deno.json",
    "src/mod.ts",
  ]);
  if (status.code !== 0) {
    console.error(status.stderr);
    Deno.exit(status.code);
  }
  if (status.stdout.trim() !== "") {
    console.error(
      "deno.json / src/mod.ts に未コミットの変更があります。clean な状態で bump してください。",
    );
    Deno.exit(1);
  }

  const before = await readVersion();
  // 組込み deno bump-version（-c で単一ファイルモード強制＝root deno.json のみ触る）。
  const bumped = await run("deno", [
    "bump-version",
    "-c",
    "./deno.json",
    increment,
  ]);
  if (bumped.code !== 0) {
    console.error(bumped.stderr);
    Deno.exit(bumped.code);
  }

  // bump-version 実行後（= deno.json 書換え後）の失敗分岐では、書換え済みファイルを原状復帰
  // してから exit する。半 bump の working tree を残すと、素朴な `git add . && commit` で
  // 版ズレが commit される罠になる（clean-tree ガード済みなので checkout は bump 差分のみ捨てる）。
  const restoreAndExit = async (
    message: string,
    code: number,
  ): Promise<never> => {
    await run("git", ["checkout", "--", "deno.json", "src/mod.ts"]);
    console.error(`${message}（deno.json / src/mod.ts は原状復帰済み）`);
    Deno.exit(code);
  };

  const after = await readVersion();
  if (after === before) {
    await restoreAndExit(`バージョンが変化しませんでした（${before}）。`, 1);
  }

  // 焼き込み src/mod.ts を同じ版へ surgical 更新（他行は保全）。deno.json と常に一致させる。
  const modPath = "src/mod.ts";
  const modTs = await Deno.readTextFile(modPath);
  const updatedTs = modTs.replace(
    /export const VERSION = "[^"]*";/,
    `export const VERSION = "${after}";`,
  );
  if (updatedTs === modTs) {
    await restoreAndExit(
      `${modPath} の VERSION 行が見つからないか変化しませんでした。`,
      1,
    );
  }
  try {
    await Deno.writeTextFile(modPath, updatedTs);
  } catch (error) {
    console.error(error);
    await restoreAndExit(`${modPath} の書き込みに失敗しました。`, 1);
  }

  // version バンプ（deno.json + src/mod.ts）のみを1コミットに（他の staged 変更は含めない）。
  const committed = await run("git", [
    "commit",
    "deno.json",
    "src/mod.ts",
    "-m",
    `chore(release): バージョンを ${after} に更新`,
  ]);
  if (committed.code !== 0) {
    console.error(committed.stderr);
    await restoreAndExit("git commit に失敗しました。", committed.code);
  }
  console.error(
    `${before} -> ${after} を commit しました（tag/push は未実施）。`,
  );
  console.log(after); // stdout は新 version（bare）。
}
