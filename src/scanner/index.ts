/**
 * 扫描编排：盘信息 → （热点清单 ∥ 全盘 Top-N）→ 合并去重。
 *
 * 两个扫描**并行**执行：它们互相独立，串行会让总时长变成两者预算之和，
 * 并行后总时长约等于较大的那个预算，用户能在 1–2 分钟内拿到报告。
 */
import { normalizePath, buildRuleIndex, expandTemplate, type RuleIndex } from '../rules/match.js';
import type { RuleSet, ScanItem, DriveInfo } from '../rules/schema.js';
import { listDrives } from './drives.js';
import { scanHotspots } from './hotspots.js';
import { scanTopTree } from './topTree.js';
import type { TopTreeResult } from './topTree.js';

export interface ScanOptions {
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
    partialReasons: string[];
  };
}

const DEFAULT_LEAF_DIRS = ['%WINDIR%', '%PROGRAMFILES%', '%PROGRAMFILES(X86)%', '%PROGRAMDATA%'];

export async function scanSystem(
  rules: RuleSet,
  options: ScanOptions = {},
  index: RuleIndex = buildRuleIndex(rules.rules),
): Promise<ScanResult> {
  const started = Date.now();
  const partialReasons: string[] = [];
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
    partialReasons.push(`热点清单未测完（已完成 ${hotspots.scanned}/${hotspots.total} 项）`);
  } else if (hotspots.partial) {
    partialReasons.push('个别热点项测量被时间片截断，数值可能偏小');
  }
  if (top.partial) partialReasons.push('全盘 Top-N 扫描超时，可能存在未发现的大目录');

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
      partialReasons,
    },
  };
}
