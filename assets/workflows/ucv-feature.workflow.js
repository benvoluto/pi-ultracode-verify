// managedBy: pi-ultracode-verify  (delete this line to take ownership; it will then never be overwritten)
/// <reference types="pi-ultracode/workflow" />
//
// Pattern: plan -> fan-out implementation (worktrees) -> repo checks + adversarial review
//          -> refute findings -> bounded fix loop until checks pass and findings are resolved.
// Agent count is dynamic: the planner decides how many independent units exist (1..maxUnits).
//
// args: { task: string, checks?: { [name]: command }, maxUnits?: 1-8 (4), maxFixRounds?: 0-4 (2), useWorktrees?: boolean (true) }

export const meta = {
  name: "ucv-feature",
  description:
    "Plan a change, implement independent units in parallel, verify with the repo's own checks plus adversarial review, and fix until green.",
  whenToUse: "Feature work or multi-part changes where verification against the repository's real checks matters.",
  phases: [{ title: "Plan" }, { title: "Implement" }, { title: "Verify" }, { title: "Refute" }, { title: "Fix" }],
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
if (!task) throw new Error("ucv-feature requires args.task");
const checks = input.checks && typeof input.checks === "object" ? input.checks : {};
const maxUnits = clamp(input.maxUnits, 1, 8, 4);
const maxFixRounds = clamp(input.maxFixRounds, 0, 4, 2);
const useWorktrees = input.useWorktrees !== false;
const MAX_REFUTE = 6;

const PLAN = {
  type: "object",
  properties: {
    summary: { type: "string" },
    units: {
      type: "array",
      minItems: 1,
      maxItems: 8,
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
  required: ["units"],
};
const IMPL = {
  type: "object",
  properties: {
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    risks: { type: "string" },
  },
  required: ["summary"],
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
const FINDINGS = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["critical", "major", "minor"] },
          file: { type: "string" },
          line: { type: "number" },
          description: { type: "string" },
          suggestedFix: { type: "string" },
        },
        required: ["severity", "file", "description"],
      },
    },
  },
  required: ["findings"],
};
const VERDICT = {
  type: "object",
  properties: { real: { type: "boolean" }, evidence: { type: "string" } },
  required: ["real", "evidence"],
};
const RESOLVED = {
  type: "object",
  properties: { resolved: { type: "boolean" }, evidence: { type: "string" } },
  required: ["resolved", "evidence"],
};

function clamp(v, lo, hi, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : d;
}

function checksText() {
  const names = Object.keys(checks);
  if (names.length === 0) {
    return "No verification commands were detected for this repository.";
  }
  return names.map((n) => "- " + n + ": `" + checks[n] + "`").join("\n");
}

function findingText(f) {
  return "[" + f.severity + "] " + f.file + (f.line ? ":" + f.line : "") + " — " + f.description;
}

function testFailures(t) {
  if (!t) return "The verification agent failed to produce results; re-run the checks yourself.";
  return t.results
    .filter((r) => !r.passed)
    .map((r) => "- " + r.name + " (`" + (r.command || "") + "`): " + (r.failureSummary || "failed"))
    .join("\n");
}

function passed(t) {
  return Boolean(t && t.allPassed === true);
}

function testerPrompt() {
  return (
    "Verify the repository after changes for this task:\n" +
    task +
    "\n\nRun these commands from the repository root, in order, and report each result:\n" +
    checksText()
  );
}

function testerOptions(label) {
  return { label: label, phase: "Verify", agentType: "ucv-tester", schema: TEST };
}
// Note: call agent() directly instead of via async helpers; pi-ultracode's static analysis
// rejects values that flow out of declared orchestration helpers in some positions.

// ---------------------------------------------------------------- Plan
phase("Plan");
const plan = await agent(
  "Decompose this task into at most " +
    maxUnits +
    " independent units that can be implemented in parallel without editing the same files. " +
    "Return ONE unit if the change is small or tightly coupled.\n\nTask:\n" +
    task,
  { label: "plan", phase: "Plan", agentType: "ucv-planner", schema: PLAN },
);
let units = plan && Array.isArray(plan.units) && plan.units.length ? plan.units.slice(0, maxUnits) : [];
if (units.length === 0) units = [{ id: "main", title: task.slice(0, 80), instructions: task, files: [] }];
log("Plan: " + units.length + " unit(s) — " + units.map((u) => u.id).join(", "));

