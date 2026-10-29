/**
 * 删除预览（tools 层）
 *
 * 职责：扫描删除目标，产出文件清单供审批弹窗展示。
 * 依赖 fs，不依赖 electron。
 *
 * 设计要点：
 *  - 不跟随符号链接（lstat），避免预览越界 + 防止循环
 *  - 单目标 + 全局双上限，防止大目录扫描卡死
 *  - 扫描失败不抛异常，记入 scanErrors，由调用方决定如何展示
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DeleteTarget } from '../../infra/dangerous-delete.js';

export interface PreviewEntry {
  /** 展示用路径：工作区内相对 workspaceRoot，工作区外为绝对路径 */
  relPath: string;
  /** 绝对路径 */
  absPath: string;
  type: 'file' | 'dir' | 'link';
  /** 文件字节数（仅 file） */
  size?: number;
  /** 链接目标（仅 link） */
  linkTarget?: string;
}

export interface PreviewResult {
  entries: PreviewEntry[];
  totalFiles: number;
  totalDirs: number;
  totalBytes: number;
  /** 是否因为上限而截断 */
  truncated: boolean;
  /** 扫描失败的目标 */
  scanErrors: Array<{ path: string; error: string }>;
}

export interface PreviewOptions {
  /** 展示条目上限，默认 200 */
  limit?: number;
  /** 目录递归最大深度，默认 20 */
  maxDepth?: number;
  /** 硬上限：扫描过的条目总数，默认 5000 */
  maxEntries?: number;
}

const DEFAULT_OPTS: Required<PreviewOptions> = {
  limit: 200,
  maxDepth: 20,
  maxEntries: 5000,
};

/**
 * 扫描删除目标，产出文件清单。
 * 仅处理 resolved !== null 的目标（unknown 目标由调用方单独展示原因）。
 */
export async function previewDelete(
  targets: DeleteTarget[],
  workspaceRoot: string | null,
  opts?: PreviewOptions,
): Promise<PreviewResult> {
  const o = { ...DEFAULT_OPTS, ...(opts || {}) };

  const entries: PreviewEntry[] = [];
  const scanErrors: PreviewResult['scanErrors'] = [];
  let totalFiles = 0;
  let totalDirs = 0;
  let totalBytes = 0;
  let scanned = 0;
  let truncated = false;

  const root = workspaceRoot ? path.resolve(workspaceRoot) : null;
  const rootWithSep = root ? (root.endsWith(path.sep) ? root : root + path.sep) : null;

  function displayPath(abs: string): string {
    if (root && rootWithSep) {
      if (abs === root) return '.';
      if (abs.startsWith(rootWithSep)) return abs.slice(rootWithSep.length).replace(/\\/g, '/');
    }
    return abs;
  }

  function pushEntry(e: PreviewEntry): boolean {
    if (entries.length >= o.limit) {
      truncated = true;
      return false;
    }
    entries.push(e);
    return true;
  }

  function walk(abs: string, depth: number): void {
    if (scanned >= o.maxEntries) {
      truncated = true;
      return;
    }
    scanned++;

    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch (e: any) {
      scanErrors.push({ path: abs, error: e && e.message ? e.message : String(e) });
      return;
    }

    if (st.isSymbolicLink()) {
      let linkTarget: string | undefined;
      try {
        linkTarget = fs.readlinkSync(abs);
      } catch (_) {
        // 忽略：读不到链接目标不影响展示
      }
      pushEntry({ relPath: displayPath(abs), absPath: abs, type: 'link', linkTarget });
      return;
    }

    if (st.isDirectory()) {
      totalDirs++;
      pushEntry({ relPath: displayPath(abs), absPath: abs, type: 'dir' });
      if (depth >= o.maxDepth) return;

      let children: string[] = [];
      try {
        children = fs.readdirSync(abs);
      } catch (e: any) {
        scanErrors.push({ path: abs, error: e && e.message ? e.message : String(e) });
        return;
      }
      // 排序让列表更可读
      children.sort();
      for (const c of children) {
        walk(path.join(abs, c), depth + 1);
      }
      return;
    }

    if (st.isFile()) {
      totalFiles++;
      totalBytes += st.size;
      pushEntry({ relPath: displayPath(abs), absPath: abs, type: 'file', size: st.size });
    }
  }

  for (const t of targets) {
    if (!t.resolved) continue;
    if (scanned >= o.maxEntries) {
      truncated = true;
      break;
    }
    walk(t.resolved, 0);
  }

  return { entries, totalFiles, totalDirs, totalBytes, truncated, scanErrors };
}

/** 格式化字节数（用于弹窗展示） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return n + ' B';
  const kb = n / 1024;
  if (kb < 1024) return kb.toFixed(1) + ' KB';
  const mb = kb / 1024;
  if (mb < 1024) return mb.toFixed(1) + ' MB';
  return (mb / 1024).toFixed(1) + ' GB';
}
