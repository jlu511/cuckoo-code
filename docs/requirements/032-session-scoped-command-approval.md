---
id: 032
type: feature
title: 会话级命令授权（allow_session）
status: done
branch: feat/032-session-scoped-command-approval
created: 2026-10-23
updated: 2026-10-23
---

## 背景

需求 031 让只读 Git 查询进入 L0 静默执行，但**所有需要审批的命令仍在每次调用时重复弹窗**。
典型场景：一次提交流程中 `npm run compile`、`npm test`、`npx tsc --noEmit` 会被反复审批，
用户被迫在几分钟内点十几次「允许执行」。

`executor.ts:56` 早已定义：

```typescript
export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny';
```

但 `default-handler.ts:123` 的弹窗只有两个按钮，**`allow_session` 从未被任何处理器返回过**——
它是死类型。而 `src/mcp/launch-gate.ts` 已完整实现同一语义（`grants` Map + `pending` 去重 +
`forgetWindow` 清理），可作为设计模板。

## 目标

- 普通 L2 命令支持「本会话内允许」：同一会话内、同一请求不再重复弹窗
- **不削弱任何硬性安全边界**：L3 敏感路径、CC Safety Net deny、只读模式拒绝、
  安全检查异常，一律不可被会话授权绕过
- L3 与高风险命令（`git push` / `git commit` / 递归删除等）**不提供会话授权选项**
- 会话切换后旧授权必须失效，包括 A → B → A 这种「切走又切回」的场景
- 保留现有并发去重语义：相同请求并发到达时，第二个继续被拒绝

## 审计发现（现状证据）

### 1. `getSignature(req)` 不能直接作为会话授权键

当前实现（`executor.ts:404-409`）：

```typescript
private getSignature(req: ExecRequest): string {
  if (req.type === 'shell') {
    return 'shell:' + req.shellType + ':' + req.rawCommand + ':' + req.cwd;
  }
  return 'proc:' + req.executable + ':' + req.args.join(' ') + ':' + req.cwd;
}
```

| 维度 | 现状 | 影响 |
|---|---|---|
| `taskId` | 不在签名内 | 无影响（不参与） |
| `env` | **不在签名内** | **风险**：带 `PATH` 覆盖的请求与普通请求同签名 |
| `timeoutMs` | 不在签名内 | 语义不同应区分 |
| `args.join(' ')` | 空格拼接 | **歧义**：`['a b']` 与 `['a','b']` 同签名 |
| `description` | 不在签名内 | 无影响（纯展示） |

`bash.ts:158` / `pwsh.ts:147` 调用时传 `executor.execute(req, activeSessionId, activeSessionId, ...)`，
即 **`taskId === sessionId`**。

### 2. `sessionId` 生命周期

`src/session/store.ts` 的 `currentSessionId` 变更点：

| 行 | 时机 | 变化 |
|---|---|---|
| 230 | 初始化 | `null` |
| 264 | `handleUrlChange` 提取到新会话 ID | 赋新值 |
| 308 | `handleUrlChange` 提取不到（回首页等） | 置 `null` |

审批**期间**会话切换已被拦截（`executor.ts:295-306` 二次校验 + `expired`）。
但**缓存层没有失效机制**。

### 3. A → B → A 漏洞（本需求必须修复）

若仅按 `sessionId` 缓存授权：

1. 会话 A 中执行命令，用户点「本会话内允许」→ 缓存 `A::cmd`
2. 切到 B（无工具调用）
3. 切回 A → `activeBefore` 重新等于 `A`
4. 再次执行同一命令 → **命中旧缓存，不弹窗**

用户已离开过 A、上下文可能被重置，但旧授权仍有效。

### 4. `ApprovalDecision` 状态机

| 位置 | 使用情况 |
|---|---|
| `default-handler.ts:123` | 只返回 `allow_once` / `deny`，按钮 2 个 |
| `executor.ts:259` | L0 硬编码 `allow_once` |
| `executor.ts:308` | 只判断 `deny`，`allow_session` 与 `allow_once` 同路径 |
| `mcp/launch-gate.ts` | **完整实现**（grants + pending + forgetWindow） |

