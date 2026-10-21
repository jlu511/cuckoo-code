/**
 * MCP Client 管理（连接池 + 引用计数，支持项目级/用户级隔离）
 *
 * 连接 key：
 *  - 用户级 server：`user::<name>`（全局唯一，跨项目共享）
 *  - 项目级 server：`project:<projectDir>::<name>`（每项目一份）
 *
 * 引用计数：每个连接记"哪些窗口在用"（Set<windowId>）。
 *  - 窗口关闭 / 切换项目 → 释放引用
 *  - 引用归零 → 启动空闲计时器（60 秒）；期间有人用则取消；超时无人用才断开
 *
 * 进程释放：
 *  - 正常退出 → disconnectAll()（由 entry.ts 的 before-quit 调用）
 *  - 强杀主进程 → 无法执行清理，依赖 stdin EOF（规范 server 自己退出）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as mcpConfig from './config.js';
import { resolveRuntimeBinDir } from '../infra/paths.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import crypto from 'node:crypto';
import type { McpLaunchGate, McpLaunchSnapshot } from './launch-gate.js';
import { buildFingerprint } from './launch-gate.js';

const require = createRequire(import.meta.url);
const { app } = require('electron');

// 空闲断开时长（毫秒）
const IDLE_DISCONNECT_MS = 60 * 1000;

// ========== MCP 启动审批网关 ==========
// 由 app 层注入；未注入时 stdio 启动一律拒绝（fail closed）
let launchGate: McpLaunchGate | null = null;

function injectMcpLaunchGate(gate: McpLaunchGate): void {
  launchGate = gate;
}

function getMcpLaunchGate(): McpLaunchGate | null {
  return launchGate;
}

/**
 * 连接池条目：
 * {
 *   key, client, transport, tools, connected,
 *   refs: Set<windowId>,   // 谁在用
 *   idleTimer: NodeJS.Timeout | null
 * }
 */
const connections = new Map<string, any>();
// 连接进行中的缓存：key -> Promise<entry>（避免并发重复连接）
const connecting = new Map<string, Promise<any>>();

// ========== 默认工作目录（同以前）==========
let defaultCwdCache: string | undefined;
let defaultCwdResolved = false;

function getDefaultMcpCwd(): string | undefined {
  if (defaultCwdResolved) return defaultCwdCache;
  defaultCwdResolved = true;

  const candidates: string[] = [];
  if (app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'mcp-cwd'));
  }
  if (app.isPackaged) {
    try {
      const exeDir = path.dirname(app.getPath('exe'));
      candidates.push(path.join(exeDir, 'mcp-cwd'));
    } catch (_) {}
  }
  try {
    candidates.push(path.join(app.getPath('userData'), 'mcp-cwd'));
  } catch (_) {}

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-test');
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      defaultCwdCache = dir;
      console.log('[MCP] 默认工作目录:', dir);
      return dir;
    } catch (_) {
      console.warn('[MCP] 工作目录不可写，尝试下一个:', dir);
    }
  }
  console.warn('[MCP] 未找到可写的默认工作目录，子进程将继承父进程 cwd');
  return undefined;
}

// ========== key 计算 ==========

function connKey(server: any): string {
  return server.source === 'project'
    ? 'project:' + (server.projectDir || '') + '::' + server.name
    : 'user::' + server.name;
}

// ========== 连接管理 ==========

/**
 * 复用已有连接前，校验该窗口的独立授权。
 * stdio 类型且已有 fingerprint 时：
 *   - 配置变化 → 返回 'config-changed'，调用方应断开重连
 *   - 配置一致 → 检查窗口授权；无授权则触发审批
 *   - 用户拒绝 → 抛错
 */
