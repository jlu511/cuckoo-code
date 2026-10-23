/**
 * Electron Utility Process 承载的 CC Safety Net 检查进程工厂。
 *
 * 依赖方向：app 层，可用 electron。
 * 环境变量在 fork 时由主进程显式注入（Node 内赋值，无尾随空格）。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { utilityProcess } = require('electron');

import type { CcsnProcess, CcsnProcessFactory } from '../../tools/core/ccsn-client.js';

/** worker-entry 的绝对文件路径（编译后位于 out/src/app/ccsn/worker-entry.js） */
const WORKER_PATH = fileURLToPath(new URL('./worker-entry.js', import.meta.url));

/**
 * 创建检查进程工厂。
 * @param env 额外环境变量（默认注入 strict 三件套）
 */
export function createElectronCcsnProcessFactory(
  env?: Record<string, string>
): CcsnProcessFactory {
  const baseEnv: Record<string, string> = {
    CC_SAFETY_NET_LEVEL: 'strict',
    CC_SAFETY_NET_STRICT: '1',
    CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY: '1',
    ...(env || {}),
  };

  return (): CcsnProcess => {
    const child = utilityProcess.fork(WORKER_PATH, [], {
      env: { ...process.env, ...baseEnv },
      stdio: 'pipe',
    });
    const listeners: Array<(msg: unknown) => void> = [];
    const exitListeners: Array<(code: number) => void> = [];

    child.on('message', (msg: unknown) => {
      for (const cb of listeners) cb(msg);
    });
    child.on('exit', (code: number) => {
      for (const cb of exitListeners) cb(code);
    });

    return {
      postMessage(msg: unknown) { child.postMessage(msg); },
      onMessage(cb) { listeners.push(cb); },
      onExit(cb) { exitListeners.push(cb); },
      kill() { try { child.kill(); } catch (_) { /* ignore */ } },
    };
  };
}
