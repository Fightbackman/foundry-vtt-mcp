import { ERROR_MESSAGES } from './constants.js';
import { permissionManager } from './permissions.js';
import {
  describeDsa5Daylight,
  describeDsa5Extras,
  dsa5FormattedDate,
  dsa5MonthAliases,
  isDsa5Calendar,
} from './dsa5-world-time.js';

/**
 * World time (`game.time`) for the world-time tool: read the current in-game date,
 * advance it, or set it to an explicit date.
 *
 * Everything goes through the core calendar API (`game.time.calendar`, a CalendarData
 * configured by the system from `CONFIG.time.worldCalendarConfig`) that Foundry v13
 * introduced and v14 kept, so this works in any system and on both versions. Time is
 * only ever changed through `game.time.advance`, so the core `updateWorldTime` hook,
 * effect duration tracking and system listeners (DSA5 condition decay, auto daylight,
 * calendar widgets) all run as if the GM had used the system's own controls. DSA5 adds
 * moon phase, time of day, holidays and its own date format (see dsa5-world-time.ts).
 */

export interface WorldTimeRequest {
  action: 'get' | 'advance' | 'set';
  // advance
  seconds?: number;
  minutes?: number;
  hours?: number;
  days?: number;
  weeks?: number;
  // set
  year?: number;
  month?: number | string;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  worldTime?: number;
}

export interface WorldTimeDate {
  worldTime: number;
  year: number;
  month: number;
  monthName: string;
  day: number;
  dayOfYear: number;
  weekday: number;
  weekdayName: string;
  hour: number;
  minute: number;
  second: number;
  season?: string;
  formatted: string;
  dsa5?: Record<string, unknown>;
}

interface TimedEffectSnapshot {
  actor: string;
  effect: string;
  parent: any;
  id: string;
  level: number | null;
  wasRunOut: boolean;
}

/** How long to wait for the system to delete or decay effects whose duration ran out. */
const EFFECT_SETTLE_TIMEOUT_MS = 2000;
const EFFECT_SETTLE_POLL_MS = 100;

/** The active world calendar, or a clear error on a Foundry without the calendar API. */
export function getWorldCalendar(): any {
  const calendar = (game as any).time?.calendar;
  if (!calendar || typeof calendar.timeToComponents !== 'function') {
    throw new Error(
      'This Foundry version has no world calendar API (game.time.calendar); Foundry v13 or later is required.'
    );
  }
  return calendar;
}

/**
 * Localize a calendar label. DSA5's calendar labels are bare keys resolved by its own
 * `translate` (which applies the calendar's translation prefix); core calendars use
 * plain i18n keys.
 */
export function localizeCalendarLabel(calendar: any, key: string | undefined): string {
  if (!key) return '';
  if (typeof calendar.translate === 'function') {
    try {
      return String(calendar.translate(key));
    } catch {
      // fall through to plain i18n
    }
  }
  return (game as any).i18n?.localize ? String((game as any).i18n.localize(key)) : key;
}

function units(calendar: any) {
  const d = calendar.days ?? {};
  const secondsPerMinute = Number(d.secondsPerMinute) || 60;
  const minutesPerHour = Number(d.minutesPerHour) || 60;
  const hoursPerDay = Number(d.hoursPerDay) || 24;
  const daysPerWeek = Array.isArray(d.values) && d.values.length ? d.values.length : 7;
  const secondsPerHour = secondsPerMinute * minutesPerHour;
  const secondsPerDay = secondsPerHour * hoursPerDay;
  return {
    secondsPerMinute,
    minutesPerHour,
    hoursPerDay,
    daysPerWeek,
    secondsPerHour,
    secondsPerDay,
  };
}

function monthLength(calendar: any, monthIndex: number, year: number): number {
  const month = calendar.months.values[monthIndex];
  const leap = typeof calendar.isLeapYear === 'function' ? calendar.isLeapYear(year) : false;
  return Number(leap ? (month.leapDays ?? month.days) : month.days) || 0;
}

async function formatDate(calendar: any, time: number): Promise<string> {
  if (isDsa5Calendar(calendar)) {
    const formatted = await dsa5FormattedDate(calendar, time);
    if (formatted) return formatted;
  }
  try {
    return String(await calendar.format(time, 'timestamp'));
  } catch {
    return '';
  }
}

