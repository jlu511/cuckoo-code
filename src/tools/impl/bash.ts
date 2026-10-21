import { Tool } from '../core/Tool.js';
import type { ToolApiMeta } from '../core/Tool.js';
import { ToolResult } from '../core/ToolResult.js';
import { exec } from 'node:child_process';
import path from 'node:path';
import { decodeOutput, normalizeCommand } from '../../infra/decode-output.js';
import { isDangerous, DANGEROUS_CMDS } from '../../infra/dangerous-commands.js';
import { checkCommandPermission, checkPathPermission } from '../../infra/permission.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ========== D12：API 契约元数据（构建期生成 api.d.ts）==========
export const apiMetas: ToolApiMeta[] = [
  {
    order: 7,
    category: '命令执行',
    name: 'bash',
    types: [
      '/** bash 的选项 */',
      'interface BashOptions {',
      '  /** 命令用途说明（清晰、简洁、主动语态，5-10 词） */',
      '  description?: string;',
      '  /** 工作目录（相对路径基于项目根目录），默认项目根目录 */',
      '  workdir?: string;',
      '  /** 超时毫秒数，默认 30000 */',
      '  timeoutMs?: number;',
      '}',
    ].join('\n'),
    doc: [
      '执行 shell 命令（Windows 使用 cmd.exe）。',
      '返回纯文本：stdout + [stderr] 分节 + 状态标记（[exit code]、[timed out]）。',
      '必须用 log() 方法打印才能看到返回内容。',
      '非零退出不抛异常，通过 [exit code] 标记报告。',
      '危险命令会被安全策略拒绝并抛异常。',
    ].join('\n'),
    params: 'command: string, options?: BashOptions',
    returns: 'Promise<string>',
    paramDocs: {
      command: '要执行的 shell 命令',
      options: '可选，{ description?: string, workdir?: string, timeoutMs?: number }',
    },
    returnsDoc: '纯文本：stdout + [stderr] 分节 + 状态标记（[exit code]、[timed out]）',
    throws: '危险命令被安全策略拒绝时抛出异常',
  },
];

/**
 * JsRunner 沙箱注入：定义 globalThis.bash。
 * 源码经 scripts/build-tool-api.mjs 提取（.toString()），组装进 JsRunner 的 BOOTSTRAP。
 * 必须在沙箱内自包含（只能引用 __call）。
 */
export function bootstrap(__call: any): void {
  (globalThis as any).bash = async function (command: any, options: any) {
    options = options || {};
    return await __call('bash', {
      command: command,
      description: options.description,
      workdir: options.workdir || options.cwd,
      timeoutMs: options.timeoutMs || options.timeout,
    });
  };
}

/**
 * Bash 执行工具 - 最小移植 dsh 风格。
 * 非零退出正常返回，附 [exit code] 标记；输出纯文本。
 */
class BashTool extends Tool {
  constructor() {
    super(
      'bash', '执行 bash 命令。非零退出以 [exit code] 标记返回，不视为错误。',
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 shell 命令'
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
      'bash(command, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:bash',
      order: 105,
      text: '执行 bash 命令并返回 stdout/stderr。每次调用在全新 shell 中运行：状态（cwd、变量、函数）不会跨调用保留——请用 workdir 参数而非 cd。非零退出以 [exit code: N] 标记报告。长输出会截断为尾部。'
    };
  }

  async execute(params: any): Promise<ToolResult> {
    const { command, description, workdir, timeoutMs, projectDir } = params;

    try {
      if (!command || typeof command !== 'string') {
        return ToolResult.error('invalid command: expected a non-empty string');
      }

      const trimmed = normalizeCommand(command.trim());
      if (!trimmed) {
        return ToolResult.error('invalid command: expected a non-empty string');
      }

      // 权限模式检查：只读模式下直接禁用 bash
      const perm = checkCommandPermission(trimmed);
      if (!perm.allow) return ToolResult.error(perm.reason!);

      // 危险命令检查（原一票否决，现合并到高危红框判定中）
      const isBaseDangerous = isDangerous(trimmed);

      if (!description || typeof description !== 'string' || description.trim() === '') {
        return ToolResult.error('安全拒绝：执行命令前必须提供清晰的 description 说明其用途。');
      }

      // ====== 1. 危险等级判定 ======
      // 破坏性命令：只要包含这些词，无论有没有盘符，都是高危
      // 破坏性命令：严格匹配参数（防止 git log --format 或 Format-Table 误报）
      const destructivePatterns = [
        /\b(rm\s+-[a-z]*[rf]|del\s+\/[a-z]*[fsq]|rd\s+\/[a-z]*s|rmdir\s+\/[a-z]*s)\b/i,
        /\bformat\s+[a-z]:/i,
        /\bmkfs\b/i,
        /\bdd\s+if=/i,
        /\bRemove-Item\b.*-Recurse/i
      ];
      // 重定向到盘符根目录
      const rootRedirectPattern = />\s*[A-Z]:\\?(\s|"|'|$|\*)/i;
      
      const isDestructive = destructivePatterns.some(p => p.test(trimmed));
      const isRootRedirect = rootRedirectPattern.test(trimmed);
      const isHighRisk = isBaseDangerous || isDestructive || isRootRedirect;

      // 剥离 powershell / cmd 外壳
      let innerCmd = trimmed;
      const pwshMatch = innerCmd.match(/^(?:powershell|pwsh)(?:\.exe)?\s+.*?-Command\s+["']?(.*?)["']?$/i);
      if (pwshMatch) innerCmd = pwshMatch[1];
      const cmdMatch = innerCmd.match(/^cmd(?:\.exe)?\s+\/[cC]\s+["']?(.*?)["']?$/i);
      if (cmdMatch) innerCmd = cmdMatch[1];

      // 危险特征拦截：只要包含写操作特征，绝不视为只读
      const writeIndicators = /(?:>|\bOut-File\b|\bSet-Content\b|\bAdd-Content\b|\bNew-Item\b|\bRemove-Item\b|\bmkdir\b|\bmd\b|\brmdir\b|\brd\b|\bcp\b|\bcopy\b|\bmv\b|\bmove\b|\bdel\b|\brm\b)/i;
      const hasWrite = writeIndicators.test(innerCmd);

      // 只读白名单
      const readonlyPrefixes = [
        /^cd\b/i, /^pwd\b/i, /^dir\b/i, /^ls\b/i, /^type\b/i, /^cat\b/i,
        /^echo\b/i, /^where\b/i, /^which\b/i, /^git status\b/i, /^git log\b/i,
        /^git diff\b/i, /^git branch\b/i, /^node -v\b/i, /^npm -v\b/i,
        /^Get-[a-z]+/i, /^Test-Path\b/i, /^Select-Object\b/i, /^Format-Table\b/i, /^Measure-Object\b/i,
        /^\$[a-zA-Z_]\w*\s*=/i
      ];
      const isReadonly = !hasWrite && readonlyPrefixes.some(p => p.test(innerCmd));

      let needConfirm = true;
      let warnText = 'AI 请求执行普通系统命令，是否允许？';

      if (isHighRisk) {
        needConfirm = true;
        warnText = '🚨 极度危险！检测到可能破坏数据的操作（如删除、格式化或直接写入盘符根目录）。一旦执行，可能导致数据永久丢失！';
      } else if (isReadonly) {
        needConfirm = false; // 只读命令直接放行
      }

      if (needConfirm) {
        try {
          const { dialog, BrowserWindow } = require('electron');
          const wins = BrowserWindow.getAllWindows();
          const mainWin = wins.length > 0 ? wins[0] : null;
          if (mainWin) { mainWin.setAlwaysOnTop(true); mainWin.focus(); }
          const { response } = await dialog.showMessageBox(mainWin || undefined, {
            type: isHighRisk ? 'error' : 'warning',
            title: isHighRisk ? '🚨 高危操作拦截' : '执行系统命令确认',
            message: 'AI 请求执行以下命令，是否允许？',
            detail: '【AI 的用途说明】\n' + description + '\n\n【完整命令内容】\n' + trimmed + '\n\n【安全分析】\n' + warnText,
            buttons: ['允许执行', '拒绝 (默认)'],
            defaultId: 1,
            cancelId: 1
          });
          if (mainWin) { mainWin.setAlwaysOnTop(false); }
          if (response === 1) {
            return ToolResult.error('用户拒绝了此命令的执行。');
          }
        } catch (e: any) {
          console.error('弹窗组件加载失败:', e);
          if (isHighRisk) {
            return ToolResult.error('命令被安全策略拒绝（危险命令）: ' + trimmed);
          }
          return ToolResult.error('安全机制异常，已默认拒绝执行。' + (e.message || e));
        }
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

      console.log('[BashTool] 执行命令: ' + trimmed + ', cwd=' + workDir);

      return await new Promise<ToolResult>((resolve) => {
        exec(
          trimmed,
          { cwd: workDir, timeout, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'buffer' },
          (error, stdout, stderr) => {
            const out = decodeOutput(stdout);
            const err = decodeOutput(stderr);

            // dsh 风格渲染
            let body = out;
            if (err && err.length > 0) {
              if (body.length > 0 && !body.endsWith('\n')) body += '\n';
              body += '[stderr]\n' + err;
            }
            if (body.length === 0) body = '(no output)';

            const markers: string[] = [];
            if (error) {
              if ((error as any).killed) {
                markers.push('[timed out after ' + timeout + 'ms]');
              } else if (typeof (error as any).code === 'number') {
                markers.push('[exit code: ' + (error as any).code + ']');
              } else {
                markers.push('[exit code: 1]');
              }
            }

            if (markers.length > 0) {
              if (!body.endsWith('\n')) body += '\n';
              body += markers.join('\n');
            }

            resolve(ToolResult.success(body));
          }
        );
      });
    } catch (err: any) {
      return ToolResult.error('命令执行异常: ' + err.message);
    }
  }
}

export { BashTool, DANGEROUS_CMDS };
