/**
 * 发布体检（market check）：把"能不能被 DSH 市场自动收录"的硬门槛钉成测试。
 *
 * 为什么单独一个套件：这些门槛全部是**静默失效**的——改了包名、把 patch 路径写错、
 * 顺手加了 postinstall、`screenshots.json` 指到不存在的图、README 少了安装命令，
 * 代码测试全绿，但市场那边就悄悄不再收录（或者只给"引导安装"）。
 * 收录规则来自市场自己的 README/schema（YELEBAI/dsh-plugin-marketplace）：
 *   - `dsh.bundle.patch` 指向仓库内安全相对路径，且 patch 里插入了 name 等于包名的 loader entry；
 *   - 声明 `dsh.client` 时平台必须是 `web` 且导出 `./client`；
 *   - GitHub 源只要含 preinstall/install/postinstall/prepare 就要构建审批；精确 npm tarball 不含这些才可自动安装；
 *   - README 要给出 `dsh plugin --profile ... add github:...`；
 *   - 预览图先读仓库根的 `screenshots.json`（1–8 张，svg 一律丢弃）。
 *
 * 运行：npm run market:check
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const at = (rel: string): string => fileURLToPath(new URL(rel, root));
const read = (rel: string): string => readFileSync(at(rel), 'utf8');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`);
}

const pkg = JSON.parse(read('package.json')) as {
  name: string;
  version: string;
  license?: string;
  files?: string[];
  keywords?: string[];
  scripts?: Record<string, string>;
  repository?: { type?: string; url?: string };
  homepage?: string;
  bugs?: { url?: string };
  exports?: Record<string, { default?: string } | string>;
  dsh?: {
    bundle?: { patch?: string };
    client?: { platform?: string; inject?: string[] };
    marketplace?: {
      profiles?: string[];
      requiresBuildApproval?: boolean;
      requiresRestart?: boolean;
      manualSteps?: boolean;
    };
  };
};

const REPO = 'https://github.com/runcat-tommy/dsh-windows-c-cleanup';

// ---------- 1. 包身份与仓库元数据 ----------
console.log('\n--- 1. 包身份与仓库元数据 ---');

check(
  '1.1 package.json 合法、包名符合 npm 规则、版本是语义化版本',
  /^[a-z0-9][a-z0-9._-]*$/.test(pkg.name) && /^\d+\.\d+\.\d+/.test(pkg.version),
  `${pkg.name}@${pkg.version}`,
);
check(
  '1.2 repository / homepage / bugs 三件套齐全且都指向同一个 GitHub 仓库（npm 页面与市场身份识别都靠它）',
  (pkg.repository?.url ?? '').includes('github.com/runcat-tommy/dsh-windows-c-cleanup') &&
    (pkg.homepage ?? '').startsWith(REPO) &&
    (pkg.bugs?.url ?? '').startsWith(`${REPO}/issues`),
  `repository=${pkg.repository?.url ?? '（缺）'}｜homepage=${pkg.homepage ?? '（缺）'}｜bugs=${pkg.bugs?.url ?? '（缺）'}`,
);
check(
  '1.3 keywords 含 dsh 与 dsh-plugin（npm 搜索口径与 GitHub topics 对齐）',
  (pkg.keywords ?? []).includes('dsh') && (pkg.keywords ?? []).includes('dsh-plugin'),
  (pkg.keywords ?? []).join(', '),
);
check(
  '1.4 license 字段与 LICENSE 文件一致',
  pkg.license === 'MIT' && existsSync(at('LICENSE')) && read('LICENSE').includes('MIT'),
  `license=${pkg.license ?? '（缺）'}｜LICENSE=${existsSync(at('LICENSE')) ? '存在' : '缺失'}`,
);

// ---------- 2. bundle patch（市场的第一道硬门槛）----------
console.log('\n--- 2. bundle patch ---');

const patchRel = pkg.dsh?.bundle?.patch ?? '';
check(
  '2.1 dsh.bundle.patch 是仓库内的安全相对路径且文件存在',
  patchRel.startsWith('./') && !patchRel.includes('..') && existsSync(at(patchRel)),
  patchRel || '（缺 dsh.bundle.patch）',
);

type PatchOp = { insert?: Array<{ id?: string; name?: string }> };
let patchDocs: PatchOp[] | undefined;
let parserNote = '';
try {
  const yaml = (await import('yaml')) as { parse: (text: string) => unknown };
  const parsed = yaml.parse(read('cordis.patch.yml'));
  patchDocs = Array.isArray(parsed) ? (parsed as PatchOp[]) : undefined;
  parserNote = 'YAML 解析器：yaml（严格解析）';
} catch {
  // 解析器不可用时退化成结构检查，并如实标注，不让测试因缺依赖而误红
  const text = read('cordis.patch.yml').replace(/^\s*#.*$/gm, '');
  const hasInsert = /^\s*-\s*insert:/m.test(text);
  const name = /name:\s*['"]?([^'"\n]+)['"]?/.exec(text)?.[1]?.trim();
  patchDocs = hasInsert && name === pkg.name ? [{ insert: [{ name }] }] : undefined;
  parserNote = 'YAML 解析器不可用，退化为结构检查';
}
check(
  `2.2 patch 是有效的 YAML 操作数组（${parserNote}）`,
  Array.isArray(patchDocs) && patchDocs.length > 0,
  patchDocs === undefined ? '解析结果不是数组' : `共 ${patchDocs.length} 个操作`,
);
const insertedEntries = (patchDocs ?? []).flatMap((op) => op.insert ?? []);
check(
  '2.3 patch 插入了 name 等于包名的 loader entry（市场按此认它是插件而不是普通仓库）',
  insertedEntries.some((entry) => entry.name === pkg.name),
  insertedEntries.map((entry) => `${entry.id ?? '?'}/${entry.name ?? '?'}`).join(', ') || '没有 insert 条目',
);
check(
  '2.4 loader entry 的 id 稳定（改了要同步 README 与文档）',
  insertedEntries.some((entry) => entry.id === 'windows-c-cleanup'),
  insertedEntries.map((entry) => entry.id ?? '?').join(', '),
);

// ---------- 3. 入口与打包白名单 ----------
console.log('\n--- 3. 入口与打包白名单 ---');

check(
  '3.1 声明了 dsh.client 的平台是 web（市场规则：带 web client 只映射到 web profile）',
  pkg.dsh?.client?.platform === 'web',
  `platform=${pkg.dsh?.client?.platform ?? '（缺）'}`,
);
const clientExport = pkg.exports?.['./client'];
const clientRel = (typeof clientExport === 'string' ? clientExport : clientExport?.default ?? '').replace(/^\.\//, '');
check(
  '3.2 导出 ./client 且指向仓库内文件（市场会核对 Git tree 里确实有这份运行产物）',
  clientRel !== '' && existsSync(at(clientRel)),
  clientRel || '（缺 exports["./client"]）',
);
check(
  '3.3 dsh.client.inject 是非空字符串数组（客户端接线时序靠它）',
  Array.isArray(pkg.dsh?.client?.inject) && (pkg.dsh?.client?.inject?.length ?? 0) > 0,
  (pkg.dsh?.client?.inject ?? []).join(', ') || '（空）',
);
const required = ['lib', 'client/client.js', 'cordis.patch.yml', 'src/rules/default-rules.json', 'src/rules/default-rules.en.json', 'README.md', 'README.en.md'];
const files = pkg.files ?? [];
check(
  '3.4 tarball 白名单覆盖全部运行必需项（缺一项装完就跑不起来）',
  required.every((entry) => files.some((f) => f === entry || f.startsWith(`${entry}/`))),
  `必需：${required.join(', ')}｜声明：${files.join(', ')}`,
);

// ---------- 4. 安装分类（自动安装 vs 引导安装）----------
console.log('\n--- 4. 安装分类 ---');

const scripts = pkg.scripts ?? {};
check(
  '4.1 没有 preinstall / install / postinstall（这是 npm 精确 tarball 能自动安装的前提）',
  !['preinstall', 'install', 'postinstall'].some((hook) => hook in scripts),
  Object.keys(scripts).filter((name) => ['preinstall', 'install', 'postinstall'].includes(name)).join(', ') || '三个都没有',
);
check(
  '4.2 prepare 与 prepublishOnly 都保留：前者让 GitHub 源安装能构建，后者保证 tarball 里有产物',
  scripts.prepare !== undefined && scripts.prepublishOnly !== undefined,
  `prepare=${scripts.prepare ?? '（缺）'}｜prepublishOnly=${scripts.prepublishOnly ?? '（缺）'}`,
);

// ---------- 5. 市场声明与预览图 ----------
console.log('\n--- 5. 市场声明与预览图 ---');

const marketplace = pkg.dsh?.marketplace;
check(
  '5.1 dsh.marketplace 四件套齐全且取值合理（profiles 含 web / 装完需重启 / 无人工步骤）',
  marketplace !== undefined &&
    (marketplace.profiles ?? []).includes('web') &&
    typeof marketplace.requiresBuildApproval === 'boolean' &&
    marketplace.requiresRestart === true &&
    marketplace.manualSteps === false,
  JSON.stringify(marketplace ?? '（缺 dsh.marketplace）'),
);

const shotsRaw = existsSync(at('screenshots.json')) ? JSON.parse(read('screenshots.json')) as unknown : undefined;
const shots = Array.isArray(shotsRaw) ? (shotsRaw as string[]) : [];
check(
  '5.2 screenshots.json 存在、1–8 条、路径都在仓库里',
  shots.length >= 1 && shots.length <= 8 && shots.every((rel) => existsSync(at(rel))),
  shots.join(', ') || '（缺 screenshots.json 或内容不是数组）',
);
check(
  '5.3 预览图没有 .svg（市场一律丢弃 svg，放 svg 等于没有预览图）',
  shots.length > 0 && shots.every((rel) => !rel.toLowerCase().endsWith('.svg')),
  shots.join(', '),
);
check(
  '5.4 预览图不是空文件（市场抓图会拿到 0 字节坏图）',
  shots.length > 0 && shots.every((rel) => existsSync(at(rel)) && statSync(at(rel)).size > 10_000),
  shots.map((rel) => `${rel}=${existsSync(at(rel)) ? statSync(at(rel)).size : 0}B`).join(', '),
);

// ---------- 6. 双语 README 的安装门槛 ----------
console.log('\n--- 6. 双语 README 的安装门槛 ---');

for (const readme of ['README.md', 'README.en.md']) {
  const text = read(readme);
  const hasNpm = new RegExp(`dsh plugin --profile \\S+ add ${pkg.name}`).test(text);
  const hasGithub = /dsh plugin --profile \S+ add github:\S+/.test(text);
  check(
    `6.${readme === 'README.md' ? 1 : 2} ${readme} 给出 npm 安装命令与 github: 源安装命令（市场会读 README 核验安装方式）`,
    hasNpm && hasGithub,
    `npm 命令=${hasNpm ? '有' : '缺'}｜github: 命令=${hasGithub ? '有' : '缺'}`,
  );
}
check(
  '6.3 两份 README 都出现本仓库的 owner/repo（市场用它核对条目身份，旧 owner / 别名会导致对不上）',
  ['README.md', 'README.en.md'].every((readme) => read(readme).includes('runcat-tommy/dsh-windows-c-cleanup')),
  'runcat-tommy/dsh-windows-c-cleanup',
);

console.log(`\n=== 结果：${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
process.exitCode = failed === 0 ? 0 : 1;