async function ensureWindowAuthorized(
  server: any,
  windowId: number,
  existing: any
): Promise<'reuse' | 'config-changed'> {
  if (existing.fingerprint === null || server.type !== 'stdio') {
    return 'reuse';
  }

  const currentSnapshot = buildLaunchSnapshot(server, windowId);

  // 配置变化 → 不可复用（旧进程用的是旧配置）
  if (existing.fingerprint !== currentSnapshot.fingerprint) {
    return 'config-changed';
  }

  const gate = getMcpLaunchGate();
  if (!gate) throw new Error('拒绝复用 MCP 连接：审批网关未注入');
  if (typeof gate.peek !== 'function') {
    throw new Error('拒绝复用 MCP 连接：审批网关缺少 peek 能力');
  }

  // 该窗口是否已有独立授权
  if (gate.peek(currentSnapshot) === 'allow_session') {
    return 'reuse';
  }

  // 无授权 → 触发该窗口自己的审批
  const decision = await gate.check(currentSnapshot);
  if (decision === 'deny') {
    throw new Error('用户拒绝复用 MCP 连接: ' + server.name);
  }
  return 'reuse';
}

async function connectServer(server: any, windowId: number | null): Promise<any> {
  const key = connKey(server);

  // 已有连接 → 校验配置未变 + 本窗口有授权
  const existing = connections.get(key);
  if (existing) {
    if (windowId !== null && server.type === 'stdio') {
      const verdict = await ensureWindowAuthorized(server, windowId, existing);
      if (verdict === 'reuse') {
        existing.refs.add(windowId);
        cancelIdleTimer(existing);
        return existing;
      }
      // 'config-changed' → 断开旧连接后走新连接
      console.log('[MCP] 配置已变化，断开旧连接:', key);
      await disconnectByKey(key);
      // 不 return，继续走下面的连接流程
    } else {
      // HTTP 或无 windowId：保持原行为
      if (windowId !== null) {
        existing.refs.add(windowId);
        cancelIdleTimer(existing);
      }
      return existing;
    }
  }

  // 连接进行中 → 等完成后同样校验该窗口的独立授权
  if (connecting.has(key)) {
    const p = connecting.get(key);
    const entry = await p;
    if (entry && windowId !== null && server.type === 'stdio') {
      const verdict = await ensureWindowAuthorized(server, windowId, entry);
      if (verdict === 'config-changed') {
        // 理论上不应发生（同 promise 内配置一致），但若发生则安全降级为拒绝
        throw new Error('并发连接期间配置发生变化，请重试');
      }
    }
    if (windowId !== null && entry) {
      entry.refs.add(windowId);
      cancelIdleTimer(entry);
    }
    return entry;
  }

  // 新连接
  const p = doConnectServer(server, key, windowId);
  connecting.set(key, p);
  try {
    const entry = await p;
    if (windowId !== null) entry.refs.add(windowId);
    return entry;
  } finally {
    connecting.delete(key);
  }
}

// ========== 自带运行时解析 ==========
// 我们打包了 uv/node（resources/runtime/<platform>/bin/）。spawn MCP 时：
//  - command 是 uvx/uv/npx/node/npm → 解析成自带绝对路径（优先自带，尊重"版本可控"）
//  - 并把自带 bin 目录加进子进程 PATH（npx.cmd 内部还要找 node）

const RUNTIME_COMMANDS = new Set(['uvx', 'uv', 'uvw', 'npx', 'node', 'npm']);

/** 命令名 → 自带可执行文件（带平台后缀） */
function bundledBinName(cmd: string): string {
  const isWin = process.platform === 'win32';
  if (cmd === 'uvx') return isWin ? 'uvx.exe' : 'uvx';
  if (cmd === 'uv') return isWin ? 'uv.exe' : 'uv';
  if (cmd === 'uvw') return isWin ? 'uvw.exe' : 'uvw';
  if (cmd === 'node') return isWin ? 'node.exe' : 'node';
  if (cmd === 'npx') return isWin ? 'npx.cmd' : 'npx';
  if (cmd === 'npm') return isWin ? 'npm.cmd' : 'npm';
  return cmd;
}

/**
 * 解析 spawn 的 command：
 *  - 若命令是 uvx/npx 等且自带运行时存在 → 返回自带绝对路径
 *  - 否则原样返回（交给系统 PATH）
 */
