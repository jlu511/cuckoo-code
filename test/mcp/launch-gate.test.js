import { test, expect, vi } from 'vitest';
import { buildFingerprint, DefaultMcpLaunchGate } from '../../src/mcp/launch-gate.js';

// ==================== helpers ====================

function makeSnapshotBase(overrides = {}) {
  return {
    windowId: 1,
    source: 'user',
    name: 'test-server',
    command: 'node',
    args: ['server.js'],
    cwd: 'D:\\test',
    env: { NORMAL_VAR: 'value', GITHUB_TOKEN: 'secret-token' },
    ...overrides,
  };
}

function makeSnapshot(overrides = {}) {
  const base = makeSnapshotBase(overrides);
  return {
    id: 'test-id',
    ...base,
    fingerprint: buildFingerprint(base),
    createdAt: Date.now(),
  };
}

// ==================== buildFingerprint ====================

test('buildFingerprint: 相同输入 → 相同指纹', () => {
  const a = buildFingerprint(makeSnapshotBase());
  const b = buildFingerprint(makeSnapshotBase());
  expect(a).toBe(b);
});

test('buildFingerprint: 不同 source → 不同指纹', () => {
  const a = buildFingerprint(makeSnapshotBase({ source: 'user' }));
  const b = buildFingerprint(makeSnapshotBase({ source: 'project' }));
  expect(a).not.toBe(b);
});

test('buildFingerprint: 不同 command → 不同指纹', () => {
  const a = buildFingerprint(makeSnapshotBase({ command: 'node' }));
  const b = buildFingerprint(makeSnapshotBase({ command: 'python' }));
  expect(a).not.toBe(b);
});

test('buildFingerprint: 不同 args → 不同指纹', () => {
  const a = buildFingerprint(makeSnapshotBase({ args: ['a.js'] }));
  const b = buildFingerprint(makeSnapshotBase({ args: ['b.js'] }));
  expect(a).not.toBe(b);
});

test('buildFingerprint: 不同 cwd → 不同指纹', () => {
  const a = buildFingerprint(makeSnapshotBase({ cwd: 'D:\\dir1' }));
  const b = buildFingerprint(makeSnapshotBase({ cwd: 'D:\\dir2' }));
  expect(a).not.toBe(b);
});

test('buildFingerprint: 不同普通 env 值 → 不同指纹', () => {
  const a = buildFingerprint(makeSnapshotBase({ env: { NORMAL_VAR: 'a' } }));
  const b = buildFingerprint(makeSnapshotBase({ env: { NORMAL_VAR: 'b' } }));
  expect(a).not.toBe(b);
});

test('buildFingerprint: 敏感 env 值变化 → 不同指纹（说明参与了计算）', () => {
  const a = buildFingerprint(makeSnapshotBase({ env: { GITHUB_TOKEN: 'token-a' } }));
  const b = buildFingerprint(makeSnapshotBase({ env: { GITHUB_TOKEN: 'token-b' } }));
  expect(a).not.toBe(b);
});

test('buildFingerprint: env 键顺序不影响指纹', () => {
  const a = buildFingerprint(makeSnapshotBase({ env: { A: '1', B: '2' } }));
  const b = buildFingerprint(makeSnapshotBase({ env: { B: '2', A: '1' } }));
  expect(a).toBe(b);
});

// ==================== DefaultMcpLaunchGate: 前置校验 ====================

test('check: windowId 为 null → 抛错（fail closed）', async () => {
  const gate = new DefaultMcpLaunchGate(async () => 'allow_once');
  const snap = makeSnapshot({ windowId: null });
  await expect(gate.check(snap)).rejects.toThrow(/缺少可信的窗口 ID/);
});

test('check: windowId 为 0 → 抛错', async () => {
  const gate = new DefaultMcpLaunchGate(async () => 'allow_once');
  const snap = makeSnapshot({ windowId: 0 });
  await expect(gate.check(snap)).rejects.toThrow(/缺少可信的窗口 ID/);
});

test('check: fingerprint 缺失 → 抛错', async () => {
  const gate = new DefaultMcpLaunchGate(async () => 'allow_once');
  const snap = { ...makeSnapshot(), fingerprint: '' };
  await expect(gate.check(snap)).rejects.toThrow(/缺少配置指纹/);
});

// ==================== DefaultMcpLaunchGate: 基本审批流 ====================

test('check: allow_once → 返回 allow_once，不缓存，第二次仍弹窗', async () => {
  const showDialog = vi.fn(async () => 'allow_once');
  const gate = new DefaultMcpLaunchGate(showDialog);
  const snap = makeSnapshot();

  expect(await gate.check(snap)).toBe('allow_once');
  expect(showDialog).toHaveBeenCalledTimes(1);

  // 第二次：allow_once 不缓存，应再次弹窗
  expect(await gate.check(snap)).toBe('allow_once');
  expect(showDialog).toHaveBeenCalledTimes(2);
});

