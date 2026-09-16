# Changelog

## [0.2.0] — M2: execution layer (delete / staging / elevation)

### Added

- **Execution engine**: `src/executor/` — safety gate (`safety.ts`), delete (`delete.ts`), staging area (`trash.ts`), elevation (`elevate.ts`), orchestration (`index.ts`).
- **Tool actions**: `apply` and `trash` are now implemented; new parameters `mode` (`permanent` / `trash`), `trashPath`, `dryRun`, and `elevation` (`none` / `dism` / `cleanmgr` / `dism+cleanmgr`).
- **Safety gate (hard constraints)**: protection list (including `overridable: false`), drive roots and critical directories such as `C:\Users`, junctions and symlinks, paths with a junction ancestor, non-system-drive paths, missing paths, and paths absent from the rule library are all refused with a displayable reason.
- **Delete engine**: measure before → recursive delete → verify what remains; files locked by running apps are reported as "partial" with residual bytes; permission failures are identified separately for the elevation path.
- **Staging area**: cross-volume moves (same-volume rename, otherwise copy-then-delete); **same-volume staging is refused outright** because it frees nothing; every move appends a JSONL ledger entry for M3 rollback, and a failed move writes none.
- **UAC elevation path**: tasks are generated as a PowerShell script (`%TEMP%\dsh-cc-elevated-*.ps1`) and run via `Start-Process -Verb RunAs`, with the log collected back; refusing the prompt is reported as `elevation-canceled` instead of a fake success. Built-in task builders cover directory removal, DISM `StartComponentCleanup`, and cleanmgr `sagerun`.
- **Execution report**: `C盘清理执行报告-<timestamp>.md` with per-item results, both released-space metrics, refusal reasons, and the elevation log tail.
- **Dry run by default**: `dryRun` defaults to `true`, and the caution tier may not be selected as a batch — it requires explicit per-item `items`.
- **Config**: new `defaultDeleteMode` (defaults to `trash`), `trashPath`, and `allowExplicitUnmatched` (defaults to `false`).
- **Tests**: `tests/m2-execute.ts` (`npm run m2`), 14 isolated cases; real deletions/moves happen only inside the `%TEMP%` sandbox and a dedicated test staging root.

### Fixed

- **Drive-letter comparison bug** (would have made every real `apply` refuse all targets as "out of scope"): `normalizePath('C:\\')` yields `c:` while `normalizePath('C')` yields `c`, so the comparison could never match. Both sides are now reduced to a single drive letter, and the drive-root check runs before the absolute-path check.
- **Rule-library path resolution**: the loader used to take the first candidate path while `tsc` does not copy JSON, so loading the compiled artifact from the host hit `ENOENT`; candidates are now probed for actual existence.
- **Released-space accounting**: added a per-item measured total so small cleanups are not reported as "0 bytes" just because other processes kept writing to the drive.

### Known limitations

- Admin-level cleanup depends on the UAC prompt (DSH has no UAC primitive).
- Cache files locked by running applications cannot be deleted; they are reported as "partial".
- `migrate` / `rollback` remain `not-implemented` (M3).

## [0.1.0] — M1: read-only scanning and five-tier grading

### Added

- **Plugin skeleton**: named exports `name` / `inject` / `Config` / `apply` (no default, so the Loader cannot unwrap away `inject`); declares `dsh.bundle.patch` so `dsh plugin add` can activate it as a profile layer.
- **`disk_cleanup` tool**: `action` vocabulary `scan` / `plan` / `apply` / `migrate` / `rollback` / `trash`; M1 implements the read-only `scan` / `plan`, while the rest return `not-implemented` inside a successful result rather than throwing.
- **Rule library**: 101 path rules plus 6 long-term prevention actions, all written with `%LOCALAPPDATA%`-style placeholders and no hardcoded user names; covers caches, temp files, leftover installers, IDE indexes, on-device browser AI models, package repositories, WinSxS, virtual disks, chat data, and more.
- **Scanner**: drive info (`fs.statfs`, no external commands), rule hotspots, whole-drive Top-N directories, junction/symlink-safe measurement (never followed, never double counted), time budgets with a `partial` flag, and `AbortSignal` cancellation.
- **Classifier**: five tiers (🟢 safe / 🟡 caution / 🟠 migrate / 🔴 protected / 🔵 long-term prevention); priority is "most specific path wins, `protected` wins ties"; anything unmatched is treated as protected.
- **Planner and report**: plan construction (with automatic migration-target selection) and a visual Markdown report (summary → 🟥 biggest consumers → five tiers → results).
- **Tests**: `tests/smoke.ts` fast self-check (rule matching 7/7); `tests/tool-run.ts` headless end-to-end through the real `defineTool` definition and `output.render`.

### Safety

- Entries marked `overridable: false` in the protection list are a **hard constraint**; user rules may not override them unless `allowProtectedOverride` is explicitly enabled.
- The tool forwards `exec.signal`, so long scans can be cancelled by the caller.
- A truncated scan is explicitly flagged `partial` in both the report and the tool result — never a silently incomplete verdict.
- Unrecognized paths are never deleted.

### Known limitations

- `apply` / `migrate` / `rollback` / `trash` are not implemented yet (M2 / M3).
- No staging area (recycle-bin-style) or UAC elevation execution path yet (M2).
- The report is delivered as a Markdown file; interactive GUI cards are planned for M4.
