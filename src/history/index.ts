/**
 * 历史趋势：把每次扫描的摘要追加到 JSONL 历史文件，并与上一次扫描对比出趋势。
 *
 * 为什么值得做：C 盘的问题不是「一次清理」，而是**应用会不断把缓存长回来**
 * （实测一轮清理后约 11 GB 被企业微信 / WPS / Chrome / uv 自己重建）。
 * 只有把每次扫描的结果存下来，才能回答「谁在长、长多快、上一轮清理到底有没有用」。
 *
 * 设计取舍：
 *  - 历史文件放 `<DSH_HOME>/windows-c-cleanup/history.jsonl`（不在被清理的缓存目录里）；
 *  - 追加写、单行一条，坏行跳过（历史文件被截断也不会让功能失效）；
 *  - 趋势只比较「路径交集」上的变化，并对新出现/消失的大头单独归类，
 *    避免把「扫描截断导致少测了一个目录」误读成「目录变小了」。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../rules/schema.js';
import { nowStamp } from '../util/format.js';

export interface BigItemSnapshot {
  path: string;
  sizeBytes: number;
  grade: string;
}

export interface HistoryEntry {
  id: string;
  at: string;
  kind: 'scan' | 'alert';
  scope: 'hotspots' | 'full';
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
  bigItems: BigItemSnapshot[];
  durationMs: number;
  partial: boolean;
  /** alert 条目的人类可读说明 */
  message?: string;
}

export interface TrendItem {
  path: string;
  sizeBytes: number;
  deltaBytes: number;
}

export interface Trend {
  previousAt: string;
  hoursAgo: number;
  freeDeltaBytes: number;
  usedDeltaBytes: number;
  /** 增长最多（超过阈值）的目录 */
  grown: TrendItem[];
  /** 缩小最多的目录 */
  shrunk: TrendItem[];
  /** 新出现的大头 */
  appeared: BigItemSnapshot[];
  /** 上次有、这次没有的大头（可能是被清理了，也可能是本次扫描未覆盖） */
  disappeared: BigItemSnapshot[];
  /** 上一次扫描本身是否被截断（截断时「消失」结论不可靠） */
  previousPartial: boolean;
}

/** 默认历史文件位置：DSH_HOME 下，避免落在会被清理的缓存目录里 */
export function defaultHistoryPath(): string {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'windows-c-cleanup', 'history.jsonl');
}

export async function appendHistory(historyPath: string, entry: HistoryEntry): Promise<void> {
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.appendFile(historyPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** 读取历史；坏行跳过，返回按时间正序的条目 */
export async function readHistory(historyPath: string, limit?: number): Promise<HistoryEntry[]> {
  let raw = '';
  try {
    raw = await fs.readFile(historyPath, 'utf8');
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as HistoryEntry;
      if (parsed && typeof parsed.at === 'string' && (parsed.kind === 'scan' || parsed.kind === 'alert')) {
        entries.push(parsed);
      }
    } catch {
      /* 坏行跳过：历史文件不该因为一行损坏就整体失效 */
    }
  }
  entries.sort((a, b) => a.at.localeCompare(b.at));
  return typeof limit === 'number' ? entries.slice(-limit) : entries;
}

/** 找出当前扫描之前最近的一次扫描记录 */
export function previousScan(entries: HistoryEntry[], currentId: string): HistoryEntry | undefined {
  return entries.filter((entry) => entry.kind === 'scan' && entry.id !== currentId).at(-1);
}

/** 最近若干条告警（新到旧） */
export function recentAlerts(entries: HistoryEntry[], limit = 5): HistoryEntry[] {
  return entries
    .filter((entry) => entry.kind === 'alert')
    .slice(-limit)
    .reverse();
}

const GROWTH_THRESHOLD = 100 * 1024 * 1024; // 100 MB：小于此的变化多为缓存抖动，不报

export function computeTrend(previous: HistoryEntry, current: HistoryEntry): Trend {
  const before = new Map(previous.bigItems.map((item) => [item.path.toLowerCase(), item]));
  const after = new Map(current.bigItems.map((item) => [item.path.toLowerCase(), item]));
  const grown: TrendItem[] = [];
  const shrunk: TrendItem[] = [];
  const appeared: BigItemSnapshot[] = [];
  const disappeared: BigItemSnapshot[] = [];

  for (const [key, item] of after) {
    const old = before.get(key);
    if (!old) {
      appeared.push(item);
      continue;
    }
    const delta = item.sizeBytes - old.sizeBytes;
    if (delta >= GROWTH_THRESHOLD) grown.push({ path: item.path, sizeBytes: item.sizeBytes, deltaBytes: delta });
    else if (-delta >= GROWTH_THRESHOLD) shrunk.push({ path: item.path, sizeBytes: item.sizeBytes, deltaBytes: delta });
  }
  for (const [key, item] of before) {
    if (!after.has(key)) disappeared.push(item);
  }

  const hoursAgo = Math.max(
    0,
    Math.round(((Date.parse(current.at) - Date.parse(previous.at)) / 3_600_000) * 10) / 10,
  );

  return {
    previousAt: previous.at,
    hoursAgo,
    freeDeltaBytes: current.freeBytes - previous.freeBytes,
    usedDeltaBytes: current.usedBytes - previous.usedBytes,
    grown: grown.sort((a, b) => b.deltaBytes - a.deltaBytes).slice(0, 8),
    shrunk: shrunk.sort((a, b) => a.deltaBytes - b.deltaBytes).slice(0, 8),
    appeared: appeared.sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 8),
    disappeared: disappeared.sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 8),
    previousPartial: previous.partial,
  };
}

/** 构造一条扫描历史记录 */
export function toHistoryEntry(input: Omit<HistoryEntry, 'id' | 'at' | 'kind'>): HistoryEntry {
  return { id: nowStamp(), at: new Date().toISOString(), kind: 'scan', ...input };
}

/**
 * 从扫描方案生成历史条目。
 *
 * 注意：**id 直接用 plan.id**，让「方案编号 / 报告文件名 / 历史记录」三处共用同一个身份，
 * 否则趋势对比会因为找不到自己那条记录而拿错基准（测试 5.2 就是这么抓到的）。
 */
export function historyEntryFromPlan(plan: Plan, scope: 'hotspots' | 'full', durationMs: number): HistoryEntry {
  return {
    ...toHistoryEntry({
      scope,
      systemDrive: plan.drives.find((drive) => drive.isSystem)?.letter ?? '',
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
      bigItems: plan.bigItems.map((item) => ({ path: item.path, sizeBytes: item.sizeBytes, grade: item.grade })),
      durationMs,
      partial: plan.partial,
    }),
    id: plan.id,
  };
}

/**
 * 构造一条告警记录。
 *
 * 顺序很重要：必须先摊开扫描条目、再覆盖 id/at/kind/message/bigItems。
 * 反过来写的话，扫描条目里的 `kind: 'scan'` 会把告警的 kind 覆盖回 scan，
 * 告警就再也筛不出来了（M4 测试 3.1/3.3 抓到过这个错）。
 */
export function toAlertEntry(
  input: Omit<HistoryEntry, 'id' | 'at' | 'kind' | 'message' | 'bigItems'>,
  message: string,
): HistoryEntry {
  return {
    ...input,
    id: nowStamp(),
    at: new Date().toISOString(),
    kind: 'alert',
    bigItems: [],
    message,
  };
}
