/**
 * Runs check commands and returns structured results with a bounded output tail.
 */

import { spawn } from "node:child_process";

export interface CheckRunResult {
	name: string;
	command: string;
	ok: boolean;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	/** Last lines of combined stdout/stderr (bounded). */
	tail: string;
}

const TAIL_LINES = 80;
const TAIL_BYTES = 8 * 1024;

export function tailOf(text: string, lines = TAIL_LINES, bytes = TAIL_BYTES): string {
	let t = text.split("\n").slice(-lines).join("\n");
	if (Buffer.byteLength(t, "utf8") > bytes) t = t.slice(-bytes);
	return t.trim();
}

export function runCommand(
	name: string,
	command: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<CheckRunResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		let out = "";
		let timedOut = false;
		let settled = false;
		const child = spawn("/bin/sh", ["-c", command], {
			cwd,
			env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true, // own process group so we can kill the whole tree
		});
		const killTree = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
			setTimeout(() => {
				try {
					if (child.pid) process.kill(-child.pid, "SIGKILL");
				} catch {
					/* already gone */
				}
			}, 3000).unref();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, timeoutMs);
		const onAbort = () => killTree();
		signal?.addEventListener("abort", onAbort, { once: true });

		const cap = (d: Buffer) => {
			out += d.toString();
			if (out.length > 4 * 1024 * 1024) out = out.slice(-1024 * 1024); // keep memory bounded
		};
		child.stdout.on("data", cap);
		child.stderr.on("data", cap);

		const finish = (code: number | null, extra = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({
				name,
				command,
				ok: code === 0 && !timedOut,
				exitCode: code,
				timedOut,
				durationMs: Date.now() - started,
				tail: tailOf(out + extra) || "(no output)",
			});
		};
		child.on("error", (err) => finish(null, `\n${err.message}`));
		child.on("close", (code) => finish(code, timedOut ? `\n[timed out after ${Math.round(timeoutMs / 1000)}s]` : ""));
	});
}

/** Run checks sequentially (they often share build caches/ports); never fail-fast so all failures are visible. */
export async function runChecks(
	entries: Array<{ name: string; command: string }>,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	onProgress?: (done: number, total: number, current?: string) => void,
): Promise<CheckRunResult[]> {
	const results: CheckRunResult[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (signal?.aborted) break;
		onProgress?.(i, entries.length, entries[i].name);
		results.push(await runCommand(entries[i].name, entries[i].command, cwd, timeoutMs, signal));
	}
	onProgress?.(results.length, entries.length);
	return results;
}

export function formatResults(results: CheckRunResult[], includeTailForPassing = false): string {
	if (results.length === 0) return "No checks were run.";
	const lines: string[] = [];
	for (const r of results) {
		const status = r.ok ? "PASS" : r.timedOut ? "TIMEOUT" : "FAIL";
		lines.push(`## ${status} ${r.name} — \`${r.command}\` (exit ${r.exitCode ?? "n/a"}, ${(r.durationMs / 1000).toFixed(1)}s)`);
		if (!r.ok || includeTailForPassing) lines.push("```", r.tail, "```");
	}
	const failed = results.filter((r) => !r.ok).length;
	lines.unshift(failed === 0 ? `All ${results.length} checks passed.` : `${failed}/${results.length} checks failed.`, "");
	return lines.join("\n");
}
