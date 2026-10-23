import { test, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createSessionStore, getGlobalSessionGeneration, invalidateGlobalSessionGeneration } from '../../src/session/store.js';
import { SandboxExecutor } from '../../src/tools/core/executor.js';
import { injectSafetyChecker } from '../../src/tools/core/safety-precheck.js';

injectSafetyChecker(async () => ({ kind: 'allow' }));

const makeWindowState = () => ({
  getMainContext: () => null,
  getContextByWebContents: () => null,
});

const makeStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-032g-'));
  const store = createSessionStore('profile-' + Math.random().toString(36).slice(2, 8), dir, makeWindowState());
  return { store, dir };
};

const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

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

const URL_A = 'https://chat.deepseek.com/a/chat/s/aaaa-1111';

// ============ 1. 跨 store 生命周期 ============

test('032g 新 store 不重置全局 generation', () => {
  const g0 = getGlobalSessionGeneration();
  const { store: s1, dir: d1 } = makeStore();
  const g1 = s1.state.sessionGeneration;
  expect(g1).toBe(g0);

  invalidateGlobalSessionGeneration();
  const { store: s2, dir: d2 } = makeStore();
  const g2 = s2.state.sessionGeneration;

  expect(g2).toBeGreaterThan(g1);
  cleanup(d1); cleanup(d2);
});

test('032g store A 授权后关闭，store B 同 sessionId 不复用旧授权', async () => {
  const { store: storeA, dir: dA } = makeStore();
  storeA.handleUrlChange(URL_A);
  const sidA = storeA.state.currentSessionId;
  expect(sidA).toBeTruthy();

  const handler = makeHandler(['allow_session', 'allow_session']);
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);
  const req = makeReq();

  // 在 A 中授权
  await ex.execute(req, 't', sidA, () => sidA, () => storeA.state.sessionGeneration, 'profile-A', 1);
  expect(handler.calls).toBe(1);
  expect(ex.getSessionGrantCount()).toBe(1);

  // 关闭 A
  storeA.invalidateSessionGeneration();

  // 新建 B，打开同一会话
  const { store: storeB, dir: dB } = makeStore();
  storeB.handleUrlChange(URL_A);
  expect(storeB.state.currentSessionId).toBe(sidA);

  // B 的 generation 必须大于 A 授权时的值
  expect(storeB.state.sessionGeneration).toBeGreaterThan(storeA.state.sessionGeneration - 1);

  // 在 B 中执行相同命令 → 必须重新弹窗
  await ex.execute(req, 't', sidA, () => sidA, () => storeB.state.sessionGeneration, 'profile-A', 1);
  expect(handler.calls).toBe(2);

  cleanup(dA); cleanup(dB);
});

// ============ 2. 真实窗口关闭事件 ============

test('032g 窗口关闭事件触发全局 generation 递增', () => {
  const { store, dir } = makeStore();
  const g0 = store.state.sessionGeneration;

  // 模拟 win.on('closed') 里调用的 invalidateSessionGeneration
  store.invalidateSessionGeneration();

  expect(store.state.sessionGeneration).toBe(g0 + 1);
  expect(getGlobalSessionGeneration()).toBe(g0 + 1);

  cleanup(dir);
});

test('032g 一个 store 递增，另一个 store 立即读到新值', () => {
  const { store: s1, dir: d1 } = makeStore();
  const { store: s2, dir: d2 } = makeStore();

  expect(s1.state.sessionGeneration).toBe(s2.state.sessionGeneration);

  s1.invalidateSessionGeneration();

  expect(s2.state.sessionGeneration).toBe(s1.state.sessionGeneration);

  cleanup(d1); cleanup(d2);
});

// ============ 3. 跨窗口缓存失效 ============

