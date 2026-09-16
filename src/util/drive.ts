/**
 * 盘符路径的唯一来源。
 *
 * 为什么必须有这个模块：这个项目里同一类 bug 已经犯过三次——
 *  1. M3：`driveOf()` 已返回 `d:`，再拼 `:\\` 得到 `D::\` → `fs.statfs` 失败 → 所有迁移被误判「目标盘空间不足」；
 *  2. 执行层：模板字面量 `` `${systemDrive}\\` `` 里 `\\` 只是一个反斜杠，拼出 `C\`（**丢了冒号**）
 *     → `statfs` 抛 ENOENT → 被 `catch` 吞掉后返回 0，报告里出现「系统盘 C 空闲 0.00 GB」这种假数字；
 *  3. 垃圾桶判断：同一个漏冒号让 `c\$recycle.bin` 永远匹配不上真实的 `c:\$recycle.bin`，特殊分支静默失效。
 *
 * 三次都是「字符串拼盘符」而不是「算盘符」造成的。所以盘符根目录一律走这里，
 * 并且配有单测：`'C'` / `'C:'` / `'c:\'` / `'C:\\'` / `' C '` 都必须归一成 `'C:\'`。
 */

/** 把各种写法的盘符归一成 `X:\`（大写盘符 + 冒号 + 反斜杠） */
export function driveRoot(input: string): string {
  const trimmed = input.trim();
  const match = /^([a-zA-Z]):?/.exec(trimmed);
  const letter = (match?.[1] ?? trimmed.charAt(0)).toUpperCase();
  return `${letter}:\\`;
}

/** 从任意路径取出盘符字母（大写，无冒号）；取不到时返回空串 */
export function driveLetterOf(target: string): string {
  const match = /^([a-zA-Z]):/.exec(target.trim());
  return match ? match[1].toUpperCase() : '';
}

/** 判断两串是否指同一个盘符（容忍 'C' / 'C:' / 'c:\' 混写） */
export function sameDrive(a: string, b: string): boolean {
  const left = driveLetterOf(a) || a.trim().charAt(0).toUpperCase();
  const right = driveLetterOf(b) || b.trim().charAt(0).toUpperCase();
  return left !== '' && left === right;
}
