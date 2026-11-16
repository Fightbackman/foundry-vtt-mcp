/**
 * toggle-token-condition tool tests: the level parameter (DSA5) and passing the
 * bridge's condition details through. Applying conditions runs browser-side and is
 * covered in foundry-module/src/dsa5-conditions.test.ts and
 * data-access.token-conditions.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { TokenManipulationTools } from './token-manipulation.js';

function makeTools(queryResult: unknown = { success: true, isActive: true }) {
  const query = vi.fn(async () => queryResult);
  const logger: any = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => logger,
  };
  const tools = new TokenManipulationTools({ foundryClient: { query } as any, logger });
  return { tools, query };
}

describe('toggle-token-condition', () => {
  it('advertises an optional whole-number level', () => {
    const { tools } = makeTools();
    const definition = tools.getToolDefinitions().find(d => d.name === 'toggle-token-condition')!;
    const props = definition.inputSchema.properties as Record<string, any>;

    expect(props.level).toMatchObject({ type: 'integer', minimum: 0 });
    expect(props.level.description).toMatch(/DSA5 only/);
    expect(definition.inputSchema.required).toEqual(['tokenId', 'conditionId']);
  });

  it('forwards a level to the bridge', async () => {
    const { tools, query } = makeTools();

    await tools.handleToggleTokenCondition({ tokenId: 't1', conditionId: 'inpain', level: 2 });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.toggle-token-condition', {
      tokenId: 't1',
      conditionId: 'inpain',
      active: undefined,
      level: 2,
    });
  });

  it('sends no level when none was given', async () => {
    const { tools, query } = makeTools();

    await tools.handleToggleTokenCondition({ tokenId: 't1', conditionId: 'prone', active: true });

    expect(query.mock.calls[0]).toEqual([
      'foundry-mcp-bridge.toggle-token-condition',
      { tokenId: 't1', conditionId: 'prone', active: true },
    ]);
  });

  it('rejects a negative or fractional level before calling Foundry', async () => {
    const { tools, query } = makeTools();

    await expect(
      tools.handleToggleTokenCondition({ tokenId: 't1', conditionId: 'inpain', level: -1 })
    ).rejects.toThrow();
    await expect(
      tools.handleToggleTokenCondition({ tokenId: 't1', conditionId: 'inpain', level: 1.5 })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('passes the resolved id, level details and warnings through', async () => {
    const { tools } = makeTools({
      success: true,
      conditionId: 'inpain',
      conditionName: 'Schmerz',
      isActive: true,
      level: 2,
      maxLevel: 4,
      autoLevel: 2,
      manualLevel: 0,
      warnings: ['Schmerz has 2 level(s) applied automatically by the system'],
    });

    const result = await tools.handleToggleTokenCondition({
      tokenId: 't1',
      conditionId: 'Schmerz',
      level: 1,
    });

    expect(result).toEqual({
      success: true,
      tokenId: 't1',
      conditionId: 'inpain',
      conditionName: 'Schmerz',
      isActive: true,
      level: 2,
      maxLevel: 4,
      autoLevel: 2,
      manualLevel: 0,
      warnings: ['Schmerz has 2 level(s) applied automatically by the system'],
    });
  });

  it('keeps the result shape of other systems unchanged', async () => {
    const { tools } = makeTools({
      success: true,
      conditionId: 'prone',
      conditionName: 'Prone',
      isActive: true,
      active: true,
      message: 'Applied prone to Goblin',
    });

    const result = await tools.handleToggleTokenCondition({
      tokenId: 't1',
      conditionId: 'prone',
      active: true,
    });

    expect(result).toEqual({
      success: true,
      tokenId: 't1',
      conditionId: 'prone',
      isActive: true,
      conditionName: 'Prone',
    });
  });
});
