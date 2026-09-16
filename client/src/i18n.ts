/**
 * 面板文案的双语字典。
 *
 * 平台机制（来自 dsh-client-locale 的实证）：
 *  - 语言只有 `'zh' | 'en'` 两种（`LOCALE_IDS`），住手在设置里，默认跟随浏览器；
 *  - 包通过 `ctx.locale.register(命名空间, 语言, 字典)` 登记字典；
 *  - 插槽注册时声明 `locale: 命名空间`，框架就会给组件注入 `t` seat，
 *    并在**语言切换时重新下发新的 `t`**（组件自动重渲染），tab 标题用 `() => t('tab')`
 *    这种 thunk 就能跟随语言而不必重新注册；
 *  - 命名空间不在平台的 `LocaleNamespaceMap` 合并表里，因此用**单语言非类型化重载**登记。
 *
 * 本文件同时保留了「宿主没有 locale 服务」时的退路：按浏览器语言自己选字典。
 * 字典键必须中英**严格对齐**（测试会断言键集合一致，防止漏译）。
 */

export type LocaleId = 'zh' | 'en';
export type Translate = (key: string, params?: Record<string, unknown>) => string;

/** 字典命名空间，同时用作插槽注册的 `locale:` 值 */
export const LOCALE_NS = 'windows-c-cleanup';

