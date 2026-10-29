/**
 * 危险删除命令分析（infra 层，纯函数）
 *
 * 职责：从命令文本中识别删除类操作，解析目标路径，判定风险级别。
 * 不依赖 fs / electron / 上层模块。
 *
 * 设计原则（fail-safe）：
 *  - 本模块负责【证明安全】，不是【判定危险】。
 *  - 无法确定目标 → 返回 unknown，由调用方弹窗但只给「我自己删」。
 *  - 解析错误只会导致多弹窗（false positive），不应导致漏拦。
 *
 * 已知边界（不宣称覆盖）：
 *  - 编码调用（powershell -EncodedCommand 等）：命令本身不是删除命令，无法识别
 *  - 脚本内部删除（python clean.py / bash clean.sh）：视为 unknown
 *  - 符号链接指向：只做词法路径分类，不解析 realpath
 *  - 上游 DANGEROUS_CMDS 命中时（format/shutdown 等）应在调用本模块【之前】直接拒绝
 */

import path from 'node:path';
import { stripWrappers } from './dangerous-commands.js';

// ==================== 类型 ====================

export type PathScope =
  | 'drive-root'
  | 'workspace-root'
  | 'workspace-parent'
  | 'outside'
  | 'inside'
  | 'unknown';

export type ShellKind = 'cmd' | 'pwsh' | 'bash';

export interface DeleteTarget {
  /** 命令中的原始 token */
  raw: string;
  /** 解析后的绝对路径；unknown 时为 null */
  resolved: string | null;
  scope: PathScope;
  isWildcard: boolean;
  hasVariable: boolean;
}

export interface DeleteAnalysis {
  /** none=放行 / preview=弹窗（给「允许执行」）/ unknown=弹窗（只给「我自己删」） */
  verdict: 'none' | 'preview' | 'unknown';
  targets: DeleteTarget[];
  reasons: string[];
  hasUnresolved: boolean;
  commands: string[];
}

export interface AnalyzeContext {
  cwd: string;
  workspaceRoot: string | null;
  shell: ShellKind;
}

// ==================== 命令表 ====================

/**
 * 删除类命令 → 生态（决定选项前缀与递归标志）。
 * 未列出的命令不视为删除命令，不会触发本模块保护。
 */
const DELETE_COMMANDS: Record<string, 'unix' | 'cmd' | 'ps'> = {
  rm: 'unix',
  rmdir: 'unix',
  del: 'cmd',
  erase: 'cmd',
  rd: 'cmd',
  'remove-item': 'ps',
  ri: 'ps',
  'clear-content': 'ps',
};

const RECURSIVE_FLAGS: Record<'unix' | 'cmd' | 'ps', RegExp[]> = {
  unix: [/^-r$/i, /^-rf$/i, /^-fr$/i, /^--recursive$/i],
  cmd: [/^\/s$/i],
  ps: [/^-recurse$/i, /^-r$/i],
};

const OPT_PREFIX: Record<'unix' | 'cmd' | 'ps', string> = {
  unix: '-',
  cmd: '/',
  ps: '-',
};

// ==================== 变量检测 ====================

/**
 * 命中任一条 → 目标标记 hasVariable（scope = unknown）。
 * 覆盖：dollar-var、百分号变量、反引号命令替换、dollar-paren 命令替换
 * 用 \x60 表示反引号，避免模板字符串/注释解析麻烦
 */