/** The date at `time` as 1-based, named components plus the system's own formatted string. */
export async function describeWorldTime(time: number): Promise<WorldTimeDate> {
  const calendar = getWorldCalendar();
  const c = calendar.timeToComponents(time);
  const weekdays = calendar.days?.values ?? [];
  // Core computes the weekday with a plain modulo, which goes negative before time 0.
  const weekdayIndex = weekdays.length
    ? ((c.dayOfWeek % weekdays.length) + weekdays.length) % weekdays.length
    : 0;
  const season =
    typeof c.season === 'number' ? calendar.seasons?.values?.[c.season]?.name : undefined;

  const date: WorldTimeDate = {
    worldTime: time,
    year: c.year,
    month: c.month + 1,
    monthName: localizeCalendarLabel(calendar, calendar.months.values[c.month]?.name),
    day: c.dayOfMonth + 1,
    dayOfYear: c.day + 1,
    weekday: weekdayIndex + 1,
    weekdayName: localizeCalendarLabel(calendar, weekdays[weekdayIndex]?.name),
    hour: c.hour,
    minute: c.minute,
    second: c.second,
    formatted: await formatDate(calendar, time),
  };
  if (season) date.season = localizeCalendarLabel(calendar, season);
  if (isDsa5Calendar(calendar)) date.dsa5 = await describeDsa5Extras(calendar, c);
  return date;
}

function monthList(calendar: any) {
  const year = calendar.timeToComponents((game as any).time.worldTime).year;
  return calendar.months.values.map((m: any, i: number) => ({
    number: i + 1,
    name: localizeCalendarLabel(calendar, m.name),
    days: monthLength(calendar, i, year),
  }));
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Resolve a month given as a 1-based number or a (localized, config or abbreviated) name. */
export function resolveMonth(calendar: any, month: number | string): number {
  const months: any[] = calendar.months.values;
  const valid = () =>
    months.map((m, i) => `${i + 1} ${localizeCalendarLabel(calendar, m.name)}`).join(', ');

  if (typeof month === 'number' || /^\s*\d+\s*$/.test(month)) {
    const n = Number(month);
    if (!Number.isInteger(n) || n < 1 || n > months.length) {
      throw new Error(`Month ${month} is out of range. Valid months: ${valid()}`);
    }
    return n - 1;
  }

  const wanted = normalizeName(month);
  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    // Only localized names: the configured names are i18n keys, and in DSA5 they are the
    // Gregorian month keys ("July" is Praios), which would silently pick the wrong month.
    const aliases = [
      localizeCalendarLabel(calendar, m.name),
      m.abbreviation ? localizeCalendarLabel(calendar, m.abbreviation) : undefined,
      ...(isDsa5Calendar(calendar) ? dsa5MonthAliases(calendar, i) : []),
    ];
    if (aliases.some(a => typeof a === 'string' && a && normalizeName(a) === wanted)) return i;
  }
  throw new Error(`Unknown month "${month}". Valid months: ${valid()}`);
}

function checkInteger(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max} (got ${value})`);
  }
}

/** World time in seconds for a date given as (partial) 1-based components. */
export function targetTimeFromComponents(calendar: any, request: WorldTimeRequest): number {
  const { secondsPerMinute, minutesPerHour, hoursPerDay } = units(calendar);
  const current = calendar.timeToComponents((game as any).time.worldTime);

  const year = request.year ?? current.year;
  if (!Number.isInteger(year)) throw new Error(`year must be a whole number (got ${year})`);
  const monthIndex =
    request.month !== undefined ? resolveMonth(calendar, request.month) : current.month;
  const length = monthLength(calendar, monthIndex, year);
  const day = request.day ?? current.dayOfMonth + 1;
  if (!Number.isInteger(day) || day < 1 || day > length) {
    const monthName = localizeCalendarLabel(calendar, calendar.months.values[monthIndex].name);
    throw new Error(
      `Day ${day} does not exist in ${monthName} of year ${year}: valid days are 1 to ${length}`
    );
  }
  const hour = request.hour ?? current.hour;
  const minute = request.minute ?? current.minute;
  const second = request.second ?? current.second;
  checkInteger('hour', hour, 0, hoursPerDay - 1);
  checkInteger('minute', minute, 0, minutesPerHour - 1);
  checkInteger('second', second, 0, secondsPerMinute - 1);

  // componentsToTime counts days from the start of the year, not month + day of month.
  let dayOfYear = day - 1;
  for (let m = 0; m < monthIndex; m++) dayOfYear += monthLength(calendar, m, year);
  const time = calendar.componentsToTime({ year, day: dayOfYear, hour, minute, second });

  // Guard against calendars whose conversion is not symmetric (custom subclasses).
  const check = calendar.timeToComponents(time);
  if (
    check.year !== year ||
    check.month !== monthIndex ||
    check.dayOfMonth !== day - 1 ||
    check.hour !== hour ||
    check.minute !== minute
  ) {
    throw new Error('The calendar could not represent this date; it was not changed.');
  }
  return time;
}

/** Seconds for an advance request, using the calendar's own day and week length. */
export function deltaFromRequest(calendar: any, request: WorldTimeRequest): number {
  const u = units(calendar);
  const parts: Array<[keyof WorldTimeRequest, number]> = [
    ['seconds', 1],
    ['minutes', u.secondsPerMinute],
    ['hours', u.secondsPerHour],
    ['days', u.secondsPerDay],
    ['weeks', u.secondsPerDay * u.daysPerWeek],
  ];
  let total = 0;
  for (const [key, factor] of parts) {
    const value = request[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${key} must be a number`);
    }
    total += value * factor;
  }
  return Math.round(total);
}

