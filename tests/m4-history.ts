/**
 * M4 隔离验证：历史趋势 / JSON 报告 / 定时扫描与告警。
 *
 * 安全约定：所有读写都发生在 %TEMP%\dsh-cc-m4-sandbox 内，抽查历史与 JSON 报告；
 * 定时扫描用**假的 runScan**（不真扫盘），只验证调度语义（单飞、节流、停止、告警阈值）。
 * 唯一一次真实扫描在工具层用例里（hotspots 范围，约几秒），用于验证趋势串起来。
 *
 * 运行：npm run m4
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Config } from '../src/config.js';
import { apply } from '../src/index.js';
import {
  appendHistory,
  computeTrend,
  historyEntryFromPlan,
  previousScan,
  readHistory,
  recentAlerts,
  toAlertEntry,
} from '../src/history/index.js';
import { JSON_REPORT_SCHEMA } from '../src/report/json.js';
import { createScheduler, describeSchedule } from '../src/scheduler/index.js';
import { registerDiskCleanupTool } from '../src/tools/disk-cleanup.js';
import type { HistoryEntry } from '../src/history/index.js';

const MB = 1024 * 1024;
const GB = 1024 ** 3;
const sandbox = path.join(os.tmpdir(), 'dsh-cc-m4-sandbox');
const historyFile = path.join(sandbox, 'history.jsonl');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`);
}

function entry(overrides: Partial<HistoryEntry> & { at: string; id: string; freeBytes: number }): HistoryEntry {
  return {
    kind: 'scan',
    scope: 'hotspots',
    systemDrive: 'C',
    totalBytes: 220 * GB,
    usedBytes: 150 * GB,
    safeBytes: 3 * GB,
    cautionBytes: 1 * GB,
    migrateBytes: 5 * GB,
    safeCount: 3,
    cautionCount: 1,
    migrateCount: 2,
    protectedCount: 4,
    bigItems: [],
    durationMs: 1000,
    partial: false,
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log('=== windows-c-cleanup M4 历史趋势 / JSON / 定时扫描 隔离验证 ===\n');
  await fs.rm(sandbox, { recursive: true, force: true });
  await fs.mkdir(sandbox, { recursive: true });

  // ---------- 1. 历史存储 ----------
  console.log('--- 1. 历史存储（JSONL）---');
  const a = entry({
    id: '20260101-000000',
    at: '2026-01-01T00:00:00.000Z',
    freeBytes: 60 * GB,
    bigItems: [
      { path: 'C:\\x\\wps', sizeBytes: 4 * GB, grade: 'migrate' },
      { path: 'C:\\x\\chrome', sizeBytes: 2 * GB, grade: 'caution' },
    ],
  });
  const b = entry({
    id: '20260102-000000',
    at: '2026-01-02T00:00:00.000Z',
    freeBytes: 55 * GB,
    bigItems: [
      { path: 'C:\\x\\wps', sizeBytes: 6 * GB, grade: 'migrate' }, // +2 GB 长回来
      { path: 'C:\\x\\nodes', sizeBytes: 3 * GB, grade: 'safe' }, // 新出现
    ],
  });
  await appendHistory(historyFile, a);
  await appendHistory(historyFile, b);

  const read = await readHistory(historyFile);
  check('1.1 历史可追加并读回（两条、时间正序）', read.length === 2 && read[0].id === a.id, `条数=${read.length}`);
  check('1.2 不存在的历史文件返回空数组而不是抛错', (await readHistory(path.join(sandbox, 'nope.jsonl'))).length === 0);

  await fs.appendFile(historyFile, '{ 这不是 JSON\n', 'utf8');
  const withBadLine = await readHistory(historyFile);
  check('1.3 坏行被跳过，好行仍可用', withBadLine.length === 2, `条数=${withBadLine.length}`);

  await fs.writeFile(historyFile, `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`, 'utf8');
  check('1.4 可只取最近 N 条', (await readHistory(historyFile, 1))[0].id === b.id);
  check('1.5 previousScan 排除当前这次扫描', previousScan(await readHistory(historyFile), b.id)?.id === a.id);

  // ---------- 2. 趋势计算 ----------
  console.log('\n--- 2. 趋势计算 ---');
  const trend = computeTrend(a, b);
  check('2.1 剩余空间变化量正确（60 → 55 GB）', trend.freeDeltaBytes === -5 * GB, `freeDelta=${trend.freeDeltaBytes / GB} GB`);
  check('2.2 时间差换算正确（24 小时）', trend.hoursAgo === 24, `hoursAgo=${trend.hoursAgo}`);
  check(
    '2.3 长回来的目录被识别且带增量（wps +2 GB）',
    trend.grown.length === 1 && trend.grown[0].path === 'C:\\x\\wps' && trend.grown[0].deltaBytes === 2 * GB,
    JSON.stringify(trend.grown),
  );
  check(
    '2.4 新出现的大头单列 appeared（不混进 grown）',
    trend.appeared.length === 1 && trend.appeared[0].path === 'C:\\x\\nodes',
    JSON.stringify(trend.appeared.map((i) => i.path)),
  );
  check(
    '2.5 本次未再测到的大头进 disappeared（chrome）',
    trend.disappeared.length === 1 && trend.disappeared[0].path === 'C:\\x\\chrome',
    JSON.stringify(trend.disappeared.map((i) => i.path)),
  );

  const tiny = computeTrend(
    a,
    entry({ ...b, bigItems: [{ path: 'C:\\x\\wps', sizeBytes: 4 * GB + 20 * MB, grade: 'migrate' }] }),
  );
  check('2.6 小于 100 MB 的抖动不报（避免噪声）', tiny.grown.length === 0 && tiny.shrunk.length === 0);

  const shrunk = computeTrend(b, entry({ ...b, id: 'c', at: '2026-01-03T00:00:00.000Z', freeBytes: 70 * GB, bigItems: [{ path: 'C:\\x\\wps', sizeBytes: 1 * GB, grade: 'migrate' }] }));
  check('2.7 释放量被识别为 shrunk（wps −5 GB）', shrunk.shrunk.length === 1 && shrunk.shrunk[0].deltaBytes === -5 * GB);

  // ---------- 3. 告警条目 ----------
  console.log('\n--- 3. 告警条目 ---');
  const alert = toAlertEntry(b, '系统盘 C 剩余空间 8% 低于告警阈值 10%');
  check('3.1 告警条目 kind=alert 且带说明、bigItems 为空', alert.kind === 'alert' && alert.message !== undefined && alert.bigItems.length === 0);
  check('3.2 告警条目保留驱动器总量（供后续判断）', alert.totalBytes === b.totalBytes && alert.freeBytes === b.freeBytes);
  await appendHistory(historyFile, alert);
  const alerts = recentAlerts(await readHistory(historyFile), 5);
  check('3.3 recentAlerts 只取告警且新到旧', alerts.length === 1 && alerts[0].message?.includes('低于告警阈值'));

  // ---------- 4. 调度语义 ----------
  console.log('\n--- 4. 定时扫描语义（假扫描，不真扫盘）---');
  check('4.1 未启用时描述明确', describeSchedule({ enabled: false, intervalHours: 24, alertFreePercent: 10, initialDelayMinutes: 1, scope: 'hotspots' }).includes('未启用'));

  let scans = 0;
  const written: HistoryEntry[] = [];
  const logs: string[] = [];
  const slow = createScheduler(
    { enabled: true, intervalHours: 24, alertFreePercent: 10, initialDelayMinutes: 600 },
    {
      runScan: async () => {
        scans++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return entry({ id: `s${scans}`, at: new Date().toISOString(), freeBytes: 50 * GB });
      },
      appendHistory: async (e) => void written.push(e),
      createAlert: (scan, message) => toAlertEntry(scan, message),
      log: (level, message) => void logs.push(`${level}:${message}`),
    },
  );
  await Promise.all([slow.tick(), slow.tick(), slow.tick()]);
  check('4.2 单飞保护：并发触发只执行一轮', scans === 1 && written.length === 1, `scans=${scans} written=${written.length}`);
  check('4.3 未达阈值时不写告警', written.filter((w) => w.kind === 'alert').length === 0);
  check('4.4 完成一轮后有 info 日志', logs.some((l) => l.startsWith('info:') && l.includes('定时扫描完成')), logs[0]?.slice(0, 60));
  slow.stop();
  await slow.tick();
  check('4.5 stop() 之后不再执行', scans === 1 && written.length === 1, `scans=${scans}`);

  let alertWritten = 0;
  const needy = createScheduler(
    { enabled: true, intervalHours: 24, alertFreePercent: 10, initialDelayMinutes: 600 },
    {
      runScan: async () => entry({ id: 'low', at: new Date().toISOString(), freeBytes: 8 * GB }),
      appendHistory: async (e) => {
        if (e.kind === 'alert') alertWritten++;
      },
      createAlert: (scan, message) => toAlertEntry(scan, message),
      log: () => {},
    },
  );
  await needy.tick();
  check('4.6 低于阈值时写入告警并给出可清理量', alertWritten === 1, `alertWritten=${alertWritten}`);
  needy.stop();

  let failing = 0;
  const broken = createScheduler(
    { enabled: true, intervalHours: 24, alertFreePercent: 10, initialDelayMinutes: 600 },
    {
      runScan: async () => {
        throw new Error('模拟扫描失败');
      },
      appendHistory: async () => {},
      createAlert: (scan, message) => toAlertEntry(scan, message),
      log: (level, message) => {
        if (level === 'error') failing++;
        void message;
      },
    },
  );
  await broken.tick();
  check('4.7 扫描抛错只记 error 日志，不向外抛（绝不带崩宿主）', failing === 1);
  broken.stop();

  // ---------- 5. 工具层：JSON 报告 + 趋势串联 ----------
  console.log('\n--- 5. 工具层（disk_cleanup + format）---');
  let tool: { execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<any> };
  const config = Config({ reportDir: sandbox, historyPath: historyFile, defaultScope: 'hotspots' }) as never;
  registerDiskCleanupTool(
    { tools: { register: (def: never) => ((tool = def as never), () => {}) } } as never,
    config,
  );
  const call = (args: Record<string, unknown>) => tool.execute(args, { signal: new AbortController().signal });

  const planOut = await call({ action: 'plan', scope: 'hotspots' });
  check('5.1 plan 输出带 historyPath', planOut.historyPath === historyFile, `historyPath=${planOut.historyPath}`);
  check(
    '5.2 扫描后历史追加了一条真实扫描记录',
    (await readHistory(historyFile)).some((e) => e.id === planOut.planId),
    `planId=${planOut.planId}`,
  );
  check(
    '5.3 与上一条历史对比得出趋势（含人类可读的增长摘要）',
    planOut.trend !== undefined && typeof planOut.trend.topGrowth === 'string' && planOut.trend.hoursAgo >= 0,
    JSON.stringify(planOut.trend),
  );
  check(
    '5.4 告警出现在工具输出里（来自历史）',
    Array.isArray(planOut.alerts) && planOut.alerts.length >= 1 && String(planOut.alerts[0]).includes('低于告警阈值'),
    JSON.stringify(planOut.alerts),
  );
  check('5.5 定时扫描状态随输出返回', typeof planOut.schedule === 'string' && planOut.schedule.includes('未启用'));
  check('5.6 默认格式仍是 Markdown 报告', planOut.reportPath.endsWith('.md') && planOut.reportJsonPath === undefined);

  const jsonOut = await call({ action: 'scan', scope: 'hotspots', format: 'json', reportPath: path.join(sandbox, '机器可读.json') });
  check('5.7 format=json 时 reportPath 指向 JSON 报告', jsonOut.reportJsonPath !== undefined && jsonOut.reportPath === jsonOut.reportJsonPath, `reportPath=${jsonOut.reportPath}`);
  const parsed = JSON.parse(await fs.readFile(jsonOut.reportJsonPath, 'utf8'));
  check('5.8 JSON 报告带 schema 版本号与扫描元信息', parsed.schema === JSON_REPORT_SCHEMA && typeof parsed.scan.id === 'string', `schema=${parsed.schema}`);
  check(
    '5.9 JSON 报告包含五级分组、大头、趋势与告警字段',
    ['safe', 'caution', 'migrate', 'protected'].every((k) => Array.isArray(parsed.groups[k])) &&
      Array.isArray(parsed.bigItems) &&
      parsed.trend !== null &&
      Array.isArray(parsed.alerts),
    `groups=${Object.keys(parsed.groups).join('/')} trend=${parsed.trend ? 'yes' : 'null'}`,
  );

  const bothOut = await call({ action: 'scan', scope: 'hotspots', format: 'both', reportPath: path.join(sandbox, '双份.md') });
  const mdExists = await fs
    .readFile(bothOut.reportPath, 'utf8')
    .then((t) => t.includes('## 📈 历史趋势（与上一次扫描对比）'))
    .catch(() => false);
  const jsonSibling = await fs
    .readFile(path.join(sandbox, '双份.json'), 'utf8')
    .then(() => true)
    .catch(() => false);
  check('5.10 format=both 同时产出 Markdown（含趋势区块）与同名 JSON', mdExists && jsonSibling && bothOut.reportJsonPath?.endsWith('双份.json') === true);

  const md = await fs.readFile(bothOut.reportPath, 'utf8');
  check('5.11 报告里写明历史文件位置与定时扫描状态', md.includes('历史记录：') && md.includes('定时扫描：'));

  // ---------- 7. 插件 apply 接线：定时器必须交给 ctx.effect 托管 ----------
  console.log('\n--- 7. apply 接线（假 ctx，验证宿主集成契约）---');
  let effectCallback: (() => (() => void) | void) | undefined;
  let effectLabel = '';
  const applyLogs: string[] = [];
  const fakeCtx = {
    tools: { register: () => () => {} },
    logger: () => ({
      info: (message: string) => void applyLogs.push(`info:${message}`),
      warn: (message: string) => void applyLogs.push(`warn:${message}`),
      error: (message: string) => void applyLogs.push(`error:${message}`),
      debug: () => {},
    }),
    effect: (callback: () => (() => void) | void, label?: string) => {
      effectCallback = callback;
      effectLabel = label ?? '';
      return () => {};
    },
  };

  apply(fakeCtx as never, Config({ reportDir: sandbox, historyPath: historyFile, schedule: { enabled: false } }) as never);
  check('7.1 默认（未启用）时不注册 effect、不建定时器', effectCallback === undefined);

  const enabledConfig = Config({
    reportDir: sandbox,
    historyPath: historyFile,
    schedule: { enabled: true, intervalHours: 24, alertFreePercent: 10, initialDelayMinutes: 600, scope: 'hotspots' },
  }) as never;
  apply(fakeCtx as never, enabledConfig);
  check(
    '7.2 启用后把定时器的清理交给 ctx.effect（带可读 label）',
    effectCallback !== undefined && effectLabel.includes('scheduled-scan'),
    `label=${effectLabel}`,
  );
  check(
    '7.3 启动时经 logger 说明配置与历史文件位置',
    applyLogs.some((line) => line.startsWith('info:') && line.includes('定时扫描已启用') && line.includes(historyFile)),
    applyLogs[0]?.slice(0, 80),
  );
  const cleanups = effectCallback?.();
  let cleanupOk = false;
  try {
    if (typeof cleanups === 'function') cleanups();
    else if (cleanups && typeof (cleanups as unknown as Promise<void>).then === 'function') await cleanups;
    cleanupOk = true;
  } catch {
    cleanupOk = false;
  }
  check('7.4 effect 的清理函数可安全调用（插件卸载即停表）', cleanupOk);

  // ---------- 收尾 ----------
  await fs.rm(sandbox, { recursive: true, force: true });
  const leftOver = await fs
    .stat(sandbox)
    .then(() => true)
    .catch(() => false);
  check('6.1 测试沙箱已清理', leftOver === false);

  console.log(`\n=== 结果：${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
  if (failed > 0) process.exitCode = 1;
}

void historyEntryFromPlan; // 由工具层用例间接覆盖，这里保留导入以便后续单测直接调用

main().catch((error) => {
  console.error('测试自身异常：', error);
  process.exitCode = 1;
});
