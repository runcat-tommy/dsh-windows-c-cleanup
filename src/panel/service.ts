/**
 * M5 面板的宿主侧服务层。
 *
 * 设计原则（见 docs/m5-panel-design.md）：**面板是薄的，判断全在宿主既有模块里**。
 * 本文件不重新实现任何业务逻辑，只做四件事：
 *  1. 把扫描 / 分级结果整理成面板能直接渲染的 JSON；
 *  2. 把「预演」和「真执行」都交给同一个 {@link executeCleanup}（dryRun 开关不同），
 *     这样 GUI 与工具两条路径不可能出现行为差异；
 *  3. 用内存 job 表承载异步执行 + 逐项进度 + 取消（AbortController）；
 *  4. 所有返回值保证是 lossless JSON（宿主会校验，undefined 会让整次调用被拒）。
 *
 * job 表是内存态：宿主重启即清空，面板据此显示「任务已随宿主重启消失」。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config.js';
import { classify, groupByGrade, sumBytes } from '../classifier/index.js';
import { executeCleanup, type ExecutedItem, type ExecuteReport } from '../executor/index.js';
import { guardTargets } from '../executor/safety.js';
import {
  appendHistory,
  computeTrend,
  defaultHistoryPath,
  historyEntryFromPlan,
  previousScan,
  readHistory,
  type Trend,
} from '../history/index.js';
import {
  activeMigrations,
  driveOf,
  hasRoomFor,
  migrateByJunction,
  readLedger,
  rollbackMigration,
  toLedgerEntry,
  MIGRATION_LEDGER_FILE,
} from '../migrator/index.js';
import { buildPlan } from '../planner/index.js';
import { renderExecutionReport } from '../report/execution.js';
import { buildRuleIndex } from '../rules/match.js';
import { loadRules } from '../rules/load.js';
import type { ClassifiedItem, Plan } from '../rules/schema.js';
import { driveRoot } from '../util/drive.js';
import { formatBytes, nowStamp } from '../util/format.js';
import { listDrives, pickMigrationTarget, readFreeSpace } from '../scanner/drives.js';
import { scanSystem } from '../scanner/index.js';
import { measurePath } from '../scanner/size.js';

const GB = 1024 ** 3;
/** 面板单项列表上限：超出只发前 N 项并标记截断，避免一次 RPC 塞进上万个对象 */
const MAX_ITEMS_PER_GROUP = 200;

export type JobKind = 'cleanup' | 'migrate' | 'rollback';
export type JobStatus = 'running' | 'done' | 'failed' | 'canceled';

export interface PanelItemView {
  path: string;
  ruleId?: string;
  sizeBytes: number;
  action: string;
  reason: string;
  movedTo?: string;
}

export interface PanelJobView {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  dryRun: boolean;
  total: number;
  done: number;
  message?: string;
  plannedBytes: number;
  freedBytes: number;
  measuredFreedBytes: number;
  items: PanelItemView[];
  reportPath?: string;
  error?: string;
}

interface JobRecord {
  view: PanelJobView;
  controller: AbortController;
}

const jobs = new Map<string, JobRecord>();
let jobSeq = 0;
/** 最近一次扫描结果：预演 / 执行复用它提供的项与大小，避免每次都重新扫盘 */
let lastScan: { plan: Plan; classified: ClassifiedItem[]; at: string; scope: 'hotspots' | 'full' } | undefined;

/** 面板发起的报告落到哪：显式 reportDir 优先，否则落在历史文件旁边的 reports/ */
export function panelOutputDir(config: Config): string {
  if (config.reportDir) return config.reportDir;
  return path.join(path.dirname(config.historyPath ?? defaultHistoryPath()), 'reports');
}

