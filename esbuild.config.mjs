import esbuild from "esbuild";

const production = process.argv[2] === "production";

await esbuild.build({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2018",
  platform: "browser",
  sourcemap: production ? false : "inline",
  minify: production,
  outfile: "main.js",
  logLevel: "info"
});
