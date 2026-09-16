/**
 * 规则库加载：内置规则 + 用户附加规则（可覆盖判定，保护名单为硬约束）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePath } from './match.js';
import type { Rule, RuleSet } from './schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 内置规则文件位置。
 *
 * 注意：`tsc` 不会把 JSON 复制到 `lib/`，所以编译后必须回到包根的 `src/rules/`；
 * 而源码直跑（tsx）时文件就在同目录。这里逐个探测**真实存在**的候选路径，
 * 不能想当然取第一个（否则宿主加载编译产物时会 ENOENT）。
 */
async function defaultRulesPath(): Promise<string> {
  const candidates = [
    path.join(here, 'default-rules.json'), // 源码直跑：src/rules/
    path.join(here, '..', '..', 'src', 'rules', 'default-rules.json'), // 编译后：lib/rules/ → 包根/src/rules/
    path.join(here, '..', '..', 'rules', 'default-rules.json'), // 若将来把 JSON 复制进 lib/rules/
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(`未找到内置规则库文件，已尝试：\n  ${candidates.join('\n  ')}`);
}

export async function loadDefaultRules(): Promise<RuleSet> {
  const file = await defaultRulesPath();
  const raw = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(raw) as RuleSet;
  if (!Array.isArray(parsed.rules)) throw new Error(`规则库格式错误：${file}`);
  return parsed;
}

export interface LoadRulesOptions {
  /** 用户附加规则文件（JSON，结构同内置：{ rules: [...], longTermActions?: [...] }） */
  extraRulesFile?: string;
  /** 是否允许覆盖保护名单（默认 false） */
  allowProtectedOverride?: boolean;
}

export interface LoadRulesResult {
  ruleSet: RuleSet;
  /** 因硬约束被拒绝的覆盖尝试 */
  rejected: Array<{ ruleId: string; conflictWith: string }>;
  warnings: string[];
}

export async function loadRules(options: LoadRulesOptions = {}): Promise<LoadRulesResult> {
  const ruleSet = await loadDefaultRules();
  const rejected: LoadRulesResult['rejected'] = [];
  const warnings: string[] = [];

  if (!options.extraRulesFile) return { ruleSet, rejected, warnings };

  const raw = await fs.readFile(options.extraRulesFile, 'utf8');
  const extra = JSON.parse(raw) as Partial<RuleSet>;

  const locked = new Map<string, Rule>();
  for (const rule of ruleSet.rules) {
    if (rule.grade === 'protected' && rule.overridable === false) {
      locked.set(normalizePath(rule.path), rule);
    }
  }

  const accepted: Rule[] = [];
  for (const rule of extra.rules ?? []) {
    const conflict = locked.get(normalizePath(rule.path));
    if (conflict && options.allowProtectedOverride !== true) {
      rejected.push({ ruleId: rule.id, conflictWith: conflict.id });
      warnings.push(`用户规则 ${rule.id} 试图覆盖硬约束保护项 ${conflict.id}，已忽略`);
      continue;
    }
    accepted.push(rule);
  }

  return {
    ruleSet: {
      ...ruleSet,
      rules: [...ruleSet.rules, ...accepted],
      longTermActions: [...ruleSet.longTermActions, ...(extra.longTermActions ?? [])],
    },
    rejected,
    warnings,
  };
}
