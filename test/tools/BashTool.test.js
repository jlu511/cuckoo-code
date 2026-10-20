'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { BashTool, DANGEROUS_CMDS } from '../../src/tools/impl/bash.js';

test('DANGEROUS_CMDS 定义完整', () => {
  assert.ok(Array.isArray(DANGEROUS_CMDS));
  assert.ok(DANGEROUS_CMDS.length >= 9);
});

test('BashTool 危险命令拒绝', async () => {
  const tool = new BashTool();
  const tests = [
    'rm -rf /',
    'format C:',
    'shutdown /s',
  ];
  for (const cmd of tests) {
    const r = await tool.execute({ command: cmd, description: 'test' });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /安全策略拒绝/);
  }
});

test('BashTool 空命令拒绝', async () => {
  const tool = new BashTool();
  const r = await tool.execute({ command: '', description: 'test' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /invalid command/);
});

test('BashTool 空描述拒绝（强制要求用途说明）', async () => {
  const tool = new BashTool();
  const r = await tool.execute({ command: 'echo hi', description: '' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /description/);
});

test('BashTool 缺失描述拒绝（强制要求用途说明）', async () => {
  const tool = new BashTool();
  const r = await tool.execute({ command: 'echo hi' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /description/);
});

test('BashTool 非字符串命令拒绝', async () => {
  const tool = new BashTool();
  const r = await tool.execute({ command: 123, description: 'test' });
  assert.strictEqual(r.success, false);
});

