/**
 * Cuckoo 插件安装器：用自带 npm 下载 npm 包到 ~/.cuckoo/cuckoo-plugins/<id>/。
 * 纯 node + 子进程。
 *
 * 安全：安装前必须经过 PluginInstallGate 审批（fail closed）。
 * 超时后强制清理进程树。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getCuckooPluginDir, isValidPluginId } from './paths.js';
import { decodeOutput } from '../../infra/decode-output.js';
import { resolveRuntimeBinDir } from '../../infra/paths.js';
import {
  buildInstallSnapshot,
  type PluginInstallGate,
  type PluginInstallSnapshot,
} from './install-gate.js';

/** 安装超时（毫秒） */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

const IS_WIN = process.platform === 'win32';

/** 安装审批网关（由 app 层注入；未注入时拒绝安装） */
let installGate: PluginInstallGate | null = null;

function injectPluginInstallGate(gate: PluginInstallGate): void {
  installGate = gate;
}

function getPluginInstallGate(): PluginInstallGate | null {
  return installGate;
}

/** 找自带的 npm.cmd（复用 infra 的跨平台/跨环境路径解析） */
function bundledNpm(): { cmd: string; binDir: string } | null {
  const binDir = resolveRuntimeBinDir();
  if (!binDir) return null;
  const cmd = path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (fs.existsSync(cmd)) return { cmd, binDir };
  return null;
}

/** 从包名提取"插件 id"（@scope/name → scope-name） */
function packageNameToId(pkgName: string): string {
  return pkgName.replace(/^@/, '').replace(/\//g, '-').toLowerCase();
}

/**
 * 校验 npm 包名合法性（防止参数注入）。
 * 允许：小写字母、数字、连字符、下划线、点、斜杠、@
 * 不允许：空格、引号、分号、管道符、& 等 shell 元字符
 */
const VALID_PKG_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

function isValidPackageName(pkg: unknown): pkg is string {
  if (typeof pkg !== 'string') return false;
  if (pkg.length === 0 || pkg.length > 214) return false;
  return VALID_PKG_RE.test(pkg);
}

/**
 * 清理进程树。
 * Windows 用 taskkill /T /F（与 default-runner.ts 一致）。
 */
function killTree(pid: number | undefined, child: any): void {
  if (!pid) {
    try { child.kill(); } catch (_) { /* ignore */ }
    return;
  }
  if (IS_WIN) {
    try {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      killer.unref();
    } catch (_) {
      try { child.kill(); } catch (_) { /* ignore */ }
    }
  } else {
    try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
  }
}

/**
 * 安装 npm 包到插件目录。
 * @param pkgName npm 包名
 * @param windowId 发起安装的可信窗口 ID（必填，用于审批）
 */
async function installCuckooPlugin(
  pkgName: string,
  windowId: number
): Promise<{ id: string; dir: string }> {
  if (!pkgName || typeof pkgName !== 'string') throw new Error('包名不能为空');
  if (!isValidPackageName(pkgName)) throw new Error('包名非法（含非法字符）: ' + pkgName);
  if (!windowId || typeof windowId !== 'number') {
    throw new Error('拒绝安装插件：缺少可信的窗口 ID');
  }

  const id = packageNameToId(pkgName);
  if (!isValidPluginId(id)) throw new Error('包名转 id 非法: ' + id);

  const dir = getCuckooPluginDir(id);
  const npm = bundledNpm();
  if (!npm) throw new Error('未找到自带 npm 运行时');

  const args = ['install', pkgName, '--no-audit', '--no-fund', '--loglevel=error'];

  // === 审批（必须在 spawn 之前）===
  const gate = getPluginInstallGate();
  if (!gate) {
    throw new Error('拒绝安装插件：审批网关未注入');
  }

  const snapshot = buildInstallSnapshot({
    windowId,
    packageName: pkgName,
    pluginId: id,
    installDir: dir,
    command: npm.cmd,
    args,
    cwd: dir,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });

  const decision = await gate.check(snapshot);
  if (decision === 'deny') {
    throw new Error('用户拒绝安装插件: ' + pkgName);
  }

  // 审批通过后才创建目录、写 package.json
  // 注意：使用 snapshot 中的路径，保证"批准什么就执行什么"
  fs.mkdirSync(snapshot.installDir, { recursive: true });
  const pkgJsonPath = path.join(snapshot.installDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: id, version: '1.0.0', private: true }, null, 2), 'utf-8');
  }

  try {
    await runNpm(npm, snapshot.command, snapshot.args, snapshot.cwd, snapshot.timeoutMs);
  } catch (err) {
    // 安装失败（如 404、断网、超时），回滚清理空目录，避免污染插件列表
    try {
      if (fs.existsSync(snapshot.installDir)) {
        fs.rmSync(snapshot.installDir, { recursive: true, force: true });
      }
    } catch (_) { /* ignore */ }
    throw err;
  }

  return { id, dir: snapshot.installDir };
}

/**
 * 执行 npm 命令。
 * Windows 下必须 shell: true（npm.cmd 是批处理），但包名已通过 isValidPackageName 严格校验，
 * 不含任何 shell 元字符，因此不存在命令注入面。
 */
function runNpm(
  npm: { cmd: string; binDir: string },
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env);
    env.PATH = npm.binDir + (IS_WIN ? ';' : ':') + (env.PATH || '');
    if (IS_WIN) env.Path = env.PATH;

    let settled = false;
    const finalize = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    let child: any;
    if (IS_WIN) {
      // Windows 下 .cmd 必须经 cmd.exe 执行。
      // 用 cmd.exe /d /s /c + 显式给 npm.cmd 路径加引号 + windowsVerbatimArguments，
      // 避免应用安装在含空格路径（如 C:\\Program Files\\）时路径被拆分。
      // args 中的 pkgName 已经 isValidPackageName 严格校验（无空格、无 shell 元字符），
      // 其余 args 均为硬编码字面量，因此拼接安全。
      const comspec = process.env.ComSpec || 'cmd.exe';
      const inner = '"' + command + '" ' + args.join(' ');
      child = spawn(comspec, ['/d', '/s', '/c', inner], {
        cwd,
        env,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn(command, args, { cwd, env });
    }

    let stderrBuf = Buffer.alloc(0);
    child.stderr?.on('data', (d: Buffer) => { stderrBuf = Buffer.concat([stderrBuf, d]); });
    child.stdout?.on('data', () => {});

    // 超时强制清理进程树
    const timer = setTimeout(() => {
      if (settled) return;
      killTree(child.pid, child);
      finalize(() => reject(new Error('npm install 超时（' + timeoutMs + 'ms）')));
    }, timeoutMs);

    child.on('error', (err: any) => {
      clearTimeout(timer);
      finalize(() => reject(err));
    });
    child.on('close', (code: any) => {
      clearTimeout(timer);
      finalize(() => {
        if (code === 0) resolve();
        else {
          const stderrStr = decodeOutput(stderrBuf);
          reject(new Error('npm install 失败（exit ' + code + '）: ' + stderrStr.slice(-500)));
        }
      });
    });
  });
}

export {
  installCuckooPlugin,
  bundledNpm,
  packageNameToId,
  isValidPackageName,
  injectPluginInstallGate,
  getPluginInstallGate,
};
