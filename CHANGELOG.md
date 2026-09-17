# 更新日志

## [0.5.1] — 面板改为中英双语 + 工具栏分组与预演说明

### 发布

- **首发 npm：`dsh-windows-c-cleanup@0.5.1`**（2026-09-17）—— 这是本插件的**第一个 npm 发行版**（此前只有 GitHub 仓库与本地 `link:` 安装）。安装：

  ```powershell
  dsh plugin --profile web add dsh-windows-c-cleanup
  ```

- 仓库：<https://github.com/runcat-tommy/dsh-windows-c-cleanup>（带 `dsh-plugin` topic，市场按此自动收录）
- 发布前的元数据补齐：`repository` / `homepage` / `bugs`（首发前 `repository` 是空的）、`keywords` 扩到 10 个并与 GitHub topics 对齐、新增 `dsh.marketplace` 声明（`profiles: ["web"]` / `requiresBuildApproval: false` / `requiresRestart: true` / `manualSteps: false`：npm 包里已带构建产物、装完需重启、无需人工步骤；从 GitHub 源安装因为仓库带 `prepare` 脚本仍会要求构建审批，那是市场自己的规则）。
- 补 `screenshots.json`（两张实测图）：市场详情页的预览图**先读仓库里这个文件**，没有它才退化成"从 README 抽图"（过滤极严，实测全市场只有 18% 的条目有预览图）。
- npm 页面显示**英文** `README.en.md`（npm 只渲染 `README.md`），发布时临时覆盖、发布后立即 `git checkout` 恢复中文原文。
- 新增 `npm run market:check`（发布体检，21 项）：把"能被市场自动收录"的硬门槛钉成测试 —— 包名/版本合法、repository 三件套齐全且同源、patch 是仓库内安全相对路径且解析为 YAML 数组、插入的 loader entry `name` 等于包名、`dsh.client.platform === 'web'` 且 `exports["./client"]` 指向存在的文件、tarball 白名单覆盖全部运行必需项、没有 `preinstall`/`install`/`postinstall`（自动安装前提）、`dsh.marketplace` 四件套取值合理、`screenshots.json` 1–8 张且都是仓库内非空非 svg 的图、双语 README 都给出 npm 与 `github:` 两条安装命令并出现本仓库 owner/repo。这些项**静默失效**（代码测试全绿但市场不再收录），所以值得单独钉住。

### 新增

- **中英双语界面**（跟随 DSH 的语言设置，无手动开关）：
  - 客户端字典 `client/src/i18n.ts`，中英各 120 条；插槽注册声明 `locale: 'windows-c-cleanup'` 让框架注入 `t` 席位，tab 标题改成**函数式 label**，语言一换标题跟着换、无需重新注册；
  - **宿主侧文案也双语**：面板每次 RPC 都带 `locale`，规则说明（`src/rules/default-rules.en.json`，按 rule id 与中文严格对齐）、安全闸 12 条拒绝理由、执行器逐项计划动作、迁移配置提示、调度状态全部按语言返回；
  - **默认中文**：模型工具那条路不传 `locale`，输出与历史逐字一致；英文缺项一律回退中文原文，绝不显示空洞；
  - 语言切换只需刷新页面（不需要重启 `dsh web`）。
- **「预演」旁边的 `?` 说明按钮**：就地解释预演是什么，文案直白（第一句就是「先干跑一遍，什么都不删」）。

### 修正

- **扫描途中切到对话页再切回来，"正在扫描 C 盘"的 loading 与扫完的结果都丢了**（用户实测）。根因：扫描跑在**宿主**侧（结果也一直缓存在宿主里），但"正在扫"这件事只存在于面板组件的本地 state —— 切走会卸载组件、本地 state 随之清零，而新挂载的实例既不知道有扫描在跑，也没人把结果接回来，界面就停在"还没扫描"，用户只能重新点一次扫描（白扫一遍）。
  现在**以宿主为权威**：`panelState()` 增加 `scan = {running, scope, startedAt}`，面板挂载（以及切语言）时据此重新显示 loading，并每 1.2 秒问一次；一旦不在扫了就用 `scan-view` 把宿主缓存的结果接回来，并补一条「扫描完成」提示。宿主同时保证**同一时刻只扫一次**：面板回来后用户又点「扫描」会接上还在跑的那一次（省一次全盘遍历，也不会让两份结果互相覆盖）。老宿主（还没重启 `dsh web`）缺 `scan` 字段时面板退化成原样行为、不报错（测试 11.6）。
