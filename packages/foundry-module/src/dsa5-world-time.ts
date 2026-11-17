/**
 * DSA5 extras for the world-time tool.
 *
 * DSA5 registers its Aventurian calendar ("Der Zwölfgöttliche Kalender": Praios … Rahja
 * plus the five Namenlose Tage, years counted BF) as the core world calendar
 * (`DSAWorldCalendar`, a CalendarData subclass). Its `timeToComponents` adds the moon
 * phase, and the system ships its own date formatters, a time-of-day classification
 * (used for auto daylight) and a holiday almanac. Everything here calls those system
 * functions rather than re-deriving Aventurian rules, and every lookup is guarded so a
 * missing piece only drops that field.
 */

/** Is the active world calendar the DSA5 one (rather than "none" / a core calendar)? */
export function isDsa5Calendar(calendar: any): boolean {
  return (game as any).system?.id === 'dsa5' && calendar?.constructor?.isDSAcompatible === true;
}

function translate(calendar: any, key: string | undefined): string {
  if (!key) return '';
  try {
    return String(calendar.translate(key));
  } catch {
    return key;
  }
}

function calendarSettings(): any {
  try {
    return (game as any).settings.get('dsa5', 'calendarSettings') ?? {};
  } catch {
    return {};
  }
}

/** The calendar widget's class, which owns the time-of-day classification. */
function calendarWidgetClass(): any {
  return (game as any).dsa5?.apps?.CalendarWidget?.constructor;
}

/** The date in the format the system's calendar widget shows (12- or 24-hour setting). */
export async function dsa5FormattedDate(calendar: any, time: number): Promise<string> {
  const formatter = calendarSettings().use24HourFormat ? 'format24Hour' : 'formatPraiosGefaellig';
  try {
    return String(await calendar.format(time, formatter));
  } catch {
    return '';
  }
}

/**
 * Extra month names accepted on input: the system's own god-month list (e.g.
 * "Namenloser" for the Namenlose Tage), so a name works whatever the UI language.
 */
export function dsa5MonthAliases(calendar: any, monthIndex: number): string[] {
  const aliases: string[] = [];
  const godMonth = calendar.constructor?.months?.[monthIndex];
  if (typeof godMonth === 'string') aliases.push(godMonth);
  if (calendar.months?.values?.[monthIndex]?.name === 'NamenloseTage') {
    aliases.push('Namenlose Tage', 'Nameless Days');
  }
  return aliases;
}

function timeOfDay(components: any): { key: string; name: string } | null {
  try {
    const gradient = calendarWidgetClass()?.dayTimeBackground?.(components);
    if (!gradient?.key) return null;
    const i18n = (game as any).i18n;
    return {
      key: gradient.key,
      name: String(i18n.localize(`CALENDAR.DSA.dayTimes.${gradient.key}`)),
    };
  } catch {
    return null;
  }
}

async function holidays(calendar: any, components: any): Promise<Array<Record<string, string>>> {
  try {
    const finder = (game as any).dsa5?.apps?.CalendarPicker?.constructor?.findHolidays;
    if (typeof finder !== 'function') return [];
    const entries = (await finder.call(
      (game as any).dsa5.apps.CalendarPicker.constructor,
      components
    )) as any[];
    const i18n = (game as any).i18n;
    return (entries ?? []).map(entry => {
      // Same lookup as the system's own season tooltip (formatSeason).
      const key = `${calendar.translationPrefix}.holiday.${entry.title}`;
      const name = i18n.has?.(key) ? String(i18n.localize(key)) : String(entry.title);
      return entry.categoryName ? { name, category: String(entry.categoryName) } : { name };
    });
  } catch {
    return [];
  }
}

/** DSA5-only fields for a date: era, 24-hour format, moon, time of day, holidays. */
export async function describeDsa5Extras(
  calendar: any,
  components: any
): Promise<Record<string, unknown>> {
  const extras: Record<string, unknown> = {
    era: translate(
      calendar,
      (globalThis as any).CONFIG?.time?.worldCalendarConfig?.years?.yearSuffix
    ),
    namelessDays: calendar.months?.values?.[components.month]?.name === 'NamenloseTage',
  };
  try {
    extras.formatted24h = String(await calendar.format(components, 'format24Hour'));
  } catch {
    // formatter missing in this system version
  }
  if (components.moon?.phase?.name) {
    extras.moonPhase = translate(calendar, components.moon.phase.name);
  }
  const tod = timeOfDay(components);
  if (tod) extras.timeOfDay = tod.name;
  extras.holidays = await holidays(calendar, components);
  return extras;
}

/** Inputs for the daylight report around a time change. */
export function describeDsa5Daylight(
  calendar: any,
  time: number
): { autoDaylight: boolean; timeOfDay: string | null; sceneDarkness: number | null } {
  const components = calendar.timeToComponents(time);
  const scene = (globalThis as any).canvas?.scene;
  const darkness = scene?.environment?.darknessLevel;
  return {
    autoDaylight: !!calendarSettings().lightByDayTime,
    timeOfDay: timeOfDay(components)?.name ?? null,
    sceneDarkness: typeof darkness === 'number' ? darkness : null,
  };
}