### 5. 执行顺序（已确认的安全性质）

```
1. sessionId 非空
2. activeBefore === sessionId
3. 拒绝熔断
4. 并发去重（runningSignatures）
5. 只读模式权限检查     ← 不可被 allow_session 绕过
6. runSafetyPrecheck（CCSN + 敏感路径）  ← deny 直接抛错
7. assessRisk → L0 / L3 / L2
8. L0: allow_once；否则 requestApproval
9. 快照 pending + TTL
10. activeAfter === sessionId
11. deny → 熔断
12. 执行
```

会话授权缓存**必须插在步骤 7 之后、步骤 8 之前**——所有硬性检查都已通过，
只是决定「这次要不要再问用户一遍」。

## 方案

### 1. 请求指纹规范化

新增 `src/tools/core/session-grant-policy.ts`，导出 `buildRequestFingerprint(req): string`。

| 字段 | 纳入 | 编码方式 |
|---|---|---|
| `type` | ✅ | 字符串 |
| `shellType` / `executable` | ✅ | 字符串 |
| `rawCommand` / `args` | ✅ | 字符串 / **`JSON.stringify`**（消除空格歧义） |
| `cwd` | ✅ | 字符串 |
| `env` | ✅ | **稳定序列化**（键排序后 JSON） |
| `timeoutMs` | ✅ | 数字（`undefined` 与显式值不同） |
| `taskId` | ❌ | 非执行语义 |
| `description` | ❌ | 纯展示 |

输出为 SHA-256 十六进制串。**不存储明文 env**，日志只记指纹前 8 位。

### 2. 会话 generation（修复 A → B → A）

`src/session/store.ts` 的 `state` 增加单调递增计数器 `sessionGeneration`。

`handleUrlChange` 中，**只要 `currentSessionId` 值发生任何变化**（A→B、A→null、null→A），
先 `sessionGeneration++` 再赋值。

| 步骤 | sessionId | generation | 缓存键 |
|---|---|---|---|
| 1. 在 A 授权 | A | 5 | `5::A::fp` |
| 2. A→B | B | 6 | — |
| 3. B→A | A | 7 | — |
| 4. 再执行 | A | 7 | `7::A::fp` ≠ `5::A::fp` → **重新弹窗** |

同一会话内 URL 变化（同会话切换消息）→ `sessionId` 不变 → generation 不变 → 授权仍有效。

### 3. 缓存位置与生命周期

`SandboxExecutor` 内部新增：

```typescript
/** key = generation::sessionId::fingerprint；只存已授权 */
private sessionGrants = new Map<string, true>();
```

| 事件 | 动作 |
|---|---|
| 命中前 | 用当前 generation 拼 key，旧 generation 自然不匹配 → 惰性失效 |
| 窗口关闭 / 会话结束 / 进程退出 | 靠 generation 兜底；进程退出随内存消失 |
| 显式清理 | 提供 `clearSessionGrants()`，供测试使用 |

**不缓存「拒绝」**：拒绝由既有 `denials` Map + `denialWindowMs` 处理，语义不同。

### 4. 接入 generation 提供者

`executor.execute()` 增加**可选**第 5 参数：

```typescript
async execute(
  req: ExecRequest,
  taskId: string,
  sessionId: string,
  getCurrentSessionId: SessionIdProvider,
  getSessionGeneration?: () => number,   // 新增，可选
): Promise<ProcessResult>
```

**兼容性**：参数缺失或返回值非法（非数字 / 非有限 / 负数）→ 会话授权功能禁用，
仍走原有单次审批。保证现有测试（不传第 5 参数）行为完全不变，且 fail-closed。

调用点：`src/app/ipc/tool.ts` 构造 `sessionGenerationProvider` 并注入 params，
`bash.ts` / `pwsh.ts` 透传给 executor。

