import esbuild from "esbuild";
import process from "process";

const isProduction = process.argv[2] === "production";

const context = await esbuild.context({
    entryPoints: ["main.js"],
    bundle: true,
    platform: "node",
    target: "es2020",
    outfile: "main.js",
    external: ["obsidian"],
    minify: isProduction,
    sourcemap: !isProduction,
    allowOverwrite: true,
});

if (isProduction) {
    await context.rebuild();
    process.exit(0);
} else {
    await context.watch();
}