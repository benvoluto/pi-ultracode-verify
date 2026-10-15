// managedBy: pi-ultracode-verify  (delete this line to take ownership; it will then never be overwritten)
/// <reference types="pi-ultracode/workflow" />
//
// Pattern: loop-until-done. Finder agents (different lenses) run each round until two consecutive
// rounds surface nothing new; each fresh bug must survive an independent refuter (who may reproduce
// it with the repo's own tests). Optional fix phase with repo-check verification.
//
// args: { focus?: string, checks?: { [name]: command }, maxRounds?: 1-6 (4), fix?: boolean, maxFixRounds?: 0-4 (2) }

export const meta = {
  name: "ucv-bughunt",
  description:
    "Hunt bugs until rounds come back dry, confirm each with an independent refuter, and optionally fix and verify with the repo's checks.",
  whenToUse: "Open-ended bug discovery where the number of issues is unknown.",
  phases: [{ title: "Find" }, { title: "Confirm" }, { title: "Fix" }],
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
const focus = String(input.focus || input.task || "").trim();
const checks = input.checks && typeof input.checks === "object" ? input.checks : {};
const maxRounds = clampInt(input.maxRounds, 1, 6, 4);
const doFix = input.fix === true;
const maxFixRounds = clampInt(input.maxFixRounds, 0, 4, 2);
const MAX_CONFIRM_PER_ROUND = 6;

const LENSES = [
  "correctness: read the code closely for logic errors, wrong conditions, and off-by-one mistakes",
  "data flow: trace values across module boundaries for null/undefined, type, and state bugs",
  "failure paths: hunt error-handling gaps, edge cases, resource leaks, and concurrency hazards",
];

const BUGS = {
  type: "object",
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          description: { type: "string" },
          trigger: { type: "string" },
        },
        required: ["file", "description"],
      },
    },
  },
  required: ["bugs"],
};
const VERDICT = {
  type: "object",
  properties: { real: { type: "boolean" }, evidence: { type: "string" } },
  required: ["real", "evidence"],
};
const IMPL = {
  type: "object",
  properties: { summary: { type: "string" }, filesChanged: { type: "array", items: { type: "string" } } },
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

function clampInt(v, lo, hi, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : d;
}
function checksText() {
  const names = Object.keys(checks);
  if (names.length === 0) return "No verification commands were detected for this repository.";
  return names.map((n) => "- " + n + ": `" + checks[n] + "`").join("\n");
}
function bugText(b) {
  return b.file + (b.line ? ":" + b.line : "") + " — " + b.description + (b.trigger ? " (trigger: " + b.trigger + ")" : "");
}
function bugKey(b) {
  return (b.file + ":" + String(b.description).slice(0, 50)).toLowerCase();
}
function finderPrompt(lens, known) {
  return (
    "Find real bugs in this repository using this lens: " +
    lens +
    "." +
    (focus ? "\n\nScope / focus:\n" + focus : "") +
    (known.length ? "\n\nAlready known (do NOT report these again):\n" + known.slice(0, 40).map((b) => "- " + bugText(b)).join("\n") : "") +
    "\n\nReport only bugs you can justify with concrete evidence; an empty list is fine. Do not modify files."
  );
}
function finderOptions(i, round) {
  return { label: "find r" + round + "." + (i + 1), phase: "Find", agentType: "ucv-reviewer", schema: BUGS };
}
function confirmPrompt(b) {
  return (
    "Try to refute this claimed bug. If cheap, reproduce it read-only with the project's existing tests:\n" +
    bugText(b) +
    "\n\nAvailable repository checks:\n" +
    checksText()
  );
}
function confirmOptions(i, round) {
  return { label: "confirm r" + round + "." + (i + 1), phase: "Confirm", agentType: "ucv-refuter", schema: VERDICT };
}
function testerOptions(label) {
  return { label: label, phase: "Fix", agentType: "ucv-tester", schema: TEST };
}

const seen = new Set();
const known = [];
const confirmed = [];
let dry = 0;
let round = 0;
while (dry < 2 && round < maxRounds) {
  round++;
  phase("Find");
  const found = await parallel(LENSES.map((lens, i) => () => agent(finderPrompt(lens, known), finderOptions(i, round))));
  const fresh = [];
  for (const r of found) {
    const bugs = r && Array.isArray(r.bugs) ? r.bugs : [];
    for (const b of bugs) {
      const k = bugKey(b);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(b);
    }
  }
  if (fresh.length === 0) {
    dry++;
    log("Round " + round + ": nothing new (dry " + dry + "/2)");
    continue;
  }
  dry = 0;
  const batch = fresh.slice(0, MAX_CONFIRM_PER_ROUND);
  phase("Confirm");
  const verdicts = await parallel(batch.map((b, i) => () => agent(confirmPrompt(b), confirmOptions(i, round))));
  for (let i = 0; i < batch.length; i++) {
    known.push(batch[i]);
    if (verdicts[i] && verdicts[i].real === true) confirmed.push(Object.assign({ evidence: verdicts[i].evidence }, batch[i]));
  }
  log("Round " + round + ": " + fresh.length + " new, " + confirmed.length + " confirmed so far");
}
const exhausted = dry >= 2;

let fixRounds = 0;
let test = null;
if (doFix && confirmed.length) {
  phase("Fix");
  await agent(
    "Fix these confirmed bugs at their root cause, adding regression tests where the project has tests:\n" +
      confirmed.map((b) => "- " + bugText(b)).join("\n") +
      "\n\nDo not weaken, skip, or delete existing tests.",
    { label: "fix bugs", phase: "Fix", agentType: "ucv-implementer", schema: IMPL },
  );
  test = await agent("Run these repository checks in order and report each result:\n" + checksText(), testerOptions("verify"));
  while (fixRounds < maxFixRounds && !(test && test.allPassed === true)) {
    fixRounds++;
    await agent(
      "The bug fixes broke or did not satisfy these checks. Fix the code (never the tests' intent):\n" +
        (test ? test.results.filter((r) => !r.passed).map((r) => "- " + r.name + ": " + (r.failureSummary || "failed")).join("\n") : "Checks did not report."),
      { label: "repair " + fixRounds, phase: "Fix", agentType: "ucv-implementer", schema: IMPL },
    );
    test = await agent("Run these repository checks in order and report each result:\n" + checksText(), testerOptions("re-verify " + fixRounds));
  }
}

return {
  confirmedBugs: confirmed,
  candidatesConsidered: seen.size,
  roundsRun: round,
  exhausted: exhausted,
  note: exhausted ? "Stopped after two consecutive dry rounds." : "Stopped at maxRounds before running dry; more bugs may exist.",
  fixed: doFix && confirmed.length > 0,
  verification: test,
  fixRounds: fixRounds,
};
