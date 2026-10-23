import { test, expect, beforeAll } from 'vitest';
import { SandboxExecutor } from '../../src/tools/core/executor.js';
import { injectSafetyChecker } from '../../src/tools/core/safety-precheck.js';

// 测试环境注入放行检查器（安全预检本身有独立测试覆盖）
beforeAll(() => {
  injectSafetyChecker(async () => ({ kind: 'allow' }));
});

// ============ 通用 helpers ============

function makeReq(rawCommand = 'echo hi') {
  return { type: 'shell', shellType: 'cmd', rawCommand, cwd: 'D:\\', env: {} };
}

const okRunner = () => {
  const runner = {
    calls: 0,
    run: async () => {
      runner.calls++;
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    }
  };
  return runner;
};

const okHandler = () => ({ requestApproval: async () => 'allow_once' });

/** 固定返回同一个会话 ID 的 resolver */
const fixedResolver = (id) => () => id;

// ============ TC-08：并发去重 ============

test('TC-08: 相同 taskId + 相同请求并发 execute，最多启动一次进程', async () => {
  const runner = {
    calls: 0,
    run: async () => {
      runner.calls++;
      await new Promise((r) => setTimeout(r, 30));
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    }
  };
  const executor = new SandboxExecutor(okHandler(), runner);
  const req = makeReq('echo concurrent');
  const resolver = fixedResolver('sessionA');

  const p1 = executor.execute(req, 'taskA', 'sessionA', resolver);
  const p2 = executor.execute(req, 'taskA', 'sessionA', resolver);

  await expect(p2).rejects.toThrow(/正在审批或执行中/);

  const r1 = await p1;
  expect(r1.exitCode).toBe(0);
  expect(runner.calls).toBe(1);
});

// ============ TC-09：pending 过期 ============

