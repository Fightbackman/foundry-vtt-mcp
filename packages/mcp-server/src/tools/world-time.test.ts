/**
 * world-time tool tests: schema shape, argument validation per action, and forwarding to
 * the bridge query. Calendar conversion, validation of dates and the effect report run
 * browser-side and are covered in foundry-module/src/world-time.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { WorldTimeTools } from './world-time.js';

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
  const tools = new WorldTimeTools({ foundryClient, logger });
  return { tools, query };
}

describe('world-time tool definition', () => {
  const definition = () => makeTools().tools.getToolDefinitions()[0];

  it('is a generic tool named world-time with get / advance / set', () => {
    expect(definition().name).toBe('world-time');
    expect(definition().description).not.toMatch(/^\[DSA5 only\]/);
    const props = definition().inputSchema.properties as Record<string, any>;
    expect(props.action.enum).toEqual(['get', 'advance', 'set']);
    expect(definition().inputSchema.required).toEqual(['action']);
  });

  it('offers combinable advance units and partial date components', () => {
    const props = definition().inputSchema.properties as Record<string, any>;
    for (const key of ['seconds', 'minutes', 'hours', 'days', 'weeks']) {
      expect(props[key]).toBeDefined();
    }
    for (const key of ['year', 'month', 'day', 'hour', 'minute', 'second', 'worldTime']) {
      expect(props[key]).toBeDefined();
    }
    expect(props.month.type).toEqual(['integer', 'string']);
  });
});

describe('world-time tool handler', () => {
  it('forwards get to the bridge', async () => {
    const { tools, query } = makeTools();
    await tools.handleWorldTime({ action: 'get' });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.worldTime', { action: 'get' });
  });

  it('forwards a combined advance', async () => {
    const { tools, query } = makeTools();
    await tools.handleWorldTime({ action: 'advance', days: 1, hours: -2 });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.worldTime', {
      action: 'advance',
      days: 1,
      hours: -2,
    });
  });

  it('forwards a set with a month name', async () => {
    const { tools, query } = makeTools();
    await tools.handleWorldTime({ action: 'set', year: 1041, month: 'Rondra', day: 15 });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.worldTime', {
      action: 'set',
      year: 1041,
      month: 'Rondra',
      day: 15,
    });
  });

  it.each([
    [{ action: 'advance' }, /advance needs at least one of/],
    [{ action: 'advance', hours: 1, hour: 3 }, /advance takes amounts only/],
    [{ action: 'set' }, /set needs at least one of/],
    [{ action: 'set', hour: 3, days: 1 }, /set takes a date/],
    [{ action: 'get', hours: 1 }, /get takes no other arguments/],
    [{ action: 'set', day: 1.5 }, /day/],
    [{ action: 'rewind' }, /action/],
    [{ action: 'get', extra: true }, /Unrecognized key/],
  ])('rejects %j without calling the bridge', async (args, message) => {
    const { tools, query } = makeTools();
    const result: any = await tools.handleWorldTime(args);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(message);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns bridge errors as a failed result', async () => {
    const { tools } = makeTools(async () => {
      throw new Error('Day 6 does not exist in Namenlose Tage of year 1041: valid days are 1 to 5');
    });
    const result: any = await tools.handleWorldTime({ action: 'set', month: 13, day: 6 });
    expect(result).toEqual({
      success: false,
      error: 'Day 6 does not exist in Namenlose Tage of year 1041: valid days are 1 to 5',
    });
  });
});
