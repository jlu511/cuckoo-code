# SandboxExecutor Phase 1.1 验收报告（Windows 进程树清理）

> 验收日期：2026-10-21
> 提交基线：Phase 1.1 修改（executor / default-runner / default-handler / 测试）

## 1. 环境

| 项 | 值 |
|---|---|
| Windows | 10.0.19044（21H2） |
| Node.js | v24.18.0 |
| 测试时间 | 2026-10-21 17:05 前后 |

## 2. 测试方式与边界

本次真机测试**通过独立 PowerShell 窗口运行脚本**完成，不经过 Cuckoo 的审批网关。测试目标是验证 `src/tools/core/default-runner.ts` 中 `taskkill /T /F /PID` 的进程树清理能力，而非端到端审批流。

测试脚本只操作自身 `spawn` 出来的 PID，全程未使用 `taskkill /IM` 或按进程名批量清理。

## 3. 进程树结构

```
Node 测试驱动 (PID 11344)
  └── cmd.exe (root PID)
        ├── conhost.exe
        └── powershell.exe  (-Command "Start-Sleep 45")
```

实测每轮启动的进程层级一致，包含控制台宿主 `conhost.exe` 与真实 PowerShell 子进程。

## 4. 取消场景（3 轮）

| 轮次 | root PID | taskkill 耗时 | 清理前 PID | 清理后残留 | 存活检查 | 结果 |
|---|---|---|---|---|---|---|
| A1 | 18640 | 145 ms | 18640, 13268, 24540 | `[]` | `[]` | PASS |
| A2 | 22504 | 152 ms | 22504, 23076, 20412 | `[]` | `[]` | PASS |
| A3 | 19972 | 139 ms | 19972, 3020, 17656 | `[]` | `[]` | PASS |

三轮清理后对原始 PID 逐一调用 `Get-Process -Id <pid>` 均返回不存在，**后代进程（conhost / powershell）全部退出**，非仅 root 退出。

## 5. 正常退出与幂等

| 测试 | 内容 | 结果 |
|---|---|---|
| B | `echo hi` 自然结束，未触发强制清理 | PASS |
| C1 | 进程已退出后调用 `taskkill /PID`，返回 false，不崩溃 | PASS |
| C2 | 连续 3 次 `taskkill /PID`，返回 `true, false, false`，幂等 | PASS |

## 6. 未验证项

1. **`taskkill` 启动失败**（如系统权限异常、`taskkill.exe` 缺失）——需人为破坏环境，风险高，未执行。
2. **PID 复用竞态**——root PID 被系统回收并复用给其他进程后，`taskkill /PID` 可能误杀无关进程。当前代码无 PID 复用防护（未记录进程创建时间）。
3. **更深层进程树**（4 层以上）未测。
4. **长时间运行后取消**（如 5 分钟后再取消）未测。
5. **经 Cuckoo 审批网关的端到端取消**未测（本轮为独立脚本验证）。

## 7. 结论

**当前 Windows 10 测试环境下，已覆盖的三轮取消场景均成功清理目标进程树；正常退出及重复清理场景通过。PID 复用竞态、taskkill 启动失败等情形尚未验证，不应据此宣称所有 Windows 进程清理场景均已安全覆盖。**

## 8. Phase 1.1 能力边界

- **应用层审批 ≠ OS 级沙箱**：批准后的子进程拥有与 Cuckoo 主进程相同的系统权限。
- **未接入入口**：`pwsh.ts`、MCP 客户端、插件系统仍未经过 `SandboxExecutor`，可绕过审批。
- **拒绝熔断为精确签名匹配**：改空格、换 shell、改 cwd 均可绕过；不构成语义级防护。
- **审计脱敏仅覆盖 env 键名匹配**：命令行参数、stdout/stderr 中的秘密无法识别。
- **`bash.ts` 未传 `activeSessionId`**：会话切换校验暂未生效。
