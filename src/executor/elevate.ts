/**
 * 提权链路（UAC）。
 *
 * DSH 的权限栈里**没有 UAC / runas 原语**（沙箱升级只管文件写权限），
 * 因此管理员级清理必须由插件自己落地：把任务写成 PowerShell 脚本，
 * 用 `Start-Process -Verb RunAs` 触发系统 UAC 弹窗，用户点「是」后执行，
 * 执行输出写入日志文件由本插件回收。
 *
 * 安全约束：
 *  - 只执行**本插件自己生成**的脚本（不接受任意脚本字符串来自模型）；
 *  - 任务集合是白名单式的构造函数（删临时目录 / DISM / cleanmgr）；
 *  - 用户取消（拒绝 UAC）如实回报为 canceled，不当成成功。
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { nowStamp } from '../util/format.js';

export interface ElevatedTask {
  id: string;
  title: string;
  /** 由本插件生成的 PowerShell 片段（不接受外部输入） */
  script: string;
}

export interface ElevatedResult {
  attempted: boolean;
  canceled: boolean;
  scriptPath: string;
  logPath: string;
  exitCode: number | null;
  logTail: string;
  errors: string[];
}

const PS_EXE = 'powershell.exe';

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 当前进程是否已是管理员 */
export async function isElevated(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      PS_EXE,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      ],
      { windowsHide: true },
    );
    let out = '';
    child.stdout?.on('data', (chunk) => (out += String(chunk)));
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(out.trim().toLowerCase() === 'true'));
  });
}

/** 生成并执行一组提权任务（会弹出 UAC；用户拒绝则如实回报） */
export async function runElevated(
  tasks: ElevatedTask[],
  options: { timeoutMs?: number; onProgress?: (message: string) => void } = {},
): Promise<ElevatedResult> {
  const stamp = nowStamp();
  const tempDir = os.tmpdir();
  const scriptPath = path.join(tempDir, `dsh-cc-elevated-${stamp}.ps1`);
  const logPath = path.join(tempDir, `dsh-cc-elevated-${stamp}.log`);

  const body: string[] = [
    '$ErrorActionPreference = "Continue"',
    `$log = ${psQuote(logPath)}`,
    'function Log($m) { "$([DateTime]::Now.ToString(\'HH:mm:ss\')) $m" | Add-Content -LiteralPath $log -Encoding UTF8 }',
    `Log "=== windows-c-cleanup 提权任务开始（${tasks.length} 项）==="`,
  ];
  for (const task of tasks) {
    body.push(`Log "--- ${task.title} ---"`);
    body.push('try {');
    for (const line of task.script.split('\n')) body.push(`  ${line}`);
    body.push('} catch { Log ("任务失败：" + $_.Exception.Message) }');
  }
  body.push('Log "=== 全部任务结束 ==="');

  await fs.writeFile(scriptPath, body.join('\n'), 'utf8');

  const command = [
    'Start-Process',
    '-FilePath',
    psQuote(PS_EXE),
    '-ArgumentList',
    psQuote(`-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`),
    '-Verb RunAs -Wait',
  ].join(' ');

  options.onProgress?.('等待 UAC 授权（请在弹窗中点击「是」）…');

  const result = await new Promise<ElevatedResult>((resolve) => {
    const child = spawn(PS_EXE, ['-NoProfile', '-Command', command], { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 900_000);
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ attempted: false, canceled: false, scriptPath, logPath, exitCode: null, logTail: '', errors: [error.message] });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const canceled = /canceled by the user|操作已被用户取消|用户取消/i.test(stderr);
      resolve({
        attempted: !canceled,
        canceled,
        scriptPath,
        logPath,
        exitCode: code,
        logTail: '',
        errors: canceled ? ['用户取消了 UAC 授权'] : stderr.trim() ? [stderr.trim().split('\n')[0]] : [],
      });
    });
  });

  try {
    const log = await fs.readFile(logPath, 'utf8');
    result.logTail = log.split('\n').slice(-25).join('\n');
  } catch {
    /* 脚本可能未运行（用户取消） */
  }

  return result;
}

/** 删除某个需要管理员权限的目录 */
export function taskRemoveDirectory(target: string, title: string): ElevatedTask {
  return {
    id: `remove:${target.toLowerCase()}`,
    title,
    script: `Remove-Item -LiteralPath ${psQuote(target)} -Recurse -Force -ErrorAction SilentlyContinue\nif (Test-Path -LiteralPath ${psQuote(
      target,
    )}) { Log "仍有残留（可能被占用）" } else { Log "已删除" }`,
  };
}

/** DISM 组件存储清理（WinSxS） */
export function taskDismComponentCleanup(resetBase = false): ElevatedTask {
  return {
    id: 'dism:StartComponentCleanup',
    title: `DISM 组件存储清理${resetBase ? '（含 ResetBase，将无法卸载已装更新）' : ''}`,
    script: [
      `$dism = Start-Process -FilePath "$env:WINDIR\\System32\\Dism.exe" -ArgumentList "/Online","/Cleanup-Image","/StartComponentCleanup"${
        resetBase ? ',"/ResetBase"' : ''
      } -Wait -PassThru -NoNewWindow`,
      'Log ("DISM 退出码：" + $dism.ExitCode)',
    ].join('\n'),
  };
}

/** 系统磁盘清理（cleanmgr，含更新清理与传递优化文件） */
export function taskDiskCleanup(sagerunId = 5150): ElevatedTask {
  return {
    id: `cleanmgr:sagerun:${sagerunId}`,
    title: '系统磁盘清理（cleanmgr，含 Windows 更新清理）',
    script: [
      '$caches = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VolumeCaches"',
      'Get-ChildItem $caches -ErrorAction SilentlyContinue | ForEach-Object {',
      `  Set-ItemProperty -Path $_.PSPath -Name "StateFlags${sagerunId}" -Value 2 -Type DWord -ErrorAction SilentlyContinue`,
      '}',
      `Log "已配置 cleanmgr 清理项，开始执行 sagerun:${sagerunId}（可能耗时数分钟）"`,
      `$p = Start-Process -FilePath "$env:WINDIR\\System32\\cleanmgr.exe" -ArgumentList "/sagerun:${sagerunId}" -Wait -PassThru`,
      'Log ("cleanmgr 退出码：" + $p.ExitCode)',
    ].join('\n'),
  };
}
