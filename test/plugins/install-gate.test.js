import { test, expect, vi } from 'vitest';
import { buildInstallSnapshot } from '../../src/plugins/cuckoo-plugins/install-gate.js';
import { DefaultPluginInstallGate } from '../../src/plugins/cuckoo-plugins/default-install-gate.js';

function makeSnapshot(overrides = {}) {
  return buildInstallSnapshot({
    windowId: 1,
    packageName: 'test-plugin',
    pluginId: 'test-plugin',
    installDir: 'C:\\plugins\\test-plugin',
    command: 'npm.cmd',
    args: ['install', 'test-plugin', '--no-audit'],
    cwd: 'C:\\plugins\\test-plugin',
    timeoutMs: 300000,
    ...overrides,
  });
}

// ==================== buildInstallSnapshot ====================

test('buildInstallSnapshot: 生成唯一 id', () => {
  const a = makeSnapshot();
  const b = makeSnapshot();
  expect(a.id).not.toBe(b.id);
  expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
});

test('buildInstallSnapshot: 保留所有字段', () => {
  const s = makeSnapshot();
  expect(s.packageName).toBe('test-plugin');
  expect(s.pluginId).toBe('test-plugin');
  expect(s.command).toBe('npm.cmd');
  expect(s.args).toEqual(['install', 'test-plugin', '--no-audit']);
  expect(s.timeoutMs).toBe(300000);
});

// ==================== DefaultPluginInstallGate: fail closed ====================

// 为了测试 gate 逻辑，不用真实 electron，直接构造并替换私有 showDialog
function makeGateWithDialog(showDialog, timeoutMs = 120000) {
  const gate = new DefaultPluginInstallGate(timeoutMs);
  // 覆盖私有方法（测试专用）
  gate.showDialog = showDialog;
  return gate;
}

test('check: windowId 为 null → 抛错（fail closed）', async () => {
  const gate = makeGateWithDialog(async () => 'allow');
  const snap = makeSnapshot({ windowId: null });
  await expect(gate.check(snap)).rejects.toThrow(/缺少可信的窗口 ID/);
});

test('check: windowId 为 0 → 抛错', async () => {
  const gate = makeGateWithDialog(async () => 'allow');
  const snap = makeSnapshot({ windowId: 0 });
  await expect(gate.check(snap)).rejects.toThrow(/缺少可信的窗口 ID/);
});

test('check: 审批返回 allow → 通过', async () => {
  const gate = makeGateWithDialog(async () => 'allow');
  const decision = await gate.check(makeSnapshot());
  expect(decision).toBe('allow');
});

test('check: 审批返回 deny → 返回 deny', async () => {
  const gate = makeGateWithDialog(async () => 'deny');
  const decision = await gate.check(makeSnapshot());
  expect(decision).toBe('deny');
});

test('check: 审批超时 → 抛错（fail closed）', async () => {
  const gate = makeGateWithDialog(async () => {
    await new Promise(r => setTimeout(r, 200));
    return 'allow';
  }, 50);
  await expect(gate.check(makeSnapshot())).rejects.toThrow(/审批超时/);
});

test('check: 审批抛异常 → 抛错（fail closed）', async () => {
  const gate = makeGateWithDialog(async () => {
    throw new Error('弹窗崩溃');
  });
  await expect(gate.check(makeSnapshot())).rejects.toThrow(/弹窗崩溃/);
});

test('check: 审批返回非法值 → 抛错（fail closed）', async () => {
  const gate = makeGateWithDialog(async () => 'invalid');
  await expect(gate.check(makeSnapshot())).rejects.toThrow(/非法决策值/);
});

test('check: 审批返回 null → 抛错（fail closed）', async () => {
  const gate = makeGateWithDialog(async () => null);
  await expect(gate.check(makeSnapshot())).rejects.toThrow(/非法决策值/);
});

// ==================== 快照不可变性（安全关键）====================

test('buildInstallSnapshot: 返回的对象被冻结（顶层）', () => {
  const snap = buildInstallSnapshot({
    windowId: 1,
    packageName: 'test-plugin',
    pluginId: 'test-plugin',
    installDir: 'C:\\x',
    command: 'npm.cmd',
    args: ['install', 'test-plugin'],
    cwd: 'C:\\x',
    timeoutMs: 1000,
  });
  expect(Object.isFrozen(snap)).toBe(true);
});

test('buildInstallSnapshot: args 数组被冻结（防止审批后篡改参数）', () => {
  const snap = buildInstallSnapshot({
    windowId: 1,
    packageName: 'test-plugin',
    pluginId: 'test-plugin',
    installDir: 'C:\\x',
    command: 'npm.cmd',
    args: ['install', 'test-plugin'],
    cwd: 'C:\\x',
    timeoutMs: 1000,
  });
  expect(Object.isFrozen(snap.args)).toBe(true);
});

test('buildInstallSnapshot: 严格模式下修改顶层字段抛错', () => {
  'use strict';
  const snap = buildInstallSnapshot({
    windowId: 1,
    packageName: 'test-plugin',
    pluginId: 'test-plugin',
    installDir: 'C:\\x',
    command: 'npm.cmd',
    args: ['install'],
    cwd: 'C:\\x',
    timeoutMs: 1000,
  });
  expect(() => { snap.args = ['evil']; }).toThrow(TypeError);
  expect(() => { snap.installDir = 'C:\\evil'; }).toThrow(TypeError);
});

test('buildInstallSnapshot: 严格模式下 push 到 args 抛错', () => {
  'use strict';
  const snap = buildInstallSnapshot({
    windowId: 1,
    packageName: 'test-plugin',
    pluginId: 'test-plugin',
    installDir: 'C:\\x',
    command: 'npm.cmd',
    args: ['install'],
    cwd: 'C:\\x',
    timeoutMs: 1000,
  });
  expect(() => { snap.args.push('--evil'); }).toThrow(TypeError);
});

test('buildInstallSnapshot: 冻结后原参数数组的修改不影响快照', () => {
  const sourceArgs = ['install', 'test-plugin'];
  const snap = buildInstallSnapshot({
    windowId: 1,
    packageName: 'test-plugin',
    pluginId: 'test-plugin',
    installDir: 'C:\\x',
    command: 'npm.cmd',
    args: sourceArgs,
    cwd: 'C:\\x',
    timeoutMs: 1000,
  });
  // 修改原始数组
  sourceArgs.push('--evil');
  // 快照不受影响（构建时已 [...params.args] 拷贝）
  expect(snap.args).toEqual(['install', 'test-plugin']);
});
