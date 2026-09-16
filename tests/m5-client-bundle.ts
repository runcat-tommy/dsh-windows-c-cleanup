/**
 * M5 客户端 bundle 契约验证（离线，不需要浏览器）。
 *
 * 宿主只认这一种产物形态，所以这里把浏览器侧的加载过程最小化重放一遍：
 *  1. classic script 顶层调用 `window.__ModuleLoader__.load({ id, factory })`；
 *  2. `id` 必须等于包名（graph row 的键）；
 *  3. factory 里 `require` 只能命中 seed 表成员；
 *  4. 物化后的 exports 必须有 `apply` / `inject`；
 *  5. 用假 ctx 真的跑一遍 `apply` + 渲染一次面板组件（能抓到拼写、导入、字段错误）。
 *
 * 运行：npm run m5:client
 */
import { readFileSync } from 'node:fs';
import { Fragment, createElement, jsxImpl, reactStub, resetHooks } from './helpers/react-stub.js';

const bundlePath = new URL('../client/client.js', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  exports: Record<string, { default?: string } | string>;
  dsh?: { client?: { platform?: string; inject?: string[] } };
};

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`);
}

// ---------- 1. 清单字段：宿主据此判定「这是一个客户端包」 ----------
console.log('=== windows-c-cleanup M5 客户端契约验证 ===\n');
console.log('--- 1. 包清单 ---');
const clientExport = pkg.exports['./client'];
const clientPath = typeof clientExport === 'string' ? clientExport : clientExport?.default;
check('1.1 exports["./client"] 指向 bundle', clientPath === './client/client.js', String(clientPath));
check('1.2 dsh.client.platform 必须是 "web"', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform));
check(
  '1.3 dsh.client.inject 是包名数组（信息性依赖边）',
  Array.isArray(pkg.dsh?.client?.inject) && (pkg.dsh?.client?.inject?.length ?? 0) > 0,
  JSON.stringify(pkg.dsh?.client?.inject),
);
check('1.4 bundle 文件存在', readFileSync(bundlePath, 'utf8').length > 0);

// ---------- 2. 加载：重放浏览器的 classic script + lazy-CJS 工厂 ----------
console.log('\n--- 2. 重放浏览器加载过程 ---');
const source = readFileSync(bundlePath, 'utf8');
const handoffs = new Map<string, (require: (spec: string) => unknown) => Record<string, unknown>>();
const seeded = ['react', 'react/jsx-runtime'];
const fakeWindow = {
  __ModuleLoader__: {
    load(handoff: { id: string; factory: (require: (spec: string) => unknown) => Record<string, unknown> }): void {
      handoffs.set(handoff.id, handoff.factory);
    },
  },
};
const fakeRequire = (spec: string): unknown => {
  if (spec === 'react') return { createElement, Fragment, ...reactStub };
  if (spec === 'react/jsx-runtime') return { jsx: jsxImpl, jsxs: jsxImpl, Fragment };
  throw new Error(`require("${spec}") 命中不了 seed 表 —— 会被浏览器模块表当场拒绝`);
};

// 样式注入与轮询用到的 DOM 面
const styleTags: Array<{ dataset: Record<string, string>; textContent: string; parentNode: unknown }> = [];
const fakeDocument = {
  querySelector: () => null,
  createElement: () => {
    const tag = { dataset: {} as Record<string, string>, textContent: '', parentNode: null as unknown };
    styleTags.push(tag);
    return tag;
  },
  head: { appendChild: () => {} },
};
const fakeWindowRuntime = { setInterval: () => 1, clearInterval: () => {} };

const run = new Function('window', 'document', 'require', source) as (
  window: unknown,
  document: unknown,
  require: unknown,
) => void;
run({ ...fakeWindow, ...fakeWindowRuntime }, fakeDocument, fakeRequire);

check('2.1 bundle 只注册了一个入口', handoffs.size === 1, [...handoffs.keys()].join(', '));
check('2.2 注册键 === 包名（graph row 的键必须一致）', handoffs.has(pkg.name), [...handoffs.keys()].join(', '));

const factory = handoffs.get(pkg.name);
check('2.3 拿到 factory', typeof factory === 'function');
const exports_ = factory === undefined ? {} : factory(fakeRequire);
check('2.4 物化后导出 apply', typeof exports_.apply === 'function');
check(
  '2.5 导出 inject 且声明了硬依赖 slots',
  Array.isArray(exports_.inject) && (exports_.inject as string[]).includes('slots'),
  JSON.stringify(exports_.inject),
);

// ---------- 3. 只 require seed 表成员 ----------
console.log('\n--- 3. 模块表依赖 ---');
const required = [...new Set([...source.matchAll(/require\((["'])([^"']+)\1\)/g)].map((match) => match[2]))];
const unknownSpecs = required.filter((spec) => !seeded.includes(spec ?? ''));
check(
  '3.1 bundle 只 require seed 表成员（第三方库必须打进 bundle）',
  unknownSpecs.length === 0,
  required.map((spec) => `${spec}${seeded.includes(spec ?? '') ? '' : ' ⚠️'}`).join(' | '),
);

// ---------- 4. 真的跑一遍客户端插件 ----------
console.log('\n--- 4. 注册与首屏渲染 ---');
interface Requirement {
  key: string;
  component: ((props: unknown) => unknown) | undefined;
  options: Record<string, unknown>;
}
const registered: Requirement[] = [];
let disposedStyles = 0;
const effects: string[] = [];
const fakeState = {
  systemDrive: 'C',
  drives: [
    { letter: 'C', totalBytes: 220 * 1024 ** 3, freeBytes: 68 * 1024 ** 3, isSystem: true },
    { letter: 'D', totalBytes: 900 * 1024 ** 3, freeBytes: 696 * 1024 ** 3, isSystem: false },
  ],
  defaultScope: 'hotspots' as const,
  historyPath: 'C:\\Users\\x\\.dsh\\windows-c-cleanup\\history.jsonl',
  reportDir: 'C:\\Users\\x\\.dsh\\windows-c-cleanup\\reports',
  scheduler: { enabled: false, running: false, intervalHours: 24, alertFreePercent: 10 },
  migrationTarget: { letter: 'D', root: 'D:\\', freeBytes: 696 * 1024 ** 3 },
  runningJobs: 0,
};
const rpcCalls: Array<{ endpoint: string; payload: unknown }> = [];
const fakeConnection = {
  rpc: {
    call: (channel: string, endpoint: string, payload: unknown) => {
      rpcCalls.push({ endpoint, payload });
      if (channel !== '/dsh-c-cleanup') throw new Error(`通道名不对：${channel}`);
      if (endpoint === 'state') return Promise.resolve({ ok: true, value: fakeState });
      return Promise.resolve({ ok: false, error: { code: 'internal', message: `测试未桩化端点 ${endpoint}` } });
    },
  },
};

interface Registered {
  key: string;
  component: ((props: unknown) => unknown) | undefined;
  options: Record<string, unknown>;
}

const fakeCtx = {
  effect: (callback: () => (() => void) | void, label?: string) => {
    effects.push(label ?? '(无标签)');
    const disposer = callback();
    return () => {
      if (typeof disposer === 'function') {
        disposer();
        disposedStyles++;
      }
    };
  },
  get: (name: string) => (name === 'connection' ? fakeConnection : undefined),
  slots: {
    inject: (key: string, callback: () => unknown) => {
      if (key !== 'conversation.view') throw new Error(`注册到了非预期插槽：${key}`);
      callback();
    },
    register: (options: Record<string, unknown>, component: (props: unknown) => unknown) => {
      if (options.name !== 'conversation.view') throw new Error(`插槽名不对：${String(options.name)}`);
      registered.push({ key: String(options.id), component, options });
      return () => {};
    },
  },
};

try {
  (exports_.apply as (ctx: unknown) => void)(fakeCtx);
  check('4.1 apply 成功执行（注册了样式与插槽）', true);
} catch (error) {
  check('4.1 apply 成功执行（注册了样式与插槽）', false, String(error));
}
check('4.2 样式走 ctx.effect 托管（可被卸载清理）', effects.some((label) => label.includes('panel css')), effects.join(' | '));
check('4.3 注册到 conversation.view（additive list 插槽）', registered.length === 1 && registered[0]?.key === 'disk-cleanup', JSON.stringify(registered.map((entry) => entry.key)));

// ---------- 5. 双语：字典键对齐 + tab 标题跟随语言 + 中英各自渲染 ----------
console.log('\n--- 5. 中英双语 ---');
const i18n = (await import('../client/src/i18n.js')) as {
  DICTS: Record<string, Record<string, string>>;
  LOCALE_NS: string;
  makeTranslate: (locale: 'zh' | 'en') => (key: string, params?: Record<string, unknown>) => string;
};
const zhKeys = Object.keys(i18n.DICTS.zh ?? {}).sort();
const enKeys = Object.keys(i18n.DICTS.en ?? {}).sort();
check(
  '5.1 中英字典键集合严格一致（防漏译）',
  zhKeys.length > 0 && zhKeys.join('\n') === enKeys.join('\n'),
  `zh=${zhKeys.length} en=${enKeys.length}｜只在中文: ${zhKeys.filter((k) => !enKeys.includes(k)).join(',') || '无'}｜只在英文: ${enKeys.filter((k) => !zhKeys.includes(k)).join(',') || '无'}`,
);
check(
  '5.2 字典覆盖到 tab 标题',
  zhKeys.includes('tab') && i18n.DICTS.zh?.tab === '磁盘清理' && i18n.DICTS.en?.tab === 'Disk cleanup',
  `${i18n.DICTS.zh?.tab} / ${i18n.DICTS.en?.tab}`,
);
check(
  '5.3 英文值里没有中文字符（中英严格分开）',
  Object.entries(i18n.DICTS.en ?? {}).every(([, value]) => !/\p{Script=Han}/u.test(value)),
  Object.entries(i18n.DICTS.en ?? {})
    .filter(([, value]) => /\p{Script=Han}/u.test(value))
    .map(([key]) => key)
    .join(', ') || '全部干净',
);
const zhTranslate = i18n.makeTranslate('zh');
const enTranslate = i18n.makeTranslate('en');
check(
  '5.4 占位符替换生效，且语言切换后文案确实换了',
  zhTranslate('selected', { count: 3 }) === '已选 3 项' && enTranslate('selected', { count: 3 }) === '3 selected',
  `${zhTranslate('selected', { count: 3 })} / ${enTranslate('selected', { count: 3 })}`,
);

const options = registered[0]?.options ?? {};
check(
  '5.5 插槽注册声明了 locale 命名空间（框架据此注入 t seat）',
  options.locale === i18n.LOCALE_NS,
  String(options.locale),
);
const labelOption = options.label;
const labelText = typeof labelOption === 'function' ? (labelOption as () => string)() : String(labelOption);
check(
  '5.6 tab 标题是 thunk（语言切换时自动跟随，无需重新注册）',
  typeof labelOption === 'function' && labelText === '磁盘清理',
  `typeof=${typeof labelOption} value=${labelText}`,
);

const component = registered[0]?.component;
check('5.7 组件是函数组件', typeof component === 'function');
/** 中文首屏渲染文本（第 7 节要拿它数按钮） */
let panelTextZh = '';

/** 最小渲染器：展开函数组件与宿主元素，产出可断言的文本（含 className，便于查骨架） */
function renderToText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(renderToText).join('');
  const element = node as { __isElement?: true; type?: unknown; props?: Record<string, unknown> };
  if (element.__isElement !== true) return '';
  const type = element.type;
  const props = element.props ?? {};
  if (typeof type === 'function') {
    resetHooks();
    return renderToText((type as (input: unknown) => unknown)(props));
  }
  const childNodes = [props.children, (node as { children?: unknown[] }).children].flat(4);
  const inner = childNodes.map(renderToText).join('');
  const className = typeof props.className === 'string' ? ` class="${props.className}"` : '';
  // 把无障碍/提示类属性也渲染出来：测试要能断言「问号按钮」的存在与展开状态
  const extra = ['title', 'aria-expanded', 'aria-label', 'aria-hidden', 'disabled']
    .filter((key) => props[key] !== undefined && (props[key] !== false || key.startsWith('aria-')))
    .map((key) => ` ${key}="${String(props[key])}"`)
    .join('');
  return `<${String(type)}${className}${extra}>${inner}</${String(type)}>`;
}

if (typeof component === 'function') {
  // 平台注入 t seat：两种语言各渲染一次，确认界面真的跟着变
  const zhText = renderToText(component({ t: zhTranslate }));
  panelTextZh = zhText;
  const enText = renderToText(component({ t: enTranslate }));
  check('5.8 中文环境下渲染出中文界面', zhText.includes('C 盘清理') && zhText.includes('预演') && zhText.includes('确认执行'), zhText.slice(0, 120));
  check(
    '5.9 英文环境下渲染出英文界面（无中文残留）',
    enText.includes('C: drive cleanup') && enText.includes('Preview') && enText.includes('Confirm and run') && !/\p{Script=Han}/u.test(enText.replace(/[\u3001\uFF08\uFF09\uFF5C]/gu, '')),
    enText.slice(0, 160),
  );

  // 平台不给 t seat（非 Web 宿主/极简装配）也要能渲染
  try {
    const fallbackText = renderToText(component({}));
    check('5.10 没有 t seat 时也能渲染（按浏览器语言自选字典）', fallbackText.length > 0, fallbackText.slice(0, 80));
  } catch (error) {
    check('5.10 没有 t seat 时也能渲染（按浏览器语言自选字典）', false, String(error));
  }

  check('5.11 首屏就去拉宿主状态（state 端点）', rpcCalls.some((call) => call.endpoint === 'state'), rpcCalls.map((call) => call.endpoint).join(' | '));
  check(
    '5.12 每次调用都带语言（宿主据此返回对应语言的规则说明/拒绝理由）',
    rpcCalls.every((call) => typeof (call.payload as { locale?: unknown } | undefined)?.locale === 'string'),
    JSON.stringify(rpcCalls[0]?.payload),
  );

  // 工具栏：三组相邻按钮的分组结构 + 问号说明在「预演」旁边
  const toolbarIndex = zhText.indexOf('class="wcc_toolbar"');
  const toolbar = toolbarIndex === -1 ? '' : zhText.slice(toolbarIndex, zhText.indexOf('</div>', zhText.indexOf('wcc_group', toolbarIndex)));
  const groups = (zhText.match(/class="wcc_group"/g) ?? []).length;
  check('5.13 工具栏分成三组相邻按钮', groups === 3, `wcc_group 出现 ${groups} 次`);
  const order = ['范围', '扫描 C 盘', '已选', '清空选择', '删除方式', '预演', '确认执行'].map((token) => zhText.indexOf(token));
  check(
    '5.14 按钮顺序符合要求（范围→扫描｜已选→清空｜删除方式→预演→确认执行）',
    order.every((index, position) => index >= 0 && (position === 0 || index > (order[position - 1] ?? -1))),
    `位置：${order.join(', ')}`,
  );
  check(
    '5.15 「预演」旁边有问号说明按钮（点击展开说明）',
    /class="wcc_help"/.test(zhText) && zhText.includes('aria-expanded="false"') && zhText.includes('预演是做什么的？'),
    toolbar.slice(0, 60),
  );

  // 组后流向箭头：「扫描」与「清空选择」后面各一个，且在「已选」「删除方式」之前
  const arrows = (zhText.match(/class="wcc_arrow"/g) ?? []).length;
  const scanAt = zhText.indexOf('扫描 C 盘');
  const arrow1 = zhText.indexOf('class="wcc_arrow"');
  const selectedAt = zhText.indexOf('已选');
  const clearAt = zhText.indexOf('清空选择');
  const arrow2 = zhText.indexOf('class="wcc_arrow"', arrow1 + 1);
  const modeAt = zhText.indexOf('删除方式');
  const arrowShape = (zhText.match(/aria-hidden="true">→</g) ?? []).length;
  check(
    '5.16 「扫描」「清空选择」后面各有一个向右箭头（共 2 个，且都对读屏隐藏）',
    arrows === 2 && arrowShape === 2,
    `箭头 ${arrows} 个 / 带 aria-hidden 的 → ${arrowShape} 个`,
  );
  check(
    '5.17 箭头位置正确（扫描 → 已选 → 清空 → 删除方式，符合三组流向）',
    scanAt >= 0 && scanAt < arrow1 && arrow1 < selectedAt && selectedAt < clearAt && clearAt < arrow2 && arrow2 < modeAt,
    `扫描=${scanAt} 箭头1=${arrow1} 已选=${selectedAt} 清空=${clearAt} 箭头2=${arrow2} 删除方式=${modeAt}`,
  );
}

// ---------- 6. 语言服务接入（时序：等 locale 就绪再接线） ----------
console.log('\n--- 6. 语言服务接入 ---');
{
  const dictCalls: Array<{ ns: string; locale: string; keys: number }> = [];
  let active = 'zh';
  const bound = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
  const fakeLocale = {
    register: (ns: string, locale: string, dict: Record<string, string>) => {
      dictCalls.push({ ns, locale, keys: Object.keys(dict).length });
      return () => {};
    },
    // 平台语义：bind 出来的翻译函数是"活"的，调用时按当时的语言渲染
    bind: (ns: string) => {
      const cached = bound.get(ns);
      if (cached !== undefined) return cached;
      const live = (key: string): string => (active === 'en' ? i18n.DICTS.en[key] : i18n.DICTS.zh[key]) ?? key;
      bound.set(ns, live);
      return live;
    },
    getLocale: () => ({ active, locales: [{ id: 'zh', label: '中文' }, { id: 'en', label: 'English' }], revision: active === 'en' ? 2 : 1 }),
  };

  const injected: string[] = [];
  const registrations: Array<{ options: Record<string, unknown> }> = [];
  const localeApiCalls: Array<{ endpoint: string; payload: unknown }> = [];
  const localeCtx = {
    effect: (callback: () => (() => void) | void) => {
      callback();
      return () => {};
    },
    get: (name: string) =>
      name === 'locale' ? fakeLocale : name === 'connection' ? {
        rpc: {
          call: (_c: string, endpoint: string, payload: unknown) => {
            localeApiCalls.push({ endpoint, payload });
            return Promise.resolve({ ok: true, value: fakeState });
          },
        },
      } : undefined,
    inject: (names: string[], callback: () => void) => {
      injected.push(...names);
      callback();
    },
    slots: {
      inject: (_key: string, callback: () => unknown) => callback(),
      register: (options: Record<string, unknown>, component: (props: unknown) => unknown) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };

  try {
    (exports_.apply as (ctx: unknown) => void)(localeCtx);
    check('6.1 有 ctx.inject 时先等 locale 服务就绪再接线', injected.join(',') === 'locale', JSON.stringify(injected));
  } catch (error) {
    check('6.1 有 ctx.inject 时先等 locale 服务就绪再接线', false, String(error));
  }
  check(
    '6.2 中英两套字典都登记到同一个命名空间（缺一套就是半翻译）',
    dictCalls.length === 2 &&
      dictCalls.every((call) => call.ns === i18n.LOCALE_NS) &&
      dictCalls.map((call) => call.locale).sort().join(',') === 'en,zh' &&
      dictCalls.every((call) => call.keys > 100),
    JSON.stringify(dictCalls),
  );
  const localeLabel = registrations[0]?.options.label;
  check(
    '6.3 tab 标题 thunk 走平台 bind（活翻译函数）',
    typeof localeLabel === 'function' && (localeLabel as () => string)() === '磁盘清理',
    String(typeof localeLabel === 'function' ? (localeLabel as () => string)() : localeLabel),
  );
  active = 'en';
  check(
    '6.4 语言切到英文后，同一个 thunk 立刻返回英文标题（无需重新注册）',
    (localeLabel as () => string)() === 'Disk cleanup',
    (localeLabel as () => string)(),
  );
  const localeComponent = registrations[0]?.component;
  const enRendered = typeof localeComponent === 'function' ? renderToText(localeComponent({ t: fakeLocale.bind(i18n.LOCALE_NS) })) : '';
  check(
    '6.5 平台注入的 t seat 与 thunk 用同一套字典（英文界面一致）',
    enRendered.includes('Confirm and run') && !/\p{Script=Han}/u.test(enRendered),
    enRendered.slice(0, 100),
  );
  check(
    '6.6 面板调用带上语言服务当前的语言（en）',
    localeApiCalls.length > 0 && localeApiCalls.every((call) => (call.payload as { locale?: string })?.locale === 'en'),
    JSON.stringify(localeApiCalls[0]?.payload),
  );
}

// ---------- 7. 可辨识度：按钮与说明 icon 的样式（用户可见性要求，回归要守住） ----------
console.log('\n--- 7. 按钮与说明 icon 的可辨识度 ---');
{
  const cssText = source; // bundle 内嵌的就是这份 CSS，断言的就是浏览器真正拿到的东西
  const actionRules = cssText.match(/\.wcc_btn_action[^{]*\{/g) ?? [];
  check(
    '7.1 「扫描/清空选择/预演」用的显眼按钮样式，且每条规则都只在可用时生效',
    actionRules.length >= 3 && actionRules.every((rule) => rule.includes(':not(:disabled)')),
    actionRules.join(' '),
  );
  const actionBlock = cssText.slice(cssText.indexOf('.wcc_btn_action:not(:disabled){'));
  check(
    '7.2 显眼按钮有加粗描边 + 品牌色 + 底色 + 投影（一眼可辨是按钮）',
    /border:2px solid var\(--dsw-alias-brand-primary/.test(actionBlock) &&
      /color:var\(--dsw-alias-brand-primary/.test(actionBlock) &&
      /font-weight:600/.test(actionBlock) &&
      /box-shadow/.test(actionBlock) &&
      /color-mix\(in srgb, var\(--dsw-alias-brand-primary/.test(actionBlock),
    actionBlock.slice(0, 120),
  );
  check(
    '7.3 禁用态外观不变（浅底灰边 + 半透明，不能把"不能点"画成"能点"）',
    /\.wcc_btn:disabled\{opacity:\.5;cursor:not-allowed\}/.test(cssText) && !/\.wcc_btn_action:disabled/.test(cssText),
  );
  const actionButtons = (panelTextZh.match(/class="wcc_btn wcc_btn_action"/g) ?? []).length;
  check(
    '7.8 「扫描 C 盘」「清空选择」「预演」三个按钮都挂上了显眼样式',
    actionButtons === 3,
    `挂上 ${actionButtons} 个（应为 3）`,
  );
  const arrowBlock = cssText.slice(cssText.indexOf('.wcc_arrow{'), cssText.indexOf('.wcc_arrow{') + 260);
  const arrowMargin = /margin:0 (\d+)px/.exec(arrowBlock);
  check(
    '7.9 流向箭头左右留白够大（≥ 8px，叠上组内 gap 更松），且不抢交互',
    arrowMargin !== null && Number(arrowMargin[1]) >= 8 && /pointer-events:none/.test(arrowBlock),
    arrowMargin === null ? arrowBlock.slice(0, 80) : `margin 左右 ${arrowMargin[1]}px + 组内 gap 6px`,
  );
  const helpBlock = cssText.slice(cssText.indexOf('.wcc_help{'), cssText.indexOf('.wcc_help_on{'));
  check(
    '7.4 问号 icon 更显眼（加大 + 2px 品牌色描边 + 底色淡染 + 加粗 + 投影）',
    /width:24px;height:24px/.test(helpBlock) &&
      /border:2px solid var\(--dsw-alias-brand-primary/.test(helpBlock) &&
      /font-size:15px;font-weight:700/.test(helpBlock) &&
      /color-mix\(in srgb, var\(--dsw-alias-brand-primary/.test(helpBlock) &&
      /box-shadow/.test(helpBlock),
    helpBlock.slice(0, 110),
  );

  // 说明内容要"简单直白"：条目少、篇幅短、第一句就说清不删东西
  const zhBody = i18n.DICTS.zh['help.preview.body'] ?? '';
  const enBody = i18n.DICTS.en['help.preview.body'] ?? '';
  const zhLimits = i18n.DICTS.zh['help.preview.limits'] ?? '';
  const enLimits = i18n.DICTS.en['help.preview.limits'] ?? '';
  check(
    '7.5 说明够简短（正文 ≤ 4 条、中文 ≤ 200 字、英文 ≤ 460 字符）',
    (zhBody.match(/·/g) ?? []).length <= 4 &&
      (enBody.match(/·/g) ?? []).length <= 4 &&
      zhBody.length <= 200 &&
      enBody.length <= 460,
    `zh=${zhBody.length} 字/${(zhBody.match(/·/g) ?? []).length} 条，en=${enBody.length} 字符/${(enBody.match(/·/g) ?? []).length} 条`,
  );
  check(
    '7.6 第一句就直白说清「预演不删任何东西」（中英都如此）',
    /什么都不删/.test(zhBody) && /nothing is deleted/.test(enBody),
    `${zhBody.split('\n')[0]} ｜ ${enBody.split('\n')[0]}`,
  );
  check(
    '7.7 注意事项也保留（篇幅压缩了，但两个诚实边界没说丢）',
    /估算/.test(zhLimits) && /占用/.test(zhLimits) && /estimate/.test(enLimits) && /locked/.test(enLimits),
    `${zhLimits.slice(0, 40)}…`,
  );
}

console.log(`\n=== 结果：${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
if (failed > 0) process.exitCode = 1;