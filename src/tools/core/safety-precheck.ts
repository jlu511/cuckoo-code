/**
 * 共用安全预检（tools 层）。
 *
 * 职责：在执行前统一做两件事——
 *   1. 敏感路径扫描（本地同步，命中即升 L3）
 *   2. CC Safety Net 检查（异步，通过注入的检查器；deny 是硬性否决）
 *
 * ⚠️ 边界：
 *  - 只负责"判定"，不负责"展示 UI"
 *  - 无法可靠抽取命令正文的请求一律 fail-closed（blocked）
 *  - CC Safety Net 的 deny/异常不可被后续审批覆盖
 */
import path from 'node:path';
import type { ExecRequest } from './executor.js';
import { scanForSensitiveAccess, type SensitiveAccessResult } from './sensitive-guard.js';

// ==================== CC Safety Net 检查器契约 ====================

export interface SafetyCheckInput {
  command: string;
  cwd: string;
}

export type SafetyCheckResult =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; ruleId: string }
  | { kind: 'error'; reason: string };

export type SafetyChecker = (input: SafetyCheckInput) => Promise<SafetyCheckResult>;

let globalChecker: SafetyChecker | null = null;

/** 注入检查器（应用入口调用；不注入则 fail-closed） */
export function injectSafetyChecker(checker: SafetyChecker | null): void {
  globalChecker = checker;
}

export function getSafetyChecker(): SafetyChecker | null {
  return globalChecker;
}

// ==================== 命令正文抽取 ====================

export type ExtractResult =
  | { ok: true; command: string; cwd: string }
  | { ok: false; reason: string };

function validateInput(command: string, cwd: string): ExtractResult {
  if (typeof command !== 'string' || command.trim() === '') {
    return { ok: false, reason: '命令正文为空' };
  }
  if (typeof cwd !== 'string' || cwd.trim() === '' || !path.isAbsolute(cwd)) {
    return { ok: false, reason: 'cwd 必须是绝对路径: ' + String(cwd) };
  }
  return { ok: true, command, cwd };
}

/**
 * 从 ExecRequest 中抽取可交给 CC Safety Net 的 { command, cwd }。
 *
 * - ShellRequest：直接用 rawCommand
 * - ProcessRequest：仅接受 powershell/pwsh -NoProfile -Command <script> 形态，
 *   返回 script 正文（不拼接 executable + args，避免引号歧义）
 * - 其他形态：fail-closed（ok: false）
 */
export function extractSafetyCommand(req: ExecRequest): ExtractResult {
  if (req.type === 'shell') {
    return validateInput(req.rawCommand, req.cwd);
  }

  // ProcessRequest
  const exe = String(req.executable || '').toLowerCase().replace(/\.exe$/, '');
  if (exe !== 'powershell' && exe !== 'pwsh') {
    return { ok: false, reason: '不支持的 ProcessRequest 可执行文件: ' + String(req.executable) };
  }
  const a = req.args || [];
  if (
    a.length !== 3 ||
    a[0] !== '-NoProfile' ||
    a[1] !== '-Command' ||
    typeof a[2] !== 'string'
  ) {
    return {
      ok: false,
      reason: '不支持的 powershell 参数形态（仅接受 -NoProfile -Command <script>）',
    };
  }
  return validateInput(a[2], req.cwd);
}

// ==================== 预检结果 ====================

export interface PrecheckOutcome {
  /** 敏感路径扫描结果（可能因异常而退化为未命中） */
  sensitive: SensitiveAccessResult;
  /** CC Safety Net 结果 */
  ccsn: SafetyCheckResult;
  /** 是否必须拒绝（CCSN deny / 异常 / 抽取失败 / 检查器未注入） */
  blocked: boolean;
  /** 阻断原因（blocked=true 时必有） */
  blockReason?: string;
  /** 阻断规则标识 */
  blockRuleId?: string;
}

/**
 * 执行安全预检。
 *
 * 顺序：
 *   1. 敏感路径（同步、纯本地，任何异常都退化为未命中，由后续层保守处理）
 *   2. 抽取 CCSN 输入（失败 → blocked）
 *   3. 调用检查器（异常 → blocked）
 *   4. 判定 blocked：deny / error 均为硬性否决
 */
export async function runSafetyPrecheck(req: ExecRequest): Promise<PrecheckOutcome> {
  // 1. 敏感路径
  let sensitive: SensitiveAccessResult;
  try {
    sensitive = scanForSensitiveAccess(req);
  } catch (_) {
    sensitive = { hit: false, targets: [], reasons: [] };
  }

  // 2. 抽取命令正文
  const extracted = extractSafetyCommand(req);
  if (!extracted.ok) {
    return {
      sensitive,
      ccsn: { kind: 'error', reason: extracted.reason },
      blocked: true,
      blockReason: '无法可靠分析该命令（' + extracted.reason + '），已拒绝执行。',
      blockRuleId: 'cuckoo.extraction-unsupported',
    };
  }

  // 3. 调用检查器
  const checker = globalChecker;
  if (!checker) {
    return {
      sensitive,
      ccsn: { kind: 'error', reason: 'CC Safety Net 检查器未注入' },
      blocked: true,
      blockReason: '安全预检服务不可用，已拒绝执行。',
      blockRuleId: 'cuckoo.checker-unavailable',
    };
  }

  let ccsn: SafetyCheckResult;
  try {
    ccsn = await checker({ command: extracted.command, cwd: extracted.cwd });
  } catch (e: any) {
    ccsn = { kind: 'error', reason: '检查异常: ' + (e && e.message ? e.message : String(e)) };
  }

  // 4. 判定
  if (ccsn.kind === 'deny') {
    return {
      sensitive,
      ccsn,
      blocked: true,
      blockReason: 'CC Safety Net 拒绝执行：' + (ccsn.reason || '(无原因)'),
      blockRuleId: ccsn.ruleId || 'ccsn.deny',
    };
  }
  if (ccsn.kind === 'error') {
    return {
      sensitive,
      ccsn,
      blocked: true,
      blockReason: '安全预检异常，已拒绝执行：' + (ccsn.reason || 'unknown'),
      blockRuleId: 'cuckoo.precheck-error',
    };
  }

  return { sensitive, ccsn, blocked: false };
}
