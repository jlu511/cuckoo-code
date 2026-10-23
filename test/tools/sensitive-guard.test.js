import { test, expect, beforeEach } from 'vitest';
import {
  scanForSensitiveAccess,
  scanPathForSensitiveAccess,
  checkSensitivePathAccess,
  injectSensitivePathHandler,
} from '../../src/tools/core/sensitive-guard.js';

const CWD = 'D:\\proj';
const HOME = 'C:\\Users\\Lee';

function shell(cmd) {
  return { type: 'shell', shellType: 'cmd', rawCommand: cmd, cwd: CWD, env: {} };
}
function pwsh(cmd) {
  return { type: 'process', executable: 'powershell', args: ['-NoProfile', '-Command', cmd], cwd: CWD, env: {} };
}

beforeEach(() => {
  injectSensitivePathHandler(null); // 恢复默认硬拒绝
});

// ============ 命令读取分析 ============

test('scan: CMD type 读 SSH 私钥命中', () => {
  const r = scanForSensitiveAccess(shell('type C:\\Users\\Lee\\.ssh\\id_rsa'));
  expect(r.hit).toBe(true);
  expect(r.targets.length).toBeGreaterThan(0);
});

test('scan: CMD type 读 .env 命中', () => {
  const r = scanForSensitiveAccess(shell('type .env'));
  expect(r.hit).toBe(true);
});

test('scan: cat 读 .aws/credentials 命中', () => {
  const r = scanForSensitiveAccess(shell('cat C:\\Users\\Lee\\.aws\\credentials'));
  expect(r.hit).toBe(true);
});

test('scan: PS Get-Content 读 SSH 私钥命中', () => {
  const r = scanForSensitiveAccess(pwsh('Get-Content C:\\Users\\Lee\\.ssh\\id_rsa'));
  expect(r.hit).toBe(true);
});

test('scan: PS Get-Content 读 .env 命中', () => {
  const r = scanForSensitiveAccess(pwsh('Get-Content D:\\proj\\.env'));
  expect(r.hit).toBe(true);
});

test('scan: 带引号的路径命中', () => {
  const r = scanForSensitiveAccess(shell('type "C:\\Users\\Lee\\.ssh\\id_rsa"'));
  expect(r.hit).toBe(true);
});

test('scan: 相对路径基于 cwd 解析', () => {
  const r = scanForSensitiveAccess(shell('type .env'));
  expect(r.hit).toBe(true);
  // 相对路径应解析到 CWD 下
  expect(r.targets.some(t => t.includes('proj'))).toBe(true);
});

test('scan: 包装形式 cmd /c', () => {
  const r = scanForSensitiveAccess(shell('cmd /c type C:\\Users\\Lee\\.ssh\\id_rsa'));
  expect(r.hit).toBe(true);
});

test('scan: 链式命令中读取敏感文件', () => {
  const r = scanForSensitiveAccess(shell('dir & type C:\\Users\\Lee\\.ssh\\id_rsa'));
  expect(r.hit).toBe(true);
});

// ============ 不误伤 ============

test('scan: 普通文件读取不命中', () => {
  expect(scanForSensitiveAccess(shell('type src\\main.ts')).hit).toBe(false);
  expect(scanForSensitiveAccess(shell('cat README.md')).hit).toBe(false);
});

test('scan: dir 列表不命中（非读取文件内容）', () => {
  expect(scanForSensitiveAccess(shell('dir /a /b')).hit).toBe(false);
});

test('scan: 非 powershell 的 process 请求不分析', () => {
  const req = { type: 'process', executable: 'node', args: ['-v'], cwd: CWD, env: {} };
  expect(scanForSensitiveAccess(req).hit).toBe(false);
});

test('scan: 非标准 powershell 结构不分析', () => {
  const req = { type: 'process', executable: 'powershell', args: ['-c', 'type .env'], cwd: CWD, env: {} };
  expect(scanForSensitiveAccess(req).hit).toBe(false);
});

// ============ 原生文件工具用的路径检查 ============

test('scanPath: 敏感路径命中', () => {
  const r = scanPathForSensitiveAccess('C:\\Users\\Lee\\.ssh\\id_rsa');
  expect(r.hit).toBe(true);
});

test('scanPath: 普通路径不命中', () => {
  expect(scanPathForSensitiveAccess('D:\\proj\\main.ts').hit).toBe(false);
});

// ============ 处理器：默认 fail-closed ============

beforeEach(() => {
  injectSensitivePathHandler(null);
});

test('checkSensitivePathAccess: 默认处理器对敏感路径拒绝', async () => {
  const r = await checkSensitivePathAccess('C:\\Users\\Lee\\.ssh\\id_rsa', 'read');
  expect(r.allow).toBe(false);
  expect(r.reason).toContain('敏感路径');
});

test('checkSensitivePathAccess: 普通路径直接放行（不调用 handler）', async () => {
  const r = await checkSensitivePathAccess('D:\\proj\\main.ts', 'read');
  expect(r.allow).toBe(true);
});

test('checkSensitivePathAccess: 写操作也拒绝', async () => {
  const r = await checkSensitivePathAccess('C:\\Users\\Lee\\.ssh\\id_rsa', 'write');
  expect(r.allow).toBe(false);
});

test('checkSensitivePathAccess: 删除操作也拒绝', async () => {
  const r = await checkSensitivePathAccess('C:\\Users\\Lee\\.ssh\\id_rsa', 'delete');
  expect(r.allow).toBe(false);
});

test('checkSensitivePathAccess: 处理器异常 → fail closed', async () => {
  injectSensitivePathHandler(async () => { throw new Error('boom'); });
  // 必须用敏感路径，否则会在调用 handler 前提前放行
  const r = await checkSensitivePathAccess('C:\\Users\\Lee\\.ssh\\id_rsa', 'read');
  expect(r.allow).toBe(false);
  expect(r.reason).toContain('异常');
});

test('checkSensitivePathAccess: 注入自定义处理器生效', async () => {
  let called = 0;
  let capturedOp = null;
  let capturedReasons = null;
  injectSensitivePathHandler(async (abs, op, reasons) => {
    called++;
    capturedOp = op;
    capturedReasons = reasons;
    return { allow: true };
  });
  const r = await checkSensitivePathAccess('C:\\Users\\Lee\\.ssh\\id_rsa', 'write');
  expect(called).toBe(1);
  expect(r.allow).toBe(true);
  expect(capturedOp).toBe('write');
  expect(capturedReasons.length).toBeGreaterThan(0);
});

test('checkSensitivePathAccess: 非敏感路径不调用 handler', async () => {
  let called = 0;
  injectSensitivePathHandler(async () => { called++; return { allow: true }; });
  const r = await checkSensitivePathAccess('D:\\proj\\main.ts', 'read');
  expect(r.allow).toBe(true);
  expect(called).toBe(0);
});


test('scan: dir 列 .ssh 目录命中（文件名泄露）', () => {
  expect(scanForSensitiveAccess(shell('dir C:\\Users\\Lee\\.ssh')).hit).toBe(true);
});

test('scan: ls 列 .aws 目录命中', () => {
  expect(scanForSensitiveAccess(shell('ls C:\\Users\\Lee\\.aws')).hit).toBe(true);
});

test('scan: dir 普通目录不命中', () => {
  expect(scanForSensitiveAccess(shell('dir C:\\Windows')).hit).toBe(false);
});


// ============ B1：多路径参数逐一检查 ============

test('B1: type 多参数，敏感路径在第二个也必须命中', () => {
  const r = scanForSensitiveAccess(shell('type C:\\proj\\readme.txt C:\\Users\\Lee\\.ssh\\id_rsa'));
  expect(r.hit).toBe(true);
  expect(r.targets.some(t => t.includes('id_rsa'))).toBe(true);
});

test('B1: cat 多参数全部检查', () => {
  const r = scanForSensitiveAccess(shell('cat a.txt b.txt C:\\Users\\Lee\\.env'));
  expect(r.hit).toBe(true);
});

test('B1: 全部非敏感参数不命中', () => {
  const r = scanForSensitiveAccess(shell('type a.txt b.txt c.txt'));
  expect(r.hit).toBe(false);
});

// ============ B2：copy / xcopy / robocopy / move ============

test('B2: copy 敏感源命中', () => {
  const r = scanForSensitiveAccess(shell('copy C:\\Users\\Lee\\.ssh\\id_rsa D:\\proj\\leaked.txt'));
  expect(r.hit).toBe(true);
  expect(r.targets.some(t => t.includes('id_rsa'))).toBe(true);
});

test('B2: copy 敏感目标命中', () => {
  const r = scanForSensitiveAccess(shell('copy D:\\proj\\pub.txt C:\\Users\\Lee\\.ssh\\authorized_keys'));
  expect(r.hit).toBe(true);
});

test('B2: xcopy 敏感源命中', () => {
  const r = scanForSensitiveAccess(shell('xcopy C:\\Users\\Lee\\.aws\\credentials D:\\proj\\ /Y'));
  expect(r.hit).toBe(true);
});

test('B2: robocopy 敏感源命中', () => {
  const r = scanForSensitiveAccess(shell('robocopy C:\\Users\\Lee\\.ssh D:\\proj\\backup'));
  expect(r.hit).toBe(true);
});

test('B2: move 敏感源命中', () => {
  const r = scanForSensitiveAccess(shell('move C:\\Users\\Lee\\.ssh\\id_rsa D:\\proj\\'));
  expect(r.hit).toBe(true);
});

test('B2: copy 非敏感路径不命中', () => {
  const r = scanForSensitiveAccess(shell('copy D:\\proj\\a.txt D:\\proj\\b.txt'));
  expect(r.hit).toBe(false);
});

// ============ B3：删除命令的敏感目标 ============

test('B3: del 敏感目标命中', () => {
  const r = scanForSensitiveAccess(shell('del C:\\Users\\Lee\\.ssh\\id_rsa'));
  expect(r.hit).toBe(true);
});

test('B3: erase 敏感目标命中', () => {
  const r = scanForSensitiveAccess(shell('erase C:\\Users\\Lee\\.aws\\credentials'));
  expect(r.hit).toBe(true);
});

test('B3: rm 敏感目标命中', () => {
  const r = scanForSensitiveAccess(shell('rm C:\\Users\\Lee\\.ssh\\id_rsa'));
  expect(r.hit).toBe(true);
});

test('B3: Remove-Item 敏感目标命中（PS）', () => {
  const r = scanForSensitiveAccess(pwsh('Remove-Item C:\\Users\\Lee\\.ssh\\id_rsa -Force'));
  expect(r.hit).toBe(true);
});

test('B3: del 非敏感目标不命中', () => {
  const r = scanForSensitiveAccess(shell('del /q D:\\proj\\temp.txt'));
  expect(r.hit).toBe(false);
});

// ============ B6：PowerShell -Path: 连写 ============

test('B6: Get-Content -Path:xxx 命中', () => {
  const r = scanForSensitiveAccess(pwsh('Get-Content -Path:C:\\Users\\Lee\\.ssh\\id_rsa'));
  expect(r.hit).toBe(true);
});

test('B6: Get-Content -LiteralPath:xxx 命中', () => {
  const r = scanForSensitiveAccess(pwsh('Get-Content -LiteralPath:C:\\Users\\Lee\\.aws\\credentials'));
  expect(r.hit).toBe(true);
});

test('B6: Select-String -Path:xxx 命中', () => {
  const r = scanForSensitiveAccess(pwsh('Select-String -Path:C:\\Users\\Lee\\.ssh\\id_rsa -Pattern "BEGIN"'));
  expect(r.hit).toBe(true);
});

// ============ findstr / grep：第一个操作数是模式 ============

test('findstr: pattern 被跳过，第二个参数才是路径', () => {
  const r = scanForSensitiveAccess(shell('findstr pattern C:\\Users\\Lee\\.ssh\\id_rsa'));
  expect(r.hit).toBe(true);
});

test('findstr: 非敏感路径不命中', () => {
  const r = scanForSensitiveAccess(shell('findstr error D:\\proj\\app.log'));
  expect(r.hit).toBe(false);
});

test('grep: 模式 + 敏感路径命中', () => {
  const r = scanForSensitiveAccess(shell('grep password C:\\Users\\Lee\\.aws\\credentials'));
  expect(r.hit).toBe(true);
});

test('grep: -r 选项被跳过，模式后才是路径', () => {
  const r = scanForSensitiveAccess(shell('grep -r password C:\\Users\\Lee\\.ssh\\config'));
  expect(r.hit).toBe(true);
});
