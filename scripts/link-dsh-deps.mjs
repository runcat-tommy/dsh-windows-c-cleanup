/**
 * 把本机 DSH 安装里的 @deepseek-ai/* 包补齐到本项目 node_modules（用目录联接，不需要管理员）。
 *
 * 为什么需要这一步：`dsh-tools` / `dsh-llm` 把运行时依赖（dsh-scope、dsh-session、dsh-timeout…）
 * 声明成 **peerDependencies**，而：
 *   - `npm install --legacy-peer-deps` 不会安装 peer 依赖；
 *   - 不带该参数的 `npm install` 又会按 peer 解析把已装的东西 prune 掉，
 *     结果测试跑起来就是 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-xxx'`。
 *
 * 直接链到宿主自己那份副本有两个好处：不用联网，且**版本与宿主严格一致**——
 * 测试跑的就是宿主真实加载的那套包。
 *
 * 用法：node scripts/link-dsh-deps.mjs [DSH 安装目录]
 */
import { existsSync, readdirSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scopeDir = path.join(projectRoot, 'node_modules', '@deepseek-ai');

const candidates = [
  process.argv[2],
  process.env.DSH_INSTALL_DIR,
  path.join(path.dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'),
  'C:\\Users\\99148\\AppData\\Local\\nvm\\v22.18.0\\node_modules\\@deepseek-ai\\dsh',
].filter((entry) => typeof entry === 'string' && entry.length > 0);

const dshRoot = candidates.find((entry) => existsSync(path.join(entry, 'package.json')));
if (dshRoot === undefined) {
  console.error('找不到 DSH 安装目录：请把路径作为参数传入，或设置 DSH_INSTALL_DIR。');
  process.exitCode = 1;
} else {
  const sourceScope = path.join(dshRoot, 'node_modules', '@deepseek-ai');
  if (!existsSync(sourceScope)) {
    console.error(`DSH 安装目录里没有 @deepseek-ai 依赖：${sourceScope}`);
    process.exitCode = 1;
  } else {
    mkdirSync(scopeDir, { recursive: true });
    let linked = 0;
    let skipped = 0;
    for (const entry of readdirSync(sourceScope, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = path.join(scopeDir, entry.name);
      if (existsSync(target)) {
        skipped++;
        continue;
      }
      symlinkSync(path.join(sourceScope, entry.name), target, 'junction');
      linked++;
    }
    // 顺带补上 DSH 依赖里非 @deepseek-ai 的运行时包（例如 cosmokit 之外的传递依赖）
    const sourceTop = path.join(dshRoot, 'node_modules');
    for (const entry of readdirSync(sourceTop, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('@')) continue;
      const target = path.join(projectRoot, 'node_modules', entry.name);
      if (existsSync(target)) continue;
      try {
        if (lstatSync(path.join(sourceTop, entry.name)).isDirectory()) {
          symlinkSync(path.join(sourceTop, entry.name), target, 'junction');
          linked++;
        }
      } catch {
        /* 个别包（例如 .bin 之类）跳过即可 */
      }
    }
    console.log(`DSH 安装目录：${dshRoot}`);
    console.log(`新链接 ${linked} 个包，已存在 ${skipped} 个（幂等，可重复运行）`);
  }
}