- **同一类问题一并修掉：正在跑的清理/迁移任务也会因为切视图而"看不见"**。`panelState()` 增加 `runningJobIds`；面板挂载时若有任务在跑，就拿 jobId 用既有的 `progress` 接上轮询，「执行进度」的进度条与逐项明细继续走（测试 11.5、12.1–12.6）。
- **切界面语言后，缓存里的宿主文案不跟着变**（用户实拍英文界面暴露：框架部分是英文，规则说明与截断告警仍是中文）。根因是那些字符串由宿主在**生成那一刻**按当时语言渲染好、面板又把结果缓存在 state 里，切语言不会重取。三处一起改：
  - 宿主新增 `scan-view` 端点：用**缓存里那次扫描**按目标语言重新出视图，不碰盘、不测量（实测 0ms，同一 planId 与时间戳，只是语言不同）；面板在语言变化时自动调它，并顺带用同一份勾选/模式重跑预演、按同样路径重跑迁移预览；
  - 扫描器的截断原因改成**结构化事实 + 按语言渲染**（`stats.partialFacts` + `partialReasonText()`），三条原因都有英文版，数字与总数不丢；
  - 面板提示句改成存**键 + 参数**（`Notice`），渲染时才取当前 `t`：「扫描完成…」「预演完成…」这类提示不再冻结在生成时的语言（类型上堵死传字符串的写法）。
- **「确认执行」不可点时，把原因写在按钮旁边**。用户实测反馈「勾了项目却点不动确认执行」：门禁本身没错（必须先预演），但原因只写在 `title` 里，而**禁用按钮在多数浏览器里收不到鼠标事件、tooltip 根本弹不出来**；而且旧逻辑把「一个都没勾」也提示成「勾选或模式已变化，请先重新预演」，答非所问。现在把门禁抽成纯函数 `confirmGate()`（`busy` / `no-selection` / `need-preview` / `stale-preview` / `ready` 五态），`disabled` 与可见提示文案由它统一驱动：没勾选→「先在下面勾选要清理的项目」，勾了没预演→「还要先点「预演」——看清会发生什么才能执行」，预演后改过勾选/模式→「勾选或删除方式变了，请重新点「预演」」，就绪→「按预演过的动作执行」（测试 8.1–8.8）。
- **执行入口收敛成一个**（用户随后要求把操作区的「确认执行」整个移除）：工具栏不再挂执行按钮，唯一的「确认执行」只在「预演结果」里，于是"没预演就执行"在界面上**根本没有入口**——这比"按钮灰着但看得见"更彻底，也顺带消灭了这整类困惑。门禁随之简化成 `runGate()`（`busy` / `need-confirm` / `ready`），可见原因照旧写在按钮旁边：永久删除未勾确认框→「永久删除要先勾选上面的确认框」，就绪→「按预演过的动作执行」（测试 8.1–8.9）。

### 移除

- **「历史对比」模块从界面移除**（用户要求）：与上次扫描的时间差、长回来的目录那一块不再显示。宿主的 `state.trend` 字段与历史台账**照旧保留**（JSON 报告里的「📈 历史趋势」区块不受影响），需要恢复时接回面板即可。

### 变更（续）

