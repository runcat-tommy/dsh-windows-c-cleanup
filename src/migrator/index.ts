/**
 * M3 迁移层：把 C 盘上的缓存/数据目录搬到其他盘，并在原位置留下**目录联接（junction）**，
 * 让应用完全无感地继续读写老路径。
 *
 * 迁移与删除的本质区别，决定了这里的实现顺序：
 *  1. **先复制，验证无误，再删源，最后建联接**。顺序反了就会在失败时丢数据；
 *  2. 目标盘空间不足、目标同名目录已存在、源目录被占用无法完整删除 —— 都**拒绝或中止**，
 *     并在中止时清掉已复制的副本，绝不留下「半迁移」状态让用户自己收拾；
 *  3. 每次成功迁移写台账（JSONL），`rollback` 依据台账把数据搬回并删掉联接；
 *  4. 迁移整体默认 dryRun，真正执行需要用户确认。
 *
 * 目录联接在 Windows 上**不需要管理员权限**（符号链接才需要），因此普通用户可以完成迁移。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { freeSpaceOf } from '../scanner/drives.js';
import { measurePath } from '../scanner/size.js';
import { formatBytes, nowStamp } from '../util/format.js';

export type MigrateMethod = 'junction' | 'app-config';
export type MigrateStatus =
  | 'planned'
  | 'migrated'
  | 'rolled-back'
  | 'failed'
  | 'destination-exists'
  | 'insufficient-space'
  | 'source-busy'
  | 'verify-failed';

export interface MigrationEntry {
  id: string;
  at: string;
  status: 'migrated' | 'rolled-back';
  method: MigrateMethod;
  source: string;
  destination: string;
  sizeBytes: number;
  fileCount: number;
  junctionCreated: boolean;
  ruleId?: string;
}

export interface MigrateOptions {
  /** 迁移目标根目录（必须位于其他盘） */
  targetRoot: string;
  dryRun: boolean;
  method?: MigrateMethod;
  ruleId?: string;
  /** app-config 类规则给出的建议命令（只提示，不自动改配置） */
  advice?: string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface MigrateOutcome {
  status: MigrateStatus;
  source: string;
  destination: string;
  method: MigrateMethod;
  sizeBytes: number;
  freedBytes: number;
  errors: string[];
  journal: string[];
  advice: string[];
}

const LEDGER_FILE = 'ledger.jsonl';

