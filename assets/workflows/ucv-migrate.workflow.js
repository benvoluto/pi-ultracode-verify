// managedBy: pi-ultracode-verify  (delete this line to take ownership; it will then never be overwritten)
/// <reference types="pi-ultracode/workflow" />
//
// Pattern: batched loop-until-done + per-unit pipeline. Each batch the planner enumerates the next
// units still needing migration (dynamic count); each unit flows implement (worktree) -> review -> fix
// independently (no barrier). After all batches, the repo's real checks run with a bounded fix loop.
//
// args: { task: string, checks?: { [name]: command }, maxUnitsPerBatch?: 1-12 (6), maxBatches?: 1-4 (3),
//         maxFixRounds?: 0-4 (2), useWorktrees?: boolean (true) }

export const meta = {
  name: "ucv-migrate",
  description:
    "Migrate/refactor across many units: batch-plan remaining work, pipeline each unit through implement -> review -> fix, then verify with the repo's checks.",
  whenToUse: "API migrations, renames, dependency upgrades, or refactors touching many modules/call sites.",
  phases: [{ title: "Plan" }, { title: "Migrate" }, { title: "Verify" }, { title: "Fix" }],
};

// `args` may arrive as an object or as a JSON string (the workflow tool's args parameter is untyped,
// and models often stringify it), so accept both.
function parseArgs(a) {
  if (typeof a === "string") {
    try {
      const v = JSON.parse(a);
      return v && typeof v === "object" ? v : {};
    } catch (e) {
      return {};
    }
  }
  return a && typeof a === "object" ? a : {};
}
const input = parseArgs(args);
const task = String(input.task || "").trim();
if (!task) throw new Error("ucv-migrate requires args.task");
const checks = input.checks && typeof input.checks === "object" ? input.checks : {};
const perBatch = clampInt(input.maxUnitsPerBatch, 1, 12, 6);
const maxBatches = clampInt(input.maxBatches, 1, 4, 3);
const maxFixRounds = clampInt(input.maxFixRounds, 0, 4, 2);
const useWorktrees = input.useWorktrees !== false;

const PLAN = {
  type: "object",
  properties: {
    done: { type: "boolean" },
    remainingEstimate: { type: "number" },
    units: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          instructions: { type: "string" },
          files: { type: "array", items: { type: "string" } },
        },
        required: ["id", "title", "instructions"],
      },
    },
  },
  required: ["done", "units"],
};
const IMPL = {
  type: "object",
  properties: { summary: { type: "string" }, filesChanged: { type: "array", items: { type: "string" } } },
  required: ["summary"],
};
const UNIT_REVIEW = {
  type: "object",
  properties: { ok: { type: "boolean" }, problems: { type: "array", items: { type: "string" } } },
  required: ["ok"],
};
const TEST = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          command: { type: "string" },
          passed: { type: "boolean" },
          failureSummary: { type: "string" },
        },
        required: ["name", "passed"],
      },
    },
    allPassed: { type: "boolean" },
  },
  required: ["results", "allPassed"],
};