- **「预演结果」上移到「操作区」正下方**（用户要求）：点完「预演」，逐项结果与它自己的「确认执行」按钮就在刚点的那排按钮下面，不用翻过四列候选卡片；没有预演结果时这个位置留给「状态与提示」，扫描完的提示同样紧贴操作区。为此把预演区块抽成 `previewSection` 变量，位置在 render 里只写一处、测试 10.7 钉住顺序（操作区 → 预演结果 → 状态与提示）。
- 模块名标签随之上移到操作区之后：概览 / **操作区（扫描 → 选择 → 预演）** / **预演结果** / 状态与提示 / 清理候选 / 长期防护 / 执行进度 / 迁移预览 / 记录与产物（9 个）。

### 变更

- **工具栏按「同组相邻」重排成三组**：①「范围」+「扫描 C 盘」 → ②「已选 N 项」+「清空选择」 → ③「删除方式」+「预演」+「?」（执行按钮不在这里，见上）。
- **三个动作按钮的可辨识度**：「扫描 C 盘」「清空选择」「预演」在**可用**时改成品牌色加粗描边 + 底色淡染 + 投影 + 加粗字（用 `color-mix` 与主题 token 混色，深色主题同样成立）。所有显眼样式都限定 `:not(:disabled)`，**禁用态保持原来的浅底灰边半透明**——不能点的按钮绝不能画得像能点（测试 7.1–7.3、7.8 守着）。
- **问号说明 icon 更显眼**：19px 细边空心圈 → 24px 圆形按钮（2px 品牌色描边、底色淡染、15px 加粗问号、悬停放大）。
- **说明文案压缩成大白话**：正文由「四条技术描述 + 绝不做清单 + 为什么值得」改成三条要点（真的检查能不能删 / 真的算权限与空间 / 每项写明会发生什么），两点注意保留但说人话；中文 141 字、英文 452 字符（测试 7.5–7.7 卡住字数与条数，防止以后再写长）。
- **面板每个区块都挂上「功能区名」标签**（新）：概览 / 操作区（扫描 → 选择 → 预演）/ 预演结果 / 状态与提示 / 清理候选（🟢/🟡/🟠/🔴）/ 长期防护 / 执行进度 / 迁移预览 / 记录与产物 —— 用户可以直接指着名字说事，README 双语各有一张「功能区对照表」，名字与界面由测试 10.1–10.6 对齐（含"文档里必须列全"这条）。标签做成 11px 圆角小 pill + `data-module` 属性，是标签不是大标题，不抢内容视线；三个动态区块（预演/进度/迁移）原本只有一句动态标题，现在稳定名字在前、动态内容在后。
- **组间流向箭头**：「扫描」按钮后与「清空选择」按钮后各加一个向右箭头 `→`，标明「先扫描 → 再选择 → 最后预演」。箭头左右各留 12px（叠上组内 6px gap，留白明显），`aria-hidden` + `pointer-events:none`：纯装饰，读屏跳过、不抢点击（测试 5.16、5.17、7.9）。
- **`panelState.scheduler` 改成结构化字段**（`{enabled, running, intervalHours, alertFreePercent}`）：宿主不再往界面吐中文句子，文案由面板按语言组织。
- **「再跑一次 dryRun」改叫「再预演一次」/「Preview again (dry run)」**：原来的文案把代码里的驼峰标识符 `dryRun` 直接印在按钮上了（英文界面显示成 `Run the dryRun again`，视觉上像断成 "Run the dry / Run again" 两个词），现在用界面自己的词「预演」。
- **截图更新为最新界面**（`assets/preview-zh.jpg` / `assets/preview-en.jpg`，1920×953）：中文图是扫描完成后的五级候选；英文图里能看到「预演结果」紧跟「操作区」、唯一执行按钮「Confirm and run」以及它旁边那句可见的禁用原因。
- **补上 `screenshots.json`**（`["assets/preview-zh.jpg", "assets/preview-en.jpg"]`）：市场详情页的预览图**先读仓库里这个文件**，没有它才会退化成"从 README 抽图"（只认 4 个 GitHub 图床、丢弃 svg、还要过语义打分，实测全市场只有 18% 的条目有预览）。这个文件不必进 npm 包，但必须提交进仓库。

### 测试