/** 面板看到的整体状态 */
export interface PanelState {
  systemDrive: string;
  drives: Array<{ letter: string; totalBytes: number; freeBytes: number; isSystem: boolean }>;
  defaultScope: 'hotspots' | 'full';
  historyPath: string;
  reportDir: string;
  scheduler: { enabled: boolean; description: string };
  lastScan?: {
    planId: string;
    at: string;
    scope: string;
    freeBytes: number;
    totalBytes: number;
    safeBytes: number;
    cautionBytes: number;
    migrateBytes: number;
    protectedCount: number;
    selectableCount: number;
    partial: boolean;
    itemCount: number;
  };
  migrationTarget?: { letter: string; root: string; freeBytes: number };
  runningJobs: number;
  trend?: Trend;
}

interface SchedulerLike {
  isRunning(): boolean;
  describe(): string;
}

export async function panelState(config: Config, scheduler?: SchedulerLike): Promise<PanelState> {
  const drives = await listDrives();
  const system = drives.find((d) => d.isSystem);
  const target = pickMigrationTarget(drives);
  const historyPath = config.historyPath ?? defaultHistoryPath();
  const entries = await readHistory(historyPath);
  const last = previousScan(entries, '');
  const trend =
    last === undefined
      ? undefined
      : (() => {
          const previous = previousScan(entries, last.id);
          return previous === undefined ? undefined : computeTrend(previous, last);
        })();

  return {
    systemDrive: system?.letter ?? 'C',
    drives: drives.map((d) => ({ letter: d.letter, totalBytes: d.totalBytes, freeBytes: d.freeBytes, isSystem: d.isSystem })),
    defaultScope: config.defaultScope,
    historyPath,
    reportDir: panelOutputDir(config),
    scheduler: {
      enabled: config.schedule?.enabled === true,
      description: scheduler?.isRunning() === true ? '定时扫描运行中' : describePanelSchedule(config),
    },
    ...(lastScan === undefined ? {} : { lastScan: planSummaryView(lastScan, drives) }),
    ...(target === undefined
      ? {}
      : { migrationTarget: { letter: target.letter, root: driveRoot(target.letter), freeBytes: target.freeBytes } }),
    runningJobs: [...jobs.values()].filter((j) => j.view.status === 'running').length,
    ...(trend === undefined ? {} : { trend }),
  };
}

function describePanelSchedule(config: Config): string {
  const schedule = config.schedule;
  if (schedule?.enabled !== true) return '未启用（config.schedule.enabled = false）';
  return `每 ${schedule.intervalHours} 小时扫描一次（范围 ${schedule.scope}）`;
}

function planSummaryView(scan: NonNullable<typeof lastScan>, drives: Awaited<ReturnType<typeof listDrives>>) {
  const system = drives.find((d) => d.isSystem);
  const plan = scan.plan;
  return {
    planId: plan.id,
    at: scan.at,
    scope: scan.scope,
    freeBytes: system?.freeBytes ?? 0,
    totalBytes: system?.totalBytes ?? 0,
    safeBytes: plan.summary.safeBytes,
    cautionBytes: plan.summary.cautionBytes,
    migrateBytes: plan.summary.migrateBytes,
    protectedCount: plan.groups.protected.length,
    selectableCount: plan.groups.safe.length + plan.groups.caution.length,
    partial: plan.partial,
    itemCount: scan.classified.length,
  };
}

export interface PanelScanResult {
  planId: string;
  at: string;
  scope: 'hotspots' | 'full';
  systemDrive: string;
  freeBytes: number;
  totalBytes: number;
  groups: {
    safe: PanelGroup;
    caution: PanelGroup;
    migrate: PanelGroup;
    protected: PanelGroup;
  };
  longTerm: Array<{ id: string; title: string; detail: string; detect: string; benefit: string }>;
  bigItems: Array<{ path: string; sizeBytes: number; grade: string }>;
  partial: boolean;
  partialReasons: string[];
  reportPath?: string;
  reportJsonPath?: string;
  trend?: Trend;
  historyPath: string;
}

interface PanelGroup {
  count: number;
  bytes: number;
  truncated: boolean;
  items: Array<{
    path: string;
    ruleId: string;
    sizeBytes: number;
    grade: string;
    reason: string;
    migratable: boolean;
    protectedReason?: string;
  }>;
}

