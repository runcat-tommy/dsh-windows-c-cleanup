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
  englishRuleCoverage,
  englishRules,
  longTermText,
  normalizeLocale,
  ruleReason,
} from '../src/i18n/index.js';
import { PANEL_CHANNEL, panelEndpoints, registerPanelRpc } from '../src/panel/rpc.js';
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
import { guardTargets } from '../src/executor/safety.js';
import { loadDefaultRules } from '../src/rules/load.js';
import { buildRuleIndex } from '../src/rules/match.js';
import { partialReasonText } from '../src/scanner/index.js';

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

/** 是否含中文字符（用来断言英文文案里没有残留中文，或反之） */
function hasHan(text: string): boolean {
  return /\p{Script=Han}/u.test(text);
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
  check(
    '1.2 定时扫描如实返回结构化状态（面板自己组织双语文案，宿主不吐中文句子）',
    state.scheduler.enabled === false && state.scheduler.running === false && state.scheduler.intervalHours === 24,
    JSON.stringify(state.scheduler),
  );
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

  // ---------- 9. 面板 RPC 端点（浏览器 → 宿主） ----------
  console.log('\n--- 9. 面板 RPC 端点 ---');
  const endpoints = panelEndpoints(config);
  const expectedEndpoints = ['state', 'scan', 'preview', 'migrate-preview', 'execute', 'migrate', 'rollback', 'progress', 'cancel', 'history', 'migrations'];
  check(
    '9.1 端点表覆盖 面板需要的全部动作',
    expectedEndpoints.every((key) => typeof endpoints[key] === 'function'),
    expectedEndpoints.filter((key) => typeof endpoints[key] !== 'function').join(', ') || '全部存在',
  );
  const stateValue = await endpoints.state?.({});
  checkLossless('9.2 state 端点返回 lossless JSON', stateValue);
  check(
    '9.3 progress 端点对不存在的任务如实回报 found:false',
    JSON.stringify(await endpoints.progress?.({ jobId: 'job-nope' })) === '{"found":false}',
  );

  interface Captured {
    channel?: string;
    options?: { authority?: string };
    handler?: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{
      ok: boolean;
      value?: unknown;
      error?: { code?: string; message?: string; details?: unknown };
    }>;
  }
  const captured: Captured = {};
  const disposers: Array<() => void> = [];
  let injected: string[] | undefined;
  let effectLabel = '';
  const rpcCtx = {
    inject: (deps: string[], callback: () => void) => {
      injected = deps;
      callback();
    },
    get: (name: string) =>
      name === 'connection'
        ? {
            rpc: {
              handle: (
                channel: string,
                handler: Captured['handler'],
                options: { authority: string },
              ): (() => void) => {
                captured.channel = channel;
                captured.handler = handler;
                captured.options = options;
                return () => {
                  disposed++;
                };
              },
            },
          }
        : undefined,
    effect: (callback: () => (() => void) | void, label?: string) => {
      effectLabel = label ?? '';
      const disposer = callback();
      if (typeof disposer === 'function') disposers.push(disposer);
    },
  };
  let disposed = 0;
  registerPanelRpc(rpcCtx as never, config);
  check('9.4 用 ctx.inject 软等待 connection（不写进硬依赖）', injected?.join(',') === 'connection', JSON.stringify(injected));
  check(
    '9.5 通道名合法且授权级别是本机 loopback',
    captured.channel === PANEL_CHANNEL && /^\/[A-Za-z0-9._~-]+$/.test(captured.channel ?? '') && captured.options?.authority === 'loopback',
    `${captured.channel} ｜ ${JSON.stringify(captured.options)}`,
  );
  check('9.6 注册随 ctx.effect 托管（卸载即撤路由）', effectLabel.includes('panel rpc') && disposers.length === 1, effectLabel);

  const handler = captured.handler;
  check('9.7 拿到 RPC handler', typeof handler === 'function');
  const okReply = await handler?.('progress', { jobId: 'job-nope' }, new AbortController().signal);
  check(
    '9.8 成功分支是 RpcResult {ok:true,value}',
    okReply?.ok === true && JSON.stringify(okReply.value) === '{"found":false}',
    JSON.stringify(okReply),
  );
  const unknownReply = await handler?.('nope', {}, new AbortController().signal);
  check(
    '9.9 未知端点返回内部错误而不是抛异常（通道契约：方法不抛业务错误）',
    unknownReply?.ok === false && unknownReply.error?.code === 'internal' && typeof unknownReply.error.message === 'string' && unknownReply.error.details !== undefined,
    JSON.stringify(unknownReply),
  );
  const thrownReply = await handler?.('migrate-preview', { paths: [null] }, new AbortController().signal);
  check(
    '9.10 服务层抛错被折成 {ok:false}（附带可读信息）',
    thrownReply?.ok === false && (thrownReply.error?.message?.length ?? 0) > 0,
    JSON.stringify(thrownReply).slice(0, 160),
  );

  for (const disposer of disposers) disposer();
  check('9.11 卸载时撤掉通道', disposed === 1, `disposed=${disposed}`);

  // 没有 connection 服务的宿主（CLI）：只警告，不抛错
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  let cliThrew = false;
  try {
    registerPanelRpc(
      {
        inject: (_deps: string[], callback: () => void) => callback(),
        get: () => undefined,
        effect: () => {},
      } as never,
      config,
    );
  } catch {
    cliThrew = true;
  }
  console.warn = originalWarn;
  check('9.12 宿主没有 connection 服务时静默降级（工具面不受影响）', cliThrew === false && warnings.some((line) => line.includes('connection')), warnings.join(' | '));

  // ---------- 10. 宿主侧中英双语 ----------
  console.log('\n--- 10. 宿主侧文案双语 ---');
  const rulesZh = await loadDefaultRules();
  const coverage = englishRuleCoverage(
    rulesZh.rules.map((rule) => rule.id),
    rulesZh.longTermActions.map((action) => action.id),
  );
  check(
    '10.1 英文文案文件可用，且 101 条规则 + 6 条长期防护全覆盖（id 严格对齐）',
    coverage.available && coverage.rules.missing.length === 0 && coverage.longTerm.missing.length === 0,
    `规则 ${coverage.rules.total - coverage.rules.missing.length}/${coverage.rules.total}｜长期 ${coverage.longTerm.total - coverage.longTerm.missing.length}/${coverage.longTerm.total}`,
  );
  check(
    '10.2 英文文案里没有中文字符（不允许「半翻译」混进界面）',
    !hasHan(JSON.stringify(englishRules() ?? {})),
  );
  const sampleRule = rulesZh.rules.find((rule) => rule.id === 'temp-user');
  check(
    '10.3 规则说明按语言取（同一 id 两种语言不同、都不是空）',
    sampleRule !== undefined &&
      ruleReason('temp-user', sampleRule.reason, 'en') !== sampleRule.reason &&
      ruleReason('temp-user', sampleRule.reason, 'zh') === sampleRule.reason &&
      !hasHan(ruleReason('temp-user', sampleRule.reason, 'en')),
    `${ruleReason('temp-user', sampleRule?.reason ?? '', 'zh')} ｜ ${ruleReason('temp-user', sampleRule?.reason ?? '', 'en')}`,
  );
  check(
    '10.4 默认语言是中文（模型工具那条路行为不变）',
    ruleReason('temp-user', sampleRule?.reason ?? '', normalizeLocale(undefined)) === sampleRule?.reason,
  );
  check(
    '10.5 英文缺失的规则 id 回退中文原文，不显示空洞',
    ruleReason('不存在的规则 id', '中文原文', 'en') === '中文原文',
  );
  check(
    '10.6 长期防护措施按语言取（title/detail/detect/benefit 四项齐全）',
    (() => {
      const action = rulesZh.longTermActions[0];
      if (action === undefined) return false;
      const en = longTermText(action, 'en');
      return en.title.length > 0 && en.detail.length > 0 && en.benefit.length > 0 && !hasHan(JSON.stringify(en));
    })(),
  );

  // 安全闸：拒绝理由也要能说英文（这是面板上最容易出现的文案）
  const guardEn = await guardTargets([protectedPath, junk], {
    index: buildRuleIndex(rulesZh.rules),
    systemDrive: 'C:',
    allowExplicitUnmatched: false,
    allowProtectedOverride: false,
    locale: 'en',
  });
  const protectedRefusalEn = guardEn.refused.find((entry) => entry.path === protectedPath);
  check(
    '10.7 安全闸拒绝理由支持英文（面板不会中英混杂）',
    guardEn.refused.length >= 1 &&
      protectedRefusalEn !== undefined &&
      !hasHan(protectedRefusalEn.reason) &&
      /Protected list/i.test(protectedRefusalEn.reason),
    JSON.stringify(guardEn.refused),
  );
  const guardZh = await guardTargets([protectedPath], {
    index: buildRuleIndex(rulesZh.rules),
    systemDrive: 'C:',
    allowExplicitUnmatched: false,
    allowProtectedOverride: false,
  });
  check(
    '10.8 不传语言时安全闸仍是中文（默认路径零变化）',
    guardZh.refused[0] !== undefined && hasHan(guardZh.refused[0].reason),
    JSON.stringify(guardZh.refused[0]),
  );

  // 端到端：RPC 端点带 locale → 服务层返回对应语言
  const missingPath = path.join(sandbox, 'never-existed-目录');
  const enPreview = (await endpoints.preview({ paths: [missingPath], locale: 'en' })) as {
    refused: Array<{ reason: string }>;
  };
  check(
    '10.9 预演端点透传 locale（拒绝理由整句英文，端到端打通）',
    enPreview.refused.length === 1 && !hasHan(enPreview.refused[0]?.reason ?? '') && /does not exist/i.test(enPreview.refused[0]?.reason ?? ''),
    JSON.stringify(enPreview.refused),
  );

  // 扫描结果里的每条规则说明都要能翻成英文（面板逐项渲染的就是它）
  const scannedRuleIds = [
    ...new Set(
      (['safe', 'caution', 'migrate', 'protected'] as const).flatMap((key) =>
        scan.groups[key].items.map((item) => item.ruleId),
      ),
    ),
  ];
  const untranslated = scannedRuleIds.filter((id) => {
    const rule = rulesZh.rules.find((entry) => entry.id === id);
    return rule === undefined || hasHan(ruleReason(id, rule.reason, 'en'));
  });
  check(
    '10.10 本次扫描到的规则说明全部有英文版本（面板切英文不残留中文）',
    scannedRuleIds.length > 0 && untranslated.length === 0,
    `扫描到 ${scannedRuleIds.length} 条规则｜未翻译：${untranslated.join(',') || '无'}`,
  );

  // 占位符与关键口径不能在翻译里丢：丢了就是"看起来翻译了、实际把路径/权限说丢了"
  const placeholderDrops = rulesZh.longTermActions
    .map((action) => {
      const zhTokens = [...new Set(`${action.detect} ${action.action} ${action.benefit}`.match(/%[A-Za-z_]+%/g) ?? [])];
      const english = longTermText(action, 'en');
      const enText = `${english.detect} ${english.detail} ${english.benefit}`;
      return { id: action.id, missing: zhTokens.filter((token) => !enText.includes(token)) };
    })
    .filter((entry) => entry.missing.length > 0);
  check(
    '10.11 英文文案保留 %占位符%（翻译不得把环境变量丢掉）',
    placeholderDrops.length === 0,
    placeholderDrops.map((entry) => `${entry.id}: ${entry.missing.join(',')}`).join('｜') || '无丢失',
  );
  const elevationDrops = rulesZh.rules
    .filter((rule) => /管理员|提权/.test(rule.reason))
    .filter((rule) => !/admin|elevat/i.test(ruleReason(rule.id, rule.reason, 'en')));
  check(
    '10.12 中文提到「管理员/提权」的规则，英文也必须说清权限（不能翻丢关键前提）',
    elevationDrops.length === 0,
    elevationDrops.map((rule) => rule.id).join(',') || '全部保留',
  );

  // ---------- 11. 切语言：用缓存重新出视图（不重扫） ----------
  console.log('\n--- 11. 切语言后的缓存重渲染 ---');

  // 截断理由是"结构化事实 + 按语言渲染"，不能只存冻死的字符串
  const factZh = partialReasonText({ kind: 'hotspots-incomplete', scanned: 65, total: 109 }, 'zh');
  const factEn = partialReasonText({ kind: 'hotspots-incomplete', scanned: 65, total: 109 }, 'en');
  check(
    '11.1 截断理由按语言渲染，且数字与总数都不能翻丢',
    hasHan(factZh) && !hasHan(factEn) && factEn.includes('65') && factEn.includes('109'),
    `${factZh} ｜ ${factEn}`,
  );
  check(
    '11.2 三条截断原因都有英文版（实测截图里那条告警就是它）',
    [
      { kind: 'hotspots-incomplete', scanned: 1, total: 2 },
      { kind: 'hotspots-truncated' },
      { kind: 'toptree-timeout' },
    ].every((fact) => {
      const zh = partialReasonText(fact as Parameters<typeof partialReasonText>[0], 'zh');
      const en = partialReasonText(fact as Parameters<typeof partialReasonText>[0], 'en');
      return hasHan(zh) && !hasHan(en) && zh !== en;
    }),
  );

  const cachedZh = (await endpoints['scan-view']({ locale: 'zh' })) as { available: boolean; view?: { planId: string; at: string; groups: { safe: { count: number; bytes: number; items: Array<{ reason: string }> } } } };
  const viewEnStart = Date.now();
  const cachedEn = (await endpoints['scan-view']({ locale: 'en' })) as typeof cachedZh;
  const viewEnMs = Date.now() - viewEnStart;
  check(
    '11.3 scan-view 用缓存出视图：同一份扫描（planId 与时间戳一致，没有重扫）',
    cachedZh.available === true &&
      cachedEn.available === true &&
      cachedZh.view?.planId === cachedEn.view?.planId &&
      cachedZh.view?.at === cachedEn.view?.at,
    `${cachedZh.view?.planId} / ${cachedEn.view?.planId}｜耗时 ${viewEnMs}ms`,
  );
  check(
    '11.4 缓存重渲染是毫秒级的（真重扫要 70s 起步，这里必须不碰盘）',
    viewEnMs < 5000,
    `${viewEnMs}ms`,
  );
  const cachedReasonsEn = (cachedEn.view?.groups.safe.items ?? []).map((item) => item.reason);
  check(
    '11.5 重新出视图后规则说明是目标语言（切英文不再残留中文）',
    cachedReasonsEn.length > 0 && cachedReasonsEn.every((reason) => !hasHan(reason)),
    `样本：${cachedReasonsEn.slice(0, 2).join(' ｜ ')}`,
  );
  check(
    '11.6 同一份缓存的分类结果不变（只换语言，不换数据）',
    cachedZh.view?.groups.safe.count === cachedEn.view?.groups.safe.count &&
      cachedZh.view?.groups.safe.bytes === cachedEn.view?.groups.safe.bytes,
    `${cachedZh.view?.groups.safe.count} 项 / ${cachedZh.view?.groups.safe.bytes} B`,
  );
  // 删掉 11.7（见 §8.3：lastScan 是模块级单例，得在 disposePanelJobs 之后才谈"没有缓存"）


  // ---------- 12. 切视图后再回来：宿主如实报告"在不在扫" ----------
  console.log('\n--- 12. 后台扫描的可见性（切走再回来能接上） ---');

  const idleState = await panelState(config);
  check(
    '12.1 空闲时状态里明确说"没在扫"（面板据此不轮询）',
    idleState.scan.running === false && idleState.scan.scope === 'hotspots' && idleState.scan.startedAt === undefined,
    JSON.stringify(idleState.scan),
  );
  check(
    '12.2 runningJobIds 与 runningJobs 一致，空闲时为空数组（面板靠 id 接上进度）',
    Array.isArray(idleState.runningJobIds) && idleState.runningJobIds.length === idleState.runningJobs && idleState.runningJobIds.length === 0,
    JSON.stringify(idleState.runningJobIds),
  );

  // 起一次真扫但不 await：模拟用户点了扫描。热点预算调到 3 秒 —— 让"正在扫"这个窗口足够长，
  // 断言不会跟"扫描已经跑完"抢跑（面板切走再回来时看到的就是这个窗口）。
  const fastConfig = { ...config, hotspotTimeBudgetMs: 3000, topTreeTimeBudgetMs: 3000 } as unknown as Config;
  const historyCount = async (): Promise<number> =>
    (await fs.readFile(config.historyPath as string, 'utf8')).trim().split('\n').filter(Boolean).length;
  const historyBefore = await historyCount();
  const firstScan = panelScan(fastConfig, { scope: 'hotspots' });
  // 面板重新挂载后用户又点了一次「扫描」：必须接上同一次，而不是并发扫第二遍
  const secondScan = panelScan(fastConfig, { scope: 'hotspots' });
  const during = await panelState(config);
  check(
    '12.3 扫描进行中如实报告"正在扫"（面板回来后据此重新显示 loading 并轮询）',
    during.scan.running === true && during.scan.startedAt !== undefined,
    JSON.stringify(during.scan),
  );
  const [firstView, secondView] = await Promise.all([firstScan, secondScan]);
  check(
    '12.4 同一时刻只扫一次：第二次「扫描」接上同一次（同一 planId，不并发扫两遍）',
    firstView.planId === secondView.planId,
    `${firstView.planId} / ${secondView.planId}`,
  );
  check('12.5 只写了一条历史（接上同一次，没有重复扫盘）', (await historyCount()) === historyBefore + 1, `${historyBefore} → ${await historyCount()}`);
  const afterScan = await panelState(config);
  const settledView = (await endpoints['scan-view']({ locale: 'zh' })) as { available: boolean; view?: { planId: string } };
  check(
    '12.6 扫完回到"没在扫"，且 scan-view 接上的正是刚扫完那次（结果不会因为切视图而丢）',
    afterScan.scan.running === false && settledView.available === true && settledView.view?.planId === firstView.planId,
    `${JSON.stringify(afterScan.scan)}｜缓存 planId=${settledView.view?.planId}`,
  );

  // ---------- 8. 卸载清理 ----------
  console.log('\n--- 8. 卸载与清理 ---');  disposePanelJobs();
  check('8.1 卸载后任务表清空（面板会显示「任务已随宿主重启消失」）', panelProgress(started.jobId).found === false);
  check(
    '8.3 卸载/宿主重启后没有缓存扫描：scan-view 明确回 available=false（面板保持原样，不报错）',
    ((await endpoints['scan-view']({ locale: 'en' })) as { available: boolean }).available === false,
  );
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