test('032g A 授权后 B 触发失效，A 再执行需重新审批', async () => {
  const { store: sA, dir: dA } = makeStore();
  const { store: sB, dir: dB } = makeStore();
  sA.handleUrlChange(URL_A);
  const sid = sA.state.currentSessionId;

  const handler = makeHandler(['allow_session', 'allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  const req = makeReq();

  await ex.execute(req, 't', sid, () => sid, () => sA.state.sessionGeneration, 'p1', 1);
  expect(handler.calls).toBe(1);

  // 另一个窗口触发失效（模拟关闭 / 切换会话）
  sB.invalidateSessionGeneration();

  // 回到 A 执行相同命令 → 必须重新审批
  await ex.execute(req, 't', sid, () => sid, () => sA.state.sessionGeneration, 'p1', 1);
  expect(handler.calls).toBe(2);

  cleanup(dA); cleanup(dB);
});

// ============ 4. 新窗口同会话 ============

test('032g 新窗口同会话：generation 延续，旧键不命中', async () => {
  const { store: s1, dir: d1 } = makeStore();
  s1.handleUrlChange(URL_A);
  const sid = s1.state.currentSessionId;

  const handler = makeHandler(['allow_session', 'allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  const req = makeReq();

  await ex.execute(req, 't', sid, () => sid, () => s1.state.sessionGeneration, 'p', 1);
  expect(ex.getSessionGrantCount()).toBe(1);

  // 关窗口（invalidate 后 store 丢弃）
  s1.invalidateSessionGeneration();

  // 新窗口新 store，同会话
  const { store: s2, dir: d2 } = makeStore();
  s2.handleUrlChange(URL_A);
  expect(s2.state.currentSessionId).toBe(sid);

  await ex.execute(req, 't', sid, () => sid, () => s2.state.sessionGeneration, 'p', 1);
  expect(handler.calls).toBe(2);

  cleanup(d1); cleanup(d2);
});

// ============ 5. 审批期间关闭窗口 ============

test('032g 审批期间 generation 变化：不写缓存，不执行', async () => {
  let gen = 1;
  const handler = {
    calls: 0,
    requestApproval: async () => { handler.calls++; gen += 5; return 'allow_session'; },
  };
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);

  await expect(
    ex.execute(makeReq(), 't', 'sX', () => 'sX', () => gen, 'p', 1)
  ).rejects.toThrow(/代次已变化/);

  expect(runner.calls).toBe(0);
  expect(ex.getSessionGrantCount()).toBe(0);
});

// ============ 6. profile 隔离 ============

test('032g 不同 profile 的相同 sessionId 不共享授权', async () => {
  const handler = makeHandler(['allow_session', 'allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  const gen = () => 1;
  const req = makeReq();

  // profile A 授权
  await ex.execute(req, 't', 'same-session-id', fixedResolver('same-session-id'), gen, 'profile-A', 1);
  expect(handler.calls).toBe(1);

  // profile B 用相同 sessionId → 必须重新审批
  await ex.execute(req, 't', 'same-session-id', fixedResolver('same-session-id'), gen, 'profile-B', 1);
  expect(handler.calls).toBe(2);

  expect(ex.getSessionGrantCount()).toBe(2);
});

test('032g 相同 profile 相同 sessionId 仍复用', async () => {
  const handler = makeHandler(['allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  const gen = () => 1;
  const req = makeReq();

  await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen, 'profile-A', 1);
  await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen, 'profile-A', 1);

  expect(handler.calls).toBe(1);
});

test('032g scopeId 缺失：禁用会话授权，每次都要审批，不写缓存', async () => {
  const handler = makeHandler(['allow_once', 'allow_once']);
  const ex = new SandboxExecutor(handler, okRunner());
  const gen = () => 1;
  const req = makeReq();

  await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen);
  await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen);

  // scopeId 缺失 → canAllowSession=false → 不会缓存 → 两次都要弹窗
  expect(handler.calls).toBe(2);
  expect(ex.getSessionGrantCount()).toBe(0);
});

test('032g scopeId 缺失：弹窗 DTO 的 canAllowSession 为 false', async () => {
  let captured = null;
  const handler = {
    requestApproval: async (dto) => { captured = dto.canAllowSession; return 'allow_once'; },
  };
  const ex = new SandboxExecutor(handler, okRunner());
  await ex.execute(makeReq(), 't', 'sid', fixedResolver('sid'), () => 1);
  expect(captured).toBe(false);
});

test('032g scopeId 为空串 / 空白串：同样禁用', async () => {
  for (const bad of ['', '   ']) {
    const handler = makeHandler(['allow_once', 'allow_once']);
    const ex = new SandboxExecutor(handler, okRunner());
    const gen = () => 1;
    const req = makeReq();
    await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen, bad);
    await ex.execute(req, 't', 'sid', fixedResolver('sid'), gen, bad);
    expect(handler.calls, JSON.stringify(bad)).toBe(2);
    expect(ex.getSessionGrantCount(), JSON.stringify(bad)).toBe(0);
  }
});

test('032g scopeId 缺失时 handler 伪造 allow_session：fail-closed，不执行不缓存', async () => {
  const handler = makeHandler(['allow_session']);
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);

  await expect(
    ex.execute(makeReq(), 't', 'sid', fixedResolver('sid'), () => 1)
  ).rejects.toThrow(/不允许会话授权/);

  expect(runner.calls).toBe(0);
  expect(ex.getSessionGrantCount()).toBe(0);
});