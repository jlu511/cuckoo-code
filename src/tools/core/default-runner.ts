import { exec, execFile, spawn } from 'node:child_process';
import type { ProcessRunner, ExecRequest, ProcessResult } from './executor.js';
import { decodeOutput } from '../../infra/decode-output.js';

/**
 * 判断当前是否运行在 Windows 上。
 */
const IS_WIN = process.platform === 'win32';

/**
 * 尝试清理进程树。
 * Windows：使用 taskkill /T /F /PID（需 spawn 新进程但这里必须用 detached + unref，
 *         且只作为清理的最后手段；主路径 child.kill() 已经能杀掉直接子进程）。
 * POSIX：暂不支持进程组清理（Phase 1 仅 Windows 目标），直接 child.kill()。
 *
 * @param pid 目标进程 PID；若为 undefined 则跳过。
 * @param child 原始 child 进程对象，用于直接 kill。
 */
function killTree(pid: number | undefined, child: any): void {
  if (!pid) {
    try { child.kill(); } catch (_) { /* ignore */ }
    return;
  }
  if (IS_WIN) {
    try {
      // 使用 spawn 启动 taskkill 并 detach，避免阻塞当前事件循环；不 await 其结果。
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      killer.unref();
    } catch (_) {
      try { child.kill(); } catch (_) { /* ignore */ }
    }
  } else {
    try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
  }
}

export class DefaultProcessRunner implements ProcessRunner {
  async run(request: ExecRequest, signal: AbortSignal): Promise<ProcessResult> {
    return new Promise((resolve) => {
      const timeout = request.timeoutMs || 30000;
      const maxBuffer = 1024 * 1024 * 10; // 10MB

      // 状态标志：防止多次触发终态
      let settled = false;
      let abortedByUser = false;
      let timedOut = false;

      // 优先级：用户取消 > 超时 > 正常退出
      // 同一请求不能因多个事件重复写入终态
      const finalize = (partial: ProcessResult) => {
        if (settled) return;
        settled = true;
        resolve(partial);
      };

      const options = {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        timeout,
        maxBuffer,
        windowsHide: true,
        encoding: 'buffer' as const,
        // exec / execFile 在超时后会设置 error.killed=true；
        // 我们不用 error.killed 判断是否超时，而用我们自己的定时器标志。
      };

      const callback = (error: any, stdout: any, stderr: any) => {
        const out = decodeOutput(stdout);
        const err = decodeOutput(stderr);

        if (abortedByUser) {
          return finalize({ stdout: out, stderr: err, exitCode: -1, isCancelled: true });
        }
        if (timedOut) {
          return finalize({ stdout: out, stderr: err, exitCode: -1, isTimeout: true });
        }

        let exitCode = 0;
        if (error) {
          if (typeof error.code === 'number') {
            exitCode = error.code;
          } else {
            exitCode = 1;
          }
        }
        finalize({ stdout: out, stderr: err, exitCode });
      };

      let child: any;
      try {
        if (request.type === 'shell') {
          child = exec(request.rawCommand, options, callback);
        } else {
          child = execFile(request.executable, request.args, options, callback);
        }
      } catch (err: any) {
        // 启动失败（例如 cwd 不存在）
        return finalize({ stdout: '', stderr: '', exitCode: 1 });
      }

      // 超时兜底：exec 自身有 timeout，但我们额外设一个计时器作为标志位来源，
      // 以避免依赖 error.killed 的不精确判断。
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killTree(child.pid, child);
      }, timeout);

      // 取消
      const onAbort = () => {
        if (settled) return;
        abortedByUser = true;
        clearTimeout(timer);
        killTree(child.pid, child);
      };
      signal.addEventListener('abort', onAbort);

      // 进程结束时清理计时器与 abort 监听
      child.on('close', () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      });
      child.on('error', () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      });
    });
  }
}
