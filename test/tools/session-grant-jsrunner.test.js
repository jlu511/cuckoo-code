import { test, expect } from 'vitest';
import { JsRunner } from '../../src/tools/runtime/JsRunner.js';
import { ToolRegistry } from '../../src/tools/core/ToolRegistry.js';
import { Tool } from '../../src/tools/core/Tool.js';
import { ToolResult } from '../../src/tools/core/ToolResult.js';

/** 探针工具：标记 dynamic 才会注入沙箱；记录收到的 params */
class ProbeTool extends Tool {
  constructor() {
    super('probeTool', 'probe', { type: 'object', properties: {} }, 'probeTool()');
    this.dynamic = true;
  }
  async execute(params) {
    ProbeTool.lastParams = params;
    return ToolResult.success('ok');
  }
}

const makeRegistry = () => {
  const reg = new ToolRegistry();
  reg.register(new ProbeTool());
  return reg;
};

test('032 JsRunner 透传 sessionGenerationProvider 到工具', async () => {
  const runner = new JsRunner(makeRegistry());
  const gen = () => 42;

  const r = await runner.run('await probeTool()', process.cwd(), null, {
    sessionId: 'sessionA',
    sessionResolver: () => 'sessionA',
    sessionGenerationProvider: gen,
  });

  expect(r.success).toBe(true);
  expect(typeof ProbeTool.lastParams.sessionGenerationProvider).toBe('function');
  expect(ProbeTool.lastParams.sessionGenerationProvider()).toBe(42);
  expect(ProbeTool.lastParams.activeSessionId).toBe('sessionA');
});

test('032 JsRunner 未传 provider 时工具收到 null（不伪造）', async () => {
  const runner = new JsRunner(makeRegistry());

  const r = await runner.run('await probeTool()', process.cwd(), null, {
    sessionId: 'sessionA',
    sessionResolver: () => 'sessionA',
  });

  expect(r.success).toBe(true);
  expect(ProbeTool.lastParams.sessionGenerationProvider).toBe(null);
});

test('032 JsRunner 工具收到的 provider 来自 settings（不可被工具参数覆盖）', async () => {
  const runner = new JsRunner(makeRegistry());
  const trustedGen = () => 7;

  const r = await runner.run('await probeTool()', process.cwd(), null, {
    sessionId: 'sA',
    sessionResolver: () => 'sA',
    sessionGenerationProvider: trustedGen,
  });

  expect(r.success).toBe(true);
  expect(ProbeTool.lastParams.sessionGenerationProvider()).toBe(7);
});