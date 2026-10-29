'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import { analyzeCommand } from '../../src/infra/dangerous-delete.js';

const CWD = path.resolve('D:/Software/cuckoo-code/cuckoo-code');
const ROOT = CWD;
const CTX = { cwd: CWD, workspaceRoot: ROOT, shell: 'cmd' };

// ===== 缺陷 1：cmd /c 内层 & 二次拆段 =====

test('cmd /c "cmd1 & cmd2" 内层 & 被识别（剥壳后二次拆段）', () => {
  const a = analyzeCommand('cmd /c "rmdir /s /q C:\\Temp\\x & echo DONE"', CTX);
  // 只有 rmdir 的目标被识别，echo 的 DONE 不应出现在清单里
  const rawTargets = a.targets.map(t => t.raw);
  assert.ok(!rawTargets.includes('DONE'), 'DONE 不应出现在目标清单');
  assert.ok(!rawTargets.includes('echo'), 'echo 不应出现在目标清单');
  assert.ok(!rawTargets.includes('&'), '& 不应出现在目标清单');
});

test('cmd /c "rm -rf D:\\ & echo ok" 第二段 echo 不干扰目标', () => {
  const a = analyzeCommand('cmd /c "rm -rf D:\\ & echo ok"', CTX);
  assert.strictEqual(a.verdict, 'preview');
  // 只有 D:\ 是目标
  assert.strictEqual(a.targets.length, 1);
  assert.strictEqual(a.targets[0].scope, 'drive-root');
});

// ===== 缺陷 2：重定向符不当作目标 =====

test('rmdir 2>nul 不把 2>nul 当目标', () => {
  const a = analyzeCommand('rmdir /s /q D:\\temp 2>nul', CTX);
  const rawTargets = a.targets.map(t => t.raw);
  assert.ok(!rawTargets.includes('2>nul'), '2>nul 不应出现在目标清单');
});

test('del a.txt >nul 不把 >nul 当目标', () => {
  const a = analyzeCommand('del a.txt >nul', CTX);
  const rawTargets = a.targets.map(t => t.raw);
  assert.ok(!rawTargets.includes('>nul'), '>nul 不应出现在目标清单');
});

test('del a.txt 2>&1 不把 2>&1 当目标', () => {
  const a = analyzeCommand('del a.txt 2>&1', CTX);
  const rawTargets = a.targets.map(t => t.raw);
  assert.ok(!rawTargets.includes('2>&1'), '2>&1 不应出现在目标清单');
});

test('rm -rf D:\\ >> log.txt 只识别 D:\\', () => {
  const a = analyzeCommand('rm -rf D:\\ >> log.txt', CTX);
  assert.strictEqual(a.targets.length, 1);
  assert.strictEqual(a.targets[0].scope, 'drive-root');
});

// ===== 组合场景：cmd /c + 内层 & + 重定向 =====

test('cmd /c "rmdir /s /q K:\\x 2>nul & echo DONE" 目标只有 K:\\x', () => {
  const a = analyzeCommand('cmd /c "rmdir /s /q K:\\x 2>nul & echo DONE"', CTX);
  assert.strictEqual(a.verdict, 'preview');
  assert.strictEqual(a.targets.length, 1);
  assert.strictEqual(a.targets[0].raw, 'K:\\x');
  assert.strictEqual(a.targets[0].scope, 'outside');
});