function resolveCommand(command: string): { command: string; bundled: boolean } {
  if (!RUNTIME_COMMANDS.has(command)) return { command, bundled: false };
  const binDir = resolveRuntimeBinDir();
  if (!binDir) return { command, bundled: false };
  const full = path.join(binDir, bundledBinName(command));
  if (fs.existsSync(full)) return { command: full, bundled: true };
  return { command, bundled: false };
}

/** 构造 MCP 子进程的 env：自带 bin 目录加到 PATH 最前（仅此进程，不碰系统） */
function buildSpawnEnv(userEnv: any): any {
  const base = Object.assign({}, process.env, userEnv || {});
  const binDir = resolveRuntimeBinDir();
  if (binDir) {
    const sep = process.platform === 'win32' ? ';' : ':';
    base.PATH = binDir + sep + (base.PATH || base.Path || '');
    // Windows 上大小写敏感：确保 Path 也在
    if (process.platform === 'win32') base.Path = base.PATH;
  }
  return base;
}

/** 连接初始化超时（毫秒） */
const CONNECT_INIT_TIMEOUT_MS = 30 * 1000;

/**
 * 构造启动快照（含指纹）。
 * 供 doConnectServer（首次连接）与 connectServer（复用前校验）共享，
 * 保证"审批看到的配置"与"连接池比对的配置"完全一致。
 */
function buildLaunchSnapshot(server: any, windowId: number): McpLaunchSnapshot {
  const resolved = resolveCommand(server.command);
  const finalEnv = buildSpawnEnv(server.env);
  const finalCwd = server.cwd || getDefaultMcpCwd() || '';
  const base = {
    windowId,
    source: server.source || 'user',
    name: server.name,
    command: resolved.command,
    args: server.args || [],
    cwd: finalCwd,
    env: finalEnv,
  };
  return {
    id: crypto.randomUUID(),
    ...base,
    userEnv: server.env || {},
    fingerprint: buildFingerprint(base),
    createdAt: Date.now(),
  };
}

async function doConnectServer(server: any, key: string, windowId: number | null): Promise<any> {
  let transport: any = null;
  let client: any = null;
  let timeoutTimer: any = null;
  let transportClosed = false;

  const closeTransport = async (): Promise<void> => {
    if (transportClosed || !transport) return;
    transportClosed = true;
    try { await transport.close(); } catch (_) { /* ignore */ }
  };

  try {
    if (server.type === 'stdio') {
      // === 启动审批（必须在创建 transport 之前）===
      const resolved = resolveCommand(server.command);
      if (resolved.bundled) {
        console.log('[MCP] 使用自带运行时: ' + server.command + ' → ' + resolved.command);
      } else if (RUNTIME_COMMANDS.has(server.command)) {
        console.warn('[MCP] 未找到自带运行时，回退系统 PATH: ' + server.command);
      }

      if (windowId === null || typeof windowId !== 'number') {
        throw new Error('拒绝启动 MCP：缺少可信的窗口 ID');
      }

      const gate = getMcpLaunchGate();
      if (!gate) {
        throw new Error('拒绝启动 MCP：审批网关未注入');
      }

      const snapshot = buildLaunchSnapshot(server, windowId);
      const decision = await gate.check(snapshot);
      if (decision === 'deny') {
        throw new Error('用户拒绝启动 MCP: ' + server.name);
      }

      transport = new StdioClientTransport({
        command: snapshot.command,
        args: snapshot.args,
        env: snapshot.env,
        cwd: snapshot.cwd,
        stderr: 'pipe',
      });
    } else if (server.type === 'http') {
      transport = new StreamableHTTPClientTransport(server.url, {
        requestInit: server.headers ? { headers: server.headers } : undefined,
      });
    } else {
      throw new Error('未知 MCP server 类型: ' + server.type);
    }

    client = new Client({ name: 'cuckoo-code', version: '0.2.4' });

    // === 连接初始化超时（仅覆盖 connect + listTools）===
    let connectPromise = (async () => {
      await client.connect(transport);
      let tools: any[] = [];
      try {
        const result = await client.listTools({});
        tools = result.tools || [];
      } catch (err: any) {
        console.error('[MCP] 获取工具列表失败:', server.name, err.message);
      }
      return tools;
    })();

    // 迟到结果不再影响主流程
    connectPromise.catch(() => { /* 已通过下面的 race 处理，避免 unhandledRejection */ });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error('MCP 连接超时（' + CONNECT_INIT_TIMEOUT_MS + 'ms）: ' + server.name));
      }, CONNECT_INIT_TIMEOUT_MS);
      if (timeoutTimer.unref) timeoutTimer.unref();
    });

    let tools: any[];
    try {
      tools = await Promise.race([connectPromise, timeoutPromise]);
    } catch (raceErr: any) {
      await closeTransport();
      throw raceErr;
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    }

    const entry = {
      key, client, transport, tools, connected: true,
      refs: new Set<number>(), idleTimer: null,
      // 记录启动时使用的配置指纹；用于"配置变更后强制重连"
      fingerprint: server.type === 'stdio' && windowId !== null
        ? buildLaunchSnapshot(server, windowId).fingerprint
        : null,
    };
    connections.set(key, entry);
    console.log('[MCP] 已连接:', key, '工具数=', tools.length);
    return entry;
  } catch (err: any) {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    await closeTransport();
    throw err;
  }
}