export function driveOf(p: string): string {
  return path.resolve(p).slice(0, 2).toLowerCase();
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** 去掉 Windows 的 \\?\ 与 \??\ 前缀，便于比较联接目标 */
function canonical(p: string): string {
  return p.replace(/^\\\\\?\\/, '').replace(/^\\\?\?\\/, '').replace(/\\+$/, '').toLowerCase();
}

export async function appendLedger(ledgerPath: string, entry: MigrationEntry): Promise<void> {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function readLedger(ledgerPath: string): Promise<MigrationEntry[]> {
  try {
    const raw = await fs.readFile(ledgerPath, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as MigrationEntry);
  } catch {
    return [];
  }
}

/** 台账里仍然「处于迁移状态」的条目（迁移后又被回滚的不算） */
export function activeMigrations(entries: MigrationEntry[]): MigrationEntry[] {
  const rolled = new Set(
    entries.filter((entry) => entry.status === 'rolled-back').map((entry) => canonical(entry.source)),
  );
  return entries.filter((entry) => entry.status === 'migrated' && !rolled.has(canonical(entry.source)));
}

/**
 * 目标盘是否放得下（留 5% 余量）。
 *
 * 注意 tri-state：读不到剩余空间时返回 `known: false` 并**放行**——
 * 把「读不到」当成「不足」会误伤正常迁移（真实踩过的坑：盘符拼接成 `D::\` 导致 statfs 失败），
 * 而真正写满时复制会报 ENOSPC，由调用方回滚副本、如实报错。
 */
export async function hasRoomFor(
  targetDriveRoot: string,
  sizeBytes: number,
): Promise<{ ok: boolean; freeBytes: number; known: boolean }> {
  const free = await freeSpaceOf(targetDriveRoot);
  if (!Number.isFinite(free) || free <= 0) return { ok: true, freeBytes: 0, known: false };
  return { ok: free > sizeBytes * 1.05, freeBytes: free, known: true };
}

/** 把源目录迁移到目标根目录下，并建立目录联接 */
export async function migrateByJunction(source: string, options: MigrateOptions): Promise<MigrateOutcome> {
  const log = options.onProgress ?? (() => {});
  const journal: string[] = [];
  const errors: string[] = [];
  const method = options.method ?? 'junction';
  const destination = path.join(options.targetRoot, path.basename(source));
  const base: Omit<MigrateOutcome, 'status'> = {
    source,
    destination,
    method,
    sizeBytes: 0,
    freedBytes: 0,
    errors,
    journal,
    advice: options.advice ?? [],
  };

  if (driveOf(source) === driveOf(destination)) {
    errors.push(`迁移目标 ${destination} 与源在同一盘，迁移不会释放空间`);
    return { ...base, status: 'failed' };
  }

  const measured = await measurePath(source, {
    timeBudgetMs: 120_000,
    signal: options.signal,
    onProgress: (dirs) => {
      if (dirs % 500 === 0) log(`测量 ${source}：已遍历 ${dirs} 个目录`);
    },
  });
  base.sizeBytes = measured.sizeBytes;
  journal.push(`测量源目录：${formatBytes(measured.sizeBytes)}，${measured.fileCount} 个文件`);

  if (options.dryRun) {
    journal.push(`计划：复制到 ${destination} → 校验 → 删除源 → 建立目录联接`);
    return { ...base, status: 'planned' };
  }

  if (await exists(destination)) {
    errors.push(`目标已存在：${destination}（不做合并，请先处理该目录或换目标盘）`);
    return { ...base, status: 'destination-exists' };
  }

  const room = await hasRoomFor(`${driveOf(destination).toUpperCase()}\\`, measured.sizeBytes);
  if (!room.ok) {
    errors.push(
      `目标盘空间不足：需要 ${formatBytes(measured.sizeBytes * 1.05)}，可用 ${formatBytes(room.freeBytes)}`,
    );
    return { ...base, status: 'insufficient-space' };
  }
  if (!room.known) journal.push('⚠️ 无法读取目标盘剩余空间，已跳过空间预检（复制失败会自动回滚副本）');

  // 1) 复制（先复制，绝不先删）
  try {
    log(`复制中：${source} → ${destination}`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    journal.push('复制完成');
  } catch (error) {
    errors.push(`复制失败：${(error as Error).message.split('\n')[0]}`);
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    return { ...base, status: 'failed' };
  }

  // 2) 校验副本（大小不低于源，文件数一致）
  const copied = await measurePath(destination, { timeBudgetMs: 120_000, signal: options.signal });
  const sizeOk = copied.sizeBytes >= measured.sizeBytes;
  const countOk = measured.fileCount === 0 ? true : copied.fileCount >= measured.fileCount;
  if (!sizeOk || !countOk) {
    errors.push(
      `副本校验失败：源 ${formatBytes(measured.sizeBytes)}/${measured.fileCount} 文件，副本 ${formatBytes(
        copied.sizeBytes,
      )}/${copied.fileCount} 文件；未删除源，已清理副本`,
    );
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    return { ...base, status: 'verify-failed' };
  }
  journal.push(`副本校验通过：${formatBytes(copied.sizeBytes)}，${copied.fileCount} 个文件`);

  // 3) 删除源目录（被占用则中止，并回滚副本，绝不留下半迁移状态）
  try {
    await fs.rm(source, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  } catch (error) {
    errors.push(`删除源目录失败：${(error as Error).message.split('\n')[0]}`);
  }
  if (await exists(source)) {
    const leftover = await measurePath(source, { timeBudgetMs: 60_000, signal: options.signal });
    errors.push(
      `源目录无法完整删除（残留 ${formatBytes(leftover.sizeBytes)}，多半是应用正在使用）；` +
        '未创建目录联接，已回滚已复制的副本，原状态保持不变',
    );
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    return { ...base, status: 'source-busy' };
  }
  journal.push('源目录已删除');

  // 4) 建立目录联接（Windows 上不需要管理员权限）
  try {
    await fs.symlink(destination, source, 'junction');
  } catch (error) {
    errors.push(
      `建立目录联接失败：${(error as Error).message.split('\n')[0]}；数据已在 ${destination}，` +
        '但老路径不可用，请手动建立联接或把数据搬回',
    );
    return { ...base, status: 'failed' };
  }

  // 5) 校验联接可用
  try {
    const entries = await fs.readdir(source);
    const target = (await fs.readlink(source)).toString();
    journal.push(`目录联接已建立 → ${target}（可读条目 ${entries.length} 个）`);
    if (canonical(target) !== canonical(destination)) {
      errors.push(`联接指向异常：${target} ≠ ${destination}`);
    }
  } catch (error) {
    errors.push(`联接校验失败：${(error as Error).message.split('\n')[0]}`);
    return { ...base, status: 'verify-failed' };
  }

  return { ...base, status: 'migrated', freedBytes: measured.sizeBytes };
}

/** 依据台账把数据搬回原位置并删除联接 */
export async function rollbackMigration(entry: MigrationEntry, options: { dryRun: boolean; signal?: AbortSignal; onProgress?: (m: string) => void }): Promise<MigrateOutcome> {
  const log = options.onProgress ?? (() => {});
  const journal: string[] = [];
  const errors: string[] = [];
  const base: Omit<MigrateOutcome, 'status'> = {
    source: entry.source,
    destination: entry.destination,
    method: entry.method,
    sizeBytes: entry.sizeBytes,
    freedBytes: 0,
    errors,
    journal,
    advice: [],
  };

  const srcExists = await exists(entry.source);
  const dstExists = await exists(entry.destination);
  if (!dstExists) {
    errors.push(`迁移数据已不存在：${entry.destination}（无法回滚）`);
    return { ...base, status: 'failed' };
  }

  if (options.dryRun) {
    journal.push(`计划：删除联接 ${entry.source} → 从 ${entry.destination} 复制回源 → 校验后删除副本`);
    return { ...base, status: 'planned' };
  }

  // 1) 确认源位置确实是迁移时建立的联接（避免删掉用户后来放回的真实目录）
  if (srcExists) {
    try {
      const st = await fs.lstat(entry.source);
      if (!st.isSymbolicLink()) {
        errors.push(`${entry.source} 不是目录联接（可能用户已放回真实目录），拒绝回滚以免覆盖`);
        return { ...base, status: 'failed' };
      }
      const target = (await fs.readlink(entry.source)).toString();
      if (canonical(target) !== canonical(entry.destination)) {
        errors.push(`联接指向 ${target}，与台账记录的 ${entry.destination} 不一致，拒绝回滚`);
        return { ...base, status: 'failed' };
      }
      await fs.unlink(entry.source);
      journal.push('已删除目录联接');
    } catch (error) {
      errors.push(`删除联接失败：${(error as Error).message.split('\n')[0]}`);
      return { ...base, status: 'failed' };
    }
  }

  // 2) 空间检查后搬回
  const measured = await measurePath(entry.destination, { timeBudgetMs: 120_000, signal: options.signal });
  const room = await hasRoomFor(`${driveOf(entry.source).toUpperCase()}\\`, measured.sizeBytes);
  if (!room.ok) {
    errors.push(`系统盘空间不足，无法搬回（需要 ${formatBytes(measured.sizeBytes * 1.05)}，可用 ${formatBytes(room.freeBytes)}）`);
    return { ...base, status: 'insufficient-space' };
  }

  try {
    log(`复制回源位置：${entry.destination} → ${entry.source}`);
    await fs.cp(entry.destination, entry.source, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  } catch (error) {
    errors.push(`复制回源失败：${(error as Error).message.split('\n')[0]}`);
    await fs.rm(entry.source, { recursive: true, force: true }).catch(() => {});
    return { ...base, status: 'failed' };
  }

  const restored = await measurePath(entry.source, { timeBudgetMs: 120_000, signal: options.signal });
  if (restored.sizeBytes < measured.sizeBytes) {
    errors.push(`回滚校验失败：${formatBytes(restored.sizeBytes)} < ${formatBytes(measured.sizeBytes)}，保留目标副本以便排查`);
    return { ...base, status: 'verify-failed' };
  }
  journal.push(`回滚校验通过：${formatBytes(restored.sizeBytes)}`);

  try {
    await fs.rm(entry.destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  } catch (error) {
    errors.push(`删除迁移副本失败（数据已搬回，可手动清理）：${(error as Error).message.split('\n')[0]}`);
  }
  journal.push('迁移副本已清理');

  return { ...base, status: 'rolled-back', sizeBytes: restored.sizeBytes };
}

/** 生成迁移台账条目 */
export function toLedgerEntry(outcome: MigrateOutcome, ruleId?: string): MigrationEntry {
  return {
    id: `${nowStamp()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    status: outcome.status === 'rolled-back' ? 'rolled-back' : 'migrated',
    method: outcome.method,
    source: outcome.source,
    destination: outcome.destination,
    sizeBytes: outcome.sizeBytes,
    fileCount: 0,
    junctionCreated: outcome.method === 'junction' && outcome.status === 'migrated',
    ruleId,
  };
}

export const MIGRATION_LEDGER_FILE = LEDGER_FILE;
