---
id: 033
type: feature
title: 危险删除拦截与用户审批（Windows Shell 写保护-lite）
status: review
branch: feat/delete-guard
created: 2026-10-30
updated: 2026-10-30
---

# 需求 033：危险删除拦截与用户审批（Windows Shell 写保护-lite）

- **基线**：origin/master @ c665f5c（v0.8.18）

## 一、问题

AI 生成的删除命令（`rm -rf`、`del /s`、`Remove-Item -Recurse` 等）在以下场景会超出预期范围：

- 路径拼接错误：`rm -rf build` 因引号/斜杠问题变成 `rm -rf D:\`
- 相对路径解析：`rm -rf build/../..` 实际指向磁盘根
- 变量展开：`rm -rf $BUILD_DIR` 在环境变量为空时变成删当前目录
- 命令链：`echo hi && rm -rf D:\` 前半段看起来安全

上游 0.8.18 的 `infra/dangerous-commands.ts` 已有 18 条黑名单规则，但存在明显缺口：

| 命令 | 上游行为 |
|---|---|
| `rm -rf /` | ✅ 直接拒绝 |
| `rm -rf D:\` | ❌ **漏**（正则只匹配 `/` 和 `~`，不识别盘符根） |
| `rm -rf build/../..` | ❌ 漏 |
| `robocopy A B /MIR` | ❌ 漏 |
| `git clean -fdx` | ❌ 漏 |
| `del /s /q D:\` | ✅ 直接拒绝，但用户无选择权 |

`execute-command` IPC 更弱：`isDangerous` 只加一行警告文字，用户点确认照样执行。

## 二、目标与非目标

### 目标

1. **只在删除范围扩大到工作区根/磁盘根/工作区外时**弹窗，工作区内正常删除不打扰
2. 弹窗列出**真实目标路径 + 待删除文件清单**
3. 用户可选择「允许执行」或「我自己删」（取消命令并返回路径给 AI）
4. 无法可靠解析目标时**取消执行**，不给「允许执行」按钮

### 非目标（明确不做）

- ❌ 完整 OS 级沙箱（Low IL / 受限令牌 / 独立用户）：PoC 已证伪，见 `docs/security/`
- ❌ 所有递归删除一律弹窗（会严重打扰正常开发）
- ❌ 覆盖类操作（`> file`、`Set-Content`、`cp -f`）
- ❌ 读取隔离、网络隔离
- ❌ 插件 `ctx.fs`、MCP 文件操作
- ❌ 自动打开资源管理器定位
- ❌ 消除 TOCTOU（只做执行前 `lstat` 复查）

## 三、方案

### 3.1 判定规则（4 条）

| # | 条件 | 行为 |
|---|---|---|
| **1** | 上游 `DANGEROUS_CMDS` 命中（18 条） | **直接拒绝，不弹窗**（行为不变） |
| **2** | 解析后目标落在：盘符根 / 工作区根 / 工作区父目录 / 工作区外 | **弹窗**（红框 + 文件清单） |
| **3** | 无法可靠识别目标（变量、命令替换、`/` 开头非 UNC、引号不配对、无明确目标） | **弹窗但只给「我自己删」** |
| **4** | 其余（解析确认在工作区内子目录，非根） | **直接执行，不弹窗** |

**关键设计**：判定看 **resolve 后的路径**，不看命令字面。`rm -rf build` 在工作区内放行，`rm -rf build/../..` resolve 后是盘符根 → 弹窗。

### 3.2 路径分类

```
drive-root        盘符根（D:\ / C:/ / D: / /）
workspace-root    恰好是 workspaceRoot
workspace-parent  dirname(workspaceRoot)
outside           工作区外
inside            工作区内子目录
unknown           含变量 / Unix 绝对路径 / UNC / 无法解析
```

**保守判定**：
- 含变量（`$VAR` / `%VAR%` / `$(...)` / 反引号）→ `unknown`
- 以 `/` 开头且非 UNC → `unknown`（不猜 MSYS 环境）
- UNC（`\\\\server\share`）→ `unknown`
- `workspaceRoot = null`（IPC 未选工作区）→ 所有具体路径 → `outside`

### 3.3 命令识别

按**命令名**查表（不是按 shell）：

| 命令 | 生态 | 递归标志 |
|---|---|---|
| `rm` | unix | `-r` / `-rf` / `--recursive` |
| `rmdir` | 按 shell 消歧 | `-r` 或 `/s` |
| `del` / `erase` / `rd` | cmd | `/s` |
| `Remove-Item` / `ri` / `Clear-Content` | ps | `-Recurse` / `-r` |

**未列出的命令不视为删除命令**，不会触发保护。

**shell 外壳剥离**：`cmd /c ...`、`powershell -Command ...`、`bash -c ...`，剥后若外层有配对引号则去掉。

### 3.4 弹窗按钮

```
[允许执行]  [我自己删 (默认)]
```

- **允许执行**：执行原命令（执行前对每个目标 `lstat` 复查）
- **我自己删 (默认)**：不执行；返回路径清单给 AI

**「我自己删」返回的文本**：

```
用户未授权 AI 执行此删除操作，将自行手动处理。

