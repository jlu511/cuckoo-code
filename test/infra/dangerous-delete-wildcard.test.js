'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import { analyzeCommand } from '../../src/infra/dangerous-delete.js';

const CWD = path.resolve('D:/Software/cuckoo-code/cuckoo-code');
const ROOT = CWD;
const CTX = { cwd: CWD, workspaceRoot: ROOT, shell: 'cmd' };

// ===== 缺陷 2：通配符归 unknown =====

test('rm -rf D:\\* → unknown（盘符根通配）', () => {
  const a = analyzeCommand('rm -rf D:\\*', CTX);
  assert.strictEqual(a.verdict, 'unknown');
  assert.strictEqual(a.hasUnresolved, true);
});

test('rm -rf build/* → unknown（工作区内通配也降级）', () => {
  const a = analyzeCommand('rm -rf build/*', CTX);
  assert.strictEqual(a.verdict, 'unknown');
  assert.strictEqual(a.hasUnresolved, true);
});

test('del C:\\temp\\*.log → unknown（通配）', () => {
  const a = analyzeCommand('del C:\\temp\\*.log', CTX);
  assert.strictEqual(a.verdict, 'unknown');
});

test('rm -rf build? → unknown（? 通配）', () => {
  const a = analyzeCommand('rm -rf build?', CTX);
  assert.strictEqual(a.verdict, 'unknown');
});

// ===== 缺陷 4：盘符相对路径 =====

test('rm -rf D:foo → unknown（盘符相对路径）', () => {
  const a = analyzeCommand('rm -rf D:foo', CTX);
  assert.strictEqual(a.verdict, 'unknown');
});

test('rm -rf D:.. → unknown', () => {
  const a = analyzeCommand('rm -rf D:..', CTX);
  assert.strictEqual(a.verdict, 'unknown');
});

test('rm -rf D:\\foo → outside（绝对路径仍走正常分类）', () => {
  const a = analyzeCommand('rm -rf D:\\foo', CTX);
  assert.strictEqual(a.verdict, 'preview');
  assert.strictEqual(a.targets[0].scope, 'outside');
});

// ===== 缺陷 3：Windows 大小写不敏感 =====

test('工作区内路径大小写不同 → 仍判 inside（不误伤）', () => {
  const lower = path.resolve('d:/software/cuckoo-code/cuckoo-code/build');
  const a = analyzeCommand('rm -rf "' + lower + '"', CTX);
  assert.strictEqual(a.verdict, 'none');
  assert.strictEqual(a.targets[0].scope, 'inside');
});

test('工作区内路径大写盘符 → 仍判 inside', () => {
  const a = analyzeCommand('rm -rf "D:/Software/Cuckoo-Code/Cuckoo-Code/build"', CTX);
  assert.strictEqual(a.verdict, 'none');
});
