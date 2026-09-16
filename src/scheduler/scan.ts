/**
 * 定时扫描的执行体：独立完成「规则库 → 扫描 → 分级 → 方案 → 历史条目」全流程。
 *
 * 刻意不复用工具里的代码路径：定时任务没有调用方、没有会话、也没有人看返回值，
 * 所以它只需要产出**可信、可对比的历史条目**，范围默认取 hotspots（更快、更省 I/O）。
 */
import type { Config } from '../config.js';
import { classify } from '../classifier/index.js';
import { historyEntryFromPlan } from '../history/index.js';
import type { HistoryEntry } from '../history/index.js';
import { buildPlan } from '../planner/index.js';
import { loadRules } from '../rules/load.js';
import { buildRuleIndex } from '../rules/match.js';
import { scanSystem } from '../scanner/index.js';

export async function runScheduledScan(config: Config, options: { signal?: AbortSignal } = {}): Promise<HistoryEntry> {
  const started = Date.now();
  const scope = config.schedule.scope;
  const { ruleSet } = await loadRules({
    extraRulesFile: config.extraRulesFile,
    allowProtectedOverride: config.allowProtectedOverride,
  });
  const index = buildRuleIndex(ruleSet.rules);

  const scan = await scanSystem(
    ruleSet,
    {
      hotspotTimeBudgetMs: config.hotspotTimeBudgetMs,
      topTree: {
        enabled: scope === 'full',
        maxDepth: config.topTreeMaxDepth,
        timeBudgetMs: config.topTreeTimeBudgetMs,
      },
      signal: options.signal,
    },
    index,
  );

  const classified = classify(scan.items, ruleSet.rules, index, {
    allowProtectedOverride: config.allowProtectedOverride,
  });
  const plan = buildPlan({
    drives: scan.drives,
    items: classified,
    longTerm: ruleSet.longTermActions,
    partial: scan.partial,
    stats: {
      durationMs: scan.stats.durationMs,
      hotspotCount: scan.stats.hotspotCount,
      hotspotScanned: scan.stats.hotspotScanned,
      hotspotTotal: scan.stats.hotspotTotal,
      topTreeDirs: scan.stats.topTreeDirs,
      topTreePartial: scan.stats.topTreePartial,
      partialReasons: scan.stats.partialReasons,
    },
  });

  return historyEntryFromPlan(plan, scope, Date.now() - started);
}
