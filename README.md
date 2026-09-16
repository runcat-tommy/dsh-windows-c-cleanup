# dsh-windows-c-cleanup

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加上** Windows 系统盘（C 盘）清理能力**的插件。

它不是「一键删缓存」脚本，而是把清理拆成一条可审计的流水线：

> **扫描 → 五级分级 → 生成可视化报告 → 用户选择 → 分层执行 / 迁移到其他盘**

## 为什么需要它

C 盘爆满通常不是「垃圾文件」造成的，而是**本该放在别的盘的东西放错了地方**：包管理器缓存、IDE 索引、浏览器端侧 AI 模型、升级包残留、虚拟磁盘。

直接删风险很高（删掉 IDE 索引要重建几小时，删掉虚拟磁盘等于毁掉整个 Linux 环境）。本插件的做法是：

1. **先量后删**：按规则库把每个候选项测出真实大小，产出可视化 Markdown 报告；
2. **五级分级**：每个候选项都带判定理由，用户看得懂再决定；
3. **保护名单是硬约束**：未收录规则的一律按保护处理（不明即不删）；
4. **能迁移就不删除**：有多个盘时，优先用 junction / 改配置把缓存搬到别的盘，长期不再回涨。

## 五级分级

| 级别 | 含义 | 执行策略 |
| --- | --- | --- |
| 🟢 可安全删除 | 缓存 / 临时文件 / 升级包残留，无数据损失 | 确认一次后可批量执行 |
| 🟡 谨慎删除 | 可重建但代价高（IDE 索引、端侧 AI 模型、包管理器仓库），或需管理员权限（WinSxS 走 DISM） | 逐项确认 |
| 🟠 建议迁移 | 搬到其他盘后应用无感，可用 junction 或改配置 | 迁移 + 建链接 + 记台账，可回滚 |
| 🔴 保护名单 | 用户文档、凭据、聊天数据、虚拟磁盘、IDE 配置、未识别路径 | **永不自动删除**（硬约束，用户规则也不得覆盖） |
| 🔵 长期防护 | 配置类动作：缓存重定向、存储感知、虚拟磁盘位置核查 | 一次性做好，长期少清理 |

## 安装

```powershell
# 从本地目录安装（开发时）
dsh plugin --profile web add D:\path\to\windows-c-cleanup

# 或从 npm 安装（发布后）
dsh plugin --profile web add dsh-windows-c-cleanup
```

`dsh plugin` 会把包装进 profile 并自动把它登记进 `dsh.profile.bundles`（依赖包里声明了 `dsh.bundle.patch`）。装完**重启 DSH** 生效：

```powershell
dsh web
```

开发时也可以不安装，直接挂 overlay（注意 Windows 必须用 `file://` URL）：

```powershell
node -e "const{pathToFileURL}=require('node:url');console.log(pathToFileURL(process.argv[1]).href)" "$PWD\src\index.ts"
dsh web --patch .\dev.cordis.yml
```

## 使用

插件注册一个工具 `disk_cleanup`：

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `action` | `scan` \| `plan` \| `apply` \| `migrate` \| `rollback` \| `trash` | 必填。`scan`/`plan` 只读；`apply`/`trash` 执行清理（M2）；`migrate`/`rollback` 迁移与回滚（M3） |
| `scope` | `hotspots` \| `full` | `hotspots` 只按规则库测热点（快）；`full` 追加全盘 Top-N 大目录（默认） |
| `reportPath` | 路径 | 报告落盘位置，缺省 `工作目录/C盘清理报告-<时间戳>.md` |
| `items` | 路径数组 | 要清理的具体路径（**谨慎层必填**：只接受用户逐项确认过的路径） |
| `grade` | `safe` \| `caution` \| `migrate` | 按层级选范围：`safe` 可批量；`caution` 必须同时给出 `items`；`migrate` 配合 `action=migrate` 自动挑选迁移层 |
| `mode` | `permanent` \| `trash` | 删除模式：`trash` 移到其他盘暂存区（可恢复，**默认**）；`permanent` 永久删除 |
| `trashPath` | 路径 | 暂存区位置，**必须位于其他盘**（同盘移动不释放空间）；缺省 `<空闲最大的非系统盘>:\to_delete` |
| `dryRun` | 布尔 | **默认 `true`**：只列出将要执行的动作，不删任何文件；用户确认后才传 `false` |
| `elevation` | `none` \| `dism` \| `cleanmgr` \| `dism+cleanmgr` | 是否一并触发管理员级系统清理（会弹 UAC） |
| `targetDrive` | 如 `D:` | 迁移目标盘；缺省自动选空闲最大的非系统盘 |
| `extraRulesFile` | 路径 | 本次扫描叠加的用户规则文件 |

