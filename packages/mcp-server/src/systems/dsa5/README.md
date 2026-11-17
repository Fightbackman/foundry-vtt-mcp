# DSA5 System Adapter

DSA5 (Das Schwarze Auge 5) support for Foundry VTT MCP integration.

## Overview

This adapter implements the v0.6.0 Registry Pattern to provide system-specific support for DSA5 characters and creatures in the Foundry VTT MCP server.

## Features

### Character Statistics Extraction

- **8 Eigenschaften (Attributes):** MU, KL, IN, CH, FF, GE, KO, KK
- **LeP (Lebensenergie):** Life points tracking
- **AsP (Astralenergie):** Mana/spell energy for spellcasters
- **KaP (Karmaenergie):** Karma energy for blessed ones
- **Talente (Skills):** All character skills with values and check attributes
- **Erfahrungsgrad (Experience Level):** 1-7 level classification based on Adventure Points

### Creature Index

- Full compendium indexing for DSA5 creatures
- Species, culture, profession metadata
- Combat statistics (LeP, Parade, Ausweichen, Rüstung)
- Spellcasting and resource detection

### Filter System

Supports filtering creatures by:

- `level`: Experience level 1-7 (e.g., `{level: 3}` for Experienced)
- `species`: Species/race (e.g., `{species: "Mensch"}`)
- `culture`: Culture background (e.g., `{culture: "Mittelreich"}`)
- `size`: Size category (tiny, small, medium, large, huge)
- `hasSpells`: Boolean - has spellcasting abilities
- `traits`: Array of special abilities/traits to match

## Architecture

### Files

```
systems/dsa5/
├── adapter.ts         (378 lines) - SystemAdapter implementation
├── constants.ts       (201 lines) - Field paths, mappings, experience levels
├── filters.ts         (202 lines) - Zod schemas, filter matching logic
├── filters.test.ts    (102 lines) - Unit tests for filters
├── index-builder.ts   (319 lines) - IndexBuilder implementation
├── index.ts           (46 lines)  - Public API exports
└── README.md          - This file
```

### Key Classes

**DSA5Adapter** (`adapter.ts`)

- Implements `SystemAdapter` interface (11 methods)
- Runs in MCP server (Node.js context)
- Handles filtering, formatting, character stat extraction

**DSA5IndexBuilder** (`index-builder.ts`)

- Implements `IndexBuilder` interface
- Runs in Foundry module (browser context)
- Builds enhanced creature indexes from compendium packs

## DSA5 Field Mappings

### Eigenschaften (8 Attributes)

```
system.characteristics.mu.value  → MU (Mut/Courage)
system.characteristics.kl.value  → KL (Klugheit/Cleverness)
system.characteristics.in.value  → IN (Intuition)
system.characteristics.ch.value  → CH (Charisma)
system.characteristics.ff.value  → FF (Fingerfertigkeit/Dexterity)
system.characteristics.ge.value  → GE (Gewandtheit/Agility)
system.characteristics.ko.value  → KO (Konstitution/Constitution)
system.characteristics.kk.value  → KK (Körperkraft/Strength)
```

### Status & Resources

```
system.status.wounds.value       → Current wounds (NOT inverted in v0.6.1!)
system.status.wounds.max         → Maximum life points
system.status.astralenergy.*     → AsP (Astral energy)
system.status.karmaenergy.*      → KaP (Karma energy)
```

### Profile

```
system.details.species.value     → Species (Mensch, Elf, Zwerg...)
system.details.culture.value     → Culture
system.details.career.value      → Profession (IMPORTANT: "career", not "profession"!)
system.details.experience.total  → Total Adventure Points (AP)
```

### Combat

```
system.status.size.value         → Size in cm
system.status.parry.value        → Melee defense (Parade)
system.status.dodge.value        → Ranged defense (Ausweichen)
```

### Skills/Talente

```
Items with type: "skill" or "talent"
Value: item.system.talentValue.value
Check: item.system.characteristic (e.g., "MU/IN/CH")
```

## Experience Levels (Erfahrungsgrad)

DSA5 uses a 7-level experience classification based on total Adventure Points (AP):

| Level | Name (DE)        | Name (EN)     | AP Range    |
| ----- | ---------------- | ------------- | ----------- |
| 1     | Unerfahren       | Inexperienced | 0 - 899     |
| 2     | Durchschnittlich | Average       | 900 - 1999  |
| 3     | Erfahren         | Experienced   | 2000 - 2999 |
| 4     | Kompetent        | Competent     | 3000 - 3999 |
| 5     | Meisterlich      | Masterful     | 4000 - 4999 |
| 6     | Brillant         | Brilliant     | 5000 - 5999 |
| 7     | Legendär         | Legendary     | 6000+       |

## Usage Examples

### Filter by Experience Level

```typescript
import { matchesDSA5Filters } from './filters.js';

const filters = { level: 3 }; // Experienced characters only
const matches = matchesDSA5Filters(creature, filters);
```

### Extract Character Stats

```typescript
import { DSA5Adapter } from './adapter.js';

const adapter = new DSA5Adapter();
const stats = adapter.extractCharacterStats(actorData);
// Returns: { attributes, resources, skills, profile, physical }
```

### Build Creature Index

```typescript
import { DSA5IndexBuilder } from './index-builder.js';

const builder = new DSA5IndexBuilder();
const index = await builder.buildIndex(packs, force);
```

## Rolls and item use

DSA5 checks are not d20 + modifier rolls, so the generic roll paths call the DSA5 system's own test pipeline instead (`packages/foundry-module/src/dsa5-rolls.ts`). The system computes the result and posts its normal chat card.

- **`request-player-rolls`** posts the system's own roll request card (the one the GM's "request roll" dialog creates). `rollType: "skill"` requests a skill check (Talentprobe, `rollTarget` = skill name or item id), `rollType: "ability"` an attribute check (Eigenschaftsprobe, `rollTarget` = MU/KL/IN/CH/FF/GE/KO/KK, the English abbreviation or the localized name). `rollModifier` must be a whole number; positive makes the check easier, negative harder. Other roll types (save, attack, initiative, custom) return an error. The designated player gets the system's roll dialog with the modifier filled in; if no owner is online the card waits and the GM can use "Roll on Behalf" or "Resend". The tool returns once the card is posted, not when the player has rolled; the outcome and quality level appear on the card.
- **`dsa5-roll-check`** rolls as the GM for any actor, NPC or creature, without a dialog: `skill`, `attribute`, `attack` / `parry` (weapon, creature trait, combat skill or `weaponless`), `dodge` and `spell` (spell, liturgy, ritual, ceremony). It returns the dice and target values, the outcome, quality level and remaining skill points, damage on an attack hit, and the AsP/KaP cost for spells. Targeted tokens turn an attack into an opposed test; a parry or dodge by the attacked token (pass its token id when it is unlinked) resolves that test as on the sheet.
- **`use-item`** does what the character sheet does: weapons and attack traits roll an attack, spells/liturgies/rituals/ceremonies their casting test, skills a skill check, consumables and plants are consumed, everything else is posted to chat. Its result includes the roll summary.

Limitations:

1. Without a dialog only the system's automatic modifiers (active effects, conditions) and the given modifier apply. Inputs the roll dialog asks for, such as the multiple-defense penalty, target size, reach comparison, combat maneuvers and spell modifications, are not applied; include them in the modifier.
2. Spell and liturgy costs are reported but not deducted. In DSA5 the caster pays them from the chat card's context menu; `dsa5-apply-damage` with `action: "pay-cost"` does that step (see below).
3. Falling damage and group checks are not covered. Regeneration is rolled by `dsa5-apply-damage` (see below).

## Damage, healing and energy

**`dsa5-apply-damage`** changes LeP, AsP and KaP through the system (`packages/foundry-module/src/dsa5-damage.ts`), so armor, brawling points, pain and the system's `preApplyDamage` hooks apply as when the GM uses the sheet or the chat card. Every result reports LeP/AsP/KaP before and after, the maximum, the armor used and the conditions DSA5 added, removed or changed (e.g. pain levels, incapacitated). An unlinked token is addressed by its token id; the change lands on that token only.

- `damage` with `messageId` applies the damage of an opposed test from its result card by running the card's own context menu entry: `armor: true` (default) is "apply damage as TP" (TP minus the RS DSA5 computed for the defender), `armor: false` is "apply damage as SP". The id of an attack or defense card linked to exactly one result works too; a still pending test, a test the defender won and an already applied card are refused. `dsa5-roll-check` attack, parry and dodge results that are part of an opposed test now include an `opposed` block with the state (pending/resolved), the winner, the damage (rolled TP, RS, after armor) and the result card id. A damage card (trap, plain dice roll) is applied to `actor`, or to its speaker.
- `damage` with `actor` and `amount` (a number or a dice formula) applies damage directly; with armor the target's RS (`Actordsa5.armorValue`) is subtracted, as DSA5 does for damage cards.
- `heal` restores LeP (`Actor#applyDamage` with a negative amount) or, with `resource`, AsP/KaP (`Actor#applyMana`); DSA5 caps both at the maximum.
- `spend` pays AsP/KaP with `Actor#applyMana`, which refuses when the actor has too few.
- `pay-cost` pays the cost of a spell, ritual, liturgy or ceremony card with the card's "Pay AsP/KaP" entry (which also starts tracking maintained spells). An insufficient pool is refused before the system is called, because DSA5 marks the card as paid even when the payment fails.
- `regenerate` rolls the regeneration test (`setupRegeneration` + `basicTest`, as the sheet's button) with the dialog's inputs as parameters (`campsite`, `interruption`, `badEnvironment`, `modifier`, `resources`) and applies the card with `RegenerationHelper`; `apply: false` only rolls, and `messageId` applies a rolled card.

Limitations:

1. The chat card actions are not exported by the system bundle; the bridge collects them from the `getChatMessageContextOptions` hook DSA5 uses to build the chat context menu and identifies them by their visibility check (`canHurt`, `canHurtSP`, `canCostMana`). If a future DSA5 version renames those, the tool reports that the action is unavailable instead of guessing.
2. With charged power sources (Kraftspeicher) DSA5 asks in a dialog how to split an AsP cost. `pay-cost` refuses then (pay from the card in Foundry); `spend` pays from the actor's own AsP only.
3. A negative regeneration result needs a confirmation in DSA5; as when it is declined, negative values are treated as 0.
4. Regeneration special abilities that are dialog checkboxes (e.g. the fixed-die options) and homunculus blood baths are not offered.
5. Dependent conditions (incapacitated at pain level IV) are added by the system shortly after the LeP change; the report waits up to about a second for them.

## Integration Points

The DSA5 adapter is registered in two places:

1. **MCP Server** (`backend.ts`):

   ```typescript
   const { DSA5Adapter } = await import('./systems/dsa5/adapter.js');
   systemRegistry.register(new DSA5Adapter());
   ```

2. **Foundry Module** (browser context - future integration):
   ```typescript
   const { DSA5IndexBuilder } = await import('./systems/dsa5/index-builder.js');
   indexBuilderRegistry.register(new DSA5IndexBuilder());
   ```

## Testing

Unit tests are provided in `filters.test.ts`:

```bash
npm test -- filters.test.ts
```

## Localization

The DSA5 adapter provides German UI text by default:

- "DSA5 Kreaturen-Index wird erstellt..."
- "Erfahrungsgrad: Erfahren (Experienced)"
- German attribute names with English translations

## Known Limitations

1. **Wounds Field Change:** In v0.6.1, `system.status.wounds.value` is used directly (not inverted). Previous versions used inversion logic.
2. **Career vs Profession:** DSA5 uses `system.details.career.value`, not `profession`
3. **Browser Context:** IndexBuilder requires Foundry module integration (planned for v0.6.2+)

## Contributing

When extending DSA5 support:

1. Add new filter fields to `DSA5FiltersSchema` in `filters.ts`
2. Update `matchesDSA5Filters()` logic
3. Add corresponding fields to `DSA5CreatureIndex` in `types.ts`
4. Update `extractCreatureData()` in `index-builder.ts`
5. Add unit tests

## Version History

- **v0.6.1** (2025-11-27): Initial DSA5 adapter for Registry Pattern
  - SystemAdapter + IndexBuilder implementation
  - Experience Level 1-7 support
  - Full filter system with 6 filter types
  - 1,248 lines of code across 6 files

## License

Same as parent project (foundry-vtt-mcp)

## References

- [DSA5 Foundry System](https://foundryvtt.com/packages/dsa5)
- [Registry Pattern Design Doc](../../docs/registry-pattern.md) (if exists)
- [GitHub Issue #11](https://github.com/adambdooley/foundry-vtt-mcp/issues/11) - Multi-system support discussion
