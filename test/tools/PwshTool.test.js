import { test, expect, beforeEach } from 'vitest';
import { PwshTool, DANGEROUS_PWSH_CMDS } from '../../src/tools/impl/pwsh.js';
import { injectSandboxExecutor } from '../../src/tools/core/executor.js';
import { injectSafetyChecker } from '../../src/tools/core/safety-precheck.js';

beforeEach(() => {
  injectSafetyChecker(async () => ({ kind: 'allow' }));
});

// ============ helpers ============

const okHandler = () => ({ requestApproval: async () => 'allow_once' });

function makeTool() {
  return new PwshTool();
}

/** 记录 runner 收到的请求，并返回固定结果 */
function makeRunner(result = { stdout: 'ok', stderr: '', exitCode: 0 }) {
  const runner = {
    calls: 0,
    lastReq: null,
    run: async (req) => {
      runner.calls++;
      runner.lastReq = req;
      return result;
    }
  };
  return runner;
}

function inject(handler, runner) {
  injectSandboxExecutor(handler, runner);
}

const VALID_SESSION = 'sessionA';
const validResolver = () => VALID_SESSION;

// ============ 元数据 ============

test('DANGEROUS_PWSH_CMDS 定义完整', () => {
  expect(Array.isArray(DANGEROUS_PWSH_CMDS)).toBe(true);
  expect(DANGEROUS_PWSH_CMDS.length).toBeGreaterThanOrEqual(13);
});

// ============ 参数校验（不依赖 executor）============

test('PwshTool 空命令拒绝', async () => {
  const tool = makeTool();
  const r = await tool.execute({ command: '', description: 'test' });
  expect(r.success).toBe(false);
  expect(r.error).toMatch(/invalid command/);
});

test('PwshTool 非字符串命令拒绝', async () => {
  const tool = makeTool();
  const r = await tool.execute({ command: 123, description: 'test' });
  expect(r.success).toBe(false);
  expect(r.error).toMatch(/invalid command/);
});

test('PwshTool 空描述拒绝', async () => {
  const tool = makeTool();
  const r = await tool.execute({ command: 'Write-Output hi', description: '' });
  expect(r.success).toBe(false);
  expect(r.error).toMatch(/description/);
});

test('PwshTool 缺少 activeSessionId 拒绝', async () => {
  const tool = makeTool();
  const r = await tool.execute({ command: 'Write-Output hi', description: 'test' });
  expect(r.success).toBe(false);
  expect(r.error).toMatch(/缺少有效的会话 ID/);
});

test('PwshTool 缺少 sessionResolver 拒绝', async () => {
  const tool = makeTool();
  const r = await tool.execute({
    command: 'Write-Output hi',
    description: 'test',
    activeSessionId: VALID_SESSION,
  });
  expect(r.success).toBe(false);
  expect(r.error).toMatch(/缺少会话解析器/);
});

// ============ 审批 + 执行闭环 ============

test('PwshTool 正常执行：构造 ProcessRequest 交给 executor', async () => {
  const runner = makeRunner({ stdout: 'hi', stderr: '', exitCode: 0 });
  inject(okHandler(), runner);
  const tool = makeTool();

  const r = await tool.execute({
    command: 'Write-Output hi',
    description: '输出 hi',
    activeSessionId: VALID_SESSION,
    sessionResolver: validResolver,
    projectDir: 'D:\\test',
  });

  expect(r.success).toBe(true);
  expect(r.data).toContain('hi');

  // 关键：语义必须保持 execFile('powershell', ['-NoProfile','-Command', trimmed])
  expect(runner.lastReq.type).toBe('process');
  expect(runner.lastReq.executable).toBe('powershell');
  expect(runner.lastReq.args).toEqual(['-NoProfile', '-Command', 'Write-Output hi']);
  expect(runner.lastReq.cwd).toBe('D:\\test');
});

test('PwshTool 拒绝：runner 不调用', async () => {
  const runner = makeRunner();
  const denyHandler = { requestApproval: async () => 'deny' };
  inject(denyHandler, runner);
  const tool = makeTool();

  const r = await tool.execute({
    command: 'Write-Output hi',
    description: 'test',
    activeSessionId: VALID_SESSION,
    sessionResolver: validResolver,
  });

  expect(r.success).toBe(false);
  expect(r.error).toMatch(/用户拒绝了此操作/);
  expect(runner.calls).toBe(0);
});

test('PwshTool 超时：isTimeout 正确渲染', async () => {
  const runner = makeRunner({ stdout: '', stderr: '', exitCode: -1, isTimeout: true });
  inject(okHandler(), runner);
  const tool = makeTool();

  const r = await tool.execute({
    command: 'Start-Sleep 10',
    description: 'test',
    activeSessionId: VALID_SESSION,
    sessionResolver: validResolver,
    timeoutMs: 100,
  });

  expect(r.success).toBe(true);
  expect(r.data).toMatch(/timed out after 100ms/);
});

test('PwshTool 取消：isCancelled 正确渲染', async () => {
  const runner = makeRunner({ stdout: '', stderr: '', exitCode: -1, isCancelled: true });
  inject(okHandler(), runner);
  const tool = makeTool();

  const r = await tool.execute({
    command: 'Start-Sleep 60',
    description: 'test',
    activeSessionId: VALID_SESSION,
    sessionResolver: validResolver,
  });

  expect(r.success).toBe(true);
  expect(r.data).toMatch(/cancelled/);
});

test('PwshTool 非零退出：渲染 exit code', async () => {
  const runner = makeRunner({ stdout: '', stderr: 'err msg', exitCode: 2 });
  inject(okHandler(), runner);
  const tool = makeTool();

  const r = await tool.execute({
    command: 'exit 2',
    description: 'test',
    activeSessionId: VALID_SESSION,
    sessionResolver: validResolver,
  });

  expect(r.success).toBe(true);
  expect(r.data).toContain('[stderr]');
  expect(r.data).toContain('err msg');
  expect(r.data).toMatch(/exit code: 2/);
});

test('PwshTool 工作目录：相对路径基于 projectDir', async () => {
  const runner = makeRunner();
  inject(okHandler(), runner);
  const tool = makeTool();

  await tool.execute({
    command: 'Get-Location',
    description: 'test',
    workdir: 'sub',
    activeSessionId: VALID_SESSION,
    sessionResolver: validResolver,
    projectDir: 'D:\\root',
  });

  // 需要能在不同平台执行。path.isAbsolute 处理
  expect(runner.lastReq.cwd).toMatch(/root[\\/]sub$/);
});

test('PwshTool 环境变量：通过 ProcessRequest.env 传递', async () => {
  const runner = makeRunner();
  inject(okHandler(), runner);
  const tool = makeTool();

  await tool.execute({
    command: 'echo $env:FOO',
    description: 'test',
    activeSessionId: VALID_SESSION,
    sessionResolver: validResolver,
  });

  // 当前 PwshTool 不主动注入 env（保持原语义），env 为空对象
  expect(runner.lastReq.env).toEqual({});
});
