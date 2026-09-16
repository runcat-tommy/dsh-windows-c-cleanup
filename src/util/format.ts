/** 通用格式化工具（报告与工具输出共用） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function formatGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatPercent(part: number, total: number): string {
  if (total <= 0) return '0%';
  return `${((part / total) * 100).toFixed(0)}%`;
}

/** 报告里把长路径缩短（用 ~ 代替用户主目录） */
export function shortPath(p: string, max = 72): string {
  const home = process.env.USERPROFILE;
  let out = p;
  if (home && out.toLowerCase().startsWith(home.toLowerCase())) out = `~${out.slice(home.length)}`;
  if (out.length <= max) return out;
  const parts = out.split('\\');
  if (parts.length <= 3) return out;
  return `${parts[0]}\\…\\${parts.slice(-2).join('\\')}`;
}

export function nowStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
