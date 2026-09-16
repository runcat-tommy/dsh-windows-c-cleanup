# dsh-windows-c-cleanup

**English** ｜ [中文](README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that adds **Windows system-drive (C:) cleanup** as an auditable pipeline:

> **Scan → five-tier grading → visual report → user selection → tiered execution / migration to another drive**

## Why

A full C: drive is rarely caused by "junk files". It is usually caused by *things that belong on another drive*: package-manager caches, IDE indexes, on-device browser AI models, leftover installers, virtual disks.

Deleting those blindly is risky: rebuilding an IDE index takes hours, and removing a virtual disk destroys an entire Linux environment. This plugin instead:

1. **Measures before deleting** — every candidate is sized against an externalized rule library, and a visual Markdown report is produced first;
2. **Grades into five tiers** — each candidate carries a human-readable reason;
3. **Treats the protection list as a hard constraint** — anything not in the rule library is treated as protected ("unknown means don't delete");
4. **Prefers migration over deletion** — with a second drive present, caches are moved via junctions or app config so they never come back.

## Five tiers

| Tier | Meaning | Execution policy |
| --- | --- | --- |
| 🟢 Safe to delete | Caches, temp files, leftover installers — no data loss | Batch after a single confirmation |
| 🟡 Delete with care | Rebuildable but expensive (IDE indexes, on-device AI models, package repos), or admin-only (WinSxS via DISM) | Confirm per item |
| 🟠 Consider migrating | Moves to another drive transparently via junction or app config | Migrate + link + ledger, rollback supported |
| 🔴 Protected | User documents, credentials, chat data, virtual disks, IDE config, unknown paths | **Never deleted automatically** (hard constraint, not overridable by user rules) |
| 🔵 Long-term prevention | Config actions: cache redirection, Storage Sense, virtual-disk location audit | Do once, clean less forever |

## Install

```powershell
# From a local checkout (development)
dsh plugin --profile web add D:\path\to\windows-c-cleanup

# Or from npm (once published)
dsh plugin --profile web add dsh-windows-c-cleanup
```

The package declares `dsh.bundle.patch`, so `dsh plugin` both installs it and registers it in `dsh.profile.bundles`. **Restart DSH** to activate:

```powershell
dsh web
```

For development you can skip installation and mount an overlay instead (on Windows the path must be a `file://` URL):

```powershell
node -e "const{pathToFileURL}=require('node:url');console.log(pathToFileURL(process.argv[1]).href)" "$PWD\src\index.ts"
dsh web --patch .\dev.cordis.yml
```

## Usage

The plugin registers one tool, `disk_cleanup`:

| Parameter | Value | Description |
| --- | --- | --- |
| `action` | `scan` \| `plan` \| `apply` \| `migrate` \| `rollback` \| `trash` | Required. `scan`/`plan` are read-only; `apply`/`trash` execute cleanup (M2); `migrate`/`rollback` move and restore data (M3) |
| `scope` | `hotspots` \| `full` | `hotspots` measures rule-library hotspots only (fast); `full` adds a whole-drive Top-N pass (default) |
| `reportPath` | path | Where the report is written; defaults to `<cwd>/C盘清理报告-<timestamp>.md` |
| `format` | `markdown` \| `json` \| `both` | Report format; defaults to the `defaultReportFormat` config. `json` writes a machine-readable report (passing `x.md` also writes a sibling `x.json`) |
| `items` | paths | Concrete paths to clean (required for the caution tier: only per-item user-confirmed paths) |
| `grade` | `safe` \| `caution` \| `migrate` | Select by tier: `safe` may be batched, `caution` must also pass `items`, `migrate` drives `action=migrate` |
| `mode` | `permanent` \| `trash` | `trash` moves items to the staging area for recovery (**default**); `permanent` deletes outright |
| `trashPath` | path | Staging root, **must be on another drive** (same-volume staging frees nothing); defaults to `<largest non-system drive>:\to_delete` |
| `migrationRoot` | path | Migration root; the `ledger.jsonl` ledger lives alongside it. Defaults to `<largest non-system drive>:\dsh-cc-migrated` |
| `historyPath` | path | Scan history (the trend data source). Defaults to `<DSH_HOME>\windows-c-cleanup\history.jsonl`, deliberately outside the caches being cleaned |
| `defaultReportFormat` | `markdown` | Default report format: `markdown` / `json` / `both` |
| `schedule.enabled` | `false` | Enable scheduled scans (**off by default** — it needs your explicit consent) |
| `schedule.intervalHours` | `24` | Scan interval in hours |
| `schedule.alertFreePercent` | `10` | Write an alert when free space drops below this percentage |
| `schedule.initialDelayMinutes` | `1` | First-run delay so startup I/O is not contended |
| `schedule.scope` | `hotspots` | Scheduled scan scope (faster and lighter than `full`) |
| `dryRun` | boolean | **Defaults to `true`**: lists the actions without deleting anything; pass `false` only after the user confirms |
| `elevation` | `none` \| `dism` \| `cleanmgr` \| `dism+cleanmgr` | Whether to also run admin-level system cleanup (triggers UAC) |
| `targetDrive` | e.g. `D:` | Migration target; defaults to the non-system drive with the most free space |
| `extraRulesFile` | path | Extra user rule file layered on top of the built-in library |

Example prompt:

> Show me what is eating my C: drive

The tool returns drive info, reclaimable bytes per tier, the biggest top-N consumers, and a migration target suggestion — plus a Markdown report containing: summary → 🟥 biggest consumers → 🟢/🟡/🟠/🔴/🔵 tiers → execution results.

### Cleanup panel (M5)

The plugin registers a **conversation view tab** in the Web GUI (`conversation.view`, an additive `list` slot — it never replaces or destroys any existing surface). Open any session, switch to "Disk cleanup", and go from "understand" to "select → preview → execute" without leaving the page.

The panel is deliberately **thin**: it makes no judgement of its own. Tiering, the safety gate, measurement and freed-bytes accounting all reuse the existing host modules, and the panel's *preview* and *real run* call the **same `executeCleanup`** (only `dryRun` differs) — so what you preview is exactly what would happen.

The toolbar is laid out as three tight groups with a right-pointing arrow after the first two, left to right:

| Group | Controls | Purpose |
| --- | --- | --- |
| ① Scan | `Scope` select + `Scan C:` | Pick hotspots/full, then scan (shows "Rescan" once a scan exists) → |
| ② Selection | `<n> selected` + `Clear selection` | Live count and one-click reset → |
| ③ Run | `Delete mode` select + `Preview` + `?` + `Confirm and run` | The `?` help button sits right next to "Preview" |

The arrows are purely decorative (`aria-hidden`, skipped by screen readers) and carry 12px of margin on each side on top of the group's 6px gap, so the flow reads clearly as "scan first → then select → finally run".

**Visual affordance** (deliberately tuned, not the default look):

- The three action buttons "Scan C:", "Clear selection" and "Preview" get a thick brand-coloured outline, a tinted fill, a drop shadow and semi-bold text **while they are enabled**, so they read as buttons at a glance. **While disabled they keep the original flat look** (pale background, grey border, translucent) — a button you cannot press must never be drawn as if you could;
- "Confirm and run" stays solid brand-coloured: solid means the final action, outlined means an ordinary clickable action, so the hierarchy never blurs;
- The `?` next to "Preview" is a 24px round button (2px brand outline, tinted fill, bold question mark, grows on hover). Opening it explains in place, in deliberately plain words: the first line is "Clicking Preview runs a dry run — nothing is deleted", then three bullet points (it really checks what may be deleted / it really counts permissions and space / it says what would happen to each item), and only then two caveats (the numbers are estimates, and locked files are invisible to a preview).

- Five-tier cards (🟢 safe / 🟡 caution / 🟠 migrate / 🔴 protected) with path, size and the reason for each verdict; protected entries **cannot be selected**;
- Two-step execution: the "confirm" button unlocks only after a preview, and any change to the selection or mode invalidates that preview; permanent deletion additionally requires an explicit confirmation tick. **While "Confirm and run" is disabled, the reason is written right next to it** — a tooltip on a disabled button never appears in most browsers, so a tooltip alone explains nothing: nothing ticked → "tick the items first"; ticked but not previewed → "click Preview"; previewed and then changed → "click Preview again" (all five states come from one pure `confirmGate()` function, pinned by checks 8.1–8.8);
- Real progress from the host's per-item accounting callback (not parsed log text), with a working "cancel job";
- Migration preview showing source → destination, file count and whether the target volume has room; app config changes are only *suggested*, never applied silently;
- Trend line at the top: time since the previous scan and which directories grew back.

#### Bilingual UI (Chinese / English)

Both the panel and the host text exist as **two complete sets** and follow the DSH locale automatically — there is no language switcher to click:

- UI strings live in the client dictionary (`client/src/i18n.ts`, 112 keys per language). The tab label is a **thunk**, so switching the locale retitles the tab without re-registering anything;
- Every panel call on the host RPC carries the current `locale`, so **host-generated text switches too**: every rule reason, all 12 safety-gate refusal sentences, the executor's per-item planned actions, migration config hints, and the scheduler status. English strings live in `src/rules/default-rules.en.json`, aligned with Chinese strictly by rule id (101 rules + 6 long-term actions, guarded by tests that check coverage *and* that no Han character leaks into the English file);
- **Chinese is the default**: the model tool path (`disk_cleanup`) never passes `locale`, so tool output is byte-for-byte what it always was; only the Web panel sends `en`;
- A missing English entry always falls back to the Chinese original — never to an empty string;
- **Wiring has an ordering requirement**: dictionaries must be registered *before* the framework renders a registration that declares `locale:`, so the client plugin waits for the locale service with `ctx.inject(['locale'])`. `dsh.client.inject` therefore lists `@deepseek-ai/dsh-client-locale` too — that is a package-metadata change, so the first upgrade needs a **`dsh web` restart**; after that, text changes only need a page refresh.

Browser and host talk over the generic Connection RPC channel `/dsh-c-cleanup` (`authority: loopback`, local callers only) with endpoints `state` / `scan` / `preview` / `execute` / `migrate` / `progress` / `cancel` / `history` and friends. The job table lives in host memory and is cleared on host restart.

**What it takes to go live** (platform mechanics, not a plugin choice):

| Change | What you must do |
| --- | --- |
| Add/remove a plugin package, or change `dsh.client` fields | **Restart `dsh web`** (package metadata verdicts are cached forever) |
| Change only the contents of `client/client.js` | **Refresh the page** (bundles are served `no-cache`; HMR is disabled in this profile) |

## Configuration

Override the row in your profile's `cordis.patch.yml` (a patch **replaces the whole config**, it does not deep-merge):

```yaml
- id: windows-c-cleanup
  name: 'dsh-windows-c-cleanup'
  config:
    reportDir: 'D:\reports'
    defaultScope: full
    hotspotTimeBudgetMs: 60000
    topTreeTimeBudgetMs: 45000
    topTreeMaxDepth: 3
    bigItemThresholdBytes: 2147483648
    allowProtectedOverride: false
    extraRulesFile: 'D:\my-rules.json'
```

| Option | Default | Description |
| --- | --- | --- |
| `reportDir` | current working directory | Report output directory |
| `defaultScope` | `full` | Default scan scope |
| `hotspotTimeBudgetMs` | `70000` | Hotspot time budget (truncates and flags `partial`) |
| `topTreeTimeBudgetMs` | `70000` | Whole-drive Top-N time budget (both scans run in parallel, so wall time tracks the larger one) |
| `topTreeMaxDepth` | `3` | Top-N traversal depth |
| `bigItemThresholdBytes` | `2 GiB` | "Big item" threshold |
| `allowProtectedOverride` | `false` | **Whether user rules may override the protection list** |
| `extraRulesFile` | none | Extra user rule file |

## Rule library

The built-in library (100+ rules) lives in `src/rules/default-rules.json`. Every path is written with placeholders (`%LOCALAPPDATA%`, `%APPDATA%`, `%USERPROFILE%`, `%WINDIR%`, …) — **no hardcoded user names**, so it is portable across machines.

```json
{
  "id": "npm-cache-local",
  "path": "%LOCALAPPDATA%\\npm-cache",
  "grade": "migrate",
  "reason": "npm package cache, often several GB; better migrated to another drive",
  "migrate": {
    "method": "app-config",
    "targetHint": "<other drive>:\\npm-cache",
    "configHint": "npm config set cache \"<target>\""
  }
}
```

Matching: a candidate hits a rule when it equals the rule path or sits beneath it; `*` matches a single path segment (e.g. `%LOCALAPPDATA%\*-updater`).
Priority: the **most specific path wins**; on ties `protected` wins; no match at all → treated as `protected`.

Custom rules use the same shape:

```json
{ "rules": [{ "id": "my-cache", "path": "%LOCALAPPDATA%\\my-app\\cache", "grade": "safe", "reason": "self-built app cache" }] }
```

Attempts to override a `overridable: false` protected entry are rejected with a warning (unless `allowProtectedOverride` is explicitly enabled).

## Safety

- **Protection list as a hard constraint**: user documents, desktop, downloads, SSH/cloud credentials, `.dsh` config, chat data (WeCom/Lark/WeChat), IDE config, `pagefile.sys` / `hiberfil.sys` / virtual disks, `Program Files`, `Windows` — never deleted automatically.
- **Unknown means protected**: paths absent from the rule library are never deleted.
- **Tiered confirmation**: the safe tier can be confirmed once; the caution tier is confirmed item by item; the protection tier has no execution entry point at all.
- **Time budgets**: a truncated scan is explicitly flagged as `partial` in both the report and the tool result — never a silently incomplete verdict.
- **No link following**: junctions and symlinks are never followed, avoiding double counting and recursion traps.
- **Reversible migration**: migrations use junctions or app config and are recorded in a ledger (`rollback` from M3).

## Status (M1 + M2 + M3 + M4 + M5)

- [x] Rule library (100+ rules, placeholder-based) + long-term prevention list
- [x] Scanning: drive info, hotspot list, whole-drive Top-N, junction-safe measurement, time budgets
- [x] Five-tier grading with "unknown means protected"
- [x] Visual Markdown report
- [x] DSH tool registration (`disk_cleanup`, parameter/output schemas validated)
- [x] M2 Execution: deletion (batch for the safe tier, per-item for caution), staging area with ledger, UAC elevation (Windows\Temp / WinSxS / DISM / cleanmgr), execution report, dry run by default
- [x] M3 Migration: junction moves (transparent to applications), JSONL ledger and `rollback`, refusal and rollback on same-volume / existing-destination / insufficient-space / busy-source, app-config suggestions
- [x] M4 Polish: scan history with trend comparison, machine-readable JSON reports, scheduled scans with alerts (cleanmgr/DISM elevation already shipped in M2)
- [x] M5 Client GUI panel: `conversation.view` five-tier cards, selection, two-step execution (preview → confirm), per-item progress with cancel, migration preview
- [ ] M6 Release: npm + community marketplace (GitHub done)

## Known limitations (M1 + M2 + M3 + M4 + M5)

- **Execution requires explicit authorization**: `apply` / `trash` dry-run by default; a real run should follow a scan the user has reviewed. `migrate` / `rollback` still return `not-implemented` (M3).
- **Admin-level cleanup depends on the UAC prompt**: DSH's permission stack has no UAC primitive, so the plugin spawns the system prompt via `Start-Process -Verb RunAs` (the script lands in `%TEMP%\dsh-cc-elevated-*.ps1`). If the user declines, `Windows\Temp`, `SoftwareDistribution`, and WinSxS cannot be cleaned and the result is explicitly marked as cancelled.
- **Files locked by running apps cannot be deleted**: an open browser, IDE, or chat client locks its own caches; those items are reported as "partial" with the residual size. That is normal Windows behaviour, not a plugin failure.
- **Whole-drive Top-N coverage is I/O bound**: Node file operations go through the libuv thread pool (4 threads by default) and directory measurement cost is essentially driven by *file count*, so raising concurrency does not help. Within the 70-second budget, the hotspot rules reach 100% coverage on a 153 GB used drive, but the whole-drive Top-N pass covers only part of the tree (in practice it truncates after roughly 160 top/shallow-level directories).
  Truncation is always flagged as `partial` with a reason in both the report and the tool result — never disguised as a complete verdict. Raise `topTreeTimeBudgetMs` for more coverage at the cost of waiting longer. **Actionable findings come from the hotspot rules; Top-N is a safety net**, so truncation does not affect the usability of the five-tier list.
- **Two released-space metrics**: for small cleanups (tens of MB) the drive free-space delta can read 0 because other processes keep writing to the drive; the per-item measured total is authoritative there, and both are reported side by side.
- No interactive confirmation UI yet in the tool path: the model hands the report to the user, and the user's selection feeds the execution path. The M5 panel provides the interactive route (preview → confirm → progress).
- **Panel availability is a platform matter**: adding/removing a package or changing `dsh.client` requires a `dsh web` restart (metadata verdicts are cached forever); changing only the bundle needs a page refresh (HMR is off in this profile).
- **The panel shares the tool's judgement but not its configuration surface**: it can scan, preview, execute, migrate and roll back, while settings such as `schedule.enabled` or `reportDir` stay in `cordis.yml` — the panel reports state, it does not persist settings.
- **Panel jobs live in host memory**: after a host restart the panel shows "job vanished with the host restart" and any running job stops (reports and the migration ledger already on disk are unaffected).

## Development

```powershell
npm install --legacy-peer-deps   # DSH type packages have peer conflicts; local install uses legacy resolution
npm run deps:link                 # link the host's own @deepseek-ai/* copies (see note below)
npm run typecheck                 # type check
npm run smoke                     # fast self-check: rule matching / drive info / budgeted measurement
npm run m2                        # isolated M2 execution tests (sandboxed under %TEMP%)
npm run m3                        # isolated M3 migration tests (sandbox + D:\dsh-cc-m3-test)
npm run m4                        # M4 history/trend/JSON/scheduling semantics (fake scans, seconds; includes one real hotspot scan)
npm run m4:live                   # M4 scheduled scan end to end (real scan, ~1 minute; history numbers checked against fs.statfs)
npm run m5                        # M5 panel host half: tiering, preview == execute, real staging area, real migration, cancel, RPC endpoints
npm run m5:client                 # M5 client bundle contract: replay the browser module load and really render the panel once (offline, seconds)
npm run m5:live                   # M5 live check: ask the running dsh web for its boot manifest and the served bundle (hash-compared with the local build)
npx tsx tests/tool-run.ts full     # headless full scan producing a real report
npm run build                      # compile to lib/ and bundle client/client.js (publishable artifacts)
npm run build:client               # re-bundle the client half only (after editing client/src)
```

> ⚠️ `@deepseek-ai/dsh-tools` and friends declare their runtime dependencies as **peerDependencies**.
> `npm install --legacy-peer-deps` therefore never installs them (tests die with
> `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-xxx'`), and a plain `npm install`
> prunes them away again. `npm run deps:link` junctions the host's own copies into `node_modules`,
> so tests run against exactly the packages the host loads. It is idempotent; re-run it after any install.
> Always re-verify `npm run build` after touching dependencies.

## License

MIT
