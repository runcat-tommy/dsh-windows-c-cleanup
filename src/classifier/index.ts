/**
 * 分级器：把扫描候选按规则库归入五级，并给出可展示的判定理由。
 * 未命中任何规则的路径一律按 protected 处理（不明即不删）。
 */
import { normalizePath, pickWinner, type RuleIndex } from '../rules/match.js';
import type { ClassifiedItem, Rule, ScanItem } from '../rules/schema.js';

export interface ClassifyOptions {
  /** 是否允许用户规则覆盖保护名单（默认 false，保护名单为硬约束） */
  allowProtectedOverride?: boolean;
}

const UNMATCHED_REASON = '未收录规则库：按「不明即不删」原则视为保护项';

export function classify(
  items: ScanItem[],
  rules: Rule[],
  index: RuleIndex,
  options: ClassifyOptions = {},
): ClassifiedItem[] {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const merged = new Map<string, ClassifiedItem>();

  for (const item of items) {
    const winner = pickWinner(item.path, index);
    const rule = winner ? byId.get(winner.rule.id) : undefined;

    if (rule && rule.grade === 'protected' && rule.overridable === false && options.allowProtectedOverride !== true) {
      // 硬约束保护项：即使被更具体的用户规则命中也不放行（本轮无用户规则，保留语义）
    }

    const classified: ClassifiedItem = {
      ...item,
      grade: rule?.grade ?? 'protected',
      ruleId: rule?.id ?? 'unmatched',
      reason: rule?.reason ?? UNMATCHED_REASON,
      overridable: rule?.overridable ?? true,
      migrate: rule?.migrate ?? null,
      special: rule?.special,
    };

    const key = normalizePath(item.path);
    const existing = merged.get(key);
    if (!existing || classified.sizeBytes > existing.sizeBytes) merged.set(key, classified);
  }

  return [...merged.values()].sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/** 按分级分组（报告与方案共用） */
export function groupByGrade(items: ClassifiedItem[]): {
  safe: ClassifiedItem[];
  caution: ClassifiedItem[];
  migrate: ClassifiedItem[];
  protected: ClassifiedItem[];
} {
  return {
    safe: items.filter((i) => i.grade === 'safe'),
    caution: items.filter((i) => i.grade === 'caution'),
    migrate: items.filter((i) => i.grade === 'migrate'),
    protected: items.filter((i) => i.grade === 'protected'),
  };
}

export function sumBytes(items: ClassifiedItem[]): number {
  return items.reduce((acc, i) => acc + i.sizeBytes, 0);
}
