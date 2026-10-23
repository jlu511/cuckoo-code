/**
 * IPC：执行 shell 命令（含安全预检与危险命令确认）
 *
 * 安全边界：
 *  - 与 SandboxExecutor 共用同一套预检（敏感路径 + CC Safety Net）
 *  - CC Safety Net 的 deny / 异常是硬性否决，不可被用户确认覆盖
 *  - 敏感路径命中时显示 L3 红框；CCSN 同时拒绝时只提供"我知道了"
 */
import { exec } from 'node:child_process';
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { isDangerous } from '../../infra/dangerous-commands.js';
import { decodeOutput, normalizeCommand } from '../../infra/decode-output.js';
import { runSafetyPrecheck } from '../../tools/core/safety-precheck.js';
import { checkCommandPermission } from '../../infra/permission.js';
import type { ShellRequest } from '../../tools/core/executor.js';

const require = createRequire(import.meta.url);
const { app, dialog, ipcMain } = require('electron');

function buildShellRequest(rawCommand: string, cwd: string): ShellRequest {
  return {
    type: 'shell',
    shellType: 'cmd',
    rawCommand,
    cwd,
    env: {},
  };
}

function registerCommandIpc(): void {
  ipcMain.handle('execute-command', async (event: any, { command, id }: any) => {
    if (!command || typeof command !== 'string') {
      return { id, success: false, error: '无效的命令' };
    }
    const trimmed = normalizeCommand(command.trim());
    if (!trimmed) return { id, success: false, error: '命令为空' };

    const ctx = windowState.getContextByWebContents(event.sender);
    const win = ctx ? ctx.win : windowState.getMainWindow();
    const store = ctx ? ctx.sessionStore : null;
    const selectedDir = store ? store.state.selectedProjectDir : null;
    const cwd = selectedDir || process.env.USERPROFILE || app.getPath('home');

    // ===== 1. 访问模式权限检查（只读模式禁止一切命令执行）=====
    // 必须最先执行，且不因拒绝而回退到下方普通确认弹窗
    let perm;
    try {
      perm = checkCommandPermission(trimmed);
    } catch (err: any) {
      perm = { allow: false, reason: '权限检查异常，已拒绝执行：' + ((err && err.message) || String(err)) };
    }
    if (!perm.allow) {
      await dialog.showMessageBox(win, {
        type: 'error',
        title: '🔒 当前访问模式禁止执行命令',
        message: '该命令不允许执行。',
        detail:
          '【完整命令】\n' + trimmed +
          '\n\n【执行目录】\n' + cwd +
          '\n\n【拒绝原因】\n' + (perm.reason || '当前访问模式不允许执行命令。') +
          '\n\n【说明】\n只读模式下不允许执行任何系统命令。',
        buttons: ['我知道了'],
        defaultId: 0,
        cancelId: 0,
      });
      return { id, success: false, error: '安全策略拒绝：' + (perm.reason || '当前访问模式不允许执行命令'), blocked: true };
    }

    // ===== 2. 安全预检（与 SandboxExecutor 共用）=====
    const precheck = await runSafetyPrecheck(buildShellRequest(trimmed, cwd));

    if (precheck.blocked) {
      const sensitiveHit = precheck.sensitive.hit;
      const sensitiveSection = sensitiveHit
        ? '\n\n【敏感路径】\n' + precheck.sensitive.targets.map((t) => '  · ' + t).join('\n') +
          (precheck.sensitive.reasons.length
            ? '\n\n【敏感类别】\n' + precheck.sensitive.reasons.map((r) => '  · ' + r).join('\n')
            : '')
        : '';

      await dialog.showMessageBox(win, {
        type: 'error',
        title: sensitiveHit ? '🔐 敏感路径访问已被阻断' : '🛑 命令已被安全策略阻断',
        message: '该命令不允许执行。',
        detail:
          '【完整命令】\n' + trimmed +
          '\n\n【执行目录】\n' + cwd +
          sensitiveSection +
          '\n\n【阻断原因】\n' + (precheck.blockReason || '安全预检拒绝执行。') +
          '\n\n【规则】\n' + (precheck.blockRuleId || 'cuckoo.precheck') +
          '\n\n【说明】\n该命令被安全策略硬性拒绝，此提示不提供放行选项。',
        buttons: ['我知道了'],
        defaultId: 0,
        cancelId: 0,
      });
      return { id, success: false, error: '安全策略拒绝：' + (precheck.blockReason || '预检阻断'), blocked: true };
    }

    // ===== 3. 原有确认流程 =====
    const dangerWarning = isDangerous(trimmed) ? '\n\n⚠️ 警告：此命令可能存在风险，请谨慎确认！' : '';
    const sensitiveWarning = precheck.sensitive.hit
      ? '\n\n🔐 该命令涉及敏感路径：\n' + precheck.sensitive.targets.map((t) => '  · ' + t).join('\n')
      : '';

    const result = await dialog.showMessageBox(win, {
      type: (precheck.sensitive.hit || isDangerous(trimmed)) ? 'warning' : 'question',
      buttons: ['取消', '确认执行'],
      defaultId: 0,
      cancelId: 0,
      title: precheck.sensitive.hit ? '🔐 敏感路径访问' : '确认执行命令',
      message: precheck.sensitive.hit ? 'AI 请求访问敏感路径，是否允许？' : '将执行以下命令：',
      detail: trimmed + sensitiveWarning + dangerWarning,
    });
    if (result.response !== 1) {
      return { id, success: false, error: '用户取消了执行', canceled: true };
    }

    // ===== 4. 执行（与原有行为一致）=====
    return new Promise((resolve) => {
      const child = exec(
        trimmed,
        {
          cwd,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          encoding: 'buffer',
        },
        (error: any, stdout: any, stderr: any) => {
          resolve({
            id,
            success: !error,
            stdout: decodeOutput(stdout),
            stderr: decodeOutput(stderr),
            error: error ? error.message : null,
          });
        }
      );
    });
  });
}

export { registerCommandIpc };
