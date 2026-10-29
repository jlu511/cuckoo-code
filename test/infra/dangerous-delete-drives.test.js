'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import { analyzeCommand } from '../../src/infra/dangerous-delete.js';

const CWD = path.resolve('D:/Software/cuckoo-code/cuckoo-code');
const ROOT = CWD;
const CTX = { cwd: CWD, workspaceRoot: ROOT, shell: 'cmd' };

test('rm -rf C:\\ → drive-root', () => {
  const a = analyzeCommand('rm -rf C:\\', CTX);
  assert.strictEqual(a.verdict, 'preview');
  assert.strictEqual(a.targets[0].scope, 'drive-root');
  assert.strictEqual(a.targets[0].resolved, 'C:\\');
});

test('rm -rf E:\\ → drive-root', () => {
  const a = analyzeCommand('rm -rf E:\\', CTX);
  assert.strictEqual(a.verdict, 'preview');
  assert.strictEqual(a.targets[0].scope, 'drive-root');
  assert.strictEqual(a.targets[0].resolved, 'E:\\');
});

test('rm -rf D:\\aaa\\ → outside（D 盘下非工作区子目录）', () => {
  const a = analyzeCommand('rm -rf D:\\aaa\\', CTX);
  assert.strictEqual(a.verdict, 'preview');
  assert.strictEqual(a.targets[0].scope, 'outside');
  assert.ok(a.targets[0].resolved.toLowerCase().endsWith('d:\\aaa'));
});

test('rm -rf C:\\Windows → outside', () => {
  const a = analyzeCommand('rm -rf C:\\Windows', CTX);
  assert.strictEqual(a.verdict, 'preview');
  assert.strictEqual(a.targets[0].scope, 'outside');
});

test('rm -rf D: （无尾斜杠）→ unknown（意图无法确定）', () => {
  const a = analyzeCommand('rm -rf D:', CTX);
  assert.strictEqual(a.verdict, 'unknown');
  assert.strictEqual(a.targets[0].scope, 'unknown');
  assert.strictEqual(a.hasUnresolved, true);
});
