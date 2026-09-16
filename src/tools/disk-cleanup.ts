/**
 * disk_cleanup 工具定义。
 *
 * 已实现动作：
 *  - `scan` / `plan`：只读扫描 → 五级分级 → 可视化 Markdown 报告（M1）
 *  - `apply` / `trash`：执行清理（M2）。**dryRun 默认开启**，必须显式传 `dryRun: false`
 *    才会真正删除；谨慎层强制逐项确认（不允许按级别批量）。
 *  - `migrate` / `rollback`：M3 实现，当前返回 not-implemented。
 *
 * 三个易错点（务必保持）：
 *  1. `parameters` 与 `output.schema` 用的是同一套 DSH schema DSL：requiredness 写在
 *     每个属性上的 `required: true`，显式 object 必须声明 `additionalProperties`。
 *  2. `output.render` 必须是纯函数（直播与回放都会执行）：禁止 I/O、时钟、随机。
 *  3. `apply` 的 `dryRun` 默认必须是 true——安全默认值不能靠调用方自觉。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { classify } from '../classifier/index.js';
import type { Config } from '../config.js';
import { executeCleanup } from '../executor/index.js';
import type { ExecutedItem, ExecuteReport } from '../executor/index.js';
import { guardTargets } from '../executor/safety.js';
import {
  appendHistory,
  computeTrend,
  defaultHistoryPath,
  historyEntryFromPlan,
  previousScan,
  readHistory,
  recentAlerts,
} from '../history/index.js';
import { renderJsonReport } from '../report/json.js';
import { describeSchedule } from '../scheduler/index.js';
import {
  MIGRATION_LEDGER_FILE,
  activeMigrations,
  appendLedger,
  migrateByJunction,
  readLedger,
  rollbackMigration,
  toLedgerEntry,
} from '../migrator/index.js';
import type { MigrateOutcome } from '../migrator/index.js';
import { buildPlan } from '../planner/index.js';
import { renderExecutionReport } from '../report/execution.js';
import { renderReport } from '../report/markdown.js';
import { loadRules } from '../rules/load.js';
import { buildRuleIndex, pickWinner } from '../rules/match.js';
import type { DriveInfo, RuleSet } from '../rules/schema.js';
import { freeSpaceOf, listDrives, pickMigrationTarget } from '../scanner/drives.js';
import { scanSystem } from '../scanner/index.js';
import { formatBytes, formatGB, nowStamp, shortPath } from '../util/format.js';

const ACTIONS = ['scan', 'plan', 'apply', 'migrate', 'rollback', 'trash'] as const;
type Action = (typeof ACTIONS)[number];

const READ_ONLY: readonly Action[] = ['scan', 'plan'];
const EXECUTING: readonly Action[] = ['apply', 'trash'];

interface BigItemView {
  path: string;
  sizeBytes: number;
  grade: string;
  reason: string;
}

interface DriveView {
  letter: string;
  totalBytes: number;
  freeBytes: number;
}

interface ExecItemView {
  path: string;
  action: string;
  sizeBefore: number;
  freedBytes: number;
  reason: string;
}

interface ExecutionView {
  mode: string;
  dryRun: boolean;
  freedBytes: number;
  measuredFreedBytes: number;
  plannedBytes: number;
  reportPath: string;
  deletedCount: number;
  trashedCount: number;
  plannedCount: number;
  refusedCount: number;
  partialCount: number;
  elevationCount: number;
  elevationCanceled: boolean;
  migratedCount: number;
  rolledBackCount: number;
  items: ExecItemView[];
}

interface TrendView {
  previousAt: string;
  hoursAgo: number;
  freeDeltaBytes: number;
  grownCount: number;
  shrunkCount: number;
  /** 人类可读的「增长最多」摘要，例如 `~\AppData\...\upgrade +1.93 GB` */
  topGrowth: string;
}

interface DiskCleanupOutput {
  action: Action;
  status: 'ok' | 'dry-run' | 'executed' | 'not-implemented';
  planId: string;
  reportPath: string;
  scannedAt: string;
  durationMs: number;
  partial: boolean;
  systemDrive: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  safeBytes: number;
  cautionBytes: number;
  migrateBytes: number;
  safeCount: number;
  cautionCount: number;
  migrateCount: number;
  protectedCount: number;
  longTermCount: number;
  bigItems: BigItemView[];
  drives: DriveView[];
  /** 迁移目标盘，如 "D:\\"；无其他盘时为空串 */
  migrationTarget: string;
  /** app-config 类迁移规则给出的建议命令（只提示，不自动改配置） */
  migrationAdvice?: string[];
  /** 扫描历史文件（每次扫描追加一条，用于趋势对比） */
  historyPath: string;
  /** JSON 报告路径（format=json / both 时产出） */
  reportJsonPath?: string;
  /** 定时扫描状态描述 */
  schedule?: string;
  /** 最近的空间告警（由定时扫描写入历史） */
  alerts?: string[];
  /** 与上一次扫描的对比（首次扫描时无此字段） */
  trend?: TrendView;
  execution?: ExecutionView;
  message?: string;
}

