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
   **不可点就必须说出原因**：禁用按钮在多数浏览器里收不到鼠标事件、`title` 弹不出来，所以原因必须渲染成**可见文案**并放在按钮旁边。门禁抽成纯函数 `confirmGate()`（`busy` / `no-selection` / `need-preview` / `stale-preview` / `ready`），`disabled` 与提示由**同一份判定**驱动——不允许"按钮点不动、界面不说为什么"，也不允许把"没勾选"说成"请重新预演"（这个错误已踩过一次，是用户实测反馈才暴露的）。
3. **默认进暂存区**：删除模式默认 `trash`（可恢复），`permanent` 需在下拉里显式选择并二次确认。
4. **迁移不静默**：迁移只在原位置留目录联接，面板在执行前展示「源 → 目标」映射；应用配置（如 `.m2` 的 `localRepository`）需要改的，面板只提示、不代改。
5. **不碰 IDEA 缓存**：保护名单照旧（含 JetBrains 缓存），面板不提供任何覆盖入口。
6. **取消即中止**：`cancel` 触发 `AbortController`，正在复制的迁移项在检查点退出并清理副本，不留半迁移状态。
7. **不能点的按钮不能画得像能点**（可辨识度与诚实性是同一条规则）：需要一眼认出的三个动作按钮（扫描 / 清空选择 / 预演）只在**可用**时用加粗描边 + 底色 + 投影强调，禁用时回落成原来的浅底灰边半透明——所以所有"显眼"样式都必须限定 `:not(:disabled)`。这条由 `npm run m5:client` 第 7 节机械校验（`.wcc_btn_action` 的每条规则都必须带 `:not(:disabled)`，且不得出现 `.wcc_btn_action:disabled`）。

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

## 7. 平台契约（已从内置包实证回填）

设计阶段留的四个问题，全部在真实 bundle 与 `dsh-client-modules` 源码里核对过，结论如下（本节即最终事实，不再是待办）：

| 问题 | 实证结论 |
| --- | --- |
| 客户端插件的注册机制 | 包声明 `exports["./client"]` + `dsh.client = { platform: "web", inject: [...] }`；单条 `cordis.patch.yml` 行同时携带宿主面与客户端面；宿主在运行期扫 Loader 条目、拼 `window.__DSH_BOOT__`、按 `/plugins/<id>/client.js?rev=<rev>` 提供产物，`id` 即包名 |
| 插槽选择 | `conversation.view` 是 additive `list`（`replaceRisk: none`），注册项为 `{ name, id, order, label }`；`root`/`sidebar`/`conversation`/`details` 都是 single，注册即摧毁后代席位，已避开 |
| 产物形态与 React 来源 | classic script，顶层唯一语句是 `window.__ModuleLoader__.load({ id, factory })`；factory 内只有**静态 seed 表**这 10 个说明符可用（`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、cordis、`dsh-client-ui-slots`、`dsh-client-web-react`、`dsh-client-ui-primitives`、`dsh-client-ui-attachment`、`dsh-client-schema-form`），其它说明符会当场抛错 → 第三方库必须打进 bundle。本插件只用 `react` 与 `react/jsx-runtime`，两者都 external |
| 客户端→宿主通道 | 静态包不能用 `host.call` / `harness.handle`（那是动态插件专属）；用 `ctx.connection.rpc.handle(channel, handler, { authority: 'loopback' })` + `connection.rpc.call(channel, endpoint, payload)`，通道名须匹配 `/^\/[A-Za-z0-9._~-]+$/`，返回 `RpcResult`（`'internal'` 码必须带 `details: {}`） |
| 是否要重建/重启 | 包元数据判定被宿主**永久缓存** → 新增/删除包、改 `dsh.client` 字段必须重启 `dsh web`；只改 bundle 内容刷新页面即可（本 profile 的 HMR 关闭：`dsh-web-app/cordis.patch.yml` 里 `- id: hmr` 带 `disabled: true`），产物以 `no-cache` 提供 |
| 中英双语怎么接（0.5.1 实证回填） | `ctx.locale.register(ns, 'zh'\|'en', dict)` 注册字典（命名空间不在 `LocaleNamespaceMap` 里就走这条未类型化重载）；插槽注册项加 `locale: '<ns>'` 后框架注入 `t` 席位，席位按 `(namespace, revision)` 重算，**语言切换会让已挂载的 outlet 重新渲染**；`label` 可以是 **thunk**，于是 tab 标题跟着语言走而无需重新注册；渲染时若声明了 `locale:` 而宿主没装语言面，框架会**显式报错**（所以字典注册与 `ctx.get('locale')` 判空必须成对写，缺失时退化成"按浏览器语言自选字典"） |

## 8. 双语策略（0.5.1）

需求是「UI 与 README 都做中英两套」。落地时按**边界**切开，而不是把中文句子翻译两遍：

| 文案来自哪 | 归属 | 做法 |
| --- | --- | --- |
| 面板界面文字（按钮、标题、提示、状态词） | 客户端 | `client/src/i18n.ts` 里的 `ZH`/`EN` 字典（各 112 条），占位符用 `{name}` 插值；测试守「键集合严格一致」「英文值不得含中文」 |
| 规则库判定理由（101 条） | 宿主 | 中文在 `default-rules.json`，英文在 `default-rules.en.json`，**按 rule id 对齐**（不是按顺序、不是按索引）；缺失回退中文 |
| 安全闸拒绝理由（12 条）、执行器计划动作、迁移配置提示 | 宿主 | 字符串就写在调用点旁边，`pick(locale, 中文, English)` 二选一——这类句子带运行时变量（路径、大小），放远端目录反而更难维护 |
| 调度状态 | 宿主 | 不再返回句子，改返回**结构化字段**（`{enabled, running, intervalHours, alertFreePercent}`），由面板按语言组织 |
| 报告 / 执行记录文件 | 宿主 | **保持中文**（这是落到磁盘、给模型与用户看的归档物，不是界面），已在文档中写明 |

三条硬约定：

1. **默认中文**：`normalizeLocale()` 只认 `'en'`，其余一律回中文；模型工具路径不传 `locale`，所以工具输出与历史逐字一致（有测试 10.4 守着）。
2. **回退优先于空洞**：任何英文缺项都回退中文原文（10.5），界面永远不会出现空字符串或 key 名。
3. **两端各自判定，不互相猜**：客户端用平台 `locale` 服务（缺失才退化到 `navigator.language`），宿主只信 payload 里的 `locale` 字段；两边都不做"探测对方语言"的小聪明。

**时序坑（踩过一次，已修）**：客户端 `apply` 执行的瞬间语言服务未必就绪，而框架在渲染声明了 `locale:` 的注册项时**找不到字典会显式报错**。所以接线改成 `ctx.inject(['locale'], wireUp)`（拿不到 `inject` 的宿主/测试替身直接接线并退化为按浏览器语言自选），翻译函数与当前语言也都在**调用时**重新 `ctx.get('locale')`，而不是在 `apply` 里缓存。同时 `dsh.client.inject` 里声明了 `@deepseek-ai/dsh-client-locale` 保证模块加载顺序——这条属于包元数据，改动后需要重启 `dsh web`（测试 6.1–6.6 守着这套时序）。

面板落地后的实测口径：`npm run m5`（宿主面 52 项）与 `npm run m5:client`（客户端产物 32 项，离线重放浏览器加载、中英各真渲染一次首屏）全绿。