function collectTimedActors(): any[] {
  const actors: any[] = [...((game as any).actors ?? [])];
  // Unlinked tokens have their own synthetic actors (and effects) that game.actors misses.
  const scene = (globalThis as any).canvas?.scene ?? (game as any).scenes?.viewed;
  for (const token of scene?.tokens ?? []) {
    if (!token.actorLink && token.actor) actors.push(token.actor);
  }
  return actors;
}

function conditionLevel(effect: any): number | null {
  const value = effect.system?.condition?.value;
  return typeof value === 'number' ? value : null;
}

/**
 * Effects with a time-based duration on world actors, their items, and unlinked tokens
 * of the viewed scene — the ones a world-time change can expire.
 */
function snapshotTimedEffects(): TimedEffectSnapshot[] {
  const result: TimedEffectSnapshot[] = [];
  const add = (actor: any, parent: any) => {
    for (const effect of parent?.effects ?? []) {
      if (!(Number(effect.duration?.seconds) > 0)) continue;
      result.push({
        actor: actor.name,
        effect: effect.name,
        parent,
        id: effect.id,
        level: conditionLevel(effect),
        wasRunOut: isRunOut(effect),
      });
    }
  };
  for (const actor of collectTimedActors()) {
    add(actor, actor);
    for (const item of actor.items ?? []) add(actor, item);
  }
  return result;
}

function liveEffect(entry: TimedEffectSnapshot): any {
  return entry.parent?.effects?.get?.(entry.id);
}

function isRunOut(effect: any): boolean {
  if (effect.duration?.expired) return true;
  const remaining = Number(effect.duration?.remaining);
  return Number.isFinite(remaining) && remaining <= 0;
}

/**
 * Expired effects are deleted (or decayed) asynchronously after the time change, by
 * core when CONFIG.ActiveEffect.expiryAction is set or by the system (DSA5). Wait
 * briefly for that so the report reflects the outcome; other systems leave run-out
 * effects in place, so there is nothing to wait for.
 */
async function waitForEffectExpiry(snapshot: TimedEffectSnapshot[]): Promise<void> {
  const handledBySomeone =
    (game as any).system?.id === 'dsa5' || !!(globalThis as any).CONFIG?.ActiveEffect?.expiryAction;
  if (!handledBySomeone) return;
  const pending = () =>
    snapshot.some(entry => {
      const effect = liveEffect(entry);
      return effect && !entry.wasRunOut && isRunOut(effect) && !effect.duration?.expired;
    });
  const deadline = Date.now() + EFFECT_SETTLE_TIMEOUT_MS;
  while (pending() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, EFFECT_SETTLE_POLL_MS));
  }
}

function diffEffects(snapshot: TimedEffectSnapshot[]) {
  const expired: Array<{ actor: string; effect: string }> = [];
  const reduced: Array<{ actor: string; effect: string; from: number; to: number }> = [];
  const runOutButKept: Array<{ actor: string; effect: string }> = [];
  for (const entry of snapshot) {
    const effect = liveEffect(entry);
    if (!effect) {
      expired.push({ actor: entry.actor, effect: entry.effect });
      continue;
    }
    const level = conditionLevel(effect);
    if (entry.level !== null && level !== null && level < entry.level) {
      reduced.push({ actor: entry.actor, effect: entry.effect, from: entry.level, to: level });
    } else if (!entry.wasRunOut && isRunOut(effect)) {
      runOutButKept.push({ actor: entry.actor, effect: entry.effect });
    }
  }
  return { expired, reduced, runOutButKept };
}

