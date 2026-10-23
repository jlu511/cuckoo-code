---
id: 029
type: feature
title: 敏感路径 L3 授权统一
status: done
branch: dev
created: 2026-10-23
updated: 2026-10-23
---

## 背景

在此需求之前，敏感文件（SSH 私钥、云凭据、`.env` 等）的访问防护依赖分散的路径判断，
且**原生文件工具（read / write / edit / delete_file）完全没有统一的敏感路径授权**：
`read` 工具此前不存在任何权限检查，`write` / `edit` / `delete_file` 各自只有零散的校验。

同时，命令行侧对敏感路径的防护也不完整（外部评估结论：通用安全库对 CMD `type`、
`cat` 等读取方式存在漏网）。结果是同一个敏感文件，换个工具或换个命令就可能绕过确认，
防护强度取决于调用路径而非资产本身的敏感度。

## 目标

- 敏感路径访问**统一为 L3 明确授权**：无论通过系统命令还是原生文件工具，一律弹确认框
- L3 优先级最高，**覆盖 L0 只读白名单**（敏感路径不允许被"只读"规则静默放行）
- 拒绝 / 超时 / 异常三种情况**一律不执行**（fail-closed）
- 授权按**单次操作**处理，不产生持久放行
- 普通文件操作与 L0 静默查询的行为**保持不变**

## 方案

### 1. 路径分类层 —— `src/infra/sensitive-paths.ts`

纯词法路径分类，不依赖上层模块。覆盖范围：

- 目录：`.ssh`、`.aws`、`.gnupg`、`.kube`、`.docker`
- 文件名：`id_rsa`、`id_dsa`、`id_ecdsa`、`id_ed25519`、`.env`、`.npmrc`、
  `.git-credentials`、`.netrc`、`_netrc`、`.pgpass`、`credentials.json`
- 文件名模式：`.env.*`
- Windows 大小写不敏感，正反斜杠混用同样命中

### 2. 命令分析 + 处理器注入层 —— `src/tools/core/sensitive-guard.ts`

- `ALL_OPERANDS_ARE_PATHS`：所有操作数都按路径检查的命令集合
  （读取：`type` / `more` / `cat` / `head` / `tail` / `less` / `dir` / `ls` /
  `Get-Content` / `Get-Item` / `Get-ChildItem` / `Get-ItemProperty` / `Select-String`；
  复制移动：`copy` / `xcopy` / `robocopy` / `move`，**源和目标都检查**；
  删除：`del` / `erase` / `rm` / `Remove-Item` / `rmdir` / `rd`）
- `FIRST_OPERAND_IS_PATTERN`：`findstr` / `grep`，跳过第一个操作数（搜索模式不是路径）
- `PATH_PARAM_RE`：识别 `-Path:` / `-LiteralPath=` / `-FilePath` / `-Source` /
  `-Destination` / `-Src` / `-Dest` 形式的连写参数
- 处理器通过注入提供（`injectSensitivePathHandler`），`tools` 层不依赖 Electron

### 3. 授权处理器 —— `src/tools/core/default-sensitive-handler.ts`

Electron 红框弹窗（`type: 'error'`），标题「🔐 敏感路径访问」，展示目标路径、
操作类型（读取 / 修改 / 删除）、敏感类别。超时（默认 120s）→ `allow: false`；
弹窗异常 → `allow: false`；用户拒绝 → `allow: false`。

### 4. 执行器集成 —— `src/tools/core/executor.ts`

`assessRisk` 中判定顺序调整为：**L3 敏感路径 → L0 只读白名单 → L2 默认策略**。
敏感路径判定本身抛异常时回退 L2，不影响既有流程。

`default-handler.ts` 改为真正消费 `dto.riskLevel`（此前只按命令关键词判红框），
并为 L3 弹窗新增「风险说明」区块，逐条展示 `riskReasons`（含目标路径）。

### 5. 原生文件工具集成

四个工具在真实文件操作前调用 `checkSensitivePathAccess`：

