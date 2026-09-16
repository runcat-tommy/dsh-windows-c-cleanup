/**
 * M2 执行层隔离验证。
 *
 * 安全约定：真实删除与移动**只发生在 %TEMP% 下的测试沙箱**以及专用测试暂存区
 * （D:\to_delete-dsh-cc-test），跑完自行清理；保护名单用例只验证「拒绝」，
 * 不会触碰任何用户真实数据。
 *
 * 运行：npm run m2
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Config } from '../src/config.js';
import { executeCleanup } from '../src/executor/index.js';
import { guardTarget } from '../src/executor/safety.js';
import { moveToTrash, readManifest } from '../src/executor/trash.js';
import { loadRules } from '../src/rules/load.js';
import { buildRuleIndex } from '../src/rules/match.js';
import { registerDiskCleanupTool } from '../src/tools/disk-cleanup.js';

const MB = 1024 * 1024;
const sandbox = path.join(os.tmpdir(), 'dsh-cc-m2-sandbox');
/** 保护名单用例的目标：真实用户文档目录（用 homedir 推导，避免把用户名写进仓库） */
const docsDir = path.join(os.homedir(), 'Documents');
const trashRoot = 'D:\\to_delete-dsh-cc-test';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`);
}

async function makeJunk(dir: string, files = 3, sizeMB = 2): Promise<number> {
  await fs.mkdir(dir, { recursive: true });
  const chunk = Buffer.alloc(sizeMB * MB, 7);
  for (let i = 0; i < files; i++) await fs.writeFile(path.join(dir, `junk-${i}.bin`), chunk);
  return files * sizeMB * MB;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log('=== windows-c-cleanup M2 执行层隔离验证 ===\n');
  await fs.rm(sandbox, { recursive: true, force: true });
  await fs.rm(trashRoot, { recursive: true, force: true });
  await fs.mkdir(sandbox, { recursive: true });

  const { ruleSet } = await loadRules({});
  const index = buildRuleIndex(ruleSet.rules);
  const guardCtx = {
    index,
    systemDrive: 'C',
    allowExplicitUnmatched: false,
    allowProtectedOverride: false,
  };

  // ---------- 1. 安全闸 ----------
  console.log('--- 1. 安全闸 ---');
  const sandboxVerdict = await guardTarget(sandbox, guardCtx);
  check(
    '1.1 %TEMP% 下的测试沙箱允许清理',
    sandboxVerdict.allowed === true,
    `verdict=${JSON.stringify(sandboxVerdict)}`,
  );

  const docsVerdict = await guardTarget(docsDir, guardCtx);
  check(
    '1.2 用户文档目录被拒绝（保护名单硬约束）',
    docsVerdict.allowed === false,
    `拒绝理由：${docsVerdict.allowed ? '——' : docsVerdict.reason}`,
  );

  const rootVerdict = await guardTarget('C:\\', guardCtx);
  check('1.3 盘根被拒绝', rootVerdict.allowed === false, `拒绝理由：${rootVerdict.allowed ? '——' : rootVerdict.reason}`);

  const missingVerdict = await guardTarget(path.join(sandbox, 'not-exist-dir'), guardCtx);
  check(
    '1.4 不存在的路径被拒绝',
    missingVerdict.allowed === false,
    `拒绝理由：${missingVerdict.allowed ? '——' : missingVerdict.reason}`,
  );

  // 目录联接：删除语义漂移，必须拒绝
  const realDir = path.join(sandbox, 'real-target');
  const linkDir = path.join(sandbox, 'junction-link');
  await fs.mkdir(realDir, { recursive: true });
  await fs.symlink(realDir, linkDir, 'junction');
  const linkVerdict = await guardTarget(linkDir, guardCtx);
  check(
    '1.5 目录联接（junction）被拒绝',
    linkVerdict.allowed === false,
    `拒绝理由：${linkVerdict.allowed ? '——' : linkVerdict.reason}`,
  );

  const otherDriveVerdict = await guardTarget('D:\\workspace_deepseek_harness', guardCtx);
  check(
    '1.6 非系统盘路径被拒绝（越界保护）',
    otherDriveVerdict.allowed === false,
    `拒绝理由：${otherDriveVerdict.allowed ? '——' : otherDriveVerdict.reason}`,
  );

  const emptyIndex = buildRuleIndex([]);
  const unmatchedVerdict = await guardTarget(realDir, { ...guardCtx, index: emptyIndex });
  check(
    '1.7 未收录规则库的路径被拒绝（不明即不删）',
    unmatchedVerdict.allowed === false && unmatchedVerdict.ruleId === 'unmatched',
    `拒绝理由：${unmatchedVerdict.allowed ? '——' : unmatchedVerdict.reason}`,
  );

  const optInVerdict = await guardTarget(realDir, { ...guardCtx, index: emptyIndex, allowExplicitUnmatched: true });
  check('1.8 显式开启 allowExplicitUnmatched 后放行', optInVerdict.allowed === true, `verdict=${JSON.stringify(optInVerdict)}`);

  // ---------- 2. 工具层 ----------
  console.log('\n--- 2. 工具层（disk_cleanup）---');
  let tool: {
    execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<Record<string, never> & any>;
  };
  registerDiskCleanupTool(
    { tools: { register: (def: never) => ((tool = def as never), () => {}) } } as never,
    Config({ reportDir: sandbox }) as never,
  );
  const call = (args: Record<string, unknown>) => tool.execute(args, { signal: new AbortController().signal });

  const junkA = path.join(sandbox, 'junk-permanent');
  const sizeA = await makeJunk(junkA);

  const dryRunResult = await call({ action: 'apply', items: [junkA] });
  check(
    '2.1 apply 未传 dryRun 时默认预演（不删任何文件）',
    dryRunResult.status === 'dry-run' && dryRunResult.execution?.dryRun === true && (await exists(junkA)),
    `status=${dryRunResult.status} 计划处理=${dryRunResult.execution?.plannedBytes} 字节（实际 ${sizeA}）`,
  );
  check(
    '2.2 预演如实报告计划大小',
    (dryRunResult.execution?.plannedBytes ?? 0) >= sizeA * 0.9,
    `plannedBytes=${dryRunResult.execution?.plannedBytes} expected≈${sizeA}`,
  );
  // 宿主实测教训：执行层曾把 `${systemDrive}\\` 拼成 `C\`（模板字面量里 \\ 只是一个反斜杠，丢了冒号），
  // statfs 抛 ENOENT 被 catch 吞掉后返回 0，报告写出「系统盘 C 空闲 0.00 GB」。
  check(
    '2.2a 预演输出里的系统盘空闲是真实数字（不是脏 catch 出来的 0）',
    (dryRunResult.freeBytes ?? 0) > 1024 ** 3 &&
      (dryRunResult.usedBytes ?? 0) + (dryRunResult.freeBytes ?? 0) <= (dryRunResult.totalBytes ?? 0) + 1024 ** 2,
    `free=${((dryRunResult.freeBytes ?? 0) / 1024 ** 3).toFixed(2)} GB ｜ total=${((dryRunResult.totalBytes ?? 0) / 1024 ** 3).toFixed(2)} GB`,
  );

  const cautionResult = await call({ action: 'apply', grade: 'caution' });
  check(
    '2.3 谨慎层不允许按级别批量（必须逐项 items）',
    cautionResult.status === 'not-implemented' && String(cautionResult.message).includes('逐项'),
    `message=${cautionResult.message}`,
  );

  const protectedResult = await call({ action: 'apply', items: [docsDir], dryRun: false });
  check(
    '2.4 显式点名保护名单也拒绝执行，且文件仍在',
    protectedResult.execution?.refusedCount === 1 && (await exists(docsDir)),
    `refused=${protectedResult.execution?.refusedCount} 理由=${protectedResult.execution?.items?.[0]?.reason}`,
  );

  const deleteResult = await call({ action: 'apply', items: [junkA], dryRun: false, mode: 'permanent' });
  const item0 = deleteResult.execution?.items?.[0];
  check(
    '2.5 真实删除（permanent）成功且文件已消失',
    deleteResult.status === 'executed' &&
      deleteResult.execution?.deletedCount === 1 &&
      (deleteResult.execution?.measuredFreedBytes ?? 0) >= sizeA * 0.9 &&
      !(await exists(junkA)),
    `逐项测量释放=${deleteResult.execution?.measuredFreedBytes} 字节（测试文件 ${sizeA}）｜盘符净增=${deleteResult.execution?.freedBytes}｜item=${JSON.stringify(item0)}`,
  );

  const junkB = path.join(sandbox, 'junk-trash');
  const sizeB = await makeJunk(junkB, 2, 2);
  const trashResult = await call({
    action: 'trash',
    items: [junkB],
    dryRun: false,
    trashPath: trashRoot,
  });
  const movedTo = trashResult.execution?.items?.[0]?.reason ?? '';
  const manifest = await readManifest(trashRoot);
  check(
    '2.6 暂存区模式：跨盘移动成功、源已消失、台账已记录',
    trashResult.execution?.trashedCount === 1 &&
      (trashResult.execution?.measuredFreedBytes ?? 0) >= sizeB * 0.9 &&
      !(await exists(junkB)) &&
      manifest.length === 1 &&
      manifest[0].originalPath === junkB,
    `逐项测量释放=${trashResult.execution?.measuredFreedBytes}（测试文件 ${sizeB}）｜台账=${JSON.stringify(manifest[0] ?? null)}｜${movedTo}`,
  );

  // ---------- 3. 直接调用执行引擎的边界用例 ----------
  console.log('\n--- 3. 执行引擎边界 ---');
  const sameVolumeJunk = path.join(sandbox, 'junk-same-volume');
  await makeJunk(sameVolumeJunk, 1, 1);
  const sameVolume = await moveToTrash(sameVolumeJunk, path.join(sandbox, 'trash-on-c'));
  check(
    '3.1 暂存区与源同盘时拒绝（移动不释放空间）',
    sameVolume.status === 'same-volume',
    `errors=${sameVolume.errors.join('；')}`,
  );

  const elevationDryRun = await executeCleanup({
    targets: ['C:\\Windows\\Temp'],
    mode: 'permanent',
    dryRun: true,
    systemDrive: 'C',
    index,
    allowExplicitUnmatched: false,
    allowProtectedOverride: false,
  });
  check(
    '3.2 管理员级目录被路由到提权任务（预演不触发 UAC）',
    elevationDryRun.elevationTasks.length >= 1 && elevationDryRun.items[0]?.action === 'planned',
    `任务=${JSON.stringify(elevationDryRun.elevationTasks)}｜item=${JSON.stringify(elevationDryRun.items[0])}`,
  );

  const partialDryRun = await executeCleanup({
    targets: [path.join(sandbox, 'not-exist-at-all')],
    mode: 'permanent',
    dryRun: false,
    systemDrive: 'C',
    index,
    allowExplicitUnmatched: false,
    allowProtectedOverride: false,
  });
  check(
    '3.3 不存在的目标执行时被拒绝而不是报成功',
    partialDryRun.items[0]?.action === 'refused' && partialDryRun.freedBytes === 0,
    `item=${JSON.stringify(partialDryRun.items[0])}`,
  );

  // ---------- 清理 ----------
  await fs.rm(sandbox, { recursive: true, force: true });
  await fs.rm(trashRoot, { recursive: true, force: true });

  console.log(`\n=== 结果：${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error('测试异常：', error);
  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
  await fs.rm(trashRoot, { recursive: true, force: true }).catch(() => {});
  process.exitCode = 1;
});
