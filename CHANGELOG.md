# Changelog

## 0.1.0 (2026-10-15)

### Features

* Repo-adaptive check detection (`project_checks`) for Node (npm/pnpm/yarn/bun), Deno, Rust, Go, Python (uv/poetry/pipenv), Gradle/Maven, Ruby, and Makefile projects, with user/project overrides (`.pi/ultracode-verify.json`, project file honored only when trusted).
* `verify` tool and `/verify` command that run the detected checks and return structured pass/fail with bounded failure output.
* Verify gate: after a run that changed files, runs the repo's checks and auto-continues with the failures, bounded by `gate.maxAttempts`.
* Saved pi-ultracode workflows `ucv-feature`, `ucv-migrate`, `ucv-audit`, `ucv-bughunt`, `ucv-review` and commands `/uc-feature`, `/uc-migrate`, `/uc-audit`, `/uc-bughunt`, `/uc-review` that pass the detected checks into the workflow.
* Agent roles `ucv-planner`, `ucv-implementer`, `ucv-reviewer`, `ucv-refuter`, `ucv-tester`, synced into `~/.pi/ultracode/` without overwriting user-owned files.
