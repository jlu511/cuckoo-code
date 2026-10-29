'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { previewDelete, formatBytes } from '../../src/tools/core/delete-preview.js';

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkTarget(abs) {
  return {
    raw: abs,
    resolved: abs,
    scope: 'inside',
    isWildcard: false,
    hasVariable: false,
  };
}

test('空目录：只列目录本身，totalFiles=0', async () => {
  const root = mkTmp('dp-empty-');
  const target = path.join(root, 'empty');
  fs.mkdirSync(target);
  try {
    const r = await previewDelete([mkTarget(target)], root);
    assert.strictEqual(r.totalFiles, 0);
    assert.strictEqual(r.totalDirs, 1);
    assert.strictEqual(r.entries.length, 1);
    assert.strictEqual(r.entries[0].type, 'dir');
    assert.strictEqual(r.scanErrors.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('目录含 3 个文件：totalFiles=3', async () => {
  const root = mkTmp('dp-three-');
  const target = path.join(root, 'build');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'a.js'), 'a');
  fs.writeFileSync(path.join(target, 'b.js'), 'bb');
  fs.writeFileSync(path.join(target, 'c.js'), 'ccc');
  try {
    const r = await previewDelete([mkTarget(target)], root);
    assert.strictEqual(r.totalFiles, 3);
    assert.strictEqual(r.totalDirs, 1);
    assert.strictEqual(r.totalBytes, 6);
    assert.strictEqual(r.entries.length, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('超过 limit：截断并标记 truncated', async () => {
  const root = mkTmp('dp-limit-');
  const target = path.join(root, 'big');
  fs.mkdirSync(target);
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(target, 'f' + i + '.txt'), 'x');
  try {
    const r = await previewDelete([mkTarget(target)], root, { limit: 5 });
    assert.strictEqual(r.entries.length, 5);
    assert.strictEqual(r.truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('符号链接：只列链接本身，不递归', async () => {
  const root = mkTmp('dp-link-');
  const target = path.join(root, 'with-link');
  fs.mkdirSync(target);
  const realDir = path.join(root, 'outside');
  fs.mkdirSync(realDir);
  fs.writeFileSync(path.join(realDir, 'secret.txt'), 'x');
  try {
    fs.symlinkSync(realDir, path.join(target, 'link-to-outside'), 'junction');
  } catch {
    // 无权限创建链接（如普通用户）：跳过该用例
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  try {
    const r = await previewDelete([mkTarget(target)], root);
    const links = r.entries.filter((e) => e.type === 'link');
    assert.strictEqual(links.length, 1);
    assert.ok(!r.entries.some((e) => e.relPath.includes('secret.txt')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('不存在的路径：scanErrors 有记录，不抛异常', async () => {
  const root = mkTmp('dp-missing-');
  const target = path.join(root, 'nope');
  try {
    const r = await previewDelete([mkTarget(target)], root);
    assert.strictEqual(r.scanErrors.length, 1);
    assert.ok(r.scanErrors[0].path.includes('nope'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unknown 目标（resolved=null）被跳过', async () => {
  const root = mkTmp('dp-unknown-');
  try {
    const r = await previewDelete(
      [{ raw: '$VAR', resolved: null, scope: 'unknown', isWildcard: false, hasVariable: true }],
      root,
    );
    assert.strictEqual(r.entries.length, 0);
    assert.strictEqual(r.scanErrors.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('formatBytes 边界', () => {
  assert.strictEqual(formatBytes(0), '0 B');
  assert.strictEqual(formatBytes(1023), '1023 B');
  assert.ok(formatBytes(1024).includes('KB'));
  assert.ok(formatBytes(1024 * 1024).includes('MB'));
  assert.ok(formatBytes(1024 * 1024 * 1024).includes('GB'));
});