const ZH: Record<string, string> = {
  tab: '磁盘清理',
  title: '🧹 C 盘清理',
  'sub.reading': '正在读取磁盘信息…',
  'sub.drive': '{letter}: 剩余 {free} / 共 {total}（已用 {used}）',
  'chip.migrationTarget': '迁移目标 {root}（{free} 可用）',
  'chip.scheduler.off': '定时扫描：未启用',
  'chip.scheduler.running': '定时扫描：正在扫描…',
  'chip.scheduler.on': '定时扫描：每 {hours} 小时一次，低于 {percent}% 告警',
  'trend.line': '📈 与上次扫描（{hours} 小时前）：剩余空间 {sign}{delta} ｜ 长回来 {grown} 项 ｜ 被释放 {shrunk} 项',
  'trend.grownRow': '＋{delta}　{path}',

  'scope.label': '范围',
  'scope.hotspots': '热点清单（快）',
  'scope.full': '热点 + 全盘 Top-N（慢）',
  'action.scan': '扫描 C 盘',
  'action.rescan': '重新扫描',
  'action.clear': '清空选择',
  'selected': '已选 {count} 项',
  'mode.label': '删除方式',
  'mode.trash': '移到暂存区（可恢复）',
  'mode.permanent': '永久删除（不可恢复）',
  'action.preview': '预演',
  'action.confirm': '确认执行',
  'action.confirmBytes': '确认执行（{size}）',
  'confirm.hintStale': '勾选或模式已变化，请先重新预演',
  'confirm.hintReady': '按预演过的动作执行',

  'help.preview.title': '预演（dry run）是做什么的？',
  'help.preview.toggle': '预演说明',
  'help.preview.body':
    '预演会把真执行的流程完整跑一遍，只在最后一步不做破坏性动作——它就是同一个执行器，只是 dryRun 打开：\n' +
    '· 真跑安全闸：保护名单、越界、不存在、可覆盖性都按真执行同一套判定，被拒的项连理由一起列出；\n' +
    '· 真算提权：需要管理员权限的项会标出来并计入「提权任务数」，但不会弹 UAC；\n' +
    '· 真测体积：优先用扫描结果，没有就现场轻量测量（每项 8 秒预算）——会读盘，但只读；\n' +
    '· 每项给出动作与理由：「将移动到暂存区 …」或「将永久删除（…）」，并汇总计划释放量。\n' +
    '它绝不会：删文件、移动、建暂存区目录、建目录联接、提权、写台账、写执行报告。\n' +
    '为什么值得先预演：面板的预演与真执行是同一条代码路径，所以清单里的每一项、每个理由、每个体积，' +
    '就是点「确认执行」后会发生的事；勾选或删除方式一变，预演立即作废，必须重跑。',
  'help.preview.limits':
    '三个诚实的边界：① 预演体积≈但不必然等于真释放量（真跑取盘符空闲净增，可能被其他进程写盘掩盖，报告里两个口径都给）；' +
    '② 预演不检测文件占用，这类问题只有真删时才暴露；③ 越早执行越准，期间别的进程可能在写盘。',

  'busy.scan': '正在扫描 C 盘（热点清单，约 1 分钟）…',
  'busy.preview': '正在预演（不删除任何文件）…',
  'busy.execute': '正在执行，请勿关闭页面…',
  'busy.executeDry': '正在执行（dryRun 预演）…',
  'busy.migratePreview': '正在计算迁移方案（不复制数据）…',
  'busy.migrate': '正在迁移（先复制、校验，再删源、建联接）…',
  'busy.migrateDry': '正在预演迁移…',
  'notice.scanDone': '扫描完成：可释放潜力 🟢 {safe} ｜ 🟡 {caution} ｜ 🟠 {migrate}',
  'notice.previewDone': '预演完成：计划处理 {size}',
  'notice.previewElevation': '，其中 {count} 项需要管理员权限',
  'notice.migratePreviewDone': '迁移预览：{count} 项，共 {size} → {root}',
  'notice.cancelRequested': '已请求取消，正在安全中止…',
  'notice.cancelFailed': '取消失败',
  'error.pickFirst': '请先勾选要处理的项',
  'error.jobGone': '任务已随宿主重启消失',
  'warn.partial': '⚠️ 扫描被时间预算截断，列表可能不完整',
  'warn.partialReasons': '：{reasons}',

  'tier.safe.title': '可安全删除',
  'tier.safe.hint': '缓存/日志/临时文件，删了会自动重建',
  'tier.caution.title': '谨慎删除',
  'tier.caution.hint': '系统或应用的缓存目录，建议确认后处理',
  'tier.migrate.title': '可迁移',
  'tier.migrate.hint': '搬到其他盘并在原位置留目录联接，应用无感',
  'tier.protected.title': '保护名单',
  'tier.protected.hint': '绝不自动删除，面板里也不可勾选',
  'card.count': '{count} 项 ｜ {size}',
  'card.chosen': ' ｜ 已选 {count}',
  'card.expand': '展开',
  'card.collapse': '收起',
  'card.selectTier': '全选本层',
  'card.clearTier': '取消本层',
  'card.checkHint': '勾选后参与预演/执行',
  'card.protectedHint': '保护名单：不可勾选',
  'card.migratePreview': '迁移预览',
  'card.empty': '（本层为空）',
  'card.truncated': '（列表过长，仅显示前 {max} 项）',

  'longterm.summary': '🔵 长期防护措施（{count} 项，改配置/改习惯比反复清理更省事）',

  'preview.title': '🔍 预演结果 —— 计划处理 {size}（{count} 项）',
  'preview.trashPath': '，暂存区 {path}',
  'preview.more': '（仅显示前 {shown} 项，完整清单见执行报告）',
  'preview.refused': '已拒绝 {count} 项（保护名单/越界/不存在，宿主的硬约束，面板无法绕过）：',
  'preview.permanentWarn': '永久删除不可恢复。若确认，请先勾选下面的确认框，再点「确认执行」。',
  'preview.permanentConfirm': '我已确认这些内容不再需要',
  'preview.dryAgain': '再跑一次 dryRun',

  'migration.title': '🚚 迁移预览 → {root}（目标盘可用 {free}）',
  'migration.spaceOk': '空间够',
  'migration.spaceLow': '空间不足',
  'migration.spaceUnknown': '空间未知',
  'migration.row': '{size} ｜ {count} 个文件 ｜ 源删净后原位置留目录联接',
  'migration.configChange': '迁移后需要你自己改的配置（插件不代改）：{list}',
  'migration.confirm': '确认迁移（{size}）',
  'migration.dry': '只看 dryRun',
  'migration.close': '关闭',

  'job.titleDry': '🧪 dryRun 任务',
  'job.titleReal': '⚙️ 执行任务',
  'job.report': ' ｜ 报告：{path}',
  'job.progress': '{done}/{total} 项 ｜ {message}',
  'job.totalsMeasured': ' ｜ 逐项合计 {measured}',
  'job.totalsDrive': ' ｜ 盘符净增 {freed}',
  'job.cancel': '取消任务',
  'job.collapse': '收起',

  'status.running': '运行中',
  'status.done': '已完成',
  'status.failed': '失败',
  'status.canceled': '已取消',

  'action.planned': '计划执行',
  'action.trashed': '已入暂存区',
  'action.deleted': '已删除',
  'action.partial': '部分完成',
  'action.failed': '失败',
  'action.refused': '已拒绝',
  'action.needsElevation': '等待提权',
  'action.elevationCanceled': '提权被取消',
  'action.migrated': '已迁移',
  'action.rolledBack': '已回滚',
  'action.destinationExists': '目标已存在',
  'action.insufficientSpace': '目标盘空间不足',
  'action.sourceBusy': '源被占用',
  'action.verifyFailed': '校验失败',
  'action.unknown': '{action}',

  'empty.noScan': '还没有扫描结果。点「扫描 C 盘」开始 —— 扫描只读，不会删除任何文件。',
  'empty.lastScan': '上次扫描：{at}（{count} 项，可释放 🟢 {safe} / 🟡 {caution}）',
  'footer.paths': '历史：{history}｜报告：{report}（任务表在宿主内存里，宿主重启即清空）',
};

