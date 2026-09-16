/**
 * 面板与宿主之间的通道（客户端侧）。
 *
 * 走 Connection 的通用逻辑 RPC：`connection.rpc.call(channel, endpoint, payload)`，
 * 返回 `{ok:true,value}` / `{ok:false,error}`。业务失败在这里统一转成异常，
 * 由面板捕获后显示原文（宿主侧已把错误信息写成可读中文）。
 */

export const PANEL_CHANNEL = '/dsh-c-cleanup';

interface RpcResultLike {
  ok: boolean;
  value?: unknown;
  error?: { code?: string; message?: string };
}

export interface ConnectionLike {
  rpc?: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResultLike>;
  };
}

export interface PanelGroupItem {
  path: string;
  ruleId: string;
  sizeBytes: number;
  grade: string;
  reason: string;
  migratable: boolean;
}

export interface PanelGroup {
  count: number;
  bytes: number;
  truncated: boolean;
  items: PanelGroupItem[];
}

export interface TrendItemView {
  path: string;
  sizeBytes: number;
  deltaBytes: number;
}

export interface TrendView {
  previousAt: string;
  hoursAgo: number;
  freeDeltaBytes: number;
  usedDeltaBytes: number;
  grown: TrendItemView[];
  shrunk: TrendItemView[];
}

export interface PanelStateView {
  systemDrive: string;
  drives: Array<{ letter: string; totalBytes: number; freeBytes: number; isSystem: boolean }>;
  defaultScope: 'hotspots' | 'full';
  historyPath: string;
  reportDir: string;
  /** 结构化调度状态：面板自己组织成双语文案，不依赖宿主的中文描述 */
  scheduler: { enabled: boolean; running: boolean; intervalHours: number; alertFreePercent: number };
  lastScan?: {
    planId: string;
    at: string;
    scope: string;
    freeBytes: number;
    totalBytes: number;
    safeBytes: number;
    cautionBytes: number;
    migrateBytes: number;
    protectedCount: number;
    selectableCount: number;
    partial: boolean;
    itemCount: number;
  };
  migrationTarget?: { letter: string; root: string; freeBytes: number };
  runningJobs: number;
  trend?: TrendView;
}

export interface ScanView {
  planId: string;
  at: string;
  scope: string;
  systemDrive: string;
  freeBytes: number;
  totalBytes: number;
  groups: { safe: PanelGroup; caution: PanelGroup; migrate: PanelGroup; protected: PanelGroup };
  longTerm: Array<{ id: string; title: string; detail: string; detect: string; benefit: string }>;
  bigItems: Array<{ path: string; sizeBytes: number; grade: string }>;
  partial: boolean;
  partialReasons: string[];
  historyPath: string;
  trend?: TrendView;
}

export interface PreviewView {
  plannedBytes: number;
  items: Array<{ path: string; sizeBytes: number; action: string; reason: string; kind: string }>;
  refused: Array<{ path: string; reason: string }>;
  elevationCount: number;
  trashPath?: string;
  migrationTarget?: string;
  warnings: string[];
}

export interface MigratePreviewView {
  items: Array<{ source: string; destination: string; sizeBytes: number; fileCount: number; hasRoom: boolean; unknown: boolean }>;
  totalBytes: number;
  targetRoot: string;
  targetFreeBytes: number;
  targetKnown: boolean;
  needsConfigChange: string[];
  warnings: string[];
}

export interface JobItemView {
  path: string;
  sizeBytes: number;
  action: string;
  reason: string;
  movedTo?: string;
}

export interface JobView {
  jobId: string;
  kind: string;
  status: 'running' | 'done' | 'failed' | 'canceled';
  startedAt: string;
  finishedAt?: string;
  dryRun: boolean;
  total: number;
  done: number;
  message?: string;
  plannedBytes: number;
  freedBytes: number;
  measuredFreedBytes: number;
  items: JobItemView[];
  reportPath?: string;
  error?: string;
}

export class PanelApi {
  constructor(
    private readonly getConnection: () => ConnectionLike | undefined,
    /** 当前界面语言：随每次调用发给宿主，让宿主返回对应语言的文案（规则说明/拒绝理由/告警等） */
    private readonly getLocale: () => string = () => 'zh',
  ) {}

  private async call<T>(endpoint: string, payload: Record<string, unknown> = {}): Promise<T> {
    const connection = this.getConnection();
    const rpc = connection?.rpc;
    if (rpc === undefined) {
      throw new Error('当前宿主没有 Connection 服务：面板无法与宿主通信（模型工具仍可用）');
    }
    const result = await rpc.call(PANEL_CHANNEL, endpoint, { locale: this.getLocale(), ...payload });
    if (result.ok !== true) throw new Error(result.error?.message ?? `调用 ${endpoint} 失败`);
    return result.value as T;
  }

  state(): Promise<PanelStateView> {
    return this.call<PanelStateView>('state');
  }

  scan(scope: 'hotspots' | 'full'): Promise<ScanView> {
    return this.call<ScanView>('scan', { scope });
  }

  /**
   * 用宿主**缓存里那次扫描**重新出视图（切界面语言后调用）。
   * 不扫盘、不测量：宿主只把已经分类好的结果按目标语言重新渲染一遍，毫秒级返回。
   */
  scanView(): Promise<{ available: boolean; view?: ScanView }> {
    return this.call<{ available: boolean; view?: ScanView }>('scan-view');
  }

  preview(paths: string[], mode: 'trash' | 'permanent'): Promise<PreviewView> {
    return this.call<PreviewView>('preview', { paths, mode });
  }

  migratePreview(paths: string[], targetDrive?: string): Promise<MigratePreviewView> {
    return this.call<MigratePreviewView>('migrate-preview', { paths, ...(targetDrive === undefined ? {} : { targetDrive }) });
  }

  execute(paths: string[], mode: 'trash' | 'permanent', dryRun: boolean): Promise<{ jobId: string }> {
    return this.call<{ jobId: string }>('execute', { paths, mode, dryRun });
  }

  migrate(paths: string[], dryRun: boolean, targetDrive?: string): Promise<{ jobId: string }> {
    return this.call<{ jobId: string }>('migrate', { paths, dryRun, ...(targetDrive === undefined ? {} : { targetDrive }) });
  }

  rollback(paths: string[], dryRun: boolean): Promise<{ jobId: string }> {
    return this.call<{ jobId: string }>('rollback', { paths, dryRun });
  }

  progress(jobId: string): Promise<{ found: boolean; job?: JobView }> {
    return this.call<{ found: boolean; job?: JobView }>('progress', { jobId });
  }

  cancel(jobId: string): Promise<{ canceled: boolean; reason?: string }> {
    return this.call<{ canceled: boolean; reason?: string }>('cancel', { jobId });
  }
}