const baseOutput = (action: Action): DiskCleanupOutput => ({
  action,
  status: 'ok',
  planId: '',
  reportPath: '',
  scannedAt: new Date(0).toISOString(),
  durationMs: 0,
  partial: false,
  systemDrive: '',
  totalBytes: 0,
  usedBytes: 0,
  freeBytes: 0,
  safeBytes: 0,
  cautionBytes: 0,
  migrateBytes: 0,
  safeCount: 0,
  cautionCount: 0,
  migrateCount: 0,
  protectedCount: 0,
  longTermCount: 0,
  bigItems: [],
  drives: [],
  migrationTarget: '',
  historyPath: '',
});

const unavailable = (action: Action, message: string): DiskCleanupOutput => ({
  ...baseOutput(action),
  status: 'not-implemented',
  message,
});

/**
 * 组装 M4 的可选输出字段：**只把「有值」的键放进去**。
 *
 * 宿主的输出校验要求返回值是 lossless JSON，而 `JSON.stringify` 会丢掉值为
 * `undefined` 的键——于是「键存在、值是 undefined」会被判为不合法，整次调用报错
 * （宿主实测：首次扫描没有上一次基准 → `trend: undefined` → `value is not lossless JSON`）。
 * 所以这条规则不能靠自觉，集中到一个函数里并由测试锁住。
 */
export function optionalFields(input: {
  historyPath?: string;
  reportJsonPath?: string;
  schedule?: string;
  alerts?: string[];
  trend?: TrendView;
}): Partial<DiskCleanupOutput> {
  const out: Partial<DiskCleanupOutput> = {};
  if (input.historyPath !== undefined) out.historyPath = input.historyPath;
  if (input.reportJsonPath !== undefined) out.reportJsonPath = input.reportJsonPath;
  if (input.schedule !== undefined) out.schedule = input.schedule;
  // 空数组也是合法 JSON，但「没有告警」时省略该键，输出更干净
  if (input.alerts !== undefined && input.alerts.length > 0) out.alerts = input.alerts;
  if (input.trend !== undefined) out.trend = input.trend;
  return out;
}

/**
 * 报告的默认落盘目录。
 *
 * 优先用**会话工作目录**（用户正在看的那个目录），而不是宿主的 `process.cwd()`
 * ——实测宿主 cwd 是用户主目录，报告会掉进 `C:\Users\<你>\` 而不是工作区。
 * 会话目录取值走 `exec.agent.session.meta.cwd`（dsh-agent 的会话元数据），
 * 任何一环缺失都退化到宿主 cwd，绝不因为取不到路径而失败。
 */
export function outputDir(config: Config, exec?: ToolRunContext): string {
  if (config.reportDir) return config.reportDir;
  const sessionCwd = (exec?.agent as { session?: { meta?: { cwd?: unknown } } } | undefined)?.session?.meta?.cwd;
  if (typeof sessionCwd === 'string' && sessionCwd.length > 0) return sessionCwd;
  return process.cwd();
}

/** 面向模型/人的紧凑摘要（纯函数） */
function describeOutput(value: DiskCleanupOutput): string {
  if (value.status === 'not-implemented') {
    return `${value.action}：${value.message ?? '尚未实现'}`;
  }

  if (value.execution) {
    const e = value.execution;
    const lines = [
      e.dryRun ? '【dryRun】C 盘清理预演完成 —— 未删除任何文件' : `C 盘清理完成（${e.mode === 'trash' ? '暂存区模式' : '永久删除'}）`,
      `系统盘 ${value.systemDrive}：剩余 ${formatGB(value.freeBytes)} / 共 ${formatGB(value.totalBytes)}`,
      e.dryRun
        ? `计划处理：${formatBytes(e.plannedBytes)}（${e.items.length} 项）`
        : `逐项测量合计释放：${formatBytes(e.measuredFreedBytes)}（盘符空闲净增 ${formatBytes(e.freedBytes)}）`,
      `结果：已删除 ${e.deletedCount} ｜ 入暂存区 ${e.trashedCount} ｜ 已迁移 ${e.migratedCount} ｜ 已回滚 ${e.rolledBackCount} ｜ 部分完成 ${e.partialCount} ｜ 已拒绝 ${e.refusedCount}${
        e.elevationCount > 0 ? ` ｜ 管理员级任务 ${e.elevationCount}` : ''
      }`,
    ];
    if (e.elevationCanceled) lines.push('⚠️ 用户取消了 UAC 授权，管理员级清理未执行。');
    if (e.items.length > 0) {
      lines.push('', '逐项结果：');
      for (const item of e.items.slice(0, 20)) {
        lines.push(`  [${item.action}] ${shortPath(item.path)} → ${item.reason.slice(0, 60)}`);
      }
      if (e.items.length > 20) lines.push(`  …另有 ${e.items.length - 20} 项，详见报告`);
    }
    lines.push('', `执行报告：${e.reportPath}`);
    if (value.migrationAdvice && value.migrationAdvice.length > 0) {
      lines.push('', '建议同时把应用配置指向新路径（插件不自动改配置，请用户确认后执行）：');
      for (const tip of value.migrationAdvice) lines.push(`  ${tip}`);
    }
    if (e.dryRun) lines.push('', '如需真正执行：请在用户确认后以 dryRun: false 重新调用。');
    return lines.join('\n');
  }

  const lines = [
    `C 盘清理扫描完成（${value.planId}）`,
    `系统盘 ${value.systemDrive}：剩余 ${formatGB(value.freeBytes)} / 共 ${formatGB(value.totalBytes)}`,
    `可释放潜力：🟢 安全 ${formatBytes(value.safeBytes)}（${value.safeCount} 项）｜ 🟡 谨慎 ${formatBytes(
      value.cautionBytes,
    )}（${value.cautionCount} 项）｜ 🟠 可迁移 ${formatBytes(value.migrateBytes)}（${value.migrateCount} 项）`,
  ];
  if (value.migrationTarget) lines.push(`迁移目标盘建议：${value.migrationTarget}`);
  if (value.alerts && value.alerts.length > 0) {
    lines.push('', '🔔 空间告警（定时扫描写入）：');
    for (const alert of value.alerts) lines.push(`  ${alert}`);
  }
  if (value.trend) {
    const sign = value.trend.freeDeltaBytes >= 0 ? '+' : '−';
    lines.push(
      '',
      `📈 与上一次扫描（${value.trend.hoursAgo} 小时前）：剩余空间 ${sign}${formatBytes(
        Math.abs(value.trend.freeDeltaBytes),
      )} ｜ 长回来 ${value.trend.grownCount} 项 ｜ 被释放 ${value.trend.shrunkCount} 项 ｜ 增长最多：${value.trend.topGrowth}`,
    );
  }
  if (value.bigItems.length > 0) {
    lines.push('', `大头占用（Top ${value.bigItems.length}）`);
    for (const item of value.bigItems) {
      lines.push(`  ${formatBytes(item.sizeBytes).padStart(9)}  [${item.grade}] ${shortPath(item.path)}`);
    }
  }
  lines.push('', `长期防护措施：${value.longTermCount} 项`, `可视化报告：${value.reportPath}`);
  if (value.reportJsonPath) lines.push(`JSON 报告：${value.reportJsonPath}`);
  if (value.historyPath) lines.push(`历史记录：${value.historyPath}（趋势对比数据源）`);
  if (value.schedule) lines.push(`定时扫描：${value.schedule}`);
  if (value.partial) lines.push('', '⚠️ 扫描超时被截断，列表可能不完整。');
  return lines.join('\n');
}

