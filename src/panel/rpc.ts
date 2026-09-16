/**
 * M5 面板的宿主侧 RPC 注册。
 *
 * 浏览器拿不到宿主工具（`ctx.tools` 是模型工具面），所以面板要走 Connection 的通用逻辑 RPC 通道：
 * 宿主用 `connection.rpc.handle(channel, handler, { authority: 'loopback' })` 注册一条绝对通道，
 * 通道名必须满足 `/^\/[A-Za-z0-9._~-]+$/`；客户端用 `connection.rpc.call(channel, endpoint, payload)` 调用。
 *
 * 两条硬约束：
 *  1. **返回必须是 RpcResult**（`{ok:true,value}` / `{ok:false,error:{code,message,details}}`），
 *     业务错误绝不能 throw —— 通道契约要求"方法不抛业务错误"；
 *  2. **不是所有宿主都有 connection 服务**（CLI 宿主就没有），所以这里用 `ctx.inject` 软等待 +
 *     `ctx.get` 取值，取不到就只打日志，工具面照常可用。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config.js';
import * as panel from './service.js';
import { normalizeLocale, type LocaleId } from '../i18n/index.js';

/** 通道名：绝对路径，且只用 CHANNEL_PATTERN 允许的字符 */
export const PANEL_CHANNEL = '/dsh-c-cleanup';

type RpcErrorLike = { code: 'internal'; message: string; details: Record<string, never> };
type RpcResultLike = { ok: true; value: unknown } | { ok: false; error: RpcErrorLike };
type RpcHandlerLike = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResultLike>;
interface ConnectionRpcLike {
  handle(
    channel: string,
    handler: RpcHandlerLike,
    options: { authority: 'trusted-host' | 'loopback' },
  ): () => void | Promise<void>;
}

function ok(value: unknown): RpcResultLike {
  return { ok: true, value };
}

function fail(message: string): RpcResultLike {
  return { ok: false, error: { code: 'internal', message, details: {} } };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 端点表：每个端点只做「取参 → 调服务层 → 返回」，业务判断全在服务层与既有模块里 */
export function panelEndpoints(
  config: Config,
): Record<string, (payload: Record<string, unknown>) => unknown | Promise<unknown>> {
  /** 界面语言：面板每次调用都会带上；缺省中文（模型工具那条路不传） */
  const localeOf = (payload: Record<string, unknown>): LocaleId => normalizeLocale(payload.locale);
  return {
    state: () => panel.panelState(config),
    scan: (payload) =>
      panel.panelScan(config, { scope: payload.scope === 'full' ? 'full' : 'hotspots', locale: localeOf(payload) }),
    // 用缓存里那次扫描重新出视图（切界面语言后调用；不扫盘、不测量）
    'scan-view': (payload) => panel.panelScanView(config, { locale: localeOf(payload) }),
    preview: (payload) =>
      panel.panelPreview(config, {
        ...(Array.isArray(payload.paths) ? { paths: payload.paths as string[] } : {}),
        ...(payload.mode === 'permanent' ? { mode: 'permanent' as const } : {}),
        ...(payload.grade === 'caution' || payload.grade === 'safe' ? { grade: payload.grade } : {}),
        locale: localeOf(payload),
      }),
    'migrate-preview': (payload) =>
      panel.panelMigratePreview(config, {
        paths: Array.isArray(payload.paths) ? (payload.paths as string[]) : [],
        ...(typeof payload.targetDrive === 'string' ? { targetDrive: payload.targetDrive } : {}),
        locale: localeOf(payload),
      }),
    // 执行：dryRun 必须是显式布尔 —— 面板没有「省略即真删」的捷径
    execute: (payload) =>
      panel.panelStartCleanup(config, {
        ...(Array.isArray(payload.paths) ? { paths: payload.paths as string[] } : {}),
        mode: payload.mode === 'permanent' ? 'permanent' : 'trash',
        dryRun: payload.dryRun === true,
        locale: localeOf(payload),
      }),
    migrate: (payload) =>
      panel.panelStartMigration(config, {
        paths: Array.isArray(payload.paths) ? (payload.paths as string[]) : [],
        dryRun: payload.dryRun !== false,
        ...(typeof payload.targetDrive === 'string' ? { targetDrive: payload.targetDrive } : {}),
      }),
    rollback: (payload) =>
      panel.panelStartRollback(config, {
        paths: Array.isArray(payload.paths) ? (payload.paths as string[]) : [],
        dryRun: payload.dryRun !== false,
      }),
    progress: (payload) => panel.panelProgress(text(payload.jobId)),
    cancel: (payload) => panel.panelCancel(text(payload.jobId)),
    history: (payload) =>
      panel.panelHistory(config, { limit: typeof payload.limit === 'number' ? payload.limit : 30 }),
    migrations: () => panel.panelMigrations(config),
  };
}

/**
 * 注册面板 RPC 通道。宿主没有 connection 服务时（CLI 场景）静默跳过，
 * 只留一条日志说明，绝不让插件加载失败。
 *
 * `ctx.inject` / `ctx.effect` 都按「有则用、无则退化」处理：真实 cordis ctx 两者都有，
 * 但最小化替身（测试、CLI）可能只有一个，插件不该因此带崩宿主。
 */
export function registerPanelRpc(ctx: Context, config: Config): void {
  const wireUp = (scope?: Context): void => {
    const holder = scope ?? ctx;
    const get = (holder as unknown as { get?: (name: string) => unknown }).get;
    const connection =
      typeof get === 'function' ? (get.call(holder, 'connection') as { rpc?: ConnectionRpcLike } | undefined) : undefined;
    const rpc = connection?.rpc;
    if (rpc === undefined || typeof rpc.handle !== 'function') {
      console.warn('windows-c-cleanup: 当前宿主没有 connection.rpc，清理面板未注册（模型工具不受影响）');
      return;
    }

    const endpoints = panelEndpoints(config);
    const register = (): (() => void) => {
      const disposing = rpc.handle(
        PANEL_CHANNEL,
        async (endpoint, payload) => {
          const handler = endpoints[endpoint];
          if (handler === undefined) return fail(`未知端点 ${endpoint}（可用：${Object.keys(endpoints).join(', ')}）`);
          try {
            const args = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
            return ok(await handler(args));
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
        { authority: 'loopback' },
      );
      return () => {
        // handle 返回的是清理函数（调用它才真正撤掉路由），不是 Promise
        try {
          void disposing();
        } catch {
          /* 卸载期的清理失败不应影响其它插件 */
        }
      };
    };

    const effect = (ctx as unknown as { effect?: (callback: () => () => void, label?: string) => unknown }).effect;
    if (typeof effect === 'function') {
      effect.call(ctx, register, 'windows-c-cleanup: panel rpc');
    } else {
      register();
    }
  };

  const inject = (ctx as unknown as { inject?: (deps: string[], callback: (scope: Context) => void) => unknown }).inject;
  if (typeof inject === 'function') {
    inject.call(ctx, ['connection'], (scope: Context) => wireUp(scope));
  } else {
    wireUp();
  }
}