const EN: Record<string, string> = {
  tab: 'Disk cleanup',
  title: '🧹 C: drive cleanup',
  'sub.reading': 'Reading drive information…',
  'sub.drive': '{letter}: {free} free of {total} ({used} used)',
  'chip.migrationTarget': 'Migration target {root} ({free} free)',
  'chip.scheduler.off': 'Scheduled scan: disabled',
  'chip.scheduler.running': 'Scheduled scan: running…',
  'chip.scheduler.on': 'Scheduled scan: every {hours} h, alert below {percent}%',
  'trend.line': '📈 Since the previous scan ({hours} h ago): free space {sign}{delta} ｜ grew back {grown} ｜ reclaimed {shrunk}',
  'trend.grownRow': '+{delta}　{path}',

  'scope.label': 'Scope',
  'scope.hotspots': 'Hotspot list (fast)',
  'scope.full': 'Hotspots + whole-drive Top-N (slow)',
  'action.scan': 'Scan the C: drive',
  'action.rescan': 'Scan again',
  'action.clear': 'Clear selection',
  'selected': '{count} selected',
  'mode.label': 'Deletion mode',
  'mode.trash': 'Move to staging area (recoverable)',
  'mode.permanent': 'Delete permanently (unrecoverable)',
  'action.preview': 'Preview',
  'action.confirm': 'Confirm and run',
  'action.confirmBytes': 'Confirm and run ({size})',
  'confirm.hintStale': 'Selection or mode changed — run the preview again first',
  'confirm.hintReady': 'Run exactly the actions you previewed',

  'help.preview.title': 'What does "preview" (dry run) do?',
  'help.preview.toggle': 'About the preview',
  'help.preview.body':
    'The preview runs the entire execution pipeline and stops only at the destructive step — it is the same executor with dryRun enabled:\n' +
    '· The safety gate really runs: protected list, out-of-scope paths, missing paths and overridability are judged exactly as in a real run, and refusals are listed with their reasons;\n' +
    '· Elevation is really computed: entries needing administrator rights are flagged and counted, but no UAC prompt appears;\n' +
    '· Sizes are really measured: the scan result is reused when available, otherwise a light on-the-fly measurement runs (8 s budget per item) — it reads the disk, nothing more;\n' +
    '· Every entry gets an action and a reason ("will move to the staging area …" / "will be deleted permanently (…)"), plus the total planned size.\n' +
    'It never: deletes files, moves anything, creates the staging area, creates junctions, elevates, writes the ledger or writes an execution report.\n' +
    'Why bother: the panel previews and executes through the same code path, so what you see — every entry, reason and size — is exactly what "Confirm and run" will do. Changing the selection or the mode invalidates the preview and you must run it again.',
  'help.preview.limits':
    'Three honest limits: (1) the previewed size is close to but not necessarily equal to the space actually reclaimed (a real run measures the drive\'s free-space delta, which other processes can mask — the report gives both numbers); ' +
    '(2) the preview does not detect locked files, which only surface during a real deletion; (3) the sooner you run after previewing, the more accurate it is, since other processes may be writing meanwhile.',

  'busy.scan': 'Scanning the C: drive (hotspot list, about a minute)…',
  'busy.preview': 'Running the preview (nothing is deleted)…',
  'busy.execute': 'Running, please keep this page open…',
  'busy.executeDry': 'Running a dryRun…',
  'busy.migratePreview': 'Computing the migration plan (no data is copied)…',
  'busy.migrate': 'Migrating (copy, verify, remove the source, then junction)…',
  'busy.migrateDry': 'Rehearsing the migration…',
  'notice.scanDone': 'Scan complete — reclaimable: 🟢 {safe} ｜ 🟡 {caution} ｜ 🟠 {migrate}',
  'notice.previewDone': 'Preview complete: {size} planned',
  'notice.previewElevation': ', {count} of them need administrator rights',
  'notice.migratePreviewDone': 'Migration preview: {count} items, {size} in total → {root}',
  'notice.cancelRequested': 'Cancellation requested, stopping safely…',
  'notice.cancelFailed': 'Cancellation failed',
  'error.pickFirst': 'Select at least one item first',
  'error.jobGone': 'The job vanished with the host restart',
  'warn.partial': '⚠️ The scan hit its time budget, so the list may be incomplete',
  'warn.partialReasons': ': {reasons}',

  'tier.safe.title': 'Safe to delete',
  'tier.safe.hint': 'Caches, logs and temp files; they rebuild themselves',
  'tier.caution.title': 'Delete with care',
  'tier.caution.hint': 'System or application cache directories — review before acting',
  'tier.migrate.title': 'Better migrated',
  'tier.migrate.hint': 'Moved to another drive with a junction left behind; apps notice nothing',
  'tier.protected.title': 'Protected list',
  'tier.protected.hint': 'Never deleted automatically, and not selectable here either',
  'card.count': '{count} items ｜ {size}',
  'card.chosen': ' ｜ {count} selected',
  'card.expand': 'Expand',
  'card.collapse': 'Collapse',
  'card.selectTier': 'Select all',
  'card.clearTier': 'Clear tier',
  'card.checkHint': 'Selected items take part in the preview and the run',
  'card.protectedHint': 'Protected list: cannot be selected',
  'card.migratePreview': 'Preview migration',
  'card.empty': '(nothing in this tier)',
  'card.truncated': '(list too long, showing the first {max} items)',

  'longterm.summary': '🔵 Long-term protections ({count} — changing settings or habits beats repeated cleanup)',

  'preview.title': '🔍 Preview — {size} planned ({count} items)',
  'preview.trashPath': ', staging area {path}',
  'preview.more': '(showing the first {shown} items; the full list is in the execution report)',
  'preview.refused': '{count} entries refused (protected list / out of scope / missing — the host\'s hard constraints, which this panel cannot bypass):',
  'preview.permanentWarn': 'Permanent deletion cannot be undone. To proceed, tick the confirmation box below, then click "Confirm and run".',
  'preview.permanentConfirm': 'I confirm these items are no longer needed',
  'preview.dryAgain': 'Run the dryRun again',

  'migration.title': '🚚 Migration preview → {root} ({free} free on the target)',
  'migration.spaceOk': 'Room available',
  'migration.spaceLow': 'Not enough room',
  'migration.spaceUnknown': 'Room unknown',
  'migration.row': '{size} ｜ {count} files ｜ a junction stays behind once the source is removed',
  'migration.configChange': 'Configuration you must change yourself afterwards (the plugin never edits it): {list}',
  'migration.confirm': 'Confirm migration ({size})',
  'migration.dry': 'dryRun only',
  'migration.close': 'Close',

  'job.titleDry': '🧪 dryRun job',
  'job.titleReal': '⚙️ Execution job',
  'job.report': ' ｜ report: {path}',
  'job.progress': '{done}/{total} items ｜ {message}',
  'job.totalsMeasured': ' ｜ measured per item: {measured}',
  'job.totalsDrive': ' ｜ drive free-space gain: {freed}',
  'job.cancel': 'Cancel job',
  'job.collapse': 'Collapse',

  'status.running': 'running',
  'status.done': 'done',
  'status.failed': 'failed',
  'status.canceled': 'canceled',

  'action.planned': 'planned',
  'action.trashed': 'in staging area',
  'action.deleted': 'deleted',
  'action.partial': 'partially done',
  'action.failed': 'failed',
  'action.refused': 'refused',
  'action.needsElevation': 'awaiting elevation',
  'action.elevationCanceled': 'elevation canceled',
  'action.migrated': 'migrated',
  'action.rolledBack': 'rolled back',
  'action.destinationExists': 'destination exists',
  'action.insufficientSpace': 'not enough room on target',
  'action.sourceBusy': 'source busy',
  'action.verifyFailed': 'verification failed',
  'action.unknown': '{action}',

  'empty.noScan': 'No scan result yet. Click "Scan the C: drive" to start — scanning is read-only and deletes nothing.',
  'empty.lastScan': 'Previous scan: {at} ({count} items, reclaimable 🟢 {safe} / 🟡 {caution})',
  'footer.paths': 'History: {history}｜reports: {report} (jobs live in host memory and are cleared when the host restarts)',
};

