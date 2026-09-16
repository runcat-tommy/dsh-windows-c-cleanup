/**
 * 执行报告渲染：逐项结果 + 真实释放量 + 被拒绝项的理由 + 提权任务日志摘要。
 *
 * 与扫描报告分开成文件，便于审计「谁在什么时候删了什么」。
 */
import type { ExecuteReport } from '../executor/index.js';
import { formatBytes, formatGB, shortPath } from '../util/format.js';

const ACTION_LABEL: Record<string, string> = {
  deleted: '✅ 已删除',
  trashed: '📦 已移入暂存区',
  partial: '⚠️ 部分完成（有文件被占用）',
  failed: '❌ 执行失败',
  refused: '🛡️ 已拒绝',
  planned: '📝 计划执行（dryRun）',
  'needs-elevation': '🔑 需要管理员权限',
  'elevation-canceled': '🚫 用户取消 UAC',
  migrated: '➡️ 已迁移到其他盘',
  'rolled-back': '↩️ 已回滚迁移',
};

const MODE_LABEL: Record<string, string> = {
  permanent: '永久删除',
  trash: '暂存区（可恢复）',
  migrate: '迁移到其他盘（原位置保留目录联接）',
  rollback: '回滚迁移（把数据搬回 C 盘）',
};

function tableRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

export function renderExecutionReport(report: ExecuteReport): string {
  const lines: string[] = [];
  lines.push(`# C 盘清理执行报告 ${report.startedAt.slice(0, 19).replace('T', ' ')}`);
  lines.push('');
  lines.push('## 概况');
  lines.push('');
  lines.push(
    `- 模式：**${MODE_LABEL[report.mode] ?? report.mode}** ｜ dryRun：**${report.dryRun ? '是（未改动任何数据）' : '否'}**`,
  );
  if (report.trashPath) lines.push(`- 暂存区：\`${report.trashPath}\``);
  lines.push(
    `- 系统盘 ${report.systemDrive} 空闲：${formatGB(report.freeBeforeBytes)} → ${formatGB(report.freeAfterBytes)}` +
      (report.dryRun ? '（dryRun 不产生变化）' : `，**盘符空闲净增 ${formatBytes(report.freedBytes)}**`),
  );
  if (!report.dryRun) {
    lines.push(
      `- **逐项测量合计释放 ${formatBytes(report.measuredFreedBytes)}**` +
        (report.freedBytes === 0 && report.measuredFreedBytes > 0
          ? '（盘符净增为 0 是因为清理量较小、被其他进程同时写入掩盖；以逐项测量为准）'
          : ''),
    );
  }
  lines.push(`- 计划处理量合计：${formatBytes(report.plannedBytes)} ｜ 条目：${report.items.length} 项`);
  if (report.dryRun) {
    lines.push('');
    lines.push('> ⚠️ 本次为 **dryRun**：只列出将要执行的动作，**没有删除任何文件**。确认后以 `dryRun: false` 重新调用才会真正执行。');
  }
  lines.push('');

  lines.push('## 逐项结果');
  lines.push('');
  if (report.items.length === 0) {
    lines.push('_无可执行项。_');
  } else {
    lines.push(tableRow(['目标', '结果', '计划/测量大小', '实际释放', '说明']));
    lines.push(tableRow(['---', '---', '---', '---', '---']));
    for (const item of report.items) {
      lines.push(
        tableRow([
          shortPath(item.path, 64),
          ACTION_LABEL[item.action] ?? item.action,
          formatBytes(item.sizeBefore),
          item.freedBytes > 0 ? formatBytes(item.freedBytes) : '—',
          item.reason.replace(/\|/g, '/'),
        ]),
      );
    }
  }
  lines.push('');

  if (report.elevationTasks.length > 0) {
    lines.push('## 管理员级任务');
    lines.push('');
    for (const title of report.elevationTasks) lines.push(`- ${title}`);
    if (report.elevation) {
      lines.push('');
      lines.push(
        report.elevation.canceled
          ? '- 结果：**用户取消了 UAC 授权**，管理员级任务未执行。'
          : `- 结果：脚本 \`${report.elevation.scriptPath}\` 退出码 ${report.elevation.exitCode ?? '未知'}`,
      );
      if (report.elevation.logTail.trim().length > 0) {
        lines.push('');
        lines.push('```text');
        lines.push(report.elevation.logTail.trim());
        lines.push('```');
      }
    } else if (report.dryRun) {
      lines.push('');
      lines.push('- 结果：dryRun，未触发 UAC。');
    }
    lines.push('');
  }

  if (report.errors.length > 0) {
    lines.push('## 错误摘要');
    lines.push('');
    for (const error of report.errors.slice(0, 20)) lines.push(`- ${error}`);
    lines.push('');
  }

  if (report.partial) {
    lines.push('> ⚠️ 存在部分删除或需提权的项目：被占用/无权限的文件没有删掉，空间未全部释放，详情见逐项结果。');
    lines.push('');
  }

  return lines.join('\n');
}
