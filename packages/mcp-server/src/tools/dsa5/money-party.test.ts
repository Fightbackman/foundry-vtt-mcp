/**
 * dsa5-money / dsa5-party tool tests. The payment and party logic runs browser-side
 * (foundry-module dsa5-money-party.ts); these cover argument validation and forwarding.
 */

import { describe, it, expect, vi } from 'vitest';
import { DSA5MoneyPartyTools } from './money-party.js';

function makeTools(queryImpl?: (method: string, data: any) => unknown) {
  const query = vi.fn(queryImpl ?? (async () => ({ success: true })));
  const logger: any = { info: vi.fn(), error: vi.fn(), child: () => logger };
  const tools = new DSA5MoneyPartyTools({ foundryClient: { query } as any, logger });
  return { tools, query };
}

describe('DSA5MoneyPartyTools definitions', () => {
  it('exposes dsa5-money and dsa5-party as DSA5-only tools', () => {
    const defs = makeTools().tools.getToolDefinitions();
    expect(defs.map(d => d.name)).toEqual(['dsa5-money', 'dsa5-party']);
    for (const def of defs) {
      expect(def.description.startsWith('[DSA5 only]')).toBe(true);
      expect(def.inputSchema.required).toEqual(['action']);
    }
  });
});

describe('dsa5-money', () => {
  it('forwards a per-coin party payment', async () => {
    const { tools, query } = makeTools();
    const args = {
      action: 'pay',
      party: true,
      amount: { silbertaler: 3, heller: 5 },
      description: 'Zimmer',
    };
    await tools.handleMoney(args);
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.dsa5Money', args);
  });

  it('accepts numbers and formula strings as amounts', async () => {
    const { tools, query } = makeTools();
    await tools.handleMoney({ action: 'receive', actors: ['Alrike'], amount: 2.5 });
    await tools.handleMoney({ action: 'receive', actors: ['Alrike'], amount: '1W6*10' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete or malformed calls without querying Foundry', async () => {
    const { tools, query } = makeTools();
    const bad = [
      { action: 'pay', actors: ['Alrike'] },
      { action: 'pay', amount: 1 },
      { action: 'transfer', from: 'A', amount: 1 },
      { action: 'receive', actors: ['A'], amount: { taler: 1 } },
      { action: 'receive', actors: ['A'], amount: { heller: -1 } },
      { action: 'receive', actors: ['A'], amount: -2 },
      { action: 'spend', actors: ['A'], amount: 1 },
    ];
    for (const args of bad) {
      expect((await tools.handleMoney(args)).success).toBe(false);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('allows get without targets (defaults to the party)', async () => {
    const { tools, query } = makeTools();
    await tools.handleMoney({ action: 'get' });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.dsa5Money', { action: 'get' });
  });

  it('surfaces bridge errors as a failed result', async () => {
    const { tools } = makeTools(async () => {
      throw new Error('Manage Money is disabled in module settings');
    });
    const result = await tools.handleMoney({ action: 'pay', actors: ['A'], amount: 1 });
    expect(result).toEqual({
      success: false,
      error: 'Manage Money is disabled in module settings',
    });
  });
});

describe('dsa5-party', () => {
  it('forwards schips and membership changes', async () => {
    const { tools, query } = makeTools();
    await tools.handleParty({
      action: 'schips',
      target: 'group',
      operation: 'set',
      value: 2,
      max: 4,
    });
    await tools.handleParty({ action: 'add-member', actor: 'Alrike', list: 'gmMenu' });
    await tools.handleParty({ action: 'set-primary', group: 'Die Gruppe' });
    expect(query.mock.calls.map(c => c[1].action)).toEqual(['schips', 'add-member', 'set-primary']);
  });

  it('rejects missing operation, actor or group', async () => {
    const { tools, query } = makeTools();
    expect((await tools.handleParty({ action: 'schips' })).success).toBe(false);
    expect((await tools.handleParty({ action: 'remove-member' })).success).toBe(false);
    expect((await tools.handleParty({ action: 'set-primary' })).success).toBe(false);
    expect((await tools.handleParty({ action: 'get', extra: 1 })).success).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