请勿再次尝试删除以下目标：
  · D:\proj\build
  · D:\proj\cache
  （共 3 个目录、47 个文件，12.3 MB）

建议改用只读方式确认现状（如 dir / ls），或等待用户明确指示后再操作。
```

含无法解析目标时追加：

```
  ⚠️ 影响范围无法完全确定（命令含变量 / 脚本调用 / 无法解析的包装）
```

### 3.5 执行前复查（recheck）

用户点「允许执行」后，对每个已解析目标 `lstat`：

- 目标不存在 → reject（可能已被移动/删除）
- 目标变为符号链接 → reject（可能被替换）
- 其他异常 → reject

**不宣称消除 TOCTOU**，只防止明显的链接替换。

## 四、文件清单

### 新增

| 文件 | 层 | 职责 |
|---|---|---|
| `src/infra/dangerous-delete.ts` | infra | 命令分析 + 目标分类（纯函数，依赖 `dangerous-commands.ts` 的 `splitShellSegments`/`stripWrappers`） |
| `src/tools/core/delete-preview.ts` | tools | 扫描目标，产出文件清单（`lstat` 不跟随符号链接，上限 200） |
| `src/tools/core/delete-guard.ts` | tools | 编排 + `injectDeleteApprovalHandler` |
| `src/app/delete-approval.ts` | app | Electron 弹窗实现 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/tools/impl/bash.ts` | workDir 计算后插入 `guardDelete`（+10 行） |
| `src/tools/impl/pwsh.ts` | 同上（+10 行） |
| `src/app/ipc/command.ts` | `selectedDir` 后插入 `guardDelete`（+11 行） |
| `src/app/entry.ts` | `app.whenReady` 内注入 handler（+4 行） |
| `.gitignore` | 追加 `update/` |
| `eslint.config.js` | ignores 加 `update/**`、`reference/**`；files 加 `**/*.cjs` |

### 不改

`src/infra/dangerous-commands.ts`（上游 18 条规则原样保留，行为不变）

## 五、接入点（实测行号）

| 文件 | 插入位置 |
|---|---|
| `bash.ts` | 第 128 行（workDir 计算完）后、第 134 行（`exec()`）前 |
| `pwsh.ts` | 第 117 行后、第 123 行前 |
| `ipc/command.ts` | 第 24 行（`selectedDir`）后、第 26 行（`isDangerous` 警告）前 |
| `entry.ts` | 第 1349 行（`setupAppMenu()` 后） |

**关键**：`guardDelete` 必须放在 workDir 计算**之后**（需要 `workDir` 参数）。

## 六、失败策略（fail-closed）

| 场景 | 行为 |
|---|---|
| handler 未注入 | reject |
| 分析异常 | reject |
| 预览异常 | reject（仅当 `hasUnresolved = false` 时才预览） |
| 弹窗异常 | reject |
| 执行前 `lstat` 失败 | reject |
| 目标变为符号链接 | reject |

## 七、测试

### 测试文件

- `test/infra/dangerous-delete.test.js`（23 用例）
- `test/tools/delete-preview.test.js`（8 用例）
- `test/tools/delete-guard.test.js`（9 用例）

### 关键覆盖

| 场景 | 期望 |
|---|---|
| `rm -rf build`（工作区内） | `none`（放行） |
| `rm -rf build/../..` | `preview`（drive-root） |
| `rm -rf D:\` | `preview`（drive-root） |
| `rm -rf ../other` | `preview`（outside） |
| `rm -rf .` | `preview`（workspace-root） |
| `rm -rf $TARGET` | `unknown` |
| `rm -rf /d/foo` | `unknown` |
| `rm a.txt`（工作区内） | `none` |
| `del D:\x.txt` | `preview` |
| `cmd /c "rm -rf D:\"` | `preview` |
| 符号链接 | 只列链接本身，不递归 |
| recheck 目标消失 | reject |
| recheck 目标变链接 | reject |

### 上游回归

上游 18 条规则**行为不变**（仍直接拒绝，不进 `guardDelete`）。

## 八、验证

### 自动化

- `npm run typecheck`：0 错误
- `npx vitest run`：**108 files / 1027 tests 全通过**（基线 964，新增 63）
- `npm run lint`：0 errors（30 warnings 为存量）
- `npm run compile`：通过
- 上游 18 条规则回归（`test/main/dangerous-commands.test.js` + `test/tools/BashTool.test.js`）：24 tests 全过

### 测试文件清单

| 文件 | 用例数 |
|---|---|
| `test/infra/dangerous-delete.test.js` | 23 |
| `test/infra/dangerous-delete-drives.test.js` | 5 |
| `test/infra/dangerous-delete-quote.test.js` | 10 |
| `test/infra/dangerous-delete-wildcard.test.js` | 9 |
| `test/tools/delete-preview.test.js` | 8 |
| `test/tools/delete-guard.test.js` | 9 |

