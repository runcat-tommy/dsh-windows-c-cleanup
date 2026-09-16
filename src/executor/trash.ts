/**
 * 暂存区（回收站式）：把待删内容**跨盘移动**到其他盘，而不是当场删掉。
 *
 * 重要事实：暂存区若与源在同一卷，移动不释放任何空间（只是改目录项），
 * 因此这里**显式拒绝同盘暂存**——这一点在真实场景里经常被误解。
 *
 * 每次移动都写台账（JSONL，append-only），为 M3 的 restore/rollback 留数据。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { measurePath } from '../scanner/size.js';
import { nowStamp } from '../util/format.js';

export interface TrashOptions {
  signal?: AbortSignal;
  /** 台账附加信息（规则 id 等） */
  meta?: Record<string, unknown>;
  onProgress?: (message: string) => void;
}

export interface TrashOutcome {
  status: 'trashed' | 'partial' | 'failed' | 'same-volume';
  movedTo?: string;
  sizeBefore: number;
  freedBytes: number;
  fileCount: number;
  errors: string[];
}

export interface ManifestEntry {
  id: string;
  at: string;
  originalPath: string;
  trashPath: string;
  sizeBytes: number;
  fileCount: number;
  meta?: Record<string, unknown>;
}

const MANIFEST_FILE = '_manifest.jsonl';

export function driveOf(p: string): string {
  return path.resolve(p).slice(0, 2).toLowerCase();
}

async function uniqueDestination(trashRoot: string, baseName: string): Promise<string> {
  const stamp = nowStamp();
  let candidate = path.join(trashRoot, `${stamp}-${baseName}`);
  let counter = 1;
  while (await pathExists(candidate)) {
    candidate = path.join(trashRoot, `${stamp}-${baseName}-${counter++}`);
  }
  return candidate;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** 追加一条台账记录 */
export async function appendManifest(trashRoot: string, entry: ManifestEntry): Promise<void> {
  await fs.mkdir(trashRoot, { recursive: true });
  await fs.appendFile(path.join(trashRoot, MANIFEST_FILE), `${JSON.stringify(entry)}\n`, 'utf8');
}

/** 读取台账（供 M3 的 restore/rollback 使用） */
export async function readManifest(trashRoot: string): Promise<ManifestEntry[]> {
  try {
    const raw = await fs.readFile(path.join(trashRoot, MANIFEST_FILE), 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ManifestEntry);
  } catch {
    return [];
  }
}

/** 把目标移动到暂存区，返回真实释放量 */
export async function moveToTrash(target: string, trashRoot: string, options: TrashOptions = {}): Promise<TrashOutcome> {
  const errors: string[] = [];

  if (driveOf(target) === driveOf(trashRoot)) {
    return {
      status: 'same-volume',
      sizeBefore: 0,
      freedBytes: 0,
      fileCount: 0,
      errors: [`暂存区 ${trashRoot} 与源 ${target} 在同一盘，移动不会释放空间，已拒绝`],
    };
  }

  const before = await measurePath(target, {
    timeBudgetMs: 120_000,
    signal: options.signal,
    onProgress: (dirs) => {
      if (dirs % 500 === 0) options.onProgress?.(`测量 ${target}：已遍历 ${dirs} 个目录`);
    },
  });

  await fs.mkdir(trashRoot, { recursive: true });
  const destination = await uniqueDestination(trashRoot, path.basename(target) || 'item');

  try {
    // 同卷 rename 很快；跨卷会抛 EXDEV，退化为「复制 + 删除」
    await fs.rename(target, destination);
  } catch {
    try {
      options.onProgress?.(`跨盘复制中：${target} → ${destination}`);
      await fs.cp(target, destination, { recursive: true, force: true, preserveTimestamps: true });
      await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
    } catch (error) {
      errors.push((error as Error).message.split('\n')[0] ?? String(error));
    }
  }

  const sourceGone = !(await pathExists(target));
  if (sourceGone) {
    await appendManifest(trashRoot, {
      id: `${nowStamp()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      originalPath: target,
      trashPath: destination,
      sizeBytes: before.sizeBytes,
      fileCount: before.fileCount,
      meta: options.meta,
    });
    return {
      status: 'trashed',
      movedTo: destination,
      sizeBefore: before.sizeBytes,
      freedBytes: before.sizeBytes,
      fileCount: before.fileCount,
      errors,
    };
  }

  const after = await measurePath(target, { timeBudgetMs: 60_000, signal: options.signal });
  const freed = Math.max(0, before.sizeBytes - after.sizeBytes);
  return {
    status: freed > 0 ? 'partial' : 'failed',
    movedTo: destination,
    sizeBefore: before.sizeBytes,
    freedBytes: freed,
    fileCount: before.fileCount,
    errors,
  };
}
