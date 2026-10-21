import { test, expect } from 'vitest';
import { extractEffectiveCommand, isHighRiskCommand } from '../../src/tools/core/default-handler.js';

// ============ extractEffectiveCommand ============

test('extractEffectiveCommand: ShellRequest 原样返回', () => {
  expect(extractEffectiveCommand({ type: 'shell', rawCommand: 'echo hi' })).toBe('echo hi');
});

test('extractEffectiveCommand: 剥离 powershell -Command 外壳', () => {
  expect(
    extractEffectiveCommand({ type: 'shell', rawCommand: 'powershell -NoProfile -Command Write-Output hi' })
  ).toBe('Write-Output hi');
});

test('extractEffectiveCommand: 剥离 pwsh -Command 外壳', () => {
  expect(
    extractEffectiveCommand({ type: 'shell', rawCommand: 'pwsh -NoProfile -Command Get-ChildItem' })
  ).toBe('Get-ChildItem');
});

test('extractEffectiveCommand: 剥离 cmd /c 外壳', () => {
  expect(
    extractEffectiveCommand({ type: 'shell', rawCommand: 'cmd /c dir' })
  ).toBe('dir');
});

test('extractEffectiveCommand: ProcessRequest 拼接 executable + args', () => {
  expect(
    extractEffectiveCommand({
      type: 'process',
      executable: 'powershell',
      args: ['-NoProfile', '-Command', 'Write-Output hi'],
    })
  ).toBe('Write-Output hi');
});

test('extractEffectiveCommand: ProcessRequest 无外壳原样拼接', () => {
  expect(
    extractEffectiveCommand({ type: 'process', executable: 'git', args: ['status'] })
  ).toBe('git status');
});

// ============ isHighRiskCommand：PowerShell ============

test('isHighRiskCommand: Remove-Item 判定为高危', () => {
  expect(isHighRiskCommand('powershell -NoProfile -Command Remove-Item -Recurse -Force D:\\__x__')).toBe(true);
});

test('isHighRiskCommand: 直接 Remove-Item 判定为高危', () => {
  expect(isHighRiskCommand('Remove-Item -Recurse -Force D:\\__x__')).toBe(true);
});

test('isHighRiskCommand: Clear-Disk 判定为高危', () => {
  expect(isHighRiskCommand('Clear-Disk -Number 0')).toBe(true);
});

test('isHighRiskCommand: Format-Volume 判定为高危', () => {
  expect(isHighRiskCommand('Format-Volume -DriveLetter D')).toBe(true);
});

test('isHighRiskCommand: Stop-Computer 判定为高危', () => {
  expect(isHighRiskCommand('Stop-Computer')).toBe(true);
});

test('isHighRiskCommand: Restart-Computer 判定为高危', () => {
  expect(isHighRiskCommand('Restart-Computer')).toBe(true);
});

test('isHighRiskCommand: 普通 PowerShell 命令判定为非高危', () => {
  expect(isHighRiskCommand('powershell -NoProfile -Command Write-Output hi')).toBe(false);
});

test('isHighRiskCommand: Get-Location 判定为非高危', () => {
  expect(isHighRiskCommand('powershell -NoProfile -Command Get-Location')).toBe(false);
});

// ============ isHighRiskCommand：bash / cmd ============

test('isHighRiskCommand: rm -rf 判定为高危', () => {
  expect(isHighRiskCommand('rm -rf /tmp/x')).toBe(true);
});

test('isHighRiskCommand: rm -r 判定为高危', () => {
  expect(isHighRiskCommand('rm -r somedir')).toBe(true);
});

test('isHighRiskCommand: del /s 判定为高危', () => {
  expect(isHighRiskCommand('del /s C:\\x')).toBe(true);
});

test('isHighRiskCommand: rd /s 判定为高危', () => {
  expect(isHighRiskCommand('rd /s C:\\x')).toBe(true);
});

test('isHighRiskCommand: format D: 判定为高危', () => {
  expect(isHighRiskCommand('format D:')).toBe(true);
});

test('isHighRiskCommand: git clean -fd 判定为高危', () => {
  expect(isHighRiskCommand('git clean -fd')).toBe(true);
});

test('isHighRiskCommand: git reset --hard 判定为高危', () => {
  expect(isHighRiskCommand('git reset --hard HEAD')).toBe(true);
});

test('isHighRiskCommand: 重定向到盘符根目录判定为高危', () => {
  expect(isHighRiskCommand('echo hi > D:\\')).toBe(true);
});

// ============ isHighRiskCommand：正常命令不误判 ============

test('isHighRiskCommand: git status 判定为非高危', () => {
  expect(isHighRiskCommand('git status')).toBe(false);
});

test('isHighRiskCommand: git log --format 判定为非高危（防止误报）', () => {
  expect(isHighRiskCommand('git log -1 --format=%B')).toBe(false);
});

test('isHighRiskCommand: dir 判定为非高危', () => {
  expect(isHighRiskCommand('dir C:\\Software')).toBe(false);
});

test('isHighRiskCommand: echo hi 判定为非高危', () => {
  expect(isHighRiskCommand('echo hi')).toBe(false);
});

test('isHighRiskCommand: cd D:\\Software\\xxx 判定为非高危（防止盘符误报）', () => {
  expect(isHighRiskCommand('cd D:\\Software\\cuckoo-code')).toBe(false);
});

test('isHighRiskCommand: npm run build 判定为非高危', () => {
  expect(isHighRiskCommand('npm run build')).toBe(false);
});

test('isHighRiskCommand: Format-Table 判定为非高危（防止 format 子串误报）', () => {
  expect(isHighRiskCommand('Get-ChildItem | Format-Table')).toBe(false);
});
