import { test, expect } from 'vitest';
import { isL0ReadOnly } from '../../src/tools/core/readonly-checker.js';

function shell(cmd) {
  return { type: 'shell', shellType: 'cmd', rawCommand: cmd, cwd: 'D:\\', env: {} };
}

// ============ 031：放行的 Git 只读命令 ============

test('031 放行: git status 各种形态', () => {
  expect(isL0ReadOnly(shell('git status'))).toBe(true);
  expect(isL0ReadOnly(shell('git status -s'))).toBe(true);
  expect(isL0ReadOnly(shell('git status -sb'))).toBe(true);
  expect(isL0ReadOnly(shell('git status --short'))).toBe(true);
  expect(isL0ReadOnly(shell('git status --porcelain'))).toBe(true);
  expect(isL0ReadOnly(shell('git status -s -b'))).toBe(true);
  expect(isL0ReadOnly(shell('GIT status --short'))).toBe(true);
});

test('031 放行: git branch --show-current', () => {
  expect(isL0ReadOnly(shell('git branch --show-current'))).toBe(true);
});

test('031 放行: git diff 只读形态', () => {
  expect(isL0ReadOnly(shell('git diff --stat'))).toBe(true);
  expect(isL0ReadOnly(shell('git diff --cached --name-only'))).toBe(true);
  expect(isL0ReadOnly(shell('git diff --cached --check'))).toBe(true);
  expect(isL0ReadOnly(shell('git diff --stat -- .cuckoo/CUCKOO.md docs/arch/03-build.md package.json'))).toBe(true);
  expect(isL0ReadOnly(shell('git diff --stat --cached'))).toBe(true);
});

test('031 放行: git rev-parse 单个 ref', () => {
  expect(isL0ReadOnly(shell('git rev-parse HEAD'))).toBe(true);
  expect(isL0ReadOnly(shell('git rev-parse origin/dev'))).toBe(true);
  expect(isL0ReadOnly(shell('git rev-parse main'))).toBe(true);
  expect(isL0ReadOnly(shell('git rev-parse v1.0.0'))).toBe(true);
});

test('031 放行: git log --oneline -N（1-20）', () => {
  expect(isL0ReadOnly(shell('git log --oneline -1'))).toBe(true);
  expect(isL0ReadOnly(shell('git log --oneline -3'))).toBe(true);
  expect(isL0ReadOnly(shell('git log --oneline -20'))).toBe(true);
  expect(isL0ReadOnly(shell('git log --oneline'))).toBe(true);
  expect(isL0ReadOnly(shell('git log --oneline -n 5'))).toBe(true);
});

test('031 放行: git show --stat --oneline <ref>', () => {
  expect(isL0ReadOnly(shell('git show --stat --oneline HEAD'))).toBe(true);
  expect(isL0ReadOnly(shell('git show --oneline --stat HEAD'))).toBe(true);
});

// ============ 031：拒绝的 Git 命令 ============

test('031 拒绝: 状态变更命令', () => {
  expect(isL0ReadOnly(shell('git add -- file.txt'))).toBe(false);
  expect(isL0ReadOnly(shell('git add .'))).toBe(false);
  expect(isL0ReadOnly(shell('git commit -m "x"'))).toBe(false);
  expect(isL0ReadOnly(shell('git push origin dev'))).toBe(false);
  expect(isL0ReadOnly(shell('git pull'))).toBe(false);
  expect(isL0ReadOnly(shell('git reset --hard'))).toBe(false);
  expect(isL0ReadOnly(shell('git checkout -- file'))).toBe(false);
  expect(isL0ReadOnly(shell('git clean -fd'))).toBe(false);
});

test('031 拒绝: --output 写文件', () => {
  expect(isL0ReadOnly(shell('git diff --output=out.txt'))).toBe(false);
  expect(isL0ReadOnly(shell('git diff --stat --output=out.txt'))).toBe(false);
  expect(isL0ReadOnly(shell('git log --oneline --output=log.txt'))).toBe(false);
  expect(isL0ReadOnly(shell('git status --output=x'))).toBe(false);
});

