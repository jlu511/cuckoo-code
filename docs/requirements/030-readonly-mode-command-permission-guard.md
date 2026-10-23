---
id: 030
type: fix
title: 只读模式命令执行权限守卫
status: done
branch: dev
created: 2026-10-23
updated: 2026-10-23
---

## 背景

`readOnly` 访问模式下，`src/infra/permission.ts` 的 `checkCommandPermission`
本应禁止一切系统命令执行，但该函数在全仓 **没有任何调用点**：

- `src/tools/impl/bash.ts`、`src/tools/impl/pwsh.ts` 无权限检查
- `src/app/ipc/command.ts`（`execute-command` IPC）无权限检查

只有 `write` / `edit` / `delete-file` 三个原生文件工具经 `checkPathPermission`
受 `readOnly` 约束。

### 已证实的越权路径

在 `CUCKOO_HOME` 指向的隔离目录中写入 `{"accessMode":"readOnly"}`，
使用打包产物中的真实 `registerCommandIpc()`，仅桩掉 Electron 弹窗（点"确认执行"），执行：

```
echo HELLO_FROM_IPC > "D:\...\__readonly-test__\ipc-write.txt"
```

结果：`success: true`，文件被真实创建，内容为 `HELLO_FROM_IPC`。

即：`readOnly` 模式对命令执行路径形同虚设。

## 目标

- `readOnly` 模式下，所有命令执行入口一律阻断（`bash` / `pwsh` / `execute-command`）
- 权限检查**先于**敏感路径检查、CC Safety Net 与 L0/L2 审批
- 不得被 L0 自动放行、用户批准或 CCSN 的 `allow` 覆盖
- `execute-command` 权限检查失败时**不回退**原有普通确认弹窗
- 可写模式（`workspaceWrite` / `fullAccess`）行为完全不变
- 权限检查异常时 fail-closed（不执行）

## 方案

沿用现有策略，不新造规则：`checkCommandPermission()` 当前语义是
"readOnly 模式禁止执行任何系统命令"，本需求忠实执行该语义，
**不为 L0 只读命令开例外**（如需放开应另立需求并明确授权语义）。

### 1. `SandboxExecutor.execute()`

在会话校验之后、拒绝熔断与并发去重之前（或在预检之前），插入权限检查：

```
会话与请求校验
    ↓
只读模式权限检查   ← 新增
    ├─ 不允许 → 直接阻断，不执行
    └─ 允许
         ↓
      敏感路径检查 → CC Safety Net → L0 / L2 审批 → 执行
```

复用 `checkCommandPermission`，异常 → 拒绝。

### 2. `src/app/ipc/command.ts`

在 `runSafetyPrecheck` 之前调用 `checkCommandPermission`；
不允许时弹阻断提示（无放行选项）并返回 `success: false`。

### 3. 测试

| 测试 | 预期 |
|---|---|
| 只读模式执行 `bash` 命令 | 阻断，runner 0 次 |
| 只读模式执行 `pwsh` 命令 | 阻断，runner 0 次 |
| 只读模式 `execute-command` 创建临时文件 | 阻断，文件不存在 |
| 只读模式 `echo x > file.txt` | 阻断，文件不存在 |
| 只读模式原生 `read` | 保持允许 |
| 可写模式合法命令 | 审批与执行行为不变 |
| 权限检查抛异常 | fail-closed，不执行 |

## 验收标准

- [ ] 上述 7 项测试全部通过
- [ ] 全量测试、typecheck、compile、lint 全绿
- [ ] 打包产物中复现原攻击路径，确认文件不再被创建
- [ ] 可写模式下 GUI 审批流程与只读模式阻断提示均真机确认

## 遗留

- 只读模式当前连 `dir /a /b` 之类的只读查询也一并禁止；
  是否放开查询类命令需另立需求评估授权语义
- 本需求只覆盖命令执行路径；插件 `ctx.fs`、`plugin-tools.ts`、
  MCP 内部调用等路径是否受 `readOnly` 约束未在本次范围
