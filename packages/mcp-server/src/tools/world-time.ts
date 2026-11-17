import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface WorldTimeToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const ADVANCE_KEYS = ['seconds', 'minutes', 'hours', 'days', 'weeks'] as const;
const SET_KEYS = ['year', 'month', 'day', 'hour', 'minute', 'second', 'worldTime'] as const;

const worldTimeSchema = z
  .object({
    action: z.enum(['get', 'advance', 'set']),
    seconds: z.number().finite().optional(),
    minutes: z.number().finite().optional(),
    hours: z.number().finite().optional(),
    days: z.number().finite().optional(),
    weeks: z.number().finite().optional(),
    year: z.number().int().optional(),
    month: z.union([z.number().int(), z.string().min(1)]).optional(),
    day: z.number().int().optional(),
    hour: z.number().int().optional(),
    minute: z.number().int().optional(),
    second: z.number().int().optional(),
    worldTime: z.number().int().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const has = (keys: readonly string[]) =>
      keys.filter(k => (value as Record<string, unknown>)[k] !== undefined);
    const advanceGiven = has(ADVANCE_KEYS);
    const setGiven = has(SET_KEYS);
    if (value.action === 'get' && (advanceGiven.length || setGiven.length)) {
      ctx.addIssue({ code: 'custom', message: 'get takes no other arguments' });
    }
    if (value.action === 'advance') {
      if (setGiven.length) {
        ctx.addIssue({
          code: 'custom',
          message: `advance takes amounts only (${ADVANCE_KEYS.join(', ')}), not ${setGiven.join(', ')}`,
        });
      }
      if (!advanceGiven.length) {
        ctx.addIssue({
          code: 'custom',
          message: `advance needs at least one of ${ADVANCE_KEYS.join(', ')}`,
        });
      }
    }
    if (value.action === 'set') {
      if (advanceGiven.length) {
        ctx.addIssue({
          code: 'custom',
          message: `set takes a date (${SET_KEYS.join(', ')}), not ${advanceGiven.join(', ')}`,
        });
      }
      if (!setGiven.length) {
        ctx.addIssue({
          code: 'custom',
          message: `set needs at least one of ${SET_KEYS.join(', ')}`,
        });
      }
    }
  });

/**
 * world-time tool: read, advance or set the in-game date through Foundry's world
 * calendar (`game.time`), in any system. Advancing goes through `game.time.advance`, so
 * effect durations, system hooks and calendar widgets react as to the GM's own controls.
 */
export class WorldTimeTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WorldTimeToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WorldTimeTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'world-time',
        description:
          'Read or change the in-game date and time (Foundry world time) through the ' +
          "world's calendar, in any system. " +
          'action "get": the current date as year, month (number and name), day of month, ' +
          "weekday, hour, minute, second, season and the system's own formatted date, plus the " +
          'raw worldTime in seconds and the list of months with their lengths. ' +
          'action "advance": move time forward by seconds / minutes / hours / days / weeks ' +
          '(combinable; negative values rewind). ' +
          'action "set": jump to a date; give only the parts to change (e.g. just hour and ' +
          'minute for a new time of day) and the rest stays; month by number (1-based) or name. ' +
          'Invalid dates are refused with the valid range. advance and set report the date ' +
          'before and after and the timed effects/conditions that expired because of the ' +
          'change; they need Allow Write Operations. ' +
          'In DSA5 worlds the Aventurian calendar is used (Praios … Rahja, then the 5 ' +
          'Namenlose Tage; years BF; month names such as "Rondra" or "Namenlose Tage"), and ' +
          'reads add moon phase, time of day and holidays; advance/set also report the ' +
          'time-of-day change that drives automatic scene daylight and the decay of timed ' +
          'conditions.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['get', 'advance', 'set'],
              description: 'get = read, advance = move by an amount, set = jump to a date',
            },
            seconds: { type: 'number', description: 'advance: seconds to add (negative rewinds)' },
            minutes: { type: 'number', description: 'advance: minutes to add' },
            hours: { type: 'number', description: 'advance: hours to add' },
            days: { type: 'number', description: 'advance: days to add' },
            weeks: {
              type: 'number',
              description: "advance: weeks to add (the calendar's weekday count)",
            },
            year: { type: 'integer', description: 'set: year (DSA5: year BF, e.g. 1041)' },
            month: {
              type: ['integer', 'string'],
              description:
                'set: month as 1-based number or name (localized or as configured, e.g. ' +
                '"Rondra", "Namenlose Tage")',
            },
            day: { type: 'integer', description: 'set: day of month, 1-based' },
            hour: { type: 'integer', description: 'set: hour, 0-based (0–23 on a 24-hour day)' },
            minute: { type: 'integer', description: 'set: minute' },
            second: { type: 'integer', description: 'set: second' },
            worldTime: {
              type: 'integer',
              description:
                'set: raw world time in seconds instead of a date (e.g. 0 for the calendar epoch)',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    ];
  }

  async handleWorldTime(args: unknown) {
    const parsed = worldTimeSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    this.logger.info('World time request', { action: parsed.data.action });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.worldTime', parsed.data);
    } catch (error) {
      this.logger.error('World time request failed', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
