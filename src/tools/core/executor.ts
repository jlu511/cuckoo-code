/**
 * SandboxExecutor：Phase 1 执行器与审批网关。
 * 
 * ⚠️ 安全边界声明：
 * 本模块仅提供【应用层审批控制】，不包含操作系统级隔离。
 */

import crypto from 'node:crypto';

export interface ProcessRequest {
  type: 'process';
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  /** AI 提供的用途说明（用于审批弹窗展示） */
  description?: string;
}

export interface ShellRequest {
  type: 'shell';
  shellType: 'cmd' | 'powershell' | 'bash';
  rawCommand: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  /** AI 提供的用途说明（用于审批弹窗展示） */
  description?: string;
}

export type ExecRequest = ProcessRequest | ShellRequest;

export type ExecStatus =
  | 'pending' | 'approved' | 'denied' | 'running'
  | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'expired';

export interface ExecSnapshot {
  id: string;
  taskId: string;
  sessionId: string;
  request: ExecRequest;
  status: ExecStatus;
  createdAt: number;
}

export interface ApprovalDTO {
  id: string;
  request: ExecRequest;
  riskLevel: 'L0' | 'L1' | 'L2' | 'L3';
  riskReasons: string[];
}

export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny';

export interface ApprovalHandler {
  requestApproval(dto: ApprovalDTO): Promise<ApprovalDecision>;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  isTimeout?: boolean;
}

export interface ProcessRunner {
  run(request: ExecRequest, signal: AbortSignal): Promise<ProcessResult>;
}

export interface AuditLogger {
  log(snapshot: ExecSnapshot, result?: ProcessResult, error?: string): void;
}

export class SandboxExecutor {
  private registry = new Map<string, ExecSnapshot>();
  private denials = new Map<string, number>();
  private activeControllers = new Map<string, AbortController>();

  constructor(
    private approvalHandler: ApprovalHandler,
    private processRunner: ProcessRunner,
    private auditLogger?: AuditLogger
  ) {}

  async execute(req: ExecRequest, taskId: string, sessionId: string): Promise<ProcessResult> {
    const risk = this.assessRisk(req);
    const sig = this.getSignature(req);

    if (this.isRecentlyDenied(sig)) {
      const msg = '操作被终止：检测到针对相同目标的重复请求（疑似绕过审批）。';
      this.auditLogger?.log({ id: 'pre-check', taskId, sessionId, request: req, status: 'denied', createdAt: Date.now() }, undefined, msg);
      throw new Error(msg);
    }

    const snapshot: ExecSnapshot = {
      id: crypto.randomUUID(),
      taskId, sessionId, request: req, status: 'pending', createdAt: Date.now(),
    };
    this.registry.set(snapshot.id, snapshot);

    let decision: ApprovalDecision;
    try {
      const dto: ApprovalDTO = {
        id: snapshot.id,
        request: JSON.parse(JSON.stringify(req)),
        riskLevel: risk.level,
        riskReasons: risk.reasons,
      };
      decision = await this.approvalHandler.requestApproval(dto);
    } catch (err: any) {
      this.registry.delete(snapshot.id);
      throw new Error('审批过程发生异常: ' + (err.message || err));
    }

    const snap = this.registry.get(snapshot.id);
    if (!snap || snap.status !== 'pending') {
      throw new Error('快照状态异常：该请求已被处理或过期。');
    }

    if (decision === 'deny') {
      snap.status = 'denied';
      this.recordDenial(sig);
      this.auditLogger?.log(snap, undefined, 'User denied');
      throw new Error('用户拒绝了此操作。');
    }

    snap.status = 'running';
    const ac = new AbortController();
    this.activeControllers.set(snap.id, ac);

    try {
      const result = await this.processRunner.run(snap.request, ac.signal);
      if (result.isTimeout) snap.status = 'timed_out';
      else if (result.exitCode !== 0) snap.status = 'failed';
      else snap.status = 'succeeded';
      
      this.auditLogger?.log(snap, result);
      return result;
    } catch (err: any) {
      snap.status = 'failed';
      this.auditLogger?.log(snap, undefined, err.message || String(err));
      throw err;
    } finally {
      this.activeControllers.delete(snap.id);
      setTimeout(() => this.registry.delete(snapshot.id), 60 * 1000);
    }
  }

  /**
   * 外部取消执行
   */
  cancel(snapshotId: string): boolean {
    const ac = this.activeControllers.get(snapshotId);
    if (ac) {
      ac.abort();
      this.activeControllers.delete(snapshotId);
      return true;
    }
    return false;
  }

  private assessRisk(req: ExecRequest): { level: 'L0'|'L1'|'L2'|'L3', reasons: string[] } {
    // 设计 v3：默认全部 L2，取消白名单
    return { level: 'L2', reasons: ['默认策略：应用层执行请求'] };
  }

  private getSignature(req: ExecRequest): string {
    if (req.type === 'shell') {
      return 'shell:' + req.shellType + ':' + req.rawCommand + ':' + req.cwd;
    }
    return 'proc:' + req.executable + ':' + req.args.join(' ') + ':' + req.cwd;
  }

  private isRecentlyDenied(sig: string): boolean {
    const last = this.denials.get(sig);
    if (!last) return false;
    return Date.now() - last < 60 * 1000;
  }

  private recordDenial(sig: string): void {
    this.denials.set(sig, Date.now());
  }
}

// ==================== 依赖注入 ====================
let globalExecutor: SandboxExecutor | null = null;

export function injectSandboxExecutor(handler: ApprovalHandler, runner: ProcessRunner, logger?: AuditLogger): void {
  globalExecutor = new SandboxExecutor(handler, runner, logger);
}

export function getSandboxExecutor(): SandboxExecutor {
  if (!globalExecutor) {
    throw new Error('安全策略拒绝：SandboxExecutor 未初始化，请先在应用入口调用 injectSandboxExecutor。');
  }
  return globalExecutor;
}
