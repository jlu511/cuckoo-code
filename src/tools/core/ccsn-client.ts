/**
 * CC Safety Net 检查客户端（tools 层）。
 *
 * 设计要点：
 *  - 不直接 import electron：通过注入的 CcsnProcessFactory 创建检查进程
 *  - 单进程复用；异常/超时/退出后销毁，下次请求重新拉起
 *  - 任何异常、超时、无效返回一律返回 error（由调用方 fail-closed）
 *  - 不阻塞事件循环：等待完全异步，主进程只设"有界等待时间"
 */
import crypto from 'node:crypto';
import type {
  CcsnRequestMessage,
  CcsnResponseMessage,
} from './ccsn-protocol.js';
import type { SafetyCheckInput, SafetyCheckResult, SafetyChecker } from './safety-precheck.js';

export interface CcsnProcess {
  postMessage(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  onExit(cb: (code: number) => void): void;
  kill(): void;
}

export type CcsnProcessFactory = () => CcsnProcess;

export interface CcsnClientOptions {
  /** 单次检查的有界等待时间（毫秒）。默认 10000。 */
  requestTimeoutMs?: number;
  /** 进程启动到 ready 的有界等待时间（毫秒）。默认 10000。 */
  startupTimeoutMs?: number;
}

interface Pending {
  resolve: (r: CcsnResponseMessage) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 消息路由判定（宽松）：只要求结构可路由。
 * 具体的 kind 合法性由 check() 负责校验，未知 kind 会被转成 error。
 */
type RoutableMessage =
  | { type: 'ready' }
  | { type: 'init-error'; reason?: string }
  | { id: string; kind: string; reason?: string; ruleId?: string };

function isRoutableMessage(v: unknown): v is RoutableMessage {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  if (m.type === 'ready' || m.type === 'init-error') return true;
  return typeof m.id === 'string' && typeof m.kind === 'string';
}

export class CcsnClient {
  private proc: CcsnProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private disposed = false;

  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;

  constructor(
    private readonly factory: CcsnProcessFactory,
    options?: CcsnClientOptions
  ) {
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 10000;
    this.startupTimeoutMs = options?.startupTimeoutMs ?? 10000;
  }

  /** 检查一条命令。永不抛异常，所有失败都转成 { kind: 'error' }。 */
  async check(input: SafetyCheckInput): Promise<SafetyCheckResult> {
    if (this.disposed) {
      return { kind: 'error', reason: 'CCSN 客户端已销毁' };
    }
    if (typeof input.command !== 'string' || input.command.trim() === '') {
      return { kind: 'error', reason: 'command 必须是非空字符串' };
    }
    if (typeof input.cwd !== 'string' || input.cwd.trim() === '') {
      return { kind: 'error', reason: 'cwd 必须是非空字符串' };
    }

    try {
      await this.ensureReady();
    } catch (e: any) {
      return { kind: 'error', reason: 'CCSN 进程启动失败: ' + (e?.message || String(e)) };
    }

    const id = crypto.randomUUID();
    const msg: CcsnRequestMessage = { id, command: input.command, cwd: input.cwd };

    let resp: CcsnResponseMessage;
    try {
      resp = await this.send(msg);
    } catch (e: any) {
      return { kind: 'error', reason: e?.message || String(e) };
    }

    if (!('kind' in resp)) {
      return { kind: 'error', reason: 'CCSN 返回了非预期结构' };
    }
    if (resp.kind === 'allow') return { kind: 'allow' };
    if (resp.kind === 'deny') {
      return { kind: 'deny', reason: resp.reason || '', ruleId: resp.ruleId || '' };
    }
    return { kind: 'error', reason: resp.reason || 'CCSN 检查失败' };
  }

  dispose(): void {
    this.disposed = true;
    this.teardown(new Error('CCSN 客户端已销毁'));
  }

  // ==================== 内部 ====================

  private ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    const p = this.spawnAndWaitReady();
    this.readyPromise = p;
    // 统一在链上吞掉 rejection，避免产生 unhandled rejection；
    // 失败时清空引用，允许下一次请求重新拉起进程。
    p.then(
      () => { /* ready */ },
      () => {
        if (this.readyPromise === p) this.readyPromise = null;
      }
    );
    return p;
  }

  private spawnAndWaitReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let proc: CcsnProcess;
      try {
        proc = this.factory();
      } catch (e: any) {
        return reject(e);
      }
      this.proc = proc;

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.teardown(new Error('CCSN 进程启动超时'));
        reject(new Error('CCSN 进程启动超时'));
      }, this.startupTimeoutMs);

      proc.onMessage((raw) => {
        if (!isRoutableMessage(raw)) return;
        if ('type' in raw && raw.type) {
          if (raw.type === 'ready') {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
            return;
          }
          // init-error
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.teardown(new Error('CCSN 初始化失败'));
          reject(new Error(raw.reason || 'CCSN 初始化失败'));
          return;
        }
        // 普通响应（kind 合法性由 check() 校验）
        const p = this.pending.get(raw.id);
        if (p) {
          this.pending.delete(raw.id);
          clearTimeout(p.timer);
          p.resolve(raw as unknown as CcsnResponseMessage);
        }
      });

      proc.onExit((code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('CCSN 进程在就绪前退出，exitCode=' + code));
        }
        // 进程退出后清空引用与未决请求，下次请求重新拉起
        this.proc = null;
        this.readyPromise = null;
        this.rejectAllPending(new Error('CCSN 进程已退出，exitCode=' + code));
      });
    });
  }

  private send(msg: CcsnRequestMessage): Promise<CcsnResponseMessage> {
    const proc = this.proc;
    if (!proc) {
      return Promise.reject(new Error('CCSN 进程不可用'));
    }
    return new Promise<CcsnResponseMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        // 超时后认为进程可能卡死，直接销毁，下次重建
        this.teardown(new Error('CCSN 检查超时'));
        reject(new Error('CCSN 检查超时（' + this.requestTimeoutMs + 'ms）'));
      }, this.requestTimeoutMs);

      this.pending.set(msg.id, { resolve, reject, timer });
      try {
        proc.postMessage(msg);
      } catch (e: any) {
        this.pending.delete(msg.id);
        clearTimeout(timer);
        reject(new Error('CCSN 发送请求失败: ' + (e?.message || String(e))));
      }
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private teardown(err: Error): void {
    const proc = this.proc;
    this.proc = null;
    this.readyPromise = null;
    this.rejectAllPending(err);
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
    }
  }
}

/** 把 CcsnClient 适配成 SafetyChecker（供 safety-precheck 注入） */
export function createCcsnChecker(client: CcsnClient): SafetyChecker {
  return (input) => client.check(input);
}
