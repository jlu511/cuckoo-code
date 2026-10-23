import { test, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createSessionStore } from '../../src/session/store.js';

/** 构造一个最小 windowState 桩（session store 需要它解析 view / 发消息） */
const makeWindowState = () => ({
  getMainContext: () => null,
  getContextByWebContents: () => null,
});

const makeStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-032-'));
  const store = createSessionStore('profile-test', dir, makeWindowState());
  return { store, dir };
};

test('032 invalidateSessionGeneration 递增 generation', () => {
  const { store, dir } = makeStore();
  try {
    const before = store.state.sessionGeneration;
    store.invalidateSessionGeneration();
    expect(store.state.sessionGeneration).toBe(before + 1);
    store.invalidateSessionGeneration();
    expect(store.state.sessionGeneration).toBe(before + 2);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('032 会话 ID 变化时 generation 递增', () => {
  const { store, dir } = makeStore();
  try {
    const g0 = store.state.sessionGeneration;
    store.handleUrlChange('https://chat.deepseek.com/a/chat/s/aaaa-1111');
    const g1 = store.state.sessionGeneration;
    expect(g1).toBe(g0 + 1);

    // 同一会话的 URL 变化（同 sessionId）→ generation 不变
    store.handleUrlChange('https://chat.deepseek.com/a/chat/s/aaaa-1111?x=1');
    expect(store.state.sessionGeneration).toBe(g1);

    // 切换到另一会话 → 递增
    store.handleUrlChange('https://chat.deepseek.com/a/chat/s/bbbb-2222');
    expect(store.state.sessionGeneration).toBe(g1 + 1);

    // 回到第一个会话 → 仍递增（A→B→A 场景）
    store.handleUrlChange('https://chat.deepseek.com/a/chat/s/aaaa-1111');
    expect(store.state.sessionGeneration).toBe(g1 + 2);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('032 窗口关闭后重建同一会话：generation 不同（旧授权不可恢复）', () => {
  const { store, dir } = makeStore();
  const URL = 'https://chat.deepseek.com/a/chat/s/cccc-3333';
  try {
    store.handleUrlChange(URL);
    const sidWindow1 = store.state.currentSessionId;
    const gWindow1 = store.state.sessionGeneration;
    expect(sidWindow1).toBeTruthy();

    // 模拟窗口关闭
    store.invalidateSessionGeneration();
    const gAfterClose = store.state.sessionGeneration;
    expect(gAfterClose).toBeGreaterThan(gWindow1);

    // 重建窗口后恢复同一 sessionId（sessionId 相同，但 generation 已不同）
    store.handleUrlChange(URL);
    const gWindow2 = store.state.sessionGeneration;

    // 关键：sessionId 相同，但 generation 不同 → 会话授权键不同 → 旧授权不可恢复
    expect(store.state.currentSessionId).toBe(sidWindow1);
    expect(gWindow2).toBeGreaterThan(gWindow1);
    expect(gWindow2).not.toBe(gWindow1);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});