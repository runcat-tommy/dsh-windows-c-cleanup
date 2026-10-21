/**
 * M5 面板的宿主侧 RPC 注册（在 `webServer` 上注册 HTTP 路由，不再走 `connection.rpc.handle`）。
 *
 * 浏览器拿不到宿主工具（`ctx.tools` 只是模型工具面），面板因此走 HTTP：
 * 插件在宿主 `webServer` 上注册一条 **prefix 路由** `/dsh-c-cleanup`；浏览器侧仍是 DSH 的
 * 通用 RPC 客户端 `connection.rpc.call(channel, endpoint, payload)`，它按 Connection 的信封
 * POST 到 `<channel>/<endpoint>`：
 *   请求 `{ type: 'client-request', rpcId, method, payload }`
 *   响应 `{ type: 'server-response', rpcId, result: {ok:true,value} | {ok:false,error} }`
 * 服务端照着这个信封自己实现，客户端零改动。
 *
 * 为什么不用 `connection.rpc.handle(...)`：DSH 0.2.x 的实现里它通过 caller 作用域 ctx 的
 * `owner.webServer` 注册路由；调用方没有注入 `webServer` 时 cordis 直接抛
 * `cannot get property "webServer" without inject`，插件会在「启用」阶段失败。
 * 改为自己注册路由后，鉴权复用 `connection.requestRejection(request)`（与市场插件同一套 fence）。
 *
 * 三条硬约束：
 *  1. 响应必须是 Connection 的 `server-response` 信封，`result` 为 RpcResult；
 *  2. 业务错误折进 `{ok:false,error}`，不抛给 HTTP；
 *  3. 宿主没有 `webServer` 服务（headless/CLI）时静默跳过，工具面照常可用。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config.js';
import * as panel from './service.js';
import { normalizeLocale, type LocaleId } from '../i18n/index.js';

/** 通道名：绝对路径，且只用 CHANNEL_PATTERN 允许的字符 */
export const PANEL_CHANNEL = '/dsh-c-cleanup';

/** 单次请求体上限：面板只发小 JSON，超出说明不是我们的客户端 */
const MAX_BODY_BYTES = 1024 * 1024;

type RpcErrorLike = { code: 'internal'; message: string; details: Record<string, never> };
type RpcResultLike = { ok: true; value: unknown } | { ok: false; error: RpcErrorLike };

