/**
 * Watchlist digest email: subject, HTML and plain text.
 *
 * Written for mail clients, not browsers — table layout, inline styles, no
 * external assets, and a plain-text alternative that stands on its own. Gmail
 * and Outlook both strip <style> blocks, so every rule is on the element.
 *
 * Compliance details that are not optional: the disclaimer travels with every
 * message (PRD §27), and both a visible unsubscribe link and RFC 8058
 * one-click headers are present. Bulk mail without a working unsubscribe is how
 * a sending domain gets blocked.
 */
import { DISCLAIMER } from "../compliance.ts";
import { escapeHtml } from "../util/html.ts";
import type { MailMessage } from "../auth/email.ts";
import { formatSessionDate, type DigestWindow } from "./schedule.ts";
import type { Headline, MarketSummary, Performance, UserSummary } from "./summary.ts";

export interface RenderContext {
  appUrl: string;
  unsubscribeToken: string;
  displayName?: string;
}

const BG = "#0a0e14";
const PANEL = "#111823";
const BORDER = "#1c2430";
const TEXT = "#d7dee8";
const MUTED = "#8b95a5";
const DIM = "#6b7684";
const UP = "#3fb950";
const DOWN = "#f85149";

// Re-exported so existing importers (and the digest tests) keep their import path.
export { escapeHtml };

/** Period wording reused across the subject, heading and preheader. */
export function windowLabel(window: DigestWindow): string {
  const first = window.sessions[0]!;
  const last = window.sessions.at(-1)!;
  if (window.frequency === "daily" || first === last) {
    return formatSessionDate(last);
  }
  return `${formatSessionDate(first, { weekday: false })} – ${formatSessionDate(last, { weekday: false })}`;
}

export function digestSubject(window: DigestWindow, user: UserSummary): string {
  const period = window.frequency === "daily" ? "Daily" : "Weekly";
  const lead = user.rows.find((r) => r.changePercent != null);
  const headline = lead
    ? ` — ${lead.ticker} ${signed(lead.changePercent!)}%`
    : "";
  return `${period} watchlist: ${windowLabel(window)}${headline}`;
}

/* ---------------- formatting ---------------- */

const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

export function money(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  // Sub-dollar names are the house specialty; two decimals would hide the move.
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function percent(n: number | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : `${signed(n)}%`;
}

export function volume(n: number | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}

const colorFor = (n: number | undefined) => (n == null ? MUTED : n > 0 ? UP : n < 0 ? DOWN : MUTED);

/* ---------------- links ---------------- */

const base = (appUrl: string) => appUrl.replace(/\/$/, "");

export function unsubscribeUrl(appUrl: string, token: string): string {
  return `${base(appUrl)}/unsubscribe?token=${encodeURIComponent(token)}`;
}

/** The Watchlist tab, where the frequency control lives. */
export function preferencesUrl(appUrl: string): string {
  return `${base(appUrl)}/#watchlist`;
}

function tickerUrl(appUrl: string, ticker: string): string {
  return `${base(appUrl)}/?ticker=${encodeURIComponent(ticker)}`;
}

/* ---------------- HTML ---------------- */

function perfRow(appUrl: string, p: Performance, weekly: boolean): string {
  const color = colorFor(p.changePercent);
  return `<tr>
    <td style="padding:10px 8px 10px 0;border-bottom:1px solid ${BORDER};vertical-align:top">
      <a href="${escapeHtml(tickerUrl(appUrl, p.ticker))}" style="color:${TEXT};text-decoration:none;font-weight:600">${escapeHtml(p.ticker)}</a>
      ${p.companyName ? `<div style="color:${DIM};font-size:12px;margin-top:2px">${escapeHtml(truncate(p.companyName, 34))}</div>` : ""}
    </td>
    <td style="padding:10px 8px;border-bottom:1px solid ${BORDER};text-align:right;white-space:nowrap;color:${TEXT}">${money(p.close)}</td>
    <td style="padding:10px 8px;border-bottom:1px solid ${BORDER};text-align:right;white-space:nowrap;color:${color};font-weight:600">${percent(p.changePercent)}</td>
    <td style="padding:10px 0 10px 8px;border-bottom:1px solid ${BORDER};text-align:right;white-space:nowrap;color:${MUTED};font-size:13px">
      ${weekly ? `${money(p.low)}–${money(p.high)}` : volume(p.volume)}
    </td>
  </tr>`;
}

function perfTable(appUrl: string, rows: Performance[], weekly: boolean): string {
  if (!rows.length) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;width:100%;margin:0 0 4px">
    <tr>
      <th align="left" style="padding:0 8px 8px 0;color:${DIM};font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600">Ticker</th>
      <th align="right" style="padding:0 8px 8px;color:${DIM};font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600">Close</th>
      <th align="right" style="padding:0 8px 8px;color:${DIM};font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600">${weekly ? "Week" : "Change"}</th>
      <th align="right" style="padding:0 0 8px 8px;color:${DIM};font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600">${weekly ? "Range" : "Volume"}</th>
    </tr>
    ${rows.map((r) => perfRow(appUrl, r, weekly)).join("")}
  </table>`;
}

function indexStrip(indices: Performance[]): string {
  if (!indices.length) return "";
  const cells = indices
    .map(
      (i) => `<td style="padding:8px 10px;text-align:center;vertical-align:top">
        <div style="color:${DIM};font-size:11px;letter-spacing:.04em">${escapeHtml(i.label ?? i.ticker)}</div>
        <div style="color:${colorFor(i.changePercent)};font-size:15px;font-weight:600;margin-top:3px">${percent(i.changePercent)}</div>
      </td>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background:${PANEL};border:1px solid ${BORDER};border-radius:8px;margin:0 0 22px">
    <tr>${cells}</tr>
  </table>`;
}

function headlineList(headlines: Headline[]): string {
  if (!headlines.length) return "";
  const items = headlines
    .map(
      (h) => `<li style="margin:0 0 10px;line-height:1.5">
        <a href="${escapeHtml(h.url)}" style="color:#2f81f7;text-decoration:none">${escapeHtml(truncate(h.title, 110))}</a>
        <div style="color:${DIM};font-size:12px;margin-top:2px">${escapeHtml(h.ticker)}${h.publisher ? ` · ${escapeHtml(h.publisher)}` : ""}</div>
      </li>`,
    )
    .join("");
  return `<h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:${DIM};margin:26px 0 12px;font-weight:600">In the news</h2>
    <ul style="margin:0;padding:0 0 0 18px;color:${TEXT};font-size:14px">${items}</ul>`;
}

function movers(user: UserSummary): string {
  const top = user.gainers[0];
  const bottom = user.losers[0];
  if (!top && !bottom) return "";
  const parts: string[] = [];
  if (top) parts.push(`<strong style="color:${UP}">${escapeHtml(top.ticker)} ${percent(top.changePercent)}</strong> led`);
  if (bottom) parts.push(`<strong style="color:${DOWN}">${escapeHtml(bottom.ticker)} ${percent(bottom.changePercent)}</strong> lagged`);
  return `<p style="color:${MUTED};font-size:14px;line-height:1.6;margin:0 0 20px">${parts.join(", ")}.</p>`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/* ---------------- message ---------------- */

/**
 * Render one recipient's digest.
 *
 * Returns null when there is nothing to report — every watched ticker is
 * missing data — so a broken provider produces silence rather than a page of
 * dashes.
 */
export function renderDigest(
  summary: MarketSummary,
  user: UserSummary,
  ctx: RenderContext,
): (Omit<MailMessage, "to"> & { subject: string }) | null {
  if (!user.rows.length) return null;

  const { window } = summary;
  const weekly = window.frequency === "weekly";
  const period = windowLabel(window);
  const unsub = unsubscribeUrl(ctx.appUrl, ctx.unsubscribeToken);
  const prefs = preferencesUrl(ctx.appUrl);
  const greeting = ctx.displayName ? `${ctx.displayName}, here` : "Here";

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT}">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(
    `${user.rows.length} ticker${user.rows.length === 1 ? "" : "s"} · ${period}`,
  )}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${BG}">
    <tr><td align="center" style="padding:28px 16px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;text-align:left">
        <tr><td>
          <div style="font-size:20px;font-weight:600;letter-spacing:-.01em;margin-bottom:6px">advis0r<span style="opacity:.5">.com</span></div>
          <h1 style="font-size:17px;margin:0 0 4px;font-weight:600">${weekly ? "Your week in review" : "Your watchlist yesterday"}</h1>
          <p style="color:${MUTED};font-size:13px;margin:0 0 22px;line-height:1.5">
            ${escapeHtml(period)} · sent as pre-market opens
          </p>

          ${indexStrip(summary.indices)}

          <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:${DIM};margin:0 0 12px;font-weight:600">
            ${greeting === "Here" ? "Your tickers" : `${escapeHtml(ctx.displayName!)}'s tickers`}
          </h2>
          ${movers(user)}
          ${perfTable(ctx.appUrl, user.rows, weekly)}

          ${
            user.unavailable.length
              ? `<p style="color:${DIM};font-size:12px;margin:12px 0 0;line-height:1.5">No market data this period for ${escapeHtml(user.unavailable.join(", "))}.</p>`
              : ""
          }

          ${headlineList(user.headlines)}

          <div style="margin:28px 0 0">
            <a href="${escapeHtml(base(ctx.appUrl))}/" style="display:inline-block;background:#2f81f7;color:#fff;text-decoration:none;padding:11px 18px;border-radius:7px;font-weight:500;font-size:14px">Open your watchlist</a>
          </div>

          <hr style="border:0;border-top:1px solid ${BORDER};margin:28px 0 16px">
          <p style="font-size:12px;color:${DIM};margin:0 0 10px;line-height:1.6">
            Prices from ${escapeHtml(summary.source)}${summary.marketError ? " (partial — some data was unavailable)" : ""}.
            ${escapeHtml(DISCLAIMER.replace(/\s+/g, " "))}
          </p>
          <p style="font-size:12px;color:${DIM};margin:0;line-height:1.6">
            You get this because you asked for ${weekly ? "weekly" : "daily"} watchlist updates.
            <a href="${escapeHtml(prefs)}" style="color:${MUTED}">Change frequency</a> ·
            <a href="${escapeHtml(unsub)}" style="color:${MUTED}">Unsubscribe</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;

  return {
    subject: digestSubject(window, user),
    html,
    text: renderText(summary, user, ctx),
    headers: {
      // RFC 8058: lets a mail client unsubscribe in one click, without the user
      // hunting for the link. Both headers are required for it to be honoured.
      "List-Unsubscribe": `<${unsub}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

export function renderText(summary: MarketSummary, user: UserSummary, ctx: RenderContext): string {
  const { window } = summary;
  const weekly = window.frequency === "weekly";
  const lines: string[] = [
    `advis0r.com — ${weekly ? "your week in review" : "your watchlist yesterday"}`,
    `${windowLabel(window)} · sent as pre-market opens`,
    "",
  ];

  if (summary.indices.length) {
    lines.push(
      summary.indices.map((i) => `${i.label ?? i.ticker} ${percent(i.changePercent)}`).join("   "),
      "",
    );
  }

  for (const r of user.rows) {
    const tail = weekly ? `range ${money(r.low)}-${money(r.high)}` : `vol ${volume(r.volume)}`;
    lines.push(`${r.ticker.padEnd(7)} ${money(r.close).padStart(10)}  ${percent(r.changePercent).padStart(8)}  ${tail}`);
  }

  if (user.unavailable.length) {
    lines.push("", `No market data this period for ${user.unavailable.join(", ")}.`);
  }

  if (user.headlines.length) {
    lines.push("", "In the news:");
    for (const h of user.headlines) {
      lines.push(`- [${h.ticker}] ${h.title}`, `  ${h.url}`);
    }
  }

  lines.push(
    "",
    `Open your watchlist: ${base(ctx.appUrl)}/`,
    "",
    `Prices from ${summary.source}. ${DISCLAIMER.replace(/\s+/g, " ")}`,
    "",
    `Change frequency: ${preferencesUrl(ctx.appUrl)}`,
    `Unsubscribe: ${unsubscribeUrl(ctx.appUrl, ctx.unsubscribeToken)}`,
  );
  return lines.join("\n");
}
