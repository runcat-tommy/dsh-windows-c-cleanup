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
import { DICTS, LOCALE_NS, detectLocale, makeTranslate, normalizeLocale, type LocaleId, type Translate } from './i18n.js';
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
.wcc_toolbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.wcc_group{display:flex;align-items:center;gap:6px}
/*
 * 组间流向箭头（在「扫描」按钮后与「清空选择」按钮后各一个）：
 * 纯装饰、aria-hidden，左右留白刻意放大（12px + 组内 gap 6px = 每侧 18px），
 * 让「先扫描 → 再选择 → 最后预演」的先后关系一眼看清。
 */
.wcc_arrow{align-self:center;margin:0 12px;color:var(--dsw-alias-label-secondary,#57606a);
  font-size:16px;line-height:1;font-weight:600;user-select:none;pointer-events:none}
.wcc_spacer{flex:1}
.wcc_help{align-self:center;width:24px;height:24px;padding:0;border-radius:50%;
  border:2px solid var(--dsw-alias-brand-primary,#0969da);
  background:var(--dsw-alias-bg-base,#fff);
  background:color-mix(in srgb, var(--dsw-alias-brand-primary,#0969da) 16%, var(--dsw-alias-bg-base,#fff));
  color:var(--dsw-alias-brand-primary,#0969da);font:inherit;font-size:15px;font-weight:700;line-height:1;
  cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.14)}
.wcc_help:hover{transform:scale(1.06);
  background:color-mix(in srgb, var(--dsw-alias-brand-primary,#0969da) 26%, var(--dsw-alias-bg-base,#fff))}
.wcc_help_on{background:var(--dsw-alias-brand-primary,#0969da);border-color:transparent;color:#fff}
.wcc_helpbox{border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-left:3px solid var(--dsw-alias-brand-primary,#0969da);
  border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-subtle,#f6f8fa);
  display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.wcc_helpbox_title{font-weight:600}
.wcc_helpbox_body{white-space:pre-line}
.wcc_helpbox_limits{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}
.wcc_field{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#57606a)}
.wcc_field select{background:var(--dsw-alias-bg-base,#fff);color:inherit;border:1px solid var(--dsw-alias-border-l1,#d0d7de);
  border-radius:6px;padding:3px 6px;font:inherit}
.wcc_btn{border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-base,#fff);color:inherit;
  border-radius:8px;padding:5px 12px;font:inherit;cursor:pointer}
.wcc_btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2,#8250df)}
.wcc_btn:disabled{opacity:.5;cursor:not-allowed}
/*
 * 显眼按钮（扫描 / 清空选择 / 预演）：加粗描边 + 品牌色 + 底色淡染 + 投影，一眼可辨是按钮。
 * 所有规则都限定 :not(:disabled) —— 不可用时**保持** .wcc_btn 的原样（浅底、灰边、半透明），
 * 绝不能把"不能点"渲染成"看起来能点"。
 */
.wcc_btn_action:not(:disabled){border:2px solid var(--dsw-alias-brand-primary,#0969da);
  background:var(--dsw-alias-bg-base,#fff);
  background:color-mix(in srgb, var(--dsw-alias-brand-primary,#0969da) 10%, var(--dsw-alias-bg-base,#fff));
  color:var(--dsw-alias-brand-primary,#0969da);font-weight:600;padding:4px 14px;
  box-shadow:0 1px 3px rgba(0,0,0,.14)}
.wcc_btn_action:not(:disabled):hover{
  background:color-mix(in srgb, var(--dsw-alias-brand-primary,#0969da) 20%, var(--dsw-alias-bg-base,#fff));
  box-shadow:0 2px 6px rgba(0,0,0,.2)}
.wcc_btn_action:not(:disabled):active{transform:translateY(1px);box-shadow:none;
  background:color-mix(in srgb, var(--dsw-alias-brand-primary,#0969da) 28%, var(--dsw-alias-bg-base,#fff))}
.wcc_btn_primary{background:var(--dsw-alias-brand-primary,#0969da);border-color:transparent;color:#fff}
/*
 * 「确认执行」不可点时的原因必须看得见。
 * 禁用按钮在多数浏览器里弹不出 title（收不到鼠标事件），只写 tooltip 等于没写。
 */
.wcc_confirm_hint{font-size:12px;line-height:1.3;max-width:230px;
  color:var(--dsw-alias-label-secondary,#57606a)}
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
/*
 * 功能模块名（每个区块左上角的小标签）。
 * 存在的理由：面板有好几块（概览/操作区/清理候选/预演结果…），用户需要能指着某一块说话——
 * 「预演结果那块」比「上面那个框」精确得多。标签样式刻意做成"标签"而不是标题文字，不抢内容。
 */
.wcc_module{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:2px 0}
.wcc_module_name{font-size:11px;font-weight:700;letter-spacing:.03em;padding:2px 8px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-subtle,#f6f8fa);
  color:var(--dsw-alias-label-secondary,#57606a);white-space:nowrap}
.wcc_module_extra{font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}
.wcc_bar{height:6px;border-radius:4px;background:var(--dsw-alias-bg-subtle,#eaeef2);overflow:hidden}
.wcc_bar_fill{height:100%;background:var(--dsw-alias-brand-primary,#0969da);transition:width .3s ease}
.wcc_refused{border-top:1px dashed var(--dsw-alias-border-l1,#d0d7de);padding-top:6px}
.wcc_longterm{border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:10px;padding:8px 10px}
.wcc_longterm summary{cursor:pointer;font-weight:600}
.wcc_footer{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;margin-top:auto;padding-top:6px;
  word-break:break-all}
.wcc_block{display:flex;flex-direction:column;gap:6px}
`;

interface SlotsLike {
  inject(key: string, callback: () => unknown): unknown;
  register(
    options: {
      name: string;
      id: string;
      order?: number;
      /** 平台允许 thunk：tab 标题按当前语言现算，不必重新注册 */
      label?: string | (() => string);
      /** 声明字典命名空间 → 框架给组件注入 `t` seat，并在语言切换时重新下发 */
      locale?: string;
      registrant?: string;
    },
    component: (props: unknown) => ReactElement | null,
  ): unknown;
}

interface LocaleRuntimeLike {
  register(ns: string, locale: string, dict: Record<string, string>): () => void;
  bind(ns: string): Translate;
  getLocale(): { active: string; locales: readonly { id: string; label: string }[]; revision: number };
}

interface ClientContextLike {
  effect(callback: () => (() => void) | void, label?: string): unknown;
  get(name: string): unknown;
  slots: SlotsLike;
  /** cordis 的服务等待：等 locale 服务就绪再跑回调（拿不到就退化成立即执行） */
  inject?(names: string[], callback: (scope: ClientContextLike) => void): unknown;
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

  /**
   * 面板接线。
   *
   * 时序很重要：字典必须**先登记**（框架渲染带 `locale:` 的注册项时找不到对应字典会显式报错），
   * 而 `apply` 执行的瞬间语言服务未必就绪。所以这里用 `ctx.inject(['locale'])` 等服务到位再接线；
   * 拿不到 `inject`（非 Web 宿主 / 离线测试替身）就立即接线，并退化到"按浏览器语言自选字典"。
   */
  const wireUp = (): void => {
    const locale = ctx.get('locale') as LocaleRuntimeLike | undefined;
    const hasLocale = locale !== undefined && typeof locale.register === 'function';
    if (hasLocale && locale !== undefined) {
      ctx.effect(() => {
        const disposers = [locale.register(LOCALE_NS, 'zh', DICTS.zh), locale.register(LOCALE_NS, 'en', DICTS.en)];
        return () => {
          for (const dispose of disposers) dispose();
        };
      }, 'windows-c-cleanup: locale dicts');
    }

    // 每次都重新取：语言服务可能后到，也可能被卸载；取不到就按浏览器语言自选
    const translateNow = (): Translate => {
      const current = ctx.get('locale') as LocaleRuntimeLike | undefined;
      return current !== undefined && typeof current.bind === 'function'
        ? current.bind(LOCALE_NS)
        : makeTranslate(detectLocale());
    };
    const localeNow = (): LocaleId => {
      const current = ctx.get('locale') as LocaleRuntimeLike | undefined;
      return current === undefined ? detectLocale() : normalizeLocale(current.getLocale?.().active);
    };

    const api = new PanelApi(
      () => ctx.get('connection') as ConnectionLike | undefined,
      () => localeNow(),
    );

    // conversation.view：additive list 插槽（replaceRisk: none），注册成对话视图环里的一个整页 tab。
    // locale: 命名空间 → 框架注入 `t` seat；label 用 thunk → 语言切换时 tab 标题自动跟随。
    ctx.slots.inject('conversation.view', () =>
      ctx.slots.register(
        {
          name: 'conversation.view',
          id: 'disk-cleanup',
          order: 40,
          label: () => translateNow()('tab'),
          locale: LOCALE_NS,
          registrant: 'dsh-windows-c-cleanup',
        },
        (props: unknown) => {
          const seat = (props as { t?: Translate } | undefined)?.t;
          return createElement(CleanupPanel, { api, ...(seat === undefined ? {} : { t: seat }) });
        },
      ),
    );
  };

  if (typeof ctx.inject === 'function') ctx.inject(['locale'], () => wireUp());
  else wireUp();
}
