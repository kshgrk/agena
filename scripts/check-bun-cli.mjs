import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const maxBytes = 80 * 1024 * 1024;
const dir = mkdtempSync(join(tmpdir(), "agena-bun-gate-"));
const outfile = join(dir, "agena");

try {
  run("bun", [
    "build",
    "--compile",
    "apps/cli/src/main.ts",
    "--outfile",
    outfile,
  ]);
  const size = statSync(outfile).size;
  if (size > maxBytes) {
    throw new Error(`compiled CLI is ${size} bytes, above ${maxBytes}`);
  }
  const help = run(outfile, ["--help"]);
  if (!help.stdout.includes("usage: agena")) {
    throw new Error("compiled CLI did not print usage for --help");
  }
  console.log(`bun gate ok: ${Math.round(size / 1024 / 1024)} MiB`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (${res.status})\n${res.stdout}${res.stderr}`,
    );
  }
  return res;
}