export function registerDiskCleanupTool(ctx: Context, config: Config): void {
  ctx.tools.register(
    defineTool({
      name: 'disk_cleanup',
      description:
        '扫描并清理 Windows 系统盘（C 盘）。流程：扫描占用 → 五级分级（🟢可安全删除 / 🟡谨慎删除 / 🟠建议迁移 / 🔴保护名单 / 🔵长期防护）→ 生成可视化 Markdown 报告 → 用户确认后分层执行。' +
        'action=scan/plan 只读扫描；action=apply 执行清理、action=trash 移动到其他盘暂存区（可恢复）。' +
        'apply/trash 默认 dryRun=true，只列动作不删文件；正确用法是先 scan、把报告交给用户、拿到用户对具体条目的确认，再用 dryRun:false 执行；谨慎层（caution）必须把用户逐项确认的路径放进 items，不允许按级别批量。' +
        '保护名单是硬约束：用户文档、凭据、虚拟磁盘、聊天数据、IDE 配置、未收录规则库的路径一律拒绝执行，即使用户点名也不删。' +
        '需要管理员权限的项（Windows\\Temp、SoftwareDistribution、WinSxS 的 DISM 清理、cleanmgr）会走 UAC 提权，用户拒绝授权时如实回报而非谎报成功。' +
        '用户有多个盘时优先建议迁移而不是删除：action=migrate 把目录搬到其他盘并在原位置留下目录联接（应用无感），台账可查、action=rollback 可搬回；迁移同样默认 dryRun，且是「先复制、校验、再删源、最后建联接」，中途失败会回滚副本、不留半迁移状态。' +
        '每次扫描都会追加一条历史并据此给出与上一次的趋势对比（谁在长回来、上一轮清理有没有用）；format=json 可另出机器可读报告供 GUI/脚本/监控消费。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: [...ACTIONS],
          description:
            'scan=只读扫描并生成报告；plan=同 scan 并返回完整方案；apply=按用户选择执行清理；trash=移动到暂存区；migrate=迁移到其他盘（M3）；rollback=回滚迁移（M3）',
        },
        scope: {
          type: 'string',
          enum: ['hotspots', 'full'],
          description: '扫描范围：hotspots=仅规则热点清单（快）；full=热点 + 全盘 Top-N 大目录（默认）',
        },
        reportPath: {
          type: 'string',
          description: '报告文件输出路径，缺省为「工作目录/C盘清理报告-<时间戳>.md」',
        },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: '要执行清理的具体路径（谨慎层必填；只接受用户逐项确认过的路径）',
        },
        grade: {
          type: 'string',
          enum: ['safe', 'caution', 'migrate'],
          description: '按层级选择范围：safe=安全层（可批量）；caution=谨慎层（必须同时给出 items 逐项确认）；migrate=迁移层（M3）',
        },
        mode: {
          type: 'string',
          enum: ['permanent', 'trash'],
          description: '删除模式：trash=移动到其他盘暂存区（可恢复，默认）；permanent=永久删除（需用户明确同意）',
        },
        trashPath: {
          type: 'string',
          description: '暂存区路径，必须位于其他盘（同盘移动不释放空间）；缺省为 <空闲最大的非系统盘>:\\to_delete',
        },
        dryRun: {
          type: 'boolean',
          description: '预演模式，默认 true：只列出将要执行的动作，不删除任何文件。只有用户明确确认后才传 false。',
        },
        elevation: {
          type: 'string',
          enum: ['none', 'dism', 'cleanmgr', 'dism+cleanmgr'],
          description: '是否一并触发管理员级系统清理：dism=组件存储清理（WinSxS）；cleanmgr=系统磁盘清理',
        },
        targetDrive: {
          type: 'string',
          description: '迁移目标盘（如 D:）；缺省自动选空闲最大的非系统盘',
        },
        extraRulesFile: { type: 'string', description: '本次扫描使用的附加规则文件路径' },
        format: {
          type: 'string',
          enum: ['markdown', 'json', 'both'],
          description:
            '报告格式（M4）：markdown=可视化报告；json=机器可读报告（给 GUI / 脚本 / 监控用）；both=两份都出。缺省取配置 defaultReportFormat',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            status: { type: 'string', required: true },
            planId: { type: 'string', required: true },
            reportPath: { type: 'string', required: true },
            scannedAt: { type: 'string', required: true },
            durationMs: { type: 'number', required: true },
            partial: { type: 'boolean', required: true },
            systemDrive: { type: 'string', required: true },
            totalBytes: { type: 'number', required: true },
            usedBytes: { type: 'number', required: true },
            freeBytes: { type: 'number', required: true },
            safeBytes: { type: 'number', required: true },
            cautionBytes: { type: 'number', required: true },
            migrateBytes: { type: 'number', required: true },
            safeCount: { type: 'number', required: true },
            cautionCount: { type: 'number', required: true },
            migrateCount: { type: 'number', required: true },
            protectedCount: { type: 'number', required: true },
            longTermCount: { type: 'number', required: true },
            bigItems: {
              type: 'array',
              required: true,
              description: '大头占用 Top-N（含各自分级与判定理由）',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  sizeBytes: { type: 'number', required: true },
                  grade: { type: 'string', required: true },
                  reason: { type: 'string', required: true },
                },
              },
            },
            drives: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  letter: { type: 'string', required: true },
                  totalBytes: { type: 'number', required: true },
                  freeBytes: { type: 'number', required: true },
                },
              },
            },
            migrationTarget: { type: 'string' },
            historyPath: {
              type: 'string',
              required: true,
              description: '扫描历史文件（每次扫描追加一条，用于趋势对比）',
            },
            reportJsonPath: { type: 'string', description: 'JSON 报告路径（format=json / both 时产出）' },
            schedule: { type: 'string', description: '定时扫描状态描述' },
            alerts: {
              type: 'array',
              description: '最近的空间告警（由定时扫描写入历史）',
              items: { type: 'string' },
            },
            trend: {
              type: 'object',
              additionalProperties: false,
              description: '与上一次扫描的对比（首次扫描时无此字段）',
              properties: {
                previousAt: { type: 'string', required: true },
                hoursAgo: { type: 'number', required: true },
                freeDeltaBytes: { type: 'number', required: true },
                grownCount: { type: 'number', required: true },
                shrunkCount: { type: 'number', required: true },
                topGrowth: { type: 'string', required: true },
              },
            },
            migrationAdvice: {
              type: 'array',
              description: '迁移时给出的建议命令（例如把应用缓存配置指向新路径），仅提示、不自动改配置',
              items: { type: 'string' },
            },
            execution: {
              type: 'object',
              additionalProperties: false,
              description: 'apply / trash 的执行结果（scan / plan 不返回该字段）',
              properties: {
                mode: { type: 'string', required: true },
                dryRun: { type: 'boolean', required: true },
                freedBytes: { type: 'number', required: true },
                measuredFreedBytes: {
                  type: 'number',
                  required: true,
                  description: '逐项测量合计释放量；清理量较小时比盘符空闲净增更可信',
                },
                plannedBytes: { type: 'number', required: true },
                reportPath: { type: 'string', required: true },
                deletedCount: { type: 'number', required: true },
                trashedCount: { type: 'number', required: true },
                plannedCount: { type: 'number', required: true },
                refusedCount: { type: 'number', required: true },
                partialCount: { type: 'number', required: true },
                elevationCount: { type: 'number', required: true },
                elevationCanceled: { type: 'boolean', required: true },
                migratedCount: { type: 'number', required: true },
                rolledBackCount: { type: 'number', required: true },
                items: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      path: { type: 'string', required: true },
                      action: { type: 'string', required: true },
                      sizeBefore: { type: 'number', required: true },
                      freedBytes: { type: 'number', required: true },
                      reason: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
            message: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: describeOutput(value as DiskCleanupOutput) }],
      },
      timeoutMs: 900_000,
      presentCall: (args) => ({
        card: 'generic',
        title: READ_ONLY.includes(args.action as Action)
          ? '扫描 C 盘占用'
          : `${args.dryRun === false ? '' : '预演：'}C 盘清理（${args.action}）`,
        kind: 'other',
      }),
      async execute(args, exec: ToolRunContext): Promise<DiskCleanupOutput> {
        const action = args.action as Action;
        const started = Date.now();
        const scope = (args.scope as 'hotspots' | 'full' | undefined) ?? config.defaultScope;

        const { ruleSet, warnings } = await loadRules({
          extraRulesFile: args.extraRulesFile ?? config.extraRulesFile,
          allowProtectedOverride: config.allowProtectedOverride,
        });
        if (warnings.length > 0) console.warn(`windows-c-cleanup: ${warnings.join('; ')}`);
        const index = buildRuleIndex(ruleSet.rules);
        const drives = await listDrives();
        const systemDrive = drives.find((d) => d.isSystem)?.letter ?? 'C';

        // 迁移层（M3）：migrate / rollback —— 在做任何扫描之前分流
        if (action === 'migrate' || action === 'rollback') {
          return runMigrationAction({ action, args, config, ruleSet, index, drives, systemDrive, exec, started });
        }

        if (READ_ONLY.includes(action)) {
          return runScan({ action, scope, args, config, ruleSet, index, drives, exec, started });
        }
        if (!EXECUTING.includes(action)) {
          return unavailable(action, `未知动作 ${action}`);
        }

        const requestedGrade = args.grade as 'safe' | 'caution' | 'migrate' | undefined;
        if (requestedGrade === 'migrate') {
          return unavailable(
            action,
            '迁移层请用 action=migrate（把目录搬到其他盘并在原位置保留目录联接），不要用 apply 删除它。',
          );
        }

        const targets: string[] = Array.isArray(args.items) ? [...args.items] : [];
        const knownSizes: Record<string, number> = {};
        let planId = '';

        if (requestedGrade !== undefined) {
          if (requestedGrade === 'caution' && targets.length === 0) {
            return unavailable(
              action,
              '谨慎层必须逐项确认：请把用户逐项确认过的路径放进 items（不允许按级别批量删谨慎层），或改用 grade=safe 处理安全层。',
            );
          }
          const scan = await scanSystem(
            ruleSet,
            {
              hotspotTimeBudgetMs: config.hotspotTimeBudgetMs,
              topTree: {
                enabled: scope === 'full',
                maxDepth: config.topTreeMaxDepth,
                timeBudgetMs: config.topTreeTimeBudgetMs,
              },
              signal: exec.signal,
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
            stats: {
              durationMs: scan.stats.durationMs,
              hotspotCount: scan.stats.hotspotCount,
              hotspotScanned: scan.stats.hotspotScanned,
              hotspotTotal: scan.stats.hotspotTotal,
              topTreeDirs: scan.stats.topTreeDirs,
              topTreePartial: scan.stats.topTreePartial,
              partialReasons: scan.stats.partialReasons,
            },
          });
          planId = plan.id;
          for (const item of classified) {
            if (item.grade === requestedGrade) {
              targets.push(item.path);
              knownSizes[item.path] = item.sizeBytes;
            }
          }
        }

        if (targets.length === 0) {
          return {
            ...baseOutput(action),
            status: 'not-implemented',
            systemDrive,
            drives: drives.map<DriveView>((d) => ({ letter: d.letter, totalBytes: d.totalBytes, freeBytes: d.freeBytes })),
            message:
              '没有可执行的清理目标：请提供 items（用户确认过的具体路径）或 grade=safe（安全层批量）。建议先执行 scan 并把报告交给用户确认。',
          };
        }

        const mode =
          action === 'trash' ? 'trash' : ((args.mode as 'permanent' | 'trash' | undefined) ?? config.defaultDeleteMode);
        const dryRun = args.dryRun !== false; // 安全默认：必须显式传 false 才真删

        const targetDrive = pickMigrationTarget(drives);
        const trashPath =
          args.trashPath ?? config.trashPath ?? (targetDrive ? `${targetDrive.letter}:\\to_delete` : undefined);

        if (mode === 'trash' && !trashPath) {
          return unavailable(
            action,
            '暂存区模式需要另一个盘：未检测到非系统盘，且未提供 trashPath。如确认永久删除，请显式传 mode=permanent 并取得用户同意。',
          );
        }

        const elevationFlag = (args.elevation as string | undefined) ?? 'none';
        const report = await executeCleanup({
          targets,
          mode,
          trashPath,
          dryRun,
          systemDrive,
          index,
          allowExplicitUnmatched: config.allowExplicitUnmatched,
          allowProtectedOverride: config.allowProtectedOverride,
          knownSizes,
          elevation: {
            dism: elevationFlag === 'dism' || elevationFlag === 'dism+cleanmgr',
            cleanmgr: elevationFlag === 'cleanmgr' || elevationFlag === 'dism+cleanmgr',
          },
          signal: exec.signal,
        });

        const execReportPath = path.join(outputDir(config, exec), `C盘清理执行报告-${nowStamp()}.md`);
        await fs.mkdir(path.dirname(execReportPath), { recursive: true });
        await fs.writeFile(execReportPath, renderExecutionReport(report), 'utf8');

        const countOf = (name: string): number => report.items.filter((item) => item.action === name).length;
        const execution: ExecutionView = {
          mode: report.mode,
          dryRun: report.dryRun,
          freedBytes: report.freedBytes,
          measuredFreedBytes: report.measuredFreedBytes,
          plannedBytes: report.plannedBytes,
          reportPath: execReportPath,
          deletedCount: countOf('deleted'),
          trashedCount: countOf('trashed'),
          plannedCount: countOf('planned'),
          refusedCount: countOf('refused'),
          partialCount: countOf('partial') + countOf('failed'),
          elevationCount: report.elevationTasks.length,
          elevationCanceled: report.elevation?.canceled === true,
          migratedCount: 0,
          rolledBackCount: 0,
          items: report.items.map<ExecItemView>((item) => ({
            path: item.path,
            action: item.action,
            sizeBefore: item.sizeBefore,
            freedBytes: item.freedBytes,
            reason: item.reason,
          })),
        };

        const system = drives.find((d) => d.isSystem);
        return {
          ...baseOutput(action),
          status: dryRun ? 'dry-run' : 'executed',
          planId,
          systemDrive,
          totalBytes: system?.totalBytes ?? 0,
          usedBytes: Math.max(0, (system?.totalBytes ?? 0) - report.freeAfterBytes),
          freeBytes: report.freeAfterBytes,
          drives: drives.map<DriveView>((d) => ({ letter: d.letter, totalBytes: d.totalBytes, freeBytes: d.freeBytes })),
          migrationTarget: targetDrive ? `${targetDrive.letter}:\\` : '',
          durationMs: Date.now() - started,
          partial: report.partial,
          execution,
        };
      },
    }),
  );
}

/** 只读扫描分支（M1 行为，保持不变） */
async function runScan(input: {
  action: Action;
  scope: 'hotspots' | 'full';
  args: Record<string, unknown>;
  config: Config;
  ruleSet: RuleSet;
  index: ReturnType<typeof buildRuleIndex>;
  drives: DriveInfo[];
  exec: ToolRunContext;
  started: number;
}): Promise<DiskCleanupOutput> {
  const { action, scope, args, config, ruleSet, index, exec, started } = input;
  const scan = await scanSystem(
    ruleSet,
    {
      hotspotTimeBudgetMs: config.hotspotTimeBudgetMs,
      topTree: {
        enabled: scope === 'full',
        maxDepth: config.topTreeMaxDepth,
        timeBudgetMs: config.topTreeTimeBudgetMs,
      },
      signal: exec.signal,
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
    stats: {
      durationMs: scan.stats.durationMs,
      hotspotCount: scan.stats.hotspotCount,
      hotspotScanned: scan.stats.hotspotScanned,
      hotspotTotal: scan.stats.hotspotTotal,
      topTreeDirs: scan.stats.topTreeDirs,
      topTreePartial: scan.stats.topTreePartial,
      partialReasons: scan.stats.partialReasons,
    },
  });

  // ── M4：写历史 → 算趋势 → 按格式出报告 ────────────────────────────────
  const historyPath = config.historyPath ?? defaultHistoryPath();
  const entry = historyEntryFromPlan(plan, scope, Date.now() - started);
  await appendHistory(historyPath, entry);
  const history = await readHistory(historyPath, 200);
  const previous = previousScan(history, entry.id);
  const trend = previous ? computeTrend(previous, entry) : undefined;
  const alerts = recentAlerts(history, 3).map(
    (alert) => `${alert.at.slice(0, 16).replace('T', ' ')} ${alert.message ?? ''}`.trim(),
  );
  const schedule = describeSchedule(config.schedule);

  const format = (args.format as 'markdown' | 'json' | 'both' | undefined) ?? config.defaultReportFormat;
  const requested = args.reportPath as string | undefined;
  const defaultBase = path.join(outputDir(config, exec), `C盘清理报告-${nowStamp()}`);
  // reportPath 指向 .md 时，附带的 JSON 报告换同名的 .json；只出 JSON 时直接用该路径
  const markdownPath = requested ?? `${defaultBase}.md`;
  const jsonPath = requested
    ? requested.toLowerCase().endsWith('.md')
      ? `${requested.slice(0, -3)}.json`
      : requested.toLowerCase().endsWith('.json')
        ? requested
        : `${requested}.json`
    : `${defaultBase}.json`;

  let reportPath = '';
  if (format === 'markdown' || format === 'both') {
    await fs.mkdir(path.dirname(markdownPath), { recursive: true });
    await fs.writeFile(
      markdownPath,
      renderReport(plan, { reportPath: markdownPath, trend, alerts, historyPath, scheduler: schedule }),
      'utf8',
    );
    reportPath = markdownPath;
  }
  let reportJsonPath: string | undefined;
  if (format === 'json' || format === 'both') {
    await fs.mkdir(path.dirname(jsonPath), { recursive: true });
    await fs.writeFile(
      jsonPath,
      renderJsonReport(plan, {
        generatedAt: new Date().toISOString(),
        trend,
        alerts,
        historyPath,
        scheduler: schedule,
      }),
      'utf8',
    );
    reportJsonPath = jsonPath;
    if (!reportPath) reportPath = jsonPath;
  }

  const aboveThreshold = plan.bigItems.filter((item) => item.sizeBytes >= config.bigItemThresholdBytes);
  const bigItems = (aboveThreshold.length > 0 ? aboveThreshold : plan.bigItems.slice(0, 12)).map<BigItemView>(
    (item) => ({ path: item.path, sizeBytes: item.sizeBytes, grade: item.grade, reason: item.reason }),
  );

  return {
    ...baseOutput(action),
    status: 'ok',
    planId: plan.id,
    reportPath,
    ...optionalFields({
      historyPath,
      reportJsonPath,
      schedule,
      alerts,
      trend: trend
        ? {
            previousAt: trend.previousAt,
            hoursAgo: trend.hoursAgo,
            freeDeltaBytes: trend.freeDeltaBytes,
            grownCount: trend.grown.length,
            shrunkCount: trend.shrunk.length,
            topGrowth:
              trend.grown.length > 0
                ? `${shortPath(trend.grown[0].path, 48)} +${formatBytes(trend.grown[0].deltaBytes)}`
                : '无显著增长',
          }
        : undefined,
    }),
    scannedAt: plan.createdAt,
    durationMs: Date.now() - started,
    partial: plan.partial,
    systemDrive: plan.drives.find((d) => d.isSystem)?.letter ?? '',
    totalBytes: plan.summary.totalBytes,
    usedBytes: plan.summary.usedBytes,
    freeBytes: plan.summary.freeBytes,
    safeBytes: plan.summary.safeBytes,
    cautionBytes: plan.summary.cautionBytes,
    migrateBytes: plan.summary.migrateBytes,
    safeCount: plan.groups.safe.length,
    cautionCount: plan.groups.caution.length,
    migrateCount: plan.groups.migrate.length,
    protectedCount: plan.groups.protected.length,
    longTermCount: plan.longTerm.length,
    bigItems,
    drives: plan.drives.map<DriveView>((d) => ({ letter: d.letter, totalBytes: d.totalBytes, freeBytes: d.freeBytes })),
    migrationTarget: plan.migrationTarget ? `${plan.migrationTarget.letter}:\\` : '',
  };
}

/** 迁移结果 → 执行报告中的一行 */
function migrationRow(outcome: MigrateOutcome, ruleId: string, source: string, destination: string): ExecutedItem {
  const action: ExecutedItem['action'] =
    outcome.status === 'migrated'
      ? 'migrated'
      : outcome.status === 'rolled-back'
        ? 'rolled-back'
        : outcome.status === 'planned'
          ? 'planned'
          : outcome.status === 'source-busy'
            ? 'partial'
            : 'failed';

  const statusText: Record<string, string> = {
    migrated: '已迁移并在原位置建立目录联接',
    'rolled-back': '已搬回原位置并删除联接',
    planned: '计划执行（dryRun，未改动数据）',
    'destination-exists': '目标已存在，未执行（不做合并）',
    'insufficient-space': '目标盘空间不足，未执行',
    'source-busy': '源目录被占用，未迁移；已回滚副本，原状态不变',
    'verify-failed': '校验失败，已回滚',
    failed: '执行失败',
  };

  const detail = [...outcome.journal.slice(-2), ...outcome.errors].join('；').replace(/\|/g, '/');
  return {
    path: source,
    ruleId,
    action,
    sizeBefore: outcome.sizeBytes,
    freedBytes: outcome.freedBytes,
    remainingBytes: 0,
    reason: `${statusText[outcome.status] ?? outcome.status}${detail ? `｜${detail}` : ''}`,
    movedTo: destination,
  };
}

