/**
 * 宿主侧文案的语言选择。
 *
 * 为什么要这一层：面板（浏览器）是中英双语的，但它每行显示的"理由"是**宿主生成的**——
 * 规则库说明、安全闸拒绝理由、执行器计划动作、调度状态。所以宿主必须能按请求语言吐文案。
 *
 * 取语言的规则很保守：**默认中文**。模型工具（`disk_cleanup`）不传 locale 就永远是中文，
 * 行为与历史完全一致；只有面板会显式传 `locale: 'en'`。
 *
 * 规则库说明的中英对照放在独立文件 `src/rules/default-rules.en.json`（按 rule id 对齐），
 * 有测试守着「101 条规则 + 6 条长期防护必须全覆盖、且 id 严格对齐」。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type LocaleId = 'zh' | 'en';

/** 归一化语言输入：只认平台登记过的 zh / en，其余一律中文 */
export function normalizeLocale(input: unknown): LocaleId {
  return input === 'en' ? 'en' : 'zh';
}

/** 按语言二选一：宿主内部零散文案用这个，字符串就写在调用点旁边，不搞远端目录 */
export function pick(locale: LocaleId, zh: string, en: string): string {
  return locale === 'en' ? en : zh;
}

interface RulesEnglishFile {
  version: string;
  description?: string;
  notes?: string[];
  reasons: Record<string, string>;
  longTerm: Record<string, { title: string; detect: string; action: string; benefit: string }>;
  configHints?: Record<string, string>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** 英文文案文件位置（沿用规则库那套"逐个探测真实存在的候选路径"的做法） */
function englishRulesPath(): string | undefined {
  const candidates = [
    path.join(here, '..', 'rules', 'default-rules.en.json'), // 源码直跑：src/i18n/ → src/rules/
    path.join(here, '..', '..', 'src', 'rules', 'default-rules.en.json'), // 编译后：lib/i18n/ → 包根/src/rules/
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      /* 试下一个 */
    }
  }
  return undefined;
}

let cached: RulesEnglishFile | undefined;
let loadFailed = false;

/** 惰性加载英文规则文案；文件缺失/损坏时返回 undefined，调用方回退中文（绝不因此报错） */
export function englishRules(): RulesEnglishFile | undefined {
  if (cached !== undefined || loadFailed) return cached;
  const file = englishRulesPath();
  if (file === undefined) {
    loadFailed = true;
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RulesEnglishFile;
    cached = parsed;
    return cached;
  } catch {
    loadFailed = true;
    return undefined;
  }
}

/** 规则说明按语言取；英文缺失就回退中文原文（宁可中文，也不显示空洞） */
export function ruleReason(ruleId: string | undefined, zhReason: string, locale: LocaleId): string {
  if (locale !== 'en' || ruleId === undefined) return zhReason;
  return englishRules()?.reasons[ruleId] ?? zhReason;
}

/** 长期防护措施按语言取；缺项逐字段回退中文 */
export function longTermText(
  action: { id: string; title: string; detail?: string; detect?: string; action?: string; benefit?: string },
  locale: LocaleId,
): { title: string; detail: string; detect: string; benefit: string } {
  const detailZh = action.detail ?? action.action ?? '';
  if (locale !== 'en') {
    return { title: action.title, detail: detailZh, detect: action.detect ?? '', benefit: action.benefit ?? '' };
  }
  const english = englishRules()?.longTerm?.[action.id];
  return {
    title: english?.title ?? action.title,
    detail: english?.action ?? detailZh,
    detect: english?.detect ?? action.detect ?? '',
    benefit: english?.benefit ?? action.benefit ?? '',
  };
}

/** 迁移后的应用配置提示（来自规则的 migrate.configHint）按语言取；缺项回退中文 */
export function ruleConfigHint(ruleId: string | undefined, zhHint: string, locale: LocaleId): string {
  if (locale !== 'en' || ruleId === undefined) return zhHint;
  return englishRules()?.configHints?.[ruleId] ?? zhHint;
}

/** 供测试与诊断：英文规则文案的覆盖情况 */
export function englishRuleCoverage(ruleIds: string[], longTermIds: string[]): {
  rules: { total: number; missing: string[] };
  longTerm: { total: number; missing: string[] };
  available: boolean;
} {
  const file = englishRules();
  if (file === undefined) {
    return { rules: { total: ruleIds.length, missing: ruleIds }, longTerm: { total: longTermIds.length, missing: longTermIds }, available: false };
  }
  return {
    rules: { total: ruleIds.length, missing: ruleIds.filter((id) => typeof file.reasons[id] !== 'string') },
    longTerm: { total: longTermIds.length, missing: longTermIds.filter((id) => file.longTerm[id] === undefined) },
    available: true,
  };
}
