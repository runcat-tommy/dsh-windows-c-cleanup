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
  extraRulesFile: Schema.string().description('用户附加规则文件路径'),
});
