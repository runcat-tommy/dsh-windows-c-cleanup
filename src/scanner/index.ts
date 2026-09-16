/**
 * 扫描编排：盘信息 → （热点清单 ∥ 全盘 Top-N）→ 合并去重。
 *
 * 两个扫描**并行**执行：它们互相独立，串行会让总时长变成两者预算之和，
 * 并行后总时长约等于较大的那个预算，用户能在 1–2 分钟内拿到报告。
 */
import { normalizePath, buildRuleIndex, expandTemplate, type RuleIndex } from '../rules/match.js';
import type { RuleSet, ScanItem, DriveInfo } from '../rules/schema.js';
import { pick, type LocaleId } from '../i18n/index.js';
import { listDrives } from './drives.js';
import { scanHotspots } from './hotspots.js';
import { scanTopTree } from './topTree.js';
import type { TopTreeResult } from './topTree.js';

export interface ScanOptions {
  /** 输出语言（默认 zh：模型工具那条路不传，输出与历史逐字一致） */
  locale?: LocaleId;
  /** 热点清单时间预算（默认 70s） */
  hotspotTimeBudgetMs?: number;
  /** 热点清单同时测量的候选项数量（默认 4） */
  hotspotRuleConcurrency?: number;
  /** 全盘 Top-N 扫描配置 */
  topTree?: {
    enabled?: boolean;
    maxDepth?: number;
    topN?: number;
    timeBudgetMs?: number;
    /** 每层并发遍历的目录数（默认 3） */
    concurrency?: number;
    /** 叶子子树测量的内部并发（默认 4） */
    leafConcurrency?: number;
  };
  /** 调用方取消信号（工具的 exec.signal 会透传到这里） */
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface ScanResult {
  drives: DriveInfo[];
  items: ScanItem[];
  partial: boolean;
  stats: {
    durationMs: number;
    hotspotCount: number;
    hotspotScanned: number;
    hotspotTotal: number;
    topTreeDirs: number;
    topTreePartial: boolean;
    /**
     * 截断原因的**结构化事实**（0.5.1 补）。
     *
     * 为什么要有它：`partialReasons` 是渲染好的字符串，语言在扫描那一刻就冻结了。
     * 面板切语言后要重新出文案，就必须能重新渲染 —— 所以底层事实单独存一份，
     * 面板的 scan-view 端点据此按目标语言重新生成（见 src/panel/service.ts）。
     */
    partialFacts: PartialFact[];
    partialReasons: string[];
  };
}

/** 扫描被截断的原因（结构化） */
export type PartialFact =
  | { kind: 'hotspots-incomplete'; scanned: number; total: number }
  | { kind: 'hotspots-truncated' }
  | { kind: 'toptree-timeout' };

/** 把截断事实渲染成一句话（中英各一套；报告/工具用中文，面板按界面语言取） */
export function partialReasonText(fact: PartialFact, locale: LocaleId = 'zh'): string {
  if (fact.kind === 'hotspots-incomplete') {
    return pick(
      locale,
      `热点清单未测完（已完成 ${fact.scanned}/${fact.total} 项）`,
      `Hotspot list incomplete (finished ${fact.scanned}/${fact.total} entries)`,
    );
  }
  if (fact.kind === 'hotspots-truncated') {
    return pick(
      locale,
      '个别热点项测量被时间片截断，数值可能偏小',
      'A few hotspot entries were cut off by the time slice, so their sizes may be understated',
    );
  }
  return pick(
    locale,
    '全盘 Top-N 扫描超时，可能存在未发现的大目录',
    'The whole-drive Top-N scan timed out, so some large directories may be missing',
  );
}

const DEFAULT_LEAF_DIRS = ['%WINDIR%', '%PROGRAMFILES%', '%PROGRAMFILES(X86)%', '%PROGRAMDATA%'];

export async function scanSystem(
  rules: RuleSet,
  options: ScanOptions = {},
  index: RuleIndex = buildRuleIndex(rules.rules),
): Promise<ScanResult> {
  const started = Date.now();
  const partialReasons: string[] = [];
  const partialFacts: PartialFact[] = [];
  const locale: LocaleId = options.locale ?? 'zh';
  const log = options.onProgress ?? (() => {});

  log('读取盘符信息…');
  const drives = await listDrives();
  const systemDrive = drives.find((d) => d.isSystem) ?? drives[0];
  if (!systemDrive) throw new Error('未检测到系统盘');

  const topTreeCfg = {
    enabled: options.topTree?.enabled ?? true,
    maxDepth: options.topTree?.maxDepth ?? 3,
    topN: options.topTree?.topN ?? 30,
    timeBudgetMs: options.topTree?.timeBudgetMs ?? 70_000,
    concurrency: options.topTree?.concurrency ?? 6,
    leafConcurrency: options.topTree?.leafConcurrency ?? 12,
  };

  log(`并行扫描：热点清单（${index.entries.length} 条规则）+ ${topTreeCfg.enabled ? '全盘 Top-N' : '（跳过 Top-N）'}…`);

  const emptyTop: TopTreeResult = { items: [], partial: false, scannedDirs: 0, durationMs: 0 };
  const [hotspots, top] = await Promise.all([
    scanHotspots(index.entries, {
      timeBudgetMs: options.hotspotTimeBudgetMs ?? 70_000,
      ruleConcurrency: options.hotspotRuleConcurrency ?? 4,
      signal: options.signal,
      onProgress: (done, total, current) => {
        if (done % 10 === 0) log(`热点扫描 ${done}/${total}：${current}`);
      },
    }),
    topTreeCfg.enabled
      ? scanTopTree(systemDrive.root, {
          maxDepth: topTreeCfg.maxDepth,
          topN: topTreeCfg.topN,
          timeBudgetMs: topTreeCfg.timeBudgetMs,
          concurrency: topTreeCfg.concurrency,
          leafConcurrency: topTreeCfg.leafConcurrency,
          signal: options.signal,
          leafDirs: DEFAULT_LEAF_DIRS.map((t) => expandTemplate(t)).filter((p) => !p.includes('%')),
          onProgress: (dirs, current) => {
            if (dirs % 400 === 0) log(`Top-N 扫描 ${dirs} 个目录：${current}`);
          },
        })
      : Promise.resolve(emptyTop),
  ]);

  if (hotspots.partial && hotspots.scanned < hotspots.total) {
    partialFacts.push({ kind: 'hotspots-incomplete', scanned: hotspots.scanned, total: hotspots.total });
  } else if (hotspots.partial) {
    partialFacts.push({ kind: 'hotspots-truncated' });
  }
  if (top.partial) partialFacts.push({ kind: 'toptree-timeout' });
  for (const fact of partialFacts) partialReasons.push(partialReasonText(fact, locale));

  const items: ScanItem[] = [...hotspots.items];
  for (const node of top.items) {
    if (node.sizeBytes <= 0) continue;
    items.push({
      path: node.path.replace(/\\+$/, ''),
      kind: 'dir',
      sizeBytes: node.sizeBytes,
      fileCount: node.fileCount,
      source: 'toptree',
    });
  }

  // 合并去重：同一路径保留更大的测量值，热点来源优先（更贴合规则语义）
  const dedup = new Map<string, ScanItem>();
  for (const item of items) {
    const key = normalizePath(item.path);
    const existing = dedup.get(key);
    if (!existing) {
      dedup.set(key, item);
      continue;
    }
    if (item.sizeBytes > existing.sizeBytes) {
      dedup.set(key, { ...item, source: existing.source === 'hotspot' ? 'hotspot' : item.source });
    }
  }

  return {
    drives,
    items: [...dedup.values()].sort((a, b) => b.sizeBytes - a.sizeBytes),
    partial: partialReasons.length > 0,
    stats: {
      durationMs: Date.now() - started,
      hotspotCount: hotspots.items.length,
      hotspotScanned: hotspots.scanned,
      hotspotTotal: hotspots.total,
      topTreeDirs: top.scannedDirs,
      topTreePartial: top.partial,
      partialFacts,
      partialReasons,
    },
  };
}
