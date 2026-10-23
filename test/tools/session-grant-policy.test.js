import { test, expect } from 'vitest';
import { buildRequestFingerprint, isSessionGrantBlocked } from '../../src/tools/core/session-grant-policy.js';

const shell = (cmd, extra = {}) => ({ type: 'shell', shellType: 'cmd', rawCommand: cmd, cwd: 'D:\\\\', env: {}, ...extra });
const ps = (script, extra = {}) => ({ type: 'process', executable: 'powershell', args: ['-NoProfile', '-Command', script], cwd: 'D:\\\\', env: {}, ...extra });

// ============ 指纹 ============

test('032 指纹：相同请求产生相同指纹', () => {
  expect(buildRequestFingerprint(shell('npm run build'))).toBe(buildRequestFingerprint(shell('npm run build')));
});

test('032 指纹：不同命令不同指纹', () => {
  expect(buildRequestFingerprint(shell('a'))).not.toBe(buildRequestFingerprint(shell('b')));
});

test('032 指纹：不同 cwd 不同指纹', () => {
  const a = buildRequestFingerprint({ ...shell('x'), cwd: 'D:\\\\a' });
  const b = buildRequestFingerprint({ ...shell('x'), cwd: 'D:\\\\b' });
  expect(a).not.toBe(b);
});

test('032 指纹：不同 env 不同指纹', () => {
  const a = buildRequestFingerprint(shell('x', { env: {} }));
  const b = buildRequestFingerprint(shell('x', { env: { PATH: 'C:\\\\evil' } }));
  expect(a).not.toBe(b);
});

test('032 指纹：env 键顺序不影响结果', () => {
  const a = buildRequestFingerprint(shell('x', { env: { A: '1', B: '2' } }));
  const b = buildRequestFingerprint(shell('x', { env: { B: '2', A: '1' } }));
  expect(a).toBe(b);
});

test('032 指纹：args 用 JSON 序列化，无空格歧义', () => {
  const one = { type: 'process', executable: 'cmd', args: ['a b'], cwd: 'D:\\\\', env: {} };
  const two = { type: 'process', executable: 'cmd', args: ['a', 'b'], cwd: 'D:\\\\', env: {} };
  expect(buildRequestFingerprint(one)).not.toBe(buildRequestFingerprint(two));
});

test('032 指纹：不同 timeoutMs 不同指纹', () => {
  const a = buildRequestFingerprint({ ...shell('x'), timeoutMs: 1000 });
  const b = buildRequestFingerprint({ ...shell('x'), timeoutMs: 2000 });
  const c = buildRequestFingerprint(shell('x'));
  expect(a).not.toBe(b);
  expect(a).not.toBe(c);
});

test('032 指纹：description 不参与（同命令不同描述指纹相同）', () => {
  const a = buildRequestFingerprint({ ...shell('x'), description: 'A' });
  const b = buildRequestFingerprint({ ...shell('x'), description: 'B' });
  expect(a).toBe(b);
});

test('032 指纹：是 64 位十六进制哈希（不含明文）', () => {
  const fp = buildRequestFingerprint(shell('echo SECRET_TOKEN_12345', { env: { API_KEY: 'sk-very-secret' } }));
  expect(fp).toMatch(/^[0-9a-f]{64}$/);
  expect(fp).not.toContain('SECRET');
  expect(fp).not.toContain('sk-very-secret');
});

test('032 指纹：shell 与 process 类型不同', () => {
  const a = buildRequestFingerprint(shell('dir'));
  const b = buildRequestFingerprint({ type: 'process', executable: 'cmd', args: ['dir'], cwd: 'D:\\\\', env: {} });
  expect(a).not.toBe(b);
});

// ============ 资格判定：禁止会话授权 ============

test('032 资格：L3 一律禁止', () => {
  expect(isSessionGrantBlocked(shell('npm run build'), 'L3')).toBe(true);
});

test('032 资格：L2 普通命令允许', () => {
  expect(isSessionGrantBlocked(shell('npm run build'), 'L2')).toBe(false);
  expect(isSessionGrantBlocked(shell('npm test'), 'L2')).toBe(false);
  expect(isSessionGrantBlocked(shell('npx tsc --noEmit'), 'L2')).toBe(false);
});

test('032 资格：git 状态变更禁止（含绝对路径 / .exe / -C）', () => {
  const cases = [
    'git push origin dev',
    'git commit -m x',
    'git add .',
    'git checkout -b feat/x',
    'git reset --hard',
    'git clean -fd',
    'git -C repo push',
    'git.exe commit -m x',
    '"C:\\\\Program Files\\\\Git\\\\cmd\\\\git.exe" push',
  ];
  for (const c of cases) expect(isSessionGrantBlocked(shell(c), 'L2'), c).toBe(true);
});

test('032 资格：高危命令禁止', () => {
  const cases = ['rm -rf /tmp/x', 'del /f /s /q C:\\\\x', 'format D:', 'Remove-Item -Recurse C:\\\\x'];
  for (const c of cases) expect(isSessionGrantBlocked(shell(c), 'L2'), c).toBe(true);
});

test('032 资格：命令链 / 管道 / 重定向一律禁止', () => {
  const cases = ['npm run a && npm run b', 'npm test | findstr x', 'echo hi > out.txt', 'a || b', 'a; b'];
  for (const c of cases) expect(isSessionGrantBlocked(shell(c), 'L2'), c).toBe(true);
});

test('032 资格：powershell 请求按剥离后的命令判定', () => {
  expect(isSessionGrantBlocked(ps('npm run build'), 'L2')).toBe(false);
  expect(isSessionGrantBlocked(ps('git push origin dev'), 'L2')).toBe(true);
  expect(isSessionGrantBlocked(ps('Remove-Item -Recurse C:\\\\x'), 'L2')).toBe(true);
});

test('032 资格：无法解析的 git 形态保守禁止', () => {
  expect(isSessionGrantBlocked(shell('git -c alias.publish=!git\\ push publish'), 'L2')).toBe(true);
  expect(isSessionGrantBlocked(shell('git --git-dir=x push'), 'L2')).toBe(true);
});

test('032 资格：所有 Git 形态一律禁止（保守正向判定）', () => {
  const cases = [
    'git -C repo push',
    'git.exe commit -m x',
    '"C:/Program Files/Git/cmd/git.exe" push',
    'git -c alias.publish=!git push publish',
    'git checkout -b newbranch',
    'git push',
    'git commit',
    'git ls-remote',
    'git unknown-subcommand-xyz',
    'git',
    'GIT PUSH',
    'git --git-dir=x status',
  ];
  for (const c of cases) expect(isSessionGrantBlocked(shell(c), 'L2'), c).toBe(true);
});

test('032 资格：普通开发命令允许会话授权', () => {
  for (const c of ['npm run build', 'npm test', 'npx tsc --noEmit']) {
    expect(isSessionGrantBlocked(shell(c), 'L2'), c).toBe(false);
  }
});