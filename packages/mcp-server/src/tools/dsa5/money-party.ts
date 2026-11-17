import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface DSA5MoneyPartyToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const coinCount = z.number().int().min(0);

const amountSchema = z.union([
  z.number().positive(),
  z.string().min(1).max(100),
  z
    .object({
      dukaten: coinCount.optional(),
      silbertaler: coinCount.optional(),
      heller: coinCount.optional(),
      kreuzer: coinCount.optional(),
    })
    .strict(),
]);

const moneySchema = z
  .object({
    action: z.enum(['get', 'pay', 'receive', 'transfer']),
    actors: z.array(z.string().min(1)).optional(),
    party: z.boolean().optional(),
    amount: amountSchema.optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    postToChat: z.boolean().optional(),
    description: z.string().max(200).optional(),
  })
  .strict();

const partySchema = z
  .object({
    action: z.enum(['get', 'schips', 'add-member', 'remove-member', 'set-primary']),
    group: z.string().min(1).optional(),
    list: z.enum(['auto', 'group', 'gmMenu']).optional(),
    target: z.string().min(1).optional(),
    operation: z.enum(['use', 'restore', 'set']).optional(),
    amount: z.number().int().min(1).optional(),
    value: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
    actor: z.string().min(1).optional(),
  })
  .strict();

const actorsProperty = {
  type: 'array',
  items: { type: 'string' },
  description: 'Actor names or ids.',
};

/**
 * dsa5-money and dsa5-party: money through the DSA5 system's own payment functions, and
 * the party as the system defines it (primary party group actor, GM menu heroes, group
 * Schicksalspunkte).
 */
export class DSA5MoneyPartyTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: DSA5MoneyPartyToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'DSA5MoneyPartyTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'dsa5-money',
        description:
          "[DSA5 only] Read and change heroes' money with the DSA5 system's own payment rules. " +
          'A purse is the coin items Dukaten (10 S), Silbertaler (1 S), Heller (0.1 S) and ' +
          'Kreuzer (0.01 S). action "get": purse per coin and total in Silbertaler for `actors` ' +
          'and/or the `party` (default: the party), with the combined total. action "pay" / ' +
          '"receive": every listed actor (and every party member with `party: true`) pays or ' +
          "receives the full `amount` - like the GM menu's group payment, the amount is not " +
          'split. The system makes change across coins (paying 3 Heller from 1 Dukat leaves ' +
          '9 S 9 H 7 K) and writes the money tracker entry; `postToChat` posts its chat ' +
          'message. A payment is all-or-nothing: if anyone cannot afford it, nothing is ' +
          'written and the result says what is missing. Actors without coin items get the ' +
          "standard coins from the system's money compendium before receiving. action " +
          '"transfer": `from` pays `to` (refused if `from` cannot afford it). `amount`: ' +
          'Silbertaler as a number (3.5), per coin ({"dukaten":1,"heller":5}), or the ' +
          'system\'s own string format: a number or roll formula in Silbertaler ("12,5", ' +
          '"2d6", "1W6*10"; rolled per actor). `description` is the entry name in the money ' +
          'tracker. Writes require Allow Write Operations.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['get', 'pay', 'receive', 'transfer'] },
            actors: actorsProperty,
            party: {
              type: 'boolean',
              description:
                'Include the party (primary party group members, else GM menu heroes, else ' +
                'player-owned actors).',
            },
            amount: {
              description:
                'Silbertaler as a number, coins as {dukaten, silbertaler, heller, kreuzer}, or ' +
                'a number/roll formula string in Silbertaler.',
              anyOf: [
                { type: 'number', exclusiveMinimum: 0 },
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    dukaten: { type: 'integer', minimum: 0 },
                    silbertaler: { type: 'integer', minimum: 0 },
                    heller: { type: 'integer', minimum: 0 },
                    kreuzer: { type: 'integer', minimum: 0 },
                  },
                  additionalProperties: false,
                },
              ],
            },
            from: { type: 'string', description: 'transfer: paying actor (name or id).' },
            to: { type: 'string', description: 'transfer: receiving actor (name or id).' },
            postToChat: {
              type: 'boolean',
              description: "Post the system's payment chat message (default false).",
            },
            description: {
              type: 'string',
              description:
                'Purpose shown in the money tracker journal (e.g. "Zimmer im Gasthaus").',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'dsa5-party',
        description:
          "[DSA5 only] The heroes' party as the DSA5 system defines it: the members of the " +
          "primary party group actor, else the GM menu's tracked heroes, else all player-owned " +
          'actors. action "get": one line per member (LeP, AsP/KaP, Schicksalspunkte, money ' +
          'total, conditions), the group actor (purse, depots, aggregate stats) if there is ' +
          'one, and the group Schicksalspunkte (current/max). `group` inspects a specific ' +
          'group actor. action "schips": `target` "group" (default) or a hero; `operation` ' +
          '"use" (`amount`, default 1; refused if not enough), "restore" (`amount`, default: ' +
          'back to the maximum) or "set" (`value`; for the group also `max`). action ' +
          '"add-member" / "remove-member" with `actor`: edits the primary party group actor ' +
          "(or `group`) through its own API, or the GM menu's hero list when there is no " +
          'group actor or `list` is "gmMenu". action "set-primary" with `group`: make that ' +
          'group actor the primary party (like the toggle on the group sheet). Writes ' +
          'require Allow Write Operations.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['get', 'schips', 'add-member', 'remove-member', 'set-primary'],
            },
            group: {
              type: 'string',
              description: 'A group actor (name or id) to use instead of the primary party.',
            },
            list: {
              type: 'string',
              enum: ['auto', 'group', 'gmMenu'],
              description: 'add/remove-member: which list to edit (default auto).',
            },
            target: {
              type: 'string',
              description: 'schips: "group" for the group Schicksalspunkte, or a hero name/id.',
            },
            operation: { type: 'string', enum: ['use', 'restore', 'set'] },
            amount: { type: 'integer', minimum: 1 },
            value: { type: 'integer', minimum: 0, description: 'set: new current value.' },
            max: { type: 'integer', minimum: 0, description: 'set (group only): new maximum.' },
            actor: { type: 'string', description: 'add/remove-member: actor name or id.' },
          },
          required: ['action'],
        },
      },
    ];
  }

  private invalid(error: z.ZodError) {
    const detail = error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { success: false, error: `Invalid arguments: ${detail}` };
  }

  async handleMoney(args: unknown) {
    const parsed = moneySchema.safeParse(args);
    if (!parsed.success) return this.invalid(parsed.error);
    const data = parsed.data;

    if (data.action !== 'get' && data.amount === undefined) {
      return { success: false, error: `${data.action} needs amount` };
    }
    if (
      (data.action === 'pay' || data.action === 'receive') &&
      !data.actors?.length &&
      !data.party
    ) {
      return { success: false, error: `${data.action} needs actors and/or party: true` };
    }
    if (data.action === 'transfer' && (!data.from || !data.to)) {
      return { success: false, error: 'transfer needs from and to' };
    }

    this.logger.info('DSA5 money', { action: data.action });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.dsa5Money', data);
    } catch (error) {
      this.logger.error('DSA5 money failed', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async handleParty(args: unknown) {
    const parsed = partySchema.safeParse(args);
    if (!parsed.success) return this.invalid(parsed.error);
    const data = parsed.data;

    if (data.action === 'schips' && !data.operation) {
      return { success: false, error: 'schips needs operation: use, restore or set' };
    }
    if ((data.action === 'add-member' || data.action === 'remove-member') && !data.actor) {
      return { success: false, error: `${data.action} needs actor` };
    }
    if (data.action === 'set-primary' && !data.group) {
      return { success: false, error: 'set-primary needs group' };
    }

    this.logger.info('DSA5 party', { action: data.action });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.dsa5Party', data);
    } catch (error) {
      this.logger.error('DSA5 party failed', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
