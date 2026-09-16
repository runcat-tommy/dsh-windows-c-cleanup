/**
 * 无头验证：不启动 DSH，直接调用真实工具定义走完整流程。
 * 运行：npx tsx tests/tool-run.ts [hotspots|full]
 *
 * 验证点：参数校验 → 规则加载 → 扫描 → 五级分级 → 报告落盘 → output 渲染。
 */
import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { Config } from '../src/config.js';
import type { Config as ConfigType } from '../src/config.js';
import { registerDiskCleanupTool } from '../src/tools/disk-cleanup.js';

const scope = (process.argv[2] as 'hotspots' | 'full' | undefined) ?? 'full';
const reportDir = path.resolve(process.cwd(), '..');

// 1) 用假 ctx 捕获工具定义（真实插件路径，只是不接宿主）
const captured: ToolDefinition[] = [];
const fakeCtx = {
  tools: {
    register(definition: ToolDefinition) {
      captured.push(definition);
      return () => {};
    },
  },
} as unknown as Context;

const config: ConfigType = Config({ reportDir }) as ConfigType;
console.log(`配置解析（schema 默认值）：scope=${config.defaultScope} 热点预算=${config.hotspotTimeBudgetMs}ms TopN 预算=${config.topTreeTimeBudgetMs}ms`);
console.log(`附加规则文件=${config.extraRulesFile ?? '（无）'} 允许覆盖保护名单=${config.allowProtectedOverride}`);

registerDiskCleanupTool(fakeCtx, config);
const tool = captured[0];
if (!tool) throw new Error('工具未注册');

// 2) 宿主侧会做的校验：参数名与 output schema 是否被接受
console.log(`已注册工具：${tool.name}（参数键：${Object.keys(tool.parameters).join(', ')}）`);

const fakeExec = {
  callId: 'test-call',
  name: tool.name,
  arguments: { action: 'scan', scope },
  signal: new AbortController().signal,
  token: 0,
  rootCallId: 'test-call',
} as unknown as ToolRunContext;

// 3) 真跑
const t0 = Date.now();
const value = (await tool.execute({ action: 'scan', scope }, fakeExec)) as Record<string, unknown>;
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// 4) render 必须是纯函数，单独调用一次确认可渲染
const rendered = tool.output?.render({ action: 'scan', scope }, value as never) ?? [];
const text = rendered.map((block) => (block.type === 'text' ? block.text : `<${block.type}>`)).join('\n');

console.log('\n===== output.render() 渲染结果 =====');
console.log(text);
console.log(`\n===== 工具返回值（关键字段）=====`);
for (const key of ['action', 'status', 'planId', 'reportPath', 'partial', 'safeBytes', 'cautionBytes', 'migrateBytes', 'safeCount', 'cautionCount', 'migrateCount', 'protectedCount', 'longTermCount', 'migrationTarget', 'durationMs']) {
  console.log(`  ${key}: ${JSON.stringify(value[key])}`);
}
const big = (value.bigItems as Array<{ path: string; sizeBytes: number; grade: string }>) ?? [];
const first = big[0];
console.log(`  bigItems: ${big.length} 项，最大一项 = ${first ? `${first.path} (${first.grade})` : '无'}`);
console.log(`\n端到端耗时 ${elapsed} 秒`);
