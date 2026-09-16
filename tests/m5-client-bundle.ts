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
  scheduler: { enabled: false, description: '未启用（config.schedule.enabled = false）' },
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
    register: (options: { name: string; id: string; order?: number; label?: string }, component: (props: unknown) => unknown) => {
      if (options.name !== 'conversation.view') throw new Error(`插槽名不对：${options.name}`);
      registered.push({ key: options.id, component });
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

const component = registered[0]?.component;
check('4.4 组件是函数组件', typeof component === 'function');

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
  return `<${String(type)}${className}>${inner}</${String(type)}>`;
}

if (typeof component === 'function') {
  try {
    const text = renderToText(component({}));
    check('4.5 首屏能渲染（无异常）', text.length > 0);
    check(
      '4.6 首屏渲染出面板骨架与标题',
      text.includes('wcc_panel') && text.includes('C 盘清理'),
      text.slice(0, 160),
    );
    check('4.7 首屏就去拉宿主状态（state 端点）', rpcCalls.some((call) => call.endpoint === 'state'), rpcCalls.map((call) => call.endpoint).join(' | '));
    check('4.8 调用走的就是面板通道 /dsh-c-cleanup', rpcCalls.length > 0, `${rpcCalls.length} 次调用`);
  } catch (error) {
    check('4.5 首屏能渲染（无异常）', false, String(error));
  }
}

console.log(`\n=== 结果：${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
if (failed > 0) process.exitCode = 1;
