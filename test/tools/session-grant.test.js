import { test, expect } from 'vitest';
import { SandboxExecutor } from '../../src/tools/core/executor.js';
import { injectSafetyChecker } from '../../src/tools/core/safety-precheck.js';

injectSafetyChecker(async () => ({ kind: 'allow' }));

const makeReq = (cmd = 'npm run build') => ({
  type: 'shell', shellType: 'cmd', rawCommand: cmd, cwd: 'D:\\\\', env: {},
});

const okRunner = () => {
  const r = { calls: 0, run: async () => { r.calls++; return { stdout: 'ok', stderr: '', exitCode: 0 }; } };
  return r;
};

/** 可编程审批处理器：记录调用次数与收到的 DTO */
const makeHandler = (decisions = ['allow_once']) => {
  const h = {
    calls: 0,
    dtos: [],
    requestApproval: async (dto) => {
      h.calls++;
      h.dtos.push(JSON.parse(JSON.stringify({ canAllowSession: dto.canAllowSession, riskLevel: dto.riskLevel })));
      const d = decisions[Math.min(h.calls - 1, decisions.length - 1)];
      return d;
    },
  };
  return h;
};

const fixedResolver = (id) => () => id;

// ============ 核心：会话授权复用 ============

test('032 同会话同请求两次：第二次不弹窗', async () => {
  const handler = makeHandler(['allow_session']);
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);
  const gen = () => 1;
  const req = makeReq();

  await ex.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'), gen, 'scope-test', 1);
  await ex.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'), gen, 'scope-test', 1);

  expect(handler.calls).toBe(1);
  expect(runner.calls).toBe(2);
  expect(ex.getSessionGrantCount()).toBe(1);
});

