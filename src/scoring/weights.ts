/**
 * Versioned scoring weights (PRD §13). Weights are stored in config/DB and
 * versioned — any change creates a new strategy version (PRD §18.3).
 */
export interface ScoreWeights {
  transcriptCatalyst: number;
  independentConfirmation: number;
  revenueBacklogAcceleration: number;
  managementExecution: number;
  financialHealth: number;
  valuationContext: number;
  priceVolumeConfirmation: number;
  eventCalendar: number;
  // Penalties (applied as negatives)
  dilutionRisk: number;
  liquidityManipulationRisk: number;
  contradictoryEvidence: number;
}

export const STRATEGY_VERSION = "v0.1.0";

export const DEFAULT_WEIGHTS: ScoreWeights = {
  transcriptCatalyst: 0.2,
  independentConfirmation: 0.15,
  revenueBacklogAcceleration: 0.15,
  managementExecution: 0.1,
  financialHealth: 0.1,
  valuationContext: 0.1,
  priceVolumeConfirmation: 0.05,
  eventCalendar: 0.05,
  dilutionRisk: 0.2, // max penalty magnitude
  liquidityManipulationRisk: 0.2,
  contradictoryEvidence: 0.25,
};
