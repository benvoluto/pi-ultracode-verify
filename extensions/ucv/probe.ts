/**
 * Repo-adaptive check detection.
 *
 * Inspects a project directory and returns the commands that typecheck, lint,
 * test, build, and format-check it. Every command is assembled from fixed
 * strings — repo-controlled text (script bodies, target names) is never
 * interpolated into a command — so detection cannot be used for shell injection.
 * Project-supplied overrides (.pi/ultracode-verify.json) are handled separately
 * in config.ts and only honored for trusted projects.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const CHECK_NAMES = ["typecheck", "lint", "test", "build", "format"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export interface DetectedCheck {
	command: string;
	/** Why this command was chosen, e.g. "package.json script \"test\"". */
	source: string;
}

export interface ProbeResult {
	root: string;
	ecosystems: string[];
	packageManager?: string;
	checks: Partial<Record<CheckName, DetectedCheck>>;
	notes: string[];
}

const exists = (p: string) => {
	try {
		fs.accessSync(p);
		return true;
	} catch {
		return false;
	}
};

const readText = (p: string): string | undefined => {
	try {
		return fs.readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
};

const readJson = (p: string): any => {
	const t = readText(p);
	if (t === undefined) return undefined;
	try {
		return JSON.parse(t);
	} catch {
		return undefined;
	}
};

/** npm's placeholder test script — treat as "no test". */
const NPM_PLACEHOLDER_TEST = /no test specified/i;

function set(result: ProbeResult, name: CheckName, command: string, source: string) {
	if (!result.checks[name]) result.checks[name] = { command, source };
}

// ---------------------------------------------------------------------------
// Ecosystem detectors (first match per check wins; order = priority)
// ---------------------------------------------------------------------------

function detectNode(root: string, r: ProbeResult) {
	const pkg = readJson(path.join(root, "package.json"));
	if (!pkg) return;
	r.ecosystems.push("node");

	let pm = "npm";
	const pmField = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
	if (["pnpm", "yarn", "bun", "npm"].includes(pmField)) pm = pmField;
	else if (exists(path.join(root, "pnpm-lock.yaml"))) pm = "pnpm";
	else if (exists(path.join(root, "yarn.lock"))) pm = "yarn";
	else if (exists(path.join(root, "bun.lockb")) || exists(path.join(root, "bun.lock"))) pm = "bun";
	r.packageManager = pm;

	const run = (script: string) => `${pm} run ${script}`;
	const exec = (bin: string) =>
		pm === "npm" ? `npx ${bin}` : pm === "pnpm" ? `pnpm exec ${bin}` : pm === "yarn" ? `yarn ${bin}` : `bunx ${bin}`;

	const scripts: Record<string, unknown> = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
	const has = (s: string) => typeof scripts[s] === "string" && (scripts[s] as string).trim().length > 0;

	for (const s of ["typecheck", "type-check", "check-types", "types", "tsc"]) {
		if (has(s)) {
			set(r, "typecheck", run(s), `package.json script "${s}"`);
			break;
		}
	}
	if (!r.checks.typecheck && exists(path.join(root, "tsconfig.json"))) {
		const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
		if (deps.typescript) set(r, "typecheck", exec("tsc --noEmit"), "tsconfig.json + typescript dependency");
	}
	for (const s of ["lint", "lint:check", "eslint"]) {
		if (has(s)) {
			set(r, "lint", run(s), `package.json script "${s}"`);
			break;
		}
	}
	if (has("test") && !NPM_PLACEHOLDER_TEST.test(String(scripts.test))) {
		set(r, "test", run("test"), 'package.json script "test"');
	} else if (has("test:unit")) {
		set(r, "test", run("test:unit"), 'package.json script "test:unit"');
	}
	if (has("build")) set(r, "build", run("build"), 'package.json script "build"');
	for (const s of ["format:check", "fmt:check", "prettier:check", "check:format"]) {
		if (has(s)) {
			set(r, "format", run(s), `package.json script "${s}"`);
			break;
		}
	}
	if (pkg.workspaces || exists(path.join(root, "pnpm-workspace.yaml"))) {
		r.notes.push("Monorepo/workspaces detected: root scripts are used; per-package checks are not enumerated.");
	}
}

function detectDeno(root: string, r: ProbeResult) {
	if (!exists(path.join(root, "deno.json")) && !exists(path.join(root, "deno.jsonc"))) return;
	r.ecosystems.push("deno");
	set(r, "typecheck", "deno check .", "deno.json");
	set(r, "lint", "deno lint", "deno.json");
	set(r, "test", "deno test", "deno.json");
	set(r, "format", "deno fmt --check", "deno.json");
}

function detectRust(root: string, r: ProbeResult) {
	if (!exists(path.join(root, "Cargo.toml"))) return;
	r.ecosystems.push("rust");
	set(r, "typecheck", "cargo check --all-targets", "Cargo.toml");
	set(r, "lint", "cargo clippy --all-targets", "Cargo.toml");
	set(r, "test", "cargo test", "Cargo.toml");
	set(r, "build", "cargo build", "Cargo.toml");
	set(r, "format", "cargo fmt --check", "Cargo.toml");
}

function detectGo(root: string, r: ProbeResult) {
	if (!exists(path.join(root, "go.mod"))) return;
	r.ecosystems.push("go");
	set(r, "typecheck", "go vet ./...", "go.mod");
	if (exists(path.join(root, ".golangci.yml")) || exists(path.join(root, ".golangci.yaml"))) {
		set(r, "lint", "golangci-lint run", ".golangci config");
	}
	set(r, "test", "go test ./...", "go.mod");
	set(r, "build", "go build ./...", "go.mod");
}

function detectPython(root: string, r: ProbeResult) {
	const pyproject = readText(path.join(root, "pyproject.toml")) ?? "";
	const isPy =
		pyproject.length > 0 ||
		["setup.py", "setup.cfg", "requirements.txt", "Pipfile"].some((f) => exists(path.join(root, f)));
	if (!isPy) return;
	r.ecosystems.push("python");

	const prefix = exists(path.join(root, "uv.lock"))
		? "uv run "
		: exists(path.join(root, "poetry.lock"))
			? "poetry run "
			: exists(path.join(root, "Pipfile.lock"))
				? "pipenv run "
				: "";
	if (prefix) r.packageManager = prefix.split(" ")[0];

	const cfg = pyproject + (readText(path.join(root, "setup.cfg")) ?? "") + (readText(path.join(root, "tox.ini")) ?? "");
	const hasPytest =
		/\[tool\.pytest|\[pytest\]|\[tool:pytest\]/.test(cfg) ||
		exists(path.join(root, "pytest.ini")) ||
		exists(path.join(root, "conftest.py")) ||
		exists(path.join(root, "tests")) ||
		exists(path.join(root, "test"));
	if (hasPytest) set(r, "test", `${prefix}pytest -q`, "pytest configuration / tests directory");

	if (/\[tool\.ruff/.test(pyproject) || exists(path.join(root, "ruff.toml")) || exists(path.join(root, ".ruff.toml"))) {
		set(r, "lint", `${prefix}ruff check .`, "ruff configuration");
		set(r, "format", `${prefix}ruff format --check .`, "ruff configuration");
	} else if (exists(path.join(root, ".flake8")) || /\[flake8\]/.test(cfg)) {
		set(r, "lint", `${prefix}flake8`, "flake8 configuration");
	}

	if (/\[tool\.mypy|\[mypy\]/.test(cfg) || exists(path.join(root, "mypy.ini"))) {
		set(r, "typecheck", `${prefix}mypy .`, "mypy configuration");
	} else if (exists(path.join(root, "pyrightconfig.json")) || /\[tool\.pyright/.test(pyproject)) {
		set(r, "typecheck", `${prefix}pyright`, "pyright configuration");
	}
}

function detectJvm(root: string, r: ProbeResult) {
	if (exists(path.join(root, "gradlew"))) {
		r.ecosystems.push("gradle");
		set(r, "test", "./gradlew test", "gradlew");
		set(r, "build", "./gradlew build -x test", "gradlew");
	} else if (exists(path.join(root, "pom.xml"))) {
		r.ecosystems.push("maven");
		set(r, "test", "mvn -q test", "pom.xml");
		set(r, "build", "mvn -q -DskipTests package", "pom.xml");
	}
}

function detectRuby(root: string, r: ProbeResult) {
	if (!exists(path.join(root, "Gemfile"))) return;
	r.ecosystems.push("ruby");
	if (exists(path.join(root, "spec"))) set(r, "test", "bundle exec rspec", "Gemfile + spec/");
	else if (exists(path.join(root, "Rakefile"))) set(r, "test", "bundle exec rake test", "Gemfile + Rakefile");
	if (exists(path.join(root, ".rubocop.yml"))) set(r, "lint", "bundle exec rubocop", ".rubocop.yml");
}

/** Makefile targets fill any slot the ecosystems above left empty. */
function detectMake(root: string, r: ProbeResult) {
	const mk = readText(path.join(root, "Makefile")) ?? readText(path.join(root, "makefile"));
	if (!mk) return;
	const targets = new Set<string>();
	for (const m of mk.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) targets.add(m[1]);
	if (targets.size === 0) return;
	r.ecosystems.push("make");
	const map: Array<[CheckName, string[]]> = [
		["typecheck", ["typecheck", "check-types", "types"]],
		["lint", ["lint"]],
		["test", ["test", "tests", "check"]],
		["build", ["build"]],
		["format", ["format-check", "fmt-check"]],
	];
	for (const [name, candidates] of map) {
		const hit = candidates.find((t) => targets.has(t));
		if (hit) set(r, name, `make ${hit}`, `Makefile target "${hit}"`);
	}
}

/** Walk up from cwd to the nearest directory that looks like a project root. */
export function findProjectRoot(cwd: string): string {
	const markers = [
		".git",
		"package.json",
		"Cargo.toml",
		"go.mod",
		"pyproject.toml",
		"deno.json",
		"pom.xml",
		"gradlew",
		"Gemfile",
		"Makefile",
	];
	let dir = path.resolve(cwd);
	for (;;) {
		if (markers.some((m) => exists(path.join(dir, m)))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(cwd);
		dir = parent;
	}
}

export function probeProject(cwd: string): ProbeResult {
	const root = findProjectRoot(cwd);
	const r: ProbeResult = { root, ecosystems: [], checks: {}, notes: [] };
	detectNode(root, r);
	detectDeno(root, r);
	detectRust(root, r);
	detectGo(root, r);
	detectPython(root, r);
	detectJvm(root, r);
	detectRuby(root, r);
	detectMake(root, r);
	if (r.ecosystems.length === 0) r.notes.push("No recognized project files; no checks detected.");
	else if (Object.keys(r.checks).length === 0) r.notes.push("Project recognized but no runnable checks found.");
	return r;
}
