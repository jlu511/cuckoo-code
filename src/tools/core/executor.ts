/**
 * SandboxExecutor：Phase 1 执行器与审批网关。
 * 
 * ⚠️ 安全边界声明：
 * 本模块仅提供【应用层审批控制】，不包含操作系统级隔离。
 */

import crypto from 'node:crypto';
import { isL0ReadOnly } from './readonly-checker.js';
import { scanForSensitiveAccess } from './sensitive-guard.js';
import { runSafetyPrecheck, type PrecheckOutcome } from './safety-precheck.js';
import { checkCommandPermission } from '../../infra/permission.js';
import { buildRequestFingerprint, isSessionGrantBlocked } from './session-grant-policy.js';

export interface ProcessRequest {
  type: 'process';
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  description?: string;
}

export interface ShellRequest {
  type: 'shell';
  shellType: 'cmd' | 'powershell' | 'bash';
  rawCommand: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
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
  /**
   * 是否允许显示「本会话内允许」按钮（需求 032）。
   * 由执行器计算：L3 / 高危 / Git 状态变更 / 命令链 / 代次非法 → false。
   * 处理器若在 false 时仍返回 allow_session，执行器会 fail-closed。
   */
  canAllowSession?: boolean;
}

export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny';

/** 阻断通知信息（CC Safety Net 硬性否决 / 预检异常） */
export interface BlockedNotice {
  request: ExecRequest;
  /** 敏感路径命中详情（未命中时为 null） */
  sensitive: { hit: boolean; targets: string[]; reasons: string[] };
  /** 阻断原因 */
  reason: string;
  /** 阻断规则标识 */
  ruleId: string;
}

export interface ApprovalHandler {
  requestApproval(dto: ApprovalDTO): Promise<ApprovalDecision>;
  /**
   * 仅通知：告诉用户某条命令已被硬性阻断（CC Safety Net deny 或预检异常）。
   * 实现方不得提供"允许执行"选项；此方法无返回值，也不影响控制流。
   */
  notifyBlocked?(notice: BlockedNotice): Promise<void>;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  isTimeout?: boolean;
  isCancelled?: boolean;
}

export interface ProcessRunner {
  run(request: ExecRequest, signal: AbortSignal): Promise<ProcessResult>;
}

export interface AuditLogger {
  log(snapshot: ExecSnapshot, result?: ProcessResult, error?: string): void;
}

/**
 * 会话 ID 解析器。每次调用返回"此刻"的活动会话 ID（可为 null）。
 * 由调用方注入，避免 tools 层依赖 session store。
 */
export type SessionIdProvider = () => string | null;

/**
 * 会话代次提供者（需求 032）。
 * 每次会话切换（含 A→B、A→null、null→A）都应递增。
 * 用于让旧会话的授权永远无法命中——包括 A→B→A 场景。
 * 返回值必须是安全整数且 >= 0，否则会话授权功能禁用（fail-closed）。
 */
export type SessionGenerationProvider = () => number;

export interface SandboxOptions {
  /** pending 状态最长存活时间（毫秒）。超时后视为 expired，拒绝执行。默认 5 分钟。 */
  pendingTtlMs?: number;
  /** 拒绝熔断窗口（毫秒）。同一 taskId + 签名在此窗口内重试将被直接拦截。默认 60 秒。 */
  denialWindowMs?: number;
}

const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_DENIAL_WINDOW_MS = 60 * 1000;
const SENSITIVE_ENV_RE = /TOKEN|API_KEY|PASSWORD|SECRET|AUTH|CREDENTIAL/i;

/**
 * 对快照做深拷贝并对敏感 env 值脱敏。
 * 注意：脱敏只影响审计/日志，不修改实际执行用的快照。
 */
function sanitizeSnapshot(snap: ExecSnapshot): ExecSnapshot {
  const clone: ExecSnapshot = JSON.parse(JSON.stringify(snap));
  const env = clone.request.env;
  if (env && typeof env === 'object') {
    for (const key of Object.keys(env)) {
      if (SENSITIVE_ENV_RE.test(key)) {
        env[key] = '[REDACTED]';
      }
    }
  }
  return clone;
}

export class SandboxExecutor {
  private registry = new Map<string, ExecSnapshot>();
  private denials = new Map<string, number>();
  private activeControllers = new Map<string, AbortController>();
  /** 相同 taskId + 签名并发去重锁 */
  private runningSignatures = new Set<string>();
  /**
   * 会话授权缓存（需求 032）。
   * key = generation::sessionId::fingerprint；value 恒为 true（只存已授权）。
   * 不存「拒绝」——拒绝由 denials + denialWindowMs 处理，语义不同。
   */
  private sessionGrants = new Map<string, true>();

  private readonly pendingTtlMs: number;
  private readonly denialWindowMs: number;

  constructor(
    private approvalHandler: ApprovalHandler,
    private processRunner: ProcessRunner,
    private auditLogger?: AuditLogger,
    options?: SandboxOptions
  ) {
    this.pendingTtlMs = options?.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.denialWindowMs = options?.denialWindowMs ?? DEFAULT_DENIAL_WINDOW_MS;
  }

  /**
   * 执行入口。
   * @param req 结构化请求
   * @param taskId 任务 ID（用于熔断与并发去重）
   * @param sessionId 发起请求的会话 ID
   * @param getCurrentSessionId 会话解析器（每次调用返回当前活动会话 ID）
   */
  async execute(
    req: ExecRequest,
    taskId: string,
    sessionId: string,
    getCurrentSessionId: SessionIdProvider,
    getSessionGeneration?: SessionGenerationProvider,
    scopeId?: string,
    windowId?: number
  ): Promise<ProcessResult> {
    // 0. 请求所属会话必须有效（拒绝伪造/空值）
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new Error('安全策略拒绝：请求缺少有效的所属会话 ID。');
    }

    // 1. 审批前校验：请求所属会话必须与当前活动会话一致
    const activeBefore = this.safeResolveSession(getCurrentSessionId);
    if (activeBefore !== sessionId) {
      throw new Error('安全策略拒绝：请求所属会话与当前活动会话不一致。');
    }

    const sig = this.getSignature(req);
    const denialKey = this.getDenialKey(taskId, sig);
    const runningKey = denialKey;

    // 1. 拒绝熔断
    if (this.isRecentlyDenied(denialKey)) {
      const msg = '操作被终止：该命令在本任务内近期已被拒绝，请等待熔断窗口结束。';
      this.auditLogger?.log(
        sanitizeSnapshot({ id: 'pre-check', taskId, sessionId, request: req, status: 'denied', createdAt: Date.now() }),
        undefined,
        msg
      );
      throw new Error(msg);
    }

    // 2. 并发去重（相同 taskId + 签名）
    if (this.runningSignatures.has(runningKey)) {
      throw new Error('安全策略拒绝：相同请求正在审批或执行中，请等待其完成。');
    }
    this.runningSignatures.add(runningKey);

