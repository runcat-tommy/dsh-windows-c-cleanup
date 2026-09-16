# dsh-windows-c-cleanup

[English](README.en.md) ｜ **中文**

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
| `format` | `markdown` \| `json` \| `both` | 报告格式，缺省取配置 `defaultReportFormat`；`json` 产出机器可读报告（传 `x.md` 时会同时写同名 `x.json`） |
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

### 历史趋势与 JSON 报告（M4）

删掉的缓存会长回来——本机实测一轮清理后约 11 GB 被应用自己重建（企业微信升级 1.93 GB、`%TEMP%` 1.47 GB、WPS 插件 1.97 GB、Chrome ~0.8 GB、uv 327 MB）。所以每次扫描都会往 `<DSH_HOME>\windows-c-cleanup\history.jsonl` 追加一条记录，并与上一次对比：

```
📈 与上一次扫描（24 小时前）：剩余空间 −1.20 GB ｜ 长回来 3 项 ｜ 被释放 1 项 ｜ 增长最多：…\WXWork\upgrade +1.93 GB
```

Markdown 报告里渲染成「📈 历史趋势」区块（长回来的 / 被释放的 / 新出现的 / 本次未再测到的）；机器可读版本用 `format`：

```jsonc
{ "action": "scan", "format": "both" }   // → C盘清理报告-<时间戳>.md + 同名 .json
```

JSON 报告带 `schema: "dsh-windows-c-cleanup/report@1"` 版本号，含五级分组、大头、趋势与告警，可直接喂给 GUI / 脚本 / 监控。**趋势只在路径交集上比较**：扫描被时间预算截断时，「上次有、这次没有」不等于「已被清理」，报告里用 `previousPartial` 标注。

### 定时扫描与告警（M4）

默认**关闭**——后台扫盘会占用你的磁盘 I/O，属于需要你点头的行为。打开后：

```yaml
- id: windows-c-cleanup
  name: dsh-windows-c-cleanup
  config:
    schedule:
      enabled: true
      intervalHours: 24
      alertFreePercent: 10
      scope: hotspots
```

- 低于 `alertFreePercent` 时写一条告警记录（下次扫描的工具输出 / 报告顶部会显示），并经 `ctx.logger` 输出 `warn` 日志；
- 宿主只提供 `ctx.logger` / `ctx.effect`，**没有定时器服务**，所以用 Node 定时器 + `unref()` + `ctx.effect` 托管释放；
- **四道保护**：单飞（上一轮没跑完就跳过本轮）、首次延迟 1 分钟（避开启动抢 I/O）、整轮 try/catch（失败只记日志）、`unref()`（不阻止宿主退出）。

### 清理面板（M5）

插件在 Web GUI 里注册一个**对话视图 tab**（`conversation.view`，additive list 插槽，不覆盖任何现有界面）：打开任意会话，切到「磁盘清理」就能完成「看懂 → 勾选 → 预演 → 执行」。

面板是**薄的**：它不做任何业务判断，分级、安全闸、测量、释放量核算全部复用宿主侧既有模块；面板调用的「预演」和「真执行」走的是**同一个 `executeCleanup`**（只有 `dryRun` 不同），所以预演里出现的每一项、每个理由都与真执行一致。

工具栏按「同组相邻」排成三组，从左到右：

| 组 | 控件 | 说明 |
| --- | --- | --- |
| ① 扫描 | `范围` 下拉 + `扫描 C 盘` | 选 hotspots/full，然后开扫（已扫过则显示「重新扫描」） |
| ② 选择 | `已选 N 项` + `清空选择` | 实时计数与一键清空 |
| ③ 执行 | `删除方式` 下拉 + `预演` + `?` + `确认执行` | 「预演」右边就是问号说明按钮 |

- **`?` 说明按钮**：点开就地解释「预演（dry run）是做什么的」——它会真的跑一遍安全闸与逐项计划，但不动任何数据；同时说明面板的三条硬边界（逐项确认、拒绝项不可执行、不做管理员提权之外的动作）。
- 五级卡片：🟢安全 / 🟡谨慎 / 🟠可迁移 / 🔴保护，逐项显示路径、大小、判定理由；保护层**不可勾选**；
- 两步执行：必须先「预演」看到逐项动作，按钮才可点「确认执行」；勾选或模式一变，预演即失效需要重跑；
- 真实进度：进度条来自宿主的**逐项记账回调**（不是猜日志文本），随时可「取消任务」；
- 迁移预览：先看「源 → 目标」映射、文件数、目标盘是否够，再决定是否迁移；需要你改的应用配置只提示、不代改；
- 趋势：面板顶部直接显示上次扫描的时间差与「长回来的目录」。

#### 中英双语

面板与宿主文案都是**中英两套**，跟随 DSH 的语言设置自动切换，不需要手动选语言：

