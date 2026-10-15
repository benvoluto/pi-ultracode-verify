/**
 * pi-ultracode-verify — repo-adaptive verification + workflows for pi-ultracode.
 *
 *  Tools
 *    project_checks   detect this repo's typecheck/lint/test/build/format commands
 *    verify           run them and return structured pass/fail with failure tails
 *
 *  Verify gate
 *    After a run that changed files, run the repo's checks; on failure, feed the failures back and
 *    continue automatically (bounded by gate.maxAttempts). /verify-gate on|off|status
 *
 *  Workflows (require pi-ultracode; enable with /ultracode)
 *    /uc-feature /uc-migrate /uc-audit /uc-bughunt /uc-review
 *    Each detects the repo's checks and launches the matching saved workflow with them as args,
 *    so verification inside workflows adapts to the repository.
 *
 *  Assets
 *    Agent roles (ucv-*) and saved workflows are synced into ~/.pi/ultracode/ on session start
 *    (never overwriting files you have taken ownership of). /ucv-sync to re-run.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type GateConfig, PROJECT_CONFIG_REL, type ResolvedChecks, USER_CONFIG, checksToMap, resolveChecks } from "./config.ts";
import { CHECK_NAMES, type CheckName } from "./probe.ts";
import { type CheckRunResult, formatResults, runChecks } from "./runner.ts";
import { syncAssets } from "./sync.ts";

const HERE = (() => {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		return __dirname;
	}
})();
const ASSETS_DIR = path.resolve(HERE, "..", "..", "assets");
const debug = (...a: unknown[]) => {
	if (process.env.PI_UCV_DEBUG === "1") console.error("[ucv]", ...a);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trusted(ctx: ExtensionContext): boolean {
	try {
		return ctx.isProjectTrusted();
	} catch {
		return false;
	}
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 15_000,
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch {
		return undefined;
	}
}

/** Hash of the working tree's changes, or undefined outside a git repo. */
function workingTreeFingerprint(cwd: string): string | undefined {
	if (git(cwd, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") return undefined;
	const status = git(cwd, ["status", "--porcelain=v1", "-uall"]) ?? "";
	const diff = git(cwd, ["diff", "HEAD", "--no-color", "--no-ext-diff"]) ?? git(cwd, ["diff", "--no-color"]) ?? "";
	// Include contents of untracked files (status alone would not change when they are edited again).
	const h = createHash("sha256").update(status).update(diff);
	for (const line of status.split("\n")) {
		if (!line.startsWith("?? ")) continue;
		try {
			const st = fs.statSync(path.join(cwd, line.slice(3)));
			h.update(`${line}:${st.size}:${st.mtimeMs}`);
		} catch {
			/* ignore */
		}
	}
	return h.digest("hex");
}

function hasCommit(cwd: string): boolean {
	return git(cwd, ["rev-parse", "--verify", "HEAD"]) !== undefined;
}

function selectEntries(resolved: ResolvedChecks, names: CheckName[]) {
	return names.filter((n) => resolved.checks[n]).map((n) => ({ name: n, command: resolved.checks[n]!.command }));
}

function describeChecks(resolved: ResolvedChecks): string {
	const lines = [`Project root: ${resolved.probe.root}`];
	lines.push(
		`Ecosystems: ${resolved.probe.ecosystems.join(", ") || "none"}${resolved.probe.packageManager ? ` (package manager: ${resolved.probe.packageManager})` : ""}`,
	);
	for (const n of CHECK_NAMES) {
		const c = resolved.checks[n];
		lines.push(c ? `- ${n}: \`${c.command}\`  (${c.source})` : `- ${n}: (none)`);
	}
	lines.push(
		`Verify gate: ${resolved.gate.enabled ? "enabled" : "disabled"}; runs [${resolved.gate.checks.join(", ")}]; max ${resolved.gate.maxAttempts} auto-fix attempts; ${resolved.gate.timeoutSeconds}s timeout per check`,
	);
	for (const note of resolved.probe.notes) lines.push(`Note: ${note}`);
	if (resolved.ignoredProjectConfig) {
		lines.push(`Note: ${resolved.ignoredProjectConfig} was ignored because this project is not trusted.`);
	}
	if (resolved.configFiles.length) lines.push(`Config: ${resolved.configFiles.join(", ")}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const ProjectChecksParams = Type.Object({});
const VerifyParams = Type.Object({
	checks: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Which checks to run: any of "typecheck","lint","test","build","format", or ["all"]. Default: the gate set (usually typecheck, lint, test).',
		}),
	),
	timeout_seconds: Type.Optional(Type.Number({ description: "Per-check timeout in seconds (default from config, 600)." })),
});

interface VerifyDetails {
	results: CheckRunResult[];
	root: string;
}

export default function ultracodeVerify(pi: ExtensionAPI) {
	// Session-scoped gate state.
	let sessionGateOverride: boolean | undefined;
	let baseline: string | undefined;
	let filesTouched = false;
	let attempts = 0;
	let gateRunning = false;

	const gateEnabled = (cfg: GateConfig) => (sessionGateOverride === undefined ? cfg.enabled : sessionGateOverride);

	// ---- assets -------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		if (process.env.PI_UCV_SYNC === "0") return;
		try {
			const r = syncAssets(ASSETS_DIR);
			const changed = r.written.length + r.updated.length;
			if (changed && ctx.hasUI) {
				ctx.ui.notify(`pi-ultracode-verify: installed/updated ${changed} agent/workflow file(s) in ~/.pi/ultracode`, "info");
			}
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`pi-ultracode-verify: asset sync failed: ${(err as Error).message}`, "warning");
		}
	});

	pi.registerCommand("ucv-sync", {
		description: "Install/update pi-ultracode-verify agent roles and workflows in ~/.pi/ultracode",
		handler: async (_args, ctx) => {
			const r = syncAssets(ASSETS_DIR);
			const parts = [
				`written ${r.written.length}`,
				`updated ${r.updated.length}`,
				`unchanged ${r.unchanged}`,
				`user-owned (left alone) ${r.skippedUserOwned.length}`,
			];
			ctx.ui.notify(`ucv-sync: ${parts.join(", ")}`, "info");
		},
	});

	// ---- tools ----------------------------------------------------------------
	pi.registerTool({
		name: "project_checks",
		label: "Project checks",
		description:
			"Detect this repository's verification commands (typecheck, lint, test, build, format) from its project files " +
			"(package.json, Cargo.toml, go.mod, pyproject, Makefile, ...). Use before verifying work, and pass the result " +
			"as `checks` to pi-ultracode workflows so subagents run the repo's real checks.",
		parameters: ProjectChecksParams,
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const resolved = resolveChecks(ctx.cwd, trusted(ctx));
			const map = checksToMap(resolved.checks);
			return {
				content: [
					{
						type: "text",
						text: `${describeChecks(resolved)}\n\nchecks (for workflow args): ${JSON.stringify(map)}`,
					},
				],
				details: { root: resolved.probe.root, checks: map, gate: resolved.gate },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("project_checks")), 0, 0);
		},
	});

	pi.registerTool({
		name: "verify",
		label: "Verify",
		description:
			"Run this repository's own verification commands (detected automatically; overridable in .pi/ultracode-verify.json) " +
			"and return structured pass/fail with the tail of each failure. Use after making changes instead of guessing commands.",
		parameters: VerifyParams,
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
		async execute(_id, params, signal, onUpdate, ctx) {
			const resolved = resolveChecks(ctx.cwd, trusted(ctx));
			const requested = params.checks?.length ? params.checks : resolved.gate.checks;
			const names: CheckName[] = requested.includes("all")
				? [...CHECK_NAMES]
				: requested.filter((n): n is CheckName => (CHECK_NAMES as readonly string[]).includes(n));
			const entries = selectEntries(resolved, names);
			if (entries.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No matching checks are available for this repository.\n\n${describeChecks(resolved)}`,
						},
					],
					details: { results: [], root: resolved.probe.root } as VerifyDetails,
				};
			}
			const timeoutMs = (params.timeout_seconds ?? resolved.gate.timeoutSeconds) * 1000;
			const results = await runChecks(entries, resolved.probe.root, timeoutMs, signal, (done, total, current) => {
				onUpdate?.({
					content: [{ type: "text", text: current ? `Running ${current} (${done + 1}/${total})…` : `Done (${total})` }],
					details: { results: [], root: resolved.probe.root },
				});
			});
			return {
				content: [{ type: "text", text: formatResults(results) }],
				details: { results, root: resolved.probe.root } as VerifyDetails,
				isError: results.some((r) => !r.ok),
			};
		},
		renderCall(args, theme) {
			const list = Array.isArray(args?.checks) && args.checks.length ? args.checks.join(", ") : "default";
			return new Text(theme.fg("toolTitle", theme.bold("verify ")) + theme.fg("accent", list), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const d = result.details as VerifyDetails | undefined;
			if (!d || d.results.length === 0) {
				const c = result.content[0];
				return new Text(theme.fg("dim", c?.type === "text" ? c.text.split("\n")[0] : "(no checks)"), 0, 0);
			}
			let text = d.results
				.map((r) =>
					r.ok
						? theme.fg("success", `✓ ${r.name}`)
						: theme.fg("error", `✗ ${r.name}${r.timedOut ? " (timeout)" : ""}`),
				)
				.join("  ");
			if (expanded) {
				for (const r of d.results.filter((x) => !x.ok)) {
					text += `\n${theme.fg("muted", `── ${r.name}: ${r.command}`)}\n${theme.fg("dim", r.tail.split("\n").slice(-25).join("\n"))}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});

	// ---- verify gate ------------------------------------------------------------
	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType === "user") {
			attempts = 0;
			filesTouched = false;
			baseline = workingTreeFingerprint(ctx.cwd);
		}
		// Teach the parent about repo-adaptive checks whenever pi-ultracode's workflow tool is active.
		const sections = (event as any).systemPromptOptions?.sections;
		if (sections && typeof sections === "object") {
			if (pi.getActiveTools().includes("workflow")) {
				sections.ultracode_verify = [
					"Repository verification (pi-ultracode-verify):",
					"- Call `project_checks` to learn this repo's real typecheck/lint/test/build commands; never guess them.",
					"- Subagents cannot call extension tools, so pass those commands into workflows via args (e.g. args.checks) and have tester agents (agentType \"ucv-tester\") run them with bash.",
					"- Saved workflows available by name: ucv-feature, ucv-migrate, ucv-audit, ucv-bughunt, ucv-review. Roles: ucv-planner, ucv-implementer, ucv-reviewer, ucv-refuter, ucv-tester.",
					"- After changing files, run `verify` before declaring the task done.",
				].join("\n");
			} else {
				delete sections.ultracode_verify;
			}
		}
	});

	pi.on("tool_execution_end", async (event) => {
		debug("tool_execution_end", event.toolName, event.isError);
		if (event.isError) return;
		if (["edit", "write", "workflow"].includes(event.toolName)) filesTouched = true;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		debug("before_settle", { outcome: event.outcome, gateRunning, filesTouched, canContinue: event.context?.canContinue });
		if (gateRunning || event.outcome !== "completed") return;
		const resolved = resolveChecks(ctx.cwd, trusted(ctx));
		if (!gateEnabled(resolved.gate)) return debug("gate disabled");

		const now = workingTreeFingerprint(ctx.cwd);
		const changed = filesTouched || (now !== undefined && now !== baseline);
		debug("changed?", { changed, baseline: baseline?.slice(0, 8), now: now?.slice(0, 8) });
		if (!changed) return;

		const entries = selectEntries(resolved, resolved.gate.checks);
		debug("entries", entries);
		if (entries.length === 0) return;

		gateRunning = true;
		let results: CheckRunResult[];
		try {
			if (ctx.hasUI) ctx.ui.setStatus("ucv", `verify: running ${entries.map((e) => e.name).join(", ")}…`);
			results = await runChecks(entries, resolved.probe.root, resolved.gate.timeoutSeconds * 1000, ctx.signal);
		} finally {
			gateRunning = false;
		}

		const failed = results.filter((r) => !r.ok);
		if (failed.length === 0) {
			attempts = 0;
			filesTouched = false;
			baseline = now;
			if (ctx.hasUI) {
				ctx.ui.setStatus("ucv", `verify: ✓ ${results.map((r) => r.name).join(", ")}`);
			}
			return {
				entries: [
					{
						type: "custom_message",
						customType: "ucv-gate",
						display: true,
						content: `Verify gate: ✓ ${results.length} check(s) passed (${results.map((r) => r.name).join(", ")}).`,
						details: { results },
					},
				],
			};
		}

		attempts++;
		if (ctx.hasUI) ctx.ui.setStatus("ucv", `verify: ✗ ${failed.map((r) => r.name).join(", ")} (attempt ${attempts})`);
		// Note: event.context.canContinue describes the context BEFORE our drafts (it ends with the assistant
		// reply, so it is false). Pi re-validates after committing our custom_message, which makes continuation valid.
		const canRetry = attempts <= resolved.gate.maxAttempts;
		const header = canRetry
			? `Verify gate: repository checks failed after your changes (auto-fix attempt ${attempts}/${resolved.gate.maxAttempts}). ` +
				"Fix the root cause in the code, then finish. Do not weaken, skip, or delete tests or checks to make them pass."
			: `Verify gate: repository checks are still failing after ${attempts - 1} auto-fix attempt(s); stopping automatic retries. ` +
				"Report the remaining failures to the user.";
		return {
			entries: [
				{
					type: "custom_message",
					customType: "ucv-gate",
					display: true,
					content: `${header}\n\n${formatResults(results)}`,
					details: { results },
				},
			],
			continue: canRetry,
		};
	});

	pi.registerCommand("verify-gate", {
		description: "Automatic post-change verification: /verify-gate on | off | status",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (a === "on") sessionGateOverride = true;
			else if (a === "off") sessionGateOverride = false;
			const resolved = resolveChecks(ctx.cwd, trusted(ctx));
			const state = gateEnabled(resolved.gate) ? "ON" : "OFF";
			const entries = selectEntries(resolved, resolved.gate.checks);
			ctx.ui.notify(
				`Verify gate ${state} for this session` +
					(entries.length ? ` — runs: ${entries.map((e) => `${e.name} (${e.command})`).join("; ")}` : " — no checks detected") +
					`. Persist with ${USER_CONFIG} or ${PROJECT_CONFIG_REL}.`,
				"info",
			);
		},
	});

	pi.registerCommand("uc-checks", {
		description: "Show this repository's detected verification commands and gate settings",
		handler: async (_args, ctx) => {
			const text = describeChecks(resolveChecks(ctx.cwd, trusted(ctx)));
			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else console.log(text);
		},
	});

	pi.registerCommand("verify", {
		description: "Run this repository's checks now and show the result to the agent (/verify [all|test|lint|...])",
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const resolved = resolveChecks(ctx.cwd, trusted(ctx));
			const names: CheckName[] = words.includes("all")
				? [...CHECK_NAMES]
				: words.length
					? words.filter((n): n is CheckName => (CHECK_NAMES as readonly string[]).includes(n))
					: resolved.gate.checks;
			const entries = selectEntries(resolved, names);
			if (!entries.length) {
				ctx.ui.notify("No matching checks detected. See /uc-checks.", "warning");
				return;
			}
			ctx.ui.notify(`Running ${entries.map((e) => e.name).join(", ")}…`, "info");
			const results = await runChecks(entries, resolved.probe.root, resolved.gate.timeoutSeconds * 1000, ctx.signal);
			await pi.sendUserMessage(`I ran the repository checks:\n\n${formatResults(results)}`);
			if (ctx.mode !== "tui") await ctx.waitForIdle(); // keep print/RPC runs alive until the agent finishes
		},
	});

	// ---- workflow commands -------------------------------------------------------
	const WORKFLOWS: Array<{
		command: string;
		workflow: string;
		description: string;
		argKey: "task" | "focus";
		required: boolean;
		extra?: (raw: string) => Record<string, unknown>;
		report: string;
	}> = [
		{
			command: "uc-feature",
			workflow: "ucv-feature",
			description: "Plan → parallel implement (worktrees) → repo checks + adversarial review → fix until green",
			argKey: "task",
			required: true,
			report:
				"units implemented, verification result per check, confirmed review findings and whether each was resolved, unresolved items, and any worktree delivery conflicts or recovery patches",
		},
		{
			command: "uc-migrate",
			workflow: "ucv-migrate",
			description: "Batch migration/refactor: per-unit implement → review → fix pipeline, then repo checks",
			argKey: "task",
			required: true,
			report: "units migrated per batch, units that failed review, whether the planner reported completion, and verification results",
		},
		{
			command: "uc-audit",
			workflow: "ucv-audit",
			description: "Fan-out audit with coverage tracking and refuted findings (read-only)",
			argKey: "focus",
			required: true,
			report: "confirmed findings grouped by severity with evidence, coverage (covered/uncovered targets, omitted scope), and refuted count",
		},
		{
			command: "uc-bughunt",
			workflow: "ucv-bughunt",
			description: "Loop-until-dry bug hunt with independent confirmation (add --fix to fix + verify)",
			argKey: "focus",
			required: false,
			extra: (raw) => (/(^|\s)--fix(\s|$)/.test(raw) ? { fix: true } : {}),
			report: "confirmed bugs with evidence, whether the search ran dry, and (if fixing) verification results",
		},
		{
			command: "uc-review",
			workflow: "ucv-review",
			description: "Adversarial review of current changes: parallel lenses + repo checks + refutation (read-only)",
			argKey: "focus",
			required: false,
			report: "check results, confirmed findings with evidence (by severity), refuted findings, and unverified minor notes",
		},
	];

	for (const wf of WORKFLOWS) {
		pi.registerCommand(wf.command, {
			description: `${wf.description} (requires /ultracode)`,
			handler: async (raw, ctx) => {
				const text = raw.replace(/(^|\s)--fix(\s|$)/g, " ").trim();
				debug(`/${wf.command}`, { raw, mode: ctx.mode });
				if (wf.required && !text) {
					ctx.ui.notify(`Usage: /${wf.command} <${wf.argKey === "task" ? "what to build/change" : "what to audit for"}>`, "warning");
					return;
				}
				const resolved = resolveChecks(ctx.cwd, trusted(ctx));
				const checks = checksToMap(resolved.checks);
				const gateChecks: Record<string, string> = {};
				for (const n of resolved.gate.checks) if (checks[n]) gateChecks[n] = checks[n];
				const wfArgs: Record<string, unknown> = { [wf.argKey]: text, checks: gateChecks, ...(wf.extra?.(raw) ?? {}) };
				if (wf.workflow === "ucv-feature" || wf.workflow === "ucv-migrate") {
					wfArgs.useWorktrees = hasCommit(resolved.probe.root);
				}
				if (!pi.getAllTools().some((t) => t.name === "workflow")) {
					ctx.ui.notify("pi-ultracode is not installed. Run: pi install npm:pi-ultracode", "error");
					return;
				}
				await pi.sendUserMessage(
					[
						`Run the saved pi-ultracode workflow "${wf.workflow}" now by calling the \`workflow\` tool with name "${wf.workflow}" and exactly these args:`,
						"```json",
						JSON.stringify(wfArgs, null, 2),
						"```",
						"Do not rewrite it as an inline script and do not do the work yourself first.",
						"If the `workflow` tool is not available to you, stop and tell me to enable it with /ultracode.",
						`When it finishes, report: ${wf.report}.`,
					].join("\n"),
				);
				if (ctx.mode !== "tui") await ctx.waitForIdle(); // keep print/RPC runs alive until the workflow finishes
			},
		});
	}
}
