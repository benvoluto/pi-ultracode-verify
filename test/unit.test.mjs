// Unit tests for detection, config, runner, and asset sync. Run: npm test
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "extensions", "ucv");
const releases = join(homedir(), ".pi/agent/install/releases");
const nm =
  process.env.PI_NODE_MODULES ||
  join(releases, readdirSync(releases).filter((v) => existsSync(join(releases, v, "node_modules/jiti"))).sort().reverse()[0], "node_modules");
const { createJiti } = await import(pathToFileURL(join(nm, "jiti/lib/jiti.mjs")).href);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(nm, "@earendil-works/pi-coding-agent"),
    "@earendil-works/pi-tui": join(nm, "@earendil-works/pi-tui"),
    typebox: join(nm, "typebox/build/index.mjs"),
  },
});
const { probeProject } = await jiti.import(join(ext, "probe.ts"));
const { resolveChecks, checksToMap } = await jiti.import(join(ext, "config.ts"));
const { runCommand, formatResults } = await jiti.import(join(ext, "runner.ts"));
const { syncAssets, MANAGED_MARKER } = await jiti.import(join(ext, "sync.ts"));

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  const norm = (v) => (v && typeof v === "object" && !Array.isArray(v) ? sortKeys(v) : v);
  const ok = JSON.stringify(norm(got)) === JSON.stringify(norm(want));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}
