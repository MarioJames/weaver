import { createContext, createElement, useContext, type ReactNode } from 'react';

/**
 * The one place the renderer turns a timestamp into text.
 * The project time zone (an IANA name from the saved policy, `display.timezone`) wins; without one the browser's own zone applies.
 * Components read the zone through `TimeZoneProvider`; the pure view helpers default to the zone the provider last applied.
 */

const CLOCK_ZONE_FALLBACK = 'UTC';
let configuredZone: string | undefined;

/** The browser's own IANA zone; UTC when the runtime cannot name one. */
export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || CLOCK_ZONE_FALLBACK; } catch { return CLOCK_ZONE_FALLBACK; }
}

export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

/** Every IANA zone the runtime knows, with the browser's and the configured zone included even when the runtime omits them (for example `UTC`). */
export function listTimeZones(extra: readonly (string | undefined)[] = []): string[] {
  let zones: string[] = [];
  try { zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { /* the fallback below applies */ }
  const all = new Set<string>(zones);
  for (const zone of [browserTimeZone(), ...extra]) if (zone && isValidTimeZone(zone)) all.add(zone);
  if (!all.size) all.add(CLOCK_ZONE_FALLBACK);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** Apply the saved setting. An empty or unknown name means "follow the browser". */
export function setProjectTimeZone(zone: string | undefined | null): void {
  configuredZone = isValidTimeZone(zone) ? zone.trim() : undefined;
}

/** The zone every timestamp is shown in right now. */
export function projectTimeZone(): string { return configuredZone ?? browserTimeZone(); }

const TimeZoneContext = createContext<string | undefined>(undefined);

/** Applies the zone for the render below it. The module value is set during render so the first paint is already right. */
export function TimeZoneProvider({ zone, children }: { zone: string | undefined; children?: ReactNode }) {
  setProjectTimeZone(zone);
  return createElement(TimeZoneContext.Provider, { value: projectTimeZone() }, children);
}

/** The zone in force, as a React dependency. Falls back to the module value outside a provider. */
export function useProjectTimeZone(): string { return useContext(TimeZoneContext) ?? projectTimeZone(); }

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let known = formatters.get(zone);
  if (!known) {
    known = new Intl.DateTimeFormat('en-US', { timeZone: zone, calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(zone, known);
  }
  return known;
}

/** The wall-clock fields of an instant in a zone. */
export function zonedParts(ms: number, zone: string = projectTimeZone()): ZonedParts {
  const found: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(ms))) if (part.type !== 'literal') found[part.type] = Number(part.value);
  return { year: found.year!, month: found.month!, day: found.day!, hour: (found.hour ?? 0) % 24, minute: found.minute!, second: found.second! };
}

/** Offset of a zone from UTC at an instant, in minutes east of UTC. */
export function zoneOffsetMinutes(ms: number, zone: string = projectTimeZone()): number {
  const p = zonedParts(ms, zone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000) / 60000);
}

/** `UTC+08:00`, `UTC-04:00`, `UTC`. */
export function offsetLabel(ms: number = Date.now(), zone: string = projectTimeZone()): string {
  const minutes = zoneOffsetMinutes(ms, zone);
  if (minutes === 0) return 'UTC+00:00';
  const abs = Math.abs(minutes);
  return `UTC${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** The instant at which the wall clock of `zone` reads the given fields (the earlier one when a clock repeats; the next valid minute inside a gap). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string = projectTimeZone()): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall - zoneOffsetMinutes(wall, zone) * 60000;
  const again = wall - zoneOffsetMinutes(guess, zone) * 60000;
  if (again !== guess) {
    // The offset changed between the two guesses (a transition): prefer the instant whose wall clock matches.
    const back = zonedParts(again, zone);
    guess = Date.UTC(back.year, back.month - 1, back.day, back.hour, back.minute) === wall ? again : Math.max(guess, again);
  }
  return guess;
}

/** 00:00 of the zone's calendar day containing `ms`. */
export function startOfZonedDay(ms: number, zone: string = projectTimeZone()): number {
  const p = zonedParts(ms, zone);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, zone);
}

const pad = (value: number) => String(value).padStart(2, '0');

const toMs = (value: string | number | Date): number => value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);

export const UNKNOWN_TIME = '时间未知';

/** Same calendar day in the zone. */
export function sameZonedDay(a: number, b: number, zone: string = projectTimeZone()): boolean {
  const x = zonedParts(a, zone), y = zonedParts(b, zone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** `HH:mm` on today's date in the zone, otherwise `MM-DD HH:mm`. */
export function compactTime(value: string | number | Date | null | undefined, now: number = Date.now(), zone: string = projectTimeZone()): string {
  const ms = value === null || value === undefined ? NaN : toMs(value);
  if (!Number.isFinite(ms)) return UNKNOWN_TIME;
  const p = zonedParts(ms, zone);
  const clock = `${pad(p.hour)}:${pad(p.minute)}`;
  return sameZonedDay(ms, now, zone) ? clock : `${pad(p.month)}-${pad(p.day)} ${clock}`;
}

/** `YYYY-MM-DD HH:mm:ss UTC+08:00 (Asia/Shanghai)`: the hover text, naming the zone the clock belongs to. */
export function fullTime(value: string | number | Date | null | undefined, zone: string = projectTimeZone()): string {
  const ms = value === null || value === undefined ? NaN : toMs(value);
  if (!Number.isFinite(ms)) return UNKNOWN_TIME;
  const p = zonedParts(ms, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} ${offsetLabel(ms, zone)} (${zone})`;
}

/** The option text of a zone picker: name and current offset. */
export function zoneOptionLabel(zone: string, at: number = Date.now()): string {
  return `${zone} ${offsetLabel(at, zone)}`;
}
