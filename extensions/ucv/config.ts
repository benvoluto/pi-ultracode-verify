/**
 * Configuration: detected checks + optional overrides.
 *
 *   ~/.pi/agent/ultracode-verify.json   user defaults (always read)
 *   <root>/.pi/ultracode-verify.json    project overrides (read only when the project is trusted,
 *                                       because it can define arbitrary shell commands)
 *
 * {
 *   "checks": { "test": "pnpm vitest run", "build": null },   // string = override, null = disable
 *   "gate":   { "enabled": true, "maxAttempts": 3, "checks": ["typecheck","lint","test"], "timeoutSeconds": 600 }
 * }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHECK_NAMES, type CheckName, type DetectedCheck, type ProbeResult, probeProject } from "./probe.ts";

export interface GateConfig {
	enabled: boolean;
	maxAttempts: number;
	checks: CheckName[];
	timeoutSeconds: number;
}

export interface ResolvedChecks {
	probe: ProbeResult;
	checks: Partial<Record<CheckName, DetectedCheck>>;
	gate: GateConfig;
	/** A project config file existed but was ignored because the project is not trusted. */
	ignoredProjectConfig?: string;
	configFiles: string[];
}

export const DEFAULT_GATE: GateConfig = {
	enabled: true,
	maxAttempts: 3,
	checks: ["typecheck", "lint", "test"],
	timeoutSeconds: 600,
};

export const USER_CONFIG = path.join(os.homedir(), ".pi", "agent", "ultracode-verify.json");
export const PROJECT_CONFIG_REL = path.join(".pi", "ultracode-verify.json");

function readConfig(file: string): any | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

const isCheckName = (v: unknown): v is CheckName => typeof v === "string" && (CHECK_NAMES as readonly string[]).includes(v);

function applyConfig(cfg: any, label: string, checks: ResolvedChecks["checks"], gate: GateConfig) {
	if (!cfg || typeof cfg !== "object") return;
	if (cfg.checks && typeof cfg.checks === "object") {
		for (const [k, v] of Object.entries(cfg.checks)) {
			if (!isCheckName(k)) continue;
			if (v === null || v === false) delete checks[k];
			else if (typeof v === "string" && v.trim()) checks[k] = { command: v.trim(), source: label };
		}
	}
	const g = cfg.gate;
	if (g && typeof g === "object") {
		if (typeof g.enabled === "boolean") gate.enabled = g.enabled;
		if (Number.isInteger(g.maxAttempts) && g.maxAttempts >= 0 && g.maxAttempts <= 10) gate.maxAttempts = g.maxAttempts;
		if (Array.isArray(g.checks)) gate.checks = g.checks.filter(isCheckName);
		if (typeof g.timeoutSeconds === "number" && g.timeoutSeconds > 0) gate.timeoutSeconds = Math.min(g.timeoutSeconds, 7200);
	}
}

export function resolveChecks(cwd: string, projectTrusted: boolean): ResolvedChecks {
	const probe = probeProject(cwd);
	const checks: ResolvedChecks["checks"] = { ...probe.checks };
	const gate: GateConfig = { ...DEFAULT_GATE, checks: [...DEFAULT_GATE.checks] };
	const configFiles: string[] = [];

	const user = readConfig(USER_CONFIG);
	if (user) {
		applyConfig(user, "user config", checks, gate);
		configFiles.push(USER_CONFIG);
	}

	let ignoredProjectConfig: string | undefined;
	const projectFile = path.join(probe.root, PROJECT_CONFIG_REL);
	const project = readConfig(projectFile);
	if (project) {
		if (projectTrusted) {
			applyConfig(project, "project config", checks, gate);
			configFiles.push(projectFile);
		} else {
			ignoredProjectConfig = projectFile;
		}
	}

	if (process.env.PI_UCV_GATE === "0") gate.enabled = false;
	return { probe, checks, gate, ignoredProjectConfig, configFiles };
}

/** Plain { name: command } map — the shape passed to workflows as args.checks. */
export function checksToMap(checks: ResolvedChecks["checks"]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of CHECK_NAMES) {
		const c = checks[name];
		if (c) out[name] = c.command;
	}
	return out;
}
