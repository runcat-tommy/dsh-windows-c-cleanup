/**
 * M5 清理面板（浏览器侧）。
 *
 * 这个组件**不做任何业务判断**：分级、安全闸、测量、释放量核算全都在宿主侧既有模块里。
 * 它只做四件事：渲染、收集勾选、按「预演 → 确认 → 执行」两步发起 RPC、轮询进度。
 * 面板里唯一的安全规则是"提前告知"（保护层不可勾选、永久删除要二次确认），
 * 真正的防线在宿主侧 guardTargets —— UI 不是唯一防线。
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

type TierKey = 'safe' | 'caution' | 'migrate' | 'protected';

const TIERS: Array<{ key: TierKey; icon: string; title: string; hint: string }> = [
  { key: 'safe', icon: '🟢', title: '可安全删除', hint: '缓存/日志/临时文件，删了会自动重建' },
  { key: 'caution', icon: '🟡', title: '谨慎删除', hint: '系统或应用的缓存目录，建议确认后处理' },
  { key: 'migrate', icon: '🟠', title: '可迁移', hint: '搬到其他盘并在原位置留目录联接，应用无感' },
  { key: 'protected', icon: '🔴', title: '保护名单', hint: '绝不自动删除，面板里也不可勾选' },
];

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

const ACTION_LABEL: Record<string, string> = {
  planned: '计划执行',
  trashed: '已入暂存区',
  deleted: '已删除',
  partial: '部分完成',
  failed: '失败',
  refused: '已拒绝',
  'needs-elevation': '等待提权',
  'elevation-canceled': '提权被取消',
  migrated: '已迁移',
  'rolled-back': '已回滚',
  'destination-exists': '目标已存在',
  'insufficient-space': '目标盘空间不足',
  'source-busy': '源被占用',
  'verify-failed': '校验失败',
};

function TrendLine({ trend }: { trend: TrendView }): JSX.Element {
  const delta = trend.freeDeltaBytes;
  const sign = delta >= 0 ? '+' : '−';
  return (
    <div className="wcc_trend">
      📈 与上次扫描（{trend.hoursAgo.toFixed(1)} 小时前）：剩余空间 {sign}
      {formatBytes(Math.abs(delta))}｜长回来 {trend.grown.length} 项｜被释放 {trend.shrunk.length} 项
      {trend.grown.length > 0 ? (
        <div className="wcc_trend_grown">
          {trend.grown.slice(0, 3).map((item) => (
            <div key={item.path} className="wcc_trend_row">
              ＋{formatBytes(item.deltaBytes)}　{shortPath(item.path, 60)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TierCard(props: {
  icon: string;
  title: string;
  hint: string;
  group: PanelGroup;
  tier: TierKey;
  selected: Set<string>;
  onToggle: (path: string) => void;
  onSelectTier: (tier: TierKey, select: boolean) => void;
  onMigrate: (path: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(props.tier === 'safe');
  const selectable = props.tier === 'safe' || props.tier === 'caution';
  const chosen = props.group.items.filter((item) => props.selected.has(item.path)).length;

  return (
    <div className={`wcc_card wcc_card_${props.tier}`}>
      <div className="wcc_card_head">
        <span className="wcc_card_title">
          {props.icon} {props.title}
        </span>
        <span className="wcc_card_meta">
          {props.group.count} 项 ｜ {formatBytes(props.group.bytes)}
          {selectable && chosen > 0 ? ` ｜ 已选 ${chosen}` : ''}
        </span>
      </div>
      <div className="wcc_card_hint">{props.hint}</div>
      <div className="wcc_card_actions">
        <button type="button" className="wcc_btn_tiny" onClick={() => setOpen((value) => !value)}>
          {open ? '收起' : '展开'}
        </button>
        {selectable ? (
          <button
            type="button"
            className="wcc_btn_tiny"
            onClick={() => props.onSelectTier(props.tier, chosen < props.group.items.length)}
          >
            {chosen < props.group.items.length ? '全选本层' : '取消本层'}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="wcc_list">
          {props.group.items.length === 0 ? <div className="wcc_empty">（本层为空）</div> : null}
          {props.group.items.map((item: PanelGroupItem) => (
            <div key={item.path} className="wcc_row">
              <input
                type="checkbox"
                className="wcc_check"
                disabled={!selectable}
                checked={props.selected.has(item.path)}
                onChange={() => props.onToggle(item.path)}
                title={selectable ? '勾选后参与预演/执行' : '保护名单：不可勾选'}
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
                  迁移预览
                </button>
              ) : null}
            </div>
          ))}
          {props.group.truncated ? <div className="wcc_empty">（列表过长，仅显示前 200 项）</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export interface PanelProps {
  api: PanelApi;
}

export function CleanupPanel({ api }: PanelProps): JSX.Element {
  const [state, setState] = useState<PanelStateView | undefined>(undefined);
  const [scan, setScan] = useState<ScanView | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'trash' | 'permanent'>('trash');
  const [scope, setScope] = useState<'hotspots' | 'full'>('hotspots');
  const [preview, setPreview] = useState<PreviewView | undefined>(undefined);
  const [previewKey, setPreviewKey] = useState('');
  const [migration, setMigration] = useState<MigratePreviewView | undefined>(undefined);
  const [job, setJob] = useState<JobView | undefined>(undefined);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmPermanent, setConfirmPermanent] = useState(false);
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
            setError('任务已随宿主重启消失');
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
  }, [api, job]);

  const selectionKey = useMemo(() => [...selected].sort().join('\n'), [selected]);

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
    setBusy('正在扫描 C 盘（热点清单，约 1 分钟）…');
    setError('');
    setNotice('');
    try {
      const result = await api.scan(scope);
      setScan(result);
      setSelected(new Set());
      setPreview(undefined);
      setMigration(undefined);
      setNotice(`扫描完成：可释放潜力 🟢 ${formatBytes(result.groups.safe.bytes)} ｜ 🟡 ${formatBytes(result.groups.caution.bytes)} ｜ 🟠 ${formatBytes(result.groups.migrate.bytes)}`);
      await refreshState();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  }, [api, refreshState, scope]);

  const runPreview = useCallback(async () => {
    if (selected.size === 0) {
      setError('请先勾选要处理的项');
      return;
    }
    setBusy('正在预演（不删除任何文件）…');
    setError('');
    try {
      const result = await api.preview([...selected], mode);
      setPreview(result);
      setPreviewKey(selectionKey);
      setNotice(
        `预演完成：计划处理 ${formatBytes(result.plannedBytes)}${result.elevationCount > 0 ? `，其中 ${result.elevationCount} 项需要管理员权限` : ''}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  }, [api, mode, selected, selectionKey]);

  const startExecute = useCallback(
    async (dryRun: boolean) => {
      setBusy(dryRun ? '正在执行（dryRun 预演）…' : '正在执行，请勿关闭页面…');
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
    [api, mode, selected],
  );

  const runMigratePreview = useCallback(
    async (paths: string[]) => {
      setBusy('正在计算迁移方案（不复制数据）…');
      setError('');
      try {
        const result = await api.migratePreview(paths, state?.migrationTarget?.letter);
        setMigration(result);
        setNotice(`迁移预览：${result.items.length} 项，共 ${formatBytes(result.totalBytes)} → ${result.targetRoot}`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy('');
      }
    },
    [api, state],
  );

  const startMigrate = useCallback(
    async (dryRun: boolean) => {
      if (migration === undefined) return;
      setBusy(dryRun ? '正在预演迁移…' : '正在迁移（先复制、校验，再删源、建联接）…');
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
    [api, migration, state],
  );

  const cancelJob = useCallback(async () => {
    if (job === undefined) return;
    try {
      const result = await api.cancel(job.jobId);
      setNotice(result.canceled ? '已请求取消，正在安全中止…' : (result.reason ?? '取消失败'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, job]);

  const needPreview = preview === undefined || previewKey !== selectionKey;
  const system = state?.drives.find((drive) => drive.isSystem);
  const usedBytes = system === undefined ? 0 : Math.max(0, system.totalBytes - system.freeBytes);

  return (
    <div className="wcc_panel">
      <header className="wcc_head">
        <div>
          <div className="wcc_title">🧹 C 盘清理</div>
          <div className="wcc_sub">
            {system === undefined
              ? '正在读取磁盘信息…'
              : `${system.letter}: 剩余 ${formatBytes(system.freeBytes)} / 共 ${formatBytes(system.totalBytes)}（已用 ${percent(usedBytes, system.totalBytes)}）`}
          </div>
        </div>
        <div className="wcc_head_right">
          {state?.migrationTarget === undefined ? null : (
            <span className="wcc_chip">迁移目标 {state.migrationTarget.root}（{formatBytes(state.migrationTarget.freeBytes)} 可用）</span>
          )}
          <span className="wcc_chip">{state?.scheduler.description ?? '定时扫描：读取中…'}</span>
        </div>
      </header>

      {state?.trend === undefined ? null : <TrendLine trend={state.trend} />}

      <div className="wcc_toolbar">
        <label className="wcc_field">
          范围
          <select value={scope} onChange={(event) => setScope(event.target.value as 'hotspots' | 'full')}>
            <option value="hotspots">热点清单（快）</option>
            <option value="full">热点 + 全盘 Top-N（慢）</option>
          </select>
        </label>
        <button type="button" className="wcc_btn" disabled={busy !== ''} onClick={() => void runScan()}>
          {scan === undefined ? '扫描 C 盘' : '重新扫描'}
        </button>
        <label className="wcc_field">
          删除方式
          <select
            value={mode}
            onChange={(event) => {
              const next = event.target.value as 'trash' | 'permanent';
              setMode(next);
              setConfirmPermanent(false);
              setPreview(undefined);
            }}
          >
            <option value="trash">移到暂存区（可恢复）</option>
            <option value="permanent">永久删除（不可恢复）</option>
          </select>
        </label>
        <span className="wcc_spacer" />
        <span className="wcc_selected">已选 {selected.size} 项</span>
        <button type="button" className="wcc_btn" disabled={selected.size === 0 || busy !== ''} onClick={() => void runPreview()}>
          预演
        </button>
        <button
          type="button"
          className="wcc_btn wcc_btn_primary"
          disabled={needPreview || selected.size === 0 || busy !== ''}
          title={needPreview ? '勾选或模式已变化，请先重新预演' : '按预演过的动作执行'}
          onClick={() => void startExecute(false)}
        >
          确认执行
        </button>
        <button type="button" className="wcc_btn" disabled={selected.size === 0} onClick={() => { setSelected(new Set()); setPreview(undefined); }}>
          清空选择
        </button>
      </div>

      {busy !== '' ? <div className="wcc_status">⏳ {busy}</div> : null}
      {notice !== '' ? <div className="wcc_notice">{notice}</div> : null}
      {error !== '' ? <div className="wcc_error">⚠️ {error}</div> : null}

      {scan === undefined ? (
        <div className="wcc_empty_panel">
          还没有扫描结果。点「扫描 C 盘」开始 —— 扫描只读，不会删除任何文件。
          {state?.lastScan === undefined ? null : (
            <div className="wcc_last">
              上次扫描：{state.lastScan.at}（{state.lastScan.itemCount} 项，可释放 🟢 {formatBytes(state.lastScan.safeBytes)} / 🟡{' '}
              {formatBytes(state.lastScan.cautionBytes)}）
            </div>
          )}
        </div>
      ) : (
        <>
          {scan.partial ? (
            <div className="wcc_warn">
              ⚠️ 扫描被时间预算截断，列表可能不完整{scan.partialReasons.length > 0 ? `：${scan.partialReasons.join('；')}` : ''}
            </div>
          ) : null}
          <div className="wcc_cards">
            {TIERS.map((tier) => (
              <TierCard
                key={tier.key}
                tier={tier.key}
                icon={tier.icon}
                title={tier.title}
                hint={tier.hint}
                group={scan.groups[tier.key]}
                selected={selected}
                onToggle={toggle}
                onSelectTier={selectTier}
                onMigrate={(path) => void runMigratePreview([path])}
              />
            ))}
          </div>

          {scan.longTerm.length === 0 ? null : (
            <details className="wcc_longterm">
              <summary>🔵 长期防护措施（{scan.longTerm.length} 项，改配置/改习惯比反复清理更省事）</summary>
              {scan.longTerm.map((action) => (
                <div key={action.id} className="wcc_row_main">
                  <div className="wcc_row_path">{action.title}</div>
                  <div className="wcc_row_reason">{action.detail}</div>
                </div>
              ))}
            </details>
          )}
        </>
      )}

      {preview === undefined ? null : (
        <section className="wcc_section">
          <div className="wcc_section_title">
            🔍 预演结果 —— 计划处理 {formatBytes(preview.plannedBytes)}（{preview.items.length} 项）
            {preview.trashPath === undefined ? '' : `，暂存区 ${preview.trashPath}`}
          </div>
          {preview.warnings.map((warning) => (
            <div key={warning} className="wcc_warn">⚠️ {warning}</div>
          ))}
          {preview.items.slice(0, 30).map((item) => (
            <div key={item.path} className="wcc_row">
              <span className={`wcc_tag wcc_tag_${item.kind}`}>{ACTION_LABEL[item.action] ?? item.action}</span>
              <div className="wcc_row_main">
                <div className="wcc_row_path" title={item.path}>{shortPath(item.path)}</div>
                <div className="wcc_row_reason">{formatBytes(item.sizeBytes)} ｜ {item.reason}</div>
              </div>
            </div>
          ))}
          {preview.items.length > 30 ? <div className="wcc_empty">（仅显示前 30 项，完整清单见执行报告）</div> : null}
          {preview.refused.length === 0 ? null : (
            <div className="wcc_refused">
              已拒绝 {preview.refused.length} 项（保护名单/越界/不存在，宿主的硬约束，面板无法绕过）：
              {preview.refused.slice(0, 8).map((item) => (
                <div key={item.path} className="wcc_row_reason">
                  🚫 {shortPath(item.path, 56)} ｜ {item.reason}
                </div>
              ))}
            </div>
          )}
          {mode === 'permanent' ? (
            <div className="wcc_danger">
              永久删除不可恢复。若确认，请先勾选下面的确认框，再点「确认执行」。
              <label className="wcc_field">
                <input type="checkbox" checked={confirmPermanent} onChange={(event) => setConfirmPermanent(event.target.checked)} />
                我已确认这些内容不再需要
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
              确认执行（{formatBytes(preview.plannedBytes)}）
            </button>
            <button type="button" className="wcc_btn" disabled={busy !== ''} onClick={() => void startExecute(true)}>
              再跑一次 dryRun
            </button>
          </div>
        </section>
      )}

      {migration === undefined ? null : (
        <section className="wcc_section">
          <div className="wcc_section_title">🚚 迁移预览 → {migration.targetRoot}（目标盘可用 {formatBytes(migration.targetFreeBytes)}）</div>
          {migration.warnings.map((warning) => (
            <div key={warning} className="wcc_warn">⚠️ {warning}</div>
          ))}
          {migration.items.map((item) => (
            <div key={item.source} className="wcc_row">
              <span className={`wcc_tag ${item.hasRoom ? 'wcc_tag_trash' : 'wcc_tag_delete'}`}>
                {item.unknown ? '空间未知' : item.hasRoom ? '空间够' : '空间不足'}
              </span>
              <div className="wcc_row_main">
                <div className="wcc_row_path" title={`${item.source} → ${item.destination}`}>
                  {shortPath(item.source, 48)} → {shortPath(item.destination, 48)}
                </div>
                <div className="wcc_row_reason">
                  {formatBytes(item.sizeBytes)} ｜ {item.fileCount} 个文件 ｜ 源删净后原位置留目录联接
                </div>
              </div>
            </div>
          ))}
          {migration.needsConfigChange.length === 0 ? null : (
            <div className="wcc_notice">迁移后需要你自己改的配置（插件不代改）：{migration.needsConfigChange.join('；')}</div>
          )}
          <div className="wcc_toolbar">
            <button type="button" className="wcc_btn wcc_btn_primary" disabled={busy !== ''} onClick={() => void startMigrate(false)}>
              确认迁移（{formatBytes(migration.totalBytes)}）
            </button>
            <button type="button" className="wcc_btn" disabled={busy !== ''} onClick={() => void startMigrate(true)}>
              只看 dryRun
            </button>
            <button type="button" className="wcc_btn" onClick={() => setMigration(undefined)}>
              关闭
            </button>
          </div>
        </section>
      )}

      {job === undefined ? null : (
        <section className="wcc_section">
          <div className="wcc_section_title">
            {job.dryRun ? '🧪 dryRun 任务' : '⚙️ 执行任务'} {job.jobId} ｜ {ACTION_LABEL[job.status] ?? job.status}
            {job.reportPath === undefined ? '' : ` ｜ 报告：${job.reportPath}`}
          </div>
          <div className="wcc_bar">
            <div className="wcc_bar_fill" style={{ width: job.total === 0 ? '0%' : `${Math.min(100, (job.done / job.total) * 100)}%` }} />
          </div>
          <div className="wcc_row_reason">
            {job.done}/{job.total} 项 ｜ {job.message ?? '…'}
            {job.status === 'running' ? '' : ` ｜ 逐项合计 ${formatBytes(job.measuredFreedBytes)}${job.freedBytes > 0 ? ` ｜ 盘符净增 ${formatBytes(job.freedBytes)}` : ''}`}
          </div>
          {job.error === undefined ? null : <div className="wcc_error">⚠️ {job.error}</div>}
          {job.items.slice(0, 40).map((item) => (
            <div key={`${item.path}-${item.action}`} className="wcc_row">
              <span className={`wcc_tag wcc_tag_${item.action === 'refused' ? 'refused' : 'trash'}`}>{ACTION_LABEL[item.action] ?? item.action}</span>
              <div className="wcc_row_main">
                <div className="wcc_row_path" title={item.path}>{shortPath(item.path)}</div>
                <div className="wcc_row_reason">{formatBytes(item.sizeBytes)} ｜ {item.reason}</div>
              </div>
            </div>
          ))}
          <div className="wcc_toolbar">
            {job.status === 'running' ? (
              <button type="button" className="wcc_btn" onClick={() => void cancelJob()}>
                取消任务
              </button>
            ) : (
              <button type="button" className="wcc_btn" onClick={() => setJob(undefined)}>
                收起
              </button>
            )}
          </div>
        </section>
      )}

      <footer className="wcc_footer">
        历史：{state?.historyPath ?? '…'}｜报告：{state?.reportDir ?? '…'}（任务表在宿主内存里，宿主重启即清空）
      </footer>
    </div>
  );
}
