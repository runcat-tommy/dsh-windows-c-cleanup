/**
 * 快速自检：验证规则加载、路径展开、规则匹配与目录测量是否正常。
 * 运行：npm run smoke
 */
import { buildRuleIndex, expandTemplate, pickWinner } from '../src/rules/match.js';
import { loadRules } from '../src/rules/load.js';
import { listDrives, pickMigrationTarget } from '../src/scanner/drives.js';
import { measurePath } from '../src/scanner/size.js';
import { scanTopTree } from '../src/scanner/topTree.js';
import { formatBytes } from '../src/util/format.js';

const t0 = Date.now();

const { ruleSet, warnings } = await loadRules();
console.log(`规则库 v${ruleSet.version}：${ruleSet.rules.length} 条路径规则，${ruleSet.longTermActions.length} 项长期防护`);
if (warnings.length) warnings.forEach((w) => console.log(`⚠️ ${w}`));

// 1) 占位符展开
const samples = ['%LOCALAPPDATA%\\npm-cache', '%PROGRAMFILES(X86)%', '%SYSTEMDRIVE%\\$Recycle.Bin', '%LOCALAPPDATA%\\*-updater'];
for (const s of samples) console.log(`展开 ${s} → ${expandTemplate(s)}`);

// 2) 规则匹配
const index = buildRuleIndex(ruleSet.rules);
const cases: Array<[string, string]> = [
  [`${process.env.LOCALAPPDATA}\\Temp`, 'safe'],
  [`${process.env.LOCALAPPDATA}\\npm-cache`, 'migrate'],
  [`${process.env.APPDATA}\\Tencent\\WXWork\\upgrade`, 'safe'],
  [`${process.env.APPDATA}\\Tencent\\WXWork\\data`, 'protected'],
  [`${process.env.WINDIR}\\WinSxS`, 'caution'],
  [`${process.env.USERPROFILE}\\Documents`, 'protected'],
  [`${process.env.USERPROFILE}\\some-unknown-dir`, 'protected'],
];
let pass = 0;
for (const [p, expected] of cases) {
  const winner = pickWinner(p, index);
  const got = winner?.rule.grade ?? 'protected';
  const ok = got === expected;
  pass += ok ? 1 : 0;
  console.log(`${ok ? '✅' : '❌'} ${p} → ${got}${ok ? '' : `（期望 ${expected}）`} [${winner?.rule.id ?? 'unmatched'}]`);
}
console.log(`规则匹配：${pass}/${cases.length} 通过`);

// 3) 盘信息
const drives = await listDrives();
for (const d of drives) {
  console.log(`${d.isSystem ? '★' : ' '} ${d.letter}: 空闲 ${formatBytes(d.freeBytes)} / ${formatBytes(d.totalBytes)}`);
}
const target = pickMigrationTarget(drives);
console.log(`迁移目标盘建议：${target ? `${target.letter}:` : '无其他盘'}`);

// 4) 限时测量 + 深度受限的 Top-N（小规模验证，避免耗时）
const measureTarget = `${process.env.LOCALAPPDATA}\\Temp`;
const measured = await measurePath(measureTarget, { timeBudgetMs: 15_000 });
console.log(
  `测量 ${measureTarget} → ${formatBytes(measured.sizeBytes)}，${measured.fileCount} 个文件${measured.partial ? '（超时截断）' : ''}`,
);

const top = await scanTopTree(`${process.env.USERPROFILE}`, { maxDepth: 1, topN: 8, timeBudgetMs: 20_000 });
console.log(`Top-N（用户目录，深度 1，${(top.durationMs / 1000).toFixed(1)}s${top.partial ? '，超时截断' : ''}）：`);
for (const node of top.items.slice(0, 8)) {
  console.log(`   ${formatBytes(node.sizeBytes).padStart(10)}  ${node.path}`);
}

console.log(`\n自检完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
