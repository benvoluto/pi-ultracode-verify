# pi-ultracode-verify

Repo-adaptive verification for [Pi](https://pi.dev) and [pi-ultracode](https://pi.dev/packages/pi-ultracode).

pi-ultracode supplies the multi-agent engine: `agent()`, `parallel()`, `pipeline()`, worktrees, structured output, and resume. This package adds the parts it leaves to you:

| | |
|---|---|
| **Repo-adaptive checks** | Detects each repository's real typecheck / lint / test / build / format commands (Node via npm/pnpm/yarn/bun, Deno, Rust, Go, Python via uv/poetry/pipenv, Gradle/Maven, Ruby, Makefile). Nothing is hard-coded per project. |
| **Verify gate** | After any run that changed files, Pi runs those checks automatically. If they fail, the failures are fed back and the agent continues fixing, up to 3 attempts. |
| **Ready-made workflows** | `/uc-feature`, `/uc-migrate`, `/uc-audit`, `/uc-bughunt`, `/uc-review`. Each passes the detected checks into the workflow, so the tester subagents run *this repo's* commands. |
| **Agent roles** | `ucv-planner`, `ucv-implementer`, `ucv-reviewer`, `ucv-refuter`, `ucv-tester`, each with a tool allowlist matched to its job. |

## Install

```bash
pi install npm:pi-ultracode            # the workflow engine (required for /uc-* workflows)
pi install /path/to/pi-ultracode-verify  # or: pi install git:github.com/<owner>/pi-ultracode-verify
```

Restart Pi (or `/reload`). On session start, the roles and workflows are copied into
`~/.pi/ultracode/{agents,workflows}`, where pi-ultracode discovers them.

## Use

```
/ultracode                         # enable pi-ultracode (needed for the /uc-* workflows)
/uc-checks                         # show what was detected for this repo
/uc-feature add rate limiting to the public API
/uc-migrate replace moment with date-fns across the codebase
/uc-audit SQL injection and missing authorization checks
/uc-bughunt src/billing --fix
/uc-review                         # review uncommitted changes / the branch
/verify [all|test|lint|...]        # run checks now
/verify-gate on|off|status
```

You can also just describe the task. With `/ultracode` on, the model is told about `project_checks`,
`verify`, and the `ucv-*` workflows and roles, and can choose them on its own.

### Workflows

| Command | Pattern | Agents (dynamic) | Writes code? |
|---|---|---|---|
| `/uc-feature` | plan → parallel implement (worktrees) → checks + adversarial review → refute → fix loop | 1 planner + 1–8 implementers (planner decides) + tester + reviewer + ≤6 refuters + fix rounds | yes |
| `/uc-migrate` | batched loop-until-done; each unit goes implement → review → fix as a pipeline; then checks + fix loop | per batch: planner + up to 6 units × 3 stages; ≤3 batches | yes |
| `/uc-audit` | scope → one reviewer per target → refute → coverage report | scout + ≤12 auditors + ≤10 refuters | no |
| `/uc-bughunt` | finders until 2 dry rounds → independent confirmation (may reproduce with tests); `--fix` adds fix + verify | 3 finders/round + ≤6 confirmers/round, ≤4 rounds | only with `--fix` |
| `/uc-review` | 4 review lenses + checks in parallel → refute every significant finding | 5 + ≤10 refuters | no |

The design follows the dynamic-workflow principles:
- Work is split so no single context has to hold everything.
- Code is always judged by an agent that didn't write it.
- Each agent gets a short, freshly restated goal.

### Verify gate

- Runs only when the agent's run **changed files**. This is detected from edit/write/workflow tool calls and from a git working-tree fingerprint.
- By default it runs `typecheck`, `lint` and `test`, whichever exist. `build` and `format` are excluded by default because they are slow or noisy.
- When checks fail, it appends the failure tails and continues the run, up to `maxAttempts` (3). After that it stops and asks the agent to report the remaining failures.
- `/verify-gate off` turns it off for the session, and `PI_UCV_GATE=0` turns it off entirely.

## Configuration (optional)

`~/.pi/agent/ultracode-verify.json` (user) and `<repo>/.pi/ultracode-verify.json` (project):

```json
{
  "checks": { "test": "pnpm vitest run --reporter=dot", "build": null },
  "gate": { "enabled": true, "maxAttempts": 3, "checks": ["typecheck", "lint", "test"], "timeoutSeconds": 600 }
}
```

A string replaces the detected command, and `null` disables that check. The **project file is only read when the
project is trusted**, because it can define arbitrary shell commands.

Detected commands are built only from fixed strings. Repo text such as script bodies and target names is never
interpolated into a shell command. Running a repo's test script still executes that repo's code, just as it would
if the agent ran it.

| Env var | Effect |
|---|---|
| `PI_UCV_GATE=0` | disable the verify gate |
| `PI_UCV_SYNC=0` | don't copy roles/workflows into `~/.pi/ultracode` |
| `PI_UCV_DEBUG=1` | log gate decisions to stderr |

## Customizing roles and workflows

The installed files in `~/.pi/ultracode/` carry a `managedBy: pi-ultracode-verify` marker and are updated when the
package updates. To customize one, **delete the marker line**. From then on it belongs to you and is never
overwritten. You can also add your own `.md` roles and `.workflow.js` files there. Project-level copies in
`<repo>/.pi/ultracode/` take precedence in trusted projects.

## Notes and limitations

- **Subagents can't call extension tools.** pi-ultracode runs subagents with extensions disabled, so
  workflows receive the check commands as `args.checks` and `ucv-tester` runs them with bash.
- **Worktrees** are used for parallel writers when the repo has at least one commit. Isolated worktrees don't share
  `node_modules`, so final checks run after the patches are integrated. A clean working tree gives the most predictable integration.
- **One-shot print mode** (`pi -p "/uc-feature ..."`): with pi-ultracode loaded, messages sent from extension
  commands don't start a run in print mode. Use the interactive TUI or RPC mode (both work), or ask in plain
  language in print mode.
- Monorepos: root-level scripts are used. Override per-package commands in `.pi/ultracode-verify.json`.

## Development

```bash
npm test   # unit tests (detection, config, runner, sync, workflow invariants)
           # + validates every workflow with pi-ultracode's own parser
```

Workflow-script rule of thumb (enforced by pi-ultracode's static checks): call `agent()` / `parallel()` / `pipeline()`
directly, and use helper functions only to build prompts and options. Don't wrap `agent()` in async helpers, and don't
push orchestration thunks into arrays.

## License

MIT
