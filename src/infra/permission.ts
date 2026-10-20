import path from 'node:path';
import fs from 'node:fs';
import { getAccessMode } from './config.js';
import type { AccessMode } from './config.js';

export interface PermissionDecision {
  allow: boolean;
  reason?: string;
}

function normalizeCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * 解析为规范化绝对路径（处理符号链接、大小写等）。
 * 对于不存在的路径，向上寻找存在的祖先，做 realpath 后再拼接。
 */
function resolveCanonical(targetPath: string, projectDir: string | null): string {
  let resolved = targetPath.replace(/\//g, path.sep);
  if (!path.isAbsolute(resolved)) {
    resolved = path.join(projectDir || process.cwd(), resolved);
  }

  // 向上寻找最近存在的祖先
  let curr = resolved;
  const suffix: string[] = [];
  while (!fs.existsSync(curr) && path.dirname(curr) !== curr) {
    suffix.unshift(path.basename(curr));
    curr = path.dirname(curr);
  }

  try {
    curr = fs.realpathSync(curr);
  } catch (e) {
    // ignore
  }

  return path.join(curr, ...suffix);
}

/**
 * 检查是否在工作区内。
 */
function isInsideWorkspace(canonical: string, workspaceRoot: string): boolean {
  const c = normalizeCase(canonical);
  const r = normalizeCase(workspaceRoot);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * 统一权限拦截点。
 * @param targetPath 要操作的文件路径或命令的 workdir
 * @param isWrite 是否为写/删操作
 * @param projectDir 当前工作区根目录
 */
export function checkPathPermission(
  targetPath: string | undefined,
  isWrite: boolean,
  projectDir: string | null
): PermissionDecision {
  const mode = getAccessMode();

  if (mode === 'fullAccess') {
    return { allow: true };
  }

  if (!targetPath) {
    // 没有目标路径（比如有些查询类操作），放过
    return { allow: true };
  }

  const canonical = resolveCanonical(targetPath, projectDir);

  if (mode === 'readOnly') {
    if (isWrite) {
      return { allow: false, reason: `当前为只读模式（readOnly），禁止修改或删除文件: ${canonical}` };
    }
    // 读取不限制
    return { allow: true };
  }

  if (mode === 'workspaceWrite') {
    if (!projectDir) {
      if (isWrite) {
        return { allow: false, reason: '当前为工作区内修改模式（workspaceWrite），但未设置工作区，无法写入' };
      }
      return { allow: true };
    }
    const inside = isInsideWorkspace(canonical, resolveCanonical(projectDir, null));
    if (isWrite && !inside) {
      return { allow: false, reason: `当前为工作区内修改模式（workspaceWrite），禁止操作工作区外的路径: ${canonical}` };
    }
    // 读取不限制（为了让AI能看外部文档）
    return { allow: true };
  }

  return { allow: true };
}

/**
 * 检查命令执行权限。
 */
export function checkCommandPermission(command: string): PermissionDecision {
  const mode = getAccessMode();
  if (mode === 'readOnly') {
    return { allow: false, reason: '当前为只读模式（readOnly），禁止执行任何系统命令' };
  }
  return { allow: true };
}
