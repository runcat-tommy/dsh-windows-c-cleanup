/**
 * Markdown 报告渲染（可视化交付物）。
 * 结构：汇总 → 🟥 大头 → 🟢 安全 → 🟡 谨慎 → 🟠 迁移 → 🔴 保护 → 🔵 长期防护 → 执行结果
 */
import type { ClassifiedItem, Plan } from '../rules/schema.js';
import { GRADE_LABEL } from '../rules/schema.js';
import type { Trend } from '../history/index.js';
import { formatBytes, formatGB, formatPercent, shortPath } from '../util/format.js';

function tableRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function itemTable(items: ClassifiedItem[], extraHeader?: string, extraCell?: (i: ClassifiedItem) => string): string {
  const lines: string[] = [];
  const header = ['路径', '大小', '文件数', '判定理由'];
  if (extraHeader) header.splice(3, 0, extraHeader);
  lines.push(tableRow(header));
  lines.push(tableRow(header.map(() => '---')));
  for (const item of items) {
    const cells = [shortPath(item.path), formatBytes(item.sizeBytes), String(item.fileCount), item.reason];
    if (extraHeader && extraCell) cells.splice(3, 0, extraCell(item));
    lines.push(tableRow(cells));
  }
  return lines.join('\n');
}

export interface RenderOptions {
  /** 是否渲染「执行结果」占位区块（M1 为只读，默认 true） */
  includeResults?: boolean;
  reportPath?: string;
  /** 与上一次扫描的对比（M4 历史趋势） */
  trend?: Trend;
  /** 最近告警（M4 定时扫描产出） */
  alerts?: string[];
  /** 历史文件位置 */
  historyPath?: string;
  /** 定时扫描状态描述 */
  scheduler?: string;
}

/** 📈 历史趋势区块：回答「谁在长回来、上一轮清理有没有用」 */
function trendSection(trend: Trend): string[] {
  const lines: string[] = [];
  lines.push('## 📈 历史趋势（与上一次扫描对比）');
  lines.push('');
  lines.push(
    `- 上一次扫描：\`${trend.previousAt.slice(0, 16).replace('T', ' ')}\`（约 ${trend.hoursAgo} 小时前）`,
  );
  lines.push(
    `- 剩余空间变化：**${trend.freeDeltaBytes >= 0 ? '+' : '−'}${formatBytes(Math.abs(trend.freeDeltaBytes))}**` +
      `（已用 ${trend.usedDeltaBytes >= 0 ? '+' : '−'}${formatBytes(Math.abs(trend.usedDeltaBytes))}）`,
  );
  lines.push('');
  if (trend.grown.length > 0) {
    lines.push('**长回来的（>100 MB）**：');
    lines.push('');
    lines.push(tableRow(['路径', '当前大小', '增长']));
    lines.push(tableRow(['---', '---', '---']));
    for (const item of trend.grown) {
      lines.push(tableRow([shortPath(item.path), formatBytes(item.sizeBytes), `+${formatBytes(item.deltaBytes)}`]));
    }
    lines.push('');
  }
  if (trend.shrunk.length > 0) {
    lines.push('**被释放的（>100 MB）**：');
    lines.push('');
    lines.push(tableRow(['路径', '当前大小', '减少']));
    lines.push(tableRow(['---', '---', '---']));
    for (const item of trend.shrunk) {
      lines.push(tableRow([shortPath(item.path), formatBytes(item.sizeBytes), `−${formatBytes(-item.deltaBytes)}`]));
    }
    lines.push('');
  }
  if (trend.appeared.length > 0) {
    lines.push(
      `**新出现的大头**：${trend.appeared.map((item) => `${shortPath(item.path, 48)}（${formatBytes(item.sizeBytes)}）`).join('、')}`,
    );
    lines.push('');
  }
  if (trend.disappeared.length > 0) {
    lines.push(
      `**本次未再测到的大头**：${trend.disappeared
        .map((item) => shortPath(item.path, 48))
        .join('、')}${trend.previousPartial ? '（上次扫描被截断，此项结论不可靠）' : ''}`,
    );
    lines.push('');
  }
  if (
    trend.grown.length === 0 &&
    trend.shrunk.length === 0 &&
    trend.appeared.length === 0 &&
    trend.disappeared.length === 0
  ) {
    lines.push('_与上一次相比没有超过 100 MB 的显著变化。_');
    lines.push('');
  }
  return lines;
}

