import { createRequire } from 'node:module';
import type { McpLaunchSnapshot, McpLaunchDecision } from './launch-gate.js';

const require = createRequire(import.meta.url);

const SENSITIVE_RE = /TOKEN|API_KEY|PASSWORD|SECRET|AUTH|CREDENTIAL/i;

function formatEnv(userEnv?: Record<string, string>): string {
  const keys = userEnv ? Object.keys(userEnv).sort() : [];
  if (keys.length === 0) {
    return '  (未显式配置，将完全继承 Cuckoo 的环境变量)';
  }
  const lines: string[] = ['  【在 mcp.json 中显式配置的变量】'];
  for (const k of keys) {
    const isSensitive = SENSITIVE_RE.test(k);
    const v = isSensitive ? '[REDACTED]' : userEnv![k];
    lines.push('  ' + k + ' = ' + v);
  }
  lines.push('\n  (还会继承 Cuckoo 应用自身的系统环境变量)');
  return lines.join('\n');
}

const SOURCE_LABEL: Record<string, string> = {
  user: '用户级配置',
  project: '项目级配置',
  plugin: '插件自带配置',
};

export async function showDefaultMcpLaunchDialog(snapshot: McpLaunchSnapshot): Promise<McpLaunchDecision> {
  const sourceLabel = SOURCE_LABEL[snapshot.source] || snapshot.source;

  const detail = [
    '【服务器信息】',
    '名称：' + snapshot.name,
    '来源：' + sourceLabel,
    '',
    '【启动命令】',
    snapshot.command + ' ' + snapshot.args.join(' '),
    '',
    '【工作目录】',
    snapshot.cwd,
    '',
    '【环境变量】',
    formatEnv(snapshot.userEnv),
    '',
    '⚠️ 重要提示：',
    '允许启动意味着该本地程序将以当前用户身份运行，拥有与 Cuckoo 相同的文件、网络、注册表访问权限。',
    '本审批仅控制"是否启动"，不构成运行时的文件、网络或工具调用级别隔离。',
    'MCP 服务器后续的所有行为（包括它自己的工具调用）不在本次审批范围内。',
    '',
    '「此窗口内允许」仅在当前窗口有效；应用退出、窗口关闭或启动配置变化后授权失效。',
  ].join('\n');

  try {
    const { dialog, BrowserWindow } = require('electron');
    const wins = BrowserWindow.getAllWindows();
    const mainWin = wins.length > 0 ? wins[0] : null;
    if (mainWin) mainWin.setAlwaysOnTop(true);

    const { response } = await dialog.showMessageBox(mainWin || undefined, {
      type: 'warning',
      title: 'MCP 服务器启动审批',
      message: 'AI 请求启动本地 MCP 服务器：' + snapshot.name,
      detail,
      buttons: ['允许一次', '此窗口内允许', '拒绝 (默认)'],
      defaultId: 2,
      cancelId: 2,
    });

    if (mainWin) mainWin.setAlwaysOnTop(false);

    if (response === 0) return 'allow_once';
    if (response === 1) return 'allow_session';
    return 'deny';
  } catch (e: any) {
    console.error('[MCP Launch] 无法显示弹窗，安全兜底拒绝:', e.message || e);
    return 'deny';
  }
}
