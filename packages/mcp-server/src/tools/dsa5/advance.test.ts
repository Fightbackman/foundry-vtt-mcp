/**
 * dsa5-advance tool tests: schema, validation and forwarding. The advancement itself
 * runs browser-side and is covered in foundry-module/src/dsa5-advancement.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { DSA5AdvanceTools } from './advance.js';

function makeTools() {
  const query = vi.fn(async () => ({ success: true }));
  const logger: any = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => logger,
  };
  const tools = new DSA5AdvanceTools({ foundryClient: { query } as any, logger });
  return { tools, query };
}

describe('dsa5-advance tool definition', () => {
  const definition = makeTools().tools.getToolDefinitions()[0];

  it('is a DSA5-only tool that needs write operations', () => {
    expect(definition.name).toBe('dsa5-advance');
    expect(definition.description).toMatch(/^\[DSA5 only\]/);
    expect(definition.description).toMatch(/Allow Write Operations/);
  });

  it('offers raise, lower, preview and award', () => {
    const props = definition.inputSchema.properties as Record<string, any>;
    expect(props.action.enum).toEqual(['raise', 'lower', 'preview', 'award']);
    expect(definition.inputSchema.required).toEqual(['action']);
  });
});

describe('handleAdvance', () => {
  it('forwards a raise to the bridge', async () => {
    const { tools, query } = makeTools();
    await tools.handleAdvance({ action: 'raise', actor: 'Alrike', target: 'Klettern', steps: 2 });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.dsa5Advance', {
      action: 'raise',
      actor: 'Alrike',
      target: 'Klettern',
      steps: 2,
      toValue: undefined,
      free: undefined,
      ignoreMaximum: undefined,
    });
  });

  it('forwards an award to the award query', async () => {
    const { tools, query } = makeTools();
    await tools.handleAdvance({ action: 'award', party: true, amount: 50, reason: 'Ende' });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.dsa5AwardAP', {
      actors: undefined,
      party: true,
      amount: 50,
      reason: 'Ende',
      postToChat: undefined,
    });
  });

  it.each([
    [{ action: 'raise', target: 'Klettern' }, /needs actor and target/],
    [{ action: 'raise', actor: 'A', target: 'B', steps: 1, toValue: 3 }, /either steps or toValue/],
    [{ action: 'raise', actor: 'A', target: 'B', ignoreMaximum: true }, /requires free/],
    [{ action: 'award', amount: 10 }, /actors and\/or party/],
    [{ action: 'award', party: true }, /amount/],
    [{ action: 'award', party: true, amount: 0 }, /Invalid arguments/],
    [{ action: 'raise', actor: 'A', target: 'B', steps: 0 }, /Invalid arguments/],
    [{ action: 'jump' }, /Invalid arguments/],
  ])('rejects %j', async (args, message) => {
    const { tools, query } = makeTools();
    const result = await tools.handleAdvance(args);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(message);
    expect(query).not.toHaveBeenCalled();
  });
});
