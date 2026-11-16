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

Checked against the system's data models (dsa5-foundryVTT 8.x, `modules/data/actor`).
Many values the sheet shows are **derived at runtime** and are not stored on the actor;
writing them has no effect. `manage-actors` therefore maps its shorthands onto the stored
parts (see `describeActorSchema` in `adapter.ts`).

### Eigenschaften (8 Attributes)

```
system.characteristics.<mu|kl|in|ch|ff|ge|ko|kk>
  .initial   stored   base value (default 8)
  .advances  stored   purchased increases
  .modifier  stored   temporary modifier
  .value     derived  initial + advances + modifier + gear
```

MU Mut/Courage, KL Klugheit/Cleverness, IN Intuition, CH Charisma, FF Fingerfertigkeit/Dexterity,
GE Gewandtheit/Agility, KO Konstitution/Constitution, KK Körperkraft/Strength.

### Status & Resources

```
system.status.wounds.value        stored   current LeP
system.status.wounds.initial      stored   base LeP (creatures: the whole pool)
system.status.wounds.max          derived  character/npc: initial + 2×KO + advances + modifier
                                           creature:      initial + advances + modifier
system.status.wounds.current      derived  intermediate base of that formula, NOT the current LeP
system.status.astralenergy.*      AsP, same layout (value = current, max derived)
system.status.karmaenergy.*       KaP, same layout
system.status.fatePoints.value    stored   Schicksalspunkte left (.current = base maximum)
```

### Profile

```
system.details.species.value     → Species (Mensch, Elf, Zwerg...)
system.details.culture.value     → Culture
system.details.career.value      → Profession (IMPORTANT: "career", not "profession"!)
system.details.experience.total  → Total Adventure Points (AP)
system.details.experience.spent  → Spent AP (available = total − spent, derived)
system.creatureClass.value       → Creature class (creatures only)
```

### Combat

```
system.status.size.value          tiny | small | average | big | giant
system.status.speed.initial       stored   base GS (.max derived)
system.status.initiative.current  stored   base INI of a creature
system.status.initiative.value    derived  heroes: (MU + GE) / 2 + modifier
system.status.dodge.max           derived  GE / 2 + modifier (all actor types)
system.status.soulpower.max       derived  SK (creatures store .value)
system.status.toughness.max       derived  ZK (creatures store .value)
system.totalArmor                 derived  RS from equipped armor items
```

### Skills/Talente

```
Items with type "skill" (Talent) or "combatskill" (Kampftechnik)
Value: item.system.talentValue.value
Check: item.system.characteristic1..3.value (e.g. kl / kl / in)
```

## Experience Levels (Erfahrungsgrad)

DSA5 classifies heroes by their total Adventure Points (AP). The thresholds are the
starting AP of hero creation and match the system's own
`DSA5_Utility.experienceDescription`:

| Level | Name (DE)        | Name (EN)     | AP Range    |
| ----- | ---------------- | ------------- | ----------- |
| 1     | Unerfahren       | Inexperienced | 0 - 999     |
| 2     | Durchschnittlich | Average       | 1000 - 1099 |
| 3     | Erfahren         | Experienced   | 1100 - 1199 |
| 4     | Kompetent        | Competent     | 1200 - 1399 |
| 5     | Meisterlich      | Masterful     | 1400 - 1699 |
| 6     | Brillant         | Brilliant     | 1700 - 2099 |
| 7     | Legendär         | Legendary     | 2100+       |

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