export function renderReport(plan: Plan, options: RenderOptions = {}): string {
  const { summary, groups } = plan;
  const lines: string[] = [];

  lines.push(`# C 盘清理报告 ${plan.createdAt.slice(0, 10)}`);
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push(
    `- 计算机：\`${plan.computer}\` ｜ 方案编号：\`${plan.id}\``,
  );
  lines.push(
    `- 系统盘：总容量 **${formatGB(summary.totalBytes)}** ｜ 已用 ${formatGB(summary.usedBytes)} ｜ 剩余 **${formatGB(
      summary.freeBytes,
    )}**（${formatPercent(summary.freeBytes, summary.totalBytes)}）`,
  );
  lines.push(
    `- 可释放潜力：🟢 安全层 **${formatBytes(summary.safeBytes)}** ｜ 🟡 谨慎层 ${formatBytes(
      summary.cautionBytes,
    )} ｜ 🟠 可迁移 ${formatBytes(summary.migrateBytes)}`,
  );
  if (plan.migrationTarget) {
    lines.push(
      `- 迁移目标盘建议：**${plan.migrationTarget.letter}:\\**（空闲 ${formatGB(plan.migrationTarget.freeBytes)}）`,
    );
  }
  const driveLine = plan.drives
    .map((d) => `${d.letter}: 空闲 ${formatGB(d.freeBytes)} / ${formatGB(d.totalBytes)}`)
    .join(' ｜ ');
  lines.push(`- 全部盘符：${driveLine}`);
  if (plan.partial) {
    lines.push('');
    lines.push(`> ⚠️ 本次扫描未完全跑完（${plan.scanStats.partialReasons.join('；')}），列表可能不完整。`);
  }
  lines.push('');

  if (options.alerts && options.alerts.length > 0) {
    lines.push('## 🔔 空间告警');
    lines.push('');
    for (const alert of options.alerts) lines.push(`- ${alert}`);
    lines.push('');
  }

  if (options.trend) lines.push(...trendSection(options.trend));

  lines.push(`## 🟥 大头占用（Top ${plan.bigItems.length}，按大小降序）`);
  lines.push('');
  lines.push('> 说明：占比为各自子树大小，条目之间存在包含关系，**不可相加**；这里只回答「空间去哪儿了」。');
  lines.push('');
  if (plan.bigItems.length === 0) {
    lines.push('_未发现 2 GB 以上的大目录。_');
  } else {
    lines.push(tableRow(['路径', '大小', '占已用空间', '分级', '说明']));
    lines.push(tableRow(['---', '---', '---', '---', '---']));
    for (const item of plan.bigItems) {
      lines.push(
        tableRow([
          shortPath(item.path),
          formatBytes(item.sizeBytes),
          formatPercent(item.sizeBytes, summary.usedBytes),
          GRADE_LABEL[item.grade],
          item.reason,
        ]),
      );
    }
  }
  lines.push('');

  const sections: Array<{ grade: keyof typeof groups; header: string }> = [
    { grade: 'safe', header: '🟢 可安全删除（确认后批量执行，无数据损失）' },
    { grade: 'caution', header: '🟡 谨慎删除（可重建但代价较高，请逐项确认）' },
    { grade: 'migrate', header: '🟠 建议迁移（搬到其他盘，应用无感，可回滚）' },
    { grade: 'protected', header: '🔴 保护名单（绝不自动删除）' },
  ];

  for (const section of sections) {
    const items = groups[section.grade];
    lines.push(`## ${section.header} —— 共 ${formatBytes(items.reduce((a, i) => a + i.sizeBytes, 0))}`);
    lines.push('');
    if (items.length === 0) {
      lines.push('_无。_');
      lines.push('');
      continue;
    }
    if (section.grade === 'migrate') {
      lines.push(
        itemTable(items, '迁移方式', (i) =>
          i.migrate
            ? `${i.migrate.method === 'junction' ? 'junction 目录联接' : '应用配置改路径'}${
                i.migrate.configHint ? `（${i.migrate.configHint}）` : ''
              }`
            : '待定',
        ),
      );
    } else {
      lines.push(itemTable(items));
    }
    lines.push('');
  }

  lines.push(`## ${GRADE_LABEL.longterm}（配置类动作，一次性做好可长期少清理）`);
  lines.push('');
  if (plan.longTerm.length === 0) {
    lines.push('_无。_');
  } else {
    lines.push(tableRow(['措施', '检测条件', '操作', '收益']));
    lines.push(tableRow(['---', '---', '---', '---']));
    for (const action of plan.longTerm) {
      lines.push(tableRow([action.title, action.detect, action.action, action.benefit]));
    }
  }
  lines.push('');

  if (options.includeResults !== false) {
    lines.push('## 执行结果');
    lines.push('');
    lines.push(
      '_本报告只描述「现状与建议」，**扫描本身不删除任何文件**。执行请调用 `disk_cleanup` 的 `apply` / `trash`（默认 dryRun，用户确认后传 `dryRun: false`）或 `migrate` / `rollback`；每次执行都会另外生成一份《C盘清理执行报告》。_',
    );
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  const coverage =
    plan.scanStats.hotspotTotal > 0
      ? `${plan.scanStats.hotspotScanned}/${plan.scanStats.hotspotTotal}（${formatPercent(
          plan.scanStats.hotspotScanned,
          plan.scanStats.hotspotTotal,
        )}）`
      : '—';
  lines.push(
    `扫描统计：耗时 ${(plan.scanStats.durationMs / 1000).toFixed(1)} 秒 ｜ 热点规则覆盖 ${coverage} ｜ Top-N 遍历 ${
      plan.scanStats.topTreeDirs
    } 个目录${plan.scanStats.topTreePartial ? '（超时截断）' : ''} ｜ 分级候选项 ${plan.scanStats.hotspotCount + plan.scanStats.topTreeDirs} 项`,
  );
  if (options.reportPath) lines.push(`报告文件：\`${options.reportPath}\``);
  if (options.historyPath) lines.push(`历史记录：\`${options.historyPath}\`（每次扫描追加一条，用于趋势对比）`);
  if (options.scheduler) lines.push(`定时扫描：${options.scheduler}`);

  return lines.join('\n');
}