function clampInt(v, lo, hi, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : d;
}
function checksText() {
  const names = Object.keys(checks);
  if (names.length === 0) return "No verification commands were detected for this repository.";
  return names.map((n) => "- " + n + ": `" + checks[n] + "`").join("\n");
}
function planPrompt(completed) {
  return (
    "Migration task:\n" +
    task +
    "\n\nUnits already completed in earlier batches:\n" +
    (completed.length ? completed.map((c) => "- " + c).join("\n") : "(none)") +
    "\n\nInspect the CURRENT code and list the next units that still need migrating, at most " +
    perBatch +
    ". Units must not edit the same files. Set done=true with an empty list if nothing remains."
  );
}
function implPrompt(u) {
  return (
    "Migration task (context):\n" + task + "\n\nYOUR UNIT: " + u.title + "\n" + u.instructions +
    (u.files && u.files.length ? "\n\nFiles you own: " + u.files.join(", ") : "") +
    "\n\nOther agents migrate other units in parallel; touch only your files."
  );
}
function unitOptions(kind, u) {
  if (kind === "review") return { label: "review " + u.id, phase: "Migrate", agentType: "ucv-refuter", schema: UNIT_REVIEW };
  const o = { label: kind + " " + u.id, phase: "Migrate", agentType: "ucv-implementer", schema: IMPL };
  if (useWorktrees) o.isolation = "worktree";
  return o;
}
function reviewPrompt(u) {
  return (
    "Check whether this migration unit was completed correctly in the current code. Be skeptical; set ok=false with specific problems if anything is missing or wrong.\n\nUnit: " +
    u.title + "\n" + u.instructions + (u.files && u.files.length ? "\nFiles: " + u.files.join(", ") : "")
  );
}
function fixPrompt(u, problems) {
  return implPrompt(u) + "\n\nA reviewer found these problems with your unit; fix them:\n" + problems.map((p) => "- " + p).join("\n");
}
function testerOptions(label) {
  return { label: label, phase: "Verify", agentType: "ucv-tester", schema: TEST };
}

const completed = [];
const unitResults = [];
let batch = 0;
let finished = false;
while (batch < maxBatches) {
  batch++;
  phase("Plan");
  const plan = await agent(planPrompt(completed), { label: "plan batch " + batch, phase: "Plan", agentType: "ucv-planner", schema: PLAN });
  const units = plan && Array.isArray(plan.units) ? plan.units.slice(0, perBatch) : [];
  if (!plan || plan.done === true || units.length === 0) {
    finished = Boolean(plan);
    break;
  }
  log("Batch " + batch + ": " + units.length + " unit(s)");
  phase("Migrate");
  const outcomes = await pipeline(
    units,
    (prev, u) => agent(implPrompt(u), unitOptions("implement", u)),
    (impl, u) => agent(reviewPrompt(u), unitOptions("review", u)),
    async (verdict, u) => {
      if (verdict && verdict.ok === false && Array.isArray(verdict.problems) && verdict.problems.length) {
        const fixed = await agent(fixPrompt(u, verdict.problems), unitOptions("fix", u));
        return { ok: Boolean(fixed), fixedAfterReview: true, problems: verdict.problems };
      }
      return { ok: Boolean(verdict && verdict.ok === true), fixedAfterReview: false, problems: [] };
    },
  );
  for (let i = 0; i < units.length; i++) {
    unitResults.push({ batch: batch, id: units[i].id, title: units[i].title, outcome: outcomes[i] });
    if (outcomes[i] && outcomes[i].ok) completed.push(units[i].title);
  }
}

phase("Verify");
let test = await agent("Run these repository checks in order and report each result:\n" + checksText(), testerOptions("verify"));
let fixRounds = 0;
while (fixRounds < maxFixRounds && !(test && test.allPassed === true)) {
  fixRounds++;
  phase("Fix");
  await agent(
    "The migration left these repository checks failing. Fix the code so they pass (do not weaken tests):\n" +
      (test ? test.results.filter((r) => !r.passed).map((r) => "- " + r.name + ": " + (r.failureSummary || "failed")).join("\n") : "Checks did not report.") +
      "\n\nMigration task (context):\n" + task,
    { label: "repair " + fixRounds, phase: "Fix", agentType: "ucv-implementer", schema: IMPL },
  );
  test = await agent("Run these repository checks in order and report each result:\n" + checksText(), testerOptions("re-verify " + fixRounds));
}

return {
  status: finished && test && test.allPassed === true ? "complete" : "needs-attention",
  finished: finished,
  note: finished ? "Planner reported no remaining units." : "Stopped at maxBatches; re-run to continue the migration.",
  batches: batch,
  units: unitResults,
  verification: test,
  fixRounds: fixRounds,
};
