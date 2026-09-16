/**
 * 方案构建：把分级结果整理成可展示、可勾选的清理方案（M1 只生成，不执行）。
 */
import { groupByGrade, sumBytes } from '../classifier/index.js';
import { normalizePath } from '../rules/match.js';
import { pickMigrationTarget } from '../scanner/drives.js';
import type { ClassifiedItem, DriveInfo, LongTermAction, Plan } from '../rules/schema.js';
import { nowStamp } from '../util/format.js';

export interface BuildPlanInput {
  drives: DriveInfo[];
  items: ClassifiedItem[];
  longTerm: LongTermAction[];
  partial: boolean;
  stats: Plan['scanStats'];
  /** 大头展示条数，默认 12 */
  bigTopN?: number;
  computer?: string;
}

/**
 * 折叠「容器项」：同一条空间不要用父子两条重复表述。
 *
 * 判定：两项存在祖先/后代关系且体量几乎相同（≥95%）时视为同一空间的重叠表述，保留一条：
 *  - 只有一方命中规则库 → 保留命中规则的那条（例如 C:\$Recycle.Bin 胜过其 SID 子目录）；
 *  - 双方都命中或都未命中 → 保留更具体（后代）的那条（例如 ~ 胜过 C:\Users）。
 */
export function collapseContainers(items: ClassifiedItem[]): ClassifiedItem[] {
  return items.filter((item) => {
    const itemKey = normalizePath(item.path);
    const itemMatched = item.ruleId !== 'unmatched';
    return !items.some((other) => {
      if (other === item) return false;
      const otherKey = normalizePath(other.path);
      const itemIsAncestor = otherKey.startsWith(`${itemKey}\\`);
      const itemIsDescendant = itemKey.startsWith(`${otherKey}\\`);
      if (!itemIsAncestor && !itemIsDescendant) return false;
      if (other.sizeBytes < item.sizeBytes * 0.95) return false;
      const otherMatched = other.ruleId !== 'unmatched';
      if (itemMatched !== otherMatched) return otherMatched;
      return itemIsAncestor;
    });
  });
}

export function buildPlan(input: BuildPlanInput): Plan {
  const groups = groupByGrade(input.items);
  const system = input.drives.find((d) => d.isSystem) ?? input.drives[0];
  const totalBytes = system?.totalBytes ?? 0;
  const freeBytes = system?.freeBytes ?? 0;
  const bigItems = collapseContainers([...input.items].sort((a, b) => b.sizeBytes - a.sizeBytes)).slice(
    0,
    input.bigTopN ?? 12,
  );

  return {
    id: `plan-${nowStamp()}`,
    createdAt: new Date().toISOString(),
    computer: input.computer ?? process.env.COMPUTERNAME ?? 'unknown',
    drives: input.drives,
    summary: {
      totalBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      freeBytes,
      safeBytes: sumBytes(groups.safe),
      cautionBytes: sumBytes(groups.caution),
      migrateBytes: sumBytes(groups.migrate),
    },
    bigItems,
    groups,
    longTerm: input.longTerm,
    migrationTarget: pickMigrationTarget(input.drives),
    partial: input.partial,
    scanStats: input.stats,
  };
}

/** 可选执行项（M1 仅用于展示；真正执行在 M2） */
export function selectableItems(plan: Plan): ClassifiedItem[] {
  return [...plan.groups.safe, ...plan.groups.caution, ...plan.groups.migrate].sort(
    (a, b) => b.sizeBytes - a.sizeBytes,
  );
}