- 界面文案由客户端字典提供（`client/src/i18n.ts`，中英各 112 条），tab 标题是**函数式标签**，语言一换标题即跟着换，无需重新注册；
- 面板每次调用宿主 RPC 都会带上当前 `locale`，所以**宿主生成的文案**也跟着切换：规则库的每一条判定理由、安全闸的 12 条拒绝理由、执行器的逐项计划动作、迁移配置提示、调度状态。英文文案放在 `src/rules/default-rules.en.json`，按规则 id 与中文严格对齐（101 条规则 + 6 条长期防护，有测试守着覆盖率和「英文里不得出现中文」）；
- **默认中文**：模型工具（`disk_cleanup`）那条路不传 `locale`，输出与历史完全一致；只有 Web 面板会传 `en`；
- 英文缺项一律回退中文原文，宁可显示中文也不显示空洞；
- 宿主重启后语言切换才生效？不需要——**刷新页面即可**（字典注册在客户端插件里，语言切换会重新下发 `t`）。

浏览器与宿主之间走 Connection 的通用 RPC 通道 `/dsh-c-cleanup`（`authority: loopback`，只接受本机调用），端点包括 `state` / `scan` / `preview` / `execute` / `migrate` / `progress` / `cancel` / `history` 等。任务表是宿主内存态，宿主重启即清空。

**落地条件**（平台机制决定，不是本插件的选择）：

| 改动 | 需要做什么 |
| --- | --- |
| 新增/删除插件包、改 `dsh.client` 字段 | **重启 `dsh web`**（包元数据判定被宿主永久缓存） |
| 只改 `client/client.js` 内容 | **刷新页面**即可（bundle 带 `no-cache`；本 profile 的 HMR 是关闭的） |

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
    historyPath: 'C:\Users\<你>\.dsh\windows-c-cleanup\history.jsonl'
    defaultReportFormat: markdown
    schedule:
      enabled: true          # 默认 false：不主动占用你的磁盘 I/O
      intervalHours: 24
      alertFreePercent: 10
      initialDelayMinutes: 1
      scope: hotspots
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
| `historyPath` | `<DSH_HOME>\windows-c-cleanup\history.jsonl` | 扫描历史（趋势对比数据源）；故意放在不会被清理的位置 |
| `defaultReportFormat` | `markdown` | 默认报告格式：`markdown` / `json` / `both` |
| `schedule.enabled` | `false` | 是否启用定时扫描（**默认关闭**，需你显式同意） |
| `schedule.intervalHours` | `24` | 定时扫描间隔（小时） |
| `schedule.alertFreePercent` | `10` | 剩余空间占比低于该值时写告警 |
| `schedule.initialDelayMinutes` | `1` | 首次执行延迟，避开宿主启动抢 I/O |
| `schedule.scope` | `hotspots` | 定时扫描范围（比 `full` 快且省 I/O） |
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
- [x] M4 打磨：扫描历史与趋势对比、JSON 报告、定时扫描与告警（cleanmgr/DISM 提权已在 M2 落地）
- [x] M5 Client GUI 面板：`conversation.view` 五级卡片、勾选、两步执行（预演 → 确认）、逐项进度与取消、迁移预览
- [ ] M6 发布：npm + 社区插件市场（GitHub 已完成）

## 已知限制（M1 + M2 + M3 + M4 + M5）

- **执行需要明确授权**：`apply` / `trash` 默认预演；真正的执行路径必须先跑扫描并把报告交给用户确认。`migrate` / `rollback` 仍是 `not-implemented`（M3）。
- **管理员级清理依赖 UAC 弹窗**：DSH 的权限栈没有 UAC 原语，插件通过 `Start-Process -Verb RunAs` 触发系统弹窗（脚本落在 `%TEMP%\dsh-cc-elevated-*.ps1`）；用户不点「是」就无法清理 `Windows\Temp`、`SoftwareDistribution`、WinSxS 等，此时结果里会明确标记为「用户取消」。
- **被占用的文件删不掉**：浏览器、IDE、企业微信正在运行时其缓存文件会被锁定，结果中记为「部分删除」并给出残留量——这是 Windows 的正常行为，不是插件故障。
- **全盘 Top-N 覆盖度受 I/O 上限约束**：Node 的文件操作走 libuv 线程池（默认 4 线程），目录测量成本基本由**文件数**决定，加并发也提不上去。因此在 70 秒预算内，153 GB 已用盘的热点规则可 100% 覆盖，但全盘 Top-N 只能遍历部分目录（实测约 160 个顶层/浅层目录后截断）。
  截断时报告与工具返回值都会标记 `partial` 并说明原因，不会伪装成完整结论；需要更高覆盖率可调大 `topTreeTimeBudgetMs`（代价是等待更久）。**可执行结论来自热点规则，Top-N 只作兜底**，因此截断不影响五级清单的可用性。
- **释放量核算的两种口径**：小体量清理（数十 MB 级）时「盘符空闲净增」可能为 0（被其他进程同时写入掩盖），此时以「逐项测量合计」为准，报告里会同时给出并注明。
- **迁移耗时与被迁移体积成正比**：迁移是「复制 → 校验 → 删源 → 建联接」，数十 GB 的目录会很慢（工具超时上限 15 分钟）；被应用占用的目录会在删源阶段中止并回滚副本。
- **`app-config` 类迁移不自动改配置**：插件只搬数据（并建立目录联接保证应用仍可用）并给出建议命令；是否让应用改用新路径由用户确认后自己执行，避免静默改坏环境。
- **扫描可能被时间预算截断**：热点清单与全盘 Top-N 各有 70 秒预算（可配 `hotspotTimeBudgetMs` / `topTreeTimeBudgetMs`），超时即截断并在报告与工具输出里标注，绝不当成「扫全了」。
- **定时扫描默认关闭且不做系统级唤醒**：依赖宿主进程存活（DSH 没跑就不会扫）；需要开机级定时请用 Windows 任务计划调用 `dsh` 或本插件的 `action=scan`。
- **趋势不跨机器迁移**：历史文件是本机的，换机或删掉历史后第一次扫描没有对比基准（不会报错，只是不显示趋势）。
- 尚未提供交互式确认界面：目前由模型把报告交给用户，用户选定范围后再进入执行链路（M4 提供 GUI 卡片）。
- **面板的落地条件由平台决定**：新增/删除插件包或改 `dsh.client` 字段必须重启 `dsh web`（包元数据判定被永久缓存）；只改 bundle 内容刷新页面即可（本 profile 的 HMR 关闭）。
- **面板与工具共用同一套判断，但入口不同**：面板只能做「扫描 / 预演 / 执行 / 迁移 / 回滚」这些已在工具里实现的动作，配置类改动（如定时扫描开关、`reportDir`）仍走 `cordis.yml`，面板只显示状态、不做持久化设置。
- **面板任务表在内存里**：宿主重启后面板会显示「任务已随宿主重启消失」，正在跑的任务随之中止（已落盘的报告与台账不受影响）。

## 开发

```powershell
npm install --legacy-peer-deps   # DSH 类型包 peer 冲突，本地用 legacy 解析
npm run deps:link                # 把宿主自己的 @deepseek-ai/* 链接进 node_modules（见下方说明）
npm run typecheck                # 类型检查
npm run smoke                    # 快速自检：规则匹配 / 盘信息 / 限时测量
npm run m2                       # M2 执行层隔离用例（真实删除只发生在 %TEMP% 沙箱）
npm run m3                       # M3 迁移层隔离用例（真实迁移只发生在 %TEMP% 沙箱 + D:\dsh-cc-m3-test）
npm run m4                       # M4 历史/趋势/JSON/调度语义（假扫描，秒级；含一次真实热点扫描）
npm run m4:live                  # M4 定时扫描端到端（真扫盘，约 1 分钟；历史数字与 fs.statfs 实测对比）
npm run m5                       # M5 面板宿主侧：分级/预演=执行同一条路/真暂存区/真迁移/取消/RPC 端点（含一次真实热点扫描）
npm run m5:client                # M5 客户端 bundle 契约：重放浏览器的模块加载并真渲染一次面板（离线，秒级）
npm run m5:live                  # M5 活体验证：直接问运行中的 dsh web 要 boot manifest 与产物（含与本地构建的哈希比对）
npx tsx tests/tool-run.ts full    # 无头跑完整扫描，产出真实报告
npm run build                     # 编译到 lib/ 并打包 client/client.js（发布物）
npm run build:client              # 只重新打包客户端 bundle（改了 client/src 之后）
```

> ⚠️ 不要用 PowerShell 的 `Get-Content`/`Set-Content` 管道改写本仓库的 UTF-8 文本文件
> （默认编码会把中文写成乱码并使 `package.json` 变成非法 JSON）；请用编辑工具直接改。
>
> ⚠️ 不要跑不带 `--legacy-peer-deps` 的 `npm install`：它会按 peer 解析 prune 掉
> `@deepseek-ai/dsh-tools` / `dsh-llm` 等提供类型的包，导致 `npm run build` 报 implicit any。装完请复验 `npm run build`。
>
> ⚠️ `@deepseek-ai/dsh-tools` 一族把自己的运行时依赖声明成 **peerDependencies**，所以
> `--legacy-peer-deps` 永远不会装它们（测试会以 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-xxx'` 崩掉），
> 而普通 `npm install` 又会把它们 prune 掉。`npm run deps:link` 用目录联接把**宿主自己那份**副本挂进
> `node_modules`，于是测试跑的就是宿主真实加载的包，且与宿主版本严格一致。该命令幂等，装完依赖重跑一次即可。

## 许可

MIT
