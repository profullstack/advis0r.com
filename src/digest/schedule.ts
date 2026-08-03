/**
 * Market-calendar and scheduling math for watchlist email digests.
 *
 * Digests are delivered "when pre-market trading opens" — 04:00 America/New_York
 * on a US equity trading day. Everything here is therefore expressed in Eastern
 * wall-clock time and computed without a timezone dependency:
 *
 *   - `Intl.DateTimeFormat` resolves the true ET offset for any instant, so DST
 *     transitions are handled by the platform rather than by a hardcoded -5/-4.
 *   - NYSE holidays are derived from their rules (nth-weekday, Easter computus,
 *     and the Saturday→Friday / Sunday→Monday observance convention) rather than
 *     from a table that silently expires at the end of the year.
 *
 * The Alpaca calendar endpoint is the authoritative source when credentials are
 * present, but the fallback market-data client returns an empty calendar, so a
 * self-contained implementation is what actually decides whether mail goes out.
 */

export const MARKET_TZ = "America/New_York";

/** US equity pre-market session opens at 04:00 ET. */
export const PREMARKET_OPEN_HOUR = 4;
export const PREMARKET_OPEN_MINUTE = 0;

/**
 * How long after pre-market open a run may still deliver that day's digest.
 *
 * A process that was down at 04:00 should still send when it comes back, but a
 * "daily market summary" arriving at dinner time is noise — past this window the
 * run is skipped and the day is recorded as missed rather than delivered late.
 */
export const CATCH_UP_HOURS = 6;

export type DigestFrequency = "daily" | "weekly" | "off";

export const DIGEST_FREQUENCIES: readonly DigestFrequency[] = ["daily", "weekly", "off"];

/** Coerce arbitrary input to a frequency, falling back to the default. */
export function parseFrequency(raw: unknown, fallback: DigestFrequency = "daily"): DigestFrequency {
  const v = String(raw ?? "").trim().toLowerCase();
  return (DIGEST_FREQUENCIES as readonly string[]).includes(v) ? (v as DigestFrequency) : fallback;
}

/* ---------------- Eastern-time primitives ---------------- */

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export interface EtParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Decompose an instant into Eastern wall-clock parts. */
export function etParts(at: Date): EtParts {
  const map: Record<string, string> = {};
  for (const p of ET_PARTS.formatToParts(at)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Intl emits "24" for midnight under hour12:false in some ICU versions.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** Eastern calendar date of an instant, as YYYY-MM-DD. */
export function etDate(at: Date): string {
  const p = etParts(at);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * Convert an Eastern wall-clock time to the instant it denotes.
 *
 * Two passes: the first guess is off by the UTC offset, and applying the offset
 * measured at that guess lands on the right instant. A second pass fixes the
 * rare case where the guess fell on the far side of a DST boundary.
 */
export function etWallTimeToUtc(dateIso: string, hour: number, minute = 0): Date {
  const [y, m, d] = dateIso.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, hour, minute, 0, 0);
  let guess = new Date(naive);
  for (let i = 0; i < 2; i++) {
    guess = new Date(naive - etOffsetMinutes(guess) * 60_000);
  }
  return guess;
}

/** Minutes Eastern time is offset from UTC at a given instant (-300 or -240). */
function etOffsetMinutes(at: Date): number {
  const p = etParts(at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The instant pre-market opens on a given Eastern date. */
export function premarketOpen(dateIso: string): Date {
  return etWallTimeToUtc(dateIso, PREMARKET_OPEN_HOUR, PREMARKET_OPEN_MINUTE);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Day of week for a YYYY-MM-DD date. 0 = Sunday. */
export function dayOfWeek(dateIso: string): number {
  const [y, m, d] = dateIso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Shift a YYYY-MM-DD date by whole days, staying in the calendar domain. */
export function addDays(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/* ---------------- NYSE holiday calendar ---------------- */

/** Date of the nth given weekday in a month (n is 1-based). */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return `${year}-${pad(month)}-${pad(1 + shift + (n - 1) * 7)}`;
}

/** Date of the last given weekday in a month. */
function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return `${year}-${pad(month)}-${pad(last.getUTCDate() - shift)}`;
}

/** Gregorian Easter Sunday (Meeus/Jones/Butcher). Good Friday is two days before. */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * NYSE observance rule for a fixed-date holiday: Saturday moves to the preceding
 * Friday, Sunday to the following Monday.
 *
 * New Year's Day is the documented exception — the exchange does not close on
 * December 31 when January 1 falls on a Saturday — so callers pass
 * `backwards: false` for it.
 */
function observed(dateIso: string, backwards = true): string | null {
  const dow = dayOfWeek(dateIso);
  if (dow === 6) return backwards ? addDays(dateIso, -1) : null;
  if (dow === 0) return addDays(dateIso, 1);
  return dateIso;
}

const holidayCache = new Map<number, Set<string>>();

/** Full-day NYSE closures for a calendar year. */
export function marketHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const days = [
    observed(`${year}-01-01`, false), // New Year's Day
    nthWeekday(year, 1, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 2, 1, 3), // Washington's Birthday
    addDays(easterSunday(year), -2), // Good Friday
    lastWeekday(year, 5, 1), // Memorial Day
    observed(`${year}-06-19`), // Juneteenth
    observed(`${year}-07-04`), // Independence Day
    nthWeekday(year, 9, 1, 1), // Labor Day
    nthWeekday(year, 11, 4, 4), // Thanksgiving
    observed(`${year}-12-25`), // Christmas
  ].filter((d): d is string => Boolean(d));

  const set = new Set(days);
  holidayCache.set(year, set);
  return set;
}

/** Whether US equity markets hold a regular session on an Eastern date. */
export function isTradingDay(dateIso: string): boolean {
  const dow = dayOfWeek(dateIso);
  if (dow === 0 || dow === 6) return false;
  return !marketHolidays(Number(dateIso.slice(0, 4))).has(dateIso);
}

/** The most recent trading day strictly before `dateIso`. */
export function previousTradingDay(dateIso: string): string {
  let d = addDays(dateIso, -1);
  // Bounded so a bad input can never spin: no run of closures approaches 15 days.
  for (let i = 0; i < 15 && !isTradingDay(d); i++) d = addDays(d, -1);
  return d;
}

/** Every trading day in [startIso, endIso], inclusive. */
export function tradingDaysBetween(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  for (let d = startIso; d <= endIso; d = addDays(d, 1)) {
    if (isTradingDay(d)) out.push(d);
  }
  return out;
}

/**
 * Whether `dateIso` is the week's first session — the day a weekly digest goes
 * out. True when the preceding session belongs to an earlier calendar week,
 * which stays correct when Monday is a holiday and the week opens on Tuesday.
 */
export function isFirstTradingDayOfWeek(dateIso: string): boolean {
  if (!isTradingDay(dateIso)) return false;
  return weekKey(previousTradingDay(dateIso)) !== weekKey(dateIso);
}

/** Monday of the ISO week containing a date. */
export function weekStart(dateIso: string): string {
  const dow = dayOfWeek(dateIso);
  return addDays(dateIso, dow === 0 ? -6 : 1 - dow);
}

/** ISO-8601 week identifier, e.g. "2026-W31". Used to key weekly sends. */
export function weekKey(dateIso: string): string {
  const [y, m, d] = dateIso.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  // Shift to the Thursday of this week: the ISO year is whichever year owns it.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const isoYear = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((t.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${pad(week)}`;
}

/* ---------------- what a run should do ---------------- */

/** The reporting window a digest covers. */
export interface DigestWindow {
  frequency: Exclude<DigestFrequency, "off">;
  /** Eastern date the digest is delivered on. */
  sendDate: string;
  /** Trading sessions summarized, oldest first. */
  sessions: string[];
  /** Idempotency key: one digest per user per period. */
  periodKey: string;
}

export interface DueOptions {
  /** Ignore the trading-day and time-of-day gates (manual/test sends). */
  force?: boolean;
  catchUpHours?: number;
}

export interface DueDecision {
  /** Windows that should be delivered now, one per frequency that is due. */
  windows: DigestWindow[];
  /** Human-readable reason when nothing is due. */
  skipped?: string;
}

/**
 * Decide what (if anything) a run started at `now` should deliver.
 *
 * Gates, in order: today must be a trading session, the pre-market bell must
 * have rung, and the run must be inside the catch-up window. `force` bypasses
 * all three but still computes a real reporting window, so a manual send is a
 * genuine digest rather than a special case.
 */
export function digestsDue(now: Date, opts: DueOptions = {}): DueDecision {
  const sendDate = etDate(now);
  const catchUpHours = opts.catchUpHours ?? CATCH_UP_HOURS;

  if (!opts.force) {
    if (!isTradingDay(sendDate)) {
      return { windows: [], skipped: `${sendDate} is not a US equity trading day` };
    }
    const open = premarketOpen(sendDate);
    if (now < open) {
      return { windows: [], skipped: `pre-market on ${sendDate} opens at 04:00 ET` };
    }
    if (now.getTime() - open.getTime() > catchUpHours * 3_600_000) {
      return {
        windows: [],
        skipped: `more than ${catchUpHours}h past the ${sendDate} pre-market open`,
      };
    }
  }

  const lastSession = previousTradingDay(sendDate);
  const windows: DigestWindow[] = [
    {
      frequency: "daily",
      sendDate,
      sessions: [lastSession],
      periodKey: `daily:${sendDate}`,
    },
  ];

  // Weekly subscribers hear from us once, at the top of the week, covering every
  // session of the week that just closed.
  if (opts.force || isFirstTradingDayOfWeek(sendDate)) {
    const sessions = tradingDaysBetween(weekStart(lastSession), lastSession);
    windows.push({
      frequency: "weekly",
      sendDate,
      sessions: sessions.length ? sessions : [lastSession],
      periodKey: `weekly:${weekKey(lastSession)}`,
    });
  }

  return { windows };
}

/** When the next digest for a frequency is expected, as an instant. */
export function nextSendAt(frequency: DigestFrequency, now: Date): Date | null {
  if (frequency === "off") return null;
  let d = etDate(now);
  // Today still counts if the bell has not rung yet.
  if (now >= premarketOpen(d)) d = addDays(d, 1);
  for (let i = 0; i < 30; i++, d = addDays(d, 1)) {
    if (!isTradingDay(d)) continue;
    if (frequency === "daily" || isFirstTradingDayOfWeek(d)) return premarketOpen(d);
  }
  return null;
}

/** "Friday, August 1, 2026" in Eastern terms — for subject lines and headings. */
export function formatSessionDate(dateIso: string, opts: { weekday?: boolean } = {}): string {
  const [y, m, d] = dateIso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: opts.weekday === false ? undefined : "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
