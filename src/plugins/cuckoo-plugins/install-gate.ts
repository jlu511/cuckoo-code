/**
 * 插件安装（npm install）审批网关。
 *
 * ⚠️ 边界声明：
 * 本模块仅控制"是否执行 npm install 下载第三方包"，不是 OS 级沙箱。
 * 批准后 npm 以当前用户身份运行，可访问文件、网络。
 * 插件运行时的行为不在本审批范围内。
 */

import crypto from 'node:crypto';

export interface PluginInstallSnapshot {
  /** 快照 ID（日志关联用） */
  id: string;
  /** 发起安装的窗口 */
  windowId: number;
  /** 用户输入的 npm 包名（原始值） */
  packageName: string;
  /** 转换后的插件 id */
  pluginId: string;
  /** 目标安装目录（绝对路径） */
  installDir: string;
  /** 实际执行的命令 */
  command: string;
  /** 实际参数列表 */
  args: string[];
  /** 工作目录 */
  cwd: string;
  /** 超时毫秒数 */
  timeoutMs: number;
  /** 创建时间 */
  createdAt: number;
}

export type PluginInstallDecision = 'allow' | 'deny';

export interface PluginInstallGate {
  /**
   * 检查是否允许执行安装。
   * 实现必须保证 fail closed：异常/超时/缺失都视为拒绝。
   */
  check(snapshot: PluginInstallSnapshot): Promise<PluginInstallDecision>;
}

/**
 * 构造安装快照（不可变）。
 * 审批展示与执行必须引用同一份快照，防止"批准 A、执行 B"。
 */
export function buildInstallSnapshot(params: {
  windowId: number;
  packageName: string;
  pluginId: string;
  installDir: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): PluginInstallSnapshot {
  return Object.freeze({
    id: crypto.randomUUID(),
    windowId: params.windowId,
    packageName: params.packageName,
    pluginId: params.pluginId,
    installDir: params.installDir,
    command: params.command,
    args: Object.freeze([...params.args]) as unknown as string[],
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    createdAt: Date.now(),
  }) as PluginInstallSnapshot;
}
