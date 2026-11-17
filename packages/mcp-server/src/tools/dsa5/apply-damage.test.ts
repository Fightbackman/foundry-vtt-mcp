/**
 * dsa5-apply-damage tool tests: schema, per-action argument checks and forwarding to the
 * bridge query. The system calls run browser-side and are covered in
 * foundry-module/src/dsa5-damage.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { DSA5ApplyDamageTools } from './apply-damage.js';

function makeTools(queryImpl?: (method: string, data: any) => unknown) {
  const query = vi.fn(queryImpl ?? (async () => ({ success: true })));
  const logger: any = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => logger,
  };
  const foundryClient: any = { query };
  const tools = new DSA5ApplyDamageTools({ foundryClient, logger });
  return { tools, query };
}

describe('dsa5-apply-damage tool definition', () => {
  it('is marked DSA5-only and lists its actions', () => {
    const [definition] = makeTools().tools.getToolDefinitions();
    expect(definition.name).toBe('dsa5-apply-damage');
    expect(definition.description.startsWith('[DSA5 only]')).toBe(true);
    const props = definition.inputSchema.properties as Record<string, any>;
    expect(props.action.enum).toEqual(['damage', 'heal', 'regenerate', 'spend', 'pay-cost']);
    expect(props.resource.enum).toEqual(['LeP', 'AsP', 'KaP']);
    expect(props.campsite.enum).toEqual(['normal', 'bad', 'good']);
    expect(props.interruption.enum).toEqual(['none', 'small', 'big']);
    expect(definition.inputSchema.required).toEqual(['action']);
  });
});

describe('dsa5-apply-damage handler', () => {
  it('forwards damage from a result card without an actor', async () => {
    const { tools, query } = makeTools();
    await tools.handleApplyDamage({ action: 'damage', messageId: 'msg-1', armor: false });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.dsa5ApplyDamage', {
      action: 'damage',
      messageId: 'msg-1',
      armor: false,
    });
  });

  it('maps actor to actorIdentifier and keeps formulas as strings', async () => {
    const { tools, query } = makeTools();
    await tools.handleApplyDamage({ action: 'damage', actor: 'tok-1', amount: '2d6+2' });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.dsa5ApplyDamage', {
      action: 'damage',
      amount: '2d6+2',
      actorIdentifier: 'tok-1',
    });
  });

  it('forwards regeneration options', async () => {
    const { tools, query } = makeTools();
    await tools.handleApplyDamage({
      action: 'regenerate',
      actor: 'Alrike',
      campsite: 'good',
      interruption: 'small',
      badEnvironment: true,
      resources: ['LeP', 'AsP'],
      apply: false,
    });
    expect(query.mock.calls[0][1]).toMatchObject({
      action: 'regenerate',
      actorIdentifier: 'Alrike',
      campsite: 'good',
      interruption: 'small',
      badEnvironment: true,
      resources: ['LeP', 'AsP'],
      apply: false,
    });
  });

  it.each([
    [{ action: 'damage' }, 'needs "messageId"'],
    [{ action: 'damage', actor: 'Alrike' }, 'needs "messageId"'],
    [{ action: 'heal', actor: 'Alrike' }, 'needs "actor" and "amount"'],
    [{ action: 'spend', actor: 'Alrike', amount: 3 }, '"resource"'],
    [{ action: 'spend', actor: 'Alrike', amount: 3, resource: 'LeP' }, 'use "damage" for LeP'],
    [{ action: 'pay-cost' }, 'needs "messageId"'],
    [{ action: 'regenerate' }, 'needs "actor"'],
  ])('rejects %j before querying Foundry', async (args, message) => {
    const { tools, query } = makeTools();
    const result: any = await tools.handleApplyDamage(args);
    expect(result.success).toBe(false);
    expect(result.error).toContain(message);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects unknown actions, fractional amounts and extra keys', async () => {
    const { tools, query } = makeTools();
    for (const args of [
      { action: 'kill', actor: 'Alrike' },
      { action: 'damage', actor: 'Alrike', amount: 2.5 },
      { action: 'damage', messageId: 'm', bogus: 1 },
    ]) {
      const result: any = await tools.handleApplyDamage(args);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid arguments');
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('returns query failures as errors', async () => {
    const { tools } = makeTools(async () => {
      throw new Error('bridge down');
    });
    const result: any = await tools.handleApplyDamage({ action: 'pay-cost', messageId: 'm' });
    expect(result).toEqual({ success: false, error: 'bridge down' });
  });
});