### 5. 执行流变更

```
[已有] 1~6：sessionId → activeBefore → 熔断 → 并发锁 → 只读权限 → CCSN 预检
[已有] 7：assessRisk → L0 / L2 / L3

[新增] 8a：计算 fingerprint + grantKey = gen::sessionId::fp
[新增] 8b：若 risk.level === L2 且 isSessionGrantBlocked 为 false：
            命中 sessionGrants → decision = allow_session（跳过弹窗）
            未命中 → dto.canAllowSession = true → requestApproval
                     若返回 allow_session → sessionGrants.set(grantKey, true)
[新增] 8c：防御性复核：decision === allow_session 但本次 canAllowSession 不为 true
            → throw（fail-closed，不执行，不缓存）

[已有] 9~12：快照校验 → activeAfter → deny 处理 → 执行
```

### 6. 按钮显示条件

`ApprovalDTO` 增加可选字段：

```typescript
/** 是否允许显示「本会话内允许」按钮（由执行器计算） */
canAllowSession?: boolean;
```

`default-handler.ts`：

```typescript
const buttons = dto.canAllowSession
  ? ['允许执行', '本会话内允许', '拒绝 (默认)']
  : ['允许执行', '拒绝 (默认)'];
```

`response` 映射：`0 → allow_once`；`1 && canAllowSession → allow_session`；其余 `deny`。

L3 的弹窗不受影响：`isSessionGrantBlocked` 对 L3 返回 true，`canAllowSession` 恒为 false，
按钮仍是 2 个（🔐 敏感路径红框保持原样）。

### 7. 会话授权资格判定

`session-grant-policy.ts` 导出 `isSessionGrantBlocked(req, riskLevel): boolean`：

| 条件 | 返回 |
|---|---|
| `riskLevel === L3` | `true`（禁止） |
| `isHighRiskCommand` 命中（`rm -rf` / `del /f` / `format` / `Remove-Item` 等） | `true` |
| 状态变更 git 子命令（`push` / `commit` / `add` / `reset` / `clean` / `checkout --`） | `true` |
| 其他普通 L2 | `false`（允许会话授权） |

**为什么不能只用 `isHighRiskCommand`**：它是关键词正则（`default-handler.ts:45-55`），
**不覆盖 `git push` / `git commit`**。需要补充结构化判定 `isDestructiveGitSubcommand(rawCommand)`。

## 验收标准

### 核心行为

- [ ] 同会话、相同请求顺序调用两次 → 第二次不弹窗
- [ ] 相同命令、不同 `cwd` → 重新审批
- [ ] 相同命令、不同 `env` → 重新审批
- [ ] `args: ['a b']` 与 `args: ['a', 'b']` → 指纹不同，各自审批
- [ ] 会话 A → B → A → 旧授权不可恢复
- [ ] 同签名并发请求 → 保持现有去重（第二个被拒绝），不重复执行

### 安全边界（不可被绕过）

- [ ] L3 敏感路径：弹窗**无**「本会话内允许」按钮
- [ ] `git push` / `git commit` / 递归删除：弹窗**无**「本会话内允许」按钮
- [ ] CCSN deny / 只读模式拒绝 / 安全检查异常：不进审批，无缓存
- [ ] 用户拒绝 / 审批超时：不缓存授权
- [ ] 非合格 handler 意外返回 `allow_session` → fail-closed，不执行不缓存
- [ ] 会话授权不绕过 `runningSignatures` 并发锁

### 兼容与泄露

- [ ] 不传第 5 参数时行为与现在完全一致（现有 1215 项测试全绿）
- [ ] `getSessionGeneration` 返回非法值 → 会话授权禁用，fail-closed
- [ ] 审计日志不含明文 env（只含指纹前 8 位 + 命令摘要）

### 验证命令

