/**
 * 执行前安全闸（M2 的核心防线）。
 *
 * 设计原则：
 *  - 保护名单是**硬约束**：即使调用方显式点名，也一律拒绝；
 *  - 「不明即不删」：未命中规则库的路径默认拒绝（除非显式开启 allowExplicitUnmatched）；
 *  - 结构性禁忌：盘根、系统关键目录、目录联接/符号链接一律拒绝；
 *  - 越界拒绝：本插件只在系统盘上执行删除，防止误伤其他盘；
 *  - 路径必须真实存在，且任何一层父目录都不能是 reparse point（否则删除语义会漂移）。
 *
 * 所有拒绝都返回**可展示的理由**，绝不静默跳过。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { normalizePath, pickWinner, type RuleIndex } from '../rules/match.js';
import type { Grade } from '../rules/schema.js';

export interface GuardContext {
  index: RuleIndex;
  /** 系统盘盘符，如 'C:' */
  systemDrive: string;
  /** 是否允许删除未收录规则库的路径（默认 false） */
  allowExplicitUnmatched: boolean;
  /** 是否允许覆盖保护名单（默认 false；开启后仍不允许硬约束项） */
  allowProtectedOverride: boolean;
  /** 允许在非系统盘执行（默认 false） */
  allowNonSystemDrive?: boolean;
}

export type GuardVerdict =
  | { allowed: true; ruleId: string; grade: Grade; reason: string }
  | { allowed: false; reason: string; ruleId: string; grade?: Grade };

/** 绝对禁止作为删除目标的路径（即使规则库有误也必须挡住） */
const FORBIDDEN_EXACT = new Set(
  [
    'c:',
    'c:\\',
    'c:\\users',
    'c:\\windows',
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\programdata',
    'c:\\users\\public',
  ].map((p) => p.toLowerCase()),
);

/** 路径段数（C:\a\b → 3） */
function segmentCount(normalized: string): number {
  return normalized.split('\\').filter((part) => part.length > 0).length;
}

/**
 * 取出盘符字母。注意：调用方可能传 'C'、'C:' 或 'C:\'，
 * 而 `normalizePath` 会把 'C:\' 变成 'c:'、把 'C' 变成 'c'——
 * 所以**必须归一化到单字母再比较**，否则两者永不相等（真实踩过的坑）。
 */
function driveLetter(value: string): string {
  const match = /([a-z]):/i.exec(value.replace(/\//g, '\\'));
  if (match) return match[1].toLowerCase();
  return value.replace(/[^a-z]/gi, '').slice(0, 1).toLowerCase();
}

async function lstatType(target: string): Promise<'missing' | 'dir' | 'file' | 'link' | 'other'> {
  try {
    const st = await fs.lstat(target);
    if (st.isSymbolicLink()) return 'link';
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    return 'other';
  } catch {
    return 'missing';
  }
}

/** 向上查找是否存在 reparse point 父目录（junction 会让删除语义漂移） */
async function findReparseAncestor(target: string): Promise<string | undefined> {
  const root = path.parse(path.resolve(target)).root;
  let current = path.dirname(path.resolve(target));
  for (let depth = 0; depth < 32; depth++) {
    if (!current || current === root || current === path.dirname(current)) return undefined;
    if ((await lstatType(current)) === 'link') return current;
    current = path.dirname(current);
  }
  return undefined;
}

/**
 * 判定一个路径能否作为删除/迁移目标。
 * 注意：`allowProtectedOverride` 只影响**用户自定义规则**，内置硬约束项永不放行。
 */
export async function guardTarget(target: string, ctx: GuardContext): Promise<GuardVerdict> {
  const normalized = normalizePath(target);

  // 盘根（'C:' / 'C:\' 归一化后都是 'c:'）：必须先判，否则会被当成「无盘符路径」
  if (/^[a-z]:?$/.test(normalized) || FORBIDDEN_EXACT.has(normalized)) {
    return { allowed: false, ruleId: 'forbidden-root', reason: '盘根或系统关键目录，永远不允许作为清理目标' };
  }

  if (!/^[a-z]:\\/.test(normalized)) {
    return { allowed: false, ruleId: 'invalid-path', reason: '不是带盘符的绝对路径' };
  }

  const drive = driveLetter(normalized);
  if (ctx.allowNonSystemDrive !== true && drive !== driveLetter(ctx.systemDrive)) {
    return {
      allowed: false,
      ruleId: 'out-of-scope',
      reason: `本插件只在系统盘（${ctx.systemDrive}）上执行清理，${drive.toUpperCase()}: 不在职责范围内`,
    };
  }

  const winner = pickWinner(target, ctx.index);
  const rule = winner?.rule;
  const isHardProtected = rule?.grade === 'protected' && rule.overridable === false;

  if (isHardProtected) {
    return { allowed: false, ruleId: rule.id, grade: 'protected', reason: `保护名单（硬约束）：${rule.reason}` };
  }
  if (rule?.grade === 'protected' && ctx.allowProtectedOverride !== true) {
    return { allowed: false, ruleId: rule.id, grade: 'protected', reason: `保护名单：${rule.reason}` };
  }
  if (!rule && !ctx.allowExplicitUnmatched) {
    if (segmentCount(normalized) < 3) {
      return { allowed: false, ruleId: 'too-shallow', reason: '未收录规则库且路径过浅（层级不足 3 段），拒绝执行' };
    }
    return {
      allowed: false,
      ruleId: 'unmatched',
      reason: '未收录规则库：按「不明即不删」原则拒绝（如确需清理，请先在规则库中登记）',
    };
  }

  const type = await lstatType(target);
  if (type === 'missing') {
    return { allowed: false, ruleId: rule?.id ?? 'unmatched', reason: '路径不存在（可能已被清理或已被迁移）' };
  }
  if (type === 'link') {
    return {
      allowed: false,
      ruleId: rule?.id ?? 'unmatched',
      reason: '目录联接/符号链接不参与清理（避免误删链接目标；迁移项请用 rollback 处理）',
    };
  }

  const reparseAncestor = await findReparseAncestor(target);
  if (reparseAncestor) {
    return {
      allowed: false,
      ruleId: rule?.id ?? 'unmatched',
      reason: `上级目录 ${reparseAncestor} 是目录联接，删除语义不确定，拒绝执行`,
    };
  }

  return {
    allowed: true,
    ruleId: rule?.id ?? 'explicit',
    grade: (rule?.grade ?? 'caution') as Grade,
    reason: rule?.reason ?? '调用方显式指定且已开启 allowExplicitUnmatched',
  };
}

export interface GuardSummary {
  allowed: Array<{ path: string; ruleId: string; grade: Grade; reason: string }>;
  refused: Array<{ path: string; ruleId: string; reason: string }>;
}

/** 批量判定（保持输入顺序，便于报告逐项对应） */
export async function guardTargets(targets: string[], ctx: GuardContext): Promise<GuardSummary> {
  const summary: GuardSummary = { allowed: [], refused: [] };
  for (const target of targets) {
    const verdict = await guardTarget(target, ctx);
    if (verdict.allowed) {
      summary.allowed.push({ path: target, ruleId: verdict.ruleId, grade: verdict.grade, reason: verdict.reason });
    } else {
      summary.refused.push({ path: target, ruleId: verdict.ruleId, reason: verdict.reason });
    }
  }
  return summary;
}
