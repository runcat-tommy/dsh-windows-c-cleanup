/**
 * 目录/文件测量。
 *
 * 关键点：
 *  - **不跟随 junction / 符号链接**（Windows 上 reparse point 会被 Node 报为 symbolic link），
 *    否则会重复计数甚至无限递归。
 *  - 支持时间预算，超时返回部分结果并标记，避免全盘扫描卡死。
 *  - 并发受限的目录遍历，错误静默跳过（无权限目录很常见）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface MeasureOptions {
  /** 并发遍历的目录数，默认 8 */
  concurrency?: number;
  /** 时间预算（毫秒），超时后返回部分结果 */
  timeBudgetMs?: number;
  /** 进度回调（已遍历目录数） */
  onProgress?: (dirsScanned: number) => void;
  signal?: AbortSignal;
}

export interface MeasureResult {
  sizeBytes: number;
  fileCount: number;
  dirCount: number;
  /** 因权限/占用等原因未能读取的路径数 */
  errorCount: number;
  /** 是否因时间预算或取消而截断 */
  partial: boolean;
}

/** 判断目录项是否应跳过（符号链接 / junction / 其他 reparse point） */
function shouldSkipEntry(dirent: { isSymbolicLink(): boolean }): boolean {
  return dirent.isSymbolicLink();
}

export async function measurePath(target: string, options: MeasureOptions = {}): Promise<MeasureResult> {
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const deadline = options.timeBudgetMs ? Date.now() + options.timeBudgetMs : Number.POSITIVE_INFINITY;

  const result: MeasureResult = { sizeBytes: 0, fileCount: 0, dirCount: 0, errorCount: 0, partial: false };

  // 单个文件
  try {
    const st = await fs.lstat(target);
    if (st.isSymbolicLink()) return result;
    if (!st.isDirectory()) {
      result.sizeBytes = st.size;
      result.fileCount = 1;
      return result;
    }
  } catch {
    result.errorCount++;
    return result;
  }

  const queue: string[] = [target];
  let active = 0;

  return new Promise<MeasureResult>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const pump = (): void => {
      if (settled) return;
      if (options.signal?.aborted || Date.now() > deadline) {
        result.partial = true;
        if (active === 0) finish();
        return;
      }
      while (active < concurrency && queue.length > 0) {
        const dir = queue.shift() as string;
        active++;
        void (async () => {
          try {
            const handle = await fs.opendir(dir);
            result.dirCount++;
            options.onProgress?.(result.dirCount);
            for await (const entry of handle) {
              if (shouldSkipEntry(entry)) continue;
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                queue.push(full);
              } else if (entry.isFile()) {
                try {
                  const st = await fs.lstat(full);
                  result.sizeBytes += st.size;
                  result.fileCount++;
                } catch {
                  result.errorCount++;
                }
              }
            }
          } catch {
            result.errorCount++;
          } finally {
            active--;
            if (queue.length === 0 && active === 0) finish();
            else pump();
          }
        })();
      }
      if (queue.length === 0 && active === 0) finish();
    };

    pump();
  });
}

/** 汇总一组文件的大小（用于文件类 glob 规则） */
export async function sumFiles(files: string[]): Promise<number> {
  let total = 0;
  for (const f of files) {
    try {
      const st = await fs.lstat(f);
      if (!st.isSymbolicLink()) total += st.size;
    } catch {
      /* 忽略 */
    }
  }
  return total;
}