function groupView(items: ClassifiedItem[]): PanelGroup {
  return {
    count: items.length,
    bytes: sumBytes(items),
    truncated: items.length > MAX_ITEMS_PER_GROUP,
    items: items.slice(0, MAX_ITEMS_PER_GROUP).map((item) => ({
      path: item.path,
      ruleId: item.ruleId,
      sizeBytes: item.sizeBytes,
      grade: item.grade,
      reason: item.reason,
      migratable: item.migrate !== undefined && item.migrate !== null,
    })),
  };
}

/** 扫描：与工具/定时扫描同一条流水线（loadRules → scanSystem → classify → buildPlan → 历史） */
export async function panelScan(
  config: Config,
  args: { scope?: 'hotspots' | 'full' } = {},
  hooks: { onProgress?: (message: string) => void; signal?: AbortSignal } = {},
): Promise<PanelScanResult> {
  const started = Date.now();
  const scope = args.scope ?? config.defaultScope;
  const { ruleSet, warnings } = await loadRules({
    extraRulesFile: config.extraRulesFile,
    allowProtectedOverride: config.allowProtectedOverride,
  });
  const log = hooks.onProgress ?? ((): void => {});
  for (const warning of warnings) log(`规则告警：${warning}`);

  const index = buildRuleIndex(ruleSet.rules);
  const scan = await scanSystem(
    ruleSet,
    {
      hotspotTimeBudgetMs: config.hotspotTimeBudgetMs,
      topTree: {
        enabled: scope === 'full',
        maxDepth: config.topTreeMaxDepth,
        timeBudgetMs: config.topTreeTimeBudgetMs,
      },
      signal: hooks.signal,
      onProgress: log,
    },
    index,
  );

  const classified = classify(scan.items, ruleSet.rules, index, {
    allowProtectedOverride: config.allowProtectedOverride,
  });
  const plan = buildPlan({
    drives: scan.drives,
    items: classified,
    longTerm: ruleSet.longTermActions,
    partial: scan.partial,
    stats: scan.stats,
  });

  const historyPath = config.historyPath ?? defaultHistoryPath();
  const entry = historyEntryFromPlan(plan, scope, Date.now() - started);
  await appendHistory(historyPath, entry);
  const entries = await readHistory(historyPath);
  const previous = previousScan(entries, plan.id);

  lastScan = { plan, classified, at: new Date().toISOString(), scope };
  const system = scan.drives.find((drive) => drive.isSystem);

  return {
    planId: plan.id,
    at: lastScan.at,
    scope,
    systemDrive: system?.letter ?? 'C',
    freeBytes: system?.freeBytes ?? 0,
    totalBytes: system?.totalBytes ?? 0,
    groups: {
      safe: groupView(plan.groups.safe),
      caution: groupView(plan.groups.caution),
      migrate: groupView(plan.groups.migrate),
      protected: groupView(plan.groups.protected),
    },
    longTerm: plan.longTerm.map((action) => ({
      id: action.id,
      title: action.title,
      detail: action.action,
      detect: action.detect,
      benefit: action.benefit,
    })),
    bigItems: plan.bigItems.slice(0, 50).map((item) => ({
      path: item.path,
      sizeBytes: item.sizeBytes,
      grade: item.grade,
    })),
    partial: plan.partial,
    partialReasons: plan.scanStats.partialReasons,
    historyPath,
    ...(previous === undefined ? {} : { trend: computeTrend(previous, entry) }),
  };
}

export interface PanelPreview {
  plannedBytes: number;
  items: Array<{ path: string; sizeBytes: number; action: string; reason: string; kind: 'delete' | 'trash' | 'elevate' | 'refused' }>;
  refused: Array<{ path: string; reason: string }>;
  elevationCount: number;
  trashPath?: string;
  migrationTarget?: string;
  warnings: string[];
}