- [ ] `npm test` 全绿
- [ ] `npm run typecheck` 0 错误
- [ ] `npm run compile` 成功
- [ ] `npm run lint` 0 errors
- [ ] `git diff --check` clean

## 涉及文件清单

### 新增

| 文件 | 职责 |
|---|---|
| `src/tools/core/session-grant-policy.ts` | 指纹计算 + 资格判定（纯函数，无副作用） |
| `test/tools/session-grant-policy.test.js` | 指纹与资格判定的单元测试 |
| `test/tools/session-grant.test.js` | executor 层的端到端会话授权测试 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/tools/core/executor.ts` | 新增 `sessionGrants` Map、第 5 参数、执行流 8a/8b/8c、`clearSessionGrants()` |
| `src/tools/core/default-handler.ts` | 按 `dto.canAllowSession` 显示三按钮；response 映射 |
| `src/session/store.ts` | `state.sessionGeneration` + `handleUrlChange` 递增逻辑 |
| `src/app/ipc/tool.ts` | 构造并注入 `sessionGenerationProvider` |
| `src/tools/impl/bash.ts` | 透传 `sessionGenerationProvider` 给 executor |
| `src/tools/impl/pwsh.ts` | 同上 |
| `src/tools/runtime/JsRunner.ts` | 透传（若 settings 含该 provider） |

## 实现期间修复的缺陷（审查发现）

### 缺陷 1：每个 store 独立的 generation 导致旧授权复活

初版把 `sessionGeneration` 存在 `state` 里（每个 store 一份），
而 `sessionGrants` 是 `SandboxExecutor` 的进程级单例。二者粒度不匹配：

| 步骤 | storeA.generation | 缓存键 |
|---|---|---|
| 在窗口 A 授权 | 1 | 写入 `1::X::fp` |
| 关闭窗口 A | → 2（storeA 随后销毁） | — |
| 新窗口 B 打开同一会话 X | **新 store 从 0 → 1** | — |
| 在 B 中执行同一命令 | 1 | **命中 `1::X::fp` → 旧授权复活** |

`invalidateSessionGeneration()` 在窗口关闭时调用完全无效——那个 store 随之销毁。

**修复**：改为**模块级全局计数器**，所有 store 的 `state.sessionGeneration`
用 **getter** 读取同一个全局值：

```typescript
let globalSessionGeneration = 0;
function getGlobalSessionGeneration(): number { return globalSessionGeneration; }
function invalidateGlobalSessionGeneration(): number { return ++globalSessionGeneration; }

const state = {
  get sessionGeneration() { return getGlobalSessionGeneration(); },
  ...
};
```

### 缺陷 2：跨 profile 授权复用

`sessionId` **不保证跨 profile 唯一**——各 provider 各自提取：

| Provider | 提取规则 | 唯一性范围 |
|---|---|---|
| DeepSeek | `/chat/s/([a-f0-9-]+)` | 仅 DeepSeek 内 |
| ChatGPT | UUID | 仅 ChatGPT 内 |

两个不同 profile 理论上可提取到相同 sessionId，而 `sessionGrants` 是进程级共享 Map。

**修复**：缓存键加入可信 `profileId`，由 `tool.ts` 从 `ctx.profileId` 提供，
经 `bash`/`pwsh`/`JsRunner` 透传；`JsRunner` 从可信 `settings` 取值（脚本参数无法覆盖）。

### 缺陷 3：缓存键缺窗口标识，跨窗口共享授权

初版缓存键 `scope::generation::sessionId::fingerprint` 中，`generation` 是进程级共享值。
两个窗口若「同 profile + 同 sessionId + 同 generation + 同命令指纹」，键相同，
**会共享授权**——但不同窗口是独立执行上下文，不应共享。

**修复**：键加入窗口实例标识 `windowId`：

```
profileId::windowId::generation::sessionId::fingerprint
```

- `windowId` 来自 `ctx.win.id`（Electron 分配，窗口重建后必然不同）
- 由 `tool.ts` 放在 `...params` **之后**，脚本参数无法覆盖

### 缺陷 4：`scopeId` / `windowId` 缺失时未 fail-closed

初版 `buildGrantKey` 在 `scopeId` 缺失时用空串占位，漏传 profile 的调用链仍能创建/命中授权键。

**修复**：三者有效性一并并入 `grantEligible`：

```typescript
const scopeValid = typeof scopeId === "string" && scopeId.trim() !== "";
const windowValid =
  typeof windowId === "number" && Number.isSafeInteger(windowId) && windowId > 0;
const grantEligible =
  risk.level === "L2" &&
  !isSessionGrantBlocked(req, risk.level) &&
  genBefore !== null &&
  scopeValid &&
  windowValid;
```

任一缺失 / 非法 → `canAllowSession = false`（只有两个按钮）；
即使 handler 伪造返回 `allow_session`，6c 复核也会拒绝（不执行、不缓存）。

## 设计取舍

### 全局 generation 的保守性

任一窗口的会话切换或关闭，会使**所有窗口**的会话授权失效。

例如：窗口 A 与 B 同时开着，A 切换会话 → B 的已有授权也失效，需重新审批。

**为什么接受**：对比「每个 store 独立计数」的缺陷（旧授权跨窗口复活），
正确性优先于便利性。若将来需要更细粒度，可改为「每个 profile 一个全局计数器」，
但那需要先证明 profile 级隔离足够。

### 隔离边界

缓存键有三层作用域，各司其职：

| 层 | 来源 | 隔离的维度 |
|---|---|---|
| `profileId` | `ctx.profileId` | 不同账号 / 不同 provider |
| `windowId` | `ctx.win.id` | 不同窗口实例（重建后是新 id） |
| `generation` | 进程级全局计数器 | 任一窗口的会话切换 / 关闭 |

`scope` 是 `profileId` 而非 `providerId`：同一 provider 的两个账号是两个 profile，已隔离；
不同 provider 各自是不同 profile，也已隔离。

## 真机验证结果（2026-10-24）

安装包：`dist/cuckoo-code-win-v0.8.17.exe`（asar 357.5 MB，`FORBIDDEN=none`）

| # | 场景 | 预期 | 实际 |
|---|---|---|---|
| 1 | 普通 L2 首次执行 | 三个按钮 | ✅ 允许执行 / 本会话内允许 / 拒绝 |
| 2 | 点「允许执行」后再次执行 | 仍弹窗 | ✅ |
| 3 | 点「本会话内允许」后再次执行 | 不弹窗 | ✅ |
| 4 | 打开新窗口后执行 | 授权失效（全局 generation 递增） | ✅ 重新弹窗 |
| 5 | 两窗口就绪后授权 → 同窗口再执行 | 不弹窗 | ✅ |
| 6 | **关闭另一窗口 → 原窗口再执行** | 重新弹窗 | ✅ **核心验证通过** |

**第 6 项的判据**：窗口 B 的 `profileId` / `windowId(11601030)` / `sessionId` / 命令指纹全部未变，
唯一变化是窗口 A 关闭导致全局 generation 递增。授权失效即证明
`win.on('closed')` → `invalidateSessionGeneration()` → 全局 generation 递增这条链真实生效。

## 遗留

- **不解决 PATH 劫持**：判定仍按名字匹配可执行文件（与 031 相同限制）
- **L0 不是 OS 沙箱**：会话授权只减少重复弹窗，不改变「一旦执行即拥有完整系统权限」的事实
- **底层脚本内容变化**：会话授权意味着用户允许同一请求在本会话内重复执行；若脚本或文件
  内容在会话期间改变，命令行为也可能变化。这是 allow_session 的固有语义。
- **跨窗口不共享**：授权绑定 profileId + windowId + generation + sessionId，不同窗口互不共享
- **跨窗口连带失效**：任一窗口切换会话或关闭，所有窗口的会话授权失效（见「设计取舍」）