/**
 * JSON 报告：给下游程序（GUI、脚本、CI、监控）用的机器可读版本。
 *
 * 形态约定：带 `schema` 版本号，便于将来演进；`plan` 原样保留，
 * 趋势与告警作为顶层兄弟字段，避免污染扫描结果结构。
 */
import type { Trend } from '../history/index.js';
import type { Plan } from '../rules/schema.js';

export const JSON_REPORT_SCHEMA = 'dsh-windows-c-cleanup/report@1';

export interface JsonReportExtras {
  generatedAt: string;
  trend?: Trend;
  alerts?: string[];
  historyPath?: string;
  scheduler?: string;
}

export function renderJsonReport(plan: Plan, extras: JsonReportExtras): string {
  const payload = {
    schema: JSON_REPORT_SCHEMA,
    generatedAt: extras.generatedAt,
    scan: {
      id: plan.id,
      createdAt: plan.createdAt,
      partial: plan.partial,
      stats: plan.scanStats,
    },
    summary: plan.summary,
    groups: {
      safe: plan.groups.safe,
      caution: plan.groups.caution,
      migrate: plan.groups.migrate,
      protected: plan.groups.protected,
    },
    bigItems: plan.bigItems,
    longTerm: plan.longTerm,
    drives: plan.drives,
    migrationTarget: plan.migrationTarget ?? null,
    trend: extras.trend ?? null,
    alerts: extras.alerts ?? [],
    historyPath: extras.historyPath ?? null,
    scheduler: extras.scheduler ?? null,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
