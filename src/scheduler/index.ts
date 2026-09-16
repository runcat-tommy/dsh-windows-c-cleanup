/**
 * 定时扫描与告警。
 *
 * 宿主事实：cordis 只提供 `ctx.logger` / `ctx.effect`，**没有内置定时器服务**，
 * 所以这里用 Node 的 `setTimeout` / `setInterval`，并做三件事保证它不会伤害宿主：
 *  1. 定时器 `unref()`：不会阻止进程退出；
 *  2. 生命周期交给 `ctx.effect()` 托管：插件卸载时自动清理（清不掉时退化为进程退出清理）；
 *  3. 单飞（single-flight）保护：上一轮还没跑完就跳过本轮，绝不并发叠加 I/O；
 *  4. 首次执行有延迟（默认 1 分钟），避免和宿主启动抢 I/O；
 *  5. 整轮包在 try/catch 里：定时任务失败只在日志里出现，绝不把宿主带崩。
 */
import { formatBytes, formatPercent } from '../util/format.js';
import type { HistoryEntry } from '../history/index.js';

export interface ScheduleOptions {
  enabled: boolean;
  /** 间隔小时数 */
  intervalHours: number;
  /** 剩余空间占比低于该值时告警（百分比，1–99） */
  alertFreePercent: number;
  /** 首次执行延迟（分钟），0 表示立即 */
  initialDelayMinutes: number;
}

export interface SchedulerHooks {
  /** 执行一次扫描（不写历史），返回历史条目 */
  runScan: () => Promise<HistoryEntry>;
  appendHistory: (entry: HistoryEntry) => Promise<void>;
  /** 由扫描结果构造告警条目（保留驱动器总量等上下文） */
  createAlert: (scan: HistoryEntry, message: string) => HistoryEntry;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface Scheduler {
  /** 手动触发一次（供测试与「立即扫描」使用） */
  tick: () => Promise<void>;
  stop: () => void;
  isRunning: () => boolean;
  describe: () => string;
}

/** 定时扫描配置的可读描述（工具输出与报告共用，纯函数） */
export function describeSchedule(options: {
  enabled: boolean;
  intervalHours: number;
  alertFreePercent: number;
  initialDelayMinutes: number;
  scope: 'hotspots' | 'full';
}): string {
  if (!options.enabled) return '未启用（config.schedule.enabled = false）';
  return `已启用：每 ${options.intervalHours} 小时扫描一次（范围 ${options.scope}，首次延迟 ${options.initialDelayMinutes} 分钟，剩余空间低于 ${options.alertFreePercent}% 时告警）`;
}

export function createScheduler(options: ScheduleOptions, hooks: SchedulerHooks): Scheduler {
  let timer: NodeJS.Timeout | undefined;
  let firstTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let inFlight = false;
  let runs = 0;
  let lastAlertAt = 0;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) {
      hooks.log('info', '定时扫描：上一轮仍在进行，跳过本轮');
      return;
    }
    inFlight = true;
    try {
      const entry = await hooks.runScan();
      await hooks.appendHistory(entry);
      runs += 1;
      hooks.log(
        'info',
        `定时扫描完成：${entry.systemDrive} 剩余 ${formatBytes(entry.freeBytes)}（${formatPercent(
          entry.freeBytes,
          entry.totalBytes,
        )}）` +
          `${entry.partial ? '（扫描被截断，结论不完整）' : ''}`,
      );

      const freeRatio = entry.totalBytes > 0 ? entry.freeBytes / entry.totalBytes : 1;
      if (freeRatio * 100 < options.alertFreePercent) {
        const message =
          `系统盘 ${entry.systemDrive} 剩余空间 ${formatPercent(entry.freeBytes, entry.totalBytes)} 低于告警阈值 ${
            options.alertFreePercent
          }%` +
          `（可清理：安全 ${formatBytes(entry.safeBytes)} / 谨慎 ${formatBytes(entry.cautionBytes)} / 可迁移 ${formatBytes(
            entry.migrateBytes,
          )}）`;
        hooks.log('warn', message);
        // 告警不刷屏：同一轮内只写一条，且两条之间至少间隔 1 小时
        if (Date.now() - lastAlertAt > 3_600_000) {
          lastAlertAt = Date.now();
          await hooks.appendHistory(hooks.createAlert(entry, message));
        }
      }
    } catch (error) {
      hooks.log('error', `定时扫描失败（不影响宿主）：${(error as Error).message}`);
    } finally {
      inFlight = false;
    }
  };

  const intervalMs = Math.max(1, options.intervalHours) * 3_600_000;
  const delayMs = Math.max(0, options.initialDelayMinutes) * 60_000;

  if (delayMs > 0) {
    firstTimer = setTimeout(() => void tick(), delayMs);
    firstTimer.unref?.();
  } else {
    void tick();
  }
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();

  return {
    tick,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      if (firstTimer) clearTimeout(firstTimer);
      timer = undefined;
      firstTimer = undefined;
    },
    isRunning: () => inFlight,
    describe: () =>
      `每 ${options.intervalHours} 小时扫描一次（首次延迟 ${options.initialDelayMinutes} 分钟，剩余空间低于 ${options.alertFreePercent}% 时告警），已完成 ${runs} 轮`,
  };
}
