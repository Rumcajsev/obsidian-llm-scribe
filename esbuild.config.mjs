import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { copyFileSync } from "fs";
import { resolve } from "path";

const prod = process.argv[2] === "production";
const VAULT_PLUGIN = resolve("../Obsidian Vault/.obsidian/plugins/kb-chat");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: `${VAULT_PLUGIN}/main.js`,
  plugins: [{
    name: "copy-static",
    setup(build) {
      build.onEnd(() => {
        copyFileSync("manifest.json", `${VAULT_PLUGIN}/manifest.json`);
        copyFileSync("styles.css", `${VAULT_PLUGIN}/styles.css`);
        copyFileSync(`${VAULT_PLUGIN}/main.js`, "main.js");
        copyFileSync("manifest.json", "manifest.json");
        copyFileSync("styles.css", "styles.css");
        console.log(`→ synced to ${VAULT_PLUGIN}`);
      });
    },
  }],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