test('check: allow_session → 第二次不弹窗', async () => {
  const showDialog = vi.fn(async () => 'allow_session');
  const gate = new DefaultMcpLaunchGate(showDialog);
  const snap = makeSnapshot();

  expect(await gate.check(snap)).toBe('allow_session');
  expect(showDialog).toHaveBeenCalledTimes(1);

  expect(await gate.check(snap)).toBe('allow_session');
  expect(showDialog).toHaveBeenCalledTimes(1);
});

test('check: deny → 返回 deny，不缓存（第二次仍弹窗）', async () => {
  const showDialog = vi.fn(async () => 'deny');
  const gate = new DefaultMcpLaunchGate(showDialog);
  const snap = makeSnapshot();

  expect(await gate.check(snap)).toBe('deny');
  expect(showDialog).toHaveBeenCalledTimes(1);

  expect(await gate.check(snap)).toBe('deny');
  expect(showDialog).toHaveBeenCalledTimes(2);
});

// ==================== DefaultMcpLaunchGate: 配置变化重新审批 ====================

test('check: 配置变化（command）→ 重新审批', async () => {
  const showDialog = vi.fn(async () => 'allow_session');
  const gate = new DefaultMcpLaunchGate(showDialog);

  await gate.check(makeSnapshot({ command: 'node' }));
  await gate.check(makeSnapshot({ command: 'python' }));

  expect(showDialog).toHaveBeenCalledTimes(2);
});

test('check: 配置变化（env）→ 重新审批', async () => {
  const showDialog = vi.fn(async () => 'allow_session');
  const gate = new DefaultMcpLaunchGate(showDialog);

  await gate.check(makeSnapshot({ env: { A: '1' } }));
  await gate.check(makeSnapshot({ env: { A: '2' } }));

  expect(showDialog).toHaveBeenCalledTimes(2);
});

test('check: 不同 windowId → 独立审批', async () => {
  const showDialog = vi.fn(async () => 'allow_session');
  const gate = new DefaultMcpLaunchGate(showDialog);

  await gate.check(makeSnapshot({ windowId: 1 }));
  await gate.check(makeSnapshot({ windowId: 2 }));

  expect(showDialog).toHaveBeenCalledTimes(2);
});

// ==================== DefaultMcpLaunchGate: 并发去重 ====================

test('check: 并发 3 个相同请求 → 只弹 1 次窗，共享结果', async () => {
  let dialogCalls = 0;
  const showDialog = async () => {
    dialogCalls++;
    await new Promise(r => setTimeout(r, 30));
    return 'allow_session';
  };
  const gate = new DefaultMcpLaunchGate(showDialog);
  const snap = makeSnapshot();

  const results = await Promise.all([
    gate.check(snap),
    gate.check(snap),
    gate.check(snap),
  ]);

  expect(dialogCalls).toBe(1);
  expect(results).toEqual(['allow_session', 'allow_session', 'allow_session']);
});

test('check: 并发不同配置 → 各自独立审批', async () => {
  let dialogCalls = 0;
  const showDialog = async () => {
    dialogCalls++;
    await new Promise(r => setTimeout(r, 20));
    return 'allow_session';
  };
  const gate = new DefaultMcpLaunchGate(showDialog);

  await Promise.all([
    gate.check(makeSnapshot({ command: 'node' })),
    gate.check(makeSnapshot({ command: 'python' })),
  ]);

  expect(dialogCalls).toBe(2);
});

// ==================== DefaultMcpLaunchGate: fail closed ====================

test('check: 审批超时 → 抛错（fail closed）', async () => {
  // 注入极短超时
  const showDialog = async () => {
    await new Promise(r => setTimeout(r, 200));
    return 'allow_once';
  };
  const gate = new DefaultMcpLaunchGate(showDialog, 50);
  const snap = makeSnapshot();

  await expect(gate.check(snap)).rejects.toThrow(/审批超时/);
});

test('check: 审批抛异常 → 抛错（fail closed）', async () => {
  const showDialog = async () => {
    throw new Error('弹窗崩溃');
  };
  const gate = new DefaultMcpLaunchGate(showDialog);

  await expect(gate.check(makeSnapshot())).rejects.toThrow(/拒绝启动 MCP.*弹窗崩溃/);
});

test('check: 审批返回非法值 → 抛错（fail closed）', async () => {
  const showDialog = async () => 'invalid_decision';
  const gate = new DefaultMcpLaunchGate(showDialog);

  await expect(gate.check(makeSnapshot())).rejects.toThrow(/非法决策值/);
});

