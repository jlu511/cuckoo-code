/**
 * 会话授权策略（需求 032）。
 *
 * 纯函数，无副作用、不依赖 Electron。
 * 职责：
 *   1. buildRequestFingerprint —— 请求执行语义的规范化指纹（SHA-256）
 *   2. isSessionGrantBlocked —— 判断某请求是否禁止「本会话内允许」
 *
 * ⚠️ 资格判定必须保守：无法可靠判断 → 不提供会话授权。
 *    不能因为「没识别出危险」就反向判定为安全。
 */
import crypto from 'node:crypto';
import type { ExecRequest } from './executor.js';
import { extractEffectiveCommand, isHighRiskCommand } from './default-handler.js';

// ==================== 请求指纹 ====================

/** 键排序后 JSON：对象属性顺序不影响结果 */
function stableSerializeEnv(env: Record<string, string> | undefined): string {
  if (!env || typeof env !== 'object') return '{}';
  const keys = Object.keys(env).sort();
  return JSON.stringify(keys.map((k) => [k, env[k]]));
}

/**
 * 计算请求的执行语义指纹（SHA-256 十六进制）。
 *
 * 纳入：type / shellType|executable / rawCommand|args(JSON) / cwd / env(稳定序列化) / timeoutMs
 * 排除：taskId（非执行语义）、description（纯展示）
 *
 * 输出为哈希值，**不含任何明文环境变量**。
 */
export function buildRequestFingerprint(req: ExecRequest): string {
  const parts: string[] = [req.type];
  if (req.type === 'shell') {
    parts.push(req.shellType);
    parts.push(req.rawCommand);
    parts.push('');
  } else {
    parts.push('');
    parts.push(req.executable);
    // JSON 序列化：避免 ['a b'] 与 ['a','b'] 产生同一指纹
    parts.push(JSON.stringify(req.args || []));
  }
  parts.push(req.cwd);
  parts.push(stableSerializeEnv(req.env));
  parts.push(req.timeoutMs === undefined ? 'undefined' : String(req.timeoutMs));
  return crypto.createHash('sha256').update(parts.join('\x00')).digest('hex');
}

// ==================== Git 识别 ====================

/** 引号感知分词；引号不配对返回 null */
function tokenize(s: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === '"') inQuote = false;
      else cur += ch;
    } else if (ch === '"') {
      inQuote = true;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur !== '' || has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += ch;
    }
  }
  if (inQuote) return null;
  if (cur !== '' || has) out.push(cur);
  return out;
}

/** 取路径的文件名部分（兼容 / 与 \\） */
function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * 判断命令是否「像 git 调用」。
 * 保守：首 token 的 basename 是 git / git.exe 就算（含绝对路径、.exe 后缀、引号包裹）。
 * 这样 git.exe / "C:\\Program Files\\Git\\cmd\\git.exe" / git -C repo push 都能被识别。
 */
function looksLikeGit(cmd: string): boolean {
  const tokens = tokenize(cmd.trim());
  if (!tokens || tokens.length === 0) return false;
  const b = basename(tokens[0]).toLowerCase();
  return b === 'git' || b === 'git.exe';
}

// ==================== 资格判定 ====================

/** 命令链 / 管道 / 重定向：语义复杂，一律不提供会话授权 */
const CHAIN_PATTERN = /&&|\|\||[|;<>]/;

/** 有效命令行（shell 用 rawCommand；process 剥离 powershell 外壳） */
function effectiveCommand(req: ExecRequest): string {
  if (req.type === 'shell') return req.rawCommand || '';
  return extractEffectiveCommand({
    type: 'process',
    executable: req.executable,
    args: req.args,
  } as any);
}

/**
 * 判断某个请求是否禁止「本会话内允许」。
 * @returns true = 禁止（弹窗只显示 2 个按钮）
 */
export function isSessionGrantBlocked(
  req: ExecRequest,
  riskLevel: 'L0' | 'L1' | 'L2' | 'L3'
): boolean {
  // 1. L3 敏感路径：永不允许会话授权
  if (riskLevel === 'L3') return true;

  const cmd = effectiveCommand(req);
  if (!cmd) return true;

  // 2. 命令链 / 管道 / 重定向：语义复杂，不提供会话授权
  if (CHAIN_PATTERN.test(cmd)) return true;

  // 3. 高危命令（rm -rf / del /f / format / Remove-Item / 盘符根写入等）
  if (isHighRiskCommand(cmd)) return true;

  // 4. Git：只读子命令已被需求 031 收入 L0，能到这里的必为状态变更或无法可靠识别，
  //    一律禁止会话授权（正向资格判定的保守实现）。
  //    覆盖 git.exe / 绝对路径 / git -C repo push / git -c alias.x=... 等形态。
  if (looksLikeGit(cmd)) return true;

  return false;
}