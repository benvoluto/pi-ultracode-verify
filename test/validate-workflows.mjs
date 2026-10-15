// Validates every bundled workflow with pi-ultracode's own parser + instrumenter.
// Run: node test/validate-workflows.mjs   (requires pi-ultracode installed via `pi install npm:pi-ultracode`)
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findUltracode, makeJiti } from "./env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const uc = findUltracode();
if (!uc) {
  console.error("pi-ultracode not found (run `npm install`); skipping workflow validation");
  process.exit(2);
}
const jiti = await makeJiti(import.meta.url);
const parser = await jiti.import(join(uc, "src/workflow/parser.ts"));

const dir = join(here, "..", "assets", "workflows");
let fail = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".workflow.js"))) {
  try {
    const parsed = parser.parseWorkflowScript(readFileSync(join(dir, f), "utf8"));
    console.log(`PASS  ${f}  (meta.name=${parsed.meta?.name})`);
  } catch (e) {
    fail++;
    console.log(
      `FAIL  ${f}\n      ${String(e?.message ?? e)
        .split("\n")
        .slice(0, 4)
        .join("\n      ")}`,
    );
  }
}
process.exit(fail ? 1 : 0);
