import { test, expect } from 'vitest';
import { CcsnClient } from '../../src/tools/core/ccsn-client.js';

/**
 * 可编程的假检查进程：由测试决定对每条命令返回什么。
 */
function makeFakeFactory(handler) {
  const state = { spawns: 0, killed: 0, last: null };
  const factory = () => {
    state.spawns++;
    let msgCb = null;
    let exitCb = null;
    const proc = {
      postMessage(msg) {
        state.last = msg;
        // 异步回包，模拟真实进程
        Promise.resolve().then(() => {
          const resp = handler(msg, state);
          if (resp === 'exit') {
            if (exitCb) exitCb(1);
            return;
          }
          if (resp && msgCb) msgCb({ ...resp, id: msg.id });
        });
      },
      onMessage(cb) { msgCb = cb; },
      onExit(cb) { exitCb = cb; },
      kill() { state.killed++; if (exitCb) exitCb(0); },
    };
    // 启动后立即 ready
    Promise.resolve().then(() => { if (msgCb) msgCb({ type: 'ready' }); });
    return proc;
  };
  return { factory, state };
}

test('CCSN 客户端：allow 透传', async () => {
  const { factory } = makeFakeFactory(() => ({ kind: 'allow' }));
  const client = new CcsnClient(factory);
  const r = await client.check({ command: 'dir', cwd: 'D:\\' });
  expect(r).toEqual({ kind: 'allow' });
  client.dispose();
});

test('CCSN 客户端：deny 透传 reason 与 ruleId', async () => {
  const { factory } = makeFakeFactory(() => ({ kind: 'deny', reason: '禁止', ruleId: 'x.y' }));
  const client = new CcsnClient(factory);
  const r = await client.check({ command: 'rm -rf /', cwd: 'D:\\' });
  expect(r).toEqual({ kind: 'deny', reason: '禁止', ruleId: 'x.y' });
  client.dispose();
});

test('CCSN 客户端：error 透传', async () => {
  const { factory } = makeFakeFactory(() => ({ kind: 'error', reason: '规则加载失败' }));
  const client = new CcsnClient(factory);
  const r = await client.check({ command: 'dir', cwd: 'D:\\' });
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.reason).toContain('规则加载失败');
  client.dispose();
});

test('CCSN 客户端：进程复用，不重复启动', async () => {
  const { factory, state } = makeFakeFactory(() => ({ kind: 'allow' }));
  const client = new CcsnClient(factory);
  await client.check({ command: 'a', cwd: 'D:\\' });
  await client.check({ command: 'b', cwd: 'D:\\' });
  await client.check({ command: 'c', cwd: 'D:\\' });
  expect(state.spawns).toBe(1);
  client.dispose();
});

test('CCSN 客户端：请求超时 → error，且销毁进程', async () => {
  const factory = () => {
    return {
      postMessage() { /* 永不回包 */ },
      onMessage(cb) { Promise.resolve().then(() => cb({ type: 'ready' })); },
      onExit() {},
      kill() {},
    };
  };
  const client = new CcsnClient(factory, { requestTimeoutMs: 50 });
  const r = await client.check({ command: 'dir', cwd: 'D:\\' });
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.reason).toContain('超时');
  client.dispose();
});

test('CCSN 客户端：启动超时 → error', async () => {
  const factory = () => ({
    postMessage() {},
    onMessage() { /* 永不 ready */ },
    onExit() {},
    kill() {},
  });
  const client = new CcsnClient(factory, { startupTimeoutMs: 50 });
  const r = await client.check({ command: 'dir', cwd: 'D:\\' });
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.reason).toContain('启动超时');
  client.dispose();
});

test('CCSN 客户端：初始化失败（init-error）→ error', async () => {
  const factory = () => {
    return {
      postMessage() {},
      onMessage(cb) { Promise.resolve().then(() => cb({ type: 'init-error', reason: '加载 cc-safety-net 失败' })); },
      onExit() {},
      kill() {},
    };
  };
  const client = new CcsnClient(factory);
  const r = await client.check({ command: 'dir', cwd: 'D:\\' });
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.reason).toContain('加载 cc-safety-net 失败');
  client.dispose();
});

test('CCSN 客户端：进程崩溃后下次请求重新启动', async () => {
  let mode = 'allow';
  const { factory, state } = makeFakeFactory(() => {
    if (mode === 'crash') return 'exit';
    return { kind: 'allow' };
  });
  const client = new CcsnClient(factory);
  await client.check({ command: 'a', cwd: 'D:\\' });
  expect(state.spawns).toBe(1);

  mode = 'crash';
  const r1 = await client.check({ command: 'b', cwd: 'D:\\' });
  expect(r1.kind).toBe('error');

  mode = 'allow';
  const r2 = await client.check({ command: 'c', cwd: 'D:\\' });
  expect(r2).toEqual({ kind: 'allow' });
  expect(state.spawns).toBe(2);
  client.dispose();
});

test('CCSN 客户端：返回非法结构 → error', async () => {
  const { factory } = makeFakeFactory(() => ({ kind: 'weird' }));
  const client = new CcsnClient(factory);
  const r = await client.check({ command: 'dir', cwd: 'D:\\' });
  expect(r.kind).toBe('error');
  client.dispose();
});

test('CCSN 客户端：空 command / 空 cwd → error，不启动进程', async () => {
  const { factory, state } = makeFakeFactory(() => ({ kind: 'allow' }));
  const client = new CcsnClient(factory);
  expect((await client.check({ command: '', cwd: 'D:\\' })).kind).toBe('error');
  expect((await client.check({ command: 'dir', cwd: '' })).kind).toBe('error');
  expect(state.spawns).toBe(0);
  client.dispose();
});

test('CCSN 客户端：dispose 后调用 → error', async () => {
  const { factory } = makeFakeFactory(() => ({ kind: 'allow' }));
  const client = new CcsnClient(factory);
  client.dispose();
  const r = await client.check({ command: 'dir', cwd: 'D:\\' });
  expect(r.kind).toBe('error');
});

test('CCSN 客户端：检查过程不阻塞事件循环（并发请求可交错）', async () => {
  // 结构性断言：两个请求必须在任何一个回包之前都已发出。
  // 若同步阻塞，第二个 postMessage 会等到第一个回包之后才发生。
  const posted = [];
  let released = false;
  const factory = () => {
    let msgCb = null;
    return {
      postMessage(msg) {
        posted.push({ id: msg.id, releasedBefore: released });
        setTimeout(() => { if (msgCb) msgCb({ id: msg.id, kind: 'allow' }); }, 20);
      },
      onMessage(cb) { msgCb = cb; Promise.resolve().then(() => cb({ type: 'ready' })); },
      onExit() {},
      kill() {},
    };
  };
  const client = new CcsnClient(factory);
  const p1 = client.check({ command: 'x', cwd: 'D:\\' });
  const p2 = client.check({ command: 'y', cwd: 'D:\\' });
  // 让两个请求都有机会发出
  await new Promise((r) => setTimeout(r, 5));
  released = true;

  const [a, b] = await Promise.all([p1, p2]);
  expect(a.kind).toBe('allow');
  expect(b.kind).toBe('allow');
  // 关键断言：两个请求都在任何回包之前发出（非阻塞）
  expect(posted.length).toBe(2);
  expect(posted[0].releasedBefore).toBe(false);
  expect(posted[1].releasedBefore).toBe(false);
  client.dispose();
});
