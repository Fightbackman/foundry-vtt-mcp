/**
 * world-time: reading, advancing and setting game.time through the world calendar.
 *
 * The calendar here is a small stand-in shaped like DSA5's DSAWorldCalendar (12 months
 * of 30 days plus 5 Namenlose Tage, month labels that are Gregorian keys translated by
 * the calendar's own `translate`) or, for the generic case, a core-style calendar whose
 * labels are plain i18n keys. Time only ever moves through game.time.advance.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deltaFromRequest,
  manageWorldTime,
  resolveMonth,
  targetTimeFromComponents,
} from './world-time.js';

const DSA_MONTH_KEYS = [
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'NamenloseTage',
];
const DSA_LABELS: Record<string, string> = {
  July: 'Praios',
  August: 'Rondra',
  September: 'Efferd',
  October: 'Travia',
  November: 'Boron',
  December: 'Hesinde',
  January: 'Firun',
  February: 'Tsa',
  March: 'Phex',
  April: 'Peraine',
  May: 'Ingerimm',
  June: 'Rahja',
  NamenloseTage: 'Namenlose Tage',
  Monday: 'Windstag',
  Thursday: 'Praiostag',
  Summer: 'Sommer',
  Rad: 'Rad',
  YearSuffix: 'BF',
};

const DAY = 86400;

function makeCalendar(dsa: boolean) {
  class Calendar {
    static isDSAcompatible = dsa ? true : undefined;
    static months = dsa
      ? [
          'Praios',
          'Rondra',
          'Efferd',
          'Travia',
          'Boron',
          'Hesinde',
          'Firun',
          'Tsa',
          'Phex',
          'Peraine',
          'Ingerimm',
          'Rahja',
          'Namenloser',
        ]
      : undefined;
    name = dsa ? 'Der Zwölfgöttliche Kalender' : 'CALENDAR.Gregorian';
    translationPrefix = 'CALENDAR.DSA';
    months = {
      values: (dsa ? DSA_MONTH_KEYS : DSA_MONTH_KEYS.slice(0, 12)).map((name, i) => ({
        name: dsa ? name : `MONTH.${name}`,
        abbreviation: dsa ? `${name}Abbr` : undefined,
        ordinal: i + 1,
        days: dsa && i === 12 ? 5 : 30,
      })),
    };
    days = {
      values: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(
        name => ({ name })
      ),
      daysPerYear: dsa ? 365 : 360,
      hoursPerDay: 24,
      minutesPerHour: 60,
      secondsPerMinute: 60,
    };
    seasons = { values: [{ name: 'Summer' }] };
    years = { firstWeekday: 3, yearSuffix: 'YearSuffix' };
    isLeapYear() {
      return false;
    }
    translate(key: string) {
      return (
        DSA_LABELS[key] ?? (key.endsWith('Abbr') ? DSA_LABELS[key.slice(0, -4)]?.slice(0, 3) : key)
      );
    }
    timeToComponents(time: number) {
      const perYear = this.days.daysPerYear * DAY;
      const year = Math.floor(time / perYear);
      let rest = time - year * perYear;
      const day = Math.floor(rest / DAY);
      rest -= day * DAY;
      let dayOfMonth = day;
      let month = 0;
      for (; month < this.months.values.length; month++) {
        if (dayOfMonth < this.months.values[month].days) break;
        dayOfMonth -= this.months.values[month].days;
      }
      const hour = Math.floor(rest / 3600);
      const minute = Math.floor((rest % 3600) / 60);
      const second = rest % 60;
      const dayOfWeek = (Math.floor(time / DAY) + 3) % 7;
      return {
        year,
        day,
        month,
        dayOfMonth,
        dayOfWeek,
        hour,
        minute,
        second,
        season: 0,
        ...(dsa ? { moon: { phase: { name: 'Rad' } } } : {}),
      };
    }
    componentsToTime(c: any) {
      return (
        (c.year ?? 0) * this.days.daysPerYear * DAY +
        (c.day ?? 0) * DAY +
        (c.hour ?? 0) * 3600 +
        (c.minute ?? 0) * 60 +
        (c.second ?? 0)
      );
    }
    async format(time: any, formatter: string) {
      const c = typeof time === 'number' ? this.timeToComponents(time) : time;
      const key = this.months.values[c.month].name;
      const name = DSA_LABELS[key] ?? key;
      return `${formatter}:${c.dayOfMonth + 1}. ${name} ${c.year} ${c.hour}:${c.minute}`;
    }
  }
  const instance: any = new Calendar();
  // Core CalendarData has no translate(); its labels are plain i18n keys.
  if (!dsa) instance.translate = undefined;
  return instance;
}

function makeEffect(id: string, name: string, seconds: number, level: number | null = null) {
  return {
    id,
    name,
    duration: { seconds, remaining: seconds, expired: false },
    system: { condition: { value: level } },
  };
}

function makeEffects(list: any[]) {
  const map = new Map(list.map(e => [e.id, e]));
  return {
    map,
    get: (id: string) => map.get(id),
    [Symbol.iterator]: () => map.values(),
  };
}

let calendar: any;
let worldTime: number;
let onAdvance: (delta: number) => void;
let settings: Record<string, any>;

function stubWorld({ dsa = true, actors = [] as any[] } = {}) {
  calendar = makeCalendar(dsa);
  worldTime = 0;
  onAdvance = () => {};
  settings = {
    'foundry-mcp-bridge.allowWriteOperations': true,
    'dsa5.calendarSettings': { lightByDayTime: true, use24HourFormat: false },
  };
  const time = {
    calendar,
    get worldTime() {
      return worldTime;
    },
    advance: vi.fn(async (delta: number) => {
      worldTime += delta;
      onAdvance(delta);
      return worldTime;
    }),
  };
  vi.stubGlobal('game', {
    ready: true,
    system: { id: dsa ? 'dsa5' : 'core-like' },
    time,
    actors,
    scenes: { viewed: null },
    settings: { get: (scope: string, key: string) => settings[`${scope}.${key}`] },
    i18n: {
      localize: (key: string) => (key.startsWith('MONTH.') ? key.slice(6) : key),
      has: () => false,
    },
    dsa5: dsa
      ? {
          apps: {
            CalendarWidget: {
              constructor: {
                dayTimeBackground: (c: any) => ({
                  key: c.hour >= 21 || c.hour < 5 ? 'night' : 'noon',
                }),
              },
            },
            CalendarPicker: {
              constructor: {
                findHolidays: async (c: any) =>
                  c.month === 1 && c.dayOfMonth === 14
                    ? [{ title: 'Schwertfest', categoryName: 'Feiertag' }]
                    : [],
              },
            },
          },
        }
      : undefined,
  });
  vi.stubGlobal('CONFIG', {
    time: { worldCalendarConfig: { years: { yearSuffix: 'YearSuffix' } } },
  });
  vi.stubGlobal('canvas', { scene: { environment: { darknessLevel: 0 }, tokens: [] } });
  return time;
}

describe('world-time', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('get', () => {
    it('reports 1-based named components, the system format and DSA5 extras', async () => {
      stubWorld();
      const result = await manageWorldTime({ action: 'get' });
      expect(result.current).toMatchObject({
        worldTime: 0,
        year: 0,
        month: 1,
        monthName: 'Praios',
        day: 1,
        weekday: 4,
        weekdayName: 'Praiostag',
        hour: 0,
        season: 'Sommer',
        formatted: 'formatPraiosGefaellig:1. Praios 0 0:0',
      });
      expect(result.current.dsa5).toMatchObject({
        era: 'BF',
        namelessDays: false,
        moonPhase: 'Rad',
        timeOfDay: 'CALENDAR.DSA.dayTimes.night',
        holidays: [],
      });
      expect(result.calendar.months).toHaveLength(13);
      expect(result.calendar.months[12]).toEqual({ number: 13, name: 'Namenlose Tage', days: 5 });
    });

    it('uses the system 24-hour format when that setting is on', async () => {
      stubWorld();
      settings['dsa5.calendarSettings'].use24HourFormat = true;
      const result = await manageWorldTime({ action: 'get' });
      expect(result.current.formatted).toMatch(/^format24Hour:/);
    });

    it('needs no write permission', async () => {
      stubWorld();
      settings['foundry-mcp-bridge.allowWriteOperations'] = false;
      const result = await manageWorldTime({ action: 'get' });
      expect(result.success).toBe(true);
    });

    it('works with a core calendar and no DSA5 extras', async () => {
      stubWorld({ dsa: false });
      const result = await manageWorldTime({ action: 'get' });
      expect(result.current.monthName).toBe('July');
      expect(result.current.formatted).toMatch(/^timestamp:/);
      expect(result.current.dsa5).toBeUndefined();
    });

    it('fails clearly without a world calendar', async () => {
      stubWorld();
      (game as any).time = { worldTime: 0 };
      await expect(manageWorldTime({ action: 'get' })).rejects.toThrow(/no world calendar API/);
    });
  });

  describe('month names', () => {
    it('accepts the localized name, number, abbreviation and the system god-month name', () => {
      stubWorld();
      expect(resolveMonth(calendar, 'Rondra')).toBe(1);
      expect(resolveMonth(calendar, 'rondra')).toBe(1);
      expect(resolveMonth(calendar, 2)).toBe(1);
      expect(resolveMonth(calendar, '13')).toBe(12);
      expect(resolveMonth(calendar, 'Namenlose Tage')).toBe(12);
      expect(resolveMonth(calendar, 'Namenloser')).toBe(12);
      expect(resolveMonth(calendar, 'Pra')).toBe(0);
    });

    // DSA5 keeps Gregorian keys internally; "July" must not silently mean Praios.
    it('refuses the internal Gregorian keys and unknown names with the valid list', () => {
      stubWorld();
      expect(() => resolveMonth(calendar, 'July')).toThrow(/Unknown month "July".*1 Praios/);
      expect(() => resolveMonth(calendar, 14)).toThrow(/out of range/);
    });
  });

  describe('set', () => {
    it('converts month and day of month into the calendar day of year', async () => {
      const time = stubWorld();
      const result = await manageWorldTime({
        action: 'set',
        year: 1041,
        month: 'Rondra',
        day: 15,
        hour: 18,
        minute: 30,
      });
      const expected = (1041 * 365 + 30 + 14) * DAY + 18 * 3600 + 30 * 60;
      expect(time.advance).toHaveBeenCalledWith(expected);
      expect(result.after).toMatchObject({ year: 1041, month: 2, day: 15, hour: 18, minute: 30 });
      expect(result.after.dsa5.holidays).toEqual([{ name: 'Schwertfest', category: 'Feiertag' }]);
    });

    it('keeps the components that are not given', async () => {
      stubWorld();
      worldTime = (1041 * 365 + 44) * DAY + 3600;
      const result = await manageWorldTime({ action: 'set', hour: 6, minute: 15 });
      expect(result.after).toMatchObject({ year: 1041, month: 2, day: 15, hour: 6, minute: 15 });
    });

    it('accepts days 1-5 of the Namenlose Tage and flags them', async () => {
      stubWorld();
      const result = await manageWorldTime({ action: 'set', year: 1041, month: 13, day: 5 });
      expect(result.after).toMatchObject({ month: 13, day: 5, monthName: 'Namenlose Tage' });
      expect(result.after.dsa5.namelessDays).toBe(true);
    });

    it('refuses a day outside the month with the valid range', async () => {
      const time = stubWorld();
      await expect(manageWorldTime({ action: 'set', month: 13, day: 6 })).rejects.toThrow(
        'Day 6 does not exist in Namenlose Tage of year 0: valid days are 1 to 5'
      );
      expect(time.advance).not.toHaveBeenCalled();
    });

    it('refuses a moved month when the kept day does not exist there', () => {
      stubWorld();
      worldTime = 29 * DAY; // 30 Praios
      expect(() => targetTimeFromComponents(calendar, { action: 'set', month: 13 })).toThrow(
        /valid days are 1 to 5/
      );
    });

    it('refuses an out-of-range time of day', async () => {
      stubWorld();
      await expect(manageWorldTime({ action: 'set', hour: 24 })).rejects.toThrow(
        'hour must be a whole number from 0 to 23 (got 24)'
      );
    });

    it('sets a raw world time', async () => {
      const time = stubWorld();
      worldTime = 5000;
      await manageWorldTime({ action: 'set', worldTime: 0 });
      expect(time.advance).toHaveBeenCalledWith(-5000);
    });

    it('does not touch the time when the date is unchanged', async () => {
      const time = stubWorld();
      const result = await manageWorldTime({ action: 'set', hour: 0 });
      expect(result.changed).toBe(false);
      expect(time.advance).not.toHaveBeenCalled();
    });
  });

  describe('advance', () => {
    it('combines units using the calendar day and week length', () => {
      stubWorld();
      expect(
        deltaFromRequest(calendar, {
          action: 'advance',
          weeks: 1,
          days: 1,
          hours: 2,
          minutes: 3,
          seconds: 4,
        })
      ).toBe(8 * DAY + 2 * 3600 + 3 * 60 + 4);
    });

    it('goes through game.time.advance and reports before and after across a year', async () => {
      const time = stubWorld();
      worldTime = (1041 * 365 + 364) * DAY + 22 * 3600; // 5. Namenlose Tage 1041, 22:00
      const result = await manageWorldTime({ action: 'advance', hours: 3 });
      expect(time.advance).toHaveBeenCalledWith(3 * 3600);
      expect(result.before).toMatchObject({ year: 1041, month: 13, day: 5, hour: 22 });
      expect(result.after).toMatchObject({ year: 1042, month: 1, day: 1, hour: 1 });
      expect(result.daylight).toMatchObject({
        autoDaylight: true,
        timeOfDayBefore: 'CALENDAR.DSA.dayTimes.night',
        sceneDarknessBefore: 0,
      });
    });

    it('allows rewinding and says expired effects stay expired', async () => {
      stubWorld();
      worldTime = 10 * DAY;
      const result = await manageWorldTime({ action: 'advance', days: -1 });
      expect(result.deltaSeconds).toBe(-DAY);
      expect(result.note).toMatch(/not restored/);
    });

    it('refuses a zero amount', async () => {
      stubWorld();
      await expect(manageWorldTime({ action: 'advance', hours: 0 })).rejects.toThrow(
        /Nothing to advance/
      );
    });

    it('requires Allow Write Operations', async () => {
      const time = stubWorld();
      settings['foundry-mcp-bridge.allowWriteOperations'] = false;
      await expect(manageWorldTime({ action: 'advance', hours: 1 })).rejects.toThrow(
        /Modify World Time is disabled/
      );
      expect(time.advance).not.toHaveBeenCalled();
    });

    it('reports effects the system removed or decayed because their time ran out', async () => {
      const prone = makeEffect('e1', 'Liegend', 60);
      const stunned = makeEffect('e2', 'Betäubung', 3600, 2);
      const blessing = makeEffect('e3', 'Segen', 7200);
      const itemEffect = makeEffect('e4', 'Gift', 30);
      const untimed = makeEffect('e5', 'Ewig', 0);
      const actorEffects = makeEffects([prone, stunned, blessing, untimed]);
      const itemEffects = makeEffects([itemEffect]);
      const actor = {
        name: 'Alrike',
        effects: actorEffects,
        items: [{ effects: itemEffects }],
      };
      stubWorld({ actors: [actor] });
      // What DSA5 does on updateWorldTime: delete run-out effects, decay leveled ones.
      onAdvance = delta => {
        for (const e of [prone, stunned, blessing, itemEffect]) e.duration.remaining -= delta;
        setTimeout(() => {
          actorEffects.map.delete('e1');
          stunned.system.condition.value = 1;
          stunned.duration.remaining = 3600;
          itemEffects.map.delete('e4');
        }, 20);
      };

      const result = await manageWorldTime({ action: 'advance', hours: 1 });

      expect(result.effects.expired).toEqual([
        { actor: 'Alrike', effect: 'Liegend' },
        { actor: 'Alrike', effect: 'Gift' },
      ]);
      expect(result.effects.conditionLevelsReduced).toEqual([
        { actor: 'Alrike', effect: 'Betäubung', from: 2, to: 1 },
      ]);
      expect(result.effects.durationOverButKept).toEqual([]);
    });

    it('in a system that keeps run-out effects, lists them without waiting', async () => {
      const effect = makeEffect('e1', 'Bless', 60);
      const actor = { name: 'Hero', effects: makeEffects([effect]), items: [] };
      stubWorld({ dsa: false, actors: [actor] });
      onAdvance = delta => {
        effect.duration.remaining -= delta;
      };
      const started = Date.now();
      const result = await manageWorldTime({ action: 'advance', minutes: 5 });
      expect(Date.now() - started).toBeLessThan(500);
      expect(result.effects.durationOverButKept).toEqual([{ actor: 'Hero', effect: 'Bless' }]);
      expect(result.daylight).toBeUndefined();
    });
  });
});
