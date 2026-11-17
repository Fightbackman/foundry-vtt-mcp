/**
 * dsa5-add-items: the item handling runs in the Foundry module (dsa5-add-items.ts); these
 * tests cover the MCP layer (schema validation and forwarding to the bridge query).
 */

import { describe, it, expect, vi } from 'vitest';
import { DSA5AddItemsTools } from './add-items.js';

function makeTools(queryImpl?: (method: string, data: any) => unknown) {
  const query = vi.fn(queryImpl ?? (async () => ({ success: true })));
  const logger: any = { info: vi.fn(), error: vi.fn(), child: () => logger };
  const tools = new DSA5AddItemsTools({ foundryClient: { query } as any, logger });
  return { tools, query };
}

describe('DSA5AddItemsTools', () => {
  it('exposes dsa5-add-items as a DSA5-only tool', () => {
    const [def] = makeTools().tools.getToolDefinitions();
    expect(def.name).toBe('dsa5-add-items');
    expect(def.description.startsWith('[DSA5 only]')).toBe(true);
    expect(def.inputSchema.required).toEqual(['actor', 'items']);
  });

  it('forwards a valid call to the dsa5AddItems bridge query', async () => {
    const { tools, query } = makeTools();
    const args = {
      actor: 'Alrike',
      free: false,
      items: [
        { name: 'Begabung', adoption: 'Klettern' },
        { uuid: 'Compendium.x.Item.abc', quantity: 3 },
        { name: 'Hohe Lebenskraft', type: 'advantage', step: 2, free: true },
      ],
    };
    expect(await tools.handleAddItems(args)).toEqual({ success: true });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.dsa5AddItems', args);
  });

  it('rejects items without uuid or name, bad quantities and unknown keys', async () => {
    const { tools, query } = makeTools();
    for (const items of [
      [{ type: 'spell' }],
      [{ name: 'Pfeil', quantity: 0 }],
      [{ name: 'x', foo: 1 }],
    ]) {
      const result: any = await tools.handleAddItems({ actor: 'Alrike', items });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid arguments/);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts the remove action', async () => {
    const { tools, query } = makeTools();
    await tools.handleAddItems({ actor: 'Alrike', action: 'remove', items: [{ name: 'Neugier' }] });
    expect(query.mock.calls[0][1]).toMatchObject({ action: 'remove' });
  });
});
