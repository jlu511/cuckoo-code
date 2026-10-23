/**
 * CC Safety Net Utility Process 通信协议（tools 层，纯类型）。
 */

/** 主进程 → 检查进程 */
export interface CcsnRequestMessage {
  id: string;
  command: string;
  cwd: string;
}

/** 检查进程 → 主进程 */
export type CcsnResponseMessage =
  | { type: 'ready' }
  | { type: 'init-error'; reason: string }
  | { id: string; kind: 'allow' }
  | { id: string; kind: 'deny'; reason: string; ruleId: string }
  | { id: string; kind: 'error'; reason: string };
