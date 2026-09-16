# dsh-windows-c-cleanup

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
| `items` | paths | Concrete paths to clean (required for the caution tier: only per-item user-confirmed paths) |
| `grade` | `safe` \| `caution` \| `migrate` | Select by tier: `safe` may be batched, `caution` must also pass `items`, `migrate` drives `action=migrate` |
| `mode` | `permanent` \| `trash` | `trash` moves items to the staging area for recovery (**default**); `permanent` deletes outright |
| `trashPath` | path | Staging root, **must be on another drive** (same-volume staging frees nothing); defaults to `<largest non-system drive>:\to_delete` |
| `migrationRoot` | path | Migration root; the `ledger.jsonl` ledger lives alongside it. Defaults to `<largest non-system drive>:\dsh-cc-migrated` |
| `dryRun` | boolean | **Defaults to `true`**: lists the actions without deleting anything; pass `false` only after the user confirms |
| `elevation` | `none` \| `dism` \| `cleanmgr` \| `dism+cleanmgr` | Whether to also run admin-level system cleanup (triggers UAC) |
| `targetDrive` | e.g. `D:` | Migration target; defaults to the non-system drive with the most free space |
| `extraRulesFile` | path | Extra user rule file layered on top of the built-in library |

Example prompt:

> Show me what is eating my C: drive

The tool returns drive info, reclaimable bytes per tier, the biggest top-N consumers, and a migration target suggestion — plus a Markdown report containing: summary → 🟥 biggest consumers → 🟢/🟡/🟠/🔴/🔵 tiers → execution results.

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

## Status (M1 + M2 + M3)

- [x] Rule library (100+ rules, placeholder-based) + long-term prevention list
- [x] Scanning: drive info, hotspot list, whole-drive Top-N, junction-safe measurement, time budgets
- [x] Five-tier grading with "unknown means protected"
- [x] Visual Markdown report
- [x] DSH tool registration (`disk_cleanup`, parameter/output schemas validated)
- [x] M2 Execution: deletion (batch for the safe tier, per-item for caution), staging area with ledger, UAC elevation (Windows\Temp / WinSxS / DISM / cleanmgr), execution report, dry run by default
- [x] M3 Migration: junction moves (transparent to applications), JSONL ledger and `rollback`, refusal and rollback on same-volume / existing-destination / insufficient-space / busy-source, app-config suggestions
- [ ] M4 Web GUI: five-tier cards, selection, progress, before/after space comparison
- [ ] M5 Scheduled scans and alerts
- [ ] M6 Release (npm + community marketplace)

## Known limitations (M1 + M2 + M3)

- **Execution requires explicit authorization**: `apply` / `trash` dry-run by default; a real run should follow a scan the user has reviewed. `migrate` / `rollback` still return `not-implemented` (M3).
- **Admin-level cleanup depends on the UAC prompt**: DSH's permission stack has no UAC primitive, so the plugin spawns the system prompt via `Start-Process -Verb RunAs` (the script lands in `%TEMP%\dsh-cc-elevated-*.ps1`). If the user declines, `Windows\Temp`, `SoftwareDistribution`, and WinSxS cannot be cleaned and the result is explicitly marked as cancelled.
- **Files locked by running apps cannot be deleted**: an open browser, IDE, or chat client locks its own caches; those items are reported as "partial" with the residual size. That is normal Windows behaviour, not a plugin failure.
- **Whole-drive Top-N coverage is I/O bound**: Node file operations go through the libuv thread pool (4 threads by default) and directory measurement cost is essentially driven by *file count*, so raising concurrency does not help. Within the 70-second budget, the hotspot rules reach 100% coverage on a 153 GB used drive, but the whole-drive Top-N pass covers only part of the tree (in practice it truncates after roughly 160 top/shallow-level directories).
  Truncation is always flagged as `partial` with a reason in both the report and the tool result — never disguised as a complete verdict. Raise `topTreeTimeBudgetMs` for more coverage at the cost of waiting longer. **Actionable findings come from the hotspot rules; Top-N is a safety net**, so truncation does not affect the usability of the five-tier list.
- **Two released-space metrics**: for small cleanups (tens of MB) the drive free-space delta can read 0 because other processes keep writing to the drive; the per-item measured total is authoritative there, and both are reported side by side.
- No interactive confirmation UI yet: the model hands the report to the user, and the user's selection feeds the execution path (GUI cards arrive in M4).

## Development

```powershell
npm install --legacy-peer-deps   # DSH type packages have peer conflicts; local install uses legacy resolution
npm run typecheck                 # type check
npm run smoke                     # fast self-check: rule matching / drive info / budgeted measurement
npm run m2                        # isolated M2 execution tests (sandboxed under %TEMP%)
npm run m3                        # isolated M3 migration tests (sandbox + D:\dsh-cc-m3-test)
npx tsx tests/tool-run.ts full     # headless full scan producing a real report
npm run build                      # compile to lib/ (publishable artifact)
```

## License

MIT
