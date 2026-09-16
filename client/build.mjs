/**
 * 客户端 bundle 构建：把 client/src/index.tsx 打成浏览器能直接执行的 classic script。
 *
 * 产物的外层形态必须与内置包逐字一致（否则 cordis 客户端 Loader 认不出）：
 *
 *   window.__ModuleLoader__.load({
 *     id: "<包名>",
 *     factory: (require) => { var module = { exports: {} }; var exports = module.exports; … return module.exports; }
 *   });
 *
 * 关键点：
 *  - `id` 必须等于包名（graph row 的键），否则浏览器报"注册键与执行的 graph row 不一致"；
 *  - React 等 seed 表成员一律 **external**，运行期由 shell 的模块表提供（打进 bundle 会导致
 *    两份 React，hooks 直接失效）；
 *  - 第三方库没有 seed，只能打进 bundle（这里没有第三方库）。
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const id = pkg.name;

await build({
  entryPoints: ['client/src/index.tsx'],
  outfile: 'client/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  sourcemap: true,
  logLevel: 'info',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
  banner: {
    js: [
      '// 由 client/build.mjs 生成：注册 lazy-CJS 工厂，模块体在首次 materialize 时执行',
      'window.__ModuleLoader__.load({',
      `\tid: ${JSON.stringify(id)},`,
      '\tfactory: (require) => {',
      '\t\tvar module = { exports: {} };',
      '\t\tvar exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: ['\t\treturn module.exports;', '\t}', '});'].join('\n'),
  },
});

console.log(`client bundle 已生成：client/client.js（id=${id}）`);
