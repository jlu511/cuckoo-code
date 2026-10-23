import { test, expect, beforeEach } from 'vitest';
import {
  extractSafetyCommand,
  injectSafetyChecker,
  runSafetyPrecheck,
} from '../../src/tools/core/safety-precheck.js';

const shellReq = (rawCommand, cwd = 'D:\\') => ({
  type: 'shell', shellType: 'cmd', rawCommand, cwd, env: {},
});

const psReq = (script, cwd = 'D:\\') => ({
  type: 'process',
  executable: 'powershell',
  args: ['-NoProfile', '-Command', script],
  cwd,
  env: {},
});

beforeEach(() => {
  injectSafetyChecker(async () => ({ kind: 'allow' }));
});

// ============ 命令正文抽取 ============

test('抽取：shell 请求直接使用 rawCommand', () => {
  const r = extractSafetyCommand(shellReq('dir /b'));
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.command).toBe('dir /b');
});

test('抽取：powershell -NoProfile -Command <script> 只返回 script 正文', () => {
  const script = 'Get-ChildItem -Path . | Where-Object { $_.Length -gt 0 }';
  const r = extractSafetyCommand(psReq(script));
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.command).toBe(script);
    // 不得包含外壳程序名或参数
    expect(r.command).not.toContain('powershell');
    expect(r.command).not.toContain('-NoProfile');
  }
});

test('抽取：powershell 参数形态不符 → fail-closed', () => {
  const bad = [
    { type: 'process', executable: 'powershell', args: ['-Command', 'x'], cwd: 'D:\\', env: {} },
    { type: 'process', executable: 'powershell', args: ['-NoProfile', '-Command'], cwd: 'D:\\', env: {} },
    { type: 'process', executable: 'powershell', args: ['-NoProfile', '-EncodedCommand', 'x'], cwd: 'D:\\', env: {} },
  ];
  for (const req of bad) {
    const r = extractSafetyCommand(req);
    expect(r.ok).toBe(false);
  }
});

test('抽取：非 powershell 的 ProcessRequest → fail-closed', () => {
  const reqs = [
    { type: 'process', executable: 'node', args: ['-e', 'console.log(1)'], cwd: 'D:\\', env: {} },
    { type: 'process', executable: 'cmd', args: ['/c', 'dir'], cwd: 'D:\\', env: {} },
  ];
  for (const req of reqs) {
    const r = extractSafetyCommand(req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不支持');
  }
});

test('抽取：cwd 非绝对路径 → fail-closed', () => {
  const r = extractSafetyCommand(shellReq('dir', 'relative/path'));
  expect(r.ok).toBe(false);
});

test('抽取：command 为空或非字符串 → fail-closed', () => {
  expect(extractSafetyCommand(shellReq('')).ok).toBe(false);
  expect(extractSafetyCommand(shellReq('   ')).ok).toBe(false);
  expect(extractSafetyCommand(shellReq(null)).ok).toBe(false);
});

// ============ 预检编排 ============

test('预检：CCSN allow + 无敏感路径 → 不阻断', async () => {
  const r = await runSafetyPrecheck(shellReq('dir /b'));
  expect(r.blocked).toBe(false);
  expect(r.ccsn.kind).toBe('allow');
  expect(r.sensitive.hit).toBe(false);
});

test('预检：CCSN deny → 阻断，携带 reason 与 ruleId', async () => {
  injectSafetyChecker(async () => ({ kind: 'deny', reason: '禁止 git reset --hard', ruleId: 'git.reset-hard' }));
  const r = await runSafetyPrecheck(shellReq('git reset --hard'));
  expect(r.blocked).toBe(true);
  expect(r.blockReason).toContain('禁止 git reset --hard');
  expect(r.blockRuleId).toBe('git.reset-hard');
});

test('预检：CCSN deny + 敏感路径命中 → 两者信息都在', async () => {
  injectSafetyChecker(async () => ({ kind: 'deny', reason: '禁止删除', ruleId: 'rm.secret' }));
  const r = await runSafetyPrecheck(shellReq('del /q .ssh\\id_rsa'));
  expect(r.blocked).toBe(true);
  expect(r.sensitive.hit).toBe(true);
  expect(r.sensitive.targets.length).toBeGreaterThan(0);
  expect(r.blockReason).toContain('禁止删除');
});

test('预检：CCSN 返回 error → 阻断（fail-closed）', async () => {
  injectSafetyChecker(async () => ({ kind: 'error', reason: '规则加载失败' }));
  const r = await runSafetyPrecheck(shellReq('dir /b'));
  expect(r.blocked).toBe(true);
  expect(r.blockReason).toContain('规则加载失败');
});

test('预检：CCSN 抛异常 → 阻断（fail-closed）', async () => {
  injectSafetyChecker(async () => { throw new Error('boom'); });
  const r = await runSafetyPrecheck(shellReq('dir /b'));
  expect(r.blocked).toBe(true);
  expect(r.blockReason).toContain('boom');
});

test('预检：检查器未注入 → 阻断（fail-closed）', async () => {
  injectSafetyChecker(null);
  const r = await runSafetyPrecheck(shellReq('dir /b'));
  expect(r.blocked).toBe(true);
  expect(r.blockRuleId).toBe('cuckoo.checker-unavailable');
});

test('预检：命令正文无法抽取 → 阻断，且不调用检查器', async () => {
  let called = false;
  injectSafetyChecker(async () => { called = true; return { kind: 'allow' }; });
  const r = await runSafetyPrecheck({
    type: 'process', executable: 'node', args: ['-e', 'x'], cwd: 'D:\\', env: {},
  });
  expect(r.blocked).toBe(true);
  expect(r.blockRuleId).toBe('cuckoo.extraction-unsupported');
  expect(called).toBe(false);
});

test('预检：传给检查器的命令不含 powershell 外壳', async () => {
  let received = null;
  injectSafetyChecker(async (input) => { received = input; return { kind: 'allow' }; });
  await runSafetyPrecheck(psReq('Remove-Item x -Force'));
  expect(received).toEqual({ command: 'Remove-Item x -Force', cwd: 'D:\\' });
});