| 工具 | operation |
|---|---|
| `src/tools/impl/read.ts` | `read` |
| `src/tools/impl/write.ts` | `write` |
| `src/tools/impl/edit.ts` | `write` |
| `src/tools/impl/delete-file.ts` | `delete` |

### 6. 注入点 —— `src/app/entry.ts`

`injectSensitivePathHandler(createDefaultSensitivePathHandler(120_000))`，
与 MCP 启动审批网关、插件安装审批网关并列。

## 验收标准

### 自动化

- [x] `test/infra/sensitive-paths.test.js` 15 个用例通过
- [x] `test/tools/sensitive-guard.test.js` 46 个用例通过
- [x] `test/tools/executor.test.js` 新增 6 个 L3 用例：
  `copy` 敏感源、`move` 敏感源、`del` 敏感目标、PS `Remove-Item`、
  `findstr` 敏感目标、普通复制不误升 L3
- [x] `del` 敏感目标判定为 **L3**（而非高危 L2），`runner.calls === 0`
- [x] 全量测试 1137/1137 通过（102 个测试文件）
- [x] `npm run typecheck` 0 错误（两套 tsconfig）
- [x] `npm run compile` 成功，生成物与提交内容一致，无额外源码改动

### 真机（Windows）

8/8 通过，夹具为 `D:\Software\cuckoo-code\__sensitive-test__`（假数据）：

| # | 场景 | 结果 |
|---|---|---|
| 1 | `type .ssh\id_rsa` | 红框 + 4 条风险说明，拒绝后未执行 |
| 2 | `copy .ssh\id_rsa leaked.txt` | 红框目标为源文件，拒绝后 `leaked.txt` 不存在 |
| 3 | `move .aws\credentials moved.txt` | 红框标注 AWS 凭据目录，源文件未移动 |
| 4 | `del /q .ssh\id_rsa` | L3 优先于高危拦截，拒绝后文件仍在 |
| 5 | PS `Remove-Item .ssh\id_rsa` | 红框，拒绝后文件仍在 |
| 6 | `findstr BEGIN .ssh\id_rsa` | 红框目标为 `id_rsa` 而非搜索模式 |
| 7 | `copy normal.txt normal2.txt` | 黄框默认策略，允许后复制成功 |
| 8 | `dir /a /b` | L0 静默，无弹窗 |

副作用核对：`.ssh\id_rsa`、`.aws\credentials`、`normal.txt`、`normal2.txt` 均存在；
`leaked.txt`、`moved.txt` 均不存在。

### 事后复验（提交 `1e42e40` 之上）

- `npm test`：102 files / 1137 tests 全部通过
- `npm run typecheck`：通过
- `npm run compile`：通过，`git status --short` 仍只有 `?? 1/`，生成物无漂移
- `git diff --check`：无空白错误（仅 CRLF/LF 提示）

## 遗留

以下为**尚未防护**或**防护不完整**的路径，本需求不声称已覆盖：

- **符号链接**：仅做词法路径分类，不解析 realpath
- **运行时动态路径**：`python -c "open('.ssh/id_rsa')"`、`node -e "..."` 等
- **变量展开**：`set F=.ssh\id_rsa & type %F%` 会被只读白名单拦为 L2，但不是 L3
- **Windows 8.3 短路径**：`ID_RSA~1` 一类路径不命中
- **未收录命令**：`certutil -dump`、`wmic`、`powershell -EncodedCommand` 等
- **插件运行时**：`ctx.fs` 无路径沙箱，`plugin-tools.ts` 反向 IPC 绕过 `SandboxExecutor`
- **MCP Server 内部工具调用**：不在本审批范围

体验类待优化项（不影响安全性）：

- **B4**：`read()` 对不存在的敏感路径也会弹窗（检查在 `existsSync` 之前）
- **B5**：敏感路径 + 工作区外写入会连续弹两次框（L3 红框 + 越界黄框）
- **B7**：`.env.example` / `.env.template` 被保守判为敏感