- `npm run m5` 新增第 11 节（5 项）：截断理由按语言渲染且数字不丢、三条原因都有英文、`scan-view` 用缓存出视图（同一 planId/时间戳，实测 0ms）、重渲染后规则说明无中文、分类结果不变。
- `npm run m5` 新增第 12 节（6 项）：空闲时如实报告"没在扫"、`runningJobIds` 与 `runningJobs` 一致且空闲为空、扫描进行中如实报告 running（带 scope 与起始时间）、并发的第二次「扫描」接上同一次（同一 planId + 只多一条历史）、`scan-view` 接上的正是刚扫完那次 —— 这些就是"切走再回来能接上"的宿主侧保证。
- `npm run m5:client` 新增第 11 节（6 项，切视图后的状态认领）：挂载时宿主正在扫盘 → 持续问宿主状态（实测调用序列 `state,state,scan-view`：扫完才接、且是 `scan-view` 而不是重扫）、扫完即停不空转、loading 文案与完成提示都在、有任务在跑时按 jobId 接上进度、老宿主缺 `scan` 字段时只查一次不轮询（向后兼容）。
- `npm run m5:client` 新增第 8 节（9 项，执行入口唯一性与门禁）、第 9 节（6 项，语言跟随）与第 10 节（7 项，功能模块名）：唯一执行按钮的三态门禁逐一钉住、首屏整屏不出现「确认执行」、源码里只有一处 `action.confirmBytes`、永久删除那条可见原因中英齐备、提示样式是小字次要色；同一提示对象中英不同、英文无中文且参数照旧替换、附加句按语言拼接、`setNotice` 全部传「键 + 参数」、语言变化时会调 `scan-view` 重取视图；9 个模块名中英齐备且英文无中文、常驻模块标签按位置各出现一次、无数据时不空挂标题、模块顺序（操作区 → 预演结果 → 状态与提示）、README 双语必须列全模块名、标签样式是小 pill 而不是大标题。
- `npm run m5` 新增第 10 节（12 项）：英文文案覆盖率（101 条规则 + 6 条长期防护全覆盖、id 严格对齐）、英文里不得出现中文、同一 id 两种语言不同、默认语言仍是中文、缺项回退、安全闸英文拒绝理由、RPC 端点 locale 透传、本次扫描到的规则是否全部有英文版本、`%占位符%` 不得翻丢、提权口径不得翻丢。
- `npm run m5:client` 新增第 5–7 节（31 项）：中英字典键集合严格一致、英文值无中文、占位符替换、插槽声明 locale 命名空间、tab 标题是 thunk、中英两种环境各真渲染一次、无 `t` 席位时也能渲染、每次调用都带语言、工具栏三组与按钮顺序、问号按钮存在且带展开状态、两个流向箭头的位置与读屏隐藏；语言服务接入时序（等 locale 就绪再接线、切语言后同一 thunk 立刻返回英文）；按钮与 icon 可辨识度（显眼样式只在可用时生效、禁用态不变、三个按钮都挂上、箭头留白、说明文案字数与要点上限）。

## [0.5.0] — M5：Web GUI 清理面板

### 新增

- **客户端半边**：包声明 `exports["./client"]` + `dsh.client = { platform: "web" }`，`client/client.js` 由 esbuild 打成 classic script（顶层只有 `window.__ModuleLoader__.load({ id: 包名, factory })`，`id` 必须等于包名）。React 走 shell 模块表的 seed（`react` / `react/jsx-runtime` 一律 external，打进 bundle 会出现两份 React 让 hooks 失效）。
- **面板挂在 `conversation.view`**：这是 additive list 插槽（`replaceRisk: none`），所以是「对话视图环里多一个 tab」，不覆盖也不摧毁任何现有界面（`root`/`sidebar`/`conversation`/`details` 都是 single，注册即摧毁后代席位的插槽，已避开）。
  - 五级卡片（🟢/🟡/🟠/🔴 + 🔵长期防护），逐项显示路径、大小、判定理由；保护层不可勾选；
  - **两步执行**：先预演看逐项动作，才允许「确认执行」；勾选或模式一变预演即作废需重跑；永久删除还要额外勾确认框；
  - 真实进度（进度条 + 逐项状态）与「取消任务」；迁移预览展示「源 → 目标」映射、文件数、目标盘是否够；顶部显示历史趋势与「长回来的目录」。