/**
 * 预演：**走的就是真执行那条路**（executeCleanup + dryRun），
 * 因此预演里出现的每一项、每个理由，都必然与真执行一致。
 */
export async function panelPreview(
  config: Config,
  args: { paths?: string[]; grade?: 'safe' | 'caution'; mode?: 'trash' | 'permanent'; trashPath?: string; elevation?: string },
): Promise<PanelPreview> {
  const targets = args.paths ?? targetsOfGrade(args.grade ?? 'safe');
  const { ruleSet } = await loadRules({
    extraRulesFile: config.extraRulesFile,
    allowProtectedOverride: config.allowProtectedOverride,
  });
  const index = buildRuleIndex(ruleSet.rules);
  const drives = await listDrives();
  const systemDrive = drives.find((d) => d.isSystem)?.letter ?? 'C';
  const target = pickMigrationTarget(drives);
  const mode = args.mode ?? config.defaultDeleteMode;
  const trashPath = args.trashPath ?? config.trashPath ?? (target ? path.join(driveRoot(target.letter), 'to_delete') : undefined);
  const warnings: string[] = [];
  if (mode === 'trash' && !trashPath) warnings.push('暂存区模式需要另一个盘：未检测到非系统盘，且未提供 trashPath');
  if (mode === 'permanent') warnings.push('永久删除不可恢复：面板默认用暂存区模式');

  const report = await executeCleanup({
    targets,
    mode,
    ...(trashPath === undefined ? {} : { trashPath }),
    dryRun: true,
    systemDrive,
    index,
    allowExplicitUnmatched: config.allowExplicitUnmatched,
    allowProtectedOverride: config.allowProtectedOverride,
    knownSizes: knownSizes(),
    elevation: {
      dism: args.elevation === 'dism' || args.elevation === 'dism+cleanmgr',
      cleanmgr: args.elevation === 'cleanmgr' || args.elevation === 'dism+cleanmgr',
    },
  });

  return {
    plannedBytes: report.plannedBytes,
    items: report.items
      .filter((item) => item.action !== 'refused')
      .map((item) => ({
        path: item.path,
        sizeBytes: item.sizeBefore,
        action: item.action,
        reason: item.reason,
        kind: item.action === 'needs-elevation' ? 'elevate' : mode === 'trash' ? 'trash' : 'delete',
      })),
    refused: report.items.filter((item) => item.action === 'refused').map((item) => ({ path: item.path, reason: item.reason })),
    elevationCount: report.elevationTasks.length,
    ...(trashPath === undefined ? {} : { trashPath }),
    ...(target === undefined ? {} : { migrationTarget: driveRoot(target.letter) }),
    warnings,
  };
}

export interface PanelMigratePreview {
  items: Array<{ source: string; destination: string; sizeBytes: number; fileCount: number; hasRoom: boolean; unknown: boolean }>;
  totalBytes: number;
  targetRoot: string;
  targetFreeBytes: number;
  targetKnown: boolean;
  needsConfigChange: string[];
  warnings: string[];
}

/** 迁移预览：源 → 目标映射 + 目标盘空间是否够（不复制任何数据） */
export async function panelMigratePreview(
  config: Config,
  args: { paths: string[]; targetDrive?: string },
  hooks: { signal?: AbortSignal } = {},
): Promise<PanelMigratePreview> {
  const drives = await listDrives();
  const requested = args.targetDrive?.replace(/:.*$/, '').toUpperCase();
  const target =
    requested === undefined
      ? pickMigrationTarget(drives)
      : drives.find((d) => d.letter === requested && !d.isSystem);
  if (target === undefined) {
    return {
      items: [],
      totalBytes: 0,
      targetRoot: '',
      targetFreeBytes: 0,
      targetKnown: false,
      needsConfigChange: [],
      warnings: ['未找到可用的非系统盘作为迁移目标（同盘迁移不会释放空间）'],
    };
  }

  const targetRoot = config.migrationRoot ?? path.join(driveRoot(target.letter), 'dsh-cc-migrated');
  const targetFree = await readFreeSpace(driveRoot(target.letter));
  const items: PanelMigratePreview['items'] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  for (const source of args.paths) {
    const measured = await measurePath(source, { timeBudgetMs: 20_000, signal: hooks.signal });
    const destination = path.join(targetRoot, path.basename(source.replace(/[\\/]+$/, '')));
    const room = await hasRoomFor(driveRoot(target.letter), measured.sizeBytes);
    totalBytes += measured.sizeBytes;
    items.push({
      source,
      destination,
      sizeBytes: measured.sizeBytes,
      fileCount: measured.fileCount,
      hasRoom: room.ok,
      unknown: !room.known,
    });
    if (!room.ok && room.known) warnings.push(`目标盘空间不足：${source}（需要 ${formatBytes(measured.sizeBytes)}）`);
    if (driveOf(source) === driveOf(destination)) warnings.push(`源与目标同盘，不会释放空间：${source}`);
  }

  return {
    items,
    totalBytes,
    targetRoot,
    targetFreeBytes: targetFree.bytes,
    targetKnown: targetFree.known,
    needsConfigChange: configMigrateHints(args.paths),
    warnings,
  };
}

/** 迁移后需要用户自己改的应用配置（面板只提示，不代改） */
function configMigrateHints(paths: string[]): string[] {
  const hints: string[] = [];
  if (paths.some((p) => /\.m2[\\/]repository/i.test(p))) hints.push('Maven：在 settings.xml 里设置 <localRepository> 指向新路径');
  if (paths.some((p) => /npm-cache/i.test(p))) hints.push('npm：设置 npm config set cache 指向新路径');
  if (paths.some((p) => /pip[\\/]cache/i.test(p))) hints.push('pip：设置 PIP_CACHE_DIR 指向新路径');
  if (paths.some((p) => /\\uv$/i.test(p) || /[\\/]uv$/i.test(p))) hints.push('uv：设置 UV_CACHE_DIR 指向新路径');
  return hints;
}

function knownSizes(): Record<string, number> {
  const sizes: Record<string, number> = {};
  if (lastScan === undefined) return sizes;
  for (const item of lastScan.classified) sizes[item.path] = item.sizeBytes;
  return sizes;
}

function targetsOfGrade(grade: 'safe' | 'caution'): string[] {
  if (lastScan === undefined) return [];
  const list = grade === 'safe' ? lastScan.plan.groups.safe : lastScan.plan.groups.caution;
  return list.map((item) => item.path);
}

/** 启动一次清理任务（异步返回 jobId，进度走 {@link panelProgress}） */
export function panelStartCleanup(
  config: Config,
  args: { paths?: string[]; grade?: 'safe' | 'caution'; mode?: 'trash' | 'permanent'; trashPath?: string; dryRun: boolean; elevation?: string },
): { jobId: string } {
  const targets = args.paths ?? targetsOfGrade(args.grade ?? 'safe');
  const job = createJob('cleanup', args.dryRun);
  void (async () => {
    try {
      const { ruleSet } = await loadRules({
        extraRulesFile: config.extraRulesFile,
        allowProtectedOverride: config.allowProtectedOverride,
      });
      const index = buildRuleIndex(ruleSet.rules);
      const drives = await listDrives();
      const systemDrive = drives.find((d) => d.isSystem)?.letter ?? 'C';
      const target = pickMigrationTarget(drives);
      const mode = args.mode ?? config.defaultDeleteMode;
      const trashPath =
        args.trashPath ?? config.trashPath ?? (target ? path.join(driveRoot(target.letter), 'to_delete') : undefined);

      const report = await executeCleanup({
        targets,
        mode,
        ...(trashPath === undefined ? {} : { trashPath }),
        dryRun: args.dryRun,
        systemDrive,
        index,
        allowExplicitUnmatched: config.allowExplicitUnmatched,
        allowProtectedOverride: config.allowProtectedOverride,
        knownSizes: knownSizes(),
        elevation: {
          dism: args.elevation === 'dism' || args.elevation === 'dism+cleanmgr',
          cleanmgr: args.elevation === 'cleanmgr' || args.elevation === 'dism+cleanmgr',
        },
        signal: job.controller.signal,
        onProgress: (message) => updateMessage(job, message),
        onItem: (item, index2) => recordItem(job, item, index2),
      });

      const reportPath = path.join(panelOutputDir(config), `C盘清理执行报告-${nowStamp()}.md`);
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, renderExecutionReport(report), 'utf8');
      finishJob(job, report, reportPath);
    } catch (error) {
      failJob(job, error);
    }
  })();
  return { jobId: job.view.jobId };
}

/** 启动一次迁移任务 */
export function panelStartMigration(
  config: Config,
  args: { paths: string[]; targetDrive?: string; dryRun: boolean },
): { jobId: string } {
  const job = createJob('migrate', args.dryRun);
  void (async () => {
    try {
      const drives = await listDrives();
      const requested = args.targetDrive?.replace(/:.*$/, '').toUpperCase();
      const target =
        requested === undefined ? pickMigrationTarget(drives) : drives.find((d) => d.letter === requested && !d.isSystem);
      if (target === undefined) throw new Error('未找到可用的非系统盘作为迁移目标');

      const targetRoot = config.migrationRoot ?? path.join(driveRoot(target.letter), 'dsh-cc-migrated');
      await fs.mkdir(targetRoot, { recursive: true });
      const ledgerPath = path.join(targetRoot, MIGRATION_LEDGER_FILE);
      job.view.total = args.paths.length;

      for (const source of args.paths) {
        updateMessage(job, `迁移 ${source} → ${targetRoot}`);
        const outcome = await migrateByJunction(source, {
          targetRoot,
          dryRun: args.dryRun,
          signal: job.controller.signal,
          onProgress: (message) => updateMessage(job, message),
        });
        if (!args.dryRun && outcome.status === 'migrated') {
          const entry = toLedgerEntry(outcome);
          await fs.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
        }
        job.view.items.push({
          path: source,
          sizeBytes: outcome.sizeBytes,
          action: outcome.status,
          reason: migrateReason(outcome, args.dryRun),
        });
        job.view.done = job.view.items.length;
        job.view.plannedBytes += outcome.sizeBytes;
      }
      job.view.status = job.controller.signal.aborted ? 'canceled' : 'done';
      job.view.finishedAt = new Date().toISOString();
    } catch (error) {
      failJob(job, error);
    }
  })();
  return { jobId: job.view.jobId };
}

/** 启动一次迁移回滚任务 */
export function panelStartRollback(config: Config, args: { paths: string[]; dryRun: boolean }): { jobId: string } {
  const job = createJob('rollback', args.dryRun);
  void (async () => {
    try {
      const drives = await listDrives();
      const target = pickMigrationTarget(drives);
      const targetRoot = config.migrationRoot ?? (target ? path.join(driveRoot(target.letter), 'dsh-cc-migrated') : '');
      const ledgerPath = targetRoot === '' ? '' : path.join(targetRoot, MIGRATION_LEDGER_FILE);
      const entries = ledgerPath === '' ? [] : await readLedger(ledgerPath);
      job.view.total = args.paths.length;

      for (const source of args.paths) {
        const entry = entries.find((candidate) => candidate.source === source);
        if (entry === undefined) {
          job.view.items.push({ path: source, sizeBytes: 0, action: 'refused', reason: '台账里没有这条迁移记录' });
          job.view.done = job.view.items.length;
          continue;
        }
        const outcome = await rollbackMigration(entry, {
          dryRun: args.dryRun,
          signal: job.controller.signal,
          onProgress: (message) => updateMessage(job, message),
        });
        job.view.items.push({
          path: source,
          sizeBytes: outcome.sizeBytes,
          action: outcome.status,
          reason: migrateReason(outcome, args.dryRun),
        });
        job.view.done = job.view.items.length;
        job.view.plannedBytes += outcome.sizeBytes;
      }
      job.view.status = job.controller.signal.aborted ? 'canceled' : 'done';
      job.view.finishedAt = new Date().toISOString();
    } catch (error) {
      failJob(job, error);
    }
  })();
  return { jobId: job.view.jobId };
}