const tmp = mkdtempSync(join(tmpdir(), "ucv-test-"));
function fixture(name, files) {
  const dir = join(tmp, name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const cmds = (r) => sortKeys(Object.fromEntries(Object.entries(r.checks).map(([k, v]) => [k, v.command])));

// ---------------------------------------------------------------- probe
{
  const d = fixture("npm-placeholder", {
    "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: "eslint ." } }),
    ".git/HEAD": "",
  });
  eq("npm: placeholder test ignored, lint via npm run", cmds(probeProject(d)), { lint: "npm run lint" });
}
{
  const d = fixture("pnpm-ts", {
    "package.json": JSON.stringify({
      scripts: { test: "vitest run", build: "tsc -b", "format:check": "prettier -c ." },
      devDependencies: { typescript: "^5" },
    }),
    "pnpm-lock.yaml": "",
    "tsconfig.json": "{}",
  });
  const r = probeProject(d);
  eq("pnpm: package manager", r.packageManager, "pnpm");
  eq("pnpm: commands", cmds(r), {
    typecheck: "pnpm exec tsc --noEmit",
    test: "pnpm run test",
    build: "pnpm run build",
    format: "pnpm run format:check",
  });
}
{
  const d = fixture("pm-field", { "package.json": JSON.stringify({ packageManager: "yarn@4.1.0", scripts: { typecheck: "tsc" } }) });
  eq("packageManager field wins (yarn)", cmds(probeProject(d)), { typecheck: "yarn run typecheck" });
}
{
  const d = fixture("rust", { "Cargo.toml": "[package]\nname='x'" });
  eq("rust", cmds(probeProject(d)), {
    typecheck: "cargo check --all-targets",
    lint: "cargo clippy --all-targets",
    test: "cargo test",
    build: "cargo build",
    format: "cargo fmt --check",
  });
}
{
  const d = fixture("go", { "go.mod": "module x", ".golangci.yml": "" });
  eq("go + golangci", cmds(probeProject(d)), {
    typecheck: "go vet ./...",
    lint: "golangci-lint run",
    test: "go test ./...",
    build: "go build ./...",
  });
}
{
  const d = fixture("python-uv", {
    "pyproject.toml": "[project]\nname='x'\n[tool.ruff]\n[tool.mypy]\n[tool.pytest.ini_options]\n",
    "uv.lock": "",
  });
  eq("python uv + ruff + mypy + pytest", cmds(probeProject(d)), {
    typecheck: "uv run mypy .",
    lint: "uv run ruff check .",
    test: "uv run pytest -q",
    format: "uv run ruff format --check .",
  });
}
{
  const d = fixture("make-fill", {
    "go.mod": "module x",
    Makefile: "lint:\n\tgolint\nVAR := 1\ntest-fast:\n\techo\n",
  });
  const r = cmds(probeProject(d));
  eq("make fills only empty slots (lint)", r.lint, "make lint");
  eq("make does not override go test", r.test, "go test ./...");
}
{
  const d = fixture("nested/sub/dir", {});
  writeFileSync(join(tmp, "nested", "Cargo.toml"), "[package]");
  eq("walks up to project root", probeProject(join(tmp, "nested/sub/dir")).root, join(tmp, "nested"));
}
{
  const d = fixture("empty", { "notes.txt": "hi" });
  const r = probeProject(d);
  eq("unrecognized project: no checks", r.checks, {});
  eq("unrecognized project: note", r.notes.length > 0, true);
}

// ---------------------------------------------------------------- config
{
  const d = fixture("cfg", {
    "package.json": JSON.stringify({ scripts: { test: "jest", build: "tsc", lint: "eslint ." } }),
    ".pi/ultracode-verify.json": JSON.stringify({
      checks: { test: "pnpm vitest run", build: null },
      gate: { maxAttempts: 1, checks: ["test"], timeoutSeconds: 30 },
    }),
  });
  const trusted = resolveChecks(d, true);
  eq("trusted: override + disable", checksToMap(trusted.checks), { lint: "npm run lint", test: "pnpm vitest run" });
  eq("trusted: gate config", trusted.gate, { enabled: true, maxAttempts: 1, checks: ["test"], timeoutSeconds: 30 });
  const untrusted = resolveChecks(d, false);
  eq("untrusted: project config ignored", checksToMap(untrusted.checks), {
    lint: "npm run lint",
    test: "npm run test",
    build: "npm run build",
  });
  eq("untrusted: reports ignored file", Boolean(untrusted.ignoredProjectConfig), true);
  process.env.PI_UCV_GATE = "0";
  eq("PI_UCV_GATE=0 disables gate", resolveChecks(d, true).gate.enabled, false);
  delete process.env.PI_UCV_GATE;
}

// ---------------------------------------------------------------- runner
{
  const ok = await runCommand("t", "echo hello", tmp, 10_000);
  eq("runner: pass", [ok.ok, ok.exitCode, ok.tail], [true, 0, "hello"]);
  const bad = await runCommand("t", "echo boom 1>&2; exit 3", tmp, 10_000);
  eq("runner: fail captures stderr", [bad.ok, bad.exitCode, bad.tail], [false, 3, "boom"]);
  const slow = await runCommand("t", "sleep 5", tmp, 300);
  eq("runner: timeout kills", [slow.ok, slow.timedOut], [false, true]);
  const long = await runCommand("t", "for i in $(seq 1 500); do echo line$i; done", tmp, 10_000);
  eq("runner: tail bounded to last lines", [long.tail.split("\n").length <= 80, long.tail.endsWith("line500")], [true, true]);
  eq("formatResults summary", formatResults([ok, bad]).split("\n")[0], "1/2 checks failed.");
}

// ---------------------------------------------------------------- sync
{
  const assets = join(tmp, "assets");
  mkdirSync(join(assets, "agents"), { recursive: true });
  mkdirSync(join(assets, "workflows"), { recursive: true });
  writeFileSync(join(assets, "agents", "a.md"), `---\nname: a\n${MANAGED_MARKER}\n---\nv1`);
  writeFileSync(join(assets, "workflows", "w.workflow.js"), `// ${MANAGED_MARKER}\nv1`);
  const home = join(tmp, "uc-home");
  let r = syncAssets(assets, home);
  eq("sync: first run writes", [r.written.length, r.updated.length], [2, 0]);
  r = syncAssets(assets, home);
  eq("sync: second run unchanged", [r.written.length, r.updated.length, r.unchanged], [0, 0, 2]);
  writeFileSync(join(assets, "agents", "a.md"), `---\nname: a\n${MANAGED_MARKER}\n---\nv2`);
  r = syncAssets(assets, home);
  eq("sync: managed file updated", [r.updated.length, readFileSync(join(home, "agents", "a.md"), "utf8").endsWith("v2")], [1, true]);
  writeFileSync(join(home, "workflows", "w.workflow.js"), "my custom version");
  writeFileSync(join(assets, "workflows", "w.workflow.js"), `// ${MANAGED_MARKER}\nv3`);
  r = syncAssets(assets, home);
  eq("sync: user-owned file untouched", [r.skippedUserOwned.length, readFileSync(join(home, "workflows", "w.workflow.js"), "utf8")], [1, "my custom version"]);
}

// ---------------------------------------------------------------- workflow invariants
{
  const wfDir = join(here, "..", "assets", "workflows");
  for (const f of readdirSync(wfDir).filter((f) => f.endsWith(".workflow.js"))) {
    const src = readFileSync(join(wfDir, f), "utf8");
    // Regression: the workflow tool's `args` is untyped and models often send a JSON string.
    eq(`${f}: tolerates string args`, /const input = parseArgs\(args\);/.test(src) && /JSON\.parse\(a\)/.test(src), true);
    eq(`${f}: carries managed marker`, src.includes(MANAGED_MARKER), true);
  }
  const agDir = join(here, "..", "assets", "agents");
  for (const f of readdirSync(agDir).filter((f) => f.endsWith(".md"))) {
    const src = readFileSync(join(agDir, f), "utf8");
    eq(`${f}: frontmatter name matches file`, (src.match(/^name: (.+)$/m) || [])[1], f.replace(/\.md$/, ""));
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
