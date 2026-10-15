// Validates every bundled workflow with pi-ultracode's own parser + instrumenter.
// Run: node test/validate-workflows.mjs   (requires pi-ultracode installed via `pi install npm:pi-ultracode`)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const uc = process.env.PI_ULTRACODE_DIR || join(homedir(), ".pi/agent/npm/node_modules/pi-ultracode");
if (!existsSync(uc)) { console.error("pi-ultracode not installed; skipping"); process.exit(2); }
const releases = join(homedir(), ".pi/agent/install/releases");
const nm = join(releases, readdirSync(releases).sort().reverse()[0], "node_modules");
const { createJiti } = await import(pathToFileURL(join(nm, "jiti/lib/jiti.mjs")).href);
const jiti = createJiti(import.meta.url, { alias: { typebox: join(nm, "typebox/build/index.mjs") } });
const parser = await jiti.import(join(uc, "src/workflow/parser.ts"));

const dir = join(here, "..", "assets", "workflows");
let fail = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".workflow.js"))) {
  try {
    const parsed = parser.parseWorkflowScript(readFileSync(join(dir, f), "utf8"));
    console.log(`PASS  ${f}  (meta.name=${parsed.meta?.name})`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${f}\n      ${String(e?.message ?? e).split("\n").slice(0, 4).join("\n      ")}`);
  }
}
process.exit(fail ? 1 : 0);
