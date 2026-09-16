# 更新日志

## [0.4.1] — 宿主实测修复（输出必须 lossless JSON / 报告落盘目录）

### 修正

- **宿主输出校验失败：`value is not lossless JSON`**（宿主实测抓到，非推断）。首次扫描没有上一次基准，`trend` 拿到 `undefined`，输出里就出现「键在、值为 `undefined`」——而 DSH 用 `snapshotJsonValue` 判定 lossless JSON，会拒绝嵌套 `undefined`、非有限数、稀疏数组、异物原型，于是**整次调用被拒**（扫描其实已经跑完落在历史里，只是结果回不来）。
  修复：M4 的可选字段集中到 `optionalFields()`，**只把有值的键放进去**；并新增 8.x 断言（`isLossless` 往返检查 + 首次扫描场景 + 空告警省略）把这条契约锁死。源码对照：`@deepseek-ai/dsh-tools` 在返回时快照并校验 lossless JSON，失败即抛 `value is not lossless JSON`。
- **报告默认落盘目录改为会话工作目录**：宿主 `process.cwd()` 是用户主目录，报告会掉进 `C:\Users\<你>\`。现在优先取 `exec.agent.session.meta.cwd`，取不到才退化到宿主 cwd；任何一环缺失都不会导致失败（9.1–9.4 覆盖四种情况）。

## [0.4.0] — M4：打磨（历史趋势 / JSON 报告 / 定时扫描与告警）

### 新增

- **历史趋势** `src/history/index.ts`：每次扫描追加一条 JSONL 记录到 `<DSH_HOME>/windows-c-cleanup/history.jsonl`，并与上一次扫描对比得出：剩余空间/已用变化、**长回来的目录**（>100 MB）、**被释放的目录**、新出现与未再测到的大头。
  这一项针对的正是本机实况——一轮清理后约 11 GB 被应用自己重建（企业微信升级 1.93 GB、`%TEMP%` 1.47 GB、WPS 插件 1.97 GB、Chrome ~0.8 GB、uv 327 MB），只删不盯是治不住的。
- **JSON 报告** `src/report/json.ts`：`format=json|both` 产出带 `schema: dsh-windows-c-cleanup/report@1` 版本号的机器可读报告，供 GUI / 脚本 / 监控消费；Markdown 与 JSON 可同时产出（`reportPath` 指向 `.md` 时，JSON 取同名 `.json`）。
- **定时扫描与告警** `src/scheduler/`：`config.schedule.enabled=true`（**默认关闭**）后按间隔自动扫描，范围默认 `hotspots`；剩余空间低于 `alertFreePercent`（默认 10%）时写告警记录并经 `ctx.logger` 输出。
  宿主事实：cordis 只提供 `ctx.logger` / `ctx.effect`，**没有定时器服务**，因此用 Node 定时器 + `unref()` + `ctx.effect` 托管释放。
- **不伤害宿主的四道保护**：单飞（上一轮未完成则跳过本轮）、首次执行延迟（默认 1 分钟，避开启动抢 I/O）、整轮 try/catch（失败只记日志）、定时器 `unref()`（不阻止进程退出）。
- **报告与工具输出**：Markdown 报告新增「🔔 空间告警」与「📈 历史趋势」区块；工具输出新增 `historyPath` / `reportJsonPath` / `trend` / `alerts` / `schedule` 字段。
- **配置**：`historyPath`、`defaultReportFormat`、`schedule.enabled/intervalHours/alertFreePercent/initialDelayMinutes/scope`。
- **测试**：`npm run m4`（33 项：假扫描覆盖调度语义 + 一次真实热点扫描串联趋势）、`npm run m4:live`（**真扫盘**端到端，把历史里的剩余空间与 `fs.statfs` 实测对比）。

### 修正

- **告警条目被覆盖成扫描条目**：`toAlertEntry` 里 `...input` 写在 `kind: 'alert'` 之后，扫描条目的 `kind: 'scan'` 把告警覆盖回去，导致告警永远筛不出来（测试 3.1/3.3 抓到）。已改为先摊开再覆盖。
- **历史 id 与方案编号不一致**：历史条目用扫描时间戳当 id，方案用 `plan-<时间戳>`，趋势对比会找不到自己那条记录，从而拿错基准。现在历史 id 直接用 `plan.id`，「方案 / 报告文件名 / 历史记录」三处共用同一身份。
- **JSON 报告路径双扩展名**：向 `reportPath` 传 `x.json` 时曾产出 `x.json.json`；现在按 `.md` / `.json` / 其他三种情况分别处理。

### 已知限制

- **定时扫描默认关闭**：它会在后台占用磁盘 I/O，属于需要用户显式同意的行为。
- **趋势按路径交集比较**：扫描被截断时「上次有、这次没有」≠「已被清理」，报告会注明 `previousPartial`。
- **历史文件固定在 `<DSH_HOME>`**：不放在会被清理的缓存目录里，避免历史被自己删掉。

## [0.3.0] — M3：迁移层（目录联接 / 台账 / 回滚）

### 新增

- **迁移引擎** `src/migrator/index.ts`：`migrateByJunction`（复制 → 校验 → 删源 → 建联接）、`rollbackMigration`（删联接 → 搬回 → 校验 → 清副本）、JSONL 台账与 `activeMigrations`。
- **工具动作**：`migrate` 与 `rollback` 实现；`grade: 'migrate'` 可自动挑选规则库里的迁移层目录。
- **迁移不可变式**：① 复制，② 校验副本大小与文件数，③ 删除源，④ 建立目录联接，⑤ 校验联接可读。任何一步失败都会**清理副本并保持原状**，绝不留下半迁移状态。
- **目录联接**：Windows 上创建 junction **不需要管理员权限**，应用无感地继续读写老路径；同盘迁移直接拒绝（不会释放空间）。
- **回滚安全**：回滚前比对联接目标与台账记录；若源位置不是联接（用户已放回真实目录）或指向不一致，**拒绝回滚**以免覆盖数据。
- **配置**：新增 `migrationRoot`（缺省 `<空闲最大的非系统盘>:\dsh-cc-migrated`，台账 `ledger.jsonl` 与之同目录）。
- **测试**：`tests/m3-migrate.ts`（`npm run m3`）14 项隔离用例：保护名单拒绝、同盘拒绝、源为联接拒绝、目标已存在拒绝、dryRun 默认、真实迁移 + 经联接读写、台账落盘、回滚、无记录回滚。

### 修正

- **盘符拼接错误**：`driveOf()` 已返回 `d:`，再拼 `:\\` 得到 `D::\`，使 `fs.statfs` 失败 → 所有迁移被误判为「目标盘空间不足」（测试当场抓到）。同时把空间预检改为**三态**：读不到剩余空间时不再当成「不足」，而是放行并交给复制阶段的 `ENOSPC` 兜底，失败时回滚副本。

### 已知限制

- `app-config` 类规则的迁移目前只搬数据并给出建议命令，**不自动修改应用配置**（避免静默改坏用户环境）。
- 迁移是「复制 + 删除」，大目录（数十 GB）需要与体积相称的时间（工具超时上限 15 分钟）。
- 被应用占用的目录无法迁移：删除源失败时回滚副本并提示先关闭应用。

## [0.2.0] — M2：执行层（删除 / 暂存区 / 提权）

### 新增

- **执行引擎**：`src/executor/` — 安全闸（`safety.ts`）、删除（`delete.ts`）、暂存区（`trash.ts`）、提权（`elevate.ts`）、编排（`index.ts`）。
- **工具动作**：`apply` 与 `trash` 实现；新增参数 `mode`（`permanent` / `trash`）、`trashPath`、`dryRun`、`elevation`（`none` / `dism` / `cleanmgr` / `dism+cleanmgr`）。
- **安全闸（硬约束）**：保护名单（含 `overridable: false`）、盘根与 `C:\Users` 等关键目录、目录联接与符号链接、父目录含 junction 的路径、非系统盘路径、不存在的路径、未收录规则库的路径 —— 全部拒绝并给出可展示理由。
- **删除引擎**：删前测量 → 递归删除 → 删后核对残留；被占用文件记为「部分删除」并给出残留字节数；需要管理员权限的失败单独标识。
- **暂存区**：跨盘移动（同卷 rename → 跨卷复制后删除），**同盘暂存直接拒绝**（不释放空间），每次移动写 JSONL 台账供 M3 回滚；移动失败不写台账。
- **UAC 提权链路**：把任务写成 PowerShell 脚本（`%TEMP%\dsh-cc-elevated-*.ps1`）经 `Start-Process -Verb RunAs` 执行，日志回收到结果；用户拒绝授权时标记 `elevation-canceled` 并说明；内置任务构造器：删目录、DISM `StartComponentCleanup`、cleanmgr `sagerun`。
- **执行报告**：`C盘清理执行报告-<时间戳>.md`，含逐项结果、两种释放量口径、被拒绝项理由、提权日志摘要。
- **默认预演**：`dryRun` 默认 `true`；谨慎层（`caution`）不允许按级别批量，必须逐项给出 `items`。
- **配置**：新增 `defaultDeleteMode`（默认 `trash`）、`trashPath`、`allowExplicitUnmatched`（默认 `false`）。
- **测试**：`tests/m2-execute.ts`（`npm run m2`）14 项隔离用例，真实删除/移动只发生在 `%TEMP%` 沙箱与专用测试暂存区。

### 修正

- **盘符比较错误**（会导致真实 `apply` 把所有目标判成「越界」而全部拒绝）：`normalizePath('C:\\')` 得到 `c:`、`normalizePath('C')` 得到 `c`，比较永不相等。改为统一抽取盘符字母后比较；盘根判定提前到绝对路径校验之前。
- **规则库路径探测错误**：原先「取第一个候选路径」，而 `tsc` 不复制 JSON，宿主加载编译产物时会 `ENOENT`；改为逐个探测真实存在的候选路径。
- **释放量口径**：新增「逐项测量合计」，避免小体量清理时盘符空闲净增被其他进程写入掩盖而显示为 0。

### 已知限制

- 管理员级清理依赖 UAC 弹窗（DSH 无 UAC 原语）。
- 被运行中的应用锁定的缓存文件无法删除，如实记为「部分删除」。
- `migrate` / `rollback` 仍为 `not-implemented`（M3）。

## [0.1.0] — M1：只读扫描与五级分级

### 新增

- **插件骨架**：命名导出 `name` / `inject` / `Config` / `apply`（无 default，避免 Loader 解包时丢失 `inject`）；声明 `dsh.bundle.patch`，可被 `dsh plugin add` 激活成 profile 层。
- **工具 `disk_cleanup`**：`action` 词表 `scan` / `plan` / `apply` / `migrate` / `rollback` / `trash`；M1 实现只读的 `scan` / `plan`，其余动作返回 `not-implemented`（写在成功结果里，不抛错）。
- **规则库**：101 条路径规则 + 6 项长期防护措施，全部以 `%LOCALAPPDATA%` 等占位符书写，不含用户名硬编码；覆盖缓存、临时文件、升级包残留、IDE 索引、浏览器端侧 AI 模型、包管理器仓库、WinSxS、虚拟磁盘、聊天数据等。
- **扫描器**：盘符信息（`fs.statfs`，无需外部命令）、规则热点清单、全盘 Top-N 大目录、junction/符号链接安全测量（不跟随、不重复计数）、时间预算与 `partial` 标记、`AbortSignal` 取消。
- **分级器**：五级分级（🟢安全 / 🟡谨慎 / 🟠迁移 / 🔴保护 / 🔵长期防护）；优先级为「最具体路径胜出，同长度 protected 优先」；未命中任何规则的路径一律按保护处理。
- **计划与报告**：方案构建（含迁移目标盘自动选择）与 Markdown 可视化报告（汇总 → 🟥大头 → 五级清单 → 执行结果）。
- **测试**：`tests/smoke.ts` 快速自检（规则匹配 7/7）；`tests/tool-run.ts` 无头端到端（走真实 `defineTool` 定义与 `output.render`）。

### 安全

- 保护名单中 `overridable: false` 的条目为**硬约束**，用户规则不得覆盖（除非显式开启 `allowProtectedOverride`）。
- 工具实现透传 `exec.signal`，长扫描可被调用方取消。
- 扫描超时会在报告与工具返回值中显式标记 `partial`，不静默给出残缺结论。
- 未识别路径一律不删（不明即不删）。

### 已知限制

- `apply` / `migrate` / `rollback` / `trash` 尚未实现（M2 / M3）。
- 尚无语义化的「暂存区（回收站式）」与 UAC 提权执行链路（M2）。
- 报告为 Markdown 文件交付；交互式 GUI 卡片计划在 M4。
