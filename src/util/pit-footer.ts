// The pit.world global footer (site name, Search, Ring, Publish here), fetched
// server-side from pit.world and appended as the last thing in <body> of every
// HTML page. Cached in memory for an hour, served stale when a refresh fails,
// and on any failure with nothing cached it renders nothing: the footer must
// never break a page.

const PIT_FOOTER_URL = "https://pit.world/snippets/footer.html?site=advis0r.com";
const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 3000;

let cached = "";
let fetchedAt = 0;
let inflight: Promise<string> | null = null;

async function refresh(fetcher: typeof fetch): Promise<string> {
  try {
    const res = await fetcher(PIT_FOOTER_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`pit footer ${res.status}`);
    const html = (await res.text()).trim();
    if (!html.includes("data-pit-footer")) throw new Error("pit footer: unexpected body");
    cached = html;
    fetchedAt = Date.now();
  } catch {
    // Keep serving whatever we had; retry on the next request after a minute.
    fetchedAt = Date.now() - TTL_MS + 60_000;
  }
  return cached;
}

/** The global footer HTML, or "" when it has never loaded. */
export async function pitFooterHtml(fetcher: typeof fetch = fetch): Promise<string> {
  if (cached && Date.now() - fetchedAt < TTL_MS) return cached;
  if (!cached && fetchedAt && Date.now() - fetchedAt < TTL_MS) return "";
  inflight ??= refresh(fetcher).finally(() => (inflight = null));
  return inflight;
}

/** Insert the footer just before the last </body>; leave the page alone if there is none. */
export function injectPitFooter(html: string, footer: string): string {
  if (!footer || html.includes("data-pit-footer")) return html;
  const at = html.lastIndexOf("</body>");
  if (at === -1) return html;
  return html.slice(0, at) + footer + "\n" + html.slice(at);
}

/** Test hook. */
export function resetPitFooterCache(): void {
  cached = "";
  fetchedAt = 0;
  inflight = null;
}
