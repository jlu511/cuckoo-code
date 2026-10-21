/**
 * Cuckoo 插件（DSH 兼容）主进程集成：
 *   installAndLoad(pkgName)  —— npm 下载 + 加载 + 注册工具
 *   loadEnabledPlugins()     —— 启动时加载所有已启用插件
 *
 * 依赖方向：本模块在 plugins 层（纯 node + esbuild + 工具注册表）。
 */
import { Tool } from '../../tools/core/Tool.js';
import { installCuckooPlugin } from './installer.js';
import fs from 'node:fs';
import { loadCuckooPlugin } from './loader.js';
import type { CuckooHost } from './loader.js';
import { listCuckooPluginDirs, getCuckooPluginDir, isValidPluginId } from './paths.js';
import { isCuckooPluginEnabled, setCuckooPluginEnabled, clearCuckooPluginState } from './state.js';

/**
 * 从 JSON Schema 生成 JS 调用签名（供提示词），展开嵌套结构——
 * 如 todo_write(todos: {content: string, status: 'pending'|'in_progress'|'completed'}[])
 * AI 看签名就懂参数结构，减少误传。
 */
function typeOf(spec: any, depth: number): string {
  if (!spec || typeof spec !== 'object' || depth > 3) return 'any';
  const t = spec.type;
  if (Array.isArray(spec.enum)) {
    return spec.enum.map((v: any) => JSON.stringify(v)).join('|');
  }
  if (t === 'array') {
    const inner = spec.items ? typeOf(spec.items, depth + 1) : 'any';
    // 对象数组用 (…)[]，简单类型用 string[] 更简洁
    return /[{}()|]/.test(inner) ? '(' + inner + ')[]' : inner + '[]';
  }
  if (t === 'object') {
    const props = spec.properties || {};
    const req: string[] = spec.required || [];
    const inner = Object.keys(props).map((k) => k + (req.includes(k) ? '' : '?') + ': ' + typeOf(props[k], depth + 1));
    return '{' + inner.join(', ') + '}';
  }
  if (t === 'integer') return 'number';
  return t || 'any';
}

/** 生成 JS 调用签名，如 greet(name: string, age?: number) */
function buildJsApi(name: string, parameters: any): string {
  const props = (parameters && parameters.properties) || {};
  const required: string[] = (parameters && parameters.required) || [];
  const parts = Object.keys(props).map((k) => {
    const opt = required.includes(k) ? '' : '?';
    return k + opt + ': ' + typeOf(props[k], 0);
  });
  return name + '(' + parts.join(', ') + ')';
}

/** 把 DSH 插件工具（{name,description,parameters,execute}）包成 Cuckoo Tool */
class DshPluginTool extends Tool {
  private _exec: (args: any) => Promise<any>;
  constructor(def: any) {
    super(def.name, def.description, def.parameters, buildJsApi(def.name, def.parameters));
    this._exec = def.execute;
    this.dynamic = true; // 运行时工具：沙箱注入 + 提示词由运行期生成
  }
  async execute(params: any): Promise<any> {
    // Cuckoo 工具约定：返回 { success, data }
    const out = await this._exec(params);
    return { success: true, data: typeof out === 'string' ? out : JSON.stringify(out) };
  }
  getPromptSection() {
    return { name: 'tool:' + this.name, order: 200, text: '使用 ' + this.jsApi + ' 工具：' + this.description };
  }
}

/** 已加载的插件工具名（供沙箱注入用） */
const loadedPluginTools = new Set<string>();

/** 从插件目录加载并注册工具到 registry */
async function loadPluginFromDir(dir: string, registry: any, host?: CuckooHost): Promise<{ pluginName: string; tools: string[] }> {
  const { pluginName, tools } = await loadCuckooPlugin(dir, host);
  const names: string[] = [];
  for (const def of tools) {
    if (!def || typeof def.name !== 'string') continue;
    registry.register(new DshPluginTool(def));
    loadedPluginTools.add(def.name);
    names.push(def.name);
  }
  return { pluginName, tools: names };
}

/** 安装（npm 下载）+ 加载 + 注册 */
async function installAndLoad(pkgName: string, registry: any, host?: CuckooHost, windowId?: number): Promise<{ id: string; pluginName: string; tools: string[] }> {
  if (typeof windowId !== 'number') {
    throw new Error('拒绝安装插件：缺少可信的窗口 ID');
  }
  const { id, dir } = await installCuckooPlugin(pkgName, windowId);
  try {
    const r = await loadPluginFromDir(dir, registry, host);
    setCuckooPluginEnabled(id, true);
    return { id, pluginName: r.pluginName, tools: r.tools };
  } catch (err: any) {
    // 加载失败：抛出友好错误，并提示用户包下载成功但可能不是合法的插件
    const msg = err && err.message ? err.message : String(err);
    throw new Error('插件下载成功，但加载失败（可能不是合法的 Cuckoo 插件）: ' + msg);
  }
}

/** 启动时加载所有"已启用"的插件 */
async function loadEnabledPlugins(registry: any, host?: CuckooHost): Promise<{ loaded: string[]; failed: { id: string; error: string }[] }> {
  const loaded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const dir of listCuckooPluginDirs()) {
    const id = dir.split(/[\\/]/).pop() || '';
    if (!isValidPluginId(id) || !isCuckooPluginEnabled(id)) continue;
    try {
      const r = await loadPluginFromDir(dir, registry, host);
      loaded.push(id + '(' + r.pluginName + '):' + r.tools.join(','));
    } catch (err: any) {
      failed.push({ id, error: err && err.message ? err.message : String(err) });
    }
  }
  return { loaded, failed };
}

/** 卸载插件（删除目录 + 清状态；工具暂不动态移除，重启生效） */
function uninstallCuckooPlugin(id: string): boolean {
  if (!isValidPluginId(id)) return false;
  clearCuckooPluginState(id);
  const dir = getCuckooPluginDir(id);
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err: any) {
      console.error('[Plugin] 删除插件目录失败:', err.message);
      return false;
    }
  }
  return true;
}

export { installAndLoad, loadEnabledPlugins, loadPluginFromDir, uninstallCuckooPlugin, loadedPluginTools, DshPluginTool };
export { injectPluginInstallGate, getPluginInstallGate } from './installer.js';
export { DefaultPluginInstallGate } from './default-install-gate.js';