test('check: 审批返回 null → 抛错（fail closed）', async () => {
  const showDialog = async () => null;
  const gate = new DefaultMcpLaunchGate(showDialog);

  await expect(gate.check(makeSnapshot())).rejects.toThrow(/非法决策值/);
});

// ==================== DefaultMcpLaunchGate: forgetWindow ====================

test('forgetWindow: 清理该窗口的 allow_session 缓存', async () => {
  const showDialog = vi.fn(async () => 'allow_session');
  const gate = new DefaultMcpLaunchGate(showDialog);
  const snap = makeSnapshot({ windowId: 42 });

  await gate.check(snap);
  expect(showDialog).toHaveBeenCalledTimes(1);

  // 缓存命中
  await gate.check(snap);
  expect(showDialog).toHaveBeenCalledTimes(1);

  // 清理窗口 42
  gate.forgetWindow(42);

  // 清理后重新弹窗
  await gate.check(snap);
  expect(showDialog).toHaveBeenCalledTimes(2);
});

test('forgetWindow: 不影响其他窗口的缓存', async () => {
  const showDialog = vi.fn(async () => 'allow_session');
  const gate = new DefaultMcpLaunchGate(showDialog);

  await gate.check(makeSnapshot({ windowId: 1 }));
  await gate.check(makeSnapshot({ windowId: 2 }));
  expect(showDialog).toHaveBeenCalledTimes(2);

  gate.forgetWindow(1);

  // 窗口 2 仍缓存
  await gate.check(makeSnapshot({ windowId: 2 }));
  expect(showDialog).toHaveBeenCalledTimes(2);

  // 窗口 1 重新弹窗
  await gate.check(makeSnapshot({ windowId: 1 }));
  expect(showDialog).toHaveBeenCalledTimes(3);
});

test('peek: 无缓存时返回 null（不弹窗）', () => {
  const showDialog = vi.fn();
  const gate = new DefaultMcpLaunchGate(showDialog);
  const snap = makeSnapshot();
  expect(gate.peek(snap)).toBeNull();
  expect(showDialog).not.toHaveBeenCalled();
});

test('peek: allow_session 后返回 allow_session（不弹窗）', async () => {
  const showDialog = vi.fn(async () => 'allow_session');
  const gate = new DefaultMcpLaunchGate(showDialog);
  const snap = makeSnapshot();

  await gate.check(snap);
  expect(showDialog).toHaveBeenCalledTimes(1);

  expect(gate.peek(snap)).toBe('allow_session');
  expect(showDialog).toHaveBeenCalledTimes(1);
});

test('peek: allow_once 不写入缓存', async () => {
  const showDialog = vi.fn(async () => 'allow_once');
  const gate = new DefaultMcpLaunchGate(showDialog);
  const snap = makeSnapshot();

  await gate.check(snap);
  expect(gate.peek(snap)).toBeNull();
});

test('peek: 不同窗口各自独立', async () => {
  const showDialog = vi.fn(async () => 'allow_session');
  const gate = new DefaultMcpLaunchGate(showDialog);

  await gate.check(makeSnapshot({ windowId: 1 }));
  expect(gate.peek(makeSnapshot({ windowId: 1 }))).toBe('allow_session');
  expect(gate.peek(makeSnapshot({ windowId: 2 }))).toBeNull();
});

test('peek: 配置变化后返回 null', async () => {
  const showDialog = vi.fn(async () => 'allow_session');
  const gate = new DefaultMcpLaunchGate(showDialog);

  await gate.check(makeSnapshot({ command: 'node' }));
  expect(gate.peek(makeSnapshot({ command: 'node' }))).toBe('allow_session');
  expect(gate.peek(makeSnapshot({ command: 'python' }))).toBeNull();
});

test('peek: windowId 缺失时返回 null', () => {
  const gate = new DefaultMcpLaunchGate(async () => 'allow_session');
  expect(gate.peek(makeSnapshot({ windowId: null }))).toBeNull();
});

test('clearAll: 清空所有缓存', async () => {
  const showDialog = vi.fn(async () => 'allow_session');
  const gate = new DefaultMcpLaunchGate(showDialog);

  await gate.check(makeSnapshot({ windowId: 1 }));
  await gate.check(makeSnapshot({ windowId: 2 }));
  expect(showDialog).toHaveBeenCalledTimes(2);

  gate.clearAll();

  await gate.check(makeSnapshot({ windowId: 1 }));
  await gate.check(makeSnapshot({ windowId: 2 }));
  expect(showDialog).toHaveBeenCalledTimes(4);
});