/** 迁移 / 回滚分支（M3） */
async function runMigrationAction(input: {
  action: Action;
  args: Record<string, unknown>;
  config: Config;
  ruleSet: RuleSet;
  index: ReturnType<typeof buildRuleIndex>;
  drives: DriveInfo[];
  systemDrive: string;
  exec: ToolRunContext;
  started: number;
}): Promise<DiskCleanupOutput> {
  const { action, args, config, ruleSet, index, drives, systemDrive, exec, started } = input;
  const dryRun = args.dryRun !== false; // 迁移同样默认预演
  const requested = args.targetDrive as string | undefined;
  const targetDrive = requested
    ? drives.find((d) => d.letter === requested.replace(/[^a-zA-Z]/g, '').slice(0, 1).toUpperCase())
    : pickMigrationTarget(drives);

  if (!targetDrive) {
    return {
      ...baseOutput(action),
      status: 'not-implemented',
      systemDrive,
      drives: drives.map<DriveView>((d) => ({ letter: d.letter, totalBytes: d.totalBytes, freeBytes: d.freeBytes })),
      message: `迁移需要另一个盘${requested ? `（指定的 ${requested} 不存在或不可用）` : ''}：未检测到非系统盘。`,
    };
  }
  if (targetDrive.letter.toUpperCase() === systemDrive.toUpperCase()) {
    return {
      ...baseOutput(action),
      status: 'not-implemented',
      systemDrive,
      message: '迁移目标不能是系统盘本身：同盘迁移不会释放空间。',
    };
  }

  const targetRoot = config.migrationRoot ?? `${targetDrive.letter}:\\dsh-cc-migrated`;
  const ledgerPath = path.join(targetRoot, MIGRATION_LEDGER_FILE);
  const systemRoot = `${systemDrive}:\\`;
  const freeBefore = await freeSpaceOf(systemRoot);
  const startedAt = new Date().toISOString();
  const items: ExecutedItem[] = [];
  const errors: string[] = [];
  const advice: string[] = [];

  if (action === 'rollback') {
    const entries = await readLedger(ledgerPath);
    const wanted =
      Array.isArray(args.items) && args.items.length > 0
        ? new Set(args.items.map((item) => String(item).toLowerCase()))
        : undefined;
    const active = activeMigrations(entries).filter((entry) => !wanted || wanted.has(entry.source.toLowerCase()));
    if (active.length === 0) {
      return {
        ...baseOutput(action),
        status: 'not-implemented',
        systemDrive,
        message: `没有可回滚的迁移记录（台账：${ledgerPath}）。`,
      };
    }
    for (const entry of active) {
      const outcome = await rollbackMigration(entry, { dryRun, signal: exec.signal });
      if (outcome.status === 'rolled-back') await appendLedger(ledgerPath, toLedgerEntry(outcome, entry.ruleId));
      items.push(migrationRow(outcome, entry.ruleId ?? 'migrated', entry.source, entry.destination));
      errors.push(...outcome.errors);
    }
  } else {
    const sources: string[] = Array.isArray(args.items) ? [...args.items] : [];
    if (args.grade === 'migrate') {
      const scan = await scanSystem(
        ruleSet,
        {
          hotspotTimeBudgetMs: config.hotspotTimeBudgetMs,
          topTree: {
            enabled: (args.scope as string | undefined ?? config.defaultScope) === 'full',
            maxDepth: config.topTreeMaxDepth,
            timeBudgetMs: config.topTreeTimeBudgetMs,
          },
          signal: exec.signal,
        },
        index,
      );
      const classified = classify(scan.items, ruleSet.rules, index, {
        allowProtectedOverride: config.allowProtectedOverride,
      });
      for (const item of classified) if (item.grade === 'migrate') sources.push(item.path);
    }
    if (sources.length === 0) {
      return {
        ...baseOutput(action),
        status: 'not-implemented',
        systemDrive,
        message:
          '没有迁移目标：请提供 items（用户确认过的目录）或 grade=migrate（自动挑选规则库里的迁移层）。建议先 scan 并把报告的 🟠 迁移清单交给用户确认。',
      };
    }

    const guards = await guardTargets(sources, {
      index,
      systemDrive,
      allowExplicitUnmatched: config.allowExplicitUnmatched,
      allowProtectedOverride: config.allowProtectedOverride,
    });
    for (const refused of guards.refused) {
      items.push({
        path: refused.path,
        ruleId: refused.ruleId,
        action: 'refused',
        sizeBefore: 0,
        freedBytes: 0,
        remainingBytes: 0,
        reason: refused.reason,
      });
    }
    for (const allowed of guards.allowed) {
      const rule = pickWinner(allowed.path, index)?.rule;
      const outcome = await migrateByJunction(allowed.path, {
        targetRoot,
        dryRun,
        ruleId: rule?.id,
        method: rule?.migrate?.method ?? 'junction',
        advice: rule?.migrate?.configHint ? [rule.migrate.configHint] : [],
        signal: exec.signal,
      });
      if (outcome.status === 'migrated') await appendLedger(ledgerPath, toLedgerEntry(outcome, rule?.id));
      items.push(migrationRow(outcome, allowed.ruleId, allowed.path, outcome.destination));
      errors.push(...outcome.errors);
      advice.push(...outcome.advice);
    }
  }

  const freeAfter = await freeSpaceOf(systemRoot);
  const report: ExecuteReport = {
    mode: action === 'rollback' ? 'rollback' : 'migrate',
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    systemDrive,
    freeBeforeBytes: freeBefore,
    freeAfterBytes: freeAfter,
    freedBytes: dryRun ? 0 : Math.max(0, freeAfter - freeBefore),
    measuredFreedBytes: items.reduce((sum, item) => sum + item.freedBytes, 0),
    plannedBytes: items.reduce((sum, item) => sum + item.sizeBefore, 0),
    items,
    elevationTasks: [],
    errors,
    partial: items.some((item) => item.action === 'failed' || item.action === 'partial'),
  };

  const reportPath = path.join(outputDir(config, exec), `C盘迁移报告-${nowStamp()}.md`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, renderExecutionReport(report), 'utf8');

  const countOf = (name: string): number => items.filter((item) => item.action === name).length;
  const system = drives.find((d) => d.isSystem);
  return {
    ...baseOutput(action),
    status: dryRun ? 'dry-run' : 'executed',
    systemDrive,
    totalBytes: system?.totalBytes ?? 0,
    usedBytes: Math.max(0, (system?.totalBytes ?? 0) - freeAfter),
    freeBytes: freeAfter,
    drives: drives.map<DriveView>((d) => ({ letter: d.letter, totalBytes: d.totalBytes, freeBytes: d.freeBytes })),
    migrationTarget: `${targetDrive.letter}:\\`,
    migrationAdvice: advice,
    durationMs: Date.now() - started,
    partial: report.partial,
    execution: {
      mode: report.mode,
      dryRun,
      freedBytes: report.freedBytes,
      measuredFreedBytes: report.measuredFreedBytes,
      plannedBytes: report.plannedBytes,
      reportPath,
      deletedCount: countOf('deleted'),
      trashedCount: countOf('trashed'),
      plannedCount: countOf('planned'),
      refusedCount: countOf('refused'),
      partialCount: countOf('partial') + countOf('failed'),
      elevationCount: 0,
      elevationCanceled: false,
      migratedCount: countOf('migrated'),
      rolledBackCount: countOf('rolled-back'),
      items: items.map<ExecItemView>((item) => ({
        path: item.path,
        action: item.action,
        sizeBefore: item.sizeBefore,
        freedBytes: item.freedBytes,
        reason: item.reason,
      })),
    },
  };
}
