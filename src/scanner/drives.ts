/**
 * 盘符信息：总容量 / 空闲空间。
 * 使用 fs.statfs（Node ≥ 18.15），无需 spawn 外部命令。
 */
import { promises as fs } from 'node:fs';
import type { DriveInfo } from '../rules/schema.js';

const LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');

export async function listDrives(systemDrive = (process.env.SystemDrive ?? 'C:') + '\\'): Promise<DriveInfo[]> {
  const drives: DriveInfo[] = [];
  await Promise.all(
    LETTERS.map(async (letter) => {
      const root = `${letter}:\\`;
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
          isSystem: root.toLowerCase() === systemDrive.toLowerCase(),
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

/** 单个盘的当前空闲字节数（执行前后用它算真实释放量） */
export async function freeSpaceOf(root: string): Promise<number> {
  try {
    const st = await fs.statfs(root);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return 0;
  }
}

/** 去掉 \\?\ 前缀等，保持报告里路径可读 */
export function prettyPath(p: string): string {
  return p.replace(/\\\\\?\\/g, '').replace(/\\+$/, '');
}
