// managedBy: pi-ultracode-verify  (delete this line to take ownership; it will then never be overwritten)
/// <reference types="pi-ultracode/workflow" />
//
// Pattern: fan-out-and-synthesize with coverage tracking (defeats "agentic laziness").
// A scout enumerates targets; one isolated reviewer per target; significant findings are
// refuted; the orchestrator tracks which targets were and were not covered. Read-only.
//
// args: { focus: string, paths?: string[], maxTargets?: 1-24 (12) }

export const meta = {
  name: "ucv-audit",
  description:
    "Audit a codebase area: enumerate targets, review each in its own context, refute significant findings, and report coverage.",
  whenToUse: "Security/quality audits or 'check every X' tasks across many files or modules.",
  phases: [{ title: "Scope" }, { title: "Audit" }, { title: "Refute" }],
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
if (!focus) throw new Error("ucv-audit requires args.focus (what to audit for)");
const givenPaths = Array.isArray(input.paths) ? input.paths.map(String) : [];
const maxTargets = clampInt(input.maxTargets, 1, 24, 12);
const MAX_REFUTE = 10;

const TARGETS = {
  type: "object",
  properties: {
    targets: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, why: { type: "string" } },
        required: ["path"],
      },
    },
    omitted: { type: "string" },
  },
  required: ["targets"],
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

function clampInt(v, lo, hi, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : d;
}
function findingText(f) {
  return "[" + f.severity + "] " + f.file + (f.line ? ":" + f.line : "") + " — " + f.description;
}
function auditPrompt(t) {
  return (
    "Audit ONLY this target: " +
    t.path +
    (t.why ? " (" + t.why + ")" : "") +
    "\n\nAudit goal:\n" +
    focus +
    "\n\nThe code is not necessarily changed; review it as it currently is. Report only concrete, evidenced defects relevant to the goal."
  );
}
function auditOptions(i) {
  return { label: "audit " + (i + 1), phase: "Audit", agentType: "ucv-reviewer", schema: FINDINGS };
}

phase("Scope");
let targets = givenPaths.map((p) => ({ path: p, why: "requested" }));
let omitted = "";
if (targets.length === 0) {
  const scope = await agent(
    "List the files or modules that must be examined for this audit, most relevant first, at most " +
      maxTargets +
      ". Group tiny related files into one target (a directory path is fine). If more targets exist than the limit, describe what was left out in `omitted`.\n\nAudit goal:\n" +
      focus,
    { label: "scope", phase: "Scope", agentType: "Explore", schema: TARGETS },
  );
  targets = scope && Array.isArray(scope.targets) ? scope.targets : [];
  omitted = scope && scope.omitted ? String(scope.omitted) : "";
}
targets = targets.slice(0, maxTargets);
if (targets.length === 0) return { error: "No audit targets found.", focus: focus };
log("Auditing " + targets.length + " target(s)");

phase("Audit");
const reports = await parallel(targets.map((t, i) => () => agent(auditPrompt(t), auditOptions(i))));
const covered = targets.filter((t, i) => reports[i]).map((t) => t.path);
const uncovered = targets.filter((t, i) => !reports[i]).map((t) => t.path);
const all = [];
for (let i = 0; i < reports.length; i++) {
  const r = reports[i];
  if (r && Array.isArray(r.findings)) for (const f of r.findings) all.push(Object.assign({ target: targets[i].path }, f));
}
const significant = all.filter((f) => f.severity !== "minor").slice(0, MAX_REFUTE);

let confirmed = [];
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
}

return {
  focus: focus,
  confirmedFindings: confirmed,
  refutedCount: significant.length - confirmed.length,
  unverifiedMinorFindings: all.filter((f) => f.severity === "minor"),
  findingsBeyondRefuteCap: Math.max(0, all.filter((f) => f.severity !== "minor").length - MAX_REFUTE),
  coverage: { covered: covered, uncovered: uncovered, omittedByScope: omitted },
};
