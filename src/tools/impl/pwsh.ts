import { Tool } from '../core/Tool.js';
import type { ToolApiMeta } from '../core/Tool.js';
import { ToolResult } from '../core/ToolResult.js';
import path from 'node:path';
import { DANGEROUS_CMDS } from '../../infra/dangerous-commands.js';
import { getSandboxExecutor, type ProcessRequest } from '../core/executor.js';

// ========== D12：API 契约元数据（构建期生成 api.d.ts）==========
export const apiMetas: ToolApiMeta[] = [
  {
    order: 8,
    category: '命令执行',
    name: 'pwsh',
    types: [
      '/** pwsh 的选项 */',
      'interface PwshOptions {',
      '  /** 命令用途说明（清晰、简洁、主动语态，5-10 词） */',
      '  description?: string;',
      '  /** 工作目录（相对路径基于项目根目录），默认项目根目录 */',
      '  workdir?: string;',
      '  /** 超时毫秒数，默认 30000 */',
      '  timeoutMs?: number;',
      '}',
    ].join('\n'),
    doc: [
      '执行 PowerShell 命令（powershell -NoProfile -Command）。',
      '返回纯文本：stdout + [stderr] 分节 + 状态标记（[exit code]、[timed out]）。',
      '必须用 log() 方法打印才能看到返回内容。',
      '非零退出不抛异常，通过 [exit code] 标记报告。',
      '危险命令会被安全策略拒绝并抛异常。',
    ].join('\n'),
    params: 'command: string, options?: PwshOptions',
    returns: 'Promise<string>',
    paramDocs: {
      command: '要执行的 PowerShell 命令',
      options: '可选，{ description?: string, workdir?: string, timeoutMs?: number }',
    },
    returnsDoc: '纯文本：stdout + [stderr] 分节 + 状态标记（[exit code]、[timed out]）',
    throws: '危险命令被安全策略拒绝时抛出异常',
  },
];

// 危险命令列表统一由 infra/dangerous-commands 提供（含 PowerShell 特有项）。
// 保留本别名仅为向后兼容既有引用；请勿在此另立一份列表。
const DANGEROUS_PWSH_CMDS = DANGEROUS_CMDS;

/**
 * pwsh 执行工具 - 仿照 dsh 的 pwsh 最小移植。
 * 使用 powershell -NoProfile -Command 执行命令。
 * 非零退出正常返回，附 [exit code] 标记；输出纯文本。
 *
 * Phase 1.2b：统一接入 SandboxExecutor（审批 + 会话校验）。
 */
class PwshTool extends Tool {
  constructor() {
    super(
      'pwsh',
      '执行 PowerShell 命令（powershell -NoProfile -Command）。非零退出以 [exit code] 标记返回，不视为错误。',
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 PowerShell 命令'
          },
          description: {
            type: 'string',
            description: '命令用途说明'
          },
          workdir: {
            type: 'string',
            description: '工作目录（相对路径基于项目根目录），默认项目根目录'
          },
          timeoutMs: {
            type: 'number',
            description: '超时毫秒数，默认 30000',
            default: 30000
          }
        },
        required: ['command', 'description'],
        additionalProperties: false
      },
      'pwsh(command, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:pwsh',
      order: 106,
      text: '执行 PowerShell 命令（powershell -NoProfile -Command）并返回 stdout/stderr。每次调用在全新 pwsh 进程中运行：状态不会跨调用保留——请用 workdir 参数而非 cd。路径使用 Windows 原生形式（C:\\...）；用 $env:NAME 读取环境变量。非零退出以 [exit code: N] 标记报告。'
    };
  }

  async execute(params: any): Promise<ToolResult> {
    const { command, description, workdir, timeoutMs, projectDir, activeSessionId, sessionResolver, sessionGenerationProvider, sessionScopeId, currentWindowId } = params;

    try {
      if (!command || typeof command !== 'string') {
        return ToolResult.error('invalid command: expected a non-empty string');
      }

      const trimmed = command.trim();
      if (!trimmed) {
        return ToolResult.error('invalid command: expected a non-empty string');
      }

      if (!description || typeof description !== 'string' || description.trim() === '') {
        return ToolResult.error('安全拒绝：执行命令前必须提供清晰的 description 说明其用途。');
      }

      // 确定工作目录
      let workDir: string;
      if (workdir) {
        const normalized = workdir.replace(/\//g, path.sep);
        workDir = path.isAbsolute(normalized)
          ? normalized
          : (projectDir ? path.join(projectDir, normalized) : path.resolve(normalized));
      } else if (projectDir) {
        workDir = projectDir;
      } else {
        workDir = process.env.USERPROFILE || process.env.HOME || 'C:\\';
      }

      const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30000;

      // 安全检查：必须同时拿到可信的会话 ID 和实时解析器，否则拒绝
      if (!activeSessionId || typeof activeSessionId !== 'string' || activeSessionId.trim() === '') {
        return ToolResult.error('安全策略拒绝：缺少有效的会话 ID，无法执行命令。');
      }
      if (typeof sessionResolver !== 'function') {
        return ToolResult.error('安全策略拒绝：缺少会话解析器，无法校验活动会话。');
      }

      // 构造 ProcessRequest：保持 execFile('powershell', ['-NoProfile', '-Command', trimmed]) 语义
      const req: ProcessRequest = {
        type: 'process',
        executable: 'powershell',
        args: ['-NoProfile', '-Command', trimmed],
        cwd: workDir,
        env: {},
        timeoutMs: timeout,
        description: description.trim(),
      };

      const executor = getSandboxExecutor();
      // 需求 032：provider 可选；缺失时执行器会禁用会话授权（fail-closed）
      const result = await executor.execute(
        req,
        activeSessionId,
        activeSessionId,
        sessionResolver,
        typeof sessionGenerationProvider === 'function' ? sessionGenerationProvider : undefined,
        typeof sessionScopeId === 'string' ? sessionScopeId : undefined,
        typeof currentWindowId === 'number' ? currentWindowId : undefined
      );

      // 渲染结果（与 bash.ts 保持一致）
      let body = result.stdout;
      if (result.stderr && result.stderr.length > 0) {
        if (body.length > 0 && !body.endsWith('\n')) body += '\n';
        body += '[stderr]\n' + result.stderr;
      }
      if (body.length === 0) body = '(no output)';

      const markers: string[] = [];
      if (result.isCancelled) {
        markers.push('[cancelled]');
      } else if (result.isTimeout) {
        markers.push('[timed out after ' + timeout + 'ms]');
      } else if (result.exitCode !== 0) {
        markers.push('[exit code: ' + result.exitCode + ']');
      }

      if (markers.length > 0) {
        if (!body.endsWith('\n')) body += '\n';
        body += markers.join('\n');
      }

      return ToolResult.success(body);
    } catch (err: any) {
      return ToolResult.error('命令执行异常: ' + err.message);
    }
  }
}

/** JsRunner 沙箱注入：定义 globalThis.pwsh。 */
export function bootstrap(__call: any): void {
  (globalThis as any).pwsh = async function (command: any, options: any) {
    options = options || {};
    return await __call('pwsh', {
      command: command,
      description: options.description,
      workdir: options.workdir || options.cwd,
      timeoutMs: options.timeoutMs || options.timeout,
    });
  };
}

export { PwshTool, DANGEROUS_PWSH_CMDS };
