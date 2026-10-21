import { createRequire } from 'node:module';
import type { ApprovalHandler, ApprovalDTO, ApprovalDecision } from './executor.js';

const require = createRequire(import.meta.url);

export class DefaultApprovalHandler implements ApprovalHandler {
  async requestApproval(dto: ApprovalDTO): Promise<ApprovalDecision> {
    // 判断是否包含危险特征，决定弹窗颜色
    const req = dto.request;
    const cmdStr = req.type === 'shell' ? req.rawCommand : req.executable + ' ' + req.args.join(' ');
    const isHighRisk = /(?:rm|del|rd|format|mkfs|git\s+clean|git\s+reset)/i.test(cmdStr);

    try {
      const { dialog, BrowserWindow } = require('electron');
      const wins = BrowserWindow.getAllWindows();
      const mainWin = wins.length > 0 ? wins[0] : null;
      
      if (mainWin) {
        mainWin.setAlwaysOnTop(true);
        mainWin.focus();
      }

      const { response } = await dialog.showMessageBox(mainWin || undefined, {
        type: isHighRisk ? 'error' : 'warning',
        title: isHighRisk ? '🚨 高危操作拦截' : '执行系统命令确认',
        message: 'AI 请求执行以下命令，是否允许？',
        detail: '【用途说明】\n' + (req.description || '(未提供)') + '\n\n【执行目录】\n' + req.cwd + '\n\n【完整命令】\n' + cmdStr + '\n\n【安全提示】\n本功能仅提供审批控制。一旦允许，进程将拥有完整系统权限。',
        buttons: ['允许执行', '拒绝 (默认)'],
        defaultId: 1,
        cancelId: 1
      });

      if (mainWin) {
        mainWin.setAlwaysOnTop(false);
      }

      return response === 0 ? 'allow_once' : 'deny';
    } catch (e: any) {
      // 在无 Electron 环境（如测试）下，安全兜底：直接拒绝
      console.error('[Sandbox] 无法加载弹窗，出于安全考虑已自动拒绝:', e.message || e);
      return 'deny';
    }
  }
}