test('031 拒绝: --ext-diff / --no-index', () => {
  expect(isL0ReadOnly(shell('git diff --stat --ext-diff'))).toBe(false);
  expect(isL0ReadOnly(shell('git diff --no-index a b'))).toBe(false);
  expect(isL0ReadOnly(shell('git show --stat --oneline --ext-diff HEAD'))).toBe(false);
});

test('031 拒绝: 改变仓库定位', () => {
  expect(isL0ReadOnly(shell('git rev-parse --git-dir=C:\\other'))).toBe(false);
  expect(isL0ReadOnly(shell('git rev-parse --work-tree=C:\\other HEAD'))).toBe(false);
  expect(isL0ReadOnly(shell('git status --git-dir=x'))).toBe(false);
});

test('031 拒绝: 改运行时配置 / 执行路径', () => {
  expect(isL0ReadOnly(shell('git -c core.pager=evil status'))).toBe(false);
  expect(isL0ReadOnly(shell('git --exec-path=C:\\evil status'))).toBe(false);
  expect(isL0ReadOnly(shell('git status --exec-path=x'))).toBe(false);
});

test('031 拒绝: --format / --pretty', () => {
  expect(isL0ReadOnly(shell('git log --oneline --format=%H'))).toBe(false);
  expect(isL0ReadOnly(shell('git log --oneline --pretty=full'))).toBe(false);
  expect(isL0ReadOnly(shell('git show --stat --oneline --format=x HEAD'))).toBe(false);
});

test('031 拒绝: git show 不带 --stat（完整补丁）', () => {
  expect(isL0ReadOnly(shell('git show HEAD'))).toBe(false);
  expect(isL0ReadOnly(shell('git show --oneline HEAD'))).toBe(false);
  expect(isL0ReadOnly(shell('git show --stat HEAD'))).toBe(false);
});

test('031 拒绝: git diff 无显示类选项（裸 diff 输出补丁）', () => {
  expect(isL0ReadOnly(shell('git diff'))).toBe(false);
  expect(isL0ReadOnly(shell('git diff -- ./file.txt'))).toBe(false);
  expect(isL0ReadOnly(shell('git diff --cached'))).toBe(false);
});

test('031 拒绝: git log 数量越界', () => {
  expect(isL0ReadOnly(shell('git log --oneline -0'))).toBe(false);
  expect(isL0ReadOnly(shell('git log --oneline -21'))).toBe(false);
  expect(isL0ReadOnly(shell('git log --oneline -100'))).toBe(false);
  expect(isL0ReadOnly(shell('git log --oneline -n 100'))).toBe(false);
  expect(isL0ReadOnly(shell('git log --oneline -n'))).toBe(false);
});

test('031 拒绝: git log 未知参数', () => {
  expect(isL0ReadOnly(shell('git log --oneline --graph'))).toBe(false);
  expect(isL0ReadOnly(shell('git log --oneline -p'))).toBe(false);
  expect(isL0ReadOnly(shell('git log --all --oneline'))).toBe(false);
});

test('031 拒绝: git log 必须含 --oneline', () => {
  expect(isL0ReadOnly(shell('git log'))).toBe(false);
  expect(isL0ReadOnly(shell('git log -3'))).toBe(false);
});

test('031 拒绝: git rev-parse 参数数量不对', () => {
  expect(isL0ReadOnly(shell('git rev-parse'))).toBe(false);
  expect(isL0ReadOnly(shell('git rev-parse HEAD HEAD'))).toBe(false);
  expect(isL0ReadOnly(shell('git rev-parse --all'))).toBe(false);
});

test('031 拒绝: git status 未知参数', () => {
  expect(isL0ReadOnly(shell('git status --ignored'))).toBe(false);
  expect(isL0ReadOnly(shell('git status -uall'))).toBe(false);
  expect(isL0ReadOnly(shell('git status --verbose'))).toBe(false);
});

test('031 拒绝: git branch 额外参数', () => {
  expect(isL0ReadOnly(shell('git branch'))).toBe(false);
  expect(isL0ReadOnly(shell('git branch -a'))).toBe(false);
  expect(isL0ReadOnly(shell('git branch -D main'))).toBe(false);
  expect(isL0ReadOnly(shell('git branch --show-current extra'))).toBe(false);
});

test('031 拒绝: git diff 路径含危险字符', () => {
  expect(isL0ReadOnly(shell('git diff --stat -- *.js'))).toBe(false);
  expect(isL0ReadOnly(shell('git diff --stat -- ../outside'))).toBe(false);
  expect(isL0ReadOnly(shell('git diff --stat -- a;b'))).toBe(false);
});

test('031 拒绝: 非 git 命令不受影响', () => {
  expect(isL0ReadOnly(shell('gitx status'))).toBe(false);
  expect(isL0ReadOnly(shell('mygit status'))).toBe(false);
});

// ============ 031：&& 链式命令 ============

test('031 放行: 全为只读 git 的 && 链', () => {
  const chain = 'git rev-parse HEAD && git rev-parse origin/dev && git status -sb && git status --short && git log --oneline -3';
  expect(isL0ReadOnly(shell(chain))).toBe(true);
});

test('031 放行: 两段只读 git 链', () => {
  expect(isL0ReadOnly(shell('git status --short && git log --oneline -3'))).toBe(true);
});

test('031 放行: echo + git 只读混合链', () => {
  expect(isL0ReadOnly(shell('echo "=== status ===" & git status --short'))).toBe(true);
});

test('031 放行: 原有 echo + dir 链未受影响', () => {
  expect(isL0ReadOnly(shell('echo "x" & dir /b "C:\\a"'))).toBe(true);
});

test('031 拒绝: 链中混入 git push', () => {
  expect(isL0ReadOnly(shell('git status --short && git push origin dev'))).toBe(false);
  expect(isL0ReadOnly(shell('git push origin dev && git status --short'))).toBe(false);
});

test('031 拒绝: 链中混入 git add / commit', () => {
  expect(isL0ReadOnly(shell('git status --short && git add .'))).toBe(false);
  expect(isL0ReadOnly(shell('git log --oneline -3 && git commit -m x'))).toBe(false);
});

test('031 拒绝: 链中混入危险参数', () => {
  expect(isL0ReadOnly(shell('git status --short && git diff --output=x'))).toBe(false);
});

test('031 拒绝: 链中混入 del', () => {
  expect(isL0ReadOnly(shell('git status --short && del file.txt'))).toBe(false);
  expect(isL0ReadOnly(shell('git status && Remove-Item x'))).toBe(false);
});

test('031 拒绝: 空段', () => {
  expect(isL0ReadOnly(shell('git status --short && '))).toBe(false);
  expect(isL0ReadOnly(shell(' && git status'))).toBe(false);
});

// ============ 031：管道与 node -e 仍拒绝 ============

test('031 拒绝: 管道命令（本轮不扩展）', () => {
  expect(isL0ReadOnly(shell('git show --stat --oneline HEAD | findstr /V /C:"^s"'))).toBe(false);
  expect(isL0ReadOnly(shell('git status --short | findstr a'))).toBe(false);
  expect(isL0ReadOnly(shell('git log --oneline -3 | more'))).toBe(false);
});

test('031 拒绝: node -e 仍走 L2', () => {
  expect(isL0ReadOnly(shell('node -e "console.log(1)"'))).toBe(false);
  expect(isL0ReadOnly(shell('node --eval "console.log(1)"'))).toBe(false);
  expect(isL0ReadOnly(shell('node -p "process.env"'))).toBe(false);
});
