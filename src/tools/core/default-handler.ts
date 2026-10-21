import { createRequire } from 'node:module';
import type { ApprovalHandler, ApprovalDTO, ApprovalDecision } from './executor.js';

const require = createRequire(import.meta.url);

/**
 * 敏感环境变量键名匹配（仅用于审批 UI 的展示脱敏）。
 */
const SENSITIVE_ENV_RE = /TOKEN|API_KEY|PASSWORD|SECRET|AUTH|CREDENTIAL/i;

/**
 * 高影响环境变量：即使值被隐藏，也必须显式提示，因为它们会改变子进程的执行行为。
 */
const IMPACTFUL_ENV = new Set(['PATH', 'PATHEXT', 'NODE_OPTIONS', 'PYTHONPATH', 'COMSPEC', 'SYSTEMROOT', 'WINDIR']);

/**
 * 将请求 env 格式化为可读的多行文本。
 * - 显式展示变量名和"将要覆盖"（因为 Shell/Process 请求的 env 会 merge 到 process.env）。
 * - 敏感键值以 [REDACTED] 替代。
 * - 高影响键额外加 ⚠️ 标记。
 */
function formatEnvSection(env: Record<string, string> | undefined): string {
  if (!env || Object.keys(env).length === 0) return '';
  const lines: string[] = ['', '【环境变量（将覆盖同名系统变量）】'];
  for (const key of Object.keys(env)) {
    const isSensitive = SENSITIVE_ENV_RE.test(key);
    const isImpactful = IMPACTFUL_ENV.has(key.toUpperCase());
    const value = isSensitive ? '[REDACTED]' : (env[key] || '');
    const tag = isImpactful ? ' ⚠️高影响' : '';
    lines.push('  ' + key + ' = ' + value + tag);
  }
  return lines.join('\n');
}

export class DefaultApprovalHandler implements ApprovalHandler {
  async requestApproval(dto: ApprovalDTO): Promise<ApprovalDecision> {
    const req = dto.request;
    const cmdStr = req.type === 'shell' ? req.rawCommand : req.executable + ' ' + req.args.join(' ');
    const isHighRisk = /(?:rm|del|rd|format|mkfs|git\s+clean|git\s+reset)/i.test(cmdStr);

    const envSection = formatEnvSection(req.env);
    const detail =
      '【用途说明】\n' + (req.description || '(未提供)') +
      '\n\n【执行目录】\n' + req.cwd +
      '\n\n【完整命令】\n' + cmdStr +
      envSection +
      '\n\n【安全提示】\n本功能仅提供审批控制。一旦允许，进程将拥有完整系统权限。';

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
        detail,
        buttons: ['允许执行', '拒绝 (默认)'],
        defaultId: 1,
        cancelId: 1,
      });

      if (mainWin) {
        mainWin.setAlwaysOnTop(false);
      }

      return response === 0 ? 'allow_once' : 'deny';
    } catch (e: any) {
      // 无 Electron 环境（如测试）下安全兜底：直接拒绝
      console.error('[Sandbox] 无法加载弹窗，出于安全考虑已自动拒绝:', e.message || e);
      return 'deny';
    }
  }
}
