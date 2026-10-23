/**
 * CC Safety Net 检查进程入口（Electron Utility Process）。
 *
 * 由主进程 utilityProcess.fork 启动；通过 parentPort 收发消息。
 * 环境变量由主进程在 fork 时显式注入（避免 CMD set 的尾随空格问题）。
 */
import { checkCommand } from 'cc-safety-net/api';

interface ParentPortLike {
  on(event: 'message', cb: (e: { data: unknown }) => void): void;
  postMessage(msg: unknown): void;
}

const parentPort = (process as any).parentPort as ParentPortLike | undefined;

function post(msg: unknown): void {
  if (parentPort) parentPort.postMessage(msg);
}

if (!parentPort) {
  // 非 utility process 环境下直接退出（不应发生）
  process.exit(2);
}

parentPort.on('message', (e) => {
  const msg: any = e?.data;
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') return;
  const { id, command, cwd } = msg;
  if (typeof command !== 'string' || typeof cwd !== 'string') {
    post({ id, kind: 'error', reason: '无效的检查请求' });
    return;
  }

  try {
    const r = checkCommand({ command, cwd });
    if (r.kind === 'allow') {
      post({ id, kind: 'allow' });
    } else if (r.kind === 'deny') {
      post({ id, kind: 'deny', reason: r.reason || '', ruleId: r.ruleId || '' });
    } else {
      post({ id, kind: 'error', reason: '未知的检查结果' });
    }
  } catch (err: any) {
    post({ id, kind: 'error', reason: (err && err.message) || String(err) });
  }
});

// 模块加载完成即代表检查器可用
post({ type: 'ready' });