const VAR_RE = /\$[\w{(]|%[\w]+%|\x60[^\x60]*\x60|\$\([^)]*\)/;

// ==================== 引号感知分段器 ====================

/**
 * 引号感知的 shell 分段器（替代上游的 splitShellSegments）。
 *
 * 与上游差异：
 *  - 引号内的 ; | & && || 换行 不作为分隔符
 *  - 支持转义 \" \' \\（引号内外均生效）
 *  - 返回 hasUnbalancedQuote，由调用方决定是否整体降级
 *
 * 不处理：命令替换 $(...) / 反引号内部的 ; | &
 * （这部分由 VAR_RE 兜底 → unknown）
 */
interface SegmentsResult {
  segments: string[];
  hasUnbalancedQuote: boolean;
}

function splitSegmentsAwareQuotes(cmd: string): SegmentsResult {
  const segments: string[] = [];
  let cur = '';
  let inQuote: string | null = null;
  let escaped = false;

  const push = (): void => {
    const t = cur.trim();
    if (t.length > 0) segments.push(t);
    cur = '';
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = i + 1 < cmd.length ? cmd[i + 1] : '';

    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }

    if (inQuote) {
      if (ch === '\\' && (next === inQuote || next === '\\')) {
        cur += ch;
        escaped = true;
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
        cur += ch;
        continue;
      }
      cur += ch;
      continue;
    }

    // 引号外
    if (ch === '\\' && (next === '"' || next === "'" || next === '\\')) {
      cur += ch;
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      cur += ch;
      continue;
    }

    // 双字符分隔符
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      push();
      i++;
      continue;
    }
    // 单字符分隔符
    if (ch === ';' || ch === '|' || ch === '&') {
      push();
      continue;
    }
    // 换行
    if (ch === '\r' || ch === '\n') {
      push();
      if (ch === '\r' && next === '\n') i++;
      continue;
    }

    cur += ch;
  }

  push();
  return { segments, hasUnbalancedQuote: inQuote !== null };
}

/**
 * 粗判：这段文本是否以删除类命令开头。
 * 仅用于 tokenize 失败时区分「删除命令解析失败 → unknown」与「普通命令解析失败 → 忽略」。
 * 不追求精确，宁可少判（未命中则忽略）也不误判。
 */
function looksLikeDeleteCommand(seg: string): boolean {
  const m = seg.match(/^["']?([A-Za-z][\w.-]*)["']?/);
  if (!m) return false;
  const name = m[1].toLowerCase().replace(/\.exe$/, '');
  return Object.prototype.hasOwnProperty.call(DELETE_COMMANDS, name);
}

// ==================== shell 外壳剥离 ====================

/**
 * 剥除命令外壳（cmd /c、powershell -Command、bash -c）。
 * 剥不掉返回原串（视为普通命令）；后续若无法解析会走 unknown。
 */
function stripOuterQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

function stripShellWrapper(seg: string): string {
  const t = seg.trim();

  const cm = t.match(/^cmd(?:\.exe)?\s+\/[cC]\s+([\s\S]+)$/i);
  if (cm) return stripOuterQuotes(cm[1]);

  const ps = t.match(/^(?:powershell|pwsh)(?:\.exe)?\s+(?:[^\s]+\s+)*?-command\s+([\s\S]+)$/i);
  if (ps) return stripOuterQuotes(ps[1]);

  const bsh = t.match(/^bash(?:\.exe)?\s+-c\s+([\s\S]+)$/i);
  if (bsh) return stripOuterQuotes(bsh[1]);

  return t;
}

// ==================== 分词 ====================

/**
 * 引号感知分词。引号不配对返回 null（表示无法可靠解析）。
 */
function tokenize(s: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let inQuote: string | null = null;
  let has = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur !== '' || has) {
        out.push(cur);
        cur = '';
        has = false;
      }
    } else {
      cur += ch;
    }
  }
  if (inQuote) return null;
  if (cur !== '' || has) out.push(cur);
  return out;
}

// ==================== 目标提取 ====================

interface ExtractResult {
  targets: string[];
  isRecursive: boolean;
}

/**
 * 重定向操作符：2>nul、>file、>>log、<in、2>&1 等。
 * 这些不是删除目标，必须跳过。
 */
const REDIRECT_RE = /^\d*[<>]/;

function extractTargets(cmd: string, eco: 'unix' | 'cmd' | 'ps'): ExtractResult | null {
  const tokens = tokenize(cmd);
  if (!tokens || tokens.length === 0) return null;

  const optPrefix = OPT_PREFIX[eco];
  const targets: string[] = [];
  let isRecursive = false;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    // 跳过重定向操作符；若操作符本身不带文件名（如 >>、>、2>），跳过其后的 token
    if (REDIRECT_RE.test(t)) {
      if (/^\d*[<>]$/.test(t) || /^\d*[<>]{2}$/.test(t)) i++;
      continue;
    }
    if (t.startsWith(optPrefix)) {
      if (RECURSIVE_FLAGS[eco].some((re) => re.test(t))) isRecursive = true;
      continue;
    }
    targets.push(t);
  }

  return { targets, isRecursive };
}

// ==================== 路径分类 ====================

