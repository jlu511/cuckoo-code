import type { ExecRequest } from './executor.js';

/**
 * 判断是否为绝对安全的只读命令。
 * 原则：最小放行，宁可错杀不可放过。
 */

const KNOWN_SAFE_BINARIES = new Set([
  'gcc', 'g++', 'clang', 'clang++',
  'node', 'npm', 'npx',
  'python', 'python3',
  'git',
]);

const VERSION_ARGS_RE = /^([a-z][a-z0-9+-]*)\s+(--version|-v|--v)$/i;

// ==================== Git 只读子命令（需求 031）====================

/** 引号感知分词；引号不配对返回 null */
interface Token { tok: string; quoted: boolean; }

function tokenizeCommand(s: string): Token[] | null {
  const out: Token[] = [];
  let cur = '';
  let quoted = false;
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === '"') inQuote = false;
      else cur += ch;
    } else if (ch === '"') {
      inQuote = true;
      quoted = true;
    } else if (/\s/.test(ch)) {
      if (cur !== '' || quoted) {
        out.push({ tok: cur, quoted });
        cur = '';
        quoted = false;
      }
    } else {
      cur += ch;
    }
  }
  if (inQuote) return null;
  if (cur !== '' || quoted) out.push({ tok: cur, quoted });
  return out;
}

/**
 * Git 危险参数前缀（纵深防御）。
 * 主逻辑是"正向枚举允许的参数"，这里是兜底：即使白名单有疏漏，
 * 命中这些前缀也一律拒绝。
 */
const GIT_DANGEROUS_PREFIXES = [
  '--output',
  '--ext-diff',
  '--no-index',
  '--git-dir',
  '--work-tree',
  '--exec-path',
  '--format',
  '--pretty',
  '--textconv',
  '--filters',
  '--open-files-in-pager',
  '--config-env',
  '--super-prefix',
  '--namespace',
  '--global',
  '--system',
  '--local',
  '--file',
];

/** ref 形态：分支/标签/HEAD，不能以 - 开头（防选项注入） */
const GIT_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/** 路径 token 禁止的字符（引号已剥离） */
const GIT_PATH_FORBIDDEN_RE = /[<>|;&`$%!^\n\r"'*?]/;

/** status 允许的参数（含 -sb 这种组合短选项，显式列出不做展开） */
const GIT_STATUS_ARGS = new Set(['-s', '--short', '-b', '-sb', '--porcelain']);

/** diff 允许的范围参数（只限定范围，不改变输出形态） */
const GIT_DIFF_SCOPE_ARGS = new Set(['--cached', '--staged']);

/** diff 允许的显示参数（必须至少有一个，否则裸 diff 会输出完整补丁） */
const GIT_DIFF_DISPLAY_ARGS = new Set(['--stat', '--name-only', '--check']);

function hasDangerousGitArg(tokens: Token[]): boolean {
  return tokens.some((t) =>
    GIT_DANGEROUS_PREFIXES.some((p) => t.tok === p || t.tok.startsWith(p + '='))
  );
}

/** 校验 `--` 之后的路径 token */
function isSafeGitPath(t: Token): boolean {
  if (GIT_PATH_FORBIDDEN_RE.test(t.tok)) return false;
  if (t.tok.includes('..')) return false;
  return true;
}

/** 校验 1–20 的数量参数 */
function isSafeLogCount(raw: string): boolean {
  if (!/^\d+$/.test(raw)) return false;
  const n = Number(raw);
  return n >= 1 && n <= 20;
}

/**
 * 判断 `git <args...>` 是否为只读命令。
 * rest 不含 "git" 本身，rest[0] 是子命令。
 */
function isSafeGitReadOnly(rest: Token[]): boolean {
  if (rest.length === 0) return false;
  const subTok = rest[0];
  if (subTok.quoted) return false;
  const sub = subTok.tok.toLowerCase();
  const args = rest.slice(1);

  // 纵深防御：任何位置出现危险参数都拒绝
  if (hasDangerousGitArg(rest)) return false;

  switch (sub) {
    case 'status': {
      // 无参数或全部为白名单参数
      return args.every((a) => !a.quoted && GIT_STATUS_ARGS.has(a.tok));
    }

    case 'branch': {
      return args.length === 1 && !args[0].quoted && args[0].tok === '--show-current';
    }

    case 'diff': {
      const dashIdx = args.findIndex((a) => a.tok === '--');
      const opts = dashIdx >= 0 ? args.slice(0, dashIdx) : args;
      const paths = dashIdx >= 0 ? args.slice(dashIdx + 1) : [];
      // 选项必须全部在「范围参数」或「显示参数」内，不接受未知参数
      if (!opts.every((o) => !o.quoted && (GIT_DIFF_SCOPE_ARGS.has(o.tok) || GIT_DIFF_DISPLAY_ARGS.has(o.tok)))) return false;
      // 必须至少含一个显示类选项（否则裸 diff / 仅 --cached 都会输出完整补丁）
      if (!opts.some((o) => GIT_DIFF_DISPLAY_ARGS.has(o.tok))) return false;
      // 路径校验
      if (!paths.every(isSafeGitPath)) return false;
      return true;
    }

    case 'rev-parse': {
      if (args.length !== 1) return false;
      const a = args[0];
      return !a.quoted && GIT_REF_RE.test(a.tok);
    }

    case 'log': {
      if (!args.some((a) => a.tok === '--oneline')) return false;
      for (let i = 0; i < args.length; i++) {
        const t = args[i];
        if (t.quoted) return false;
        if (t.tok === '--oneline') continue;
        const shortForm = t.tok.match(/^-(\d+)$/);
        if (shortForm) {
          if (!isSafeLogCount(shortForm[1])) return false;
          continue;
        }
        if (t.tok === '-n') {
          const next = args[i + 1];
          if (!next || next.quoted || !isSafeLogCount(next.tok)) return false;
          i++;
          continue;
        }
        return false;
      }
      return true;
    }

    case 'show': {
      if (!args.some((a) => a.tok === '--stat')) return false;
      if (!args.some((a) => a.tok === '--oneline')) return false;
      const refs = args.filter((a) => a.tok !== '--stat' && a.tok !== '--oneline');
      if (refs.length !== 1) return false;
      return !refs[0].quoted && GIT_REF_RE.test(refs[0].tok);
    }

    default:
      return false;
  }
}

/** 判断整条命令是否为只读 git 调用 */
function isGitReadOnlyCommand(tokens: Token[]): boolean {
  if (tokens.length === 0) return false;
  if (tokens[0].quoted) return false;
  const name = tokens[0].tok.toLowerCase();
  if (name !== 'git' && name !== 'git.exe') return false;
  return isSafeGitReadOnly(tokens.slice(1));
}

export function isL0ReadOnly(req: ExecRequest): boolean {
  if (req.type === 'shell') {
    if (req.shellType !== 'cmd') return false;
    return isCmdReadOnly(req.rawCommand);
  }

  if (req.type === 'process') {
    if (req.executable.toLowerCase() !== 'powershell') return false;
    if (req.args.length !== 3) return false;
    if (req.args[0] !== '-NoProfile') return false;
    if (req.args[1] !== '-Command') return false;
    return isPwshReadOnly(req.args[2]);
  }

  return false;
}

function isKnownBinaryVersion(cmd: string): boolean {
  const m = cmd.match(VERSION_ARGS_RE);
  if (!m) return false;
  return KNOWN_SAFE_BINARIES.has(m[1].toLowerCase());
}

/** 校验 dir 参数（不含 &，用于单命令和链式命令共用） */
function isSafeDirArgs(content: string): boolean {
  if (content.toLowerCase() === 'dir') return true;
  const dirMatch = content.match(/^dir\s+(.+)$/i);
  if (!dirMatch) return false;

  const args = dirMatch[1].trim();
  // 关键防御：重定向符号一旦出现，无论位置如何，一律拒绝（防止 /b>nul 被当路径）
  if (/[<>|;&]/.test(args)) return false;
  if (/\/s\b/i.test(args)) return false;
  if (args.includes('..')) return false;

  const argsNoPath = args.replace(/"[^"]+"/g, 'PATH_HERE');
  const parts = argsNoPath.split(/\s+/);
  let hasPath = false;
  for (const p of parts) {
    if (p === 'PATH_HERE') {
      if (hasPath) return false;
      hasPath = true;
    } else if (/^\/[abw]$/i.test(p)) {
      continue;
    } else if (/^[^"\s]+$/.test(p)) {
      if (hasPath) return false;
      hasPath = true;
    } else {
      return false;
    }
  }
  return true;
}

/** 单命令白名单：ver / where / dir / binary --version */
function isSafeSingleCmd(trimmed: string): boolean {
  const lower = trimmed.toLowerCase();
  if (lower === 'ver') return true;

  if (/^where\s+[a-z0-9_-]+(\.[a-z0-9_-]+)?$/i.test(trimmed)) {
    if (trimmed.includes('..')) return false;
    return true;
  }

  if (isSafeDirArgs(trimmed)) return true;

  if (isKnownBinaryVersion(trimmed)) return true;

  // Git 只读子命令（需求 031）：正向枚举，未知参数不放行
  const gitTokens = tokenizeCommand(trimmed);
  if (gitTokens && isGitReadOnlyCommand(gitTokens)) return true;

  return false;
}

/** 链式段白名单：仅 echo 和 dir */
function isSafeChainSegment(seg: string): boolean {
  if (!seg) return false;
  let content = seg;

  const redirMatch = content.match(/\s+(2>nul|>nul)$/i);
  if (redirMatch) content = content.slice(0, redirMatch.index).trim();

  if (/[<>|;&]/.test(content)) return false;

  if (/^echo\s+"[^"%!^&|<>]*"$/i.test(content)) return true;
  if (/^echo\s*""$/i.test(content)) return true;

  if (isSafeDirArgs(content)) return true;

  // Git 只读子命令（需求 031）：链式段同样走严格白名单
  const segTokens = tokenizeCommand(content);
  if (segTokens && isGitReadOnlyCommand(segTokens)) return true;

  return false;
}

/**
 * 链式命令（按引号感知的 & / && 拆分）。
 * 需求 031：支持 && 顺序链，每一段都必须独立命中白名单。
 * 仍拒绝 || （短路语义复杂，且本轮无需求）。
 */
function isSafeCmdChain(trimmed: string): boolean {
  const segments: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === '"') inQuote = !inQuote;
    if (char === '&' && !inQuote) {
      // && 与 & 都作为分隔符；&& 时跳过第二个 &
      if (trimmed[i + 1] === '&') i++;
      segments.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  segments.push(current.trim());

  if (segments.length === 0) return false;
  return segments.every(seg => isSafeChainSegment(seg));
}

function isCmdReadOnly(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  if (/[|;<\`$^()\n\r%!]/.test(trimmed)) return false;
  if (trimmed.includes("'")) return false;
  // 需求 031：允许 && 顺序链（每段独立判定）；|| 仍拒绝
  if (trimmed.includes('||')) return false;
  if ((trimmed.split('"').length - 1) % 2 !== 0) return false;

  let hasUnquotedAmp = false;
  let inQuote = false;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '"') inQuote = !inQuote;
    if (trimmed[i] === '&' && !inQuote) { hasUnquotedAmp = true; break; }
  }

  if (hasUnquotedAmp) return isSafeCmdChain(trimmed);
  return isSafeSingleCmd(trimmed);
}

const PWSH_DANGEROUS_RE = /[;&|<>\`$"'%!^()\n\r]/;

function isPwshReadOnly(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  if (PWSH_DANGEROUS_RE.test(trimmed)) return false;

  const lower = trimmed.toLowerCase();
  if (lower === 'get-location') return true;
  if (lower === 'get-date') return true;
  if (lower === 'pwd') return true;
  if (lower === 'get-psdrive') return true;

  if (isKnownBinaryVersion(trimmed)) return true;
  return false;
}
