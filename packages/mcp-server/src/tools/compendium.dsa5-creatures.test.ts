/**
 * list-creatures-by-criteria in a DSA5 world.
 *
 * The index itself is built and filtered browser-side
 * (foundry-module/src/dsa5-creature-index.ts); this covers the MCP tool layer: the
 * DSA5 criteria are advertised, validated and forwarded, and the module's result is
 * passed through instead of being squeezed into the D&D-shaped default.
 */

import { describe, it, expect, vi } from 'vitest';
import { CompendiumTools } from './compendium.js';

const wolf = {
  id: 'wolf1',
  name: 'Grauwolf',
  type: 'creature',
  pack: 'world.bestiary',
  packLabel: 'Bestiary',
  hasImage: true,
  summary: 'creature: Tier, nicht humanoid — small, 18 LeP — from Bestiary',
  creatureClass: 'Tier, nicht humanoid',
  size: 'small',
  lifePoints: 18,
  hasSpells: false,
};

function makeTools(creatures: any[] = [wolf]) {
  const query = vi.fn(async (method: string) => {
    if (method === 'foundry-mcp-bridge.listCreaturesByCriteria') {
      return { response: { creatures, searchSummary: { packsSearched: 1 } } };
    }
    // system detection
    return { system: 'dsa5', systemId: 'dsa5', id: 'dsa5' };
  });
  const logger: any = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => logger,
  };
  const tools = new CompendiumTools({ foundryClient: { query } as any, logger });
  (tools as any).gameSystem = 'dsa5';
  return { tools, query };
}

const criteriaSent = (query: ReturnType<typeof vi.fn>) =>
  query.mock.calls.find(call => call[0] === 'foundry-mcp-bridge.listCreaturesByCriteria')?.[1];

describe('list-creatures-by-criteria for DSA5', () => {
  it('advertises the DSA5 criteria', () => {
    const { tools } = makeTools();
    const definition = tools
      .getToolDefinitions()
      .find(d => d.name === 'list-creatures-by-criteria')!;
    const props = definition.inputSchema.properties as Record<string, any>;
    expect(props.creatureClass.type).toBe('string');
    expect(props.species.type).toBe('string');
    expect(props.actorType.enum).toEqual(['creature', 'npc', 'character']);
    expect(props.size.enum).toEqual(expect.arrayContaining(['average', 'big', 'giant']));
    expect(definition.description).toContain('DSA5');
  });

  it('forwards the DSA5 criteria to the bridge', async () => {
    const { tools, query } = makeTools();
    const result = await tools.handleListCreaturesByCriteria({
      creatureClass: 'Tier',
      species: 'Elf',
      actorType: 'creature',
      size: 'big',
      hitPoints: { min: 10, max: 40 },
      hasSpells: false,
    });
    expect(criteriaSent(query)).toMatchObject({
      creatureClass: 'Tier',
      species: 'Elf',
      actorType: 'creature',
      size: 'big',
      hitPoints: { min: 10, max: 40 },
      hasSpells: false,
    });
    expect(result.gameSystem).toBe('dsa5');
    expect(result.criteriaDescription).toContain('class contains "Tier"');
    expect(result.criteriaDescription).toContain('LeP 10-40');
  });

  it('rejects an unknown actor type', async () => {
    const { tools } = makeTools();
    await expect(tools.handleListCreaturesByCriteria({ actorType: 'vehicle' })).rejects.toThrow(
      /Parameter validation failed/
    );
  });

  it("passes the module's DSA5 result through", async () => {
    const { tools } = makeTools();
    const result = await tools.handleListCreaturesByCriteria({});
    expect(result.creatures).toEqual([
      {
        name: 'Grauwolf',
        id: 'wolf1',
        type: 'creature',
        pack: { id: 'world.bestiary', label: 'Bestiary' },
        summary: 'creature: Tier, nicht humanoid — small, 18 LeP — from Bestiary',
        creatureClass: 'Tier, nicht humanoid',
        size: 'small',
        lifePoints: 18,
        hasSpells: false,
      },
    ]);
    expect(result.searchSummary.searchStrategy).toContain('DSA5');
  });

  it('keeps name-only fallback results free of D&D defaults', async () => {
    const fallback = { id: 'x1', name: 'Oger', type: 'creature', pack: 'p', packLabel: 'P' };
    const { tools } = makeTools([fallback]);
    const result = await tools.handleListCreaturesByCriteria({});
    expect(result.creatures).toEqual([
      { name: 'Oger', id: 'x1', type: 'creature', pack: { id: 'p', label: 'P' } },
    ]);
  });
});
