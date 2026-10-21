# Phase 2 原生 OS 沙箱原型技术结论

> 归档日期：2026-10-21
> 状态：**已结束，未达到生产准入要求**
> 本阶段仅做原型验证，不接入生产执行器，不宣称 OS 级隔离已实现。

## 1. 背景

Phase 1 已落地应用层审批控制（`SandboxExecutor`，含会话校验、拒绝熔断、危险命令红框识别）。但用户批准后，子进程仍继承当前用户的完整系统权限。

Phase 2 的目的是探索 Windows 原生隔离方案，验证能否在**不修改生产代码、不请求管理员权限**的前提下，限制 AI 执行命令对工作区外文件的写入能力。

本轮测试了两种原生方案：
- **AppContainer**（自定义 SID + 低完整性级别）
- **Restricted Token**（`CreateRestrictedToken` + `WRITE_RESTRICTED`）

**结论：两种原型均未达到生产准入要求。Phase 2 正式结束，回退到 Phase 1 应用层安全控制。**

## 2. 测试环境

| 项 | 值 |
|---|---|
| Windows | 10.0.19044（21H2）x64 |
| 编译器 | Visual Studio 2022 Community，MSVC 19.36 |
| 构建工具链 | `vcvarsall.bat x64` + `cl.exe /EHsc` |
| 测试账号 | 当前用户（Medium Integrity，非管理员） |

## 3. AppContainer 原型

### 3.1 原型目标
创建自定义 AppContainer profile，以低完整性级别启动 `cmd.exe`，验证：
1. 能否写入显式授权的目录。
2. 是否拒绝写入未授权目录。
3. 能否读取未授权目录。
4. 能否访问网络（无 capability 配置时应失败）。
5. 子进程是否继承限制。

### 3.2 源码位置（保留）
`D:\Software\cuckoo-code\appcontainer-proto\`
- `Launcher.cpp`（5728 字节）
- `build.bat`
- `run-tests.ps1`（测试矩阵）
- `Launcher.exe`（304KB）

**注意**：当前版本 Launcher 没有写 debug.log 的逻辑（用的是 stdout 输出）。归档时未保留当次测试日志快照。

### 3.3 实际结果（2026-10-21 19:27 前后）

| 测试 | 期望 | 实际 | 判定 |
|---|---|---|---|
| OS-01 写入授权目录 | 成功 | 文件未创建 | **FAILED** |
| OS-02 写入未授权目录 | 拒绝 | 文件未创建 | PASSED（阴性结果） |
| OS-03 读取未授权目录 | 拒绝 | 无输出，未捕获到 Access Denied | UNEXPECTED |
| OS-05 子进程继承限制 | 授权目录成功、未授权目录失败 | 两者都失败 | FAILED |
| OS-06 网络访问 | 拒绝 | 无输出 | 未验证 |
| OS-07 环境变量 | 成功 | 无输出 | FAILED |

每次运行都成功打印了 AppContainer SID：`S-1-15-2-581802951-3921772608-1048006002-3183890719-1604759062-2223445326-594618865`。

### 3.4 已确认的事实
1. `CreateAppContainerProfile` 成功创建自定义 SID。
2. `CreateProcessW`（配合 `SECURITY_CAPABILITIES`）能启动子进程，未报 `CreateProcessW failed`。
3. 子进程启动后**未产生任何授权目录写入**，也未通过管道返回任何输出。
4. 授权目录的 DACL 已通过 `SetNamedSecurityInfoW` 为 AppContainer SID 授予了 `GENERIC_ALL`。
5. 授权目录的 SACL 已通过 `SetNamedSecurityInfoW` 设置为 Low Integrity。

### 3.5 可能原因（未确认为唯一根因）
- **系统目录 ACL 限制**：自定义 SID 无法访问 `C:\Windows\System32` 下的 DLL 和可执行文件，导致 `cmd.exe` 初始化阶段即失败。
- **管道 ACL 未放行**：`CreatePipe` 默认继承当前用户的 ACL，AppContainer 内的低完整性进程可能无法写入管道。
- **IPC / 桌面隔离**：AppContainer 进程可能无法访问当前桌面的消息队列或窗口句柄。
- **完整性级别约束**：即使 DACL 正确，如果父目录的完整性标签高于 Low，仍可能被 MIC 拦截。

**特别说明**：未修改 `System32` 的 ACL 来尝试修复。这是安全决策 —— 修改系统目录权限会影响整个系统的稳定性，且无法在卸载时完全恢复，不适合作为桌面应用的默认行为。

### 3.6 不得声称的结论
- 不得声称 "AppContainer 在 Windows 上普遍不可行"。
- 不得声称 "`System32` ACL 是唯一根因"。
- 不得声称 "已经验证 AppContainer 无法隔离网络"。

真正可验证的结论只有：**在不修改系统 ACL 的前提下，使用自定义 SID 的 AppContainer 无法启动 `cmd.exe` 并执行命令**。

## 4. Restricted Token 原型

### 4.1 原型目标
使用 `CreateRestrictedToken`（`DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED` + 自定义 restricting SID）以受限令牌启动 `cmd.exe`，验证：
1. 能否启动并执行基础命令。
2. 是否真正限制文件写入。
3. 子进程和 Job Object 行为。

### 4.2 源码位置（保留）
`D:\Software\cuckoo-code\restricted-proto\`
- `Launcher.cpp`（4690 字节，最后修改 19:33）
- `build.bat`
- `run.ps1`
- `Launcher.exe`（177KB）
- `debug.log`（243 字节，最后写入 19:34）

### 4.3 令牌构建参数

```cpp
DWORD flags = DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED;
SID_AND_ATTRIBUTES sidsToRestrict[1];
sidsToRestrict[0].Sid = pRestrictSid;  // 自定义 SID: S-1-5-21-1111111111-2222222222-3333333333-1001
sidsToRestrict[0].Attributes = 0;
CreateRestrictedToken(hCurrentToken, flags, 0, NULL, 0, NULL, 1, sidsToRestrict, &hRestrictedToken);
```

### 4.4 实际令牌信息（来自 debug.log）

```
[Original] User SID: S-1-5-21-2929849406-1308706290-773228186-1000
[Restricted] User SID: S-1-5-21-2929849406-1308706290-773228186-1000
```

- 两者用户 SID 相同（说明令牌复制成功，用户身份未变）。
- `debug.log` 中缺失 Integrity Level 输出。最终版代码已调用 `DumpTokenInfo` 尝试打印，但 `GetTokenInformation(TokenIntegrityLevel)` 可能静默失败（`dwSize` 未填充），因此未记录到令牌完整性级别。不影响本报告对 `0xC0000142` 退出码的判定。

### 4.5 测试结果

#### 测试 A：`echo hello`（cmd 内置命令）
- 结果：**成功**。
- 日志：
  ```
  [DEBUG] Process started, PID: 21876
  [STDOUT] hello
  [DEBUG] Exit code: 0
  ```
- 结论：受限令牌能启动 `cmd.exe` 并执行内置命令。

#### 测试 B：`whoami /all`（独立外部程序）
- 结果：**失败**。
- 日志（最终 debug.log 内容）：
  ```
  [DEBUG] Process started, PID: 16956
  [STDOUT]
  [DEBUG] Exit code: 3221225794
  ```
- 退出码 `3221225794` = `0xC0000142` = **`STATUS_DLL_INIT_FAILED`**。
- 说明：受限令牌下，独立外部程序（`whoami.exe`）初始化阶段即崩溃，无法加载依赖的 DLL 或初始化控制台。

#### 测试 C：`echo hello > test.txt`（写文件）
- 结果：**失败**（文件未创建）。
- 日志：
  ```
  [DEBUG] Process started, PID: 20168
  [STDOUT]
  [DEBUG] Exit code: 0
  ```
- 说明：退出码 0 但 `test.txt` 未创建。可能原因：
  - `cmd.exe` 的 stdout 重定向在受限令牌下被管道 ACL 拦截。
  - `WRITE_RESTRICTED` 确实拦截了写入。
  - 授权目录的 ACL 未真正生效（尽管已调用 `SetEntriesInAclW`）。

### 4.6 已确认的事实
1. `CreateRestrictedToken` 成功。
2. `CreateProcessAsUserW` 成功启动 `cmd.exe`。
3. `cmd.exe` 内置命令（`echo`）能执行并返回输出。
4. 独立外部程序（`whoami.exe`）启动后返回 `0xC0000142`（`STATUS_DLL_INIT_FAILED`）。
5. 文件写入测试（`echo > file`）未产生文件。

### 4.7 不得声称的结论
- 不得直接断言 "`WRITE_RESTRICTED` 会导致管道重定向失败"（未做隔离测试）。
- 不得仅凭 `whoami.exe` 失败，就推断 Git、Node.js、Python 等所有外部程序必然无法运行（未测试这些程序）。
- 不得声称 "Restricted Token 无法实现任何文件写入隔离"（授权目录写入也未成功，可能是 ACL 配置问题而非令牌限制）。
- 不得把单次原型失败表述为对所有 Restricted Token 实现的普遍性证明。

## 5. 安全结论

### 5.1 当前状态

| 项 | 状态 |
|---|---|
| Phase 1 应用层审批 | 已实现 |
| Phase 2 OS 级文件写入隔离 | 未实现 |
| Phase 2 OS 级网络隔离 | 未测试（两种原型都未到达网络测试阶段） |
| 子进程权限降级 | 部分实现（Restricted Token 能降级，但外部程序无法启动） |

### 5.2 必须明确告知用户的风险

1. **Phase 1 应用层审批不等于 OS 级隔离。**
2. 经审批执行的命令**仍继承当前用户的系统权限**。
3. 授权目录外的访问限制**尚未得到完整、可复现的 OS 级保障**。
4. MCP 子进程、插件进程**未接入任何审批**（Phase 1 未覆盖）。
5. 拒绝熔断是**精确字符串匹配**，换壳可绕过。

### 5.3 未来若重启 OS 沙箱探索

不应默认采用"创建本地用户并修改系统 ACL"的方案。应重新评估：

1. **Windows Sandbox**（Hyper-V 容器，隔离性最强，但需要 Hyper-V 和 Windows 10 Pro+）。
2. **成熟的沙箱运行环境**（如 Container、Windows Defender Application Guard）。
3. **基于 EDR 的进程限制**（如 AppLocker、WDAC，但需要企业策略）。
4. **重新设计 AppContainer 原型**，在初始化阶段添加 `S-1-15-2-2`（ALL APPLICATION PACKAGES）ACL 到系统目录，明确记录这种方案的部署代价。

### 5.4 部署风险提醒

- `CreateProcessWithTokenW` 需要 `SeImpersonatePrivilege`（普通用户有）。
- `CreateProcessAsUserW` 需要 `SeAssignPrimaryTokenPrivilege` 和 `SeIncreaseQuotaPrivilege`（普通用户没有，需 UAC 提权）。
- 修改系统目录 ACL 需要管理员权限，且无法完全恢复。
- 杀毒软件可能拦截 `taskkill /T`、ACL 修改、`CreateProcessWithTokenW` 等操作。

## 6. 后续 Phase 1 方向（候选，不在本次执行）

1. 将 MCP 子进程启动纳入统一审批和审计体系。
2. 审查插件及子代理中的进程启动入口。
3. 清理已确认无引用的旧执行路径和僵尸代码（如 `src/overlay/panels/mcp-manager.ts`）。
4. 补充针对会话切换、拒绝熔断、取消和超时的回归测试。

**MCP、插件或子代理的接入不得直接绕过现有审批网关**；同时必须明确记录当前仍缺少 OS 级隔离的风险。

## 7. 证据位置汇总

| 证据 | 位置 |
|---|---|
| AppContainer 源码 | `D:\Software\cuckoo-code\appcontainer-proto\Launcher.cpp` |
| AppContainer 测试脚本 | `D:\Software\cuckoo-code\appcontainer-proto\run-tests.ps1` |
| Restricted Token 源码 | `D:\Software\cuckoo-code\restricted-proto\Launcher.cpp` |
| Restricted Token 最后一次测试日志 | `D:\Software\cuckoo-code\restricted-proto\debug.log` |
| 测试目录 | `C:\temp\cuckoo-rt-test\authorized`、`C:\temp\cuckoo-rt-test\unauthorized` |

**注意**：两个原型目录**未纳入 Git 管理**（位于项目根目录之外，且未执行 `git add`）。归档时未清理，待后续确认后单独处理。
