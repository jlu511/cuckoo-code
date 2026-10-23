/**
 * 敏感路径授权弹窗的默认实现（Electron dialog）。
 *
 * 与 DefaultApprovalHandler 同级：都在 tools/core，通过 createRequire 延迟
 * 加载 electron，避免纯 Node 环境（测试）下崩溃。
 *
 * 与命令行 L3 审批一致性：
 *  - 红框（type: 'error'）
 *  - 展示目标路径、操作类型、命中类别
 *  - fail-closed（无 Electron / 异常 / 超时 → 拒绝）
 */
import { createRequire } from 'node:module';
import type { SensitivePathHandler, SensitiveOperation } from './sensitive-guard.js';

const require = createRequire(import.meta.url);

const OPERATION_LABEL: Record<SensitiveOperation, string> = {
  read: '读取',
  write: '修改',
  delete: '删除',
};

/**
 * 创建默认的敏感路径授权处理器（Electron 弹窗）。
 * 返回的函数签名符合 SensitivePathHandler。
 */
export function createDefaultSensitivePathHandler(
  approvalTimeoutMs = 120_000
): SensitivePathHandler {
  return async (
    absPath: string,
    operation: SensitiveOperation,
    matchedReasons: string[]
  ): Promise<{ allow: boolean; reason?: string }> => {
    const action = OPERATION_LABEL[operation] || operation;

    const detail = [
      '【目标路径】',
      absPath,
      '',
      '【操作类型】',
      action,
      '',
      '【敏感类别】',
      matchedReasons.length > 0
        ? matchedReasons.map((r) => '  · ' + r).join('\n')
        : '  · 敏感路径',
      '',
      '⚠️ 重要提示：',
      '该文件可能包含私钥、令牌或凭据。允许访问后，内容可能被发送到 AI 服务或写入日志。',
      '本次授权仅对当前这一次操作有效，不会记住你的选择。',
      '拒绝后本次操作不会执行。',
    ].join('\n');

    try {
      const { dialog, BrowserWindow } = require('electron');
      const wins = BrowserWindow.getAllWindows();
      const mainWin = wins.length > 0 ? wins[0] : null;

      // 与 default-handler 一致：不强制置顶/focus，避免与 WebContentsView 抢焦点
      const result = await Promise.race([
        dialog.showMessageBox(mainWin || undefined, {
          type: 'error',
          title: '🔐 敏感路径访问',
          message: 'AI 请求' + action + '敏感文件，是否允许？',
          detail,
          buttons: ['允许本次' + action, '拒绝 (默认)'],
          defaultId: 1,
          cancelId: 1,
        }),
        new Promise<{ response: number }>((resolve) =>
          setTimeout(() => resolve({ response: 1 }), approvalTimeoutMs).unref()
        ),
      ]);

      if (result.response === 0) {
        return { allow: true };
      }
      return {
        allow: false,
        reason: '用户拒绝' + action + '敏感文件：' + absPath,
      };
    } catch (e: any) {
      console.error('[SensitivePath] 无法显示弹窗，安全兜底拒绝:', e?.message || e);
      return {
        allow: false,
        reason:
          '敏感路径' + action + '需要明确授权，但授权窗口加载失败（已拒绝）：' + absPath,
      };
    }
  };
}