    try {
      const snapshot: ExecSnapshot = {
        id: crypto.randomUUID(),
        taskId, sessionId, request: req, status: 'pending', createdAt: Date.now(),
      };
      this.registry.set(snapshot.id, snapshot);

      // 3. 访问模式权限检查（只读模式禁止一切命令执行）
      //    必须最先执行：不能被子序列的 L0 放行、用户批准或 CCSN allow 覆盖
      try {
        const perm = checkCommandPermission(req.type === 'shell' ? req.rawCommand : req.executable);
        if (!perm.allow) {
          snapshot.status = 'denied';
          const reason = perm.reason || '当前访问模式不允许执行命令。';
          this.auditLogger?.log(
            sanitizeSnapshot(snapshot),
            undefined,
            'Blocked by access mode: ' + reason
          );
          throw new Error('安全策略拒绝：' + reason);
        }
      } catch (err: any) {
        if (err && typeof err.message === 'string' && err.message.startsWith('安全策略拒绝：')) {
          throw err;
        }
        // 权限检查本身异常 → fail-closed
        snapshot.status = 'denied';
        const reason = '权限检查异常，已拒绝执行：' + ((err && err.message) || String(err));
        this.auditLogger?.log(sanitizeSnapshot(snapshot), undefined, reason);
        throw new Error('安全策略拒绝：' + reason);
      }

      // 4. 安全预检（敏感路径 + CC Safety Net）
      //    必须在审批之前完成：CCSN 的 deny 是硬性否决，不能被 L3/L2 授权覆盖
      const precheck = await runSafetyPrecheck(req);

      if (precheck.blocked) {
        snapshot.status = 'denied';
        const reason = precheck.blockReason || '安全预检拒绝执行。';
        this.auditLogger?.log(
          sanitizeSnapshot(snapshot),
          undefined,
          'Blocked by safety precheck [' + (precheck.blockRuleId || '-') + ']: ' + reason
        );

        // CCSN 硬性否决或预检异常：一律显示阻断提示（不论是否命中敏感路径）
        if (typeof this.approvalHandler.notifyBlocked === 'function') {
          try {
            await this.approvalHandler.notifyBlocked({
              request: JSON.parse(JSON.stringify(req)),
              sensitive: precheck.sensitive,
              reason,
              ruleId: precheck.blockRuleId || 'cuckoo.precheck',
            });
          } catch (_) { /* 通知失败不影响拒绝 */ }
        }

        throw new Error('安全策略拒绝：' + reason);
      }

      // 5. 审批
      const risk = this.assessRisk(req, precheck);
      let decision: ApprovalDecision;

      // 5a. 会话代次（需求 032）：非法值 → 禁用会话授权（fail-closed）
      //     在审批前读取一次，用于缓存查询；审批后再读一次，用于写缓存前的二次校验。
      const genBefore = this.resolveGeneration(getSessionGeneration);

      // 5b. 会话授权缓存查询（仅在 L2 且资格允许时）
      //     位置必须在只读权限、CCSN、敏感路径判定之后——它们已全部通过。
      //
      //     scopeId（profile 标识）与 windowId（窗口实例标识）都必须有效才启用会话授权：
      //       - scopeId 缺失 → 不同 profile 的相同 sessionId 会共享授权键
      //       - windowId 缺失 → 同一 profile+会话在不同窗口间会共享授权键
      //     与 generation 缺失一致，采用 fail-closed。
      const scopeValid = typeof scopeId === 'string' && scopeId.trim() !== '';
      const windowValid =
        typeof windowId === 'number' &&
        Number.isSafeInteger(windowId) &&
        windowId > 0;
      const grantEligible =
        risk.level === 'L2' &&
        !isSessionGrantBlocked(req, risk.level) &&
        genBefore !== null &&
        scopeValid &&
        windowValid;
      let grantKey: string | null = null;
      let cacheHit = false;
      if (grantEligible) {
        grantKey = this.buildGrantKey(
          genBefore as number,
          sessionId,
          req,
          scopeId as string,
          windowId as number
        );
        if (this.sessionGrants.has(grantKey)) cacheHit = true;
      }

      if (risk.level === 'L0') {
        // L0：跳过弹窗，直接自动放行。后续校验（快照/TTL/会话/拒绝/执行）全部保留。
        decision = 'allow_once';
        this.auditLogger?.log(
          sanitizeSnapshot(snapshot),
          undefined,
          'Auto-approved L0: ' + risk.reasons.join('; ')
        );
      } else if (cacheHit) {
        // 会话授权命中：跳过弹窗。后续所有校验（快照/TTL/会话/代次/执行）全部保留。
        decision = 'allow_session';
        this.auditLogger?.log(
          sanitizeSnapshot(snapshot),
          undefined,
          'Session grant hit: ' + (grantKey || '').slice(0, 16) + '…'
        );
      } else {
        try {
          const dto: ApprovalDTO = {
            id: snapshot.id,
            request: JSON.parse(JSON.stringify(req)),
            riskLevel: risk.level,
            riskReasons: risk.reasons,
            canAllowSession: grantEligible,
          };
          decision = await this.approvalHandler.requestApproval(dto);
        } catch (err: any) {
          this.registry.delete(snapshot.id);
          throw new Error('审批过程发生异常: ' + (err.message || err));
        }
      }

      // 6. 校验快照状态与过期
      const snap = this.registry.get(snapshot.id);
      if (!snap || snap.status !== 'pending') {
        throw new Error('快照状态异常：该请求已被处理或过期。');
      }
      const ageMs = Date.now() - snap.createdAt;
      if (ageMs > this.pendingTtlMs) {
        snap.status = 'expired';
        this.auditLogger?.log(sanitizeSnapshot(snap), undefined, 'Pending expired before approval');
        throw new Error('安全策略拒绝：审批结果返回时请求已过期（' + ageMs + 'ms）。');
      }

      // 审批后二次校验：重新实时读取当前活动会话
      let activeAfter: string;
      try {
        activeAfter = this.safeResolveSession(getCurrentSessionId);
      } catch (e: any) {
        snap.status = 'expired';
        this.auditLogger?.log(sanitizeSnapshot(snap), undefined, e?.message || String(e));
        throw e;
      }
      if (activeAfter !== sessionId) {
        snap.status = 'expired';
        const msg = '安全策略拒绝：审批期间会话已切换，请求作废。';
        this.auditLogger?.log(sanitizeSnapshot(snap), undefined, msg);
        throw new Error(msg);
      }

      // 6b. 会话代次二次校验（需求 032）
      //     覆盖「审批弹窗打开期间发生 A→B→A」：sessionId 相同但 generation 变了。
      const genAfter = this.resolveGeneration(getSessionGeneration);
      if (genBefore !== genAfter) {
        snap.status = 'expired';
        const msg = '安全策略拒绝：审批期间会话代次已变化，请求作废。';
        this.auditLogger?.log(sanitizeSnapshot(snap), undefined, msg);
        throw new Error(msg);
      }

      // 6c. 防御性复核：allow_session 只能来自「本次允许会话授权」的弹窗
      //     - grantEligible 已包含 L2 + 非禁止 + generation 有效 + scope 有效
      //     - 弹窗返回时，必须在 canAllowSession === true 的前提下才可信
      if (decision === 'allow_session' && !cacheHit) {
        if (!grantEligible) {
          snap.status = 'denied';
          const msg = '安全策略拒绝：该请求不允许会话授权，但审批返回了 allow_session。';
          this.auditLogger?.log(sanitizeSnapshot(snap), undefined, msg);
          throw new Error(msg);
        }
      }

      if (decision === 'deny') {
        snap.status = 'denied';
        this.recordDenial(denialKey);
        this.auditLogger?.log(sanitizeSnapshot(snap), undefined, 'User denied');
        throw new Error('用户拒绝了此操作。');
      }

      // 6d. 写入会话授权缓存（需求 032）
      //     只在此刻写入：deny 已排除、代次未变、资格已确认、快照未过期。
      if (decision === 'allow_session' && !cacheHit && grantKey && grantEligible) {
        this.sessionGrants.set(grantKey, true);
        this.auditLogger?.log(
          sanitizeSnapshot(snap),
          undefined,
          'Session grant stored: ' + grantKey.slice(0, 16) + '…'
        );
      }

      // 7. 执行（pending -> running 在单线程内原子）
      snap.status = 'running';
      const ac = new AbortController();
      this.activeControllers.set(snap.id, ac);

      try {
        const result = await this.processRunner.run(snap.request, ac.signal);
        if (result.isCancelled) snap.status = 'cancelled';
        else if (result.isTimeout) snap.status = 'timed_out';
        else if (result.exitCode !== 0) snap.status = 'failed';
        else snap.status = 'succeeded';

        this.auditLogger?.log(sanitizeSnapshot(snap), result);
        return result;
      } catch (err: any) {
        snap.status = 'failed';
        this.auditLogger?.log(sanitizeSnapshot(snap), undefined, err.message || String(err));
        throw err;
      } finally {
        this.activeControllers.delete(snap.id);
        setTimeout(() => this.registry.delete(snapshot.id), 60 * 1000);
      }
    } finally {
      this.runningSignatures.delete(runningKey);
    }
  }

  /**
   * 清空所有会话授权（需求 032）。
   * 供窗口关闭 / 会话上下文销毁 / 测试使用。
   */
  clearSessionGrants(): void {
    this.sessionGrants.clear();
  }

  /** 当前缓存条目数（测试与诊断用） */
  getSessionGrantCount(): number {
    return this.sessionGrants.size;
  }

  /**
   * 读取并校验会话代次（需求 032）。
   * 非法值（未注入 / 抛错 / 非安全整数 / 负数）一律返回 null → 禁用会话授权。
   */
  private resolveGeneration(provider?: SessionGenerationProvider): number | null {
    if (typeof provider !== 'function') return null;
    let v: unknown;
    try {
      v = provider();
    } catch (_) {
      return null;
    }
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return null;
    return v;
  }

  /**
   * 构造会话授权缓存键：
   *   scope::window::generation::sessionId::fingerprint
   *
   * 三段作用域各司其职：
   *   - scope（profileId）：不同 profile 的 sessionId 可能相同，需隔离
   *   - window（Electron window.id）：同 profile + 同会话在不同窗口间不共享授权。
   *     窗口重建会分配新 id，因此旧窗口的授权不会随新窗口复活
   *   - generation（进程级全局）：任一窗口切换会话或关闭，使所有旧键失效
   *
   * 调用方必须先确认三者有效才会走到这里（见 execute() 的 grantEligible）。
   */
  private buildGrantKey(
    gen: number,
    sessionId: string,
    req: ExecRequest,
    scopeId: string,
    windowId: number
  ): string {
    return scopeId + '::' + windowId + '::' + gen + '::' + sessionId + '::' + buildRequestFingerprint(req);
  }

  /**
   * 外部取消执行。
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

  /**
   * 安全解析当前活动会话。任何异常/空值/非法类型都显式拒绝，不静默跳过。
   */
  private safeResolveSession(provider: SessionIdProvider): string {
    if (typeof provider !== 'function') {
      throw new Error('安全策略拒绝：会话解析器未提供。');
    }
    let v: string | null;
    try {
      v = provider();
    } catch (e: any) {
      throw new Error('安全策略拒绝：会话解析器异常。' + (e?.message || String(e)));
    }
    if (!v || typeof v !== 'string' || v.trim() === '') {
      throw new Error('安全策略拒绝：无法获取当前活动会话 ID。');
    }
    return v;
  }

  private assessRisk(req: ExecRequest, precheck?: PrecheckOutcome): { level: 'L0'|'L1'|'L2'|'L3', reasons: string[] } {
    // L3：敏感路径访问（优先级最高，覆盖 L0）
    try {
      const sensitive = precheck ? precheck.sensitive : scanForSensitiveAccess(req);
      if (sensitive.hit) {
        return {
          level: 'L3',
          reasons: [
            '敏感路径访问',
            ...sensitive.reasons,
            '目标: ' + sensitive.targets.join('; '),
          ],
        };
      }
    } catch (_) {
      // 扫描异常 → 不静默放行，落回 L2 审批
    }

    // L0：只读白名单
    try {
      if (isL0ReadOnly(req)) {
        return { level: 'L0', reasons: ['只读命令白名单命中'] };
      }
    } catch (_) {
      // 判定器异常 → fail closed，回退 L2
    }

    return { level: 'L2', reasons: ['默认策略：应用层执行请求'] };
  }

  private getSignature(req: ExecRequest): string {
    if (req.type === 'shell') {
      return 'shell:' + req.shellType + ':' + req.rawCommand + ':' + req.cwd;
    }
    return 'proc:' + req.executable + ':' + req.args.join(' ') + ':' + req.cwd;
  }

  private getDenialKey(taskId: string, sig: string): string {
    return taskId + '::' + sig;
  }

  private isRecentlyDenied(denialKey: string): boolean {
    const last = this.denials.get(denialKey);
    if (!last) return false;
    return Date.now() - last < this.denialWindowMs;
  }

  private recordDenial(denialKey: string): void {
    this.denials.set(denialKey, Date.now());
  }
}

let globalExecutor: SandboxExecutor | null = null;

export function injectSandboxExecutor(
  handler: ApprovalHandler,
  runner: ProcessRunner,
  logger?: AuditLogger,
  options?: SandboxOptions
): void {
  globalExecutor = new SandboxExecutor(handler, runner, logger, options);
}

export function getSandboxExecutor(): SandboxExecutor {
  if (!globalExecutor) {
    throw new Error('安全策略拒绝：SandboxExecutor 未初始化，请先在应用入口调用 injectSandboxExecutor。');
  }
  return globalExecutor;
}
