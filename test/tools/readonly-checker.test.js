import { test, expect } from 'vitest';
import { isL0ReadOnly } from '../../src/tools/core/readonly-checker.js';

function shell(cmd) {
  return { type: 'shell', shellType: 'cmd', rawCommand: cmd, cwd: 'D:\\', env: {} };
}
function pwsh(cmd) {
  return { type: 'process', executable: 'powershell', args: ['-NoProfile', '-Command', cmd], cwd: 'D:\\', env: {} };
}

// ============ CMD 单命令白名单 ============

test('CMD 单命令: ver / where / dir / binary --version 通过', () => {
  expect(isL0ReadOnly(shell('ver'))).toBe(true);
  expect(isL0ReadOnly(shell('VER'))).toBe(true);
  expect(isL0ReadOnly(shell('where msbuild'))).toBe(true);
  expect(isL0ReadOnly(shell('where gcc.exe'))).toBe(true);
  expect(isL0ReadOnly(shell('dir'))).toBe(true);
  expect(isL0ReadOnly(shell('dir /a /b'))).toBe(true);
  expect(isL0ReadOnly(shell('dir /w'))).toBe(true);
  expect(isL0ReadOnly(shell('gcc --version'))).toBe(true);
  expect(isL0ReadOnly(shell('node -v'))).toBe(true);
  expect(isL0ReadOnly(shell('python --version'))).toBe(true);
  expect(isL0ReadOnly(shell('git --version'))).toBe(true);
  expect(isL0ReadOnly(shell('clang++ -v'))).toBe(true);
});

test('CMD 单命令: echo 独立使用被拒', () => {
  expect(isL0ReadOnly(shell('echo "hello"'))).toBe(false);
  expect(isL0ReadOnly(shell('echo "del C:\\\\x"'))).toBe(false);
  expect(isL0ReadOnly(shell('echo hi'))).toBe(false);
});

test('CMD 单命令: 危险字符直接拦截', () => {
  expect(isL0ReadOnly(shell('dir > out.txt'))).toBe(false);
  expect(isL0ReadOnly(shell('dir | findstr a'))).toBe(false);
  expect(isL0ReadOnly(shell('dir & echo hi'))).toBe(false);
  expect(isL0ReadOnly(shell('dir ; rm -rf /'))).toBe(false);
  expect(isL0ReadOnly(shell('dir `whoami`'))).toBe(false);
  expect(isL0ReadOnly(shell('dir %PATH%'))).toBe(false);
  expect(isL0ReadOnly(shell('dir "C:\\\\test" & echo a'))).toBe(false);
});

test('CMD 单命令: 危险参数与逃逸被拒', () => {
  expect(isL0ReadOnly(shell('dir /s'))).toBe(false);
  expect(isL0ReadOnly(shell('dir /s /b'))).toBe(false);
  expect(isL0ReadOnly(shell('where ..\\\\evil'))).toBe(false);
  expect(isL0ReadOnly(shell('where C:\\\\Windows\\\\explorer.exe'))).toBe(false);
});

test('CMD 单命令: 版本查询伪装被拒', () => {
  expect(isL0ReadOnly(shell('./node -v'))).toBe(false);
  expect(isL0ReadOnly(shell('node -v > out.txt'))).toBe(false);
  expect(isL0ReadOnly(shell('node --version --eval "bad"'))).toBe(false);
  expect(isL0ReadOnly(shell('node -v && rm -rf'))).toBe(false);
});

test('CMD 单命令: 已从白名单移除的 binary 被拒', () => {
  expect(isL0ReadOnly(shell('rustc --version'))).toBe(false);
  expect(isL0ReadOnly(shell('cargo --version'))).toBe(false);
  expect(isL0ReadOnly(shell('mvn --version'))).toBe(false);
  expect(isL0ReadOnly(shell('gradle --version'))).toBe(false);
  expect(isL0ReadOnly(shell('go version'))).toBe(false);
  expect(isL0ReadOnly(shell('java -version'))).toBe(false);
});

test('CMD 单命令: 未知 binary 版本查询被拒', () => {
  expect(isL0ReadOnly(shell('mytool --version'))).toBe(false);
  expect(isL0ReadOnly(shell('evil-exe -v'))).toBe(false);
});

// ============ CMD 链式命令 ============

test('CMD 链式: echo + dir 合法组合通过', () => {
  const fig5 = 'echo "=== sig ===" & dir /b "C:\\\\a" 2>nul & echo "=== plg ===" & dir /b "C:\\\\b"';
  expect(isL0ReadOnly(shell(fig5))).toBe(true);
  expect(isL0ReadOnly(shell('echo "x" & dir /b "C:\\\\a"'))).toBe(true);
  expect(isL0ReadOnly(shell('dir /b 2>nul & echo "done"'))).toBe(true);
});

