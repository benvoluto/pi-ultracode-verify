// managedBy: pi-ultracode-verify  (delete this line to take ownership; it will then never be overwritten)
/// <reference types="pi-ultracode/workflow" />
//
// Pattern: adversarial verification. Several review lenses + the repo's real checks run in
// parallel; every significant finding must survive an independent refuter. Read-only.
//
// args: { focus?: string, checks?: { [name]: command }, lenses?: string[] }

export const meta = {
  name: "ucv-review",
  description:
    "Adversarially review the current changes: parallel review lenses plus the repo's own checks, with every significant finding independently refuted.",
  whenToUse: "Reviewing a branch, PR, or uncommitted changes before merging.",
  phases: [{ title: "Review" }, { title: "Refute" }],
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
const focus = String(input.focus || "").trim();
const checks = input.checks && typeof input.checks === "object" ? input.checks : {};
const lenses =
  Array.isArray(input.lenses) && input.lenses.length
    ? input.lenses.slice(0, 6).map(String)
    : ["correctness and edge cases", "security and data handling", "tests and coverage of changed behavior", "performance and reliability"];
const MAX_REFUTE = 10;

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
const VERDICT = {
  type: "object",
  properties: { real: { type: "boolean" }, evidence: { type: "string" } },
  required: ["real", "evidence"],
};

function checksText() {
  const names = Object.keys(checks);
  if (names.length === 0) return "No verification commands were detected for this repository.";
  return names.map((n) => "- " + n + ": `" + checks[n] + "`").join("\n");
}
function findingText(f) {
  return "[" + f.severity + "] " + f.file + (f.line ? ":" + f.line : "") + " — " + f.description;
}
function reviewPrompt(lens) {
  return (
    "Review the current changes in this repository (git diff HEAD plus untracked files; if there are none, review the latest commit with git show HEAD) through ONE lens: " +
    lens +
    ". Report only concrete, evidenced defects for this lens." +
    (focus ? "\n\nFocus / context from the requester:\n" + focus : "")
  );
}
// Jobs are plain data; thunks are created in a single map expression (pi-ultracode rejects
// pushing orchestration thunks into arrays).
function jobPrompt(job) {
  return job.kind === "test"
    ? "Run these repository checks in order and report each result:\n" + checksText()
    : reviewPrompt(job.lens);
}
function jobOptions(job) {
  return job.kind === "test"
    ? { label: "run checks", phase: "Review", agentType: "ucv-tester", schema: TEST }
    : { label: "lens " + (job.i + 1), phase: "Review", agentType: "ucv-reviewer", schema: FINDINGS };
}

phase("Review");
const jobs = lenses.map((lens, i) => ({ kind: "lens", lens: lens, i: i }));
jobs.push({ kind: "test" });
const panel = await parallel(jobs.map((job) => () => agent(jobPrompt(job), jobOptions(job))));
const test = panel[lenses.length];

// Merge + dedupe findings across lenses (same file+line+first 60 chars).
const seen = new Set();
const all = [];
for (let i = 0; i < lenses.length; i++) {
  const r = panel[i];
  const list = r && Array.isArray(r.findings) ? r.findings : [];
  for (const f of list) {
    const key = f.file + ":" + (f.line || 0) + ":" + String(f.description).slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(Object.assign({ lens: lenses[i] }, f));
  }
}
const lensesFailed = lenses.filter((l, i) => !panel[i]);
const significant = all.filter((f) => f.severity !== "minor").slice(0, MAX_REFUTE);
const minor = all.filter((f) => f.severity === "minor");

let confirmed = [];
let refuted = [];
if (significant.length) {
  phase("Refute");
  const verdicts = await parallel(
    significant.map((f, i) => () =>
      agent("Try to refute this claimed defect in the current code:\n" + findingText(f), {
        label: "refute " + (i + 1),
        phase: "Refute",
        agentType: "ucv-refuter",
        schema: VERDICT,
      }),
    ),
  );
  confirmed = significant
    .map((f, i) => Object.assign({ evidence: verdicts[i] ? verdicts[i].evidence : "" }, f))
    .filter((f, i) => verdicts[i] && verdicts[i].real === true);
  refuted = significant.filter((f, i) => !(verdicts[i] && verdicts[i].real === true));
}

return {
  checks: test,
  checksPassed: Boolean(test && test.allPassed === true),
  confirmedFindings: confirmed,
  refutedFindings: refuted,
  unverifiedMinorFindings: minor,
  coverage: { lenses: lenses, lensesFailed: lensesFailed, findingsConsidered: all.length },
};
