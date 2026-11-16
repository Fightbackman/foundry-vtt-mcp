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

## Conditions

`toggle-token-condition` and `get-available-conditions` use DSA5's own condition API (`actor.addCondition` / `actor.removeCondition`, implemented in `packages/foundry-module/src/dsa5-conditions.ts`), not `toggleStatusEffect`, which in DSA5 adds one level per call.

- Many conditions have levels (usually 1–4; `get-available-conditions` reports `maxLevel`). Each level is the sum of an **automatic** share, which the system sets itself (pain from lost LeP, encumbrance from armour, stupor from brawling), and a **manual** share.
- `level: N` sets the total to N by changing only the manual share. It is capped at the maximum, and cannot go below the automatic share; both cases return a warning.
- `active: true` adds level 1 if the condition is missing and otherwise leaves it as it is. `active: false` or `level: 0` removes it, except for automatic levels: the system recalculates those after every effect change and would re-apply them at once, so they stay and a warning says so.
- Conditions can be named by id or by localized name, case-insensitively (`inpain`, or `Schmerz` / `Pain` depending on the world's language).
- The system only applies conditions to an unlinked token while that token is drawn on the canvas; otherwise the tool returns an error instead of silently doing nothing.
- `get-character` lists each effect's `statuses` and, for leveled conditions, `level` and `maxLevel`.

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
