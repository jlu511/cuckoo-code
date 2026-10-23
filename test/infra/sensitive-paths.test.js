import { test, expect } from 'vitest';
import { classifySensitivePath } from '../../src/infra/sensitive-paths.js';

// ============ 目录类 ============

test('classifySensitivePath: .ssh 目录', () => {
  const r = classifySensitivePath('C:\\Users\\Lee\\.ssh\\id_rsa');
  expect(r.sensitive).toBe(true);
  expect(r.matched.some(m => m.category === 'ssh')).toBe(true);
});

test('classifySensitivePath: .aws 目录', () => {
  const r = classifySensitivePath('C:\\Users\\Lee\\.aws\\credentials');
  expect(r.sensitive).toBe(true);
  expect(r.matched.some(m => m.category === 'aws')).toBe(true);
});

test('classifySensitivePath: .gnupg 目录', () => {
  expect(classifySensitivePath('C:\\Users\\Lee\\.gnupg\\secring.gpg').sensitive).toBe(true);
});

test('classifySensitivePath: .kube 目录', () => {
  expect(classifySensitivePath('C:\\Users\\Lee\\.kube\\config').sensitive).toBe(true);
});

test('classifySensitivePath: .docker 目录', () => {
  expect(classifySensitivePath('C:\\Users\\Lee\\.docker\\config.json').sensitive).toBe(true);
});

// ============ 文件名类 ============

test('classifySensitivePath: .env 文件', () => {
  expect(classifySensitivePath('D:\\proj\\.env').sensitive).toBe(true);
  expect(classifySensitivePath('D:\\proj\\.env.local').sensitive).toBe(true);
  expect(classifySensitivePath('D:\\proj\\.env.production').sensitive).toBe(true);
});

test('classifySensitivePath: .npmrc', () => {
  expect(classifySensitivePath('C:\\Users\\Lee\\.npmrc').sensitive).toBe(true);
});

test('classifySensitivePath: .git-credentials', () => {
  expect(classifySensitivePath('C:\\Users\\Lee\\.git-credentials').sensitive).toBe(true);
});

test('classifySensitivePath: SSH 私钥文件名（任意目录）', () => {
  expect(classifySensitivePath('D:\\backup\\id_rsa').sensitive).toBe(true);
  expect(classifySensitivePath('D:\\backup\\id_ed25519').sensitive).toBe(true);
});

// ============ Windows 大小写 ============

test('classifySensitivePath: Windows 大小写不敏感', () => {
  if (process.platform !== 'win32') return;
  expect(classifySensitivePath('C:\\Users\\Lee\\.SSH\\ID_RSA').sensitive).toBe(true);
  expect(classifySensitivePath('D:\\proj\\.ENV').sensitive).toBe(true);
});

// ============ 正反斜杠混合 ============

test('classifySensitivePath: 正反斜杠混合', () => {
  expect(classifySensitivePath('C:/Users/Lee/.ssh/id_rsa').sensitive).toBe(true);
  expect(classifySensitivePath('C:\\Users\\Lee/.aws/credentials').sensitive).toBe(true);
});

// ============ 路径穿越 ============

test('classifySensitivePath: 路径穿越已由调用方 resolve，此处只看最终路径', () => {
  // classifySensitivePath 接收的是已 resolve 的路径
  // 这里直接测 resolve 后的形态
  const path = require('node:path');
  const resolved = path.resolve('D:\\proj', '..\\..\\.ssh\\id_rsa');
  expect(classifySensitivePath(resolved).sensitive).toBe(true);
});

// ============ 普通文件不误伤 ============

test('classifySensitivePath: 普通文件不命中', () => {
  expect(classifySensitivePath('D:\\proj\\src\\main.ts').sensitive).toBe(false);
  expect(classifySensitivePath('D:\\proj\\README.md').sensitive).toBe(false);
  expect(classifySensitivePath('D:\\proj\\package.json').sensitive).toBe(false);
});

test('classifySensitivePath: 名字相似但不命中', () => {
  expect(classifySensitivePath('D:\\proj\\environment.ts').sensitive).toBe(false);
  expect(classifySensitivePath('D:\\proj\\ssh-client.ts').sensitive).toBe(false);
  expect(classifySensitivePath('D:\\proj\\.envrc').sensitive).toBe(false); // 不是 .env 也不是 .env.*
});

test('classifySensitivePath: 空值/null 不命中', () => {
  expect(classifySensitivePath('').sensitive).toBe(false);
  expect(classifySensitivePath(null).sensitive).toBe(false);
  expect(classifySensitivePath(undefined).sensitive).toBe(false);
});