test('TC-09: pending 超过 TTL 后返回审批结果，必须拒绝且不启动进程', async () => {
  const runner = okRunner();
  const slowHandler = {
    requestApproval: async () => {
      await new Promise((r) => setTimeout(r, 200));
      return 'allow_once';
    }
  };

  const executor = new SandboxExecutor(slowHandler, runner, undefined, { pendingTtlMs: 50 });
  const req = makeReq('echo expire-test');

  await expect(executor.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'))).rejects.toThrow(/已过期/);
  expect(runner.calls).toBe(0);
});

// ============ TC-10：DTO 篡改不影响执行 ============

test('TC-10: 前端篡改 DTO 不影响内部执行的请求', async () => {
  let capturedCmd = '';
  const mockHandler = {
    requestApproval: async (dto) => {
      dto.request.rawCommand = 'rm -rf / (tampered)';
      return 'allow_once';
    }
  };
  const runner = {
    run: async (req) => {
      capturedCmd = req.rawCommand;
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    }
  };

  const executor = new SandboxExecutor(mockHandler, runner);
  await executor.execute(makeReq('echo safe'), 'taskA', 'sessionA', fixedResolver('sessionA'));

  expect(capturedCmd).toBe('echo safe');
  expect(capturedCmd).not.toBe('rm -rf / (tampered)');
});

// ============ TC-11：主动取消 ============

test('TC-11: 主动取消后状态为 cancelled，且不会误判为 timed_out', async () => {
  const slowRunner = {
    run: (req, signal) => {
      return new Promise((resolve) => {
        if (signal.aborted) {
          return resolve({ stdout: '', stderr: '', exitCode: -1, isCancelled: true });
        }
        signal.addEventListener('abort', () => {
          resolve({ stdout: '', stderr: '', exitCode: -1, isCancelled: true });
        });
      });
    }
  };

  let snapId = '';
  const captureHandler = {
    requestApproval: async (dto) => {
      snapId = dto.id;
      return 'allow_once';
    }
  };

  const executor = new SandboxExecutor(captureHandler, slowRunner);
  const p = executor.execute(makeReq('ping -t 127.0.0.1'), 'taskA', 'sessionA', fixedResolver('sessionA'));
  await new Promise((r) => setTimeout(r, 20));

  expect(executor.cancel(snapId)).toBe(true);
  const result = await p;
  expect(result.isCancelled).toBe(true);
  expect(result.isTimeout).toBeUndefined();
});

// ============ 拒绝熔断：按 taskId 隔离 ============

test('拒绝熔断：同一 taskId 拒绝后重试被拦截，不同 taskId 互不影响', async () => {
  let denyCount = 0;
  const handler = {
    requestApproval: async () => {
      denyCount++;
      return 'deny';
    }
  };
  const executor = new SandboxExecutor(handler, okRunner());
  const req = makeReq('del /q test.txt');

  await expect(executor.execute(req, 'taskA', 'sessA', fixedResolver('sessA'))).rejects.toThrow('用户拒绝了此操作。');
  expect(denyCount).toBe(1);

  await expect(executor.execute(req, 'taskA', 'sessA', fixedResolver('sessA'))).rejects.toThrow(/已被拒绝/);
  expect(denyCount).toBe(1);

  await expect(executor.execute(req, 'taskB', 'sessB', fixedResolver('sessB'))).rejects.toThrow('用户拒绝了此操作。');
  expect(denyCount).toBe(2);
});

// ============ 审计日志脱敏 ============

test('审计日志：敏感 env 值被 [REDACTED]，原始值不出现', async () => {
  const logs = [];
  const logger = {
    log: (snap) => {
      logs.push(JSON.parse(JSON.stringify(snap)));
    }
  };

  const executor = new SandboxExecutor(okHandler(), okRunner(), logger);

  const req = {
    type: 'shell',
    shellType: 'cmd',
    rawCommand: 'echo hello',
    cwd: 'D:\\',
    env: {
      GITHUB_TOKEN: 'ghp_realsecret123',
      API_KEY: 'sk-live-deadbeef',
      NORMAL_VAR: 'keep-me',
    },
  };

  await executor.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'));

  const execLog = logs.find((l) => l.id !== 'pre-check' && l.request && l.request.env);
  expect(execLog).toBeTruthy();

  expect(execLog.request.env.GITHUB_TOKEN).toBe('[REDACTED]');
  expect(execLog.request.env.API_KEY).toBe('[REDACTED]');
  expect(execLog.request.env.NORMAL_VAR).toBe('keep-me');

  const serialized = JSON.stringify(logs);
  expect(serialized).not.toContain('ghp_realsecret123');
  expect(serialized).not.toContain('sk-live-deadbeef');
});

// ============ 会话校验（Phase 1.2a） ============

test('会话校验：活动会话与请求会话一致时正常执行', async () => {
  const runner = okRunner();
  const executor = new SandboxExecutor(okHandler(), runner);
  const r = await executor.execute(makeReq('echo hi'), 'taskA', 'sessionA', fixedResolver('sessionA'));
  expect(r.exitCode).toBe(0);
  expect(runner.calls).toBe(1);
});

test('会话校验：审批前活动会话与请求会话不一致 → 拒绝，不弹窗不执行', async () => {
  const runner = okRunner();
  let handlerCalls = 0;
  const handler = { requestApproval: async () => { handlerCalls++; return 'allow_once'; } };
  const executor = new SandboxExecutor(handler, runner);

  await expect(
    executor.execute(makeReq('echo hi'), 'taskA', 'sessionA', fixedResolver('sessionB'))
  ).rejects.toThrow(/会话与当前活动会话不一致/);

  expect(handlerCalls).toBe(0);
  expect(runner.calls).toBe(0);
});

test('会话校验：审批期间切到 B，批准后仍拒绝执行，runner 调用 0 次', async () => {
  const runner = okRunner();
  let active = 'sessionA';
  const resolver = () => active;
  const handler = {
    requestApproval: async () => {
      // 模拟弹窗期间用户切到 sessionB
      active = 'sessionB';
      return 'allow_once';
    }
  };
  const executor = new SandboxExecutor(handler, runner);

  await expect(
    executor.execute(makeReq('echo switch'), 'taskA', 'sessionA', resolver)
  ).rejects.toThrow(/审批期间会话已切换/);

  expect(runner.calls).toBe(0);
});

test('会话校验：resolver 返回 null → 拒绝', async () => {
  const runner = okRunner();
  const executor = new SandboxExecutor(okHandler(), runner);

  await expect(
    executor.execute(makeReq('echo hi'), 'taskA', 'sessionA', () => null)
  ).rejects.toThrow(/无法获取当前活动会话/);

  expect(runner.calls).toBe(0);
});

test('会话校验：resolver 抛异常 → 拒绝', async () => {
  const runner = okRunner();
  const executor = new SandboxExecutor(okHandler(), runner);

  await expect(
    executor.execute(makeReq('echo hi'), 'taskA', 'sessionA', () => { throw new Error('boom'); })
  ).rejects.toThrow(/会话解析器异常/);

  expect(runner.calls).toBe(0);
});

test('会话校验：resolver 不是函数 → 拒绝', async () => {
  const runner = okRunner();
  const executor = new SandboxExecutor(okHandler(), runner);

  await expect(
    executor.execute(makeReq('echo hi'), 'taskA', 'sessionA', undefined)
  ).rejects.toThrow(/会话解析器未提供/);

  expect(runner.calls).toBe(0);
});

test('会话校验：sessionId 为空 → 拒绝', async () => {
  const runner = okRunner();
  const executor = new SandboxExecutor(okHandler(), runner);

  await expect(
    executor.execute(makeReq('echo hi'), 'taskA', '', fixedResolver('sessionA'))
  ).rejects.toThrow(/缺少有效的所属会话 ID/);

  expect(runner.calls).toBe(0);
});

test('会话校验：切换后重试不再被 runningSignature 锁住', async () => {
  const runner = okRunner();
  let active = 'sessionA';
  const resolver = () => active;
  const handler = {
    requestApproval: async () => {
      active = 'sessionB';
      return 'allow_once';
    }
  };
  const executor = new SandboxExecutor(handler, runner);

  await expect(
    executor.execute(makeReq('echo x'), 'taskA', 'sessionA', resolver)
  ).rejects.toThrow(/审批期间会话已切换/);

  // 切回 A 后，同样的 taskId + 命令必须能重新进入（不是被签名锁永久占住）
  active = 'sessionA';
  const handler2 = { requestApproval: async () => 'allow_once' };
  const executor2 = new SandboxExecutor(handler2, okRunner());
  const r = await executor2.execute(makeReq('echo x'), 'taskA', 'sessionA', fixedResolver('sessionA'));
  expect(r.exitCode).toBe(0);
});


// ============ L0 自动放行（Phase 1.3） ============

test('L0 自动放行：不调用审批弹窗，但走完后续校验与执行', async () => {
  let handlerCalls = 0;
  const handler = { requestApproval: async () => { handlerCalls++; return 'allow_once'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  // cmd 下的 ver 是白名单命令
  const req = makeReq('ver');
  const r = await executor.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'));

  expect(r.exitCode).toBe(0);
  expect(runner.calls).toBe(1);
  expect(handlerCalls).toBe(0); // 关键：没弹窗
});

test('L0 自动放行：仍受会话校验约束（前置不匹配拒绝）', async () => {
  const runner = okRunner();
  const executor = new SandboxExecutor(okHandler(), runner);
  const req = makeReq('ver');

  await expect(
    executor.execute(req, 'taskA', 'sessionA', fixedResolver('sessionB'))
  ).rejects.toThrow(/会话与当前活动会话不一致/);
  expect(runner.calls).toBe(0);
});

test('L0 自动放行：仍受并发去重约束', async () => {
  const runner = { calls: 0, run: async () => { runner.calls++; await new Promise(r => setTimeout(r, 50)); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const executor = new SandboxExecutor(okHandler(), runner);
  const req = makeReq('ver');
  const resolver = fixedResolver('sessionA');

  const p1 = executor.execute(req, 'taskA', 'sessionA', resolver);
  const p2 = executor.execute(req, 'taskA', 'sessionA', resolver);

  await expect(p2).rejects.toThrow(/正在审批或执行中/);
  await p1;
  expect(runner.calls).toBe(1);
});

test('L0 自动放行：审计日志含 Auto-approved 且不含敏感 env 明文', async () => {
  const logs = [];
  const logger = { log: (snap, res, err) => logs.push({ snap, res, err }) };
  const executor = new SandboxExecutor(okHandler(), okRunner(), logger);
  const req = {
    type: 'shell', shellType: 'cmd', rawCommand: 'ver', cwd: 'D:\\',
    env: { GITHUB_TOKEN: 'secret-l0-token' },
  };

  await executor.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'));

  const autoLog = logs.find(l => l.err && l.err.includes('Auto-approved L0'));
  expect(autoLog).toBeTruthy();
  // 日志里的快照不应含明文 token
  const serialized = JSON.stringify(autoLog.snap);
  expect(serialized).not.toContain('secret-l0-token');
});

test('L2 行为不变：非白名单命令仍要弹窗', async () => {
  let handlerCalls = 0;
  const handler = { requestApproval: async () => { handlerCalls++; return 'allow_once'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  // echo hi 不在白名单里
  await executor.execute(makeReq('echo hi'), 'taskA', 'sessionA', fixedResolver('sessionA'));
  expect(handlerCalls).toBe(1);
});


// ============ L0 补齐：判定器异常 / 失败 / 超时 / 审计状态 ============

test('安全预检：无法抽取命令正文 → fail-closed 拒绝，不弹窗不执行', async () => {
  let handlerCalls = 0;
  const handler = { requestApproval: async () => { handlerCalls++; return 'allow_once'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  // rawCommand = null：无法抽取可分析的命令正文
  // 预检必须 fail-closed（不放行、不进入审批），runner 也不得执行
  const evilReq = {
    type: 'shell',
    shellType: 'cmd',
    rawCommand: null,
    cwd: 'D:\\',
    env: {},
  };

  await expect(
    executor.execute(evilReq, 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/安全策略拒绝/);

  expect(handlerCalls).toBe(0);
  expect(runner.calls).toBe(0);
});

test('L0 执行失败 → 状态 failed，锁已释放', async () => {
  const runner = {
    calls: 0,
    run: async () => {
      runner.calls++;
      return { stdout: '', stderr: 'boom', exitCode: 1 };
    }
  };
  const logs = [];
  const logger = { log: (snap, res, err) => logs.push({ snap, res, err }) };
  const executor = new SandboxExecutor(okHandler(), runner, logger);

  const r = await executor.execute(makeReq('ver'), 'taskA', 'sessionA', fixedResolver('sessionA'));
  expect(r.exitCode).toBe(1);

  const finalSnap = logs.filter(l => l.res).pop();
  expect(finalSnap).toBeTruthy();
  expect(finalSnap.snap.status).toBe('failed');

  // 锁已释放：同签名可再次执行
  const r2 = await executor.execute(makeReq('ver'), 'taskA', 'sessionA', fixedResolver('sessionA'));
  expect(r2.exitCode).toBe(1);
  expect(runner.calls).toBe(2);
});

test('L0 超时 → 状态 timed_out，锁已释放', async () => {
  const runner = {
    calls: 0,
    run: async () => {
      runner.calls++;
      return { stdout: '', stderr: '', exitCode: -1, isTimeout: true };
    }
  };
  const logs = [];
  const logger = { log: (snap, res, err) => logs.push({ snap, res, err }) };
  const executor = new SandboxExecutor(okHandler(), runner, logger);

  const r = await executor.execute(makeReq('ver'), 'taskA', 'sessionA', fixedResolver('sessionA'));
  expect(r.isTimeout).toBe(true);

  const finalSnap = logs.filter(l => l.res).pop();
  expect(finalSnap).toBeTruthy();
  expect(finalSnap.snap.status).toBe('timed_out');

  const r2 = await executor.execute(makeReq('ver'), 'taskA', 'sessionA', fixedResolver('sessionA'));
  expect(r2.isTimeout).toBe(true);
  expect(runner.calls).toBe(2);
});

test('L0 审计快照状态不伪造为 approved/succeeded', async () => {
  const logs = [];
  const logger = { log: (snap, res, err) => logs.push({ snap, res, err }) };
  const executor = new SandboxExecutor(okHandler(), okRunner(), logger);

  await executor.execute(makeReq('ver'), 'taskA', 'sessionA', fixedResolver('sessionA'));

  const autoLog = logs.find(l => l.err && l.err.includes('Auto-approved L0'));
  expect(autoLog).toBeTruthy();
  // 关键断言：快照状态必须是 pending（登记时的原始状态）
  expect(autoLog.snap.status).toBe('pending');
  expect(autoLog.snap.status).not.toBe('approved');
  expect(autoLog.snap.status).not.toBe('succeeded');
});


// ============ L3：敏感路径访问（Phase B） ============

test('L3 敏感路径：审批 DTO 携带 riskLevel=L3 与目标路径', async () => {
  let capturedDto = null;
  const handler = {
    requestApproval: async (dto) => {
      capturedDto = dto;
      return 'deny';
    }
  };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  // type 读 .ssh 私钥
  const req = makeReq('type C:\\Users\\Lee\\.ssh\\id_rsa');

  await expect(
    executor.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/用户拒绝了此操作/);

  expect(capturedDto).toBeTruthy();
  expect(capturedDto.riskLevel).toBe('L3');
  expect(capturedDto.riskReasons.join(' ')).toContain('敏感路径');
  expect(capturedDto.riskReasons.join(' ')).toContain('id_rsa');
  // 关键：拒绝后不执行
  expect(runner.calls).toBe(0);
});

test('L3 敏感路径：即使命中 L0 白名单也不能静默（L3 优先级更高）', async () => {
  let handlerCalls = 0;
  const handler = { requestApproval: async () => { handlerCalls++; return 'deny'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  // 'dir /a /b' 是 L0 白名单，但指向 .ssh 目录应升为 L3
  const req = makeReq('dir /a /b C:\\Users\\Lee\\.ssh');

  await expect(
    executor.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/用户拒绝了此操作/);

  // 关键：L0 命令也必须弹窗（说明 L3 覆盖了 L0）
  expect(handlerCalls).toBe(1);
  expect(runner.calls).toBe(0);
});

test('L3 敏感路径：用户允许后正常执行', async () => {
  let handlerCalls = 0;
  const handler = { requestApproval: async () => { handlerCalls++; return 'allow_once'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  const req = makeReq('type C:\\Users\\Lee\\.ssh\\id_rsa');
  const r = await executor.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'));

  expect(handlerCalls).toBe(1);
  expect(runner.calls).toBe(1);
  expect(r.exitCode).toBe(0);
});

test('L3 敏感路径：普通命令不触发 L3', async () => {
  let capturedDto = null;
  const handler = {
    requestApproval: async (dto) => { capturedDto = dto; return 'allow_once'; }
  };
  const executor = new SandboxExecutor(handler, okRunner());

  await executor.execute(makeReq('type README.md'), 'taskA', 'sessionA', fixedResolver('sessionA'));

  expect(capturedDto.riskLevel).toBe('L2');
});


// ============ L3 执行器层：多命令语义覆盖 ============

function makePwshReq(cmd) {
  return { type: 'process', executable: 'powershell', args: ['-NoProfile', '-Command', cmd], cwd: 'D:\\', env: {} };
}

test('L3 执行器层：copy 敏感源触发 L3，拒绝后 runner 不执行', async () => {
  let capturedDto = null;
  const handler = { requestApproval: async (dto) => { capturedDto = dto; return 'deny'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  const req = makeReq('copy C:\\Users\\Lee\\.ssh\\id_rsa D:\\proj\\leaked.txt');

  await expect(
    executor.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/用户拒绝了此操作/);

  expect(capturedDto.riskLevel).toBe('L3');
  expect(capturedDto.riskReasons.join(' ')).toContain('id_rsa');
  expect(runner.calls).toBe(0);
});

test('L3 执行器层：move 敏感源触发 L3', async () => {
  let capturedDto = null;
  const handler = { requestApproval: async (dto) => { capturedDto = dto; return 'deny'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  const req = makeReq('move C:\\Users\\Lee\\.aws\\credentials D:\\proj\\');

  await expect(
    executor.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/用户拒绝了此操作/);

  expect(capturedDto.riskLevel).toBe('L3');
  expect(runner.calls).toBe(0);
});

test('L3 执行器层：del 敏感目标触发 L3（而非仅高危红框）', async () => {
  let capturedDto = null;
  const handler = { requestApproval: async (dto) => { capturedDto = dto; return 'deny'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  const req = makeReq('del /q C:\\Users\\Lee\\.ssh\\id_rsa');

  await expect(
    executor.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/用户拒绝了此操作/);

  // 关键：del 本身是高危关键词，但敏感路径命中时应为 L3（敏感路径优先）
  expect(capturedDto.riskLevel).toBe('L3');
  expect(capturedDto.riskReasons.join(' ')).toContain('敏感路径');
  expect(capturedDto.riskReasons.join(' ')).toContain('id_rsa');
  expect(runner.calls).toBe(0);
});

test('L3 执行器层：PowerShell Remove-Item 敏感目标触发 L3', async () => {
  let capturedDto = null;
  const handler = { requestApproval: async (dto) => { capturedDto = dto; return 'deny'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  const req = makePwshReq('Remove-Item C:\\Users\\Lee\\.ssh\\id_rsa -Force');

  await expect(
    executor.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/用户拒绝了此操作/);

  expect(capturedDto.riskLevel).toBe('L3');
  expect(runner.calls).toBe(0);
});

test('L3 执行器层：findstr pattern 后跟敏感路径触发 L3', async () => {
  let capturedDto = null;
  const handler = { requestApproval: async (dto) => { capturedDto = dto; return 'deny'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  const req = makeReq('findstr BEGIN C:\\Users\\Lee\\.ssh\\id_rsa');

  await expect(
    executor.execute(req, 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/用户拒绝了此操作/);

  expect(capturedDto.riskLevel).toBe('L3');
  expect(capturedDto.riskReasons.join(' ')).toContain('id_rsa');
  expect(runner.calls).toBe(0);
});

test('L3 执行器层：复制非敏感文件保持 L2（不误升 L3）', async () => {
  let capturedDto = null;
  const handler = { requestApproval: async (dto) => { capturedDto = dto; return 'allow_once'; } };
  const executor = new SandboxExecutor(handler, okRunner());

  await executor.execute(
    makeReq('copy D:\\proj\\a.txt D:\\proj\\b.txt'),
    'taskA', 'sessionA', fixedResolver('sessionA')
  );

  expect(capturedDto.riskLevel).toBe('L2');
});

// ============ CC Safety Net 硬性否决（不可被 L3/L2/L0 覆盖）============

test('CCSN deny + 无敏感路径 → 直接拒绝，不弹窗不执行', async () => {
  injectSafetyChecker(async () => ({ kind: 'deny', reason: '禁止破坏性 Git 操作', ruleId: 'git.reset-hard' }));
  let handlerCalls = 0;
  const handler = { requestApproval: async () => { handlerCalls++; return 'allow_once'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  await expect(
    executor.execute(makeReq('git reset --hard'), 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/CC Safety Net 拒绝执行/);

  expect(handlerCalls).toBe(0);
  expect(runner.calls).toBe(0);
});

test('CCSN deny + 命中 L3 → 仍拒绝，用户无权放行，只弹阻断提示', async () => {
  injectSafetyChecker(async () => ({ kind: 'deny', reason: '禁止删除密钥', ruleId: 'secret.rm' }));
  let approvalCalls = 0;
  let blockedNotice = null;
  const handler = {
    requestApproval: async () => { approvalCalls++; return 'allow_once'; },
    notifyBlocked: async (notice) => { blockedNotice = notice; },
  };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  await expect(
    executor.execute(
      makeReq('del /q C:\\Users\\Lee\\.ssh\\id_rsa'),
      'taskA', 'sessionA', fixedResolver('sessionA')
    )
  ).rejects.toThrow(/CC Safety Net 拒绝执行/);

  // 关键：没有进入审批（用户没有任何放行机会）
  expect(approvalCalls).toBe(0);
  expect(runner.calls).toBe(0);
  // 但用户能看到阻断原因
  expect(blockedNotice).not.toBeNull();
  expect(blockedNotice.reason).toContain('禁止删除密钥');
  expect(blockedNotice.ruleId).toBe('secret.rm');
  expect(blockedNotice.sensitive.hit).toBe(true);
});

test('CCSN deny + 命中 L0 白名单 → 仍拒绝（L0 不豁免 CCSN）', async () => {
  injectSafetyChecker(async () => ({ kind: 'deny', reason: '白名单命令也被拒绝', ruleId: 'test.l0' }));
  let handlerCalls = 0;
  const handler = { requestApproval: async () => { handlerCalls++; return 'allow_once'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  await expect(
    executor.execute(makeReq('dir /a /b'), 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/CC Safety Net 拒绝执行/);

  expect(handlerCalls).toBe(0);
  expect(runner.calls).toBe(0);
});

test('CCSN 异常 → fail-closed，不执行', async () => {
  injectSafetyChecker(async () => { throw new Error('规则引擎崩溃'); });
  let handlerCalls = 0;
  const handler = { requestApproval: async () => { handlerCalls++; return 'allow_once'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  await expect(
    executor.execute(makeReq('echo hi'), 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/安全预检异常/);

  expect(handlerCalls).toBe(0);
  expect(runner.calls).toBe(0);
});

test('CCSN 超时 → fail-closed，不执行', async () => {
  injectSafetyChecker(() => new Promise((resolve) => setTimeout(() => resolve({ kind: 'allow' }), 5000)));
  // 用 client 的超时语义模拟：这里让检查器自身超时拒绝
  injectSafetyChecker(async () => ({ kind: 'error', reason: 'CCSN 检查超时（10000ms）' }));
  const runner = okRunner();
  const executor = new SandboxExecutor(okHandler(), runner);

  await expect(
    executor.execute(makeReq('echo hi'), 'taskA', 'sessionA', fixedResolver('sessionA'))
  ).rejects.toThrow(/检查超时/);

  expect(runner.calls).toBe(0);
});

test('CCSN allow + L3 → 走 L3 红框，用户允许后执行', async () => {
  injectSafetyChecker(async () => ({ kind: 'allow' }));
  let capturedDto = null;
  const handler = { requestApproval: async (dto) => { capturedDto = dto; return 'allow_once'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  await executor.execute(
    makeReq('type C:\\Users\\Lee\\.ssh\\id_rsa'),
    'taskA', 'sessionA', fixedResolver('sessionA')
  );

  expect(capturedDto.riskLevel).toBe('L3');
  expect(runner.calls).toBe(1);
});

test('CCSN allow + L3 → 用户拒绝则不执行', async () => {
  injectSafetyChecker(async () => ({ kind: 'allow' }));
  const handler = { requestApproval: async () => 'deny' };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  await expect(
    executor.execute(
      makeReq('type C:\\Users\\Lee\\.ssh\\id_rsa'),
      'taskA', 'sessionA', fixedResolver('sessionA')
    )
  ).rejects.toThrow(/用户拒绝了此操作/);

  expect(runner.calls).toBe(0);
});

test('CCSN allow + 普通命令 → 仍走 L2 弹窗', async () => {
  injectSafetyChecker(async () => ({ kind: 'allow' }));
  let capturedDto = null;
  const handler = { requestApproval: async (dto) => { capturedDto = dto; return 'allow_once'; } };
  const executor = new SandboxExecutor(handler, okRunner());

  await executor.execute(makeReq('echo hi'), 'taskA', 'sessionA', fixedResolver('sessionA'));

  expect(capturedDto.riskLevel).toBe('L2');
});

test('CCSN allow + L0 → 仍然静默放行（行为不变）', async () => {
  injectSafetyChecker(async () => ({ kind: 'allow' }));
  let handlerCalls = 0;
  const handler = { requestApproval: async () => { handlerCalls++; return 'allow_once'; } };
  const runner = okRunner();
  const executor = new SandboxExecutor(handler, runner);

  await executor.execute(makeReq('dir /a /b'), 'taskA', 'sessionA', fixedResolver('sessionA'));

  expect(handlerCalls).toBe(0);
  expect(runner.calls).toBe(1);
});

test('CCSN 检查器收到的是 PowerShell 脚本正文（不含外壳参数）', async () => {
  let received = null;
  injectSafetyChecker(async (input) => { received = input; return { kind: 'allow' }; });
  const executor = new SandboxExecutor(okHandler(), okRunner());

  await executor.execute(
    makePwshReq('Remove-Item .\\tmp.txt -Force'),
    'taskA', 'sessionA', fixedResolver('sessionA')
  );

  expect(received).not.toBeNull();
  expect(received.command).toBe('Remove-Item .\\tmp.txt -Force');
  expect(received.command).not.toContain('powershell');
  expect(received.command).not.toContain('-NoProfile');
});
