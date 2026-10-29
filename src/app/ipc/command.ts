/**
 * IPC：执行 shell 命令（含危险命令确认）
 */
import { exec } from 'node:child_process';
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { isDangerous } from '../../infra/dangerous-commands.js';
import { decodeOutput, normalizeCommand } from '../../infra/decode-output.js';
import { guardDelete } from '../../tools/core/delete-guard.js';

const require = createRequire(import.meta.url);
const { app, dialog, ipcMain } = require('electron');

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

    // 删除保护编排：上游 isDangerous 只加了警告文字，此处补充越界删除的阻断审批
    const effectiveCwd = selectedDir || process.env.USERPROFILE || app.getPath('home');
    const guard = await guardDelete(trimmed, effectiveCwd, selectedDir || null, 'cmd');
    if (guard.action === 'reject') {
      return { id, success: false, error: guard.text };
    }
    if (guard.action === 'manual') {
      return { id, success: false, error: guard.text, manual: true };
    }

    const dangerWarning = isDangerous(trimmed) ? '\n\n⚠️ 警告：此命令可能存在风险，请谨慎确认！' : '';
    const result = await dialog.showMessageBox(win, {
      type: isDangerous(trimmed) ? 'warning' : 'question',
      buttons: ['取消', '确认执行'],
      defaultId: 0,
      cancelId: 0,
      title: '确认执行命令',
      message: '将执行以下命令：',
      detail: trimmed + dangerWarning,
    });
    if (result.response !== 1) {
      return { id, success: false, error: '用户取消了执行', canceled: true };
    }
    return new Promise((resolve) => {
      const child = exec(
        trimmed,
        {
          cwd: selectedDir || process.env.USERPROFILE || app.getPath('home'),
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