async function changeWorldTime(delta: number, action: 'advance' | 'set') {
  const permissionCheck = permissionManager.checkWritePermission('modifyWorldTime');
  if (!permissionCheck.allowed) {
    throw new Error(`${ERROR_MESSAGES.ACCESS_DENIED}: ${permissionCheck.reason}`);
  }
  permissionManager.auditPermissionCheck('modifyWorldTime', permissionCheck, { action, delta });

  const calendar = getWorldCalendar();
  const time = (game as any).time;
  const before = await describeWorldTime(time.worldTime);
  if (delta === 0) {
    return { success: true, action, changed: false, deltaSeconds: 0, before, after: before };
  }

  const dsa5 = isDsa5Calendar(calendar);
  const daylightBefore = dsa5 ? describeDsa5Daylight(calendar, time.worldTime) : null;
  const snapshot = snapshotTimedEffects();

  await time.advance(delta);
  await waitForEffectExpiry(snapshot);

  const after = await describeWorldTime(time.worldTime);
  const { expired, reduced, runOutButKept } = diffEffects(snapshot);

  const result: Record<string, any> = {
    success: true,
    action,
    changed: true,
    deltaSeconds: after.worldTime - before.worldTime,
    before,
    after,
    effects: {
      scope: 'world actors and their items, plus unlinked tokens on the viewed scene',
      expired,
      conditionLevelsReduced: reduced,
      durationOverButKept: runOutButKept,
    },
  };
  if (delta < 0) {
    result.note =
      'Time was rewound. Effects that already expired are not restored, and remaining durations grow again.';
  }
  if (daylightBefore) {
    const daylightAfter = describeDsa5Daylight(calendar, time.worldTime);
    result.daylight = {
      autoDaylight: daylightAfter.autoDaylight,
      timeOfDayBefore: daylightBefore.timeOfDay,
      timeOfDayAfter: daylightAfter.timeOfDay,
      sceneDarknessBefore: daylightBefore.sceneDarkness,
      ...(daylightAfter.autoDaylight
        ? {
            note: "The system adjusts the viewed scene's darkness to the new time of day itself, after the calendar widget's time animation (up to about 10 seconds).",
          }
        : {}),
    };
  }
  return result;
}

/** Entry point for the bridge query. */
export async function manageWorldTime(request: WorldTimeRequest): Promise<any> {
  const calendar = getWorldCalendar();
  const time = (game as any).time;

  switch (request.action) {
    case 'get': {
      return {
        success: true,
        current: await describeWorldTime(time.worldTime),
        calendar: {
          // Calendar names are plain text or core i18n keys, never calendar-prefixed keys.
          name: String((game as any).i18n?.localize?.(calendar.name) ?? calendar.name),
          months: monthList(calendar),
          weekdays: (calendar.days?.values ?? []).map((d: any) =>
            localizeCalendarLabel(calendar, d.name)
          ),
          hoursPerDay: units(calendar).hoursPerDay,
        },
      };
    }
    case 'advance': {
      const delta = deltaFromRequest(calendar, request);
      if (delta === 0) {
        throw new Error('Nothing to advance: give seconds, minutes, hours, days and/or weeks');
      }
      return changeWorldTime(delta, 'advance');
    }
    case 'set': {
      const hasComponents = ['year', 'month', 'day', 'hour', 'minute', 'second'].some(
        k => (request as any)[k] !== undefined
      );
      let target: number;
      if (request.worldTime !== undefined) {
        if (hasComponents) {
          throw new Error('Give either worldTime or date components, not both');
        }
        if (!Number.isInteger(request.worldTime)) {
          throw new Error('worldTime must be a whole number of seconds');
        }
        target = request.worldTime;
      } else {
        if (!hasComponents) {
          throw new Error('Give at least one of year, month, day, hour, minute, second');
        }
        target = targetTimeFromComponents(calendar, request);
      }
      return changeWorldTime(target - time.worldTime, 'set');
    }
    default:
      throw new Error(`Unknown action "${(request as any).action}": use get, advance or set`);
  }
}
