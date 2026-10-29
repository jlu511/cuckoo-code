'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import { analyzeCommand } from '../../src/infra/dangerous-delete.js';

const CWD = path.resolve('D:/proj');
const ROOT = path.resolve('D:/proj');
const CTX = { cwd: CWD, workspaceRoot: ROOT, shell: 'cmd' };

// ==================== 放行场景（verdict = none） ====================

test('工作区内递归删除 build → none', () => {
  const a = analyzeCommand('rm -rf build', CTX);
  assert.strictEqual(a.verdict, 'none');
  assert.strictEqual(a.targets.length, 1);
  assert.strictEqual(a.targets[0].scope, 'inside');
});

test('工作区内相对子目录 rm -rf ./cache → none', () => {
  const a = analyzeCommand('rm -rf ./cache', CTX);
  assert.strictEqual(a.verdict, 'none');
});

test('工作区内单文件删除 rm a.txt → none', () => {
  const a = analyzeCommand('rm a.txt', CTX);
  assert.strictEqual(a.verdict, 'none');
});

test('非删除命令 dir → none', () => {
  const a = analyzeCommand('dir', CTX);
  assert.strictEqual(a.verdict, 'none');
  assert.strictEqual(a.targets.length, 0);
});

test('非删除命令 npm run build → none', () => {
  const a = analyzeCommand('npm run build', CTX);
  assert.strictEqual(a.verdict, 'none');
});

// ==================== 高危场景（verdict = preview） ====================

test('盘符根 rm -rf D:\\ → preview', () => {
  const a = analyzeCommand('rm -rf D:\\', CTX);
  assert.strictEqual(a.verdict, 'preview');
  assert.strictEqual(a.targets[0].scope, 'drive-root');
});

test('盘符根 D:/ → preview', () => {
  const a = analyzeCommand('rm -rf D:/', CTX);
  assert.strictEqual(a.verdict, 'preview');
  assert.strictEqual(a.targets[0].scope, 'drive-root');
});

test('路径跳转 ./build/../.. → preview（指向盘符根）', () => {
  const a = analyzeCommand('rm -rf build/../..', CTX);
  assert.strictEqual(a.verdict, 'preview');
  assert.strictEqual(a.targets[0].scope, 'drive-root');
});

test('工作区外 ../other → preview', () => {
  const a = analyzeCommand('rm -rf ../other', CTX);
  assert.strictEqual(a.verdict, 'preview');
  assert.strictEqual(a.targets[0].scope, 'outside');
});

test('工作区根 . → preview（workspace-root）', () => {
  const a = analyzeCommand('rm -rf .', CTX);
  assert.strictEqual(a.verdict, 'preview');
  assert.strictEqual(a.targets[0].scope, 'workspace-root');
});

test('工作区外单文件 del D:\\x.txt → preview', () => {
  const a = analyzeCommand('del D:\\x.txt', CTX);
  assert.strictEqual(a.verdict, 'preview');
});

test('命令链 echo hi && rm -rf D:\\ → preview', () => {
  const a = analyzeCommand('echo hi && rm -rf D:\\', CTX);
  assert.strictEqual(a.verdict, 'preview');
});

test('cmd /c 剥壳 "rm -rf D:\\" → preview', () => {
  const a = analyzeCommand('cmd /c "rm -rf D:\\\\"', CTX);
  assert.strictEqual(a.verdict, 'preview');
});

test('PowerShell Remove-Item -Recurse -Force D:\\x → preview', () => {
  const ctx = { ...CTX, shell: 'pwsh' };
  const a = analyzeCommand('Remove-Item -Recurse -Force D:\\x', ctx);
  assert.strictEqual(a.verdict, 'preview');
});

// ==================== 未知场景（verdict = unknown） ====================

test('含变量 rm -rf $TARGET → unknown', () => {
  const a = analyzeCommand('rm -rf $TARGET', CTX);
  assert.strictEqual(a.verdict, 'unknown');
  assert.strictEqual(a.hasUnresolved, true);
});

test('含百分号变量 del %TEMP%\\* → unknown', () => {
  const a = analyzeCommand('del %TEMP%\\*', CTX);
  assert.strictEqual(a.verdict, 'unknown');
});

test('Unix 绝对路径 rm -rf /d/foo → unknown（不猜 MSYS）', () => {
  const a = analyzeCommand('rm -rf /d/foo', CTX);
  assert.strictEqual(a.verdict, 'unknown');
});

test('UNC 路径 rm -rf \\\\server\\share\\x → unknown', () => {
  const a = analyzeCommand('rm -rf \\\\server\\share\\x', CTX);
  assert.strictEqual(a.verdict, 'unknown');
});

// ==================== 边界 ====================

test('空命令 → none', () => {
  const a = analyzeCommand('', CTX);
  assert.strictEqual(a.verdict, 'none');
});

test('null workspaceRoot：具体路径一律 outside', () => {
  const ctx = { cwd: CWD, workspaceRoot: null, shell: 'cmd' };
  const a = analyzeCommand('rm -rf build', ctx);
  assert.strictEqual(a.verdict, 'preview');
  assert.strictEqual(a.targets[0].scope, 'outside');
});

test('reason 包含盘符根提示', () => {
  const a = analyzeCommand('rm -rf D:\\', CTX);
  assert.ok(a.reasons.some((r) => r.includes('磁盘根目录')));
});

test('reason 包含工作区外提示', () => {
  const a = analyzeCommand('rm -rf ../other', CTX);
  assert.ok(a.reasons.some((r) => r.includes('工作区外')));
});

test('多目标去重', () => {
  const a = analyzeCommand('rm -rf build build build', CTX);
  assert.strictEqual(a.targets.length, 1);
});
