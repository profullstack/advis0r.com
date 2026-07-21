/** Mandatory disclaimer attached to every ranking (PRD §27). */
export const DISCLAIMER = `This output is generated from public information and automated analysis.
It is a research aid, not a guarantee, personalized recommendation, or
substitute for professional financial advice. Small-cap and low-priced
stocks may be highly volatile, illiquid, subject to dilution, manipulation,
delisting, and total loss.`;

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
