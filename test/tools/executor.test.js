import { test, expect, vi } from 'vitest';
import { SandboxExecutor } from '../../src/tools/core/executor.js';

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

// ============ TC-08：并发去重（真实行为测试） ============

test('TC-08: 相同 taskId + 相同请求并发 execute，最多启动一次进程', async () => {
  const runner = {
    calls: 0,
    run: async () => {
      runner.calls++;
      // 模拟慢执行，让两个并发请求在时间上重叠
      await new Promise((r) => setTimeout(r, 30));
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    }
  };
  const executor = new SandboxExecutor(okHandler(), runner);
  const req = makeReq('echo concurrent');

  // 同时发起两次（不 await 第一条）
  const p1 = executor.execute(req, 'taskA', 'sessionA');
  const p2 = executor.execute(req, 'taskA', 'sessionA');

  // 第二条必须立刻被拒绝（正在审批或执行中）
  await expect(p2).rejects.toThrow(/正在审批或执行中/);

  // 第一条正常完成
  const r1 = await p1;
  expect(r1.exitCode).toBe(0);

  // 关键断言：runner 只被调用一次
  expect(runner.calls).toBe(1);
});

// ============ TC-09：pending 过期后拒绝（真实行为测试） ============

test('TC-09: pending 超过 TTL 后返回审批结果，必须拒绝且不启动进程', async () => {
  const runner = okRunner();

  // 让审批 handler 延迟 200ms 返回，模拟"审批弹窗挂在后台很久"
  const slowHandler = {
    requestApproval: async () => {
      await new Promise((r) => setTimeout(r, 200));
      return 'allow_once';
    }
  };

  // 注入极小 TTL（50ms）
  const executor = new SandboxExecutor(slowHandler, runner, undefined, { pendingTtlMs: 50 });
  const req = makeReq('echo expire-test');

  await expect(executor.execute(req, 'taskA', 'sessionA')).rejects.toThrow(/已过期/);

  // 关键断言：runner 从未被调用
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
  await executor.execute(makeReq('echo safe'), 'taskA', 'sessionA');

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
  const p = executor.execute(makeReq('ping -t 127.0.0.1'), 'taskA', 'sessionA');
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

  // 任务 A 被拒
  await expect(executor.execute(req, 'taskA', 'sessA')).rejects.toThrow('用户拒绝了此操作。');
  expect(denyCount).toBe(1);

  // 任务 A 重试：直接拦截，不弹窗
  await expect(executor.execute(req, 'taskA', 'sessA')).rejects.toThrow(/已被拒绝/);
  expect(denyCount).toBe(1);

  // 任务 B（不同 taskId）：应该重新弹窗，不受任务 A 影响
  await expect(executor.execute(req, 'taskB', 'sessB')).rejects.toThrow('用户拒绝了此操作。');
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

  // 构造一个带敏感 env 的请求
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

  await executor.execute(req, 'taskA', 'sessionA');

  // 找到执行日志（非 pre-check 的）
  const execLog = logs.find((l) => l.id !== 'pre-check' && l.request && l.request.env);
  expect(execLog).toBeTruthy();

  // 敏感值必须被脱敏
  expect(execLog.request.env.GITHUB_TOKEN).toBe('[REDACTED]');
  expect(execLog.request.env.API_KEY).toBe('[REDACTED]');
  // 非敏感值原样保留
  expect(execLog.request.env.NORMAL_VAR).toBe('keep-me');

  // 原始 secret 字符串绝不出现在序列化后的日志里
  const serialized = JSON.stringify(logs);
  expect(serialized).not.toContain('ghp_realsecret123');
  expect(serialized).not.toContain('sk-live-deadbeef');
});

// ============ 会话切换校验（可选参数） ============

test('会话切换校验：activeSessionId 与 sessionId 不一致时拒绝执行', async () => {
  const runner = okRunner();
  const executor = new SandboxExecutor(okHandler(), runner);

  await expect(
    executor.execute(makeReq('echo hi'), 'taskA', 'session-old', 'session-new')
  ).rejects.toThrow(/会话与当前活动会话不一致/);

  expect(runner.calls).toBe(0);
});

test('会话切换校验：未传 activeSessionId 时不做校验（向后兼容）', async () => {
  const runner = okRunner();
  const executor = new SandboxExecutor(okHandler(), runner);
  const r = await executor.execute(makeReq('echo hi'), 'taskA', 'sessionA');
  expect(r.exitCode).toBe(0);
  expect(runner.calls).toBe(1);
});
