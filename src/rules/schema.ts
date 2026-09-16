/**
 * 规则库类型定义。
 *
 * 五级分级：
 *  - safe      可安全删除（缓存/临时/升级包，无数据损失）
 *  - caution   谨慎删除（可重建但代价高，或需管理员权限）
 *  - migrate   建议迁移（junction 或应用配置改路径搬到其他盘）
 *  - protected 保护名单（硬约束，任何情况下不自动删除）
 *  - longterm  长期防护（配置类动作，见 LongTermAction）
 */
export type Grade = 'safe' | 'caution' | 'migrate' | 'protected' | 'longterm';

export const GRADES: readonly Grade[] = ['safe', 'caution', 'migrate', 'protected', 'longterm'];

export const GRADE_LABEL: Record<Grade, string> = {
  safe: '🟢 可安全删除',
  caution: '🟡 谨慎删除',
  migrate: '🟠 建议迁移',
  protected: '🔴 保护名单',
  longterm: '🔵 长期防护',
};

export interface MigrateSpec {
  /** app-config：改应用配置/环境变量；junction：跨盘移动后建目录联接 */
  method: 'app-config' | 'junction';
  /** 目标路径提示，例如 "<其他盘>:\\npm-cache" */
  targetHint?: string;
  /** 具体操作提示，例如 'npm config set cache "<目标路径>"' */
  configHint?: string;
  /** 迁移前必须关闭的进程，例如 ['chrome.exe'] */
  requiresAppClosed?: string[];
}

export interface Rule {
  id: string;
  /** 路径模板：支持 %LOCALAPPDATA% 等占位符与单段通配 * */
  path: string;
  /** 默认 dir；file 表示规则指向文件而非目录 */
  kind?: 'dir' | 'file';
  grade: Grade;
  /** 面向用户的判定理由（必须可直接展示） */
  reason: string;
  /** false 表示硬约束，用户自定义规则不得覆盖 */
  overridable?: boolean;
  /** 特殊处理标记：recycle-bin（用 Clear-RecycleBin）、dism（需 DISM 清理）等 */
  special?: string;
  migrate?: MigrateSpec | null;
}

export interface LongTermAction {
  id: string;
  title: string;
  /** 检测条件的自然语言描述（M2 起补充可执行检测） */
  detect: string;
  action: string;
  benefit: string;
}

export interface RuleSet {
  version: string;
  description?: string;
  notes?: string[];
  rules: Rule[];
  longTermActions: LongTermAction[];
}

/** 扫描得到的一个候选项 */
export interface ScanItem {
  path: string;
  kind: 'dir' | 'file';
  sizeBytes: number;
  fileCount: number;
  /** 来源：hotspot=规则热点清单；toptree=全盘 Top-N */
  source: 'hotspot' | 'toptree';
}

/** 分级后的候选项 */
export interface ClassifiedItem extends ScanItem {
  grade: Grade;
  ruleId: string;
  reason: string;
  overridable: boolean;
  migrate?: MigrateSpec | null;
  special?: string;
}

export interface DriveInfo {
  letter: string;
  root: string;
  totalBytes: number;
  freeBytes: number;
  isSystem: boolean;
}

export interface Plan {
  id: string;
  createdAt: string;
  computer: string;
  drives: DriveInfo[];
  summary: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    safeBytes: number;
    cautionBytes: number;
    migrateBytes: number;
  };
  /** 大头：按大小降序的 Top-N（含各自分级） */
  bigItems: ClassifiedItem[];
  groups: {
    safe: ClassifiedItem[];
    caution: ClassifiedItem[];
    migrate: ClassifiedItem[];
    protected: ClassifiedItem[];
  };
  longTerm: LongTermAction[];
  /** 迁移目标盘建议（空闲最大且非系统盘） */
  migrationTarget?: DriveInfo;
  /** 扫描是否因时间预算被截断 */
  partial: boolean;
  scanStats: {
    durationMs: number;
    hotspotCount: number;
    /** 完成测量的热点候选项数 / 总数（覆盖率） */
    hotspotScanned: number;
    hotspotTotal: number;
    topTreeDirs: number;
    topTreePartial: boolean;
    partialReasons: string[];
  };
}