function implPrompt(u) {
  const others = units
    .filter((o) => o.id !== u.id)
    .map((o) => "- " + o.title + (o.files && o.files.length ? " (files: " + o.files.join(", ") + ")" : ""))
    .join("\n");
  return (
    "Overall task (for context):\n" +
    task +
    (plan && plan.summary ? "\n\nShared context:\n" + plan.summary : "") +
    "\n\nYOUR UNIT: " +
    u.title +
    "\n" +
    u.instructions +
    (u.files && u.files.length ? "\n\nFiles you own: " + u.files.join(", ") : "") +
    (others ? "\n\nOther agents are implementing these units in parallel; do not edit their files:\n" + others : "") +
    "\n\nRepository verification commands (run what you can; the orchestrator re-runs all of them after integration):\n" +
    checksText()
  );
}

function implOptions(u) {
  const o = { label: "implement " + u.id, phase: "Implement", agentType: "ucv-implementer", schema: IMPL };
  if (useWorktrees) o.isolation = "worktree";
  return o;
}

// ---------------------------------------------------------------- Implement
phase("Implement");
let implementations;
if (units.length === 1) {
  const one = await agent(implPrompt(units[0]), {
    label: "implement " + units[0].id,
    phase: "Implement",
    agentType: "ucv-implementer",
    schema: IMPL,
  });
  implementations = [one];
} else {
  implementations = await parallel(
    units.map((u) => () =>
      agent(implPrompt(u), implOptions(u)),
    ),
  );
}
const failedUnits = units.filter((u, i) => !implementations[i]).map((u) => u.id);
if (failedUnits.length) log("Units without a result (failed or conflicted delivery): " + failedUnits.join(", "));

// ---------------------------------------------------------------- Verify (checks + review in parallel)
phase("Verify");
const verifyPanel = await parallel([
  () => agent(testerPrompt(), testerOptions("run checks")),
  () =>
    agent(
      "Review the changes just made in this repository (git diff HEAD plus untracked files) for this task:\n" +
        task +
        "\n\nReport only concrete, evidenced defects, including requirement misses.",
      { label: "adversarial review", phase: "Verify", agentType: "ucv-reviewer", schema: FINDINGS },
    ),
]);
let test = verifyPanel[0];
const review = verifyPanel[1];
const significant = (review && review.findings ? review.findings : [])
  .filter((f) => f.severity === "critical" || f.severity === "major")
  .slice(0, MAX_REFUTE);

// ---------------------------------------------------------------- Refute
let confirmed = [];
if (significant.length) {
  phase("Refute");
  const verdicts = await parallel(
    significant.map((f, i) => () =>
      agent(
        "Try to refute this claimed defect in the current code:\n" + findingText(f) +
          (f.suggestedFix ? "\nSuggested fix: " + f.suggestedFix : ""),
        { label: "refute " + (i + 1), phase: "Refute", agentType: "ucv-refuter", schema: VERDICT },
      ),
    ),
  );
  confirmed = significant.filter((f, i) => verdicts[i] && verdicts[i].real === true);
  log("Review: " + significant.length + " significant finding(s), " + confirmed.length + " survived refutation");
}
const initialFindings = confirmed.slice();

// ---------------------------------------------------------------- Fix loop
let open = confirmed;
let round = 0;
while (round < maxFixRounds && (!passed(test) || open.length > 0)) {
  round++;
  phase("Fix");
  await agent(
    "Fix the following problems for this task:\n" +
      task +
      (passed(test) ? "" : "\n\nFailing verification checks:\n" + testFailures(test)) +
      (open.length ? "\n\nConfirmed review findings:\n" + open.map((f) => "- " + findingText(f)).join("\n") : "") +
      "\n\nFix the root causes in the code. Do not weaken, skip, or delete tests or checks.",
    { label: "fix round " + round, phase: "Fix", agentType: "ucv-implementer", schema: IMPL },
  );
  if (open.length) {
    const resolution = await parallel(
      open.map((f, i) => () =>
        agent("Has this previously confirmed defect been RESOLVED in the current code?\n" + findingText(f), {
          label: "re-check " + (i + 1),
          phase: "Fix",
          agentType: "ucv-refuter",
          schema: RESOLVED,
        }),
      ),
    );
    open = open.filter((f, i) => !(resolution[i] && resolution[i].resolved === true));
  }
  test = await agent(testerPrompt(), testerOptions("re-verify " + round));
}

const verified = passed(test) && open.length === 0 && failedUnits.length === 0;
return {
  status: verified ? "verified" : "needs-attention",
  units: units.map((u, i) => ({ id: u.id, title: u.title, result: implementations[i] })),
  failedUnits: failedUnits,
  verification: test,
  confirmedFindings: initialFindings,
  unresolvedFindings: open,
  fixRounds: round,
};
