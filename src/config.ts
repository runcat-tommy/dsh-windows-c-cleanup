/**
 * 插件配置 schema（Schemastery，由宿主在加载时校验并填默认值）。
 */
import Schema from '@deepseek-ai/schemastery';

export interface Config {
  /** 报告输出目录；缺省为 DSH 会话工作目录 */
  reportDir?: string;
  /** 默认扫描范围：hotspots=仅规则热点清单；full=热点 + 全盘 Top-N */
  defaultScope: 'hotspots' | 'full';
  /** 热点清单扫描时间预算（毫秒） */
  hotspotTimeBudgetMs: number;
  /** 全盘 Top-N 扫描时间预算（毫秒） */
  topTreeTimeBudgetMs: number;
  /** Top-N 遍历的最大深度 */
  topTreeMaxDepth: number;
  /** 「大头」判定阈值（字节），默认 2 GiB */
  bigItemThresholdBytes: number;
  /** 是否允许用户附加规则覆盖保护名单（默认否：保护名单是硬约束） */
  allowProtectedOverride: boolean;
  /** 是否允许清理「未收录规则库」的显式路径（默认否：不明即不删） */
  allowExplicitUnmatched: boolean;
  /** 默认删除模式：trash=移到其他盘暂存区（可恢复）；permanent=直接删除 */
  defaultDeleteMode: 'permanent' | 'trash';
  /** 暂存区路径；缺省为 <空闲最大的非系统盘>:\to_delete */
  trashPath?: string;
  /** 迁移根目录；缺省为 <空闲最大的非系统盘>:\dsh-cc-migrated（台账 ledger.jsonl 就放在这里） */
  migrationRoot?: string;
  /** 扫描历史文件路径；缺省 <DSH_HOME>/windows-c-cleanup/history.jsonl（用于趋势对比） */
  historyPath?: string;
  /** 默认报告格式：markdown=可视化报告；json=机器可读；both=两份都出 */
  defaultReportFormat: 'markdown' | 'json' | 'both';
  /** 定时扫描与告警（默认关闭：不主动占用用户 I/O） */
  schedule: {
    enabled: boolean;
    /** 间隔小时数 */
    intervalHours: number;
    /** 剩余空间占比低于该值（百分比）时写告警 */
    alertFreePercent: number;
    /** 首次执行延迟（分钟），避免与宿主启动抢 I/O */
    initialDelayMinutes: number;
    /** 定时扫描范围：hotspots 更快、更省 I/O */
    scope: 'hotspots' | 'full';
  };
  /** 用户附加规则文件（JSON，结构同内置规则库） */
  extraRulesFile?: string;
}

export const Config: Schema<Config> = Schema.object({
  reportDir: Schema.string().description('报告输出目录，缺省为当前工作目录'),
  defaultScope: Schema.union([Schema.const('hotspots'), Schema.const('full')])
    .default('full')
    .description('默认扫描范围：hotspots 仅规则热点；full 热点 + 全盘 Top-N'),
  hotspotTimeBudgetMs: Schema.natural()
    .default(70_000)
    .description('热点清单扫描时间预算（毫秒）'),
  topTreeTimeBudgetMs: Schema.natural()
    .default(70_000)
    .description('全盘 Top-N 扫描时间预算（毫秒）'),
  topTreeMaxDepth: Schema.natural().default(3).description('Top-N 遍历最大深度'),
  bigItemThresholdBytes: Schema.natural()
    .default(2 * 1024 ** 3)
    .description('「大头」判定阈值（字节）'),
  allowProtectedOverride: Schema.boolean()
    .default(false)
    .description('是否允许用户规则覆盖保护名单（默认否）'),
  allowExplicitUnmatched: Schema.boolean()
    .default(false)
    .description('是否允许清理未收录规则库的显式路径（默认否：不明即不删）'),
  defaultDeleteMode: Schema.union([Schema.const('permanent'), Schema.const('trash')])
    .default('trash')
    .description('默认删除模式：trash=移到其他盘暂存区（可恢复）；permanent=直接删除'),
  trashPath: Schema.string().description('暂存区路径，缺省为 <空闲最大的非系统盘>:\\to_delete'),
  migrationRoot: Schema.string().description(
    '迁移根目录，缺省为 <空闲最大的非系统盘>:\\dsh-cc-migrated；迁移台账 ledger.jsonl 存放于此',
  ),
  historyPath: Schema.string().description(
    '扫描历史文件路径，缺省 <DSH_HOME>/windows-c-cleanup/history.jsonl；每次扫描追加一条，用于趋势对比',
  ),
  defaultReportFormat: Schema.union([Schema.const('markdown'), Schema.const('json'), Schema.const('both')])
    .default('markdown')
    .description('默认报告格式：markdown / json / both（both 同时产出可视化报告与机器可读 JSON）'),
  schedule: Schema.object({
    enabled: Schema.boolean().default(false).description('是否启用定时扫描（默认关闭，不主动占用用户 I/O）'),
    intervalHours: Schema.natural().default(24).description('扫描间隔（小时）'),
    alertFreePercent: Schema.natural().default(10).description('剩余空间占比低于该百分比时写告警（1–99）'),
    initialDelayMinutes: Schema.natural().default(1).description('首次执行延迟（分钟），避免与宿主启动抢 I/O'),
    scope: Schema.union([Schema.const('hotspots'), Schema.const('full')])
      .default('hotspots')
      .description('定时扫描范围：hotspots 更快更省 I/O；full 更全但更慢'),
  }).description('定时扫描与告警'),
  extraRulesFile: Schema.string().description('用户附加规则文件路径'),
});
