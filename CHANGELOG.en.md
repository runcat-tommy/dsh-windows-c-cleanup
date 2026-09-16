# Changelog

## [0.5.1] — Bilingual panel + grouped toolbar and preview help

### Added

- **Bilingual UI** (follows the DSH locale; there is no manual switch):
  - Client dictionary `client/src/i18n.ts` with 112 keys per language. The slot registers `locale: 'windows-c-cleanup'` so the framework injects the `t` seat, and the tab label is a **thunk**, so a locale switch retitles the tab without re-registering anything.
  - **Host text is bilingual too**: every panel RPC carries `locale`, so rule reasons (`src/rules/default-rules.en.json`, aligned with Chinese strictly by rule id), all 12 safety-gate refusals, the executor's per-item planned actions, migration config hints and the scheduler status all come back in the requested language.
  - **Chinese stays the default**: the model tool path never passes `locale`, so its output is unchanged; a missing English entry falls back to the Chinese original and never renders an empty string.
  - Switching the language needs a page refresh only — no `dsh web` restart.
- **A `?` help button next to "Preview"** that explains in place what a preview is, in deliberately plain words (its first line is "runs a dry run — nothing is deleted").

### Changed

- **The toolbar is regrouped so related controls sit together**: ① Scope + Scan C: → ② "n selected" + Clear selection → ③ Delete mode + Preview + `?` + Confirm and run.
- **Affordance of the three action buttons**: "Scan C:", "Clear selection" and "Preview" now use a thick brand-coloured outline, a tinted fill, a drop shadow and semi-bold text **while enabled** (the tint is mixed with theme tokens via `color-mix`, so dark themes work too). Every prominent rule is scoped to `:not(:disabled)`, so the **disabled state keeps the original flat look** — a button you cannot press must never look pressable (checks 7.1–7.3 and 7.8).
- **The `?` help icon is more prominent**: a 19px thin hollow circle became a 24px round button (2px brand outline, tinted fill, 15px bold question mark, grows on hover).
- **The help copy is plainer and shorter**: the old "four technical bullets + never-does list + why bother" became three bullets (it really checks what may be deleted / it really counts permissions and space / it says what would happen to each item) plus two caveats in plain words. Chinese body 141 characters, English 452 (checks 7.5–7.7 cap the length and bullet count so it cannot creep back up).
- **`panelState.scheduler` is now structured** (`{enabled, running, intervalHours, alertFreePercent}`): the host no longer pushes Chinese sentences into the UI; the panel composes the wording per locale.

### Tests

- `npm run m5` gains section 10 (12 checks): English coverage (all 101 rules + 6 long-term actions, ids strictly aligned), no Han characters in the English file, same id differs per language, Chinese remains the default, missing entries fall back, English safety-gate refusals, locale passed through the RPC endpoint, whether every rule seen in the last scan has an English version, `%placeholder%` tokens never dropped, and elevation wording never dropped in translation.
- `npm run m5:client` gains sections 5–7 (29 checks): identical key sets across dictionaries, no Chinese inside English values, placeholder interpolation, the slot declaring its locale namespace, a thunked tab label, a real render in both locales, rendering without a `t` seat, every call carrying a locale, the three toolbar groups and button order, and the help button's presence plus expanded state; locale-service wiring order (wait for readiness, and the same thunk switching to English immediately); and the affordance rules (prominent styling only while enabled, disabled state untouched, all three buttons carrying it, help-copy length and bullet caps).

## [0.5.0] — M5: Web GUI cleanup panel

### Added

- **Client half**: the package declares `exports["./client"]` plus `dsh.client = { platform: "web" }`, and `client/client.js` is bundled by esbuild into a classic script whose only top-level statement is `window.__ModuleLoader__.load({ id: <package name>, factory })` (the `id` must equal the package name). React comes from the shell's module-table seed, so `react` / `react/jsx-runtime` stay external — bundling them would create two React copies and break hooks.
- **The panel lives in `conversation.view`**, an additive `list` slot (`replaceRisk: none`), so it adds a tab to the conversation view ring instead of replacing or destroying anything. Slots such as `root` / `sidebar` / `conversation` / `details` are single-occupant and would destroy descendant seats, so they are deliberately avoided.
  - Five-tier cards (🟢 / 🟡 / 🟠 / 🔴 plus 🔵 long-term protections) showing path, size and the reason for each verdict; protected entries cannot be selected;
  - **Two-step execution**: the confirm button unlocks only after a preview, any change to the selection or mode invalidates that preview, and permanent deletion needs an extra confirmation tick;
  - Real progress (bar plus per-item state) with a working "cancel job"; the migration preview shows source → destination, file count and whether the target volume has room; the header carries the historical trend and which directories grew back.
