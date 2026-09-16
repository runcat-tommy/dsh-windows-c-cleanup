/**
 * 热点清单扫描：把规则库里的路径模板展开为真实路径并测量。
 * 只测量「存在的」路径；不存在的规则项不出现在结果里。
 *
 * 先顺序展开（读目录快），再**并发测量**（测量才是耗时大头）；整体受时间预算约束。
 */
import { promises as fs } from 'node:fs';
import { expandGlob, normalizePath } from '../rules/match.js';
import type { Rule, ScanItem } from '../rules/schema.js';
import { mapLimit } from '../util/concurrency.js';
import { measurePath } from './size.js';

export interface HotspotOptions {
  /** 单个候选项测量时的内部目录并发，默认 8 */
  concurrency?: number;
  /** 同时测量的候选项数量，默认 4 */
  ruleConcurrency?: number;
  /** 热点扫描总时间预算，默认 90 秒 */
  timeBudgetMs?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, current: string) => void;
}

export interface HotspotResult {
  items: ScanItem[];
  partial: boolean;
  /** 实际完成测量的候选项数 / 展开后的候选项总数（用于报告覆盖率） */
  scanned: number;
  total: number;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function readdirNames(p: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.map((e) => e.name);
  } catch {
    return [];
  }
}

export async function scanHotspots(
  entries: Array<{ rule: Rule; expanded: string }>,
  options: HotspotOptions = {},
): Promise<HotspotResult> {
  const deadline = Date.now() + (options.timeBudgetMs ?? 90_000);
  const ruleConcurrency = Math.max(1, options.ruleConcurrency ?? 4);
  let partial = false;

  // 1) 展开阶段：模板 → 真实存在的路径（顺序执行，读操作很快）
  const candidates: Array<{ path: string; kind: 'dir' | 'file' }> = [];
  const seen = new Set<string>();
  for (const { rule, expanded } of entries) {
    if (Date.now() > deadline || options.signal?.aborted === true) {
      partial = true;
      break;
    }
    const isFile = rule.kind === 'file';
    const resolved = expanded.includes('*')
      ? await expandGlob(expanded, { readdir: readdirNames, exists }, process.env)
      : (await exists(expanded))
        ? [expanded.replace(/\\+$/, '')]
        : [];
    for (const path of resolved) {
      const key = normalizePath(path);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ path, kind: isFile ? 'file' : 'dir' });
    }
  }

  // 2) 测量阶段：并发测量，超预算即置 partial
  let done = 0;
  const measuredItems = await mapLimit(candidates, ruleConcurrency, async (candidate) => {
    if (Date.now() > deadline || options.signal?.aborted === true) {
      partial = true;
      return undefined;
    }
    options.onProgress?.(done++, candidates.length, candidate.path);
    const measured = await measurePath(candidate.path, {
      concurrency: options.concurrency ?? 8,
      timeBudgetMs: candidate.kind === 'file' ? 5_000 : Math.max(1_000, deadline - Date.now()),
      signal: options.signal,
    });
    if (measured.partial) partial = true;
    if (measured.fileCount === 0 && measured.sizeBytes === 0 && measured.errorCount > 0) return undefined;
    const item: ScanItem = {
      path: candidate.path,
      kind: candidate.kind,
      sizeBytes: measured.sizeBytes,
      fileCount: measured.fileCount,
      source: 'hotspot',
    };
    return item;
  });

  const items = measuredItems.filter((item): item is ScanItem => item !== undefined);
  items.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { items, partial, scanned: done, total: candidates.length };
}
