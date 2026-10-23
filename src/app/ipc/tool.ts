/**
 * IPC：执行工具与 JS 脚本
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { registry as toolRegistry, jsRunner } from '../../tools/index.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

// 上次推送的 todoWrite 列表（去重）
let lastTodosJson = '';

/** 重置计划（新任务/新对话时调用，避免旧 todo 残留） */
function resetTodosCache(): void {
  lastTodosJson = '';
  (globalThis as any).__cuckooTodos = [];
}

export { resetTodosCache };

function registerToolIpc(): void {
  // 执行工具
  ipcMain.handle('execute-tool', async (event: any, { toolName, params, callId }: any) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const selectedDir = store ? store.state.selectedProjectDir : null;
    const win = ctx ? ctx.win : null;
    const windowId = win && !win.isDestroyed() ? win.id : null;
    try {
      const sessionId = store ? store.state.currentSessionId : null;
      // 实时解析器：每次调用都从 ctx 重新读取，反映审批期间可能发生的会话切换
      const sessionResolver = () => {
        const s = ctx ? ctx.sessionStore : null;
        return s ? s.state.currentSessionId : null;
      };
      // 需求 032：会话代次提供者（可信来源是主进程的 sessionStore，不接受脚本伪造）
      const sessionGenerationProvider = () => {
        const s = ctx ? ctx.sessionStore : null;
        return s ? s.state.sessionGeneration : -1;
      };
      // 需求 032：profile 隔离标识（不同 profile 的 sessionId 可能撞车）
      const sessionScopeId = ctx ? ctx.profileId : null;
      const result = await toolRegistry.execute(toolName, {
        ...params,
        projectDir: selectedDir,
        currentWindowId: windowId,
        activeSessionId: sessionId,
        sessionResolver,
        sessionGenerationProvider,
        sessionScopeId,
      });
      return { callId, success: result.success, data: result.data, error: result.error };
    } catch (err: any) {
      return { callId, success: false, error: err.message };
    }
  });

  // 执行 JS 脚本
  ipcMain.handle('execute-js', async (event: any, { code, callId, attachDelayMin, attachDelayMax, ssrfGuard }: any) => {
    if (!code || typeof code !== 'string') {
      return { callId, success: false, error: '无效的 JS 代码' };
    }
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const selectedDir = store ? store.state.selectedProjectDir : null;
    const sessionId = store ? store.state.currentSessionId : null;
    const win = ctx ? ctx.win : null;
    const windowId = win && !win.isDestroyed() ? win.id : null;
    try {
      const sessionResolver = () => {
        const s = ctx ? ctx.sessionStore : null;
        return s ? s.state.currentSessionId : null;
      };
      // 需求 032：会话代次提供者（可信来源是主进程的 sessionStore）
      const sessionGenerationProvider = () => {
        const s = ctx ? ctx.sessionStore : null;
        return s ? s.state.sessionGeneration : -1;
      };
      // 需求 032：profile 隔离标识
      const sessionScopeId = ctx ? ctx.profileId : null;
      const result = await jsRunner.run(code, selectedDir, windowId, {
        attachDelayMin,
        attachDelayMax,
        sessionId,
        ssrfGuard,
        sessionResolver,
        sessionGenerationProvider,
        sessionScopeId,
      });
      // 复用官方 todoWrite 结果：执行后读取 globalThis.__cuckooTodos（官方规范化的列表），推给 harness
      try {
        const todos = (globalThis as any).__cuckooTodos;
        if (Array.isArray(todos) && todos.length) {
          const json = JSON.stringify(todos);
          if (json !== lastTodosJson) {
            lastTodosJson = json;
            const hv = ctx && (ctx as any).harnessView;
            if (hv && !hv.webContents.isDestroyed()) {
              hv.webContents.send('harness-event', { type: 'plan', todos: todos });
            }
          }
        }
      } catch (_) { /* ignore */ }
      return { callId, ...result };
    } catch (err: any) {
      return { callId, success: false, error: err.message };
    }
  });
}

export { registerToolIpc };
