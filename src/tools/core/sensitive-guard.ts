/**
 * 敏感路径命令分析（tools 层）。
 *
 * 职责：从 shell 命令文本中提取可能的文件读取目标，调用 infra 层的
 * classifySensitivePath 判定。命中时由 executor 升级为 L3（红框明确授权）。
 *
 * ⚠️ 边界：
 *  - 只做静态文本分析，无法识别运行时拼接、变量展开、脚本内部访问
 *  - 无法可靠解析的命令不阻断，但也不允许进入 L0
 */
import path from 'node:path';
import type { ExecRequest } from './executor.js';
import { classifySensitivePath, getUserHomeDir } from '../../infra/sensitive-paths.js';

export interface SensitiveAccessResult {
  /** 是否检测到敏感路径访问 */
  hit: boolean;
  /** 命中的绝对路径 */
  targets: string[];
  /** 命中类别说明（去重） */
  reasons: string[];
}

/**
 * 命令分类：
 *  - ALL_OPERANDS_ARE_PATHS：所有非选项操作数都是路径（type/cat/copy/del...）
 *  - FIRST_OPERAND_IS_PATTERN：第一个非选项是搜索模式，之后才是路径（findstr/grep）
 */
const ALL_OPERANDS_ARE_PATHS = new Set([
  // 读取
  'type', 'more', 'cat', 'head', 'tail', 'less',
  'dir', 'ls',
  'get-content', 'get-item', 'get-childitem', 'get-itemproperty',
  'select-string',
  // 复制 / 移动（源和目标都要检查）
  'copy', 'xcopy', 'robocopy', 'move',
  // 删除（目标必须检查）
  'del', 'erase', 'rm', 'remove-item', 'rmdir', 'rd',
]);

const FIRST_OPERAND_IS_PATTERN = new Set(['findstr', 'grep']);

/** 识别 -Path:xxx / -Path=xxx / -LiteralPath:xxx 等形式的路径参数 */
const PATH_PARAM_RE = /^-(?:path|literalpath|filepath|source|destination|src|dest)[:=](.+)$/i;

/**
 * 从一段命令中提取"可能的文件路径参数"。
 * 按命令语义分类，提取全部操作数（B1），并支持 -Path:xxx 连写形式（B6）。
 * 无法可靠解析时返回空数组（不阻断，由调用方决定 L2 审批）。
 */
function extractReadTargets(segment: string): string[] {
  // 分词（保留引号内的内容为一个 token）
  const tokens: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) { quote = null; } else { cur += ch; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);

  const targets: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const cmd = tokens[i].toLowerCase();
    const isAllPaths = ALL_OPERANDS_ARE_PATHS.has(cmd);
    const isPatternFirst = FIRST_OPERAND_IS_PATTERN.has(cmd);
    if (!isAllPaths && !isPatternFirst) continue;

    // 收集该命令之后的所有操作数（不再 break）
    const operands: string[] = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (!t) continue;

      // -Path:xxx 连写形式 → 直接取出冒号后的路径
      const pathParam = t.match(PATH_PARAM_RE);
      if (pathParam) {
        if (pathParam[1]) operands.push(pathParam[1]);
        continue;
      }

      // 其他选项（-Recurse / -Force / /b 等）跳过
      if (t.startsWith('-')) continue;
      if (t.startsWith('/') && t.length <= 3) continue;

      operands.push(t);
    }

    // findstr/grep：第一个操作数是搜索模式，跳过
    const candidates = isPatternFirst ? operands.slice(1) : operands;
    targets.push(...candidates);
  }

  return targets;
}

/**
 * 把候选路径解析为绝对路径。
 * 处理 ~ 展开、相对路径基于 cwd。
 */
function resolveTarget(target: string, cwd: string): string {
  let t = target;
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) {
    t = t.replace(/^~/, getUserHomeDir());
  }
  if (path.isAbsolute(t)) return path.resolve(t);
  return path.resolve(cwd, t);
}

/**
 * 分析一个 ExecRequest 是否可能访问敏感路径。
 */
export function scanForSensitiveAccess(req: ExecRequest): SensitiveAccessResult {
  const cwd = req.cwd || process.cwd();
  let segments: string[] = [];

  if (req.type === 'shell') {
    // 按 cmd 连接符拆分
    segments = req.rawCommand.split(/&&|\|\||[&;|\n\r]/).map((s) => s.trim()).filter(Boolean);
  } else {
    // process 请求：只有 powershell -Command 才分析
    if (req.executable.toLowerCase() !== 'powershell') {
      return { hit: false, targets: [], reasons: [] };
    }
    if (req.args.length !== 3 || req.args[0] !== '-NoProfile' || req.args[1] !== '-Command') {
      return { hit: false, targets: [], reasons: [] };
    }
    segments = req.args[2].split(/;|\|\||&&|[&|\n\r]/).map((s) => s.trim()).filter(Boolean);
  }

  const targets: string[] = [];
  const reasons: string[] = [];

  for (const seg of segments) {
    const candidates = extractReadTargets(seg);
    for (const cand of candidates) {
      // 跳过明显的非路径（如 URL、纯变量）
      if (/^(https?:|\$|%)/i.test(cand)) continue;
      let abs: string;
      try {
        abs = resolveTarget(cand, cwd);
      } catch (_) {
        continue;
      }
      const cls = classifySensitivePath(abs);
      if (cls.sensitive) {
        targets.push(abs);
        for (const m of cls.matched) {
          if (!reasons.includes(m.description)) reasons.push(m.description);
        }
      }
    }
  }

  // 去重 targets
  const uniq = Array.from(new Set(targets));
  return { hit: uniq.length > 0, targets: uniq, reasons };
}

/**
 * 原生文件工具用：直接检查一个已解析的绝对路径。
 */
export function scanPathForSensitiveAccess(absPath: string): SensitiveAccessResult {
  const cls = classifySensitivePath(absPath);
  if (!cls.sensitive) return { hit: false, targets: [], reasons: [] };
  return {
    hit: true,
    targets: [absPath],
    reasons: cls.matched.map((m) => m.description),
  };
}


// ==================== 原生文件工具用的处理器 ====================

export interface SensitivePathDecision {
  /** 是否允许操作 */
  allow: boolean;
  /** 拒绝时的原因 */
  reason?: string;
}

/** 操作类型：读取 / 写入(编辑) / 删除 */
export type SensitiveOperation = 'read' | 'write' | 'delete';

export type SensitivePathHandler = (
  absPath: string,
  operation: SensitiveOperation,
  matchedReasons: string[]
) => Promise<SensitivePathDecision>;

/**
 * 默认处理器：硬拒绝。原生文件工具在没有上层注入审批能力时，
 * 遇到敏感路径直接拒绝（fail-closed），不静默放行。
 */
const defaultHandler: SensitivePathHandler = async (absPath, operation, matchedReasons) => {
  // 未注入弹窗实现时（如测试环境）fail-closed，但不再引导改用 bash
  const action = operation === 'read' ? '读取' : operation === 'write' ? '修改' : '删除';
  return {
    allow: false,
    reason:
      '敏感路径' + action + '需要明确授权，但当前环境无法弹出授权窗口：' + absPath +
      '（' + (matchedReasons.join('、') || '敏感路径') + '）',
  };
};

let globalHandler: SensitivePathHandler = defaultHandler;

/**
 * 注入自定义处理器（例如带审批弹窗的实现）。
 * app 层启动时可注入；不注入则使用硬拒绝的默认实现。
 */
export function injectSensitivePathHandler(handler: SensitivePathHandler | null): void {
  globalHandler = handler || defaultHandler;
}

/**
 * 供原生文件工具调用：检查并决定是否允许该路径操作。
 */
export async function checkSensitivePathAccess(
  absPath: string,
  operation: SensitiveOperation
): Promise<SensitivePathDecision> {
  try {
    const cls = classifySensitivePath(absPath);
    if (!cls.sensitive) return { allow: true };
    return await globalHandler(absPath, operation, cls.matched.map((m) => m.description));
  } catch (e: any) {
    // 处理器异常 → fail closed
    return {
      allow: false,
      reason: '敏感路径检查异常，已拒绝：' + (e?.message || String(e)),
    };
  }
}
