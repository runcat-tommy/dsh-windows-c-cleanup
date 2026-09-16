/**
 * dsh-windows-c-cleanup —— DSH 插件入口。
 *
 * 形态要求（DSH Loader 约束）：命名导出 name / inject / Config / apply，
 * **绝不导出 default**（一旦有 default，Loader 会解包并丢掉 inject）。
 * `apply` 保持同步（异步初始化放在可观测边界），注册随 fiber 自动释放。
 *
 * M4 新增：`apply` 里按配置启动**定时扫描**（默认关闭）。定时器由 `ctx.effect`
 * 托管，插件卸载即清理；宿主没有定时器服务，因此用 Node 定时器 + `unref()`。
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
import { appendHistory, defaultHistoryPath, toAlertEntry } from './history/index.js';
import { createScheduler, describeSchedule } from './scheduler/index.js';
import { runScheduledScan } from './scheduler/scan.js';
import { registerDiskCleanupTool } from './tools/disk-cleanup.js';

/** Loader 诊断用的插件名 */
export const name = 'windows-c-cleanup';

/** 依赖的宿主服务：工具注册表 */
export const inject = ['tools'];

export { Config };

type LogLevel = 'info' | 'warn' | 'error';

export function apply(ctx: Context, config: Config): void {
  registerDiskCleanupTool(ctx, config);

  if (config.schedule?.enabled !== true) return;

  const historyPath = config.historyPath ?? defaultHistoryPath();
  const logger = ctx.logger?.('windows-c-cleanup');

  const scheduler = createScheduler(
    {
      enabled: true,
      intervalHours: config.schedule.intervalHours,
      alertFreePercent: config.schedule.alertFreePercent,
      initialDelayMinutes: config.schedule.initialDelayMinutes,
    },
    {
      runScan: () => runScheduledScan(config),
      appendHistory: (entry) => appendHistory(historyPath, entry),
      createAlert: (scanEntry, message) => toAlertEntry(scanEntry, message),
      log: (level: LogLevel, message: string) => {
        const method = logger?.[level];
        if (typeof method === 'function') {
          method(`${message}`);
          return;
        }
        // 宿主没给 logger（例如测试里的假 ctx）时退化到控制台，绝不因为日志而抛错
        if (level === 'error') console.error(`[windows-c-cleanup] ${message}`);
        else if (level === 'warn') console.warn(`[windows-c-cleanup] ${message}`);
        else console.log(`[windows-c-cleanup] ${message}`);
      },
    },
  );

  logger?.info(`定时扫描已启用：${describeSchedule(config.schedule)}；历史文件：${historyPath}`);

  const cleanup = (): void => scheduler.stop();
  // cordis 的 effect 会把清理器绑到当前 fiber；缺失时退回进程级清理，保证定时器不会泄漏
  const effect = (ctx as unknown as { effect?: (callback: () => () => void, label?: string) => unknown }).effect;
  if (typeof effect === 'function') {
    effect.call(ctx, () => cleanup, 'windows-c-cleanup:scheduled-scan');
  } else {
    process.once('exit', cleanup);
  }
}
