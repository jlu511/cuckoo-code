'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  guardDelete,
  injectDeleteApprovalHandler,
  hasDeleteApprovalHandler,
} from '../../src/tools/core/delete-guard.js';

const ROOT = path.resolve('D:/proj');
const CWD = ROOT;

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function clearHandler() {
  injectDeleteApprovalHandler(null);
}

// ==================== 无需干预 ====================

test('verdict=none 的命令：直接 execute，不调 handler', async () => {
  clearHandler();
  let called = 0;
  injectDeleteApprovalHandler({
    async requestApproval() {
      called++;
      return 'allow';
    },
  });
  try {
    const r = await guardDelete('rm -rf build', CWD, ROOT, 'cmd');
    assert.strictEqual(r.action, 'execute');
    assert.strictEqual(called, 0);
  } finally {
    clearHandler();
  }
});

test('非删除命令：直接 execute', async () => {
  clearHandler();
  const r = await guardDelete('dir', CWD, ROOT, 'cmd');
  assert.strictEqual(r.action, 'execute');
});

// ==================== handler 未注入 → fail-closed ====================

test('handler 未注入 + 高危删除 → reject', async () => {
  clearHandler();
  const r = await guardDelete('rm -rf D:\\\\', CWD, ROOT, 'cmd');
  assert.strictEqual(r.action, 'reject');
  if (r.action === 'reject') {
    assert.ok(r.text.includes('未注入'));
  }
});

test('hasDeleteApprovalHandler 反映注入状态', async () => {
  clearHandler();
  assert.strictEqual(hasDeleteApprovalHandler(), false);
  injectDeleteApprovalHandler({ async requestApproval() { return 'manual'; } });
  assert.strictEqual(hasDeleteApprovalHandler(), true);
  clearHandler();
});

// ==================== preview + allow ====================

test('preview + allow + recheck 通过 → execute', async () => {
  const root = mkTmp('dg-allow-');
  const target = path.join(root, 'sub');
  fs.mkdirSync(target);
  try {
    injectDeleteApprovalHandler({
      async requestApproval(req) {
        assert.strictEqual(req.allowExecute, true);
        assert.ok(req.preview);
        return 'allow';
      },
    });
    // 目标在工作区外（root 是 cwd，workspace 在 root/ws）
    const r = await guardDelete('rm -rf "' + target + '"', root, path.join(root, 'ws'), 'cmd');
    assert.strictEqual(r.action, 'execute');
  } finally {
    clearHandler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ==================== manual ====================

test('preview + manual → 返回 manual 文本，含「请勿再次尝试删除」', async () => {
  const root = mkTmp('dg-manual-');
  const target = path.join(root, 'sub');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'a.txt'), 'x');
  try {
    injectDeleteApprovalHandler({ async requestApproval() { return 'manual'; } });
    const r = await guardDelete('rm -rf "' + target + '"', root, path.join(root, 'ws'), 'cmd');
    assert.strictEqual(r.action, 'manual');
    if (r.action === 'manual') {
      assert.ok(r.text.includes('请勿再次尝试删除'));
      assert.ok(r.text.includes('未授权'));
    }
  } finally {
    clearHandler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ==================== recheck 失败 ====================

test('recheck 时目标已不存在 → reject', async () => {
  const root = mkTmp('dg-vanish-');
  const target = path.join(root, 'sub');
  fs.mkdirSync(target);
  try {
    injectDeleteApprovalHandler({
      async requestApproval() {
        fs.rmSync(target, { recursive: true, force: true });
        return 'allow';
      },
    });
    const r = await guardDelete('rm -rf "' + target + '"', root, path.join(root, 'ws'), 'cmd');
    assert.strictEqual(r.action, 'reject');
    if (r.action === 'reject') {
      assert.ok(r.text.includes('已不存在') || r.text.includes('无法访问'));
    }
  } finally {
    clearHandler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ==================== unknown 目标 ====================

test('unknown 目标：handler 收到 allowExecute=false，preview=null', async () => {
  clearHandler();
  let gotReq = null;
  injectDeleteApprovalHandler({
    async requestApproval(req) {
      gotReq = req;
      return 'manual';
    },
  });
  try {
    const r = await guardDelete('rm -rf $TARGET', CWD, ROOT, 'cmd');
    assert.strictEqual(r.action, 'manual');
    assert.ok(gotReq);
    assert.strictEqual(gotReq.allowExecute, false);
    assert.strictEqual(gotReq.preview, null);
  } finally {
    clearHandler();
  }
});

// ==================== handler 抛异常 ====================

test('handler 抛异常 → reject', async () => {
  clearHandler();
  injectDeleteApprovalHandler({
    async requestApproval() {
      throw new Error('dialog crashed');
    },
  });
  try {
    const r = await guardDelete('rm -rf D:\\\\', CWD, ROOT, 'cmd');
    assert.strictEqual(r.action, 'reject');
    if (r.action === 'reject') {
      assert.ok(r.text.includes('审批异常'));
    }
  } finally {
    clearHandler();
  }
});
