import type { ExecRequest } from './executor.js';

/**
 * 判断是否为绝对安全的只读命令。
 * ⚠️ 原则：最小放行，宁可错杀不可放过。
 * 只要包含连接符、重定向、变量展开、引号、转义等，直接返回 false（走审批）。
 *
 * 注意：判定器仅限制命令形式，不证明实际执行的二进制文件可信。
 */

/**
 * 已知安全的版本查询 binary 白名单。
 *
 * ⚠️ 仅做名字字符串匹配，不解析实际执行路径。
 * PATH 中存在同名恶意程序时仍可能被执行。收窄白名单只缩小攻击面，
 * 不消除 PATH 劫持风险。
 *
 * 收录原则：Cuckoo Code 自身与日常开发高频工具。
 * 已移除：mvn/gradle/cargo/go/rustc/dotnet/msbuild（低频）、
 *          cc/c++/py/yarn/pnpm（可能指向任意目标）
 */
const KNOWN_SAFE_BINARIES = new Set([
  'gcc', 'g++', 'clang', 'clang++',
  'node', 'npm', 'npx',
  'python', 'python3',
  'git',
]);

/** 匹配二进制版本查询（如 gcc --version, node -v） */
const VERSION_ARGS_RE = /^([a-z][a-z0-9+-]*)\s+(--version|-v|--v)$/i;

/** 危险字符：命令连接、重定向、管道、变量、引号、转义、换行 */
const DANGEROUS_CHARS_RE = /[;&|<>\`$"'%!^()\n\r]/;

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

function isCmdReadOnly(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  if (DANGEROUS_CHARS_RE.test(trimmed)) return false;

  const lower = trimmed.toLowerCase();
  if (lower === 'ver') return true;

  if (/^where\s+[a-z0-9_-]+(\.[a-z0-9_-]+)?$/i.test(trimmed)) {
    if (trimmed.includes('..')) return false;
    return true;
  }

  if (/^dir(\s+\/[abw])*$/i.test(trimmed)) {
    return true;
  }

  if (isKnownBinaryVersion(trimmed)) return true;

  return false;
}

function isPwshReadOnly(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  if (DANGEROUS_CHARS_RE.test(trimmed)) return false;

  const lower = trimmed.toLowerCase();
  if (lower === 'get-location') return true;
  if (lower === 'get-date') return true;
  if (lower === 'pwd') return true;
  if (lower === 'get-psdrive') return true;

  if (isKnownBinaryVersion(trimmed)) return true;

  return false;
}