- **宿主侧面板服务** `src/panel/service.ts`：扫描、预演、执行、迁移、回滚、进度、取消、历史、台账。**预演与真执行走同一个 `executeCleanup`（只有 dryRun 不同）**，所以 GUI 与工具两条路径不可能出现行为差异；任务表在内存里（宿主重启即清空），上限 20 条由 `disposePanelJobs()` 在卸载时清理。
- **面板私有 RPC** `src/panel/rpc.ts`：走 Connection 的通用逻辑通道 `/dsh-c-cleanup`（`authority: loopback`，只接受本机），返回严格的 `RpcResult`（业务错误折成 `{ok:false,error:{code:'internal',…}}`，绝不 throw）；`ctx.inject(['connection'])` 软等待，CLI 宿主没有该服务时只记一条日志、工具面照常可用。

### 变更

- **执行器新增 `onItem` 回调**：每有一条结果落表就回报一次（含提权改写后的补报），面板的逐项进度来自真实记账而不是解析日志文本。

### 测试

- `npm run m5`（42 项）：五级分组、保护项在预演阶段即被拒、预演与执行同路、真暂存区删除、真迁移并写台账、取消语义、每个载荷的 lossless JSON、RPC 端点表与 `RpcResult` 形状、无 `connection` 宿主下的降级。
- `npm run m5:client`（17 项，离线）：重放浏览器的模块加载（`__ModuleLoader__.load` → 物化 factory），校验注册键等于包名、只 require seed 表成员、导出 `apply`/`inject`、注册进 `conversation.view`，并用最小 React 替身真渲染一次首屏。

## [0.4.2] — 盘符拼接归一化（一类 bug 的根治）+ 报告目录字段修正

### 修正

- **盘符字符串拼接第三次咬人，这次做到根治**。宿主实测：`apply` 预演输出「系统盘 C：剩余 **0.00 GB**」。根因是执行层写成 `` const root = `${systemDrive}\\` `` —— 模板字面量里 `\\` 只表示一个反斜杠，于是拼出 **`C\`（丢了冒号）**，`fs.statfs` 抛 `ENOENT`，又被 `catch` 吞掉返回 0，报告就把「读不到」写成了「0.00 GB」。
  同一处漏冒号还让垃圾桶判断（`` `${systemDrive.toLowerCase()}\\$recycle.bin` `` → `c\$recycle.bin`）永远匹配不上真实的 `c:\$recycle.bin`，该特殊分支**静默失效**。
  这是本项目第三起同类问题（M3 是 `D::\`，这次是 `C\` ×2），所以不再逐个打补丁：新增 `src/util/drive.ts` 的 `driveRoot()` / `driveLetterOf()` / `sameDrive()` 统一算盘符，执行层、扫描层、迁移层、工具层全部改走它。
- **不再用 0 冒充「未知」**：`freeSpaceOf()` 现在归一化入参、失败重试一次并打日志；报告里空闲读不到时显示「未知（statfs 读取失败）」；工具输出在实测失败时退回扫描得到的盘符空闲，绝不出现假数字。
- **报告目录字段修正**：0.4.1 写的 `exec.agent.session.meta.cwd` 取不到值（静默退化回宿主 cwd）。真实字段是 `session.header.cwd`（dsh-session 的 `SessionHeader`），现已按它取值，并保留 `meta` 作兜底。

### 测试

- `npm run m2` 新增 2.2a：预演输出的系统盘空闲必须是真实数字（再犯漏冒号会当场红）。
- `npm run m4` 新增 10.1–10.5：`C` / `C:` / `c:\` / `C:\` / 含空格 / 裸字母全部归一成 `X:\`，且归一化后 `freeSpaceOf` 能读到 > 0 的真实空闲；9.2a 覆盖 `session.meta.cwd` 兜底。

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
