/**
 * Estimate the additional cost of registering a foreign-plate car in Serbia.
 *
 * Pure calculation (no DB, no network). Based on Serbian customs/VAT rules
 * for used passenger-car imports (2026):
 *
 * - Customs duty: 0% with proof of EU preferential origin (EUR.1 / origin
 *   declaration), otherwise 12.5%. Defaults to 12.5% (no origin proof at
 *   browsing time).
 * - VAT: 20% on (customs value + duty + waste fee + transport to border).
 * - Waste/eco fee: 14.58 RSD per kg of vehicle mass (2026). Mass is not in
 *   the feed, so a typical ~1,400 kg passenger car is assumed (~€174).
 * - No excise and no 2.5% transfer tax on passenger-car imports.
 *
 * IMPORTANT: Serbian customs determines the vehicle's value itself using
 * AMSS catalogs — an understated invoice does not lower the duty/VAT base.
 * Pass `customsAssessedValueEur` when the seller confirms an AMSS value
 * (e.g. "cena na ime kupca sa potvrdom AMSS"); otherwise the calculation is
 * based on the advertised price and the real total may be higher.
 *
 * Fixed fees (rough, market-researched): border transport ~€500, technical
 * inspection/homologation ~€130, registration/plates/insurance ~€220,
 * customs-agency clearance ~€170, database extract ~€70.
 *
 * This is a planning estimate, not a quote.
 */
export interface SerbiaImportCostEstimateEur {
  /** Advertised asking price (EUR). */
  priceEur: number;
  /** Value customs actually uses — AMSS catalog value, or `priceEur` when not overridden. */
  customsValueEur: number;
  /** 'advertised' when customs uses the asking price, 'assessed' when an AMSS value overrides it. */
  valueSource: 'advertised' | 'assessed';
  /** Assumed transport cost to the Serbian border (EUR). Default 500. */
  transportEur: number;
  /** Duty rate applied (0 / 0.05 / 0.125). Default 0.125 (no origin proof). */
  dutyRate: number;
  /** Duty amount. */
  dutyEur: number;
  /** Estimated waste/eco fee (mass not available in the feed). Default ~174. */
  wasteFeeEur: number;
  /** VAT base = customs value + duty + waste fee. */
  vatBaseEur: number;
  /** VAT amount at 20%. */
  vatEur: number;
  /** Fixed inspection/registration/agency/db-extract fees (EUR). Default 590. */
  fixedFeesEur: number;
  /** Everything added on top of the customs value. */
  totalAddedEur: number;
  /** Customs value + all import/registration costs — the realistic all-in price. */
  totalRealisticEur: number;
  /** totalAddedEur as a % of the customs value. */
  surchargePct: number;
  /** Human-readable caveat to show next to the estimate. */
  note: string;
}

const DEFAULT_TRANSPORT_EUR = 500;
// 14.58 RSD/kg x ~1,400 kg / ~117.4 RSD per EUR (customs middle rate).
const DEFAULT_WASTE_FEE_EUR = 174;
// Inspection 130 + registration 220 + agency 170 + db extract 70.
const DEFAULT_FIXED_FEES_EUR = 590;
const DUTY_RATE_NO_ORIGIN_PROOF = 0.125;
const VAT_RATE = 0.2;

const ADVERTISED_NOTE =
  'Customs assesses value via AMSS catalogs — understated prices are ' +
  'corrected upward, so the real total may be higher.';

const ASSESSED_NOTE =
  'Based on seller-confirmed AMSS value; customs uses this as the duty/VAT base.';

export function estimateSerbiaImportCostsEur(
  priceEur: number,
  opts: {
    /** Assumed transport to Serbian border (EUR). Default 500. */
    transportEur?: number;
    /** Waste/eco fee (EUR). Default ~174 (~1,400 kg). */
    wasteFeeEur?: number;
    /** Fixed inspection/registration/agency/db-extract fees (EUR). Default 590. */
    fixedFeesEur?: number;
    /** Duty rate override (0 / 0.05 / 0.125). Default 0.125 (no origin proof). */
    dutyRate?: number;
    /** AMSS-assessed customs value (EUR), e.g. seller-confirmed "cena sa potvrdom AMSS". */
    customsAssessedValueEur?: number;
  } = {},
): SerbiaImportCostEstimateEur {
  const transport = opts.transportEur ?? DEFAULT_TRANSPORT_EUR;
  const wasteFee = opts.wasteFeeEur ?? DEFAULT_WASTE_FEE_EUR;
  const fixedFees = opts.fixedFeesEur ?? DEFAULT_FIXED_FEES_EUR;
  const dutyRate = opts.dutyRate ?? DUTY_RATE_NO_ORIGIN_PROOF;

  const assessedValue =
    opts.customsAssessedValueEur != null && opts.customsAssessedValueEur > 0
      ? opts.customsAssessedValueEur
      : priceEur;

  const customsValue = assessedValue + transport;
  const dutyEur = customsValue * dutyRate;
  const vatBase = customsValue + dutyEur + wasteFee;
  const vatEur = vatBase * VAT_RATE;
  const totalAddedEur = dutyEur + vatEur + transport + wasteFee + fixedFees;
  const totalRealisticEur = assessedValue + totalAddedEur;
  const surchargePct =
    assessedValue > 0 ? (totalAddedEur / assessedValue) * 100 : 0;

  const valueSource =
    opts.customsAssessedValueEur != null && opts.customsAssessedValueEur > 0
      ? 'assessed'
      : 'advertised';

  const note = valueSource === 'assessed' ? ASSESSED_NOTE : ADVERTISED_NOTE;

  return {
    priceEur,
    customsValueEur: assessedValue,
    valueSource,
    transportEur: transport,
    dutyRate,
    dutyEur,
    wasteFeeEur: wasteFee,
    vatBaseEur: vatBase,
    vatEur,
    fixedFeesEur: fixedFees,
    totalAddedEur,
    totalRealisticEur,
    surchargePct,
    note,
  };
}
