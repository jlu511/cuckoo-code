'use strict';
/**
 * MCP 连接初始化超时测试。
 *
 * 验证：
 * 1. connect 挂起 → 30s 后超时，transport.close() 被调用
 * 2. 超时后迟到 resolve → 连接不被登记为成功
 * 3. 超时后迟到 reject → 不产生 unhandledRejection
 * 4. 超时清理后可以重新连接
 *
 * 策略：mock SDK 的 Client.connect 由测试控制 resolve/reject 时机；
 * 用 vi.useFakeTimers 推进 30s 超时。
 */
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => (id) => {
      if (id === 'electron') return { app: { isPackaged: false, getPath: () => 'C:/ud', getAppPath: () => 'C:/app' } };
      throw new Error('unexpected require: ' + id);
    },
  };
});

// 可控的 SDK mock：connect 挂起直到测试手动触发
const sdkState = {
  connectBehavior: 'pending', // 'pending' | 'resolve' | 'reject'
  connectResolve: null,
  connectReject: null,
  listToolsCalls: 0,
  closeCalls: 0,
  instances: [],
};

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    constructor() {
      sdkState.instances.push(this);
    }
    connect() {
      if (sdkState.connectBehavior === 'resolve') return Promise.resolve();
      if (sdkState.connectBehavior === 'reject') return Promise.reject(new Error('connect failed'));
      return new Promise((resolve, reject) => {
        sdkState.connectResolve = resolve;
        sdkState.connectReject = reject;
      });
    }
    async listTools() {
      sdkState.listToolsCalls++;
      return { tools: [{ name: 't1', description: 'd', inputSchema: {} }] };
    }
    async callTool() { return { content: [] }; }
    async close() {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(params) {
      this.params = params;
      this.closed = false;
    }
    async close() {
      sdkState.closeCalls++;
      this.closed = true;
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class { constructor() {} },
}));

const PROJ1 = 'C:/proj1';
const server = () => ({ name: 'p', source: 'project', type: 'stdio', command: 'x', args: [], cwd: 'C:/tmp', enabled: true });

vi.mock('../../src/mcp/config.js', () => ({
  getServers: () => [server()],
  getEnabledServers: () => [server()],
  getUserServers: () => [server()],
}));

let client;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  sdkState.connectBehavior = 'pending';
  sdkState.connectResolve = null;
  sdkState.connectReject = null;
  sdkState.listToolsCalls = 0;
  sdkState.closeCalls = 0;
  sdkState.instances = [];

  client = await import('../../src/mcp/client.js');
  client.injectMcpLaunchGate({
    check: async () => 'allow_session',
    peek: () => 'allow_session',
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function isConnected() {
  const s = client.listConfiguredServers(PROJ1).find(x => x.name === 'p');
  return !!(s && s.connected);
}

// ==================== 超时测试 ====================

test('connect 挂起 30s → 超时，transport.close() 被调用', async () => {
  const connectPromise = client.connectServerByName('p', PROJ1, 1);
  const caught = connectPromise.catch(e => e);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(30_000);

  const err = await caught;
  assert.match(err.message, /MCP 连接超时/);
  assert.strictEqual(sdkState.closeCalls, 1, 'transport.close() 应被调用（只调一次）');
  assert.strictEqual(isConnected(), false, '超时后不应登记为已连接');
});

test('超时后迟到 resolve → 连接不被登记为成功', async () => {
  const connectPromise = client.connectServerByName('p', PROJ1, 1);
  const caught = connectPromise.catch(e => e);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(30_000);

  const err = await caught;
  assert.match(err.message, /MCP 连接超时/);

  // 迟到的 connect 成功
  const lateResolve = sdkState.connectResolve;
  if (lateResolve) lateResolve();
  await vi.advanceTimersByTimeAsync(100);

  // 关键断言：连接池不应出现该连接
  assert.strictEqual(isConnected(), false, '迟到 resolve 不应污染连接池');
});

test('超时后迟到 reject → 不产生 unhandledRejection', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const connectPromise = client.connectServerByName('p', PROJ1, 1);
    const caught = connectPromise.catch(e => e);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await caught;
    assert.match(err.message, /MCP 连接超时/);

    // 迟到的 connect 失败
    const lateReject = sdkState.connectReject;
    if (lateReject) lateReject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(100);

    assert.strictEqual(unhandled.length, 0, '不应产生 unhandledRejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('超时清理后可以重新连接', async () => {
  // 第一次：超时
  const p1 = client.connectServerByName('p', PROJ1, 1);
  const caught1 = p1.catch(e => e);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(30_000);
  const err1 = await caught1;
  assert.match(err1.message, /MCP 连接超时/);
  assert.strictEqual(isConnected(), false);

  // 第二次：正常 resolve
  sdkState.connectBehavior = 'resolve';
  const p2 = client.connectServerByName('p', PROJ1, 1);
  await vi.advanceTimersByTimeAsync(100);
  await p2;

  assert.strictEqual(isConnected(), true, '超时后应能重新连接成功');
});

test('正常连接（快速 resolve）不触发超时', async () => {
  sdkState.connectBehavior = 'resolve';
  const p = client.connectServerByName('p', PROJ1, 1);
  await vi.advanceTimersByTimeAsync(100);
  await p;

  assert.strictEqual(isConnected(), true);
  assert.strictEqual(sdkState.closeCalls, 0, '正常连接不应触发 close');
  assert.strictEqual(sdkState.listToolsCalls, 1, '应调用 listTools');
});

test('connect 立即 reject → 抛错且清理 transport', async () => {
  sdkState.connectBehavior = 'reject';
  const p = client.connectServerByName('p', PROJ1, 1);
  const caught = p.catch(e => e);
  await vi.advanceTimersByTimeAsync(100);

  const err = await caught;
  assert.match(err.message, /connect failed/);
  assert.strictEqual(isConnected(), false);
  assert.strictEqual(sdkState.closeCalls, 1, '连接失败也应关闭 transport（只调一次）');
});
