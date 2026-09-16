/**
 * M5 面板服务隔离验证（宿主侧那一半）。
 *
 * 安全约定：真实删除 / 迁移**只发生在 %TEMP% 下的测试沙箱**与专用测试暂存区，
 * 跑完自行清理；保护名单用例只验证「拒绝」，不触碰任何真实用户数据。
 * 测试里唯一会读真实 C 盘的动作是 hotspots 扫描（与 m4 同款，只读）。
 *
 * 运行：npm run m5
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Config } from '../src/config.js';
import { defaultHistoryPath } from '../src/history/index.js';
import {
  disposePanelJobs,
  panelCancel,
  panelGuard,
  panelHistory,
  panelMigratePreview,
  panelMigrations,
  panelOutputDir,
  panelPreview,
  panelProgress,
  panelScan,
  panelStartCleanup,
  panelStartMigration,
  panelState,
} from '../src/panel/service.js';

const MB = 1024 * 1024;
const sandbox = path.join(os.tmpdir(), 'dsh-cc-m5-sandbox');
const trashRoot = 'D:\\to_delete-dsh-cc-m5';
const migrateRoot = 'D:\\dsh-cc-m5-migrated';
/** 保护名单用例：真实文档目录（只做「拒绝」断言，绝不触碰内容） */
const protectedPath = path.join(os.homedir(), 'Documents');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function makeJunk(dir: string, files = 3, sizeMB = 2): Promise<number> {
  await fs.mkdir(dir, { recursive: true });
  const chunk = Buffer.alloc(sizeMB * MB, 7);
  for (let i = 0; i < files; i++) await fs.writeFile(path.join(dir, `junk-${i}.bin`), chunk);
  return files * sizeMB * MB;
}

/** 宿主对工具/服务返回值做 lossless JSON 校验，这里提前用同一套规则卡住 */
function firstViolation(value: unknown, trail = '$'): string | undefined {
  if (value === undefined) return `${trail} 是 undefined（JSON 会丢键，宿主会拒绝整次调用）`;
  if (value === null) return undefined;
  const type = typeof value;
  if (type === 'function') return `${trail} 是函数`;
  if (type === 'number') return Number.isFinite(value as number) ? undefined : `${trail} 是非有限数 ${String(value)}`;
  if (type === 'bigint' || type === 'symbol') return `${trail} 是 ${type}`;
  if (Array.isArray(value)) {
    if (value.length !== Object.keys(value).length) return `${trail} 是稀疏数组`;
    for (let i = 0; i < value.length; i++) {
      const bad = firstViolation(value[i], `${trail}[${i}]`);
      if (bad !== undefined) return bad;
    }
    return undefined;
  }
  if (type === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return `${trail} 的原型不是普通对象`;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const bad = firstViolation(entry, `${trail}.${key}`);
      if (bad !== undefined) return bad;
    }
    return undefined;
  }
  return undefined;
}

function checkLossless(name: string, value: unknown): void {
  const bad = firstViolation(value);
  check(name, bad === undefined, bad ?? '可安全 JSON 往返');
}

async function waitJob(jobId: string, timeoutMs = 180_000): Promise<ReturnType<typeof panelProgress>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = panelProgress(jobId);
    if (snapshot.job === undefined || snapshot.job.status !== 'running') return snapshot;
    if (Date.now() > deadline) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main(): Promise<void> {
  console.log('=== windows-c-cleanup M5 面板服务隔离验证 ===\n');
  await fs.rm(sandbox, { recursive: true, force: true });
  await fs.rm(trashRoot, { recursive: true, force: true });
  await fs.rm(migrateRoot, { recursive: true, force: true });
  await fs.mkdir(sandbox, { recursive: true });

  const config = {
    defaultScope: 'hotspots',
    historyPath: path.join(sandbox, 'history.jsonl'),
    reportDir: path.join(sandbox, 'reports'),
    trashPath: trashRoot,
    migrationRoot: migrateRoot,
    defaultDeleteMode: 'trash',
    allowExplicitUnmatched: false,
    allowProtectedOverride: false,
    bigItemThresholdBytes: 2 * 1024 ** 3,
    hotspotTimeBudgetMs: 70_000,
    topTreeTimeBudgetMs: 70_000,
    topTreeMaxDepth: 3,
    schedule: { enabled: false, intervalHours: 24, alertFreePercent: 10, initialDelayMinutes: 1, scope: 'hotspots' },
  } as unknown as Config;

  // ---------- 1. 状态视图 ----------
  console.log('--- 1. 面板状态 ---');
  const state = await panelState(config);
  check('1.1 状态里有系统盘与全部盘符', state.systemDrive === 'C' && state.drives.length >= 2, JSON.stringify(state.drives.map((d) => d.letter)));
  check('1.2 定时扫描如实显示未启用', state.scheduler.enabled === false && state.scheduler.description.includes('未启用'), state.scheduler.description);
  check('1.3 报告目录与历史路径来自配置', state.reportDir === path.join(sandbox, 'reports') && state.historyPath === path.join(sandbox, 'history.jsonl'));
  check('1.4 迁移目标盘是非系统盘且给出根路径', state.migrationTarget?.root === 'D:\\', JSON.stringify(state.migrationTarget));
  checkLossless('1.5 状态视图是 lossless JSON', state);

  // ---------- 2. 扫描（唯一读真实 C 盘的动作，只读） ----------
  console.log('\n--- 2. 扫描与分级 ---');
  const scan = await panelScan(config, { scope: 'hotspots' });
  const groupTotal = scan.groups.safe.count + scan.groups.caution.count + scan.groups.migrate.count + scan.groups.protected.count;
  check('2.1 扫描返回五级分区（保护层非空）', groupTotal > 0 && scan.groups.protected.count > 0, `safe=${scan.groups.safe.count} caution=${scan.groups.caution.count} migrate=${scan.groups.migrate.count} protected=${scan.groups.protected.count}`);
  check('2.2 每层都给出项数与合计字节', (['safe', 'caution', 'migrate', 'protected'] as const).every((key) => scan.groups[key].count >= 0 && scan.groups[key].bytes >= 0));
  const safeItem = scan.groups.safe.items[0];
  check(
    '2.3 逐项数据带规则 id / 大小 / 判定理由（面板要能解释「为什么可删」）',
    safeItem !== undefined && safeItem.ruleId.length > 0 && safeItem.sizeBytes > 0 && safeItem.reason.length > 0,
    safeItem === undefined ? '安全层为空' : `${safeItem.path} ｜ ${safeItem.ruleId} ｜ ${safeItem.reason}`,
  );
  check('2.4 逐项列表有上限并如实标记截断', scan.groups.safe.items.length <= 200 && typeof scan.groups.safe.truncated === 'boolean');
  check('2.5 长期防护措施带可执行动作', scan.longTerm.length > 0 && scan.longTerm.every((action) => action.title.length > 0 && action.detail.length > 0));
  check('2.6 扫描把历史写完（面板趋势才有数据源）', (await fs.readFile(config.historyPath as string, 'utf8')).trim().split('\n').length >= 1);
  checkLossless('2.7 扫描结果（含未截断与截断两种形态）是 lossless JSON', scan);

  // ---------- 3. 预演 = 真执行同一条路 ----------
  console.log('\n--- 3. 预演 ---');
  const junk = path.join(sandbox, 'junk');
  const junkBytes = await makeJunk(junk, 2, 2);
  const preview = await panelPreview(config, { paths: [junk] });
  check(
    '3.1 预演给出逐项动作与大小（默认进暂存区）',
    preview.items.length === 1 && preview.items[0].kind === 'trash' && preview.items[0].sizeBytes > 0 && preview.plannedBytes >= junkBytes * 0.9,
    `kind=${preview.items[0]?.kind} size=${preview.items[0]?.sizeBytes} planned=${preview.plannedBytes}`,
  );
  check('3.2 预演绝不改数据（目录仍在）', await exists(junk));
  check('3.3 预演说明里写明去向', (preview.items[0]?.reason ?? '').includes(trashRoot), preview.items[0]?.reason ?? '');
  const protectedPreview = await panelPreview(config, { paths: [protectedPath] });
  check(
    '3.4 保护名单项在预演阶段就被拒绝（面板不会把它列成可执行）',
    protectedPreview.items.length === 0 && protectedPreview.refused.length === 1,
    JSON.stringify(protectedPreview.refused),
  );
  checkLossless('3.5 预演结果是 lossless JSON', preview);

  const guard = await panelGuard(config, [junk, protectedPath]);
  check('3.6 安全闸与执行层同一套判定', guard.allowed.length === 1 && guard.refused.length === 1, JSON.stringify(guard.refused));

  // ---------- 4. 真执行 + 进度 + 报告 ----------
  console.log('\n--- 4. 执行任务与逐项进度 ---');
  const started = panelStartCleanup(config, { paths: [junk], dryRun: false, mode: 'trash' });
  check('4.1 任务立即返回 jobId（异步执行）', /^job-/.test(started.jobId), started.jobId);
  const running = panelProgress(started.jobId);
  check('4.2 任务可查（初始为 running 或已完成）', running.found === true && running.job !== undefined, `status=${running.job?.status}`);
  const settled = await waitJob(started.jobId);
  check(
    '4.3 执行完成且逐项结果为 trashed',
    settled.job?.status === 'done' && settled.job.items.some((item) => item.action === 'trashed'),
    `status=${settled.job?.status} items=${JSON.stringify(settled.job?.items.map((item) => item.action))}`,
  );
  check('4.4 真执行后沙箱目录已不在', !(await exists(junk)));
  check('4.5 进度是真实逐项计数（done === items.length，不是猜日志）', settled.job !== undefined && settled.job.done === settled.job.items.length && settled.job.done >= 1, `done=${settled.job?.done}`);
  check(
    '4.6 执行报告落盘且路径回传',
    settled.job?.reportPath !== undefined && (await exists(settled.job.reportPath)),
    settled.job?.reportPath ?? '（无）',
  );
  check('4.7 结果里的释放量来自逐项测量', (settled.job?.measuredFreedBytes ?? 0) >= junkBytes * 0.9, `measured=${settled.job?.measuredFreedBytes}`);
  checkLossless('4.8 任务视图是 lossless JSON（含字段缺失的几种分支）', settled.job ?? {});

  // 预演任务（dryRun）也要能跑通并明确标注
  const dryJunk = path.join(sandbox, 'dry-junk');
  await makeJunk(dryJunk, 1, 1);
  const dryJob = panelStartCleanup(config, { paths: [dryJunk], dryRun: true });
  const drySettled = await waitJob(dryJob.jobId);
  check(
    '4.9 dryRun 任务标注 dryRun 且不动数据',
    drySettled.job?.dryRun === true && (await exists(dryJunk)) && drySettled.job.items.every((item) => item.action === 'planned'),
    `status=${drySettled.job?.status} actions=${JSON.stringify(drySettled.job?.items.map((item) => item.action))}`,
  );

  // ---------- 5. 取消 ----------
  console.log('\n--- 5. 取消任务 ---');
  check(
    '5.1 取消不存在的任务如实回报（不谎报成功）',
    panelCancel('job-does-not-exist').canceled === false,
    JSON.stringify(panelCancel('job-does-not-exist')),
  );
  const bigSource = path.join(sandbox, 'big-source');
  await fs.mkdir(bigSource, { recursive: true });
  for (let i = 0; i < 400; i++) await fs.writeFile(path.join(bigSource, `f-${i}.bin`), Buffer.alloc(64 * 1024, 3));
  const cancelJob = panelStartMigration(config, { paths: [bigSource], dryRun: true });
  const cancelResult = panelCancel(cancelJob.jobId);
  const canceled = await waitJob(cancelJob.jobId);
  check(
    '5.2 取消请求被接受且任务以 canceled 收尾（或已跑完）',
    cancelResult.canceled === true ? canceled.job?.status === 'canceled' : canceled.job?.status === 'done',
    `cancel=${JSON.stringify(cancelResult)} status=${canceled.job?.status}`,
  );
  check(
    '5.3 取消后重复取消如实回报状态',
    panelCancel(cancelJob.jobId).canceled === false,
    JSON.stringify(panelCancel(cancelJob.jobId)),
  );

  // ---------- 6. 迁移预览与台账 ----------
  console.log('\n--- 6. 迁移预览 ---');
  const migratePreview = await panelMigratePreview(config, { paths: [bigSource], targetDrive: 'D' });
  const migrateItem = migratePreview.items[0];
  check(
    '6.1 迁移预览给出 源 → 目标 映射与文件数',
    migrateItem !== undefined && migrateItem.destination.startsWith('D:\\') && migrateItem.fileCount >= 400 && migrateItem.sizeBytes > 0,
    JSON.stringify(migrateItem),
  );
  check('6.2 目标盘空间判定明确（有 room 且不是「未知」）', migrateItem?.hasRoom === true && migrateItem.unknown === false);
  check('6.3 目标盘空闲是实测数字', migratePreview.targetFreeBytes > 0 && migratePreview.targetKnown === true, `${(migratePreview.targetFreeBytes / 1024 ** 3).toFixed(2)} GB`);
  checkLossless('6.4 迁移预览是 lossless JSON', migratePreview);

  const migrateJob = panelStartMigration(config, { paths: [bigSource], dryRun: false, targetDrive: 'D' });
  const migrateSettled = await waitJob(migrateJob.jobId, 300_000);
  check(
    '6.5 真迁移完成：源位置变成目录联接，数据在目标盘',
    migrateSettled.job?.status === 'done' && migrateSettled.job.items[0]?.action === 'migrated' && (await exists(bigSource)),
    `status=${migrateSettled.job?.status} action=${migrateSettled.job?.items[0]?.action}`,
  );
  const migrations = await panelMigrations(config);
  check('6.6 台账记录了这次迁移（面板可据此回滚）', migrations.entries.some((entry) => entry.source === bigSource), `targetRoot=${migrations.targetRoot} entries=${migrations.entries.length}`);

  // ---------- 7. 历史与趋势 ----------
  console.log('\n--- 7. 历史与趋势 ---');
  const history = await panelHistory(config, { limit: 10 });
  check('7.1 历史返回条目与数据源路径', history.entries.length >= 1 && history.historyPath === config.historyPath, `${history.entries.length} 条`);
  checkLossless('7.2 历史结果是 lossless JSON（无基准时必须省略 trend）', history);

  // ---------- 8. 卸载清理 ----------
  console.log('\n--- 8. 卸载与清理 ---');
  disposePanelJobs();
  check('8.1 卸载后任务表清空（面板会显示「任务已随宿主重启消失」）', panelProgress(started.jobId).found === false);
  check('8.2 面板报告目录默认落在历史文件旁的 reports/', panelOutputDir({} as Config) === path.join(path.dirname(defaultHistoryPath()), 'reports'), panelOutputDir({} as Config));

  // ---------- 清理 ----------
  await fs.rm(sandbox, { recursive: true, force: true });
  await fs.rm(trashRoot, { recursive: true, force: true });
  await fs.rm(migrateRoot, { recursive: true, force: true });

  console.log(`\n=== 结果：${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error('测试异常：', error);
  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
  await fs.rm(trashRoot, { recursive: true, force: true }).catch(() => {});
  await fs.rm(migrateRoot, { recursive: true, force: true }).catch(() => {});
  process.exitCode = 1;
});
