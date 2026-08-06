/** Mandatory disclaimer attached to every ranking (PRD §27). */
export const DISCLAIMER = `This output is generated from public information and automated analysis.
It is a research aid, not a guarantee, personalized recommendation, or
substitute for professional financial advice. Small-cap and low-priced
stocks may be highly volatile, illiquid, subject to dilution, manipulation,
delisting, and total loss.`;

/**
 * Crypto carries risks the equity disclaimer does not name — no issuer, no
 * exchange listing standards, 24/7 trading with no circuit breakers, and
 * venue-specific pricing. Routes under /crypto/** attach this instead.
 */
export const CRYPTO_DISCLAIMER = `This output is generated from public market data and automated analysis.
It is a research aid, not a guarantee, personalized recommendation, or
substitute for professional financial advice. Digital assets are unregulated
in many jurisdictions, trade 24/7 without circuit breakers, and may be
extremely volatile, thinly traded, or subject to manipulation and total loss.
Prices reflect Alpaca's US crypto venue and may differ materially from other
exchanges.`;

/** Language that must never appear in output (PRD §27). */
export const BANNED_PHRASES = [
  "guaranteed winner",
  "guaranteed return",
  "can't lose",
  "risk-free",
  "sure thing",
];

export function assertNoBannedLanguage(text: string): void {
  const lower = text.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      throw new Error(`Output contains prohibited language: "${phrase}"`);
    }
  }
}