export function panelProgress(jobId: string): { found: boolean; job?: PanelJobView } {
  const job = jobs.get(jobId);
  return job === undefined ? { found: false } : { found: true, job: job.view };
}

export function panelCancel(jobId: string): { canceled: boolean; reason?: string } {
  const job = jobs.get(jobId);
  if (job === undefined) return { canceled: false, reason: '任务不存在（宿主可能已重启）' };
  if (job.view.status !== 'running') return { canceled: false, reason: `任务已结束（${job.view.status}）` };
  job.controller.abort();
  updateMessage(job, '收到取消请求，正在安全中止…');
  return { canceled: true };
}

/** 面板只保留最近 20 个任务，避免内存表无限增长 */
function pruneJobs(): void {
  const finished = [...jobs.values()].filter((job) => job.view.status !== 'running');
  if (jobs.size <= 20) return;
  finished
    .sort((a, b) => (a.view.finishedAt ?? '').localeCompare(b.view.finishedAt ?? ''))
    .slice(0, jobs.size - 20)
    .forEach((job) => jobs.delete(job.view.jobId));
}

export function panelHistory(
  _config: Config,
  args: { limit?: number } = {},
  historyPath?: string,
): Promise<{ historyPath: string; entries: Awaited<ReturnType<typeof readHistory>>; trend?: Trend }> {
  const file = historyPath ?? _config.historyPath ?? defaultHistoryPath();
  return readHistory(file, args.limit ?? 30).then((entries) => {
    const scans = entries.filter((entry) => entry.kind === 'scan');
    const current = scans.at(-1);
    const previous = current === undefined ? undefined : scans.at(-2);
    return {
      historyPath: file,
      entries,
      ...(current === undefined || previous === undefined ? {} : { trend: computeTrend(previous, current) }),
    };
  });
}

/** 迁移台账里的活跃项（面板用来渲染「可回滚」清单） */
export async function panelMigrations(config: Config): Promise<{ targetRoot: string; entries: ReturnType<typeof activeMigrations> }> {
  const drives = await listDrives();
  const target = pickMigrationTarget(drives);
  const targetRoot = config.migrationRoot ?? (target ? path.join(driveRoot(target.letter), 'dsh-cc-migrated') : '');
  if (targetRoot === '') return { targetRoot: '', entries: [] };
  const entries = await readLedger(path.join(targetRoot, MIGRATION_LEDGER_FILE));
  return { targetRoot, entries: activeMigrations(entries) };
}

/** 宿主卸载时取消在跑的任务（由插件 apply 通过 ctx.effect 注册） */
export function disposePanelJobs(): void {
  for (const job of jobs.values()) {
    if (job.view.status === 'running') job.controller.abort();
  }
  jobs.clear();
  lastScan = undefined;
}

function migrateReason(outcome: { status: string; errors: string[]; advice: string[]; destination: string }, dryRun: boolean): string {
  if (outcome.errors.length > 0) return outcome.errors.join('；');
  const advice = outcome.advice.length > 0 ? `（建议同步改配置：${outcome.advice.join('；')}）` : '';
  if (dryRun) return `dryRun：未改动数据，计划 → ${outcome.destination}${advice}`;
  if (outcome.status === 'migrated') return `已迁移到 ${outcome.destination}，原位置保留目录联接${advice}`;
  if (outcome.status === 'rolled-back') return '已搬回原位置并删除目录联接';
  return `状态：${outcome.status}${advice}`;
}

function createJob(kind: JobKind, dryRun: boolean): JobRecord {
  const job: JobRecord = {
    controller: new AbortController(),
    view: {
      jobId: `job-${nowStamp()}-${++jobSeq}`,
      kind,
      status: 'running',
      startedAt: new Date().toISOString(),
      dryRun,
      total: 0,
      done: 0,
      plannedBytes: 0,
      freedBytes: 0,
      measuredFreedBytes: 0,
      items: [],
    },
  };
  jobs.set(job.view.jobId, job);
  pruneJobs();
  return job;
}

function updateMessage(job: JobRecord, message: string): void {
  job.view.message = message;
}

function recordItem(job: JobRecord, item: ExecutedItem, index: number): void {
  const view: PanelItemView = {
    path: item.path,
    ...(item.ruleId === undefined ? {} : { ruleId: item.ruleId }),
    sizeBytes: item.sizeBefore,
    action: item.action,
    reason: item.reason,
    ...(item.movedTo === undefined ? {} : { movedTo: item.movedTo }),
  };
  job.view.items[index] = view;
  job.view.done = job.view.items.filter((entry) => entry !== undefined).length;
  if (job.view.total < job.view.items.length) job.view.total = job.view.items.length;
}

function finishJob(job: JobRecord, report: ExecuteReport, reportPath: string): void {
  job.view.status = job.controller.signal.aborted ? 'canceled' : 'done';
  job.view.finishedAt = new Date().toISOString();
  job.view.plannedBytes = report.plannedBytes;
  job.view.freedBytes = report.freedBytes;
  job.view.measuredFreedBytes = report.measuredFreedBytes;
  job.view.reportPath = reportPath;
  job.view.total = report.items.length;
  job.view.items = report.items.map((item) => ({
    path: item.path,
    ...(item.ruleId === undefined ? {} : { ruleId: item.ruleId }),
    sizeBytes: item.sizeBefore,
    action: item.action,
    reason: item.reason,
    ...(item.movedTo === undefined ? {} : { movedTo: item.movedTo }),
  }));
  job.view.done = report.items.length;
  updateMessage(job, summarize(report));
}

function summarize(report: ExecuteReport): string {
  const parts = [`计划处理 ${formatBytes(report.plannedBytes)}`];
  if (!report.dryRun) parts.push(`逐项测量释放 ${formatBytes(report.measuredFreedBytes)}`);
  return parts.join(' ｜ ');
}

function failJob(job: JobRecord, error: unknown): void {
  job.view.status = job.controller.signal.aborted ? 'canceled' : 'failed';
  job.view.finishedAt = new Date().toISOString();
  job.view.error = error instanceof Error ? error.message : String(error);
}

/** 供测试与诊断：把安全闸单独暴露出来（面板预览与工具走同一套判定） */
export async function panelGuard(
  config: Config,
  targets: string[],
): Promise<{ allowed: string[]; refused: Array<{ path: string; reason: string }> }> {
  const { ruleSet } = await loadRules({
    extraRulesFile: config.extraRulesFile,
    allowProtectedOverride: config.allowProtectedOverride,
  });
  const index = buildRuleIndex(ruleSet.rules);
  const drives = await listDrives();
  const systemDrive = drives.find((d) => d.isSystem)?.letter ?? 'C';
  const guards = await guardTargets(targets, {
    index,
    systemDrive,
    allowExplicitUnmatched: config.allowExplicitUnmatched,
    allowProtectedOverride: config.allowProtectedOverride,
  });
  return {
    allowed: guards.allowed.map((item) => item.path),
    refused: guards.refused.map((item) => ({ path: item.path, reason: item.reason })),
  };
}

/** 供测试与诊断：面板视角的空闲空间（含 total，便于换算百分比） */
export async function panelDriveUsage(letter = 'C'): Promise<{ freeBytes: number; known: boolean; totalGB: number }> {
  const drives = await listDrives();
  const drive = drives.find((candidate) => candidate.letter === letter.toUpperCase());
  const free = await readFreeSpace(driveRoot(letter));
  return {
    freeBytes: free.bytes,
    known: free.known,
    totalGB: Math.round(((drive?.totalBytes ?? 0) / GB) * 100) / 100,
  };
}