- **Host-side panel service** `src/panel/service.ts`: scan, preview, execute, migrate, roll back, progress, cancel, history, ledger. **Preview and the real run call the same `executeCleanup`** (only `dryRun` differs), so the GUI and tool paths cannot diverge. Jobs live in host memory (cleared on restart) and are capped at 20, with `disposePanelJobs()` releasing them on unload.
- **Panel-private RPC** `src/panel/rpc.ts`: the generic Connection channel `/dsh-c-cleanup` (`authority: loopback`, local callers only) returning strict `RpcResult` values — business failures become `{ok:false,error:{code:'internal',…}}` and never throw. `ctx.inject(['connection'])` waits softly, and on a CLI host without that service the plugin only logs a line while the tool surface keeps working.

### Changed

- **The executor gained an `onItem` callback**: every result that lands in the table is reported once (including re-reported entries after elevation rewriting), so the panel's per-item progress comes from real accounting rather than parsed log text.

### Tests

- `npm run m5` (42 checks): tiering, protected targets refused at preview time, preview == execute path, real staging-area deletion, real migration with ledger, cancel semantics, lossless JSON for every payload, the RPC endpoint table and `RpcResult` shapes, and graceful degradation on a host without `connection`.
- `npm run m5:client` (17 checks, offline): replays the browser module load (`__ModuleLoader__.load` → factory materialization), verifying that the registration key equals the package name, that only seed-table members are `require`d, that `apply`/`inject` are exported, that the panel registers into `conversation.view`, and that it really renders once using a minimal React stand-in.

## [0.4.2] — drive-root concatenation fixed structurally, plus a report-directory field correction

### Fixed

