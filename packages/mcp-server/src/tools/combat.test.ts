/**
 * manage-combat tool tests: schema shape, argument validation and forwarding to the
 * bridge query. The encounter handling itself runs browser-side and is covered in
 * foundry-module/src/combat-manager.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { CombatTools } from './combat.js';

function makeTools(queryImpl?: (method: string, data: any) => unknown) {
  const query = vi.fn(queryImpl ?? (async () => ({ success: true })));
  const logger: any = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => logger,
  };
  const tools = new CombatTools({ foundryClient: { query } as any, logger });
  return { tools, query };
}

function definition() {
  return makeTools().tools.getToolDefinitions()[0];
}

describe('manage-combat tool definition', () => {
  it('is a generic tool named manage-combat that only requires an action', () => {
    expect(definition().name).toBe('manage-combat');
    expect(definition().inputSchema.required).toEqual(['action']);
  });

  it('offers the encounter actions', () => {
    const action = (definition().inputSchema.properties as any).action;
    expect(action.enum).toEqual(
      expect.arrayContaining([
        'state',
        'create',
        'add',
        'start',
        'initiative',
        'next-turn',
        'previous-turn',
        'next-round',
        'update-combatant',
        'remove-combatant',
        'end',
      ])
    );
  });

  it('says that changes need Allow Write Operations', () => {
    expect(definition().description).toMatch(/Allow Write Operations/);
  });
});

describe('manage-combat arguments', () => {
  it('forwards valid arguments to the bridge', async () => {
    const { tools, query } = makeTools();
    const args = {
      action: 'create',
      tokens: ['Grauwolf'],
      rollInitiative: 'npcs',
      begin: true,
      messageMode: 'gm',
    };

    await tools.handleManageCombat(args);

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.manageCombat', args);
  });

  it.each([
    [{ action: 'create' }, /tokens/],
    [{ action: 'add', combat: 'x' }, /tokens/],
    [{ action: 'update-combatant', combatants: ['a'] }, /defeated/],
    [{ action: 'remove-combatant' }, /combatants/],
    [{ action: 'initiative', mode: 'everyone' }, /mode/],
    [{ action: 'state', unknown: 1 }, /unknown|Unrecognized/i],
  ])('rejects %j without calling Foundry', async (args, message) => {
    const { tools, query } = makeTools();

    const result: any = await tools.handleManageCombat(args);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(message);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns a bridge error as a failed result', async () => {
    const { tools } = makeTools(async () => {
      throw new Error('No encounter on scene "Cave"');
    });

    const result: any = await tools.handleManageCombat({ action: 'state' });

    expect(result).toEqual({ success: false, error: 'No encounter on scene "Cave"' });
  });
});
