/**
 * 全盘 Top-N 大目录扫描。
 *
 * 策略（为满足「1–2 分钟出报告」的验收标准）：
 *  - 逐层递归聚合每个目录的子树大小，最多深入 maxDepth 层；**每层并发遍历**（默认 3 路），
 *    这是保证预算内跑完的关键——顺序遍历在 C 盘上会跑不到 C:\Windows 就被截断；
 *  - 到达深度上限时，用 measurePath 一次性测量该子树（不再逐目录记录）；
 *  - leafDirs（如 C:\Windows、Program Files）整体测量但不深入；
 *  - 不跟随 junction / 符号链接；超时则返回部分结果并标记 partial；
 *  - 默认不把扫描根自身计入结果（盘根没有信息量，且会污染大头榜）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { normalizePath } from '../rules/match.js';
import { mapLimit } from '../util/concurrency.js';
import { measurePath } from './size.js';

export interface TopTreeOptions {
  maxDepth?: number;
  topN?: number;
  timeBudgetMs?: number;
  /** 整体测量但不深入的目录（展开后的绝对路径） */
  leafDirs?: string[];
  /** 每层并发遍历的目录数，默认 6 */
  concurrency?: number;
  /** 叶子子树测量的内部并发，默认 12 */
  leafConcurrency?: number;
  /** 是否把扫描根自身计入结果，默认 false */
  includeRoot?: boolean;
  signal?: AbortSignal;
  onProgress?: (dirsScanned: number, current: string) => void;
}

export interface TopTreeNode {
  path: string;
  sizeBytes: number;
  fileCount: number;
  depth: number;
}

export interface TopTreeResult {
  items: TopTreeNode[];
  partial: boolean;
  scannedDirs: number;
  durationMs: number;
}

export async function scanTopTree(root: string, options: TopTreeOptions = {}): Promise<TopTreeResult> {
  const maxDepth = options.maxDepth ?? 3;
  const topN = options.topN ?? 30;
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const leafConcurrency = Math.max(1, options.leafConcurrency ?? 12);
  const deadline = Date.now() + (options.timeBudgetMs ?? 60_000);
  const started = Date.now();
  const leafSet = new Set((options.leafDirs ?? []).map(normalizePath));
  const rootKey = normalizePath(root);
  const collected: TopTreeNode[] = [];
  let scannedDirs = 0;
  let partial = false;

  const timedOut = (): boolean => {
    if (Date.now() > deadline) {
      partial = true;
      return true;
    }
    return false;
  };

  const aborted = (): boolean => {
    if (options.signal?.aborted === true) {
      partial = true;
      return true;
    }
    return false;
  };

  const record = (node: TopTreeNode): void => {
    if (!options.includeRoot && normalizePath(node.path) === rootKey) return;
    collected.push(node);
  };

  async function walk(dir: string, depth: number): Promise<{ size: number; files: number }> {
    if (timedOut() || aborted()) return { size: 0, files: 0 };
    scannedDirs++;
    if (scannedDirs % 200 === 0) options.onProgress?.(scannedDirs, dir);

    if (leafSet.has(normalizePath(dir)) || depth >= maxDepth) {
      const measured = await measurePath(dir, {
        concurrency: leafConcurrency,
        timeBudgetMs: Math.max(1_000, deadline - Date.now()),
        signal: options.signal,
      });
      if (measured.partial) partial = true;
      record({ path: dir, sizeBytes: measured.sizeBytes, fileCount: measured.fileCount, depth });
      return { size: measured.sizeBytes, files: measured.fileCount };
    }

    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return { size: 0, files: 0 };
    }

    const childDirs: string[] = [];
    const childFiles: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // junction / reparse point：不跟随
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) childDirs.push(full);
      else if (entry.isFile()) childFiles.push(full);
    }

    const fileSizes = await mapLimit(childFiles, 8, async (file) => {
      try {
        return (await fs.lstat(file)).size;
      } catch {
        return 0;
      }
    });
    let size = fileSizes.reduce((acc, value) => acc + value, 0);
    let files = childFiles.length;

    const dirResults = await mapLimit(childDirs, concurrency, (child) => walk(child, depth + 1));
    for (const result of dirResults) {
      size += result.size;
      files += result.files;
    }

    record({ path: dir, sizeBytes: size, fileCount: files, depth });
    return { size, files };
  }

  await walk(root, 0);

  const items = collected.sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, topN);
  return { items, partial, scannedDirs, durationMs: Date.now() - started };
}
