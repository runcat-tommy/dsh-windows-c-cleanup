/**
 * M5 清理面板（浏览器侧）。
 *
 * 这个组件**不做任何业务判断**：分级、安全闸、测量、释放量核算全都在宿主侧既有模块里。
 * 它只做四件事：渲染、收集勾选、按「预演 → 确认 → 执行」两步发起 RPC、轮询进度。
 * 面板里唯一的安全规则是"提前告知"（保护层不可勾选、永久删除要二次确认），
 * 真正的防线在宿主侧 guardTargets —— UI 不是唯一防线。
 *
 * 文案全部走 `t`（平台在插槽声明 `locale:` 后注入的翻译 seat）：
 * 语言切换时框架会下发新的 `t`，组件随之重渲染，不需要自己订阅 locale 变化。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  PanelApi,
  type JobView,
  type MigratePreviewView,
  type PanelGroup,
  type PanelGroupItem,
  type PanelStateView,
  type PreviewView,
  type ScanView,
  type TrendView,
} from './api.js';
import { detectLocale, makeTranslate, type Translate } from './i18n.js';

type TierKey = 'safe' | 'caution' | 'migrate' | 'protected';

/**
 * 面板里的**功能模块名**（0.5.1 补）。
 *
 * 每个区块左上角都挂一个固定名字的标签，用户可以直接指着说「预演结果那块」，
 * 不用描述位置。名字同时写进 README 的「功能区对照表」，两边由测试对齐（10.1–10.4）。
 */
export const MODULES = [
  'overview',
  'trend',
  'toolbar',
  'status',
  'candidates',
  'longterm',
  'preview',
  'progress',
  'migration',
  'artifacts',
] as const;
export type ModuleKey = (typeof MODULES)[number];

function ModuleTitle({ id, extra, t }: { id: ModuleKey; extra?: string; t: Translate }): JSX.Element {
  return (
    <div className="wcc_module" data-module={id}>
      <span className="wcc_module_name">{t(`module.${id}`)}</span>
      {extra === undefined || extra === '' ? null : <span className="wcc_module_extra">{extra}</span>}
    </div>
  );
}

/**
 * 「确认执行」的五个门禁状态。
 *
 * `no-selection` / `need-preview` / `stale-preview` 三种都不可点，但**原因不同**，
 * 所以要分开说：以前一律提示"勾选或模式已变化"，用户勾了项目却看到"请重新预演"，无法理解。
 */
export type ConfirmGate = 'busy' | 'no-selection' | 'need-preview' | 'stale-preview' | 'ready';

/**
 * 一条提示句：**只存键与参数**，渲染时才用当前语言的 `t` 取文案。
 * 存渲染结果会让文案冻结在生成它的那个语言上（切语言后仍是旧语言）。
 */
export interface Notice {
  key: string;
  params?: Record<string, string | number>;
  /** 附加键：有值时拼在后面（例如预演提示后面追加"需要 N 项管理员权限"） */
  extraKey?: string;
  extraParams?: Record<string, string | number>;
}

export function noticeText(notice: Notice | undefined, t: Translate): string {
  if (notice === undefined) return '';
  const head = t(notice.key, notice.params);
  if (notice.extraKey === undefined) return head;
  return head + t(notice.extraKey, notice.extraParams);
}

export function confirmGate(input: {
  selectedCount: number;
  previewed: boolean;
  previewFresh: boolean;
  busy: boolean;
}): ConfirmGate {
  if (input.busy) return 'busy';
  if (input.selectedCount === 0) return 'no-selection';
  if (!input.previewed) return 'need-preview';
  if (!input.previewFresh) return 'stale-preview';
  return 'ready';
}

const TIERS: Array<{ key: TierKey; icon: string }> = [
  { key: 'safe', icon: '🟢' },
  { key: 'caution', icon: '🟡' },
  { key: 'migrate', icon: '🟠' },
  { key: 'protected', icon: '🔴' },
];

/** 宿主动作码 → 字典键（对不上就原样显示动作码，方便发现新动作） */
const ACTION_KEY: Record<string, string> = {
  planned: 'action.planned',
  trashed: 'action.trashed',
  deleted: 'action.deleted',
  partial: 'action.partial',
  failed: 'action.failed',
  refused: 'action.refused',
  'needs-elevation': 'action.needsElevation',
  'elevation-canceled': 'action.elevationCanceled',
  migrated: 'action.migrated',
  'rolled-back': 'action.rolledBack',
  'destination-exists': 'action.destinationExists',
  'insufficient-space': 'action.insufficientSpace',
  'source-busy': 'action.sourceBusy',
  'verify-failed': 'action.verifyFailed',
};

const STATUS_KEY: Record<string, string> = {
  running: 'status.running',
  done: 'status.done',
  failed: 'status.failed',
  canceled: 'status.canceled',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(2)} ${units[unit]}`;
}

function shortPath(target: string, max = 74): string {
  return target.length <= max ? target : `…${target.slice(target.length - max + 1)}`;
}

function percent(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function TrendLine({ trend, t }: { trend: TrendView; t: Translate }): JSX.Element {
  const sign = trend.freeDeltaBytes >= 0 ? '+' : '−';
  return (
    <div className="wcc_trend">
      {t('trend.line', {
        hours: trend.hoursAgo.toFixed(1),
        sign,
        delta: formatBytes(Math.abs(trend.freeDeltaBytes)),
        grown: trend.grown.length,
        shrunk: trend.shrunk.length,
      })}
      {trend.grown.length === 0 ? null : (
        <div className="wcc_trend_grown">
          {trend.grown.slice(0, 3).map((item) => (
            <div key={item.path} className="wcc_trend_row">
              {t('trend.grownRow', { delta: formatBytes(item.deltaBytes), path: shortPath(item.path, 60) })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TierCard(props: {
  icon: string;
  tier: TierKey;
  group: PanelGroup;
  selected: Set<string>;
  t: Translate;
  onToggle: (path: string) => void;
  onSelectTier: (tier: TierKey, select: boolean) => void;
  onMigrate: (path: string) => void;
}): JSX.Element {
  const { t, group, tier } = props;
  const [open, setOpen] = useState(tier === 'safe');
  const selectable = tier === 'safe' || tier === 'caution';
  const chosen = group.items.filter((item) => props.selected.has(item.path)).length;

  return (
    <div className={`wcc_card wcc_card_${tier}`}>
      <div className="wcc_card_head">
        <span className="wcc_card_title">
          {props.icon} {t(`tier.${tier}.title`)}
        </span>
        <span className="wcc_card_meta">
          {t('card.count', { count: group.count, size: formatBytes(group.bytes) })}
          {selectable && chosen > 0 ? t('card.chosen', { count: chosen }) : ''}
        </span>
      </div>
      <div className="wcc_card_hint">{t(`tier.${tier}.hint`)}</div>
      <div className="wcc_card_actions">
        <button type="button" className="wcc_btn_tiny" onClick={() => setOpen((value) => !value)}>
          {open ? t('card.collapse') : t('card.expand')}
        </button>
        {selectable ? (
          <button
            type="button"
            className="wcc_btn_tiny"
            onClick={() => props.onSelectTier(tier, chosen < group.items.length)}
          >
            {chosen < group.items.length ? t('card.selectTier') : t('card.clearTier')}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="wcc_list">
          {group.items.length === 0 ? <div className="wcc_empty">{t('card.empty')}</div> : null}
          {group.items.map((item: PanelGroupItem) => (
            <div key={item.path} className="wcc_row">
              <input
                type="checkbox"
                className="wcc_check"
                disabled={!selectable}
                checked={props.selected.has(item.path)}
                onChange={() => props.onToggle(item.path)}
                title={selectable ? t('card.checkHint') : t('card.protectedHint')}
              />
              <div className="wcc_row_main">
                <div className="wcc_row_path" title={item.path}>
                  {shortPath(item.path)}
                </div>
                <div className="wcc_row_reason">
                  {formatBytes(item.sizeBytes)} ｜ {item.reason}
                </div>
              </div>
              {item.migratable ? (
                <button type="button" className="wcc_btn_tiny" onClick={() => props.onMigrate(item.path)}>
                  {t('card.migratePreview')}
                </button>
              ) : null}
            </div>
          ))}
          {group.truncated ? <div className="wcc_empty">{t('card.truncated', { max: 200 })}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export interface PanelProps {
  api: PanelApi;
  /** 平台注入的翻译 seat（插槽注册声明了 `locale:` 才有）；缺失时按浏览器语言自己选字典 */
  t?: Translate;
}

export function CleanupPanel({ api, t: seat }: PanelProps): JSX.Element {
  const t = useMemo<Translate>(() => seat ?? makeTranslate(detectLocale()), [seat]);
  const [state, setState] = useState<PanelStateView | undefined>(undefined);
  const [scan, setScan] = useState<ScanView | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'trash' | 'permanent'>('trash');
  const [scope, setScope] = useState<'hotspots' | 'full'>('hotspots');
  const [preview, setPreview] = useState<PreviewView | undefined>(undefined);
  const [previewKey, setPreviewKey] = useState('');
  const [migration, setMigration] = useState<MigratePreviewView | undefined>(undefined);
  /** 上次做迁移预览的路径：切语言时据此原样重跑一次，让文案跟上语言 */
  const [migrationPaths, setMigrationPaths] = useState<string[] | undefined>(undefined);
  const [job, setJob] = useState<JobView | undefined>(undefined);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  /**
   * 提示句存的是**键 + 参数**，不是渲染好的字符串。
   *
   * 为什么（0.5.1 修正）：以前 `setNotice(t('notice.scanDone', …))` 把当时语言的结果冻在 state 里，
   * 用户切到英文后，扫描提示仍然是中文（实测截图里就是这样）。存键 + 参数，渲染时再取当前 `t`，
   * 语言一换提示句跟着换。类型上也彻底堵住：`Notice` 是对象，传字符串编译不过。
   */
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [confirmPermanent, setConfirmPermanent] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);

  const refreshState = useCallback(async () => {
    try {
      setState(await api.state());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api]);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  // 进度轮询：只在有任务在跑时开，跑完立刻停（1 秒一次，避免无谓流量）
  useEffect(() => {
    if (job === undefined || job.status !== 'running') {
      if (pollRef.current !== undefined) {
        window.clearInterval(pollRef.current);
        pollRef.current = undefined;
      }
      return;
    }
    if (pollRef.current !== undefined) return;
    pollRef.current = window.setInterval(() => {
      void api
        .progress(job.jobId)
        .then((snapshot) => {
          if (snapshot.job !== undefined) setJob(snapshot.job);
          if (snapshot.found === false) {
            setError(t('error.jobGone'));
            setJob(undefined);
          }
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, 1000);
    return () => {
      if (pollRef.current !== undefined) {
        window.clearInterval(pollRef.current);
        pollRef.current = undefined;
      }
    };
  }, [api, job, t]);

  const selectionKey = useMemo(() => [...selected].sort().join('\n'), [selected]);

  /**
   * 语言变了就把「宿主已经渲染好的文案」重新要一遍。
   *
   * 扫描结果、逐项理由、截断原因、预演里的每一项理由，都是宿主在**生成那一刻**按当时语言渲染好的
   * 字符串；面板把它们缓存在 state 里，切语言不会自动变。用户实测就是这个现象：切到英文后，
   * 界面框架是英文的，规则说明却还是中文。
   *
   * 这里只做三件事，都是廉价调用（不扫盘、不真删）：
   *  1. scan-view：让宿主用**缓存里那次扫描**按新语言重新出视图（毫秒级，零磁盘 I/O）；
   *  2. 若已有预演，按同一份勾选 + 模式重跑预演（dryRun，只读）；
   *  3. 若已有迁移预览，按同样的路径重跑（会重新测量，故只在用户确实在看时才做）。
   *
   * 只依赖 `t`（语言变化时才触发，首次挂载不请求）；勾选/模式/路径从最新值 ref 里取，
   * 这样切语言的同时用户还在点勾选也不会把这次刷新打断。
   */
  const latestRef = useRef({ selected, mode, migrationPaths, migrationTarget: state?.migrationTarget?.letter });
  useEffect(() => {
    latestRef.current = { selected, mode, migrationPaths, migrationTarget: state?.migrationTarget?.letter };
  });
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cached = await api.scanView();
        if (alive && cached.available && cached.view !== undefined) setScan(cached.view);
      } catch {
        /* 拿不到就让旧视图留着，不打断用户 */
      }
      const current = latestRef.current;
      if (current.selected.size > 0) {
        try {
          const result = await api.preview([...current.selected], current.mode);
          if (alive) {
            setPreview(result);
            setPreviewKey([...current.selected].sort().join('\n'));
          }
        } catch {
          /* 预演失败不弹错：语言切换不该打断正在做的事 */
        }
      }
      if (current.migrationPaths !== undefined && current.migrationPaths.length > 0) {
        try {
          const result = await api.migratePreview(current.migrationPaths, current.migrationTarget);
          if (alive) setMigration(result);
        } catch {
          /* 同上 */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, t]);

  const toggle = useCallback((path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setPreview(undefined);
  }, []);

  const selectTier = useCallback(
    (tier: TierKey, select: boolean) => {
      if (scan === undefined) return;
      if (tier !== 'safe' && tier !== 'caution') return;
      const group = scan.groups[tier];
      setSelected((current) => {
        const next = new Set(current);
        for (const item of group.items) {
          if (select) next.add(item.path);
          else next.delete(item.path);
        }
        return next;
      });
      setPreview(undefined);
    },
    [scan],
  );

  const runScan = useCallback(async () => {
    setBusy(t('busy.scan'));
    setError('');
    setNotice(undefined);
    try {
      const result = await api.scan(scope);
      setScan(result);
      setSelected(new Set());
      setPreview(undefined);
      setMigration(undefined);
      setNotice({
        key: 'notice.scanDone',
        params: {
          safe: formatBytes(result.groups.safe.bytes),
          caution: formatBytes(result.groups.caution.bytes),
          migrate: formatBytes(result.groups.migrate.bytes),
        },
      });
      await refreshState();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  }, [api, refreshState, scope, t]);

  const runPreview = useCallback(async () => {
    if (selected.size === 0) {
      setError(t('error.pickFirst'));
      return;
    }
    setBusy(t('busy.preview'));
    setError('');
    try {
      const result = await api.preview([...selected], mode);
      setPreview(result);
      setPreviewKey(selectionKey);
      setNotice({
        key: 'notice.previewDone',
        params: { size: formatBytes(result.plannedBytes) },
        ...(result.elevationCount > 0
          ? { extraKey: 'notice.previewElevation', extraParams: { count: result.elevationCount } }
          : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  }, [api, mode, selected, selectionKey, t]);

  const startExecute = useCallback(
    async (dryRun: boolean) => {
      setBusy(dryRun ? t('busy.executeDry') : t('busy.execute'));
      setError('');
      try {
        const started = await api.execute([...selected], mode, dryRun);
        const snapshot = await api.progress(started.jobId);
        if (snapshot.job !== undefined) setJob(snapshot.job);
        if (!dryRun) setPreview(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy('');
      }
    },
    [api, mode, selected, t],
  );

  const runMigratePreview = useCallback(
    async (paths: string[]) => {
      setBusy(t('busy.migratePreview'));
      setError('');
      try {
        const result = await api.migratePreview(paths, state?.migrationTarget?.letter);
        setMigration(result);
        setMigrationPaths(paths);
        setNotice({
          key: 'notice.migratePreviewDone',
          params: {
            count: result.items.length,
            size: formatBytes(result.totalBytes),
            root: result.targetRoot,
          },
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy('');
      }
    },
    [api, state, t],
  );

  const startMigrate = useCallback(
    async (dryRun: boolean) => {
      if (migration === undefined) return;
      setBusy(dryRun ? t('busy.migrateDry') : t('busy.migrate'));
      setError('');
      try {
        const started = await api.migrate(
          migration.items.map((item) => item.source),
          dryRun,
          state?.migrationTarget?.letter,
        );
        const snapshot = await api.progress(started.jobId);
        if (snapshot.job !== undefined) setJob(snapshot.job);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy('');
      }
    },
    [api, migration, state, t],
  );

  const cancelJob = useCallback(async () => {
    if (job === undefined) return;
    try {
      const result = await api.cancel(job.jobId);
      // 宿主返回的 reason 是它自己渲染的句子（无法本地化），当作参数塞进本地模板里
      setNotice(
        result.canceled
          ? { key: 'notice.cancelRequested' }
          : result.reason === undefined
            ? { key: 'notice.cancelFailed' }
            : { key: 'notice.cancelFailedWithReason', params: { reason: result.reason } },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, job, t]);

  const actionLabel = useCallback(
    (action: string): string => {
      const key = ACTION_KEY[action];
      return key === undefined ? t('action.unknown', { action }) : t(key);
    },
    [t],
  );

  const schedulerChip = (): string => {
    const scheduler = state?.scheduler;
    if (scheduler === undefined || !scheduler.enabled) return t('chip.scheduler.off');
    if (scheduler.running) return t('chip.scheduler.running');
    return t('chip.scheduler.on', { hours: scheduler.intervalHours, percent: scheduler.alertFreePercent });
  };

  /**
   * 「确认执行」的门禁：**必须先预演**，而且预演必须对得上当前的勾选与删除方式。
   * 抽成纯函数是为了让离线测试能把五个分支逐一钉住（以前这段判断重复写在 disabled 与 title 两处，
   * 结果"没勾选"时也提示"请重新预演"，误导人）。
   */
  const gate = confirmGate({
    selectedCount: selected.size,
    previewed: preview !== undefined,
    previewFresh: preview !== undefined && previewKey === selectionKey,
    busy: busy !== '',
  });
  /** 门禁原因：直接显示在按钮旁边（禁用按钮的 title 在多数浏览器里弹不出来，只写 title 等于没写） */
  const confirmHintText = (): string => {
    if (gate === 'no-selection') return t('confirm.hintNoSelection');
    if (gate === 'need-preview') return t('confirm.hintNeedPreview');
    if (gate === 'stale-preview') return t('confirm.hintStale');
    if (gate === 'ready') return t('confirm.hintReady');
    return '';
  };
  const system = state?.drives.find((drive) => drive.isSystem);
  const usedBytes = system === undefined ? 0 : Math.max(0, system.totalBytes - system.freeBytes);

  return (
    <div className="wcc_panel">
      <header className="wcc_head">
        <div>
          <ModuleTitle id="overview" t={t} />
          <div className="wcc_title">{t('title')}</div>
          <div className="wcc_sub">
            {system === undefined
              ? t('sub.reading')
              : t('sub.drive', {
                  letter: system.letter,
                  free: formatBytes(system.freeBytes),
                  total: formatBytes(system.totalBytes),
                  used: percent(usedBytes, system.totalBytes),
                })}
          </div>
        </div>
        <div className="wcc_head_right">
          {state?.migrationTarget === undefined ? null : (
            <span className="wcc_chip">
              {t('chip.migrationTarget', {
                root: state.migrationTarget.root,
                free: formatBytes(state.migrationTarget.freeBytes),
              })}
            </span>
          )}
          <span className="wcc_chip">{schedulerChip()}</span>
        </div>
      </header>

      {state?.trend === undefined ? null : (
        <div className="wcc_block">
          <ModuleTitle id="trend" t={t} />
          <TrendLine trend={state.trend} t={t} />
        </div>
      )}

      {/* 三组相邻按钮：①范围+扫描 → ②已选+清空 → ③删除方式+预演+说明+确认执行
          组后各有一个向右箭头，标明「先扫描 → 再选择 → 最后执行」的先后关系（纯装饰，读屏会跳过） */}
      <div className="wcc_block">
        <ModuleTitle id="toolbar" t={t} />
        <div className="wcc_toolbar">
        <div className="wcc_group">
          <label className="wcc_field">
            {t('scope.label')}
            <select value={scope} onChange={(event) => setScope(event.target.value as 'hotspots' | 'full')}>
              <option value="hotspots">{t('scope.hotspots')}</option>
              <option value="full">{t('scope.full')}</option>
            </select>
          </label>
          <button type="button" className="wcc_btn wcc_btn_action" disabled={busy !== ''} onClick={() => void runScan()}>
            {scan === undefined ? t('action.scan') : t('action.rescan')}
          </button>
          <span className="wcc_arrow" aria-hidden="true">
            →
          </span>
        </div>

        <div className="wcc_group">
          <span className="wcc_selected">{t('selected', { count: selected.size })}</span>
          <button
            type="button"
            className="wcc_btn wcc_btn_action"
            disabled={selected.size === 0}
            onClick={() => {
              setSelected(new Set());
              setPreview(undefined);
            }}
          >
            {t('action.clear')}
          </button>
          <span className="wcc_arrow" aria-hidden="true">
            →
          </span>
        </div>

        <div className="wcc_group">
          <label className="wcc_field">
            {t('mode.label')}
            <select
              value={mode}
              onChange={(event) => {
                const next = event.target.value as 'trash' | 'permanent';
                setMode(next);
                setConfirmPermanent(false);
                setPreview(undefined);
              }}
            >
              <option value="trash">{t('mode.trash')}</option>
              <option value="permanent">{t('mode.permanent')}</option>
            </select>
          </label>
          <button
            type="button"
            className="wcc_btn wcc_btn_action"
            disabled={selected.size === 0 || busy !== ''}
            onClick={() => void runPreview()}
          >
            {t('action.preview')}
          </button>
          <button
            type="button"
            className={`wcc_help${helpOpen ? ' wcc_help_on' : ''}`}
            aria-expanded={helpOpen}
            aria-label={t('help.preview.toggle')}
            title={t('help.preview.title')}
            onClick={() => setHelpOpen((value) => !value)}
          >
            ?
          </button>
          <button
            type="button"
            className="wcc_btn wcc_btn_primary"
            disabled={gate !== 'ready'}
            title={confirmHintText()}
            onClick={() => void startExecute(false)}
          >
            {t('action.confirm')}
          </button>
          {confirmHintText() === '' ? null : <span className="wcc_confirm_hint">{confirmHintText()}</span>}
        </div>
        </div>
      </div>

      {helpOpen ? (
        <div className="wcc_helpbox">
          <div className="wcc_helpbox_title">{t('help.preview.title')}</div>
          <div className="wcc_helpbox_body">{t('help.preview.body')}</div>
          <div className="wcc_helpbox_body wcc_helpbox_limits">{t('help.preview.limits')}</div>
          <button type="button" className="wcc_btn_tiny" onClick={() => setHelpOpen(false)}>
            {t('job.collapse')}
          </button>
        </div>
      ) : null}

      <div className="wcc_block">
        <ModuleTitle id="status" t={t} />
        {busy !== '' ? <div className="wcc_status">⏳ {busy}</div> : null}
        {notice === undefined ? null : <div className="wcc_notice">{noticeText(notice, t)}</div>}
        {error !== '' ? <div className="wcc_error">⚠️ {error}</div> : null}
        {scan !== undefined && scan.partial ? (
          <div className="wcc_warn">
            {t('warn.partial')}
            {scan.partialReasons.length > 0 ? t('warn.partialReasons', { reasons: scan.partialReasons.join('；') }) : ''}
          </div>
        ) : null}
      </div>

      {scan === undefined ? (
        <div className="wcc_empty_panel">
          {t('empty.noScan')}
          {state?.lastScan === undefined ? null : (
            <div className="wcc_last">
              {t('empty.lastScan', {
                at: state.lastScan.at,
                count: state.lastScan.itemCount,
                safe: formatBytes(state.lastScan.safeBytes),
                caution: formatBytes(state.lastScan.cautionBytes),
              })}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="wcc_block">
            <ModuleTitle id="candidates" t={t} />
            <div className="wcc_cards">
              {TIERS.map((tier) => (
                <TierCard
                  key={tier.key}
                  tier={tier.key}
                  icon={tier.icon}
                  group={scan.groups[tier.key]}
                  selected={selected}
                  t={t}
                  onToggle={toggle}
                  onSelectTier={selectTier}
                  onMigrate={(path) => void runMigratePreview([path])}
                />
              ))}
            </div>
          </div>

          {scan.longTerm.length === 0 ? null : (
            <div className="wcc_block">
              <ModuleTitle id="longterm" t={t} />
              <details className="wcc_longterm">
                <summary>{t('longterm.summary', { count: scan.longTerm.length })}</summary>
                {scan.longTerm.map((action) => (
                  <div key={action.id} className="wcc_row_main">
                    <div className="wcc_row_path">{action.title}</div>
                    <div className="wcc_row_reason">{action.detail}</div>
                  </div>
                ))}
              </details>
            </div>
          )}
        </>
      )}

      {preview === undefined ? null : (
        <section className="wcc_section">
          <ModuleTitle
            id="preview"
            t={t}
            extra={
              t('preview.title', { size: formatBytes(preview.plannedBytes), count: preview.items.length }) +
              (preview.trashPath === undefined ? '' : t('preview.trashPath', { path: preview.trashPath }))
            }
          />
          {preview.warnings.map((warning) => (
            <div key={warning} className="wcc_warn">
              ⚠️ {warning}
            </div>
          ))}
          {preview.items.slice(0, 30).map((item) => (
            <div key={item.path} className="wcc_row">
              <span className={`wcc_tag wcc_tag_${item.kind}`}>{actionLabel(item.action)}</span>
              <div className="wcc_row_main">
                <div className="wcc_row_path" title={item.path}>
                  {shortPath(item.path)}
                </div>
                <div className="wcc_row_reason">
                  {formatBytes(item.sizeBytes)} ｜ {item.reason}
                </div>
              </div>
            </div>
          ))}
          {preview.items.length > 30 ? <div className="wcc_empty">{t('preview.more', { shown: 30 })}</div> : null}
          {preview.refused.length === 0 ? null : (
            <div className="wcc_refused">
              {t('preview.refused', { count: preview.refused.length })}
              {preview.refused.slice(0, 8).map((item) => (
                <div key={item.path} className="wcc_row_reason">
                  🚫 {shortPath(item.path, 56)} ｜ {item.reason}
                </div>
              ))}
            </div>
          )}
          {mode === 'permanent' ? (
            <div className="wcc_danger">
              {t('preview.permanentWarn')}
              <label className="wcc_field">
                <input type="checkbox" checked={confirmPermanent} onChange={(event) => setConfirmPermanent(event.target.checked)} />
                {t('preview.permanentConfirm')}
              </label>
            </div>
          ) : null}
          <div className="wcc_toolbar">
            <button
              type="button"
              className="wcc_btn wcc_btn_primary"
              disabled={busy !== '' || (mode === 'permanent' && !confirmPermanent)}
              onClick={() => void startExecute(false)}
            >
              {t('action.confirmBytes', { size: formatBytes(preview.plannedBytes) })}
            </button>
            <button type="button" className="wcc_btn" disabled={busy !== ''} onClick={() => void startExecute(true)}>
              {t('preview.dryAgain')}
            </button>
          </div>
        </section>
      )}

      {migration === undefined ? null : (
        <section className="wcc_section">
          <ModuleTitle
            id="migration"
            t={t}
            extra={t('migration.title', { root: migration.targetRoot, free: formatBytes(migration.targetFreeBytes) })}
          />
          {migration.warnings.map((warning) => (
            <div key={warning} className="wcc_warn">
              ⚠️ {warning}
            </div>
          ))}
          {migration.items.map((item) => (
            <div key={item.source} className="wcc_row">
              <span className={`wcc_tag ${item.hasRoom ? 'wcc_tag_trash' : 'wcc_tag_delete'}`}>
                {item.unknown ? t('migration.spaceUnknown') : item.hasRoom ? t('migration.spaceOk') : t('migration.spaceLow')}
              </span>
              <div className="wcc_row_main">
                <div className="wcc_row_path" title={`${item.source} → ${item.destination}`}>
                  {shortPath(item.source, 48)} → {shortPath(item.destination, 48)}
                </div>
                <div className="wcc_row_reason">
                  {t('migration.row', { size: formatBytes(item.sizeBytes), count: item.fileCount })}
                </div>
              </div>
            </div>
          ))}
          {migration.needsConfigChange.length === 0 ? null : (
            <div className="wcc_notice">{t('migration.configChange', { list: migration.needsConfigChange.join('；') })}</div>
          )}
          <div className="wcc_toolbar">
            <button type="button" className="wcc_btn wcc_btn_primary" disabled={busy !== ''} onClick={() => void startMigrate(false)}>
              {t('migration.confirm', { size: formatBytes(migration.totalBytes) })}
            </button>
            <button type="button" className="wcc_btn" disabled={busy !== ''} onClick={() => void startMigrate(true)}>
              {t('migration.dry')}
            </button>
            <button type="button" className="wcc_btn" onClick={() => setMigration(undefined)}>
              {t('migration.close')}
            </button>
          </div>
        </section>
      )}

      {job === undefined ? null : (
        <section className="wcc_section">
          <ModuleTitle
            id="progress"
            t={t}
            extra={
              `${job.dryRun ? t('job.titleDry') : t('job.titleReal')} ${job.jobId} ｜ ` +
              `${STATUS_KEY[job.status] === undefined ? job.status : t(STATUS_KEY[job.status] as string)}` +
              (job.reportPath === undefined ? '' : t('job.report', { path: job.reportPath }))
            }
          />
          <div className="wcc_bar">
            <div
              className="wcc_bar_fill"
              style={{ width: job.total === 0 ? '0%' : `${Math.min(100, (job.done / job.total) * 100)}%` }}
            />
          </div>
          <div className="wcc_row_reason">
            {t('job.progress', { done: job.done, total: job.total, message: job.message ?? '…' })}
            {job.status === 'running'
              ? ''
              : t('job.totalsMeasured', { measured: formatBytes(job.measuredFreedBytes) }) +
                (job.freedBytes > 0 ? t('job.totalsDrive', { freed: formatBytes(job.freedBytes) }) : '')}
          </div>
          {job.error === undefined ? null : <div className="wcc_error">⚠️ {job.error}</div>}
          {job.items.slice(0, 40).map((item) => (
            <div key={`${item.path}-${item.action}`} className="wcc_row">
              <span className={`wcc_tag wcc_tag_${item.action === 'refused' ? 'refused' : 'trash'}`}>
                {actionLabel(item.action)}
              </span>
              <div className="wcc_row_main">
                <div className="wcc_row_path" title={item.path}>
                  {shortPath(item.path)}
                </div>
                <div className="wcc_row_reason">
                  {formatBytes(item.sizeBytes)} ｜ {item.reason}
                </div>
              </div>
            </div>
          ))}
          <div className="wcc_toolbar">
            {job.status === 'running' ? (
              <button type="button" className="wcc_btn" onClick={() => void cancelJob()}>
                {t('job.cancel')}
              </button>
            ) : (
              <button type="button" className="wcc_btn" onClick={() => setJob(undefined)}>
                {t('job.collapse')}
              </button>
            )}
          </div>
        </section>
      )}

      <footer className="wcc_footer">
        <ModuleTitle id="artifacts" t={t} />
        <div>{t('footer.paths', { history: state?.historyPath ?? '…', report: state?.reportDir ?? '…' })}</div>
      </footer>
    </div>
  );
}
