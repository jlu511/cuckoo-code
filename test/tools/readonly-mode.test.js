import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SandboxExecutor } from '../../src/tools/core/executor.js';
import { injectSafetyChecker } from '../../src/tools/core/safety-precheck.js';

// ============ helpers ============

let tmpHome;
let prevHome;

function writeAccessMode(mode) {
  fs.writeFileSync(
    path.join(tmpHome, 'config.json'),
    JSON.stringify({ memoriesEnabled: false, accessMode: mode }, null, 2),
    'utf-8'
  );
}

const makeReq = (rawCommand = 'echo hi') => ({
  type: 'shell', shellType: 'cmd', rawCommand, cwd: 'D:\\', env: {},
});

const makePwshReq = (script = 'Get-Date') => ({
  type: 'process',
  executable: 'powershell',
  args: ['-NoProfile', '-Command', script],
  cwd: 'D:\\',
  env: {},
});

const okRunner = () => {
  const runner = { calls: 0, run: async () => { runner.calls++; return { stdout: 'ok', stderr: '', exitCode: 0 }; } };
  return runner;
};

const okHandler = () => {
  const h = {
    approvalCalls: 0,
    blockedCalls: 0,
    lastBlocked: null,
    requestApproval: async () => { h.approvalCalls++; return 'allow_once'; },
    notifyBlocked: async (n) => { h.blockedCalls++; h.lastBlocked = n; },
  };
  return h;
};

const fixedResolver = (id) => () => id;

beforeEach(() => {
  prevHome = process.env.CUCKOO_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-ro-'));
  process.env.CUCKOO_HOME = tmpHome;
  // 默认放行 CCSN，隔离变量
  injectSafetyChecker(async () => ({ kind: 'allow' }));
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CUCKOO_HOME;
  else process.env.CUCKOO_HOME = prevHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ============ 只读模式：命令执行一律阻断 ============

test('readOnly：bash 命令被阻断，不弹审批不执行', async () => {
  writeAccessMode('readOnly');
  const handler = okHandler();
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);

  await expect(
    ex.execute(makeReq('echo hi'), 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/只读模式/);

  expect(handler.approvalCalls).toBe(0);
  expect(runner.calls).toBe(0);
});

test('readOnly：pwsh 命令被阻断，不弹审批不执行', async () => {
  writeAccessMode('readOnly');
  const handler = okHandler();
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);

  await expect(
    ex.execute(makePwshReq('Get-Date'), 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/只读模式/);

  expect(handler.approvalCalls).toBe(0);
  expect(runner.calls).toBe(0);
});

test('readOnly：即使命中 L0 白名单也被阻断（L0 不豁免）', async () => {
  writeAccessMode('readOnly');
  const handler = okHandler();
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);

  await expect(
    ex.execute(makeReq('dir /a /b'), 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/只读模式/);

  expect(runner.calls).toBe(0);
});

test('readOnly：即使 CCSN allow 也被阻断（CCSN 不豁免）', async () => {
  writeAccessMode('readOnly');
  injectSafetyChecker(async () => ({ kind: 'allow' }));
  const handler = okHandler();
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);

  await expect(
    ex.execute(makeReq('echo hi'), 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/只读模式/);

  expect(runner.calls).toBe(0);
});

test('readOnly：重定向写文件被阻断（echo > file）', async () => {
  writeAccessMode('readOnly');
  const handler = okHandler();
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);

  await expect(
    ex.execute(makeReq('echo x > out.txt'), 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/只读模式/);

  expect(runner.calls).toBe(0);
});

// ============ 可写模式：行为不变 ============

test('workspaceWrite：普通命令仍走审批并执行', async () => {
  writeAccessMode('workspaceWrite');
  const handler = okHandler();
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);

  await ex.execute(makeReq('echo hi'), 'taskA', 'sessionA', fixedResolver('sessionA'));

  expect(handler.approvalCalls).toBe(1);
  expect(runner.calls).toBe(1);
});

test('fullAccess：普通命令仍走审批并执行', async () => {
  writeAccessMode('fullAccess');
  const handler = okHandler();
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);

  await ex.execute(makeReq('echo hi'), 'taskA', 'sessionA', fixedResolver('sessionA'));

  expect(handler.approvalCalls).toBe(1);
  expect(runner.calls).toBe(1);
});

// ============ 顺序：权限检查先于 CCSN ============

test('readOnly：CCSN 根本不会被调用（权限检查在前）', async () => {
  writeAccessMode('readOnly');
  let ccsnCalls = 0;
  injectSafetyChecker(async () => { ccsnCalls++; return { kind: 'deny', reason: 'x', ruleId: 'y' }; });
  const handler = okHandler();
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);

  await expect(
    ex.execute(makeReq('echo hi'), 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/只读模式/);

  expect(ccsnCalls).toBe(0);
});

// ============ 原生 read 工具仍允许（只读不影响读取） ============

test('readOnly：infra 层 checkPathPermission 对读取仍放行', async () => {
  writeAccessMode('readOnly');
  const { checkPathPermission } = await import('../../src/infra/permission.js');
  const r = checkPathPermission(path.join(tmpHome, 'a.txt'), false, tmpHome);
  expect(r.allow).toBe(true);
});
