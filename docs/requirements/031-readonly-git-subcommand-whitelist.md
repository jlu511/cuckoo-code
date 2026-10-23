---
id: 031
type: feature
title: 只读 Git 子命令白名单扩展
status: doing
branch: feat/031-readonly-git-subcommand-whitelist
created: 2026-10-23
updated: 2026-10-23
---

## 背景

L0 只读白名单当前对 `git` 只放行 `git --version` 一种形态（`readonly-checker.ts` 的
`VERSION_ARGS_RE` + `KNOWN_SAFE_BINARIES`）。实际开发中 AI 高频执行纯查询类 Git 命令：

```
git status --short
git branch --show-current
git diff --stat -- <files>
git diff --cached --name-only
git diff --cached --check
git rev-parse HEAD
git log --oneline -3
git show --stat --oneline HEAD
```

这些命令**没有任何副作用**，却因未命中白名单而全部落入 L2 审批弹窗。
一次例行验证会连续弹出 10 次以上确认框，严重拖慢效率。

另一方面，`git add` / `git commit` / `git push` 确实改变状态，必须继续审批。

### 本次问题的实际触发场景

一次「确认构建脚本改动并提交」的操作，产生了 12 个弹窗，其中 **7 个是纯只读查询**。

## 目标

- 将**严格受限的只读 Git 子命令**纳入 L0，消除无意义弹窗
- 采用**正向枚举**（只列允许的参数），未知参数默认走 L2，不继承 L0
- 支持 `&&` 链式命令：**每一段都命中白名单**才整体放行
- 状态变更类 Git 命令（`add` / `commit` / `push`）继续审批
- 管道 `|` 本轮**不扩展**
- `node -e` 等动态代码通道**不纳入**任何通用白名单

## 方案

### 1. Git 只读判定器（正向枚举）

在 `src/tools/core/readonly-checker.ts` 新增 `isSafeGitReadOnly(args: string[]): boolean`，
**只接受白名单内明确的子命令与参数组合**，未知参数一律拒绝。

放行清单：

| 子命令 | 允许形态 |
|---|---|
| `status` | `-s` / `--short` / `-b` / `-sb` / `--porcelain` / 无参数 |
| `branch` | `--show-current`（无额外参数） |
| `diff` | `--stat` / `--cached` / `--name-only` / `--check` 的组合；`--` 后可跟路径参数 |
| `rev-parse` | 单个 ref 参数（`HEAD` / `origin/dev` 等，形如 `[A-Za-z0-9_./-]+`） |
| `log` | 必须含 `--oneline`；数量参数 `-N` 限制在 1–20；不接受 `--format` |
| `show` | 必须同时含 `--stat` 与 `--oneline`；后跟单个 ref；**不带 --stat 的 git show 不放行** |

显式拒绝的危险参数（即使出现在上述子命令中）：

- `--output=` / `--output `（写文件）
- `--ext-diff` / `--no-index`（外部程序 / 任意路径比较）
- `--git-dir=` / `--work-tree=`（改变仓库定位）
- `-c` / `--exec-path=`（改运行时配置）
- `--format=` / `--pretty=`（本轮不放行自定义格式）
- `--open-files-in-pager` / `-O` / `--ext-diff`
- 任何以 `--output` / `--exec` 开头的未知长参数

### 2. 链式命令扩展

现有 `isSafeCmdChain` 只允许 `echo "..."` 和 `dir` 段。扩展为：
每一段先尝试 `isSafeChainSegment`，再尝试 `isSafeGitReadOnly`；
**任一失败 → 整条命令 L2**。

示例（应放行）：
```
git rev-parse HEAD && git rev-parse origin/dev && git status -sb && git status --short && git log --oneline -3
```

示例（应拒绝）：
```
git status --short && git push origin dev
```

### 3. 保持不变

- 管道 `|` 仍全局拦截
- `node -e` / `python -c` 不放行
- `git add` / `git commit` / `git push` 走 L2
- 无 `--stat` 的 `git show HEAD`（输出完整补丁）走 L2

## 验收标准

### 自动化

- [ ] 放行：`git status` / `git status -s` / `git status -sb` / `git status --short` / `git status --porcelain`
- [ ] 放行：`git branch --show-current`
- [ ] 放行：`git diff --stat` / `git diff --cached --name-only` / `git diff --cached --check` / `git diff --stat -- <paths>`
- [ ] 放行：`git rev-parse HEAD` / `git rev-parse origin/dev`
- [ ] 放行：`git log --oneline -3`（含 1–20 边界）
- [ ] 放行：`git show --stat --oneline HEAD`
- [ ] 放行：上述命令的 `&&` 合法链
- [ ] 拒绝：`git diff --output=x` / `--ext-diff` / `--no-index`
- [ ] 拒绝：`git rev-parse --git-dir=...` / `--work-tree=...`
- [ ] 拒绝：`git -c ...` / `--exec-path=...`
- [ ] 拒绝：`git log --format=...`
- [ ] 拒绝：`git show HEAD`（无 --stat）
- [ ] 拒绝：`git log --oneline -100`（超数量上限）
- [ ] 拒绝：`git add` / `git commit` / `git push`
- [ ] 拒绝：`git status --short && git push origin dev`（链中含不安全段）
- [ ] 拒绝：任何带 `|` 的命令
- [ ] 拒绝：`node -e "..."` 仍走 L2
- [ ] `npm test` / `npm run typecheck` / `npm run compile` / `git diff --check` 全绿

### 真机

- [ ] 在 Cuckoo 中执行 `git status --short` 无弹窗
- [ ] 执行 `git add <file>` 仍弹窗
- [ ] 执行 `git status --short && git push` 仍弹窗

## 遗留

- **PATH 劫持风险未消除**：判定器按名字匹配可执行文件，不验证实际执行路径。
  名为 `git` 的恶意程序若在 PATH 前部，仍会被当作 git 放行。这是既有限制，
  本次加入 Git 子命令后**不改变**该风险，也不声称已解决。
- **L0 不是 OS 沙箱**：L0 仅表示"命令本身无副作用"，执行进程仍拥有完整系统权限。
  应用层审批 ≠ 操作系统级隔离（见 `docs/security/phase-2-sandbox-conclusion.md`）。
- 管道 `|` 未扩展，`git show ... | findstr` 仍需审批。
- `node -e` 未纳入任何通用白名单。
- `git log --format` 未放行（避免自定义格式可能触发外部程序）。
