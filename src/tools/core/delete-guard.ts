/**
 * 删除审批编排（tools 层）
 *
 * 职责：串起「分析 → 预览 → 弹窗 → 执行前复查」。
 *
 * 依赖方向：tools/core 不可 import app。弹窗通过 injectDeleteApprovalHandler 注入。
 *
 * 失败策略（fail-closed）：
 *  - handler 未注入 → reject
 *  - 分析异常 → reject
 *  - 弹窗异常 → reject
 *  - 执行前 lstat 失败 / 目标变为符号链接 → reject
 */

import fs from 'node:fs';
import { analyzeCommand } from '../../infra/dangerous-delete.js';
import type { DeleteAnalysis, ShellKind } from '../../infra/dangerous-delete.js';
import { previewDelete, formatBytes } from './delete-preview.js';
import type { PreviewResult } from './delete-preview.js';

// ==================== 类型 ====================

export type DeleteApprovalDecision = 'allow' | 'manual';

export interface DeleteApprovalRequest {
  command: string;
  cwd: string;
  analysis: DeleteAnalysis;
  preview: PreviewResult | null;
  workspaceRoot: string | null;
  /** false 时弹窗不应显示「允许执行」按钮（含无法解析目标） */
  allowExecute: boolean;
}

export interface DeleteApprovalHandler {
  requestApproval(req: DeleteApprovalRequest): Promise<DeleteApprovalDecision>;
}

export type DeleteGuardResult =
  | { action: 'execute' }
  | { action: 'manual'; text: string }
  | { action: 'reject'; text: string };

// ==================== 注入 ====================

let globalHandler: DeleteApprovalHandler | null = null;

/**
 * 注入删除审批处理器（app 层启动时调用）。
 * 传 null 可清除注入（测试用）。
 */
export function injectDeleteApprovalHandler(h: DeleteApprovalHandler | null): void {
  globalHandler = h;
}

/** 仅供测试：读取当前注入状态 */
export function hasDeleteApprovalHandler(): boolean {
  return globalHandler !== null;
}

// ==================== 文案构造 ====================

function buildManualText(analysis: DeleteAnalysis, preview: PreviewResult | null): string {
  const lines: string[] = [];
  lines.push('用户未授权 AI 执行此删除操作，将自行手动处理。');
  lines.push('');
  lines.push('请勿再次尝试删除以下目标：');

  // 顶层目标（按 resolved || raw 去重）
  const tops = new Set<string>();
  for (const t of analysis.targets) {
    tops.add(t.resolved || t.raw);
  }
  if (tops.size === 0) {
    lines.push('  （无法确定目标）');
  } else {
    for (const p of tops) lines.push('  · ' + p);
  }

  if (preview) {
    const total = preview.totalFiles + preview.totalDirs;
    if (total > 0) {
      lines.push('  （共 ' + preview.totalDirs + ' 个目录、' + preview.totalFiles + ' 个文件，' + formatBytes(preview.totalBytes) + '）');
      if (preview.truncated) {
        lines.push('  （清单已截断，实际数量可能更多）');
      }
    }
  }

  if (analysis.hasUnresolved) {
    lines.push('  ⚠️ 影响范围无法完全确定（命令含变量 / 脚本调用 / 无法解析的包装）');
  }

  lines.push('');
  lines.push('建议改用只读方式确认现状（如 dir / ls），或等待用户明确指示后再操作。');
  return lines.join('\n');
}

// ==================== 执行前复查 ====================

interface RecheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * 执行前对每个已解析目标做 lstat 复查：
 *  - 目标不存在 → 可能已被移动/删除，拒绝（要求重新发起）
 *  - 目标变为符号链接 → 可能被替换，拒绝
 *  - 其他异常 → 拒绝
 */
function recheckTargets(analysis: DeleteAnalysis): RecheckResult {
  for (const t of analysis.targets) {
    if (!t.resolved) continue;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(t.resolved);
    } catch (e: any) {
      const msg = e && e.message ? e.message : String(e);
      return { ok: false, reason: '目标已不存在或无法访问：' + t.resolved + '（' + msg + '）' };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, reason: '目标已被替换为符号链接：' + t.resolved };
    }
  }
  return { ok: true };
}

// ==================== 主入口 ====================

/**
 * 对一条命令执行删除保护编排。
 *
 * @param rawCommand 命令原文
 * @param cwd 执行目录
 * @param workspaceRoot 工作区根（可为 null）
 * @param shell 目标 shell
 */
export async function guardDelete(
  rawCommand: string,
  cwd: string,
  workspaceRoot: string | null,
  shell: ShellKind,
): Promise<DeleteGuardResult> {
  // 1. 分析
  let analysis: DeleteAnalysis;
  try {
    analysis = analyzeCommand(rawCommand, { cwd, workspaceRoot, shell });
  } catch (e: any) {
    const msg = e && e.message ? e.message : String(e);
    return { action: 'reject', text: '安全策略：删除检测异常，已拒绝执行（' + msg + '）' };
  }

  if (analysis.verdict === 'none') {
    return { action: 'execute' };
  }

  // 2. handler 必须在弹窗前就检查，避免无谓扫描
  const handler = globalHandler;
  if (!handler) {
    return { action: 'reject', text: '安全策略：删除审批处理器未注入，已拒绝执行。' };
  }

  // 3. 预览（unknown 目标不预览，直接弹窗说明无法确定）
  let preview: PreviewResult | null = null;
  if (!analysis.hasUnresolved) {
    try {
      preview = await previewDelete(analysis.targets, workspaceRoot);
    } catch (e: any) {
      const msg = e && e.message ? e.message : String(e);
      return { action: 'reject', text: '安全策略：无法预览删除范围，已拒绝执行（' + msg + '）' };
    }
  }

  // 4. 弹窗
  const allowExecute = !analysis.hasUnresolved;
  let decision: DeleteApprovalDecision;
  try {
    decision = await handler.requestApproval({
      command: rawCommand,
      cwd,
      analysis,
      preview,
      workspaceRoot,
      allowExecute,
    });
  } catch (e: any) {
    const msg = e && e.message ? e.message : String(e);
    return { action: 'reject', text: '删除审批异常，已拒绝执行（' + msg + '）' };
  }

  if (decision === 'manual') {
    return { action: 'manual', text: buildManualText(analysis, preview) };
  }

  // 5. 执行前复查
  const rc = recheckTargets(analysis);
  if (!rc.ok) {
    return { action: 'reject', text: '安全策略：' + (rc.reason || '执行前复查失败') + '。已拒绝执行，请重试。' };
  }

  return { action: 'execute' };
}
