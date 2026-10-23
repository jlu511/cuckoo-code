/**
 * 敏感路径分类（纯路径判定，无上层依赖）。
 *
 * 用途：
 *  - 命令执行入口（通过 sensitive-guard.ts）识别读取敏感文件的命令
 *  - 原生文件工具（read/write/edit/delete-file）在操作前检查
 *
 * ⚠️ 边界：仅做词法路径分类，不解析符号链接的真实指向。
 * 命中表示"应触发显式授权"，不表示"已完整防止所有敏感文件访问"。
 */
import path from 'node:path';
import os from 'node:os';

export interface SensitivePathCategory {
  /** 类别标识（用于日志/UI） */
  category: string;
  /** 人类可读说明 */
  description: string;
}

export interface SensitivePathResult {
  /** 是否命中敏感路径 */
  sensitive: boolean;
  /** 命中类别（未命中时为空） */
  matched: SensitivePathCategory[];
}

/** 目录类别：命中目录及其下所有文件 */
const SENSITIVE_DIRS: Array<{ dirs: string[]; category: string; description: string }> = [
  { dirs: ['.ssh'], category: 'ssh', description: 'SSH 密钥目录（.ssh）' },
  { dirs: ['.aws'], category: 'aws', description: 'AWS 凭据目录（.aws）' },
  { dirs: ['.gnupg'], category: 'gnupg', description: 'GPG 密钥目录（.gnupg）' },
  { dirs: ['.kube'], category: 'kube', description: 'Kubernetes 配置目录（.kube）' },
  { dirs: ['.docker'], category: 'docker', description: 'Docker 凭据目录（.docker）' },
];

/** 文件名类别：只命中特定文件名 */
const SENSITIVE_BASENAMES: Array<{ names: string[]; category: string; description: string }> = [
  { names: ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'], category: 'ssh-key', description: 'SSH 私钥文件' },
  { names: ['.env'], category: 'dotenv', description: '.env 环境变量文件' },
  { names: ['.npmrc'], category: 'npmrc', description: 'npm 配置（可能含令牌）' },
  { names: ['.git-credentials'], category: 'git-credentials', description: 'Git 凭据文件' },
  { names: ['.netrc', '_netrc'], category: 'netrc', description: 'netrc 凭据文件' },
  { names: ['.pgpass'], category: 'pgpass', description: 'PostgreSQL 密码文件' },
  { names: ['credentials.json'], category: 'gcloud-credentials', description: '云服务凭据文件' },
];

/** 文件名模式：匹配前缀/后缀 */
const SENSITIVE_BASENAME_PATTERNS: Array<{ re: RegExp; category: string; description: string }> = [
  { re: /^\.env\..+$/, category: 'dotenv', description: '.env.* 环境变量文件' },
];

/**
 * 分类一个绝对或相对路径。相对路径不解析（返回未命中），
 * 调用方应先解析为绝对路径再传入。
 */
export function classifySensitivePath(targetPath: string | undefined | null): SensitivePathResult {
  if (!targetPath || typeof targetPath !== 'string') {
    return { sensitive: false, matched: [] };
  }

  // 规范化：统一分隔符，Windows 下小写化
  const isWin = process.platform === 'win32';
  const normalized = targetPath.replace(/[\\/]+/g, path.sep);
  const cmp = isWin ? normalized.toLowerCase() : normalized;

  const matched: SensitivePathCategory[] = [];

  // 1. 目录检查：路径中任一段等于敏感目录名
  const segments = cmp.split(path.sep).filter(Boolean);
  for (const entry of SENSITIVE_DIRS) {
    for (const dirName of entry.dirs) {
      const name = isWin ? dirName.toLowerCase() : dirName;
      if (segments.includes(name)) {
        matched.push({ category: entry.category, description: entry.description });
        break;
      }
    }
  }

  // 2. basename 检查
  const base = path.basename(cmp);
  for (const entry of SENSITIVE_BASENAMES) {
    for (const name of entry.names) {
      const n = isWin ? name.toLowerCase() : name;
      if (base === n) {
        matched.push({ category: entry.category, description: entry.description });
        break;
      }
    }
  }

  // 3. basename 模式检查
  for (const entry of SENSITIVE_BASENAME_PATTERNS) {
    if (entry.re.test(base)) {
      matched.push({ category: entry.category, description: entry.description });
    }
  }

  // 去重
  const seen = new Set<string>();
  const deduped = matched.filter((m) => {
    if (seen.has(m.category)) return false;
    seen.add(m.category);
    return true;
  });

  return { sensitive: deduped.length > 0, matched: deduped };
}

/** 当前用户家目录（用于测试和 UI 提示） */
export function getUserHomeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}