调用示例（自然语言即可，模型会映射到工具）：

> 帮我扫一下 C 盘，看看哪里占地方最大

工具会产出：

- **工具返回值**：盘符、剩余空间、各层可释放字节数、大头 Top-N、迁移目标盘建议；
- **可视化报告**（Markdown）：汇总 → 🟥 大头 → 🟢/🟡/🟠/🔴/🔵 五级清单 → 执行结果。

### 执行清理（M2）

执行是**两阶段**的，安全默认值不靠调用方自觉：

1. **预演**：`apply` 不传 `dryRun` 时默认 `dryRun: true`，只输出「将要删什么、多大、为什么」的逐项清单，并落盘一份 `C盘清理执行报告-<时间戳>.md`；
2. **执行**：用户确认后，才用 `dryRun: false` 真正执行。

```jsonc
// 1) 安全层批量预演（不删文件）
{ "action": "apply", "grade": "safe" }

// 2) 用户逐项确认后的谨慎层（必须列出具体路径）
{ "action": "apply", "items": ["C:\\Users\\<你>\\AppData\\Local\\Temp\\某缓存"], "mode": "trash", "dryRun": false }

// 3) 永久删除（需用户明确同意）
{ "action": "apply", "items": ["..."], "mode": "permanent", "dryRun": false }

// 4) 附带管理员级系统清理（会弹 UAC，用户拒绝则如实回报）
{ "action": "apply", "grade": "safe", "dryRun": false, "elevation": "dism+cleanmgr" }
```

执行报告与返回值会给出：逐项结果（已删除 / 已入暂存区 / 部分删除 / 已拒绝 / 需提权）、**逐项测量合计释放量**、盘符空闲净增、被拒绝项的完整理由、提权脚本路径与日志摘要。

### 迁移与回滚（M3）

「删掉」只是治标——企业微信、WPS、浏览器、包管理器的缓存删完会再长回来（实测一轮清理后约 11 GB 被应用自己重建）。迁移是治本：把目录搬到其他盘，**在原位置留一个目录联接（junction）**，应用完全无感。

```jsonc
// 1) 预演迁移（不动数据）
{ "action": "migrate", "items": ["C:\\Users\\<你>\\AppData\\Local\\npm-cache"], "targetDrive": "D" }

// 2) 用户确认后执行；原目录变成 junction，数据在 D:\dsh-cc-migrated\npm-cache
{ "action": "migrate", "items": ["..."], "targetDrive": "D", "dryRun": false }

// 3) 自动挑选规则库里的 🟠 迁移层
{ "action": "migrate", "grade": "migrate", "dryRun": false }

// 4) 后悔了：依据台账搬回并删除联接
{ "action": "rollback", "dryRun": false }
```

不可让步的执行顺序：**复制 → 校验（大小与文件数）→ 删除源 → 建立联接 → 校验联接可读**。任何一步失败都会清理副本并保持原状，绝不留下「半迁移」状态让用户自己收拾。具体保证：

| 情况 | 行为 |
| --- | --- |
| 目标与源在同一盘 | 拒绝（移动不释放空间） |
| 目标同名目录已存在 | 拒绝并提示，**绝不合并** |
| 目标盘空间不足 | 拒绝，并给出需要的空间 |
| 源目录被应用占用、删不掉 | 回滚已复制的副本，原状态不变，提示先关闭应用 |
| 复制成功但建联接失败 | 明确报告数据已在新位置、老路径不可用，绝不谎报成功 |
| 回滚时源位置不是联接或指向不一致 | **拒绝回滚**，避免覆盖用户后来放回的数据 |
| 迁移台账 | `<migrationRoot>\ledger.jsonl`，逐条记录源/目标/大小/时间/方法 |

`app-config` 类规则（如 npm 缓存）除搬数据外，还会返回建议命令（例如 `npm config set cache "D:\..."`），但**不自动修改应用配置**。目录联接在 Windows 上不需要管理员权限。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖（patch 会**整体替换**该行 config，不做深合并）：

```yaml
- id: windows-c-cleanup
  name: 'dsh-windows-c-cleanup'
  config:
    reportDir: 'D:\reports'
    defaultScope: full
    hotspotTimeBudgetMs: 70000
    topTreeTimeBudgetMs: 70000
    topTreeMaxDepth: 3
    bigItemThresholdBytes: 2147483648
    allowProtectedOverride: false
    allowExplicitUnmatched: false
    defaultDeleteMode: trash
    trashPath: 'D:\to_delete'
    migrationRoot: 'D:\dsh-cc-migrated'
    extraRulesFile: 'D:\my-rules.json'
```

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `reportDir` | 当前工作目录 | 报告输出目录 |
| `defaultScope` | `full` | 默认扫描范围 |
| `hotspotTimeBudgetMs` | `70000` | 热点清单时间预算（超时截断并标记） |
| `topTreeTimeBudgetMs` | `70000` | 全盘 Top-N 时间预算（两个扫描并行，总时长约等于较大者） |
| `topTreeMaxDepth` | `3` | Top-N 遍历深度 |
| `bigItemThresholdBytes` | `2 GiB` | 「大头」判定阈值 |
| `allowProtectedOverride` | `false` | **是否允许用户规则覆盖保护名单**（默认禁止；硬约束项永不放行） |
| `allowExplicitUnmatched` | `false` | 是否允许清理未收录规则库的显式路径（默认「不明即不删」） |
| `defaultDeleteMode` | `trash` | 默认删除模式：`trash` 移到其他盘暂存区，`permanent` 直接删除 |
| `trashPath` | `<空闲最大的非系统盘>:\to_delete` | 暂存区位置（必须与其他盘同盘不同卷才释放空间） |
| `migrationRoot` | `<空闲最大的非系统盘>:\dsh-cc-migrated` | 迁移根目录；迁移台账 `ledger.jsonl` 与之同目录 |
| `extraRulesFile` | 无 | 用户附加规则文件 |

## 规则库

内置 100+ 条规则位于 `src/rules/default-rules.json`，全部用占位符书写（`%LOCALAPPDATA%`、`%APPDATA%`、`%USERPROFILE%`、`%WINDIR%`…），**不含用户名硬编码**，可跨机器复用。

规则形态：

```json
{
  "id": "npm-cache-local",
  "path": "%LOCALAPPDATA%\\npm-cache",
  "grade": "migrate",
  "reason": "npm 包缓存，体积常达数 GB；建议迁移到其他盘并从 C 盘释放",
  "migrate": {
    "method": "app-config",
    "targetHint": "<其他盘>:\\npm-cache",
    "configHint": "npm config set cache \"<目标路径>\""
  }
}
```

匹配语义：候选路径等于规则路径或位于其下即命中；`*` 只匹配单段目录名（如 `%LOCALAPPDATA%\*-updater`）。
优先级：**最具体的路径胜出**，同长度时 `protected` 优先；未命中任何规则 → 按 `protected` 处理。

自定义规则文件只需同结构：

```json
{ "rules": [{ "id": "my-cache", "path": "%LOCALAPPDATA%\\my-app\\cache", "grade": "safe", "reason": "自建应用缓存" }] }
```

试图覆盖 `overridable: false` 的保护名单项会被拒绝并告警（除非显式开启 `allowProtectedOverride`）。

## 安全设计

- **保护名单硬约束**：用户文档、桌面、下载、SSH/云凭据、`.dsh` 配置、聊天数据（企业微信/飞书/微信）、IDE 配置、`pagefile.sys` / `hiberfil.sys` / 虚拟磁盘、`Program Files`、`Windows` —— 永不自动删除。
- **未识别即保护**：规则库没收录的目录不会被删（除非显式开启 `allowExplicitUnmatched`）。
- **分层确认**：安全层可一次确认；谨慎层逐项确认；保护层不出现执行入口。
- **默认预演**：`apply` / `trash` 的 `dryRun` 默认为 `true`，不显式传 `false` 就不会删任何文件。
- **结构性禁忌**：盘根、`C:\Users` 等关键目录、目录联接/符号链接、父目录含 junction 的路径、非系统盘路径，执行前一律拒绝。
- **同盘暂存被拒绝**：暂存区与源在同一卷时移动不释放任何空间，因此直接拒绝并说明原因。
- **如实汇报**：被占用/无权限的文件删不掉时返回「部分删除」与残留字节数；用户拒绝 UAC 时返回 `elevation-canceled`，绝不谎报成功。
- **两种释放量都给**：同时给出「逐项测量合计」与「盘符空闲净增」——清理量较小时后者会被其他进程的写入掩盖。
- **时间预算**：扫描超时会截断并在报告与返回值里明确标记 `partial`，不会静默给出残缺结论。
- **不跟随链接**：junction / 符号链接一律不跟随，避免重复计数与递归踩坑。
- **迁移可回滚**：迁移用 `junction` 或应用配置改路径，并记录台账（M3 起提供 `rollback`）。

## 当前状态（M1 + M2 + M3）

- [x] 规则库（100+ 条，占位符化）+ 长期防护清单
- [x] 扫描：盘符信息、热点清单、全盘 Top-N、junction 安全测量、时间预算
- [x] 五级分级 + 未识别即保护
- [x] 可视化 Markdown 报告
- [x] DSH 工具注册（`disk_cleanup`，参数/输出 schema 校验通过）
- [x] M2 执行层：删除（安全层批量 / 谨慎层逐项）、暂存区与台账、UAC 提权（Windows\Temp / WinSxS / DISM / cleanmgr）、执行报告与 dryRun 默认
- [x] M3 迁移层：目录联接迁移（应用无感）、迁移台账与 `rollback`、对同盘/同名冲突/空间不足/源被占用的拒绝与回滚、app-config 建议命令
- [ ] M4 Web GUI：五级分区卡片、勾选、进度、空间变化对比
- [ ] M5 定时扫描与告警
- [ ] M6 发布（npm + 社区插件市场）

## 已知限制（M1 + M2 + M3）

- **执行需要明确授权**：`apply` / `trash` 默认预演；真正的执行路径必须先跑扫描并把报告交给用户确认。`migrate` / `rollback` 仍是 `not-implemented`（M3）。
- **管理员级清理依赖 UAC 弹窗**：DSH 的权限栈没有 UAC 原语，插件通过 `Start-Process -Verb RunAs` 触发系统弹窗（脚本落在 `%TEMP%\dsh-cc-elevated-*.ps1`）；用户不点「是」就无法清理 `Windows\Temp`、`SoftwareDistribution`、WinSxS 等，此时结果里会明确标记为「用户取消」。
- **被占用的文件删不掉**：浏览器、IDE、企业微信正在运行时其缓存文件会被锁定，结果中记为「部分删除」并给出残留量——这是 Windows 的正常行为，不是插件故障。
- **全盘 Top-N 覆盖度受 I/O 上限约束**：Node 的文件操作走 libuv 线程池（默认 4 线程），目录测量成本基本由**文件数**决定，加并发也提不上去。因此在 70 秒预算内，153 GB 已用盘的热点规则可 100% 覆盖，但全盘 Top-N 只能遍历部分目录（实测约 160 个顶层/浅层目录后截断）。
  截断时报告与工具返回值都会标记 `partial` 并说明原因，不会伪装成完整结论；需要更高覆盖率可调大 `topTreeTimeBudgetMs`（代价是等待更久）。**可执行结论来自热点规则，Top-N 只作兜底**，因此截断不影响五级清单的可用性。
- **释放量核算的两种口径**：小体量清理（数十 MB 级）时「盘符空闲净增」可能为 0（被其他进程同时写入掩盖），此时以「逐项测量合计」为准，报告里会同时给出并注明。
- **迁移耗时与被迁移体积成正比**：迁移是「复制 → 校验 → 删源 → 建联接」，数十 GB 的目录会很慢（工具超时上限 15 分钟）；被应用占用的目录会在删源阶段中止并回滚副本。
- **`app-config` 类迁移不自动改配置**：插件只搬数据（并建立目录联接保证应用仍可用）并给出建议命令；是否让应用改用新路径由用户确认后自己执行，避免静默改坏环境。
- 尚未提供交互式确认界面：目前由模型把报告交给用户，用户选定范围后再进入执行链路（M4 提供 GUI 卡片）。

## 开发

```powershell
npm install --legacy-peer-deps   # DSH 类型包 peer 冲突，本地用 legacy 解析
npm run typecheck                # 类型检查
npm run smoke                    # 快速自检：规则匹配 / 盘信息 / 限时测量
npm run m2                       # M2 执行层隔离用例（真实删除只发生在 %TEMP% 沙箱）
npm run m3                       # M3 迁移层隔离用例（真实迁移只发生在 %TEMP% 沙箱 + D:\dsh-cc-m3-test）
npx tsx tests/tool-run.ts full    # 无头跑完整扫描，产出真实报告
npm run build                     # 编译到 lib/（发布物）
```

> ⚠️ 不要用 PowerShell 的 `Get-Content`/`Set-Content` 管道改写本仓库的 UTF-8 文本文件
> （默认编码会把中文写成乱码并使 `package.json` 变成非法 JSON）；请用编辑工具直接改。

## 许可

MIT
