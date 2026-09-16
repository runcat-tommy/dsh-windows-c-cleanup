# 更新日志

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