interface WebServerRoute {
  kind: 'prefix';
  path: string;
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}
interface WebServerLike {
  register(route: WebServerRoute): () => void | Promise<void>;
}
interface ConnectionLike {
  /** 返回 401/403（拒绝）或 undefined（放行） */
  requestRejection?(request: IncomingMessage): number | undefined;
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

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

/** POST 必须同源（Origin 缺省放行；有就必须与 Host 一致，挡住别的网页驱动本机清理） */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  try {
    return new URL(origin).host === (request.headers.host ?? '');
  } catch {
    return false;
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
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
 * 注册面板 HTTP 路由。宿主没有 `webServer` 服务时（headless/CLI）静默跳过，绝不让插件加载失败。
 *
 * 只用 façade 放行的三件事：`ctx.get`（取服务）、`ctx.on`（等 internal/service）、
 * `ctx.effect`（生命周期托管）；`ctx.inject` 只在真能访问到时使用（沙箱 façade 上读取会抛异常）。
 */
export function registerPanelRpc(ctx: Context, config: Config): void {
  const endpoints = panelEndpoints(config);
  let dispose: (() => void) | undefined;
  let registered = false;

  const serviceOf = <T>(name: string): T | undefined => {
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get;
    if (typeof get !== 'function') return undefined;
    try {
      return get.call(ctx, name) as T | undefined;
    } catch {
      return undefined;
    }
  };

  const registerWith = (webServer: WebServerLike): void => {
    if (registered) return;

    const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      try {
        // 鉴权：与市场插件同一套 fence（Host/Origin 白名单 + 浏览器会话）。
        // 每请求现取 connection，避免注册时它还没就位而整段跳过鉴权。
        const rejection = serviceOf<ConnectionLike>('connection')?.requestRejection?.(request);
        if (rejection !== undefined) {
          response.writeHead(rejection);
          response.end(rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
        if (!sameOrigin(request)) {
          response.writeHead(403);
          response.end('cross-origin request refused');
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(405);
          response.end('method not allowed');
          return;
        }

        const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        const endpoint = pathname.startsWith(`${PANEL_CHANNEL}/`)
          ? decodeURIComponent(pathname.slice(PANEL_CHANNEL.length + 1))
          : '';
        const entry = endpoints[endpoint];
        if (entry === undefined) {
          sendJson(response, 404, {
            type: 'server-response',
            rpcId: '',
            result: fail(`未知端点 ${endpoint}（可用：${Object.keys(endpoints).join(', ')}）`),
          });
          return;
        }

        let message: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown } = {};
        try {
          const raw = await readBody(request);
          message = raw === '' ? {} : (JSON.parse(raw) as typeof message);
        } catch {
          sendJson(response, 400, { type: 'server-response', rpcId: '', result: fail('请求体不是 JSON') });
          return;
        }

        const rpcId = typeof message.rpcId === 'string' ? message.rpcId : '';
        if (message.type !== 'client-request' || message.method !== endpoint) {
          sendJson(response, 400, { type: 'server-response', rpcId, result: fail('请求信封非法') });
          return;
        }

        const payload =
          message.payload !== null && typeof message.payload === 'object'
            ? (message.payload as Record<string, unknown>)
            : {};
        let result: RpcResultLike;
        try {
          result = ok(await entry(payload));
        } catch (error) {
          result = fail(error instanceof Error ? error.message : String(error));
        }
        sendJson(response, 200, { type: 'server-response', rpcId, result });
      } catch {
        // 响应已结束或 socket 出错：不再二次写头
        try {
          response.writeHead(500);
          response.end('handler failure');
        } catch {
          /* 忽略 */
        }
      }
    };

    const disposing = webServer.register({ kind: 'prefix', path: PANEL_CHANNEL, handler });
    registered = true;
    dispose = () => {
      try {
        void disposing();
      } catch {
        /* 卸载期的清理失败不应影响其它插件 */
      }
    };
  };

  const cleanup = (): void => {
    dispose?.();
    dispose = undefined;
    registered = false;
  };

  const effect = (ctx as unknown as { effect?: (callback: () => (() => void) | void, label?: string) => unknown })
    .effect;
  if (typeof effect === 'function') {
    effect.call(ctx, () => cleanup, 'windows-c-cleanup: panel rpc');
  } else {
    process.once('exit', cleanup);
  }

  const existing = serviceOf<WebServerLike>('webServer');
  if (existing !== undefined && typeof existing.register === 'function') registerWith(existing);
  if (registered) return;

  // webServer 还没就位：交给 cordis 等服务出现（沙箱 façade 上 ctx.inject 会抛，退回 internal/service 事件）
  const inject = (ctx as unknown as { inject?: (deps: string[], callback: (scope: Context) => void) => unknown })
    .inject;
  if (typeof inject === 'function') {
    try {
      inject.call(ctx, ['webServer'], (scope: Context) => {
        const webServer = (scope as unknown as { webServer?: WebServerLike }).webServer;
        if (webServer !== undefined && typeof webServer.register === 'function') registerWith(webServer);
      });
      return;
    } catch {
      /* façade：没有 inject，走下面的 on */
    }
  }

  const on = (ctx as unknown as { on?: (event: string, callback: (...args: unknown[]) => void) => unknown }).on;
  if (typeof on === 'function') {
    on.call(ctx, 'internal/service', (name: unknown) => {
      if (name !== 'webServer') return;
      const webServer = serviceOf<WebServerLike>('webServer');
      if (webServer !== undefined && typeof webServer.register === 'function') registerWith(webServer);
    });
    return;
  }

  console.warn('windows-c-cleanup: 当前宿主没有 webServer 服务，清理面板未注册（模型工具不受影响）');
}
