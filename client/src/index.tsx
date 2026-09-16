/**
 * 客户端插件入口（浏览器侧）。
 *
 * 契约（来自内置包实证）：bundle 是 classic script，顶层唯一语句是
 * `window.__ModuleLoader__.load({ id: 包名, factory })`；factory 内用同步 `require`
 * 取模块表里的 seed（`react` / `react/jsx-runtime` 都在表内），并导出 `apply` / `inject`。
 *
 * 这里**只依赖 `slots` 一个硬服务**；connection（RPC）用 `ctx.get` 软取 —— 拿不到时
 * 面板会显示"当前宿主没有 Connection 服务"，而不是让整个客户端插件加载失败。
 */
import { createElement, type ReactElement } from 'react';
import { PanelApi, type ConnectionLike } from './api.js';
import { CleanupPanel } from './panel.js';

const STYLE_TAG_ID = 'dsh-windows-c-cleanup/panel.css';

/** 颜色一律走主题 token，保证跟随明暗主题 */
const PANEL_CSS = `
.wcc_panel{display:flex;flex-direction:column;gap:10px;padding:14px 16px;height:100%;overflow:auto;
  color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:1.5}
.wcc_head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.wcc_title{font-size:16px;font-weight:600}
.wcc_sub{color:var(--dsw-alias-label-secondary,#57606a);margin-top:2px}
.wcc_head_right{display:flex;gap:6px;flex-wrap:wrap}
.wcc_chip{border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:10px;padding:2px 8px;
  color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}
.wcc_trend{border-left:3px solid var(--dsw-alias-border-l2,#8250df);padding:6px 10px;border-radius:6px;
  background:var(--dsw-alias-bg-subtle,#f6f8fa)}
.wcc_trend_grown{margin-top:4px;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}
.wcc_trend_row{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcc_toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wcc_spacer{flex:1}
.wcc_field{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#57606a)}
.wcc_field select{background:var(--dsw-alias-bg-base,#fff);color:inherit;border:1px solid var(--dsw-alias-border-l1,#d0d7de);
  border-radius:6px;padding:3px 6px;font:inherit}
.wcc_btn{border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-base,#fff);color:inherit;
  border-radius:8px;padding:5px 12px;font:inherit;cursor:pointer}
.wcc_btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2,#8250df)}
.wcc_btn:disabled{opacity:.5;cursor:not-allowed}
.wcc_btn_primary{background:var(--dsw-alias-brand-primary,#0969da);border-color:transparent;color:#fff}
.wcc_btn_tiny{border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:transparent;color:inherit;
  border-radius:6px;padding:1px 7px;font-size:12px;cursor:pointer}
.wcc_status,.wcc_notice,.wcc_error,.wcc_warn{border-radius:8px;padding:6px 10px}
.wcc_status{background:var(--dsw-alias-bg-subtle,#f6f8fa)}
.wcc_notice{background:var(--dsw-alias-bg-subtle,#f6f8fa);border-left:3px solid var(--dsw-alias-brand-primary,#0969da)}
.wcc_error{background:var(--dsw-alias-bg-subtle,#fff1f0);border-left:3px solid #d1242f}
.wcc_warn{background:var(--dsw-alias-bg-subtle,#fff8c5);border-left:3px solid #d4a72c}
.wcc_danger{border:1px dashed #d1242f;border-radius:8px;padding:8px 10px;color:#a40e26;display:flex;
  flex-direction:column;gap:6px}
.wcc_empty_panel{border:1px dashed var(--dsw-alias-border-l1,#d0d7de);border-radius:10px;padding:18px;text-align:center;
  color:var(--dsw-alias-label-secondary,#57606a)}
.wcc_last{margin-top:8px;font-size:12px}
.wcc_cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px}
.wcc_card{border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:10px;padding:10px;display:flex;
  flex-direction:column;gap:6px;min-width:0}
.wcc_card_safe{border-left:3px solid #1a7f37}
.wcc_card_caution{border-left:3px solid #bf8700}
.wcc_card_migrate{border-left:3px solid #bc4c00}
.wcc_card_protected{border-left:3px solid #d1242f}
.wcc_card_head{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.wcc_card_title{font-weight:600}
.wcc_card_meta{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}
.wcc_card_hint{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}
.wcc_card_actions{display:flex;gap:6px}
.wcc_list{display:flex;flex-direction:column;gap:4px;max-height:320px;overflow:auto}
.wcc_row{display:flex;align-items:flex-start;gap:8px;padding:4px 0;border-top:1px solid var(--dsw-alias-border-l2,#eaeef2);min-width:0}
.wcc_check{margin-top:3px}
.wcc_row_main{flex:1;min-width:0}
.wcc_row_path{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcc_row_reason{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}
.wcc_tag{flex:0 0 auto;border-radius:6px;padding:1px 7px;font-size:11px;background:var(--dsw-alias-bg-subtle,#f6f8fa);
  border:1px solid var(--dsw-alias-border-l1,#d0d7de)}
.wcc_tag_trash{border-color:#1a7f37;color:#1a7f37}
.wcc_tag_delete{border-color:#d1242f;color:#d1242f}
.wcc_tag_elevate{border-color:#bf8700;color:#bf8700}
.wcc_tag_refused{border-color:#8250df;color:#8250df}
.wcc_empty{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;padding:4px 0}
.wcc_section{border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:10px;padding:10px;display:flex;
  flex-direction:column;gap:6px}
.wcc_section_title{font-weight:600}
.wcc_bar{height:6px;border-radius:4px;background:var(--dsw-alias-bg-subtle,#eaeef2);overflow:hidden}
.wcc_bar_fill{height:100%;background:var(--dsw-alias-brand-primary,#0969da);transition:width .3s ease}
.wcc_refused{border-top:1px dashed var(--dsw-alias-border-l1,#d0d7de);padding-top:6px}
.wcc_longterm{border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:10px;padding:8px 10px}
.wcc_longterm summary{cursor:pointer;font-weight:600}
.wcc_footer{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;margin-top:auto;padding-top:6px;
  word-break:break-all}
`;

interface SlotsLike {
  inject(key: string, callback: () => unknown): unknown;
  register(
    options: { name: string; id: string; order?: number; label?: string },
    component: (props: unknown) => ReactElement | null,
  ): unknown;
}

interface ClientContextLike {
  effect(callback: () => (() => void) | void, label?: string): unknown;
  get(name: string): unknown;
  slots: SlotsLike;
}

/** 硬依赖：插槽注册表。connection 用 ctx.get 软取，不做硬依赖 */
export const inject = ['slots'];

export function apply(ctx: ClientContextLike): void {
  // 样式注入（幂等）+ 由 ctx.effect 托管清理，插件卸载不留 <style>
  ctx.effect(() => {
    const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`);
    if (existing !== null) return () => {};
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-windows-c-cleanup';
    tag.dataset.pluginCss = STYLE_TAG_ID;
    tag.textContent = PANEL_CSS;
    document.head.appendChild(tag);
    return () => {
      if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
    };
  }, 'windows-c-cleanup: panel css');

  const api = new PanelApi(() => ctx.get('connection') as ConnectionLike | undefined);

  // conversation.view：additive list 插槽（replaceRisk: none），注册成对话视图环里的一个整页 tab
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      { name: 'conversation.view', id: 'disk-cleanup', order: 40, label: '磁盘清理' },
      () => createElement(CleanupPanel, { api }),
    ),
  );
}
