import { test, expect } from 'vitest';
import { isValidPackageName, packageNameToId } from '../../src/plugins/cuckoo-plugins/installer.js';

// ==================== isValidPackageName ====================

test('isValidPackageName: 普通包名通过', () => {
  expect(isValidPackageName('dsh-plugin-greet')).toBe(true);
  expect(isValidPackageName('my-plugin')).toBe(true);
  expect(isValidPackageName('plugin123')).toBe(true);
});

test('isValidPackageName: scoped 包名通过', () => {
  expect(isValidPackageName('@scope/plugin-name')).toBe(true);
  expect(isValidPackageName('@deepseek-ai/dsh-greet-tool')).toBe(true);
});

test('isValidPackageName: 点、下划线、连字符通过', () => {
  expect(isValidPackageName('my.plugin_name-test')).toBe(true);
});

test('isValidPackageName: 空/null/非字符串拒绝', () => {
  expect(isValidPackageName('')).toBe(false);
  expect(isValidPackageName(null)).toBe(false);
  expect(isValidPackageName(undefined)).toBe(false);
  expect(isValidPackageName(123)).toBe(false);
  expect(isValidPackageName({})).toBe(false);
});

test('isValidPackageName: 超长包名拒绝', () => {
  expect(isValidPackageName('a'.repeat(215))).toBe(false);
});

test('isValidPackageName: 空格注入拒绝', () => {
  expect(isValidPackageName('foo bar')).toBe(false);
  expect(isValidPackageName('  foo')).toBe(false);
  expect(isValidPackageName('foo ')).toBe(false);
});

test('isValidPackageName: shell 元字符拒绝', () => {
  expect(isValidPackageName('foo;rm -rf')).toBe(false);
  expect(isValidPackageName('foo&&rm')).toBe(false);
  expect(isValidPackageName('foo|rm')).toBe(false);
  expect(isValidPackageName('foo>out')).toBe(false);
  expect(isValidPackageName('foo<input')).toBe(false);
  expect(isValidPackageName('foo`whoami`')).toBe(false);
  expect(isValidPackageName('foo$(whoami)')).toBe(false);
});

test('isValidPackageName: 引号拒绝', () => {
  expect(isValidPackageName('foo"bar')).toBe(false);
  expect(isValidPackageName("foo'bar")).toBe(false);
});

test('isValidPackageName: 反斜杠拒绝', () => {
  expect(isValidPackageName('foo\\bar')).toBe(false);
});

test('isValidPackageName: 双重斜杠拒绝', () => {
  expect(isValidPackageName('@scope//name')).toBe(false);
  expect(isValidPackageName('foo//bar')).toBe(false);
});

test('isValidPackageName: 以非法字符开头拒绝', () => {
  expect(isValidPackageName('-foo')).toBe(false);
  expect(isValidPackageName('.foo')).toBe(false);
  expect(isValidPackageName('_foo')).toBe(false);
});

// ==================== packageNameToId ====================

test('packageNameToId: 普通包名', () => {
  expect(packageNameToId('my-plugin')).toBe('my-plugin');
});

test('packageNameToId: scoped 包名去 @ 和斜杠', () => {
  expect(packageNameToId('@scope/plugin-name')).toBe('scope-plugin-name');
  expect(packageNameToId('@deepseek-ai/dsh-greet-tool')).toBe('deepseek-ai-dsh-greet-tool');
});

test('packageNameToId: 大写转小写', () => {
  expect(packageNameToId('MyPlugin')).toBe('myplugin');
});
