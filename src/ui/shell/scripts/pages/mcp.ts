/**
 * MCP（连接器）页：列出 server，点击追加"请使用 xxx 这个 MCP"。
 * 支持编辑用户级配置（JSON）。
 */
import { api, escapeHtml, ckAlert, ckConfirm } from '../shared.js';
import { addRecent } from '../recent.js';
import { expandForModal, restoreAfterModal } from '../sidebar.js';

/** 把用户级 server 列表转成主流 mcpServers 格式的 JSON 文本 */
function serversToJson(servers: any[]): string {
  const mcpServers: Record<string, any> = {};
  for (const s of servers) {
    const def: any = {};
    if (s.type === 'http') {
      if (s.url) def.url = s.url;
      if (s.headers) def.headers = s.headers;
    } else {
      if (s.command) def.command = s.command;
      if (s.args && s.args.length) def.args = s.args;
      if (s.env) def.env = s.env;
    }
    mcpServers[s.name] = def;
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

/** 加载用户级配置到 JSON 编辑框 */
async function loadMcpJson(): Promise<void> {
  const el = document.getElementById('mcp-json') as any;
  if (!el || !api.listUserMcpServers) return;
  try {
    const r = await api.listUserMcpServers();
    const servers = (r && r.success) ? r.servers : [];
    el.value = serversToJson(servers || []);
  } catch (_) {
    el.value = '{\n  "mcpServers": {}\n}';
  }
}

/** 保存 JSON 编辑框里的用户级配置 */
async function saveMcpJson(): Promise<boolean> {
  const el = document.getElementById('mcp-json') as any;
  if (!el || !String(el.value).trim()) {
    await ckAlert('请输入配置');
    return false;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(el.value);
  } catch (err: any) {
    await ckAlert('JSON 解析失败: ' + (err.message || err));
    return false;
  }
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) {
    await ckAlert('配置格式错误，需要 mcpServers 对象');
    return false;
  }
  // 逐项校验，发现错误立即中止（不删旧配置）
  for (const [name, def] of Object.entries(parsed.mcpServers) as [string, any][]) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      await ckAlert('配置错误：server "' + name + '" 的定义必须是对象');
      return false;
    }
    const hasUrl = def.url !== undefined;
    const hasCommand = def.command !== undefined;
    if (hasUrl) {
      if (typeof def.url !== 'string' || !def.url.trim()) {
        await ckAlert('配置错误：server "' + name + '" 的 url 必须是非空字符串');
        return false;
      }
      if (hasCommand) {
        await ckAlert('配置错误：server "' + name + '" 不能同时指定 url 和 command');
        return false;
      }
    } else if (hasCommand) {
      if (typeof def.command !== 'string' || !def.command.trim()) {
        await ckAlert('配置错误：server "' + name + '" 的 command 必须是非空字符串');
        return false;
      }
    } else {
      await ckAlert('配置错误：server "' + name + '" 缺少 command 或 url');
      return false;
    }
    if (def.args !== undefined && !Array.isArray(def.args)) {
      await ckAlert('配置错误：server "' + name + '" 的 args 必须是数组');
      return false;
    }
    if (def.env !== undefined && (typeof def.env !== 'object' || def.env === null || Array.isArray(def.env))) {
      await ckAlert('配置错误：server "' + name + '" 的 env 必须是对象');
      return false;
    }
    if (def.headers !== undefined && (typeof def.headers !== 'object' || def.headers === null || Array.isArray(def.headers))) {
      await ckAlert('配置错误：server "' + name + '" 的 headers 必须是对象');
      return false;
    }
  }

  if (!api.upsertMcpServer || !api.removeMcpServer) {
    await ckAlert('当前版本不支持保存 MCP 配置');
    return false;
  }

  try {
    // 先删除 JSON 里不存在的旧 server（只针对用户级，避免误删项目级）
    const oldRes = await api.listUserMcpServers!();
    const oldServers = (oldRes && oldRes.success && oldRes.servers) || [];
    const newNames = new Set(Object.keys(parsed.mcpServers));
    for (const old of oldServers) {
      if (!newNames.has(old.name)) {
        await api.removeMcpServer!(old.name);
      }
    }
    // 逐个 upsert
    for (const [name, def] of Object.entries(parsed.mcpServers) as [string, any][]) {
      const server = {
        name,
        type: def && def.url ? 'http' : 'stdio',
        command: def && def.command,
        args: (def && def.args) || [],
        url: def && def.url,
        headers: def && def.headers,
        env: def && def.env,
      };
      await api.upsertMcpServer!(server);
    }
    await ckAlert('配置已保存');
    await loadMcpServers();
    await loadMcpJson();
    return true;
  } catch (err: any) {
    await ckAlert('保存失败: ' + (err.message || err));
    return false;
  }
}

export async function loadMcpServers(): Promise<void> {
  const listEl = document.getElementById('mcp-list');
  if (!listEl || !api.listMcpServers) return;
  try {
    const r = await api.listMcpServers();
    const servers = (r && r.success) ? r.servers : [];
    if (!servers || servers.length === 0) {
      listEl.innerHTML = '<div class="ck-list-empty">未配置 MCP server</div>';
      return;
    }
    const cardHtml = (s: any) => {
      const dotCls = s.connected ? 'ck-mcp-dot on' : 'ck-mcp-dot';
      const isEnabled = s.enabled !== false;
      return '<div class="ck-mcp-item" data-name="' + escapeHtml(s.name) + '">' +
        '<div class="ck-mcp-top">' +
          '<span class="' + dotCls + '"></span>' +
          '<span class="ck-mcp-name">' + escapeHtml(s.name) + '</span>' +
          '<label class="ck-switch" style="margin-left:auto; flex-shrink:0;" onclick="event.stopPropagation()">' +
            '<input type="checkbox" class="mcp-toggle" ' + (isEnabled ? 'checked' : '') + ' />' +
            '<span class="ck-switch-track"></span>' +
          '</label>' +
        '</div>' +
        '<div class="ck-mcp-bottom">' +
          '<span class="ck-mcp-tag">' + escapeHtml(s.type || 'stdio') + '</span>' +
          '<span class="ck-mcp-tag">' + (s.toolCount || 0) + ' 工具</span>' +
        '</div>' +
      '</div>';
    };
    const userServers = servers.filter((s: any) => s.source !== 'project');
    const projServers = servers.filter((s: any) => s.source === 'project');
    let html = '';
    if (userServers.length) html += '<div class="ck-mcp-group-title">用户级</div>' + userServers.map(cardHtml).join('');
    if (projServers.length) html += '<div class="ck-mcp-group-title">项目级</div>' + projServers.map(cardHtml).join('');
    listEl.innerHTML = html;
    listEl.querySelectorAll('.ck-mcp-item').forEach((el: any) => {
      const name = el.dataset.name;
      const toggle = el.querySelector('.mcp-toggle') as HTMLInputElement;

      if (toggle) {
        toggle.addEventListener('change', async (e: Event) => {
          e.stopPropagation();
          const isChecked = toggle.checked;
          try {
            if (isChecked) {
              if (api.enableMcpServer) await api.enableMcpServer(name);
            } else {
              if (api.disableMcpServer) await api.disableMcpServer(name);
            }
            await loadMcpServers(); // 刷新状态
          } catch (err: any) {
            toggle.checked = !isChecked; // 回滚
            await ckAlert('切换状态失败: ' + (err.message || err));
          }
        });
      }

      el.addEventListener('click', async () => {
        if (api.appendSnippet) {
          try { await api.appendSnippet('请使用 ' + name + ' 这个 MCP'); } catch (_) { /* ignore */ }
        }
        addRecent('mcp', name);
      });
    });
  } catch (_) {
    listEl.innerHTML = '<div class="ck-list-empty">加载失败</div>';
  }
}

document.getElementById('mcp-refresh')?.addEventListener('click', loadMcpServers);

// 弹窗逻辑
const mcpModal = document.getElementById('mcp-modal');

function closeMcpModal() {
  if (!mcpModal) return;
  mcpModal.classList.add('cuckoo-hidden');
  restoreAfterModal();
}

document.getElementById('mcp-edit-toggle')?.addEventListener('click', async () => {
  if (!mcpModal) return;
  expandForModal();
  await loadMcpJson();
  mcpModal.classList.remove('cuckoo-hidden');
});

document.getElementById('mcp-modal-cancel')?.addEventListener('click', closeMcpModal);

document.getElementById('mcp-modal-save')?.addEventListener('click', async () => {
  const ok = await ckConfirm('保存将覆盖用户级 MCP 配置，确定继续？', '确认保存');
  if (!ok) return;
  const success = await saveMcpJson();
  if (success) {
    closeMcpModal();
  }
});