function cancelIdleTimer(entry: any): void {
  if (entry && entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function scheduleIdleDisconnect(entry: any): void {
  cancelIdleTimer(entry);
  entry.idleTimer = setTimeout(() => {
    if (entry.refs.size === 0) {
      disconnectByKey(entry.key).catch(() => {});
    }
  }, IDLE_DISCONNECT_MS);
  // 定时器不阻止进程退出
  if (entry.idleTimer && typeof entry.idleTimer.unref === 'function') entry.idleTimer.unref();
}

async function disconnectByKey(key: string): Promise<void> {
  // 等正在进行的连接结束，避免断开后又被它重新登记
  if (connecting.has(key)) {
    try { await connecting.get(key); } catch (_) {}
  }
  const entry = connections.get(key);
  if (!entry) return;
  cancelIdleTimer(entry);
  try {
    await entry.client.close();
  } catch (_) {}
  connections.delete(key);
  console.log('[MCP] 已断开:', key);
}

/**
 * 释放某个窗口的全部引用（窗口关闭 / 退出时调用）。
 * 引用归零的连接 → 启动空闲计时。
 */
function releaseWindow(windowId: number): void {
  for (const entry of connections.values()) {
    if (entry.refs.has(windowId)) {
      entry.refs.delete(windowId);
      if (entry.refs.size === 0) scheduleIdleDisconnect(entry);
    }
  }
}

/**
 * 窗口切换项目目录：释放该窗口对"旧项目"连接的引用。
 * 旧项目 = 与 newProjectDir 不同的所有 project:* 连接。
 */
function releaseProject(windowId: number, newProjectDir: string | null): void {
  for (const entry of connections.values()) {
    if (!entry.key.startsWith('project:')) continue;
    // key 形如 project:<dir>::<name>，取出 dir
    const rest = entry.key.slice('project:'.length);
    const sep = rest.indexOf('::');
    const dir = sep >= 0 ? rest.slice(0, sep) : rest;
    if (dir !== (newProjectDir || '') && entry.refs.has(windowId)) {
      entry.refs.delete(windowId);
      if (entry.refs.size === 0) scheduleIdleDisconnect(entry);
    }
  }
}

/** 退出时强制断开全部 */
async function disconnectAll(): Promise<void> {
  const keys = Array.from(connections.keys());
  for (const key of keys) {
    await disconnectByKey(key);
  }
}

// ========== 对外 API（都带 projectDir）==========

/** 从配置里找 server 定义（项目级优先），带 source/projectDir */
function resolveServer(name: string, projectDir: string | null): any | null {
  const list = mcpConfig.getServers(projectDir);
  return list.find((s: any) => s.name === name) || null;
}

/** 连接指定 server，并登记窗口引用 */
async function connectServerByName(name: string, projectDir: string | null, windowId: number | null = null): Promise<any> {
  const server = resolveServer(name, projectDir);
  if (!server) throw new Error('MCP server 不存在或未启用: ' + name);
  if (!server.enabled) throw new Error('MCP server 已禁用: ' + name);
  server.projectDir = projectDir; // 供 connKey 用
  return connectServer(server, windowId);
}

/** 连接所有已启用 server（按需；连接后不登记引用——由调用方按需 acquire） */
/**
 * @deprecated MCP 启动审批要求可信 windowId；本函数不接受 windowId，
 * 内部 connectServer(server, null) 会在审批阶段 fail closed。
 * 保留导出仅为向后兼容，不要在新代码中调用。请改用按需连接（mcpCall 自动触发）。
 */
async function connectEnabledServers(projectDir: string | null = null): Promise<string[]> {
  const servers = mcpConfig.getEnabledServers(projectDir);
  for (const server of servers) {
    server.projectDir = projectDir;
    try {
      await connectServer(server, null);
    } catch (err: any) {
      console.error('[MCP] 连接失败:', server.name, err.message);
    }
  }
  return Array.from(connections.keys());
}

/** 每个窗口"上次自动连的项目目录"，避免同一项目重复触发 */
const lastProjectByWindow = new Map<number, string | null>();

/**
 * 窗口的项目目录确定后，异步自动连接该项目下所有已启用 server，并登记窗口引用。
 * 同一窗口同一项目只触发一次。连接失败不影响其它。
 */
function autoConnectForWindow(windowId: number, projectDir: string | null): void {
  const prev = lastProjectByWindow.get(windowId);
  if (prev === projectDir) return; // 同一项目，已处理
  lastProjectByWindow.set(windowId, projectDir);
  // 项目变了：先释放旧项目引用
  if (prev !== undefined) releaseProject(windowId, projectDir);
  // 异步连（不阻塞调用方）
  const servers = mcpConfig.getEnabledServers(projectDir);
  for (const server of servers) {
    server.projectDir = projectDir;
    connectServer(server, windowId).catch((err: any) => {
      console.error('[MCP] 自动连接失败:', server.name, err.message);
    });
  }
}

/** 窗口关闭时清理其"上次项目"记录 */
function forgetWindow(windowId: number): void {
  lastProjectByWindow.delete(windowId);
  releaseWindow(windowId);
}

/** 调用工具（自动确保连接） */
async function callMcpTool(serverName: string, toolName: string, args: any, projectDir: string | null = null, windowId: number | null = null): Promise<any> {
  const entry = await connectServerByName(serverName, projectDir, windowId);
  const result = await entry.client.callTool({ name: toolName, arguments: args });
  return result;
}

/** 列出已配置 server（含启用/连接状态） */
function listConfiguredServers(projectDir: string | null): any[] {
  const servers = mcpConfig.getServers(projectDir);
  return servers.map((s: any) => {
    // 与连接侧共用 connKey：此前这里内联了一份同样的判断，
    // 新增 plugin 来源后两处极易分叉（分叉 = "已连接"永远显示为假）
    s.projectDir = projectDir;
    const entry = connections.get(connKey(s));
    return {
      name: s.name,
      source: s.source,
      type: s.type,
      enabled: s.enabled,
      connected: !!(entry && entry.connected),
      toolCount: entry ? entry.tools.length : 0,
    };
  });
}

/** 某 server 的工具列表（按需连接） */
async function getToolsByServer(name: string, projectDir: string | null, windowId: number | null = null): Promise<any[]> {
  const entry = await connectServerByName(name, projectDir, windowId);
  return entry.tools.map((t: any) => ({
    name: t.name,
    description: t.description || '',
    inputSchema: t.inputSchema || {},
  }));
}

export {
  injectMcpLaunchGate,
  getMcpLaunchGate,
  connectServer,
  connectServerByName,
  connectEnabledServers,
  autoConnectForWindow,
  forgetWindow,
  disconnectAll,
  releaseWindow,
  releaseProject,
  callMcpTool,
  listConfiguredServers,
  getToolsByServer,
  getDefaultMcpCwd,
  IDLE_DISCONNECT_MS,
};