function classifyToken(raw: string, ctx: AnalyzeContext): DeleteTarget {
  const isWildcard = /[*?]/.test(raw);

  // 1. 含变量 / 命令替换 → unknown
  if (VAR_RE.test(raw)) {
    return { raw, resolved: null, scope: 'unknown', isWildcard, hasVariable: true };
  }

  // 2. Unix 绝对路径（以 / 开头，但不是 UNC //）：不猜 MSYS，一律 unknown
  if (/^\//.test(raw) && !/^\/\//.test(raw)) {
    return { raw, resolved: null, scope: 'unknown', isWildcard, hasVariable: false };
  }

  // 3. UNC（双反斜杠开头）
  if (/^\\\\/.test(raw)) {
    return { raw, resolved: null, scope: 'unknown', isWildcard, hasVariable: false };
  }

  // 4. 纯盘符 / 盘符相对路径（D: / D:foo / D:..）：Windows 语义依赖 cwd 是否在该盘，
  //    Git Bash 里可能是盘符根，意图无法确定 → unknown
  if (/^[A-Za-z]:(?![\\/])/.test(raw)) {
    return { raw, resolved: null, scope: 'unknown', isWildcard, hasVariable: false };
  }

  // 5. 含通配符：审批前无法可靠展开（不引入 glob），无法证明安全 → unknown
  if (isWildcard) {
    return { raw, resolved: null, scope: 'unknown', isWildcard: true, hasVariable: false };
  }

  // 6. 正常 resolve
  let resolved: string;
  try {
    resolved = path.resolve(ctx.cwd, raw);
  } catch (_) {
    return { raw, resolved: null, scope: 'unknown', isWildcard, hasVariable: false };
  }

  // 盘符根：D:\ / D:/ / D: 以及裸 /
  if (/^[A-Za-z]:[\\/]?$/.test(resolved) || resolved === path.sep) {
    return { raw, resolved, scope: 'drive-root', isWildcard, hasVariable: false };
  }

  // 无工作区 → 具体路径一律视为工作区外（保守）
  if (!ctx.workspaceRoot) {
    return { raw, resolved, scope: 'outside', isWildcard, hasVariable: false };
  }

  const root = path.resolve(ctx.workspaceRoot);

  // Windows 路径比较大小写不敏感：只影响分类，不改写 resolved（展示/复查仍用原始值）
  const cmp = process.platform === 'win32' ? (s: string) => s.toLowerCase() : (s: string) => s;
  const resolvedCmp = cmp(resolved);
  const rootCmp = cmp(root);
  const parentCmp = cmp(path.dirname(root));

  if (resolvedCmp === rootCmp) {
    return { raw, resolved, scope: 'workspace-root', isWildcard, hasVariable: false };
  }
  if (resolvedCmp === parentCmp) {
    return { raw, resolved, scope: 'workspace-parent', isWildcard, hasVariable: false };
  }

  const rootWithSepCmp = rootCmp.endsWith(path.sep) ? rootCmp : rootCmp + path.sep;
  if (resolvedCmp.startsWith(rootWithSepCmp)) {
    return { raw, resolved, scope: 'inside', isWildcard, hasVariable: false };
  }

  return { raw, resolved, scope: 'outside', isWildcard, hasVariable: false };
}

// ==================== 主入口 ====================

/**
 * 分析一条命令是否为危险删除操作。
 *
 * verdict 语义：
 *  - none    : 不是删除命令，或所有目标都在工作区内（且非根）→ 放行
 *  - preview : 有目标落在高危范围（盘符根/工作区根/工作区父/工作区外）→ 弹窗
 *  - unknown : 含无法解析的目标，或删除命令无法可靠解析 → 弹窗（只给「我自己删」）
 *
 * 注意：调用方应先执行上游 isDangerous()；命中时直接拒绝，不要进本函数。
 */
export function analyzeCommand(rawCommand: string, ctx: AnalyzeContext): DeleteAnalysis {
  const empty: DeleteAnalysis = {
    verdict: 'none',
    targets: [],
    reasons: [],
    hasUnresolved: false,
    commands: [],
  };

  if (!rawCommand || typeof rawCommand !== 'string') return empty;

  const splitResult = splitSegmentsAwareQuotes(rawCommand);
  if (splitResult.segments.length === 0) return empty;

  const allTargets: DeleteTarget[] = [];
  const reasons: string[] = [];
  const commands = new Set<string>();
  let hasUnresolved = false;

  // 引号未配对：整体降级。不能因为后面解析失败就把前面已识别的危险目标放行
  if (splitResult.hasUnbalancedQuote) {
    hasUnresolved = true;
    reasons.push('命令含未配对的引号，无法完整解析');
  }

  for (const segRaw of splitResult.segments) {
    const segStripped = stripWrappers(segRaw);
    const seg = stripShellWrapper(segStripped);

    // 剥壳后可能暴露新的分隔符（如 cmd /c "cmd1 & cmd2" → 内部有 &），再拆一次
    const innerSplit = splitSegmentsAwareQuotes(seg);
    if (innerSplit.hasUnbalancedQuote) {
      hasUnresolved = true;
      reasons.push('命令含未配对的引号，无法完整解析');
    }
    const innerSegs = innerSplit.segments.length > 0 ? innerSplit.segments : [seg];

    for (const innerSeg of innerSegs) {
    const tokens = tokenize(innerSeg);
    if (!tokens || tokens.length === 0) {
      // 只有能粗判为删除命令时才标 unknown；普通命令（echo/findstr 等）解析失败不影响
      if (looksLikeDeleteCommand(innerSeg)) {
        hasUnresolved = true;
        reasons.push('命令无法解析');
      }
      continue;
    }

    // 首个非选项 token = 命令名
    let cmdName = '';
    for (const t of tokens) {
      if (t && !t.startsWith('-') && !t.startsWith('/')) {
        cmdName = t.toLowerCase().replace(/\.exe$/, '');
        break;
      }
    }
    if (!cmdName) continue;

    const ecoBase = DELETE_COMMANDS[cmdName];
    if (!ecoBase) continue;

    // rmdir 在 cmd 与 unix 都存在：按 ctx.shell 消歧
    let eco: 'unix' | 'cmd' | 'ps' = ecoBase;
    if (cmdName === 'rmdir') {
      eco = ctx.shell === 'pwsh' ? 'ps' : ctx.shell === 'cmd' ? 'cmd' : 'unix';
    }

    commands.add(cmdName);

    const extracted = extractTargets(innerSeg, eco);
    if (!extracted) {
      hasUnresolved = true;
      reasons.push('命令 ' + cmdName + ' 无法解析（引号不配对等）');
      continue;
    }
    if (extracted.targets.length === 0) {
      hasUnresolved = true;
      reasons.push('命令 ' + cmdName + ' 无明确目标');
      continue;
    }

    for (const raw of extracted.targets) {
      const t = classifyToken(raw, ctx);
      allTargets.push(t);
      if (t.scope === 'unknown') hasUnresolved = true;
    }
    }
  }

  // 去重（按 resolved||raw + scope）
  const seen = new Set<string>();
  const uniqTargets: DeleteTarget[] = [];
  for (const t of allTargets) {
    const key = (t.resolved || t.raw) + '|' + t.scope;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqTargets.push(t);
  }

  if (uniqTargets.length === 0 && !hasUnresolved) {
    return { ...empty, commands: Array.from(commands) };
  }

  const dangerScopes: PathScope[] = ['drive-root', 'workspace-root', 'workspace-parent', 'outside'];
  const hasDanger = uniqTargets.some((t) => dangerScopes.includes(t.scope));

  for (const t of uniqTargets) {
    const p = t.resolved || t.raw;
    if (t.scope === 'drive-root') reasons.push('目标包含磁盘根目录：' + p);
    else if (t.scope === 'workspace-root') reasons.push('目标为工作区根目录本身：' + p);
    else if (t.scope === 'workspace-parent') reasons.push('目标为工作区父目录：' + p);
    else if (t.scope === 'outside') reasons.push('目标在工作区外：' + p);
    else if (t.scope === 'unknown') reasons.push('目标无法确定：' + t.raw);
    if (t.isWildcard) reasons.push('目标含通配符：' + t.raw);
  }

  const uniqReasons = Array.from(new Set(reasons));

  let verdict: DeleteAnalysis['verdict'];
  if (hasUnresolved) verdict = 'unknown';
  else if (hasDanger) verdict = 'preview';
  else verdict = 'none';

  return {
    verdict,
    targets: uniqTargets,
    reasons: uniqReasons,
    hasUnresolved,
    commands: Array.from(commands),
  };
}
