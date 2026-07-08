// Packaging step 2 (after `vite build`): bundle the main process — it imports
// workspace TypeScript through pnpm symlinks, which don't survive packaging —
// and embed the daemon connection (dist-config.json) from the repo-root .env.
// The token never enters git; it exists only inside the built artifact
// (private-beta stance: repo/releases are private; dynamic login replaces this
// before any public release).
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}dist-electron`;
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [`${root}electron/main.mjs`],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["electron"],
  outfile: `${out}/main.mjs`,
  banner: {
    // esbuild's ESM output still emits require() for some CJS deps
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
copyFileSync(`${root}electron/preload.cjs`, `${out}/preload.cjs`);

// daemon connection from repo-root .env → dist-config.json (gitignored dir)
const env = Object.fromEntries(
  readFileSync(`${root}../../.env`, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const url = env.AGENA_RELEASE_URL;
const token = env.AGENA_MODAL_TOKEN;
if (!url || !token) {
  throw new Error(
    "AGENA_RELEASE_URL and AGENA_MODAL_TOKEN must be set in the repo-root .env to bake a release build (see README: Desktop → Packaging)",
  );
}
writeFileSync(`${out}/dist-config.json`, JSON.stringify({ url, token }));
console.log(`bundled main → dist-electron/ (daemon: ${url})`);