/** 全量字典，键集合必须严格对齐（有测试守着） */
export const DICTS: Record<LocaleId, Record<string, string>> = { zh: ZH, en: EN };

/** 把 `{name}` 占位符替换成参数；缺参数时保留占位符本身（比静默吞掉更容易发现） */
export function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** 造一个只读某个语言的翻译函数；字典缺键时回退到中文，再缺就原样返回键名（失败要响） */
export function makeTranslate(locale: LocaleId): Translate {
  const primary = DICTS[locale] ?? ZH;
  return (key, params) => interpolate(primary[key] ?? ZH[key] ?? key, params);
}

/** 宿主没提供 locale 服务时的退路：按页面/浏览器语言猜（拿不到就当中文） */
export function detectLocale(): LocaleId {
  let fromHtml = '';
  let fromNavigator = '';
  try {
    fromHtml = typeof document === 'undefined' ? '' : (document.documentElement?.lang ?? '');
  } catch {
    fromHtml = '';
  }
  try {
    fromNavigator = typeof navigator === 'undefined' ? '' : (navigator.language ?? '');
  } catch {
    fromNavigator = '';
  }
  const raw = (fromHtml || fromNavigator).toLowerCase();
  return raw.startsWith('zh') ? 'zh' : raw === '' ? 'zh' : 'en';
}

/** 语言 id 归一化：只认平台登记的 zh / en，其余按英文处理 */
export function normalizeLocale(input: unknown): LocaleId {
  return input === 'en' ? 'en' : input === 'zh' ? 'zh' : detectLocale();
}
