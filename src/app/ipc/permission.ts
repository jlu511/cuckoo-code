import { createRequire } from 'node:module';
import { getAccessMode, setAccessMode } from '../../infra/config.js';
import type { AccessMode } from '../../infra/config.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

function registerPermissionIpc(): void {
  ipcMain.handle('get-access-mode', async () => {
    return { success: true, mode: getAccessMode() };
  });

  ipcMain.handle('set-access-mode', async (_event: any, { mode }: any) => {
    if (!['readOnly', 'workspaceWrite', 'fullAccess'].includes(mode)) {
      return { success: false, error: '无效的权限模式' };
    }
    const ok = setAccessMode(mode as AccessMode);
    return { success: ok };
  });
}

export { registerPermissionIpc };
