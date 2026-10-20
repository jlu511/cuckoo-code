/**
 * 权限设置页面
 */
import { api, ckAlert } from '../shared.js';

export async function loadPermission(): Promise<void> {
  if (!api.getAccessMode) return;
  try {
    const r = await api.getAccessMode();
    if (r && r.success) {
      const radios = document.querySelectorAll('input[name="access-mode"]') as NodeListOf<HTMLInputElement>;
      radios.forEach(radio => {
        radio.checked = (radio.value === r.mode);
      });
    }
  } catch (_) { /* ignore */ }
}

// 绑定切换事件（只绑定一次）
const radios = document.querySelectorAll('input[name="access-mode"]') as NodeListOf<HTMLInputElement>;
radios.forEach(radio => {
  radio.addEventListener('change', async (e: any) => {
    if (!api.setAccessMode) return;
    const mode = e.target.value;
    try {
      const r = await api.setAccessMode(mode);
      if (!r || !r.success) {
        await ckAlert('设置权限失败');
        loadPermission(); // 恢复
      }
    } catch (err: any) {
      await ckAlert('设置权限失败: ' + (err.message || err));
      loadPermission();
    }
  });
});
