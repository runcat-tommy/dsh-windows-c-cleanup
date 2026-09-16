/**
 * 删除引擎：递归删除 + 如实的「部分删除」汇报。
 *
 * 关键取舍：
 *  - 先测量再删除，删完再核对剩余量，**拿到真实释放字节数**（而不是按测量值宣称）；
 *  - 被占用/无权限的文件很常见（浏览器、IDE、企业微信在跑就删不掉），
 *    这种情况返回 `partial` 并给出剩余量与错误摘要，绝不谎报成功；
 *  - 需要管理员权限的失败单独识别为 `needs-elevation`，交给提权链路处理。
 */
import { promises as fs } from 'node:fs';
import { measurePath } from '../scanner/size.js';

export interface DeleteOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface DeleteOutcome {
  status: 'deleted' | 'partial' | 'failed' | 'needs-elevation';
  /** 删除前测量的大小 */
  sizeBefore: number;
  /** 真实释放的字节数（= 删除前 - 删除后剩余） */
  freedBytes: number;
  /** 删除后仍残留的字节数 */
  remainingBytes: number;
  fileCount: number;
  errors: string[];
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** 递归删除一个路径，返回真实释放量 */
export async function deletePath(target: string, options: DeleteOptions = {}): Promise<DeleteOutcome> {
  const errors: string[] = [];
  const before = await measurePath(target, {
    timeBudgetMs: 120_000,
    signal: options.signal,
    onProgress: (dirs) => {
      if (dirs % 500 === 0) options.onProgress?.(`测量 ${target}：已遍历 ${dirs} 个目录`);
    },
  });

  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  } catch (error) {
    errors.push((error as Error).message.split('\n')[0] ?? String(error));
  }

  if (!(await exists(target))) {
    return {
      status: 'deleted',
      sizeBefore: before.sizeBytes,
      freedBytes: before.sizeBytes,
      remainingBytes: 0,
      fileCount: before.fileCount,
      errors,
    };
  }

  // 仍存在：区分「部分删除」与「完全失败 / 需要提权」
  const after = await measurePath(target, { timeBudgetMs: 60_000, signal: options.signal });
  const freedBytes = Math.max(0, before.sizeBytes - after.sizeBytes);
  const permission = errors.some((message) => /EPERM|EACCES|EBUSY|denied|拒绝访问/i.test(message));

  if (after.sizeBytes === 0) {
    // 目录还在但已空（例如只剩空壳目录）
    return {
      status: 'deleted',
      sizeBefore: before.sizeBytes,
      freedBytes: before.sizeBytes,
      remainingBytes: 0,
      fileCount: before.fileCount,
      errors,
    };
  }

  return {
    status: freedBytes > 0 ? 'partial' : permission ? 'needs-elevation' : 'failed',
    sizeBefore: before.sizeBytes,
    freedBytes,
    remainingBytes: after.sizeBytes,
    fileCount: before.fileCount,
    errors,
  };
}

/** 清空回收站：逐个 SID 子目录尽力删除 */
export async function emptyRecycleBin(recycleRoot: string, options: DeleteOptions = {}): Promise<DeleteOutcome> {
  const before = await measurePath(recycleRoot, { timeBudgetMs: 120_000, signal: options.signal });
  const errors: string[] = [];

  let entries: string[] = [];
  try {
    entries = await fs.readdir(recycleRoot);
  } catch (error) {
    errors.push((error as Error).message.split('\n')[0] ?? String(error));
  }

  for (const entry of entries) {
    const full = `${recycleRoot}\\${entry}`;
    try {
      await fs.rm(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
    } catch (error) {
      errors.push(`${entry}: ${(error as Error).message.split('\n')[0] ?? String(error)}`);
    }
  }

  const after = await measurePath(recycleRoot, { timeBudgetMs: 60_000, signal: options.signal });
  const freedBytes = Math.max(0, before.sizeBytes - after.sizeBytes);
  return {
    status: after.sizeBytes === 0 ? 'deleted' : freedBytes > 0 ? 'partial' : 'failed',
    sizeBefore: before.sizeBytes,
    freedBytes,
    remainingBytes: after.sizeBytes,
    fileCount: before.fileCount,
    errors,
  };
}
