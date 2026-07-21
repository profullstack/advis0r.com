/** Rough token estimate for cost/budget checks (PRD §25). ~4 chars/token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
