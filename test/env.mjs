// Resolves the Pi runtime packages used by the tests.
// Order: PI_NODE_MODULES env -> this repo's node_modules (CI: `npm ci`) -> the local Pi installation.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function findNodeModules() {
  if (process.env.PI_NODE_MODULES && existsSync(process.env.PI_NODE_MODULES))
    return process.env.PI_NODE_MODULES;
  const local = join(repo, "node_modules");
  if (existsSync(join(local, "jiti")) && existsSync(join(local, "@earendil-works/pi-coding-agent")))
    return local;
  const releases = join(homedir(), ".pi/agent/install/releases");
  if (existsSync(releases)) {
    const v = readdirSync(releases)
      .filter((x) => existsSync(join(releases, x, "node_modules/jiti")))
      .sort()
      .reverse()[0];
    if (v) return join(releases, v, "node_modules");
  }
  throw new Error("Pi runtime not found: run `npm install`, or set PI_NODE_MODULES.");
}

export const nodeModules = findNodeModules();

/** pi-ultracode source dir (devDependency, or the copy installed into Pi). */
export function findUltracode() {
  for (const p of [
    process.env.PI_ULTRACODE_DIR,
    join(repo, "node_modules/pi-ultracode"),
    join(homedir(), ".pi/agent/npm/node_modules/pi-ultracode"),
  ]) {
    if (p && existsSync(join(p, "src/workflow/parser.ts"))) return p;
  }
  return undefined;
}

export async function makeJiti(fromUrl) {
  const { createJiti } = await import(pathToFileURL(join(nodeModules, "jiti/lib/jiti.mjs")).href);
  return createJiti(fromUrl, {
    alias: {
      "@earendil-works/pi-coding-agent": join(nodeModules, "@earendil-works/pi-coding-agent"),
      "@earendil-works/pi-tui": join(nodeModules, "@earendil-works/pi-tui"),
      typebox: join(nodeModules, "typebox/build/index.mjs"),
    },
  });
}
