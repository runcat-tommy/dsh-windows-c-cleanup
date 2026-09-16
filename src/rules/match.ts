/**
 * 路径模板展开与规则匹配。
 *
 * 匹配语义：
 *  - 无通配的 dir 规则：候选路径等于规则路径，或位于其下（descendant）即命中。
 *  - 无通配的 file 规则：候选路径必须等于规则路径（不匹配其子项）。
 *  - 含 * 的规则：* 匹配「单个路径段」（不含反斜杠）。
 *
 * 优先级（用于同名重叠）：
 *   1) 更具体的路径（字面前缀更长）胜出；
 *   2) 同长度时 protected 胜出；
 *   3) 再相同则按规则库中的先后顺序（先者胜）。
 */
import type { Grade, Rule } from './schema.js';

/** 模板占位符 → 环境变量名（大小写不敏感） */
const ENV_ALIAS: Record<string, string> = {
  LOCALAPPDATA: 'LOCALAPPDATA',
  APPDATA: 'APPDATA',
  USERPROFILE: 'USERPROFILE',
  TEMP: 'TEMP',
  TMP: 'TMP',
  WINDIR: 'WINDIR',
  SYSTEMROOT: 'SystemRoot',
  SYSTEMDRIVE: 'SystemDrive',
  PROGRAMDATA: 'ProgramData',
  PROGRAMFILES: 'ProgramFiles',
  'PROGRAMFILES(X86)': 'ProgramFiles(x86)',
  PROGRAMFILESX86: 'ProgramFiles(x86)',
  COMPUTERNAME: 'COMPUTERNAME',
  USERNAME: 'USERNAME',
};

/** 展开 %VAR% 占位符；未识别的占位符原样保留（便于报告里提示） */
export function expandTemplate(template: string, env: NodeJS.ProcessEnv = process.env): string {
  return template.replace(/%([A-Za-z0-9_()]+)%/g, (whole, name: string) => {
    const key = ENV_ALIAS[name.toUpperCase()] ?? name;
    const value = env[key] ?? env[key.toUpperCase()];
    return value === undefined || value === '' ? whole : value;
  });
}

/** 规范化用于比较：统一分隔符、去掉末尾反斜杠、转小写（Windows 大小写不敏感） */
export function normalizePath(p: string): string {
  const unified = p.replace(/\//g, '\\').replace(/\\+$/g, '');
  return unified.toLowerCase();
}

export function hasGlob(path: string): boolean {
  return path.includes('*');
}

/** 字面前缀长度（首个 * 之前的部分），用作「具体程度」度量 */
function literalPrefixLength(path: string): number {
  const star = path.indexOf('*');
  return star === -1 ? path.length : star;
}

/** glob → 正则：* 只匹配单段（不含反斜杠） */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*/g, '[^\\\\]*');
  return new RegExp(`^${body}$`, 'i');
}

export interface MatchResult {
  matched: boolean;
  /** 命中具体程度：越大越具体 */
  specificity: number;
}

/** 判断候选路径是否命中规则 */
export function matchRule(candidatePath: string, rule: Rule, expandedRulePath: string): MatchResult {
  const c = normalizePath(candidatePath);
  const r = normalizePath(expandedRulePath);
  const isFile = rule.kind === 'file';

  if (hasGlob(r)) {
    const re = globToRegExp(r);
    if (re.test(c)) return { matched: true, specificity: literalPrefixLength(r) };
    // 目录型 glob 规则也覆盖其子项
    if (!isFile && re.test(c) === false) {
      const dirPart = r.slice(0, r.lastIndexOf('\\'));
      if (hasGlob(dirPart)) return { matched: false, specificity: 0 };
    }
    if (!isFile && c.startsWith(r + '\\')) {
      return { matched: true, specificity: literalPrefixLength(r) };
    }
    return { matched: false, specificity: 0 };
  }

  if (c === r) return { matched: true, specificity: r.length };
  if (!isFile && c.startsWith(r + '\\')) return { matched: true, specificity: r.length };
  return { matched: false, specificity: 0 };
}

export interface RuleIndex {
  entries: Array<{ rule: Rule; expanded: string; order: number }>;
}

export function buildRuleIndex(rules: Rule[], env: NodeJS.ProcessEnv = process.env): RuleIndex {
  return {
    entries: rules.map((rule, order) => ({ rule, expanded: expandTemplate(rule.path, env), order })),
  };
}

const GRADE_PRIORITY: Record<Grade, number> = {
  protected: 5,
  caution: 4,
  migrate: 3,
  safe: 2,
  longterm: 1,
};

export interface Winner {
  rule: Rule;
  expanded: string;
  specificity: number;
}

/** 在所有规则中挑选最具体的一条（同长度时 protected 优先，再按规则库顺序） */
export function pickWinner(candidatePath: string, index: RuleIndex): Winner | undefined {
  let best: (Winner & { priority: number; order: number }) | undefined;
  for (const entry of index.entries) {
    const { matched, specificity } = matchRule(candidatePath, entry.rule, entry.expanded);
    if (!matched) continue;
    const priority = GRADE_PRIORITY[entry.rule.grade] ?? 0;
    if (
      best === undefined ||
      specificity > best.specificity ||
      (specificity === best.specificity && priority > best.priority) ||
      (specificity === best.specificity && priority === best.priority && entry.order < best.order)
    ) {
      best = { rule: entry.rule, expanded: entry.expanded, specificity, priority, order: entry.order };
    }
  }
  if (!best) return undefined;
  return { rule: best.rule, expanded: best.expanded, specificity: best.specificity };
}

/** 把含通配的模板展开为具体路径列表（只展开 * 所在层，深度有限） */
export async function expandGlob(
  template: string,
  fs: {
    readdir: (p: string) => Promise<string[]>;
    exists: (p: string) => Promise<boolean>;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const expanded = expandTemplate(template, env);
  if (!hasGlob(expanded)) return (await fs.exists(expanded)) ? [expanded] : [];

  const segments = expanded.split('\\');
  let prefixes: string[] = [segments[0] + '\\'];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const next: string[] = [];
    for (const prefix of prefixes) {
      if (seg.includes('*')) {
        const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
        let names: string[] = [];
        try {
          names = await fs.readdir(prefix);
        } catch {
          names = [];
        }
        for (const name of names) {
          if (re.test(name)) next.push(prefix + name + '\\');
        }
      } else {
        const candidate = prefix + seg + (i === segments.length - 1 ? '' : '\\');
        if (i === segments.length - 1) {
          if (await fs.exists(candidate)) next.push(candidate);
        } else {
          next.push(candidate);
        }
      }
    }
    prefixes = next;
    if (prefixes.length === 0) break;
  }
  return prefixes.map((p) => p.replace(/\\+$/, ''));
}
