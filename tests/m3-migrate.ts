/**
 * M3 迁移层隔离验证。
 *
 * 安全约定：真实迁移/回滚只发生在 %TEMP% 沙箱与 D:\dsh-cc-m3-test 测试根目录，
 * 跑完自行清理（含目录联接的显式解除），不触碰任何真实缓存或应用数据。
 *
 * 运行：npm run m3
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Config } from '../src/config.js';
import { guardTarget } from '../src/executor/safety.js';
import { activeMigrations, migrateByJunction, readLedger } from '../src/migrator/index.js';
import { loadRules } from '../src/rules/load.js';
import { buildRuleIndex } from '../src/rules/match.js';
import { registerDiskCleanupTool } from '../src/tools/disk-cleanup.js';

const sandbox = path.join(os.tmpdir(), 'dsh-cc-m3-sandbox');
const targetRoot = 'D:\\dsh-cc-m3-test';
const ledgerPath = path.join(targetRoot, 'ledger.jsonl');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`);
}

async function makeCache(dir: string, files = 3, sizeMB = 2): Promise<number> {
  await fs.mkdir(dir, { recursive: true });
  const chunk = Buffer.alloc(sizeMB * 1024 * 1024, 42);
  for (let i = 0; i < files; i++) await fs.writeFile(path.join(dir, `f-${i}.bin`), chunk);
  await fs.writeFile(path.join(dir, 'marker.txt'), 'dsh-cc-m3-marker', 'utf8');
  return files;
}

async function lstatKind(target: string): Promise<'missing' | 'link' | 'dir' | 'file'> {
  try {
    const st = await fs.lstat(target);
    if (st.isSymbolicLink()) return 'link';
    if (st.isDirectory()) return 'dir';
    return 'file';
  } catch {
    return 'missing';
  }
}

/** 清理：先解除联接，再删目录，避免任何跟随链接的递归删除 */
async function purge(root: string): Promise<void> {
  const kind = await lstatKind(root);
  if (kind === 'missing') return;
  if (kind === 'link') {
    await fs.unlink(root);
    return;
  }
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    /* ignore */
  }
  for (const entry of entries) {
    const full = path.join(root, entry);
    const childKind = await lstatKind(full);
    if (childKind === 'link') await fs.unlink(full);
    else await fs.rm(full, { recursive: true, force: true }).catch(() => {});
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

async function main(): Promise<void> {
  console.log('=== windows-c-cleanup M3 迁移层隔离验证 ===\n');
  await purge(sandbox);
  await purge(targetRoot);
  await fs.mkdir(sandbox, { recursive: true });

  const { ruleSet } = await loadRules({});
  const index = buildRuleIndex(ruleSet.rules);
  const guardCtx = {
    index,
    systemDrive: 'C',
    allowExplicitUnmatched: false,
    allowProtectedOverride: false,
  };

  let tool: {
    execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<Record<string, never> & any>;
  };
  registerDiskCleanupTool(
    { tools: { register: (def: never) => ((tool = def as never), () => {}) } } as never,
    Config({ reportDir: sandbox, migrationRoot: targetRoot }) as never,
  );
  const call = (args: Record<string, unknown>) => tool.execute(args, { signal: new AbortController().signal });

  // ---------- 1. 迁移前置校验 ----------
  console.log('--- 1. 前置校验 ---');
  const cache = path.join(sandbox, 'fake-app-cache');
  await makeCache(cache);

  const docsVerdict = await guardTarget(path.join(os.homedir(), 'Documents'), guardCtx);
  check(
    '1.1 保护名单目录不允许迁移',
    docsVerdict.allowed === false,
    `拒绝理由：${docsVerdict.allowed ? '——' : docsVerdict.reason}`,
  );

  const sameVolume = await migrateByJunction(cache, {
    targetRoot: path.join(sandbox, 'migrated-on-c'),
    dryRun: false,
  });
  check(
    '1.2 目标与源同盘时拒绝迁移',
    sameVolume.status === 'failed' && sameVolume.errors.some((e) => e.includes('同一盘')),
    `errors=${sameVolume.errors.join('；')}`,
  );
  check('1.3 被拒绝的迁移没有改动源目录', (await lstatKind(cache)) === 'dir', `源类型=${await lstatKind(cache)}`);

  const junctionSource = path.join(sandbox, 'junction-source');
  await fs.symlink(cache, junctionSource, 'junction');
  const junctionVerdict = await guardTarget(junctionSource, guardCtx);
  check(
    '1.4 源本身是目录联接时拒绝迁移',
    junctionVerdict.allowed === false,
    `拒绝理由：${junctionVerdict.allowed ? '——' : junctionVerdict.reason}`,
  );

  // 目标同名目录已存在 → 拒绝（绝不合并）
  const conflictCache = path.join(sandbox, 'conflict-cache');
  await makeCache(conflictCache, 1, 1);
  await fs.mkdir(path.join(targetRoot, 'conflict-cache'), { recursive: true });
  const conflict = await migrateByJunction(conflictCache, { targetRoot, dryRun: false });
  check(
    '1.5 目标同名目录已存在时拒绝（不做合并）',
    conflict.status === 'destination-exists' && (await lstatKind(conflictCache)) === 'dir',
    `status=${conflict.status}｜errors=${conflict.errors.join('；')}｜源类型=${await lstatKind(conflictCache)}`,
  );

  // ---------- 2. 工具层：dryRun 默认 ----------
  console.log('\n--- 2. 工具层（disk_cleanup）---');
  const sizeBefore = (await Promise.all(['f-0.bin', 'f-1.bin', 'f-2.bin'].map(async (f) => (await fs.stat(path.join(cache, f))).size))).reduce((a, b) => a + b, 0) + 20;

  const dryRunResult = await call({ action: 'migrate', items: [cache], targetDrive: 'D' });
  const dryEntry = dryRunResult.execution?.items?.[0];
  check(
    '2.1 migrate 未传 dryRun 时默认预演（源仍是真实目录）',
    dryRunResult.status === 'dry-run' &&
      dryRunResult.execution?.dryRun === true &&
      (await lstatKind(cache)) === 'dir' &&
      dryEntry?.action === 'planned',
    `status=${dryRunResult.status}｜源类型=${await lstatKind(cache)}｜item=${JSON.stringify(dryEntry)}`,
  );
  check(
    '2.2 预演给出计划迁移量与目标路径',
    (dryRunResult.execution?.plannedBytes ?? 0) >= sizeBefore * 0.9 && String(dryEntry?.reason ?? '').length > 0,
    `plannedBytes=${dryRunResult.execution?.plannedBytes}｜目标=${dryEntry?.movedTo ?? dryRunResult.execution?.items?.[0]?.reason}`,
  );

  // ---------- 3. 真实迁移 ----------
  console.log('\n--- 3. 真实迁移 ---');
  const migrateResult = await call({ action: 'migrate', items: [cache], targetDrive: 'D', dryRun: false });
  const targetPath = path.join(targetRoot, 'fake-app-cache');
  const linkTarget = (await lstatKind(cache)) === 'link' ? (await fs.readlink(cache)).toString() : '';
  const marker = await fs.readFile(path.join(cache, 'marker.txt'), 'utf8').catch(() => '');
  const ledgerAfterMigrate = await readLedger(ledgerPath);

  check(
    '3.1 迁移成功：源位置变成目录联接，应用仍可透明读写',
    migrateResult.status === 'executed' &&
      migrateResult.execution?.migratedCount === 1 &&
      (await lstatKind(cache)) === 'link' &&
      marker === 'dsh-cc-m3-marker',
    `linkTarget=${linkTarget}｜经联接读到标记=${JSON.stringify(marker)}｜item=${JSON.stringify(migrateResult.execution?.items?.[0])}`,
  );
  check(
    '3.2 数据确实落在目标盘',
    (await lstatKind(targetPath)) === 'dir' && (await fs.readdir(targetPath)).length === 4,
    `目标条目：${(await fs.readdir(targetPath).catch(() => [])).join(', ')}`,
  );
  check(
    '3.3 台账已记录，且被识别为进行中的迁移',
    ledgerAfterMigrate.length === 1 &&
      ledgerAfterMigrate[0].source === cache &&
      activeMigrations(ledgerAfterMigrate).length === 1,
    `台账=${JSON.stringify(ledgerAfterMigrate[0] ?? null)}`,
  );
  check(
    '3.4 迁移报告已产出',
    String(migrateResult.execution?.reportPath ?? '').endsWith('.md') &&
      (await fs.stat(migrateResult.execution?.reportPath).catch(() => null)) !== null,
    `报告=${migrateResult.execution?.reportPath}`,
  );

  // ---------- 4. 回滚 ----------
  console.log('\n--- 4. 回滚 ---');
  const rollbackDry = await call({ action: 'rollback', targetDrive: 'D' });
  check(
    '4.1 rollback 默认预演（联接仍在）',
    rollbackDry.status === 'dry-run' && (await lstatKind(cache)) === 'link',
    `status=${rollbackDry.status}｜源类型=${await lstatKind(cache)}`,
  );

  const rollbackReal = await call({ action: 'rollback', targetDrive: 'D', dryRun: false });
  const ledgerAfterRollback = await readLedger(ledgerPath);
  check(
    '4.2 回滚成功：源恢复为真实目录、数据完好、联接已解除',
    rollbackReal.status === 'executed' &&
      rollbackReal.execution?.rolledBackCount === 1 &&
      (await lstatKind(cache)) === 'dir' &&
      (await fs.readFile(path.join(cache, 'marker.txt'), 'utf8').catch(() => '')) === 'dsh-cc-m3-marker',
    `源类型=${await lstatKind(cache)}｜item=${JSON.stringify(rollbackReal.execution?.items?.[0])}`,
  );
  check(
    '4.3 回滚后目标盘副本已清理，台账状态更新',
    (await lstatKind(targetPath)) === 'missing' &&
      ledgerAfterRollback.length === 2 &&
      activeMigrations(ledgerAfterRollback).length === 0,
    `目标类型=${await lstatKind(targetPath)}｜台账条数=${ledgerAfterRollback.length}｜进行中=${activeMigrations(ledgerAfterRollback).length}`,
  );

  // ---------- 5. 无记录时的回滚 ----------
  const noRecord = await call({ action: 'rollback', targetDrive: 'D' });
  check(
    '4.4 没有可回滚记录时明确说明而不是报成功',
    noRecord.status === 'not-implemented' && String(noRecord.message).includes('没有可回滚'),
    `message=${noRecord.message}`,
  );

  // ---------- 清理 ----------
  await purge(sandbox);
  await purge(targetRoot);

  console.log(`\n=== 结果：${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error('测试异常：', error);
  await purge(sandbox).catch(() => {});
  await purge(targetRoot).catch(() => {});
  process.exitCode = 1;
});
