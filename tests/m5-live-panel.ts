/**
 * M5 面板的**活体验证**：直接问正在运行的 dsh web 要事实，不靠猜。
 *
 * 检查三件事：
 *  1. boot manifest（首页里的 `window.__DSH_BOOT__`）是否已经包含本插件的客户端条目；
 *  2. `/plugins/<包名>/client.js` 是否 200，且**内容与本地构建产物逐字节一致**；
 *  3. 产物里的注册 id 是否等于包名。
 *
 * 为什么必须重启宿主：包元数据（是否客户端包、`dsh.client` 字段）被宿主永久缓存，
 * 新增/删除包或改这些字段后不重启就永远是 404 —— 这正是本脚本第一条检查要证明的事。
 *
 * 运行：npm run m5:live [baseUrl]（默认 http://127.0.0.1:3080）
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const base = (process.argv[2] ?? process.env.DSH_WEB_BASE ?? 'http://127.0.0.1:3080').replace(/\/$/, '');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
const localBundle = readFileSync(new URL('../client/client.js', import.meta.url));
const localHash = createHash('sha256').update(localBundle).digest('hex');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`);
}

console.log(`=== M5 活体验证：${base}（包 ${pkg.name}@${pkg.version}）===\n`);
console.log('--- 1. 宿主是否已把本包当成客户端插件 ---');

let html = '';
try {
  const response = await fetch(`${base}/`);
  check('1.1 首页可访问（宿主在跑）', response.ok, `HTTP ${response.status}`);
  html = await response.text();
} catch (error) {
  check('1.1 首页可访问（宿主在跑）', false, String(error));
}
check('1.2 首页带 boot manifest（__DSH_BOOT__）', html.includes('__DSH_BOOT__'));

const manifestHasPackage = html.includes(pkg.name);
const occurrences = html.split(pkg.name).length - 1;
check(
  '1.3 boot manifest 已包含本插件的客户端条目',
  manifestHasPackage,
  manifestHasPackage
    ? `出现 ${occurrences} 次`
    : '未包含 → 宿主仍在使用缓存的包元数据，需要重启 `dsh web` 后刷新页面',
);
if (manifestHasPackage) {
  const index = html.indexOf(pkg.name);
  console.log(`     片段：…${html.slice(Math.max(0, index - 160), index + 120).replace(/\s+/g, ' ')}…`);
}

console.log('\n--- 2. 产物是否真的被提供，且与本地构建一致 ---');
let served: Buffer | undefined;
try {
  const response = await fetch(`${base}/plugins/${pkg.name}/client.js`);
  const body = Buffer.from(await response.arrayBuffer());
  check('2.1 /plugins/<包名>/client.js 返回 200', response.ok, `HTTP ${response.status}，${body.length} 字节`);
  if (response.ok) served = body;
  const cacheControl = response.headers.get('cache-control');
  console.log(`     content-type=${response.headers.get('content-type')} cache-control=${cacheControl ?? '(未设置)'}`);
} catch (error) {
  check('2.1 /plugins/<包名>/client.js 返回 200', false, String(error));
}

if (served !== undefined) {
  const servedHash = createHash('sha256').update(served).digest('hex');
  check(
    '2.2 宿主提供的产物与本地 client/client.js 逐字节一致',
    servedHash === localHash,
    servedHash === localHash ? `sha256=${localHash.slice(0, 16)}…` : `宿主=${servedHash.slice(0, 16)}… 本地=${localHash.slice(0, 16)}…（刷新页面通常即可，宿主对 bundle 是 no-cache）`,
  );
  const text = served.toString('utf8');
  check(
    '2.3 产物注册 id 等于包名（graph row 键必须一致）',
    text.includes(`id: "${pkg.name}"`) || text.includes(`id: '${pkg.name}'`),
  );
  check('2.4 产物是 classic script（顶层 __ModuleLoader__.load）', text.trimStart().startsWith('//') || text.includes('__ModuleLoader__.load('));
}

console.log('\n--- 3. 面板通道 ---');
console.log('    通道 /dsh-c-cleanup 注册在宿主内部（Connection RPC），浏览器侧由面板调用；');
console.log('    端到端确认需要打开 GUI 并切到「磁盘清理」tab（见下方清单）。');

console.log(`\n=== 结果：${failed === 0 ? '宿主已就绪，请在 GUI 切到「磁盘清理」tab' : `${failed} 项未就绪`} ===`);
if (failed > 0) {
  console.log('提示：重启宿主 `dsh web`（包元数据判定被永久缓存），然后刷新页面；只改 bundle 内容则刷新即可。');
  process.exitCode = 1;
}
