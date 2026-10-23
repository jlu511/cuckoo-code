import { test, expect } from 'vitest';
import { SandboxExecutor } from '../../src/tools/core/executor.js';
import { injectSafetyChecker } from '../../src/tools/core/safety-precheck.js';

injectSafetyChecker(async () => ({ kind: 'allow' }));

const makeReq = (cmd = 'npm run build') => ({
  type: 'shell', shellType: 'cmd', rawCommand: cmd, cwd: 'D:\\\\', env: {},
});

const okRunner = () => {
  const r = { calls: 0, run: async () => { r.calls++; return { stdout: 'ok', stderr: '', exitCode: 0 }; } };
  return r;
};

const makeHandler = (decisions = ['allow_session']) => {
  const h = {
    calls: 0,
    requestApproval: async () => { h.calls++; return decisions[Math.min(h.calls - 1, decisions.length - 1)]; },
  };
  return h;
};

const fixedResolver = (id) => () => id;

// ============ 窗口隔离 ============

test('032w 同 profile + 同会话 + 同命令，不同窗口不共享授权', async () => {
  const handler = makeHandler(['allow_session', 'allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  const gen = () => 1;
  const req = makeReq();

  // 窗口 1 授权
  await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen, 'profile-A', 1);
  expect(handler.calls).toBe(1);

  // 窗口 2 相同 profile / 会话 / 命令 → 必须重新审批
  await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen, 'profile-A', 2);
  expect(handler.calls).toBe(2);

  expect(ex.getSessionGrantCount()).toBe(2);
});

test('032w 同窗口同请求复用（窗口隔离未误伤）', async () => {
  const handler = makeHandler(['allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  const gen = () => 1;
  const req = makeReq();

  await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen, 'p', 7);
  await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen, 'p', 7);

  expect(handler.calls).toBe(1);
});

test('032w 窗口关闭重建（新 windowId）：旧授权不可恢复', async () => {
  const handler = makeHandler(['allow_session', 'allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  let gen = 1;
  const genProvider = () => gen;
  const req = makeReq();

  // 窗口 100 授权
  await ex.execute(req, 't', 'sid', fixedResolver('sid'), genProvider, 'p', 100);
  expect(handler.calls).toBe(1);

  // 关闭窗口 100 → generation 递增
  gen = 2;

  // 重建窗口拿到新 id 101，同会话同命令
  await ex.execute(req, 't', 'sid', fixedResolver('sid'), genProvider, 'p', 101);
  expect(handler.calls).toBe(2);
});

test('032w windowId 非法（0 / 负数 / 小数 / NaN）：禁用会话授权', async () => {
  for (const bad of [0, -1, 1.5, NaN]) {
    const handler = makeHandler(['allow_once', 'allow_once']);
    const ex = new SandboxExecutor(handler, okRunner());
    const gen = () => 1;
    const req = makeReq();
    await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen, 'p', bad);
    await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen, 'p', bad);
    expect(handler.calls, String(bad)).toBe(2);
    expect(ex.getSessionGrantCount(), String(bad)).toBe(0);
  }
});

test('032w windowId 缺失：禁用会话授权', async () => {
  const handler = makeHandler(['allow_once', 'allow_once']);
  const ex = new SandboxExecutor(handler, okRunner());
  const gen = () => 1;
  const req = makeReq();

  await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen, 'p');
  await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen, 'p');

  expect(handler.calls).toBe(2);
  expect(ex.getSessionGrantCount()).toBe(0);
});

test('032w windowId 缺失时 handler 伪造 allow_session：fail-closed', async () => {
  const handler = makeHandler(['allow_session']);
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);

  await expect(
    ex.execute(makeReq(), 't', 'sid', fixedResolver('sid'), () => 1, 'p')
  ).rejects.toThrow(/不允许会话授权/);

  expect(runner.calls).toBe(0);
  expect(ex.getSessionGrantCount()).toBe(0);
});