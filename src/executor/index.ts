/**
 * 执行编排：安全闸 → 删除 / 暂存 → 提权任务 → 真实释放量核算。
 *
 * 三条不可让步的规则：
 *  1. **dryRun 默认开启**：没有明确关闭时，只报告「会做什么」，不删任何东西；
 *  2. **被拒绝的项照实列出**，附可展示理由，绝不静默跳过；
 *  3. **释放量以盘符空闲变化为准**（而不是把测量值当成功劳），
 *     锁定文件导致的「部分删除」单独记 `partial`，需要管理员权限的记 `needs-elevation`。
 */
import type { RuleIndex } from '../rules/match.js';
import { freeSpaceOf } from '../scanner/drives.js';
import { measurePath } from '../scanner/size.js';
import { driveRoot } from '../util/drive.js';
import { deletePath, emptyRecycleBin } from './delete.js';
import type { ElevatedResult, ElevatedTask } from './elevate.js';
import { isElevated, runElevated, taskDismComponentCleanup, taskDiskCleanup, taskRemoveDirectory } from './elevate.js';
import { guardTargets } from './safety.js';
import { moveToTrash } from './trash.js';

export interface ExecuteRequest {
  /** 目标路径（通常来自扫描结果或用户点选） */
  targets: string[];
  /** permanent=直接删除；trash=移动到其他盘的暂存区 */
  mode: 'permanent' | 'trash';
  trashPath?: string;
  dryRun: boolean;
  systemDrive: string;
  index: RuleIndex;
  allowExplicitUnmatched: boolean;
  allowProtectedOverride: boolean;
  /** 已知大小（来自扫描结果），避免 dryRun 重复测量 */
  knownSizes?: Record<string, number>;
  /** 需要一并触发的管理员级系统清理 */
  elevation?: { dism?: boolean; dismResetBase?: boolean; cleanmgr?: boolean; cleanmgrId?: number };
  onProgress?: (message: string) => void;
  /** 每有一条结果落表就回调一次（索引为该项在结果表中的位置），供 GUI 显示逐项进度 */
  onItem?: (item: ExecutedItem, index: number) => void;
  signal?: AbortSignal;
}

export type ExecutedAction =
  | 'deleted'
  | 'trashed'
  | 'partial'
  | 'failed'
  | 'refused'
  | 'planned'
  | 'needs-elevation'
  | 'elevation-canceled'
  | 'migrated'
  | 'rolled-back';

export interface ExecutedItem {
  path: string;
  ruleId: string;
  action: ExecutedAction;
  sizeBefore: number;
  freedBytes: number;
  remainingBytes: number;
  reason: string;
  movedTo?: string;
}

/** 执行模式；migrate / rollback 由 M3 迁移层复用同一份执行报告结构 */
export type ExecutionMode = 'permanent' | 'trash' | 'migrate' | 'rollback';

export interface ExecuteReport {
  mode: ExecutionMode;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  systemDrive: string;
  trashPath?: string;
  freeBeforeBytes: number;
  freeAfterBytes: number;
  /** 真实释放量（系统盘空闲变化，扣掉扫描期间其他进程的占用波动）
   *  注意：小体量清理时该值会被其他进程的写入淹没，此时以 measuredFreedBytes 为准 */
  freedBytes: number;
  /** 逐项测量合计（对每一项「删前 - 删后」求和，不依赖盘符快照） */
  measuredFreedBytes: number;
  plannedBytes: number;
  items: ExecutedItem[];
  elevationTasks: string[];
  elevation?: ElevatedResult;
  errors: string[];
  partial: boolean;
}

function needsElevation(target: string, windir: string, programData: string): boolean {
  const normalized = target.replace(/\//g, '\\').toLowerCase();
  return (
    (windir.length > 0 && normalized.startsWith(windir.toLowerCase())) ||
    (programData.length > 0 && normalized.startsWith(programData.toLowerCase()))
  );
}

function isRecycleBinTarget(target: string, systemDrive: string): boolean {
  const normalized = target.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
  return normalized === `${driveRoot(systemDrive).toLowerCase()}$recycle.bin`;
}

export async function executeCleanup(request: ExecuteRequest): Promise<ExecuteReport> {
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const items: ExecutedItem[] = [];
  const elevationTasks: ElevatedTask[] = [];
  const log = request.onProgress ?? (() => {});
  const root = driveRoot(request.systemDrive);
  const windir = process.env.WINDIR ?? '';
  const programData = process.env.ProgramData ?? '';

  const freeBefore = await freeSpaceOf(root);

  /** 逐项记账：推入结果表的同时回报进度（M5 面板靠它显示真实进度，而不是猜日志） */
  const record = (item: ExecutedItem): void => {
    items.push(item);
    request.onItem?.(item, items.length - 1);
  };

  log(`安全闸校验 ${request.targets.length} 个目标…`);
  const guards = await guardTargets(request.targets, {
    index: request.index,
    systemDrive: request.systemDrive,
    allowExplicitUnmatched: request.allowExplicitUnmatched,
    allowProtectedOverride: request.allowProtectedOverride,
  });

  for (const refused of guards.refused) {
    record({
      path: refused.path,
      ruleId: refused.ruleId,
      action: 'refused',
      sizeBefore: request.knownSizes?.[refused.path] ?? 0,
      freedBytes: 0,
      remainingBytes: 0,
      reason: refused.reason,
    });
  }

  const elevatedAlready = guards.allowed.some((item) => needsElevation(item.path, windir, programData))
    ? await isElevated()
    : true;

  let plannedBytes = 0;

  for (const allowed of guards.allowed) {
    const knownSize = request.knownSizes?.[allowed.path] ?? 0;
    const requiresAdmin = needsElevation(allowed.path, windir, programData) && !elevatedAlready;

    if (requiresAdmin) {
      elevationTasks.push(taskRemoveDirectory(allowed.path, `删除 ${allowed.path}`));
      plannedBytes += knownSize;
      record({
        path: allowed.path,
        ruleId: allowed.ruleId,
        action: request.dryRun ? 'planned' : 'needs-elevation',
        sizeBefore: knownSize,
        freedBytes: 0,
        remainingBytes: 0,
        reason: request.dryRun ? '需要管理员权限：将在提权阶段执行' : '需要管理员权限，已加入提权任务',
      });
      continue;
    }

    if (request.dryRun) {
      // 预演也要给出可信的「计划大小」：调用方给了扫描结果就用，否则现场轻量测量
      let size = knownSize;
      if (size === 0) {
        const measured = await measurePath(allowed.path, { timeBudgetMs: 8_000, signal: request.signal });
        size = measured.sizeBytes;
      }
      plannedBytes += size;
      record({
        path: allowed.path,
        ruleId: allowed.ruleId,
        action: 'planned',
        sizeBefore: size,
        freedBytes: 0,
        remainingBytes: 0,
        reason:
          request.mode === 'trash'
            ? `将移动到暂存区 ${request.trashPath ?? '（未指定）'}`
            : `将永久删除（${allowed.reason}）`,
      });
      continue;
    }

    log(`处理 ${allowed.path}…`);
    if (request.mode === 'trash') {
      if (!request.trashPath) {
        record({
          path: allowed.path,
          ruleId: allowed.ruleId,
          action: 'refused',
          sizeBefore: knownSize,
          freedBytes: 0,
          remainingBytes: 0,
          reason: 'trash 模式必须提供 trashPath（且应位于其他盘）',
        });
        continue;
      }
      const outcome = await moveToTrash(allowed.path, request.trashPath, {
        signal: request.signal,
        meta: { ruleId: allowed.ruleId },
        onProgress: log,
      });
      plannedBytes += outcome.sizeBefore;
      record({
        path: allowed.path,
        ruleId: allowed.ruleId,
        action:
          outcome.status === 'trashed'
            ? 'trashed'
            : outcome.status === 'partial'
              ? 'partial'
              : 'failed',
        sizeBefore: outcome.sizeBefore,
        freedBytes: outcome.freedBytes,
        remainingBytes: Math.max(0, outcome.sizeBefore - outcome.freedBytes),
        reason:
          outcome.status === 'same-volume'
            ? outcome.errors[0] ?? '暂存区与源同盘'
            : outcome.status === 'trashed'
              ? `已移动到 ${outcome.movedTo}`
              : outcome.errors.join('；') || '移动未完成',
        movedTo: outcome.movedTo,
      });
      if (outcome.errors.length > 0 && outcome.status !== 'trashed') errors.push(...outcome.errors.slice(0, 3));
      continue;
    }

    const outcome = isRecycleBinTarget(allowed.path, request.systemDrive)
      ? await emptyRecycleBin(allowed.path, { signal: request.signal, onProgress: log })
      : await deletePath(allowed.path, { signal: request.signal, onProgress: log });
    plannedBytes += outcome.sizeBefore;
    record({
      path: allowed.path,
      ruleId: allowed.ruleId,
      action:
        outcome.status === 'deleted'
          ? 'deleted'
          : outcome.status === 'partial'
            ? 'partial'
            : outcome.status === 'needs-elevation'
              ? 'needs-elevation'
              : 'failed',
      sizeBefore: outcome.sizeBefore,
      freedBytes: outcome.freedBytes,
      remainingBytes: outcome.remainingBytes,
      reason:
        outcome.status === 'deleted'
          ? '已彻底删除'
          : outcome.errors[0] ?? (outcome.status === 'needs-elevation' ? '需要管理员权限' : '删除未完成'),
    });
    if (outcome.errors.length > 0) errors.push(...outcome.errors.slice(0, 3));
  }

  if (request.elevation?.dism) {
    elevationTasks.push(taskDismComponentCleanup(request.elevation.dismResetBase === true));
  }
  if (request.elevation?.cleanmgr) {
    elevationTasks.push(taskDiskCleanup(request.elevation.cleanmgrId ?? 5150));
  }

  let elevation: ElevatedResult | undefined;
  if (!request.dryRun && elevationTasks.length > 0) {
    log(`触发提权任务（${elevationTasks.length} 项），等待 UAC 授权…`);
    elevation = await runElevated(elevationTasks, { onProgress: log });
    if (elevation.canceled) {
      items.forEach((item, index) => {
        if (item.action === 'needs-elevation') {
          item.action = 'elevation-canceled';
          item.reason = '用户取消了 UAC 授权，未执行';
          request.onItem?.(item, index); // 状态改写要补报一次，否则面板仍显示「等待提权」
        }
      });
    }
    if (elevation.errors.length > 0) errors.push(...elevation.errors);
  } else if (request.dryRun && elevationTasks.length > 0) {
    log(`dryRun：将触发 ${elevationTasks.length} 项提权任务，未实际执行`);
  }

  const freeAfter = await freeSpaceOf(root);
  const freedBytes = request.dryRun ? 0 : Math.max(0, freeAfter - freeBefore);
  const measuredFreedBytes = items.reduce((sum, item) => sum + item.freedBytes, 0);

  return {
    mode: request.mode,
    dryRun: request.dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    systemDrive: request.systemDrive,
    trashPath: request.trashPath,
    freeBeforeBytes: freeBefore,
    freeAfterBytes: freeAfter,
    freedBytes,
    measuredFreedBytes,
    plannedBytes,
    items,
    elevationTasks: elevationTasks.map((task) => task.title),
    elevation,
    errors,
    partial: items.some((item) => item.action === 'partial' || item.action === 'needs-elevation'),
  };
}
