/**
 * 盘符信息：总容量 / 空闲空间。
 * 使用 fs.statfs（Node ≥ 18.15），无需 spawn 外部命令。
 */
import { promises as fs } from 'node:fs';
import type { DriveInfo } from '../rules/schema.js';
import { driveRoot } from '../util/drive.js';

const LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');

export async function listDrives(systemDrive = (process.env.SystemDrive ?? 'C:') + '\\'): Promise<DriveInfo[]> {
  const drives: DriveInfo[] = [];
  await Promise.all(
    LETTERS.map(async (letter) => {
      const root = driveRoot(letter);
      try {
        const st = await fs.statfs(root);
        const totalBytes = Number(st.blocks) * Number(st.bsize);
        const freeBytes = Number(st.bavail) * Number(st.bsize);
        if (!Number.isFinite(totalBytes) || totalBytes <= 0) return;
        drives.push({
          letter: letter.toUpperCase(),
          root,
          totalBytes,
          freeBytes,
          isSystem: root.toLowerCase() === driveRoot(systemDrive).toLowerCase(),
        });
      } catch {
        /* 盘符不存在或不可访问 */
      }
    }),
  );
  drives.sort((a, b) => a.letter.localeCompare(b.letter));
  return drives;
}

/** 选择迁移目标盘：空闲最大且非系统盘 */
export function pickMigrationTarget(drives: DriveInfo[]): DriveInfo | undefined {
  return drives
    .filter((d) => !d.isSystem)
    .sort((a, b) => b.freeBytes - a.freeBytes)
    .at(0);
}

/**
 * 单个盘的当前空闲字节数（执行前后用它算真实释放量）。
 *
 * 盘符写法一律归一（`'C'` → `'C:\'`）：漏一个冒号会让 `statfs` 抛 ENOENT，
 * 而这里若静默返回 0，报告就会写出「空闲 0.00 GB」这种假数字。
 * 因此失败时**重试一次并打日志**，返回值仍然可能为 0，调用方必须用
 * {@link readFreeSpace} 区分「0」与「读不到」。
 */
export async function freeSpaceOf(root: string): Promise<number> {
  const target = /^[a-zA-Z]:?\\*$/.test(root.trim()) ? driveRoot(root) : root;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const st = await fs.statfs(target);
      return Number(st.bavail) * Number(st.bsize);
    } catch (error) {
      if (attempt === 2) {
        console.warn(
          `windows-c-cleanup: 读取 ${target} 的空闲空间失败（${(error as NodeJS.ErrnoException).code ?? 'unknown'}），本次按「未知」处理`,
        );
        return 0;
      }
    }
  }
  return 0;
}

/** 带「是否读到了」标记的空闲空间读取：0 与「未知」必须能区分 */
export async function readFreeSpace(root: string): Promise<{ bytes: number; known: boolean }> {
  const bytes = await freeSpaceOf(root);
  return { bytes, known: bytes > 0 };
}

/** 去掉 \\?\ 前缀等，保持报告里路径可读 */
export function prettyPath(p: string): string {
  return p.replace(/\\\\\?\\/g, '').replace(/\\+$/, '');
}