- **String-built drive roots bit us a third time, so this is now fixed structurally.** Measured in the host: an `apply` dry run reported "system drive C: **0.00 GB** free". The cause was `` const root = `${systemDrive}\\` `` in the executor — inside a template literal `\\` is a single backslash, so it built **`C\` (the colon was lost)**, `fs.statfs` threw `ENOENT`, the catch swallowed it and returned 0, and the report turned "unreadable" into "0.00 GB".
  The same missing colon made the recycle-bin check (`` `${systemDrive.toLowerCase()}\\$recycle.bin` `` → `c\$recycle.bin`) never match the real `c:\$recycle.bin`, so that special branch **silently stopped working**.
  This is the third instance of the same class of bug (M3 had `D::\`, this one is `C\` twice), so instead of patching call sites again, `src/util/drive.ts` now owns `driveRoot()` / `driveLetterOf()` / `sameDrive()`, and the executor, scanner, migrator and tool all go through it.
- **Zero no longer masquerades as "unknown"**: `freeSpaceOf()` normalizes its input, retries once and logs a warning; the report prints "unknown (statfs failed)" instead of 0.00 GB; and the tool falls back to the drive free space from the scan when the measurement fails — never a fabricated number.
- **Report directory field corrected**: 0.4.1 read `exec.agent.session.meta.cwd`, which resolves to nothing (so it silently fell back to the host cwd). The real field is `session.header.cwd` (dsh-session's `SessionHeader`); the plugin now reads that, keeping `meta` as a fallback.

### Tests

- `npm run m2` gains 2.2a: the dry-run output's system-drive free space must be a real number (a returning missing colon turns this red immediately).
- `npm run m4` gains 10.1–10.5: `C` / `C:` / `c:\` / `C:\` / padded / bare letters all normalize to `X:\`, and a normalized `freeSpaceOf` reads a real > 0 figure; 9.2a covers the `session.meta.cwd` fallback.

## [0.4.1] — fixes found by running in the real host (lossless JSON output / report directory)

### Fixed

- **Host output validation failed with `value is not lossless JSON`** (caught live, not inferred). A first-ever scan has no previous baseline, so `trend` was `undefined` and the output carried a key whose value is `undefined`. DSH judges lossless JSON with `snapshotJsonValue`, which rejects nested `undefined`, non-finite numbers, sparse arrays and exotic prototypes — so the **entire call was rejected** (the scan itself had already completed and reached the history; only its result could not come back).
  Fix: the M4 optional fields now go through `optionalFields()`, which **includes only keys that have a value**; checks 8.x (an `isLossless` round-trip check, the first-scan case, and empty-alert omission) lock the contract down. Source reference: `@deepseek-ai/dsh-tools` snapshots and validates the returned lossless JSON and throws `value is not lossless JSON` on failure.
- **The default report directory is now the session working directory**: the host's `process.cwd()` is the user's home directory, so reports landed in `C:\Users\<you>\`. The plugin now prefers `exec.agent.session.meta.cwd` and falls back to the host cwd only when it is unavailable; no missing link can make the call fail (checks 9.1–9.4 cover all four cases).

## [0.4.0] — M4: polish (history trend / JSON report / scheduled scans and alerts)

### Added

- **History trend** `src/history/index.ts`: every scan appends one JSONL record to `<DSH_HOME>/windows-c-cleanup/history.jsonl` and is compared against the previous scan — free/used delta, **directories that grew back** (>100 MB), directories that were released, and big items that appeared or were no longer measured. This targets what was measured on this machine: ~11 GB grew back after one cleanup round (WXWork upgrade 1.93 GB, `%TEMP%` 1.47 GB, WPS add-ons 1.97 GB, Chrome ~0.8 GB, uv 327 MB).
- **JSON report** `src/report/json.ts`: `format=json|both` writes a machine-readable report versioned as `schema: dsh-windows-c-cleanup/report@1` for GUIs, scripts and monitoring; Markdown and JSON can be produced together (a `reportPath` ending in `.md` yields a sibling `.json`).
- **Scheduled scans and alerts** `src/scheduler/`: with `config.schedule.enabled=true` (**off by default**) the plugin scans on an interval (default scope `hotspots`) and records an alert when free space drops below `alertFreePercent` (default 10%), also emitted through `ctx.logger`.
  Host fact: cordis exposes `ctx.logger` / `ctx.effect` but **no timer service**, so this uses Node timers with `unref()` and `ctx.effect` for disposal.
- **Four protections that keep the host safe**: single-flight (a still-running round makes the next one skip), a first-run delay (1 minute by default so startup I/O is not contended), a whole-round try/catch (failures only log), and `unref()` (the timer never blocks process exit).
- **Reports and tool output**: the Markdown report gains "🔔 Alerts" and "📈 History trend" sections; the tool output gains `historyPath`, `reportJsonPath`, `trend`, `alerts` and `schedule`.
- **Config**: `historyPath`, `defaultReportFormat`, `schedule.enabled/intervalHours/alertFreePercent/initialDelayMinutes/scope`.
- **Tests**: `npm run m4` (33 checks: scheduling semantics with a fake scan plus one real hotspot scan wired through the trend) and `npm run m4:live` (a **real disk scan** end to end, comparing the history's free-space figure against `fs.statfs`).

### Fixed

- **Alert records were overwritten into scan records**: in `toAlertEntry` the `...input` spread came after `kind: 'alert'`, so the scan entry's `kind: 'scan'` won and alerts could never be filtered out (caught by checks 3.1/3.3). The spread now comes first.
- **History id did not match the plan id**: history used a scan timestamp while plans used `plan-<timestamp>`, so a trend lookup could not find its own record and compared against the wrong baseline. The history id is now `plan.id`, giving one identity across plan, report file name and history.
- **Double extension on the JSON report path**: passing `x.json` as `reportPath` produced `x.json.json`; `.md`, `.json` and other suffixes are now handled separately.

### Known limitations

- **Scheduled scans are off by default**: they consume background disk I/O, which needs explicit user consent.
- **Trends compare the intersection of paths**: when a scan is truncated, "present last time, absent now" does not mean "cleaned" — the report notes `previousPartial`.
- **The history file lives under `<DSH_HOME>`**: deliberately outside the caches being cleaned, so it cannot delete itself.

## [0.3.0] — M3: migration layer (junctions / ledger / rollback)

### Added

- **Migration engine** `src/migrator/index.ts`: `migrateByJunction` (copy → verify → delete source → create junction), `rollbackMigration` (unlink → move back → verify → drop the copy), a JSONL ledger, and `activeMigrations`.
- **Tool actions**: `migrate` and `rollback` are implemented; `grade: 'migrate'` picks the migration tier straight from the rule library.
- **Migration invariant**: ① copy, ② verify size and file count, ③ delete the source, ④ create the junction, ⑤ verify the junction is readable. Any failure **cleans up the copy and leaves the original untouched** — no half-migrated state.
- **Junctions**: creating a junction on Windows needs **no administrator rights**, so applications keep reading and writing the old path transparently. Same-volume migration is refused outright (it frees nothing).
- **Rollback safety**: the junction target is compared against the ledger first; if the original path is no longer a junction or points elsewhere, rollback is **refused** rather than overwriting data.
- **Config**: new `migrationRoot` (defaults to `<largest non-system drive>:\dsh-cc-migrated`, with `ledger.jsonl` alongside).
- **Tests**: `tests/m3-migrate.ts` (`npm run m3`), 14 isolated cases: protection-list refusal, same-volume refusal, junction-as-source refusal, existing-destination refusal, dry run by default, a real migration with reads through the junction, ledger persistence, rollback, and rollback with no records.

### Fixed

- **Drive-root string bug**: `driveOf()` already returns `d:`, so appending `:\\` produced `D::\`, which made `fs.statfs` fail and every migration report "not enough space on the target drive" (caught by the test on the first run). The space pre-check is now tri-state: an unreadable free-space figure is no longer treated as "not enough" — the copy proceeds and an `ENOSPC` failure rolls the copy back.

### Known limitations

- Rules marked `app-config` currently move the data and print the suggested command; they do **not** rewrite application configuration automatically.
- Migration is copy-then-delete, so large directories (tens of GB) take time proportional to their size (tool timeout is 15 minutes).
- A directory in use by a running app cannot be migrated: the copy is rolled back and the user is told to close the app first.

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