test('CMD 链式: 混入单命令白名单被拒', () => {
  expect(isL0ReadOnly(shell('gcc --version & dir /b'))).toBe(false);
  expect(isL0ReadOnly(shell('where msbuild & echo "x"'))).toBe(false);
  expect(isL0ReadOnly(shell('ver & dir'))).toBe(false);
});

test('CMD 链式: 混入危险命令被拒', () => {
  expect(isL0ReadOnly(shell('dir /b & del C:\\\\x'))).toBe(false);
  expect(isL0ReadOnly(shell('dir & Remove-Item C:\\\\x'))).toBe(false);
  expect(isL0ReadOnly(shell('dir /b > actual.txt & echo "x"'))).toBe(false);
});

test('CMD 链式: 引号歧义被拒', () => {
  expect(isL0ReadOnly(shell('echo "a & b" & dir'))).toBe(false);
  expect(isL0ReadOnly(shell('echo "unclosed'))).toBe(false);
});

test('CMD: 重定向仅 >nul / 2>nul 在链式中放行', () => {
  expect(isL0ReadOnly(shell('dir /b 2>nul & echo "x"'))).toBe(true);
  expect(isL0ReadOnly(shell('echo "x" & dir /b > actual.txt'))).toBe(false);
  expect(isL0ReadOnly(shell('dir /b 2>>err.txt & echo "x"'))).toBe(false);
});

// ============ PowerShell ============

test('PowerShell: 基础安全命令通过', () => {
  expect(isL0ReadOnly(pwsh('Get-Location'))).toBe(true);
  expect(isL0ReadOnly(pwsh('get-date'))).toBe(true);
  expect(isL0ReadOnly(pwsh('pwd'))).toBe(true);
  expect(isL0ReadOnly(pwsh('Get-PSDrive'))).toBe(true);
});

test('PowerShell: 管道与复杂脚本块拦截', () => {
  expect(isL0ReadOnly(pwsh('Get-PSDrive -PSProvider FileSystem | Select-Object'))).toBe(false);
  expect(isL0ReadOnly(pwsh('Get-PSDrive | Format-Table'))).toBe(false);
  expect(isL0ReadOnly(pwsh('Get-ChildItem > out.txt'))).toBe(false);
  expect(isL0ReadOnly(pwsh('Get-Location; Remove-Item C:\\\\x'))).toBe(false);
  expect(isL0ReadOnly(pwsh('Get-Process -Id $pid'))).toBe(false);
  expect(isL0ReadOnly(pwsh('Get-ChildItem "C:\\\\"'))).toBe(false);
});

test('PowerShell: 已知 binary 版本查询通过', () => {
  expect(isL0ReadOnly(pwsh('gcc --version'))).toBe(true);
  expect(isL0ReadOnly(pwsh('node -v'))).toBe(true);
});

test('PowerShell: 未知 binary 被拒', () => {
  expect(isL0ReadOnly(pwsh('mytool --version'))).toBe(false);
});

test('PowerShell: 非 execFile 形式拦截', () => {
  expect(isL0ReadOnly({ type: 'process', executable: 'powershell', args: ['-c', 'dir'], cwd: 'D:\\', env: {} })).toBe(false);
  expect(isL0ReadOnly({ type: 'process', executable: 'powershell', args: ['-NoProfile', '-Command'], cwd: 'D:\\', env: {} })).toBe(false);
});

// ============ 其他 executable 拦截 ============

test('其他 executable 拦截', () => {
  expect(isL0ReadOnly({ type: 'process', executable: 'cmd', args: ['/c', 'dir'], cwd: 'D:\\', env: {} })).toBe(false);
  expect(isL0ReadOnly({ type: 'process', executable: 'bash', args: ['-c', 'ls'], cwd: 'D:\\', env: {} })).toBe(false);
});


// ============ 边界：重定向前必须有空格 ============

test('CMD: 无空格的重定向（dir /b2>nul / dir /b>nul）必须走 L2', () => {
  // 这两个形式不应被当作路径或自动放行
  expect(isL0ReadOnly(shell('dir /b2>nul'))).toBe(false);
  expect(isL0ReadOnly(shell('dir /b>nul'))).toBe(false);
  expect(isL0ReadOnly(shell('dir/a>nul'))).toBe(false);
  expect(isL0ReadOnly(shell('dir /b 2>nul'))).toBe(false); // 单命令仍拒（不剥离）
});
