import { exec, execFile } from 'node:child_process';
import type { ProcessRunner, ExecRequest, ProcessResult } from './executor.js';
import { decodeOutput } from '../../infra/decode-output.js';

export class DefaultProcessRunner implements ProcessRunner {
  async run(request: ExecRequest, signal: AbortSignal): Promise<ProcessResult> {
    return new Promise((resolve) => {
      const timeout = request.timeoutMs || 30000;
      const maxBuffer = 1024 * 1024 * 10; // 10MB
      
      const callback = (error: any, stdout: any, stderr: any) => {
        const out = decodeOutput(stdout);
        const err = decodeOutput(stderr);
        let exitCode = 0;
        let isTimeout = false;
        
        if (error) {
          if (error.killed) {
            isTimeout = true;
            exitCode = -1;
          } else if (typeof error.code === 'number') {
            exitCode = error.code;
          } else {
            exitCode = 1;
          }
        }
        resolve({ stdout: out, stderr: err, exitCode, isTimeout });
      };

      const options = {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        timeout,
        maxBuffer,
        windowsHide: true,
        encoding: 'buffer' as const,
      };

      if (request.type === 'shell') {
        // Shell 请求：原样执行
        const child = exec(request.rawCommand, options, callback);
        signal.addEventListener('abort', () => child.kill());
      } else {
        // Process 请求：分离可执行文件和参数
        const child = execFile(request.executable, request.args, options, callback);
        signal.addEventListener('abort', () => child.kill());
      }
    });
  }
}
