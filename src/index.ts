/**
 * dsh-windows-c-cleanup —— DSH 插件入口。
 *
 * 形态要求（DSH Loader 约束）：命名导出 name / inject / Config / apply，
 * **绝不导出 default**（一旦有 default，Loader 会解包并丢掉 inject）。
 * `apply` 保持同步（异步初始化放在可观测边界），注册随 fiber 自动释放。
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
import { registerDiskCleanupTool } from './tools/disk-cleanup.js';

/** Loader 诊断用的插件名 */
export const name = 'windows-c-cleanup';

/** 依赖的宿主服务：工具注册表 */
export const inject = ['tools'];

export { Config };

export function apply(ctx: Context, config: Config): void {
  registerDiskCleanupTool(ctx, config);
}
