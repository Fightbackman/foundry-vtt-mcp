/**
 * dsa5-roll-check tool tests: schema, validation and forwarding to the bridge query.
 * The roll itself runs browser-side and is covered in
 * foundry-module/src/dsa5-rolls.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { DSA5RollCheckTools } from './roll-check.js';

function makeTools(queryImpl?: (method: string, data: any) => unknown) {
  const query = vi.fn(queryImpl ?? (async () => ({ success: true, roll: { outcome: 'success' } })));
  const logger: any = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => logger,
  };
  const foundryClient: any = { query };
  const tools = new DSA5RollCheckTools({ foundryClient, logger });
  return { tools, query };
}

describe('dsa5-roll-check tool definition', () => {
  it('is marked DSA5-only and lists the supported checks', () => {
    const [definition] = makeTools().tools.getToolDefinitions();
    expect(definition.name).toBe('dsa5-roll-check');
    expect(definition.description.startsWith('[DSA5 only]')).toBe(true);
    const props = definition.inputSchema.properties as Record<string, any>;
    expect(props.check.enum).toEqual(['skill', 'attribute', 'attack', 'parry', 'dodge', 'spell']);
    expect(props.messageMode.enum).toEqual(['public', 'gm', 'blind', 'self']);
    expect(definition.inputSchema.required).toEqual(['actor', 'check']);
  });
});

describe('dsa5-roll-check handler', () => {
  it('forwards a valid check to the bridge', async () => {
    const { tools, query } = makeTools();
    const result = await tools.handleRollCheck({
      actor: 'Alrike',
      check: 'skill',
      name: 'Climbing',
      modifier: -2,
      messageMode: 'gm',
    });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.dsa5RollCheck', {
      actorIdentifier: 'Alrike',
      check: 'skill',
      name: 'Climbing',
      modifier: -2,
      targets: undefined,
      messageMode: 'gm',
    });
    expect(result).toEqual({ success: true, roll: { outcome: 'success' } });
  });

  it('allows dodge without a name', async () => {
    const { tools, query } = makeTools();
    await tools.handleRollCheck({ actor: 'Wolf', check: 'dodge' });
    expect(query).toHaveBeenCalledOnce();
  });

  it('requires a name for every other check', async () => {
    const { tools, query } = makeTools();
    const result = await tools.handleRollCheck({ actor: 'Alrike', check: 'attack' });
    expect(result).toEqual({ success: false, error: '"name" is required for check "attack".' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects unknown checks, fractional modifiers and unknown fields', async () => {
    const { tools, query } = makeTools();
    for (const args of [
      { actor: 'Alrike', check: 'save', name: 'dex' },
      { actor: 'Alrike', check: 'skill', name: 'Climbing', modifier: 1.5 },
      { actor: 'Alrike', check: 'skill', name: 'Climbing', formula: '1d20' },
    ]) {
      const result: any = await tools.handleRollCheck(args);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^Invalid arguments/);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('returns bridge errors instead of throwing', async () => {
    const { tools } = makeTools(async () => {
      throw new Error('Foundry VTT is not ready');
    });
    const result = await tools.handleRollCheck({ actor: 'Alrike', check: 'dodge' });
    expect(result).toEqual({ success: false, error: 'Foundry VTT is not ready' });
  });
});