### 真机验证（8/8 通过）

用独立 Electron 主进程加载 `out/src/` 编译产物，`K:\test-workspace` 作为工作区（K 盘不存在，避免误操作）。

| # | 命令 | 弹窗 | 按钮数 | 结果 |
|---|---|---|---|---|
| 1 | `rm -rf build` | 无 | — | execute（不打扰） |
| 2 | `rm -rf .` | 🚨 红框 | 2 | manual |
| 3 | `rm -rf build/*` | 🗑️ | **1** | manual |
| 4 | `rm -rf D:\` | 🚨 红框 | 2 | manual |
| 5 | `rm -rf $TARGET` | 🗑️ | **1** | manual |
| 6 | `echo "hello; world"` | 无 | — | execute（不误伤） |
| 7 | `echo hi && rm -rf D:\` | 🚨 红框 | 2 | manual |
| 8 | `del D:\x.txt` | 🚨 红框 | 2 | manual |

**真机验证发现 1 个 P0 缺陷**（见 §十一），已修复并复测通过。

## 九、已知局限（如实声明）

1. **解析错误可能导致漏拦**：`path.resolve` 对含特殊字符的输入可能误判。这是本方案的根本风险，不宣称完全消除
2. **编码调用无法识别**：`powershell -EncodedCommand` 这类命令本身不是删除命令，所有黑名单都拦不住
3. **脚本内部删除**：`python clean.py` 视为 `unknown`，弹窗但无清单
4. **不消除 TOCTOU**：弹窗到执行之间的竞态只做 `lstat` 复查
5. **符号链接指向未解析**：只做词法路径分类，不解析 `realpath`
6. **插件 `ctx.fs` / MCP**：不在范围
7. **读取 / 网络 / 覆盖操作**：不在范围

## 十、合并策略

基于 `origin/master`（0.8.18）的独立分支 `feat/delete-guard`，不修改 `dev`。

**改动规模**：
- 新增 4 个文件（约 560 行）
- 修改 6 个文件（共约 40 行插入）
- **改上游函数签名 0 处**

**合并难度：低**。风险最高的是 `entry.ts`（上游 0.8.18 改了 89 行），但只插 1 行孤立代码。真正风险是**语义冲突**（上游将来自己做删除确认），不是文本冲突。

## 十一、审查与真机验证发现的缺陷及修复

### 第一次代码审查发现的 4 个 P0/P1 缺陷

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | 引号内的 `;` / `|` / `&` 被误当命令分隔符（`echo "hello; world"` 误判 unknown） | 新增 `splitSegmentsAwareQuotes`，跟踪引号状态、支持转义 `\"`；未配对引号整体降级为 unknown；`tokenize` 失败只在 `looksLikeDeleteCommand` 命中时标 unknown |
| 2 | 通配符目标（`D:\*` / `build/*`）显示「允许执行」后必然被 recheck 拒绝 | `classifyToken` 在 resolve 前将 `isWildcard` 归为 `unknown` → `allowExecute = false` → 弹窗只有「我自己删」 |
| 3 | Windows 路径大小写敏感导致工作区内路径被误判为 outside | 分类比较时 `toLowerCase()`（仅 Windows），`resolved` 保持原始值 |
| 4 | `D:foo` / `D:..` 盘符相对路径未处理 | 正则 `/^[A-Za-z]:(?![\\/])/` → `unknown`；`D:\foo` 仍按绝对路径 |
| 5 | 弹窗清单统计口径不含符号链接 | `total = totalFiles + totalDirs + linkCount`，显示链接数量 |

### 真机验证发现的 P0 缺陷

**现象**：`allowExecute=false`（只显示「我自己删」一个按钮）的场景，用户点唯一按钮后返回 `action: "allow"`，即**误执行删除**。

**根因**：`delete-approval.ts` 的按钮判定逻辑

```typescript
const buttons = req.allowExecute
  ? ['允许执行', '我自己删 (默认)']
  : ['我自己删 (默认)'];          // 只有 1 个按钮
const defaultId = buttons.length - 1;  // allowExecute=false 时 = 0
// ...
return response === 0 ? 'allow' : 'manual';  // BUG：唯一按钮 response=0 被当成 allow
```

**为什么自动化测试没抓到**：`test/tools/delete-guard.test.js` 用 mock handler 直接返回 `'manual'`，绕过了真实 Electron dialog 的 `response === 0` 行为。

**修复**：

```typescript
// allowExecute=false 时只有「我自己删」一个按钮，response 必然是 0，不能按 index 判断
if (!req.allowExecute) return 'manual';
return response === 0 ? 'allow' : 'manual';
```

**复测**：真机验证 CASE 3（`rm -rf build/*`）和 CASE 5（`rm -rf $TARGET`）均返回 `manual` ✅。

### 修复后的完整验证

- `npm run typecheck`：0 错误
- `npx vitest run`：108 files / 1027 tests 全通过
- `npm run lint`：0 errors
- `npm run compile`：通过
- 真机验证 8/8 通过（含 P0 缺陷复测）
