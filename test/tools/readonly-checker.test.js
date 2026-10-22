import { test, expect } from 'vitest';
import { isL0ReadOnly } from '../../src/tools/core/readonly-checker.js';

function shell(cmd) {
  return { type: 'shell', shellType: 'cmd', rawCommand: cmd, cwd: 'D:\\', env: {} };
}
function pwsh(cmd) {
  return { type: 'process', executable: 'powershell', args: ['-NoProfile', '-Command', cmd], cwd: 'D:\\', env: {} };
}

test('CMD: 基础安全命令通过', () => {
  expect(isL0ReadOnly(shell('ver'))).toBe(true);
  expect(isL0ReadOnly(shell('VER'))).toBe(true);
  expect(isL0ReadOnly(shell('where msbuild'))).toBe(true);
  expect(isL0ReadOnly(shell('where gcc.exe'))).toBe(true);
  expect(isL0ReadOnly(shell('dir'))).toBe(true);
  expect(isL0ReadOnly(shell('dir /a /b'))).toBe(true);
  expect(isL0ReadOnly(shell('dir /w'))).toBe(true);
});

test('CMD: 危险字符直接拦截', () => {
  expect(isL0ReadOnly(shell('dir > out.txt'))).toBe(false);
  expect(isL0ReadOnly(shell('dir | findstr a'))).toBe(false);
  expect(isL0ReadOnly(shell('dir & echo hi'))).toBe(false);
  expect(isL0ReadOnly(shell('dir ; rm -rf /'))).toBe(false);
  expect(isL0ReadOnly(shell('dir `whoami`'))).toBe(false);
  expect(isL0ReadOnly(shell('dir %PATH%'))).toBe(false);
  expect(isL0ReadOnly(shell('dir "C:\\test"'))).toBe(false);
  expect(isL0ReadOnly(shell('dir \n echo hi'))).toBe(false);
});

test('CMD: 逃逸和非法参数拦截', () => {
  expect(isL0ReadOnly(shell('dir /s'))).toBe(false);
  expect(isL0ReadOnly(shell('where ..\\evil'))).toBe(false);
  expect(isL0ReadOnly(shell('where C:\\Windows\\explorer.exe'))).toBe(false);
});

test('CMD: 已知 binary 版本查询通过（收窄后）', () => {
  expect(isL0ReadOnly(shell('gcc --version'))).toBe(true);
  expect(isL0ReadOnly(shell('node -v'))).toBe(true);
  expect(isL0ReadOnly(shell('python --version'))).toBe(true);
  expect(isL0ReadOnly(shell('git --version'))).toBe(true);
  expect(isL0ReadOnly(shell('clang++ -v'))).toBe(true);
});

test('CMD: 已从白名单移除的 binary 现在被拒', () => {
  expect(isL0ReadOnly(shell('rustc --version'))).toBe(false);
  expect(isL0ReadOnly(shell('cargo --version'))).toBe(false);
  expect(isL0ReadOnly(shell('mvn --version'))).toBe(false);
  expect(isL0ReadOnly(shell('gradle --version'))).toBe(false);
  expect(isL0ReadOnly(shell('go version'))).toBe(false);
  expect(isL0ReadOnly(shell('java -version'))).toBe(false);
});

test('CMD: 未知 binary 版本查询被拒', () => {
  expect(isL0ReadOnly(shell('mytool --version'))).toBe(false);
  expect(isL0ReadOnly(shell('evil-exe -v'))).toBe(false);
  expect(isL0ReadOnly(shell('foo --version'))).toBe(false);
});

test('CMD: 版本查询伪装的危险命令被拒', () => {
  expect(isL0ReadOnly(shell('./node -v'))).toBe(false);
  expect(isL0ReadOnly(shell('node -v > out.txt'))).toBe(false);
  expect(isL0ReadOnly(shell('node --version --eval "bad"'))).toBe(false);
  expect(isL0ReadOnly(shell('node -v && rm -rf'))).toBe(false);
});

test('PowerShell: 基础安全命令通过', () => {
  expect(isL0ReadOnly(pwsh('Get-Location'))).toBe(true);
  expect(isL0ReadOnly(pwsh('get-date'))).toBe(true);
  expect(isL0ReadOnly(pwsh('pwd'))).toBe(true);
  expect(isL0ReadOnly(pwsh('Get-PSDrive'))).toBe(true);
});

test('PowerShell: 带管道或复杂参数的拦截', () => {
  expect(isL0ReadOnly(pwsh('Get-PSDrive -PSProvider FileSystem | Select-Object'))).toBe(false);
  expect(isL0ReadOnly(pwsh('Get-PSDrive | Format-Table'))).toBe(false);
  expect(isL0ReadOnly(pwsh('Get-ChildItem > out.txt'))).toBe(false);
  expect(isL0ReadOnly(pwsh('Get-Location; Remove-Item C:\\x'))).toBe(false);
  expect(isL0ReadOnly(pwsh('Get-Process -Id $pid'))).toBe(false);
  expect(isL0ReadOnly(pwsh('Get-ChildItem "C:\\"'))).toBe(false);
});

test('PowerShell: 已知 binary 版本查询通过', () => {
  expect(isL0ReadOnly(pwsh('gcc --version'))).toBe(true);
  expect(isL0ReadOnly(pwsh('node -v'))).toBe(true);
});

test('PowerShell: 未知 binary 版本查询被拒', () => {
  expect(isL0ReadOnly(pwsh('mytool --version'))).toBe(false);
});

test('PowerShell: 非 execFile 形式的 powershell 拦截', () => {
  expect(isL0ReadOnly({ type: 'process', executable: 'powershell', args: ['-c', 'dir'], cwd: 'D:\\', env: {} })).toBe(false);
  expect(isL0ReadOnly({ type: 'process', executable: 'powershell', args: ['-NoProfile', '-Command'], cwd: 'D:\\', env: {} })).toBe(false);
});

test('其他 executable 拦截', () => {
  expect(isL0ReadOnly({ type: 'process', executable: 'cmd', args: ['/c', 'dir'], cwd: 'D:\\', env: {} })).toBe(false);
  expect(isL0ReadOnly({ type: 'process', executable: 'bash', args: ['-c', 'ls'], cwd: 'D:\\', env: {} })).toBe(false);
});
