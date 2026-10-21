import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => (id) => {
      if (id === 'electron') {
        return {
          app: {
            isPackaged: false,
            getAppPath: () => 'C:/app',
            getPath: () => 'C:/ud',
          },
        };
      }
      return actual.createRequire(import.meta.url)(id);
    },
  };
});

// 为了让插件目录指向临时目录，需要重设 CUCKOO_HOME
const TMP = path.join(os.tmpdir(), 'cuckoo-plugin-uninstall-test');
let oldHome;

beforeEach(() => {
  oldHome = process.env.CUCKOO_HOME;
  process.env.CUCKOO_HOME = TMP;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'cuckoo-plugins', 'demo-plugin'), { recursive: true });
  // 随便写点内容，证明目录非空
  fs.writeFileSync(path.join(TMP, 'cuckoo-plugins', 'demo-plugin', 'package.json'), '{}');
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.CUCKOO_HOME;
  else process.env.CUCKOO_HOME = oldHome;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('uninstallCuckooPlugin: 真实删除插件目录 + 清理状态', async () => {
  const indexMod = await import('../../src/plugins/cuckoo-plugins/index.js');
  const stateMod = await import('../../src/plugins/cuckoo-plugins/state.js');
  
  const pluginDir = path.join(TMP, 'cuckoo-plugins', 'demo-plugin');
  expect(fs.existsSync(pluginDir)).toBe(true);

  stateMod.setCuckooPluginEnabled('demo-plugin', true);
  expect(stateMod.isCuckooPluginEnabled('demo-plugin')).toBe(true);

  const ok = indexMod.uninstallCuckooPlugin('demo-plugin');
  expect(ok).toBe(true);

  // 目录应被彻底删除
  expect(fs.existsSync(pluginDir)).toBe(false);
  // 状态应被清理
  expect(stateMod.isCuckooPluginEnabled('demo-plugin')).toBe(false);
});

test('uninstallCuckooPlugin: 非法 id 直接拒绝，不抛异常', async () => {
  const { uninstallCuckooPlugin } = await import('../../src/plugins/cuckoo-plugins/index.js');
  const ok = uninstallCuckooPlugin('../evil');
  expect(ok).toBe(false);
});
