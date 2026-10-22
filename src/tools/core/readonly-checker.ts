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

  return false;
}

/** 链式命令（按引号感知的 & 拆分） */
function isSafeCmdChain(trimmed: string): boolean {
  const segments: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === '"') inQuote = !inQuote;
    if (char === '&' && !inQuote) {
      if (trimmed[i-1] === '&' || trimmed[i+1] === '&') return false;
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
  if (trimmed.includes('&&') || trimmed.includes('||')) return false;
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