test('032 不同 cwd：指纹不同，各自弹窗', async () => {
  const handler = makeHandler(['allow_session', 'allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  const gen = () => 1;

  await ex.execute({ ...makeReq(), cwd: 'D:\\\\a' }, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
  await ex.execute({ ...makeReq(), cwd: 'D:\\\\b' }, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);

  expect(handler.calls).toBe(2);
});

test('032 不同 env：指纹不同，各自弹窗', async () => {
  const handler = makeHandler(['allow_session', 'allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  const gen = () => 1;

  await ex.execute({ ...makeReq(), env: {} }, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
  await ex.execute({ ...makeReq(), env: { PATH: 'C:\\\\evil' } }, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);

  expect(handler.calls).toBe(2);
});

test('032 env 键顺序不同：指纹相同（稳定序列化）', async () => {
  const handler = makeHandler(['allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  const gen = () => 1;

  await ex.execute({ ...makeReq(), env: { A: '1', B: '2' } }, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
  await ex.execute({ ...makeReq(), env: { B: '2', A: '1' } }, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);

  expect(handler.calls).toBe(1);
});

test('032 不同 timeoutMs：指纹不同', async () => {
  const handler = makeHandler(['allow_session', 'allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  const gen = () => 1;

  await ex.execute({ ...makeReq(), timeoutMs: 1000 }, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
  await ex.execute({ ...makeReq(), timeoutMs: 2000 }, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);

  expect(handler.calls).toBe(2);
});

test('032 会话 A→B→A：旧授权不可恢复', async () => {
  const handler = makeHandler(['allow_session', 'allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  const req = makeReq();
  let generation = 1;
  const gen = () => generation;

  await ex.execute(req, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
  expect(handler.calls).toBe(1);

  // A -> B
  generation++;
  // B -> A
  generation++;

  await ex.execute(req, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
  expect(handler.calls).toBe(2);
});

test('032 同一会话内 generation 不变：授权继续有效', async () => {
  const handler = makeHandler(['allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  const gen = () => 7;
  const req = makeReq();

  await ex.execute(req, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
  await ex.execute(req, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
  await ex.execute(req, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);

  expect(handler.calls).toBe(1);
});

// ============ 资格判定：不应出现第三个按钮 ============

test('032 L3 敏感路径：canAllowSession 为 false', async () => {
  const handler = makeHandler(['deny']);
  const ex = new SandboxExecutor(handler, okRunner());
  const gen = () => 1;

  await ex.execute(makeReq('type C:\\\\Users\\\\x\\\\.ssh\\\\id_rsa'), 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1).catch(() => {});

  expect(handler.dtos[0].canAllowSession).toBe(false);
  expect(handler.dtos[0].riskLevel).toBe('L3');
});

test('032 git push / commit / checkout：canAllowSession 为 false', async () => {
  const gen = () => 1;
  for (const cmd of ['git push origin dev', 'git commit -m x', 'git checkout -b feat/x', 'git -C repo push', 'git.exe commit -m x']) {
    const handler = makeHandler(['deny']);
    const ex = new SandboxExecutor(handler, okRunner());
    await ex.execute(makeReq(cmd), 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1).catch(() => {});
    expect(handler.dtos[0].canAllowSession, cmd).toBe(false);
  }
});

test('032 高危命令：canAllowSession 为 false', async () => {
  const gen = () => 1;
  for (const cmd of ['rm -rf /tmp/x', 'del /f /s /q C:\\\\x', 'format D:', 'Remove-Item -Recurse C:\\\\x']) {
    const handler = makeHandler(['deny']);
    const ex = new SandboxExecutor(handler, okRunner());
    await ex.execute(makeReq(cmd), 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1).catch(() => {});
    expect(handler.dtos[0].canAllowSession, cmd).toBe(false);
  }
});

test('032 命令链 / 管道：canAllowSession 为 false', async () => {
  const gen = () => 1;
  for (const cmd of ['npm run a && npm run b', 'npm test | findstr x', 'echo hi > out.txt']) {
    const handler = makeHandler(['deny']);
    const ex = new SandboxExecutor(handler, okRunner());
    await ex.execute(makeReq(cmd), 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1).catch(() => {});
    expect(handler.dtos[0].canAllowSession, cmd).toBe(false);
  }
});

test('032 普通 L2 命令：canAllowSession 为 true', async () => {
  const handler = makeHandler(['allow_once']);
  const ex = new SandboxExecutor(handler, okRunner());
  await ex.execute(makeReq('npm run build'), 't', 'sA', fixedResolver('sA'), () => 1, 'scope-test', 1);
  expect(handler.dtos[0].canAllowSession).toBe(true);
});

// ============ 代次非法 / 未注入 ============

test('032 未注入 generation provider：canAllowSession 为 false，不缓存', async () => {
  const handler = makeHandler(['allow_once', 'allow_once']);
  const ex = new SandboxExecutor(handler, okRunner());
  const req = makeReq();

  await ex.execute(req, 't', 'sA', fixedResolver('sA'));
  await ex.execute(req, 't', 'sA', fixedResolver('sA'));

  expect(handler.calls).toBe(2);
  expect(handler.dtos[0].canAllowSession).toBe(false);
  expect(ex.getSessionGrantCount()).toBe(0);
});

test('032 非法 generation（小数 / Infinity / 负数 / NaN）：禁用会话授权', async () => {
  for (const bad of [1.5, Infinity, -1, NaN]) {
    const handler = makeHandler(['allow_once', 'allow_once']);
    const ex = new SandboxExecutor(handler, okRunner());
    const req = makeReq();
    const gen = () => bad;
    await ex.execute(req, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
    await ex.execute(req, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
    expect(handler.calls, String(bad)).toBe(2);
    expect(handler.dtos[0].canAllowSession, String(bad)).toBe(false);
  }
});

test('032 generation provider 抛异常：禁用会话授权', async () => {
  const handler = makeHandler(['allow_once']);
  const ex = new SandboxExecutor(handler, okRunner());
  await ex.execute(makeReq(), 't', 'sA', fixedResolver('sA'), () => { throw new Error('boom'); });
  expect(handler.dtos[0].canAllowSession).toBe(false);
});

// ============ 安全边界：缓存不能绕过硬性检查 ============

test('032 缓存命中仍执行 CCSN 检查（deny 时拒绝）', async () => {
  const handler = makeHandler(['allow_session']);
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);
  const gen = () => 1;
  const req = makeReq();

  // 第一次 allow + 写入缓存
  await ex.execute(req, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
  expect(runner.calls).toBe(1);

  // 第二次：CCSN 改为 deny，应拒绝且不执行
  injectSafetyChecker(async () => ({ kind: 'deny', reason: 'now blocked', ruleId: 'test.deny' }));
  await expect(ex.execute(req, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1)).rejects.toThrow(/now blocked/);
  expect(runner.calls).toBe(1);

  injectSafetyChecker(async () => ({ kind: 'allow' }));
});

test('032 用户拒绝时不写入缓存', async () => {
  const handler = makeHandler(['deny']);
  const ex = new SandboxExecutor(handler, okRunner());
  await expect(ex.execute(makeReq(), 't', 'sA', fixedResolver('sA'), () => 1)).rejects.toThrow();
  expect(ex.getSessionGrantCount()).toBe(0);
});

test('032 handler 伪造 allow_session（canAllowSession=false）：fail-closed', async () => {
  const handler = makeHandler(['allow_session']);
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);
  // git push 禁止会话授权，但 handler 仍返回 allow_session
  await expect(
    ex.execute(makeReq('git push origin dev'), 't', 'sA', fixedResolver('sA'), () => 1)
  ).rejects.toThrow(/不允许会话授权/);
  expect(runner.calls).toBe(0);
  expect(ex.getSessionGrantCount()).toBe(0);
});

// ============ 审批期间会话/代次变化 ============

test('032 审批期间代次变化：请求作废且不缓存', async () => {
  let generation = 1;
  const gen = () => generation;
  const handler = {
    calls: 0,
    requestApproval: async () => {
      handler.calls++;
      generation++;  // 审批期间 A->B
      return 'allow_session';
    },
  };
  const runner = okRunner();
  const ex = new SandboxExecutor(handler, runner);

  await expect(
    ex.execute(makeReq(), 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1)
  ).rejects.toThrow(/代次已变化/);

  expect(runner.calls).toBe(0);
  expect(ex.getSessionGrantCount()).toBe(0);
});

test('032 审批期间会话切换：请求作废', async () => {
  let sid = 'sA';
  const handler = {
    calls: 0,
    requestApproval: async () => { handler.calls++; sid = 'sB'; return 'allow_session'; },
  };
  const ex = new SandboxExecutor(handler, okRunner());

  await expect(
    ex.execute(makeReq(), 't', 'sA', () => sid, () => 1, 'scope-test', 1)
  ).rejects.toThrow(/会话已切换/);
});

// ============ 并发语义保持 ============

test('032 同请求并发：第二个被拒绝（不重复执行）', async () => {
  const handler = makeHandler(['allow_session']);
  const runner = {
    calls: 0,
    run: async () => { runner.calls++; await new Promise((r) => setTimeout(r, 40)); return { stdout: 'ok', stderr: '', exitCode: 0 }; },
  };
  const ex = new SandboxExecutor(handler, runner);
  const gen = () => 1;
  const req = makeReq();

  const p1 = ex.execute(req, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
  await expect(ex.execute(req, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1)).rejects.toThrow(/正在审批或执行中/);
  await p1;

  expect(runner.calls).toBe(1);
});

test('032 clearSessionGrants 清空缓存', async () => {
  const handler = makeHandler(['allow_session', 'allow_session']);
  const ex = new SandboxExecutor(handler, okRunner());
  const gen = () => 1;
  const req = makeReq();

  await ex.execute(req, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
  expect(ex.getSessionGrantCount()).toBe(1);
  ex.clearSessionGrants();
  expect(ex.getSessionGrantCount()).toBe(0);

  await ex.execute(req, 't', 'sA', fixedResolver('sA'), gen, 'scope-test', 1);
  expect(handler.calls).toBe(2);
});