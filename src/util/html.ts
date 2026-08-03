/**
 * HTML escaping for server-rendered output.
 *
 * Everything the server writes into markup — company names, headlines, model
 * prose, ticker symbols from a URL — is untrusted: source text is scraped from
 * the open web and analysis text is model output. This is the single choke
 * point, so there is one implementation to audit rather than one per template.
 */
export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Escape for an XML text node (sitemaps). Same rules, separate name for intent. */
export const escapeXml = escapeHtml;
