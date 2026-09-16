# M5 设计：清理面板（Client GUI）

> 状态：设计中（宿主侧契约已定，客户端注册机制以平台契约实测为准）
> 前置：M1–M4 已完成（扫描 / 分级 / 迁移 / 历史趋势 / JSON 报告）

## 1. 目标与边界

**目标**：把已经跑通的清理能力搬进 Web GUI，让用户不必读报告就能完成「看懂 → 勾选 → 预演 → 执行」。
**四块内容**（对应设计方案里的 M5）：

| 区块 | 内容 | 数据来源 |
| --- | --- | --- |
| 五级分区卡片 | 🟢安全 / 🟡谨慎 / 🔴保护 / 🟠可迁移 / 🔵长期防护 五张卡：项数、合计大小、展开逐项 | 复用 M1/M2 的 `classify` 结果 |
| 勾选执行 | 逐项 / 按层批量勾选；保护层**不可勾选** | 复用 M2 的 `guardTargets` 安全闸 |
| 进度 | 执行中逐项状态、累计释放量、可取消 | 宿主侧 job 表 + 轮询 |
| 迁移预览 | 源 → 目标路径映射、目标盘剩余空间、是否需要建联接 | 复用 M3 的测量与 `hasRoomFor` |

**非目标**：不在面板里改规则/配置（配置仍走 `cordis.yml`）；不提供「永久删除」的一键入口（永久删除仍需显式参数与确认）；不绕过保护名单（包括 `allowProtectedOverride` 也不在 UI 暴露）。

## 2. 分层：面板是"薄"的

面板**不重新实现任何业务逻辑**，只做「渲染 + 收集选择 + 发起 RPC」。所有判断（分级、安全闸、测量、释放量核算）都留在宿主侧既有模块里，避免 GUI 与工具两条路径出现行为差异——工具和面板必须共用同一个 `executeCleanup` / `migratePath` / `buildPlan`。

```
Client（React，无业务判断）
   │  host.call(method, args)   ← 仅 lossless JSON
   ▼
Host 面板服务（本包新增 src/panel/service.ts）
   │  复用既有模块：scanner / classifier / planner / executor / migrator / history
   ▼
C:\ 真实文件系统
```

## 3. 宿主侧 RPC 契约（全部 lossless JSON）

| 方法 | 入参 | 出参（要点） |
| --- | --- | --- |
| `state` | `{}` | `{ schedule, historyPath, reportDir, defaultScope, drives, lastScan }` |
| `scan` | `{ scope?: 'hotspots'\|'full' }` | `{ planId, at, summary, groups, bigItems, longTerm, trend, partial, partialReasons }` |
| `preview` | `{ paths: string[], mode?: 'trash'\|'permanent', grade?, targetDrive? }` | `{ plannedBytes, items: [{ path, sizeBytes, verdict, reason, kind: 'delete'\|'trash'\|'elevate'\|'refused' }], refused: [...] }` |
| `migratePreview` | `{ paths: string[], targetDrive?: string }` | `{ items: [{ source, destination, sizeBytes, fileCount, hasRoom }], targetFreeBytes, needsLink: true }` |
| `execute` | `{ paths?: string[], grade?, mode, dryRun: boolean, elevation? }` | `{ jobId }`（**异步**：立即返回，进度靠轮询） |
| `migrate` | `{ paths: string[], targetDrive?, dryRun: boolean }` | `{ jobId }` |
| `rollback` | `{ paths: string[], dryRun: boolean }` | `{ jobId }` |
| `progress` | `{ jobId }` | `{ status: 'running'\|'done'\|'failed'\|'canceled', done, total, currentPath, items: [{ path, state, bytes }], freedBytes, measuredFreedBytes, reportPath?, error? }` |
| `cancel` | `{ jobId }` | `{ canceled: boolean }` |
| `history` | `{ limit?: number }` | `{ entries: [...], trend }` |

**进度为什么用轮询而不是推送**：进度是"当前值"语义，轮询一次拿全量快照最简单、最不容易在断线/刷新后失步；面板打开时 1 秒一次，完成后停。job 表为内存 Map，宿主重启即清空（面板据此显示"任务已随宿主重启消失"）。

## 4. 安全规则（与工具一致，且在 UI 层再加一道）

1. **保护层不可勾选**：`protected` 项渲染为不可选（复选框禁用 + 说明理由），即使调 `preview`/`execute` 传了这些路径，宿主侧 `guardTargets` 仍会拒绝——UI 只是提前告知，不是唯一防线。
2. **真实执行必须两步**：面板上「执行」默认以 `dryRun: true` 走一遍，把将要发生的动作逐项列出来，用户点「确认执行」才以 `dryRun: false` 发起。**面板没有跳过预演的捷径。**
3. **默认进暂存区**：删除模式默认 `trash`（可恢复），`permanent` 需在下拉里显式选择并二次确认。
4. **迁移不静默**：迁移只在原位置留目录联接，面板在执行前展示「源 → 目标」映射；应用配置（如 `.m2` 的 `localRepository`）需要改的，面板只提示、不代改。
5. **不碰 IDEA 缓存**：保护名单照旧（含 JetBrains 缓存），面板不提供任何覆盖入口。
6. **取消即中止**：`cancel` 触发 `AbortController`，正在复制的迁移项在检查点退出并清理副本，不留半迁移状态。

## 5. 面板状态机

```
idle ──扫描──▶ scanning ──▶ ready(卡片+趋势)
                              │ 勾选
                              ▼
                           selected ──预演──▶ previewing ──▶ previewed(逐项动作)
                                                              │ 确认
                                                              ▼
                                                     running(进度/可取消)
                                                        │
                                        ┌───────────────┴───────────────┐
                                        ▼                               ▼
                                  done(结果+新趋势)                 failed(错误+可重试)
```

## 6. 与 M4 的衔接

- 面板顶部显示 `📈 趋势`（来自 `history.jsonl`）：上次扫描时间、剩余空间变化、长回来的项——这正是用户"清完又长回来"的直觉来源。
- 定时扫描（`config.schedule.enabled`）在面板上只**显示状态与下次时间**，开关仍走配置：面板不做持久化设置。

## 7. 待平台契约确认后回填

- 客户端插件的注册机制与插槽选择（`Slots` 清单、注册协议 `single/list/keyed/chain`）。
- 客户端产物形态（模块格式、React 来源、样式注入方式）与构建步骤。
- 客户端→宿主 RPC 的包私有通道名称（本文档统一按 `host.call` 语义书写，实际 API 以平台为准）。
- 是否需要重建 Web 产物、是否需要重启 `dsh web`。
