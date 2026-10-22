import { createRequire } from 'node:module';
import type { PluginInstallSnapshot, PluginInstallDecision, PluginInstallGate } from './install-gate.js';

const require = createRequire(import.meta.url);

export class DefaultPluginInstallGate implements PluginInstallGate {
  constructor(private approvalTimeoutMs = 120_000) {}

  async check(snapshot: PluginInstallSnapshot): Promise<PluginInstallDecision> {
    // fail closed：windowId 必须有效
    if (!snapshot.windowId || typeof snapshot.windowId !== 'number') {
      throw new Error('拒绝安装插件：缺少可信的窗口 ID');
    }

    let decision: PluginInstallDecision;
    try {
      decision = await Promise.race([
        this.showDialog(snapshot),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('安装审批超时')), this.approvalTimeoutMs).unref()
        ),
      ]);
    } catch (err: any) {
      throw new Error('拒绝安装插件：' + (err.message || '审批失败'));
    }

    if (decision !== 'allow' && decision !== 'deny') {
      throw new Error('拒绝安装插件：审批返回了非法决策值（' + String(decision) + '）');
    }
    return decision;
  }

  private async showDialog(snapshot: PluginInstallSnapshot): Promise<PluginInstallDecision> {
    const detail = [
      '【插件包信息】',
      'npm 包名：' + snapshot.packageName,
      '插件 ID：' + snapshot.pluginId,
      '安装目录：' + snapshot.installDir,
      '',
      '【将执行的命令】',
      snapshot.command + ' ' + snapshot.args.join(' '),
      '',
      '【工作目录】',
      snapshot.cwd,
      '',
      '⚠️ 重要提示：',
      '此操作将从 npm registry 下载第三方代码到本机，并在安装完成后自动加载执行。',
      'npm install 期间会访问网络；安装脚本（postinstall 等）会以当前用户身份执行。',
      '本审批仅控制"是否执行安装"，不构成插件运行时的安全隔离。',
      '只安装你信任来源的插件包。',
    ].join('\n');

    try {
      const { dialog, BrowserWindow } = require('electron');
      const wins = BrowserWindow.getAllWindows();
      const mainWin = wins.length > 0 ? wins[0] : null;

      const { response } = await dialog.showMessageBox(mainWin || undefined, {
        type: 'warning',
        title: '插件安装审批',
        message: 'AI 请求从 npm 安装插件：' + snapshot.packageName,
        detail,
        buttons: ['允许安装', '拒绝 (默认)'],
        defaultId: 1,
        cancelId: 1,
      });

      return response === 0 ? 'allow' : 'deny';
    } catch (e: any) {
      console.error('[Plugin Install] 无法显示弹窗，安全兜底拒绝:', e.message || e);
      return 'deny';
    }
  }
}
