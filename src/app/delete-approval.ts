/**
 * 删除审批弹窗（app 层）
 *
 * 职责：实现 DeleteApprovalHandler，展示删除目标与文件清单，让用户选择
 * 「允许执行」或「我自己删」。
 *
 * 依赖方向：app → tools（合规）。
 * Electron 通过 createRequire(import.meta.url) 动态 require。
 */

import { createRequire } from 'node:module';
import type {
  DeleteApprovalHandler,
  DeleteApprovalRequest,
  DeleteApprovalDecision,
} from '../tools/core/delete-guard.js';
import { formatBytes } from '../tools/core/delete-preview.js';

const require = createRequire(import.meta.url);

const MAX_LIST_ENTRIES = 50;

/** 是否为高危场景（红框） */
function isHighRisk(req: DeleteApprovalRequest): boolean {
  const DANGER = new Set(['drive-root', 'workspace-root', 'workspace-parent', 'outside']);
  return req.analysis.targets.some((t) => DANGER.has(t.scope));
}

/** 渲染文件清单 */
function buildList(req: DeleteApprovalRequest): string {
  const p = req.preview;
  if (!p) {
    if (req.analysis.hasUnresolved) {
      return '⚠️ 无法预览：命令含变量 / 脚本调用 / 无法解析的包装，无法确定真实范围。';
    }
    return '⚠️ 无法预览。';
  }

  const lines: string[] = [];
  const linkCount = p.entries.filter((e) => e.type === 'link').length;
  const total = p.totalFiles + p.totalDirs + linkCount;
  const linkSuffix = linkCount > 0 ? '、' + linkCount + ' 个链接' : '';
  lines.push('【将删除】共 ' + p.totalDirs + ' 个目录、' + p.totalFiles + ' 个文件' + linkSuffix + '（' + formatBytes(p.totalBytes) + '）');

  const shown = p.entries.slice(0, MAX_LIST_ENTRIES);
  for (const e of shown) {
    const prefix = e.type === 'dir' ? '[D] ' : e.type === 'link' ? '[L] ' : '    ';
    let line = '  ' + prefix + e.relPath;
    if (e.type === 'file' && typeof e.size === 'number') line += '  (' + formatBytes(e.size) + ')';
    if (e.type === 'link' && e.linkTarget) line += '  -> ' + e.linkTarget;
    lines.push(line);
  }

  if (p.entries.length < total) {
    lines.push('  （还有 ' + (total - p.entries.length) + ' 项未显示）');
  }
  if (p.truncated) {
    lines.push('  （清单已截断，实际数量可能更多）');
  }
  if (p.scanErrors.length > 0) {
    lines.push('');
    lines.push('⚠️ 以下目标无法扫描：');
    for (const e of p.scanErrors.slice(0, 10)) {
      lines.push('  · ' + e.path + '（' + e.error + '）');
    }
    if (p.scanErrors.length > 10) {
      lines.push('  （还有 ' + (p.scanErrors.length - 10) + ' 项）');
    }
  }
  return lines.join('\n');
}

/** 拼装弹窗 detail 文本 */
function buildDetail(req: DeleteApprovalRequest): string {
  const lines: string[] = [];

  lines.push('【原始命令】');
  lines.push(req.command);
  lines.push('');
  lines.push('【执行目录】');
  lines.push(req.cwd);
  lines.push('');

  lines.push('【解析目标】');
  if (req.analysis.targets.length === 0) {
    lines.push('  （无）');
  } else {
    for (const t of req.analysis.targets) {
      const p = t.resolved || t.raw;
      const scopeTag =
        t.scope === 'drive-root' ? '  ⚠️ 磁盘根目录' :
        t.scope === 'workspace-root' ? '  ⚠️ 工作区根目录' :
        t.scope === 'workspace-parent' ? '  ⚠️ 工作区父目录' :
        t.scope === 'outside' ? '  ⚠️ 工作区外' :
        t.scope === 'unknown' ? '  ⚠️ 无法确定' :
        '';
      lines.push('  · ' + p + scopeTag);
    }
  }
  lines.push('');

  lines.push(buildList(req));
  lines.push('');

  if (req.analysis.reasons.length > 0) {
    lines.push('【风险说明】');
    for (const r of req.analysis.reasons) lines.push('  · ' + r);
    lines.push('');
  }

  lines.push('【说明】');
  if (req.allowExecute) {
    lines.push('点击「允许执行」将执行上述原始命令。');
    lines.push('点击「我自己删」不会执行任何命令，路径清单将返回给 AI。');
  } else {
    lines.push('本操作的影响范围无法完全确定，不提供「允许执行」。');
    lines.push('点击「我自己删」将取消本次命令，路径清单将返回给 AI。');
  }

  return lines.join('\n');
}

/**
 * 创建默认删除审批处理器。
 */
export function createDefaultDeleteApprovalHandler(): DeleteApprovalHandler {
  return {
    async requestApproval(req: DeleteApprovalRequest): Promise<DeleteApprovalDecision> {
      const { dialog, BrowserWindow } = require('electron');

      const wins = BrowserWindow.getAllWindows();
      const mainWin = wins.length > 0 ? wins[0] : null;
      const high = isHighRisk(req);

      const buttons = req.allowExecute
        ? ['允许执行', '我自己删 (默认)']
        : ['我自己删 (默认)'];
      const defaultId = buttons.length - 1;
      const cancelId = buttons.length - 1;

      const title = high ? '🚨 删除操作确认（高危）' : '🗑️ 删除操作确认';
      const message = req.analysis.hasUnresolved
        ? 'AI 请求执行删除操作，但目标无法确定。'
        : (high
            ? 'AI 请求执行会删除工作区外内容的操作。'
            : 'AI 请求执行以下删除操作。');

      let response = defaultId;
      try {
        const result = await dialog.showMessageBox(mainWin || undefined, {
          type: 'warning',
          title,
          message,
          detail: buildDetail(req),
          buttons,
          defaultId,
          cancelId,
          noLink: true,
        });
        response = result.response;
      } catch (_) {
        // 弹窗失败 → 保守，返回 manual（不执行）
        return 'manual';
      }

      // allowExecute=false 时只有「我自己删」一个按钮，response 必然是 0，
      // 不能按 index 判断 —— 一律 manual
      if (!req.allowExecute) return 'manual';
      // allowExecute=true 时按钮顺序是 ['允许执行', '我自己删']，index 0 = allow
      return response === 0 ? 'allow' : 'manual';
    },
  };
}
