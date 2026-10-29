'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import { analyzeCommand } from '../../src/infra/dangerous-delete.js';

const CWD = path.resolve('D:/Software/cuckoo-code/cuckoo-code');
const ROOT = CWD;
const CTX = { cwd: CWD, workspaceRoot: ROOT, shell: 'cmd' };

// ===== 缺陷 1：引号内分隔符不误拆 =====

test('echo "hello; world" → none（引号内 ; 不拆）', () => {
  const a = analyzeCommand('echo "hello; world"', CTX);
  assert.strictEqual(a.verdict, 'none');
});

test('echo "a|b" → none（引号内 | 不拆）', () => {
  const a = analyzeCommand('echo "a|b"', CTX);
  assert.strictEqual(a.verdict, 'none');
});

test('findstr "a;b" file.txt → none（常见误伤场景）', () => {
  const a = analyzeCommand('findstr "a;b" file.txt', CTX);
  assert.strictEqual(a.verdict, 'none');
});

test('echo hi && rm -rf D:\\ → preview（真命令链仍识别）', () => {
  const a = analyzeCommand('echo hi && rm -rf D:\\', CTX);
  assert.strictEqual(a.verdict, 'preview');
});

test('rm -rf build; echo "unfinished → unknown（未配对引号整体降级）', () => {
  const a = analyzeCommand('rm -rf build; echo "unfinished', CTX);
  assert.strictEqual(a.verdict, 'unknown');
  assert.strictEqual(a.hasUnresolved, true);
  assert.ok(a.reasons.some((r) => r.includes('未配对')));
});

test('rm -rf D:\\; echo "unfinished → unknown（后段崩了也不能放行前段危险目标）', () => {
  const a = analyzeCommand('rm -rf D:\\; echo "unfinished', CTX);
  assert.strictEqual(a.verdict, 'unknown');
});

test('转义引号 \\" 不破坏引号状态', () => {
  const a = analyzeCommand('echo "a\\"; rm -rf D:\\"', CTX);
  // 引号配对正常，第二段应识别为危险
  assert.ok(a.verdict === 'preview' || a.verdict === 'unknown');
});

test('git log --format="%s;%b" → none（引号内 ; 不拆）', () => {
  const a = analyzeCommand('git log --format="%s;%b"', CTX);
  assert.strictEqual(a.verdict, 'none');
});

test('echo "a&b" → none（引号内 & 不拆）', () => {
  const a = analyzeCommand('echo "a&b"', CTX);
  assert.strictEqual(a.verdict, 'none');
});

test('echo "a&&b" → none（引号内 && 不拆）', () => {
  const a = analyzeCommand('echo "a&&b"', CTX);
  assert.strictEqual(a.verdict, 'none');
});
