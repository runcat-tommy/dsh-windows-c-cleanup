/**
 * 定时扫描端到端验证（**真扫盘**，约 30–60 秒）。
 *
 * 为什么单独有这一个：`tests/m4-history.ts` 里的调度语义用假 runScan 覆盖，
 * 而 `runScheduledScan`（真扫盘 → 历史条目）必须实测一次，否则「定时扫描到底能不能
 * 产出可信数字」只是推断。这里把历史写进 %TEMP% 沙箱，并把历史里的剩余空间与
 * `fs.statfs` 实测值对比，确认数字不是编的。
 *
 * 运行：npm run m4:live
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Config } from '../src/config.js';
import { appendHistory, readHistory, toAlertEntry } from '../src/history/index.js';
import { createScheduler, describeSchedule } from '../src/scheduler/index.js';
import { runScheduledScan } from '../src/scheduler/scan.js';
import { formatGB } from '../src/util/format.js';

const GB = 1024 ** 3;
const sandbox = path.join(os.tmpdir(), 'dsh-cc-m4-live');
const historyFile = path.join(sandbox, 'history.jsonl');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`);
}

async function main(): Promise<void> {
  console.log('=== 定时扫描端到端验证（真实热点扫描）===\n');
  await fs.rm(sandbox, { recursive: true, force: true });

  const config = Config({
    reportDir: sandbox,
    historyPath: historyFile,
    schedule: {
      enabled: true,
      intervalHours: 24,
      alertFreePercent: 1, // 设成 1%，避免在你机器上误触发告警噪声
      initialDelayMinutes: 600,
      scope: 'hotspots',
    },
  }) as Config;

  console.log(`配置：${describeSchedule(config.schedule)}\n`);
  const logs: string[] = [];
  const scheduler = createScheduler(
    {
      enabled: config.schedule.enabled,
      intervalHours: config.schedule.intervalHours,
      alertFreePercent: config.schedule.alertFreePercent,
      initialDelayMinutes: config.schedule.initialDelayMinutes,
    },
    {
      runScan: () => runScheduledScan(config),
      appendHistory: (entry) => appendHistory(historyFile, entry),
      createAlert: (scan, message) => toAlertEntry(scan, message),
      log: (level, message) => {
        logs.push(`${level}:${message}`);
        console.log(`[${level}] ${message}`);
      },
    },
  );

  const started = Date.now();
  await scheduler.tick();
  const wallMs = Date.now() - started;
  scheduler.stop();

  const entries = await readHistory(historyFile);
  const scan = entries.find((entry) => entry.kind === 'scan');
  check('1 定时扫描真的跑完并写入了一条历史', scan !== undefined, `历史条数=${entries.length}，墙钟 ${(wallMs / 1000).toFixed(1)} 秒`);
  if (!scan) {
    console.log(`\n=== 结果：${failed} 项失败 ===`);
    process.exitCode = 1;
    return;
  }
  check('2 历史条目的身份与范围正确', scan.id.length > 0 && scan.scope === 'hotspots' && scan.systemDrive === 'C', `id=${scan.id} scope=${scan.scope} drive=${scan.systemDrive}`);
  check(
    '3 驱动器数字是实数（总量 > 0、已用 + 剩余 = 总量）',
    scan.totalBytes > 0 && Math.abs(scan.usedBytes + scan.freeBytes - scan.totalBytes) < 1024 ** 2,
    `总 ${formatGB(scan.totalBytes)} ｜ 已用 ${formatGB(scan.usedBytes)} ｜ 剩余 ${formatGB(scan.freeBytes)}`,
  );

  // 与实测 statfs 对比：容差 3 GB（两次测量之间系统仍在写入）
  const stat = await fs.statfs('C:\\');
  const actualFree = stat.bavail * stat.bsize;
  check(
    '4 历史里的剩余空间与 fs.statfs 实测一致（容差 3 GB）',
    Math.abs(scan.freeBytes - actualFree) < 3 * GB,
    `历史 ${formatGB(scan.freeBytes)} vs 实测 ${formatGB(actualFree)}（差 ${formatGB(Math.abs(scan.freeBytes - actualFree))}）`,
  );
  check(
    '5 分级统计自洽（可清理量不超过已用空间）',
    scan.safeBytes + scan.cautionBytes + scan.migrateBytes <= scan.usedBytes,
    `安全 ${formatGB(scan.safeBytes)} / 谨慎 ${formatGB(scan.cautionBytes)} / 可迁移 ${formatGB(scan.migrateBytes)}`,
  );
  check('6 未达告警阈值时不写告警条目', entries.filter((entry) => entry.kind === 'alert').length === 0);
  check('7 有 info 日志且含剩余空间', logs.some((line) => line.includes('定时扫描完成') && line.includes('剩余')));

  await fs.rm(sandbox, { recursive: true, force: true });
  console.log(`\n=== 结果：${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('验证自身异常：', error);
  process.exitCode = 1;
});
