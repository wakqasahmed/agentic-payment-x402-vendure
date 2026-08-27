/**
 * Payments that could plausibly still settle or already have, mirroring the
 * state filter Vendure's own (internal, non-exported) `totalCoveredByPayments`
 * helper uses. Settled refunds are netted out; unlike that helper, this does
 * not additionally filter by state history depth -- fine for a same-request
 * quote or a pre-settle drift check, not intended as a full ledger reconciliation.
 */
export interface PaymentForCoverage {
  state: string;
  amount: number;
  refunds?: Array<{ state: string; total: number }>;
}

export function totalCoveredByPayments(payments: PaymentForCoverage[]): number {
  const covering = payments.filter(p => p.state !== 'Error' && p.state !== 'Declined' && p.state !== 'Cancelled');
  let total = 0;
  for (const payment of covering) {
    const settledRefundTotal = (payment.refunds ?? [])
      .filter(r => r.state === 'Settled')
      .reduce((sum, r) => sum + r.total, 0);
    total += payment.amount - Math.abs(settledRefundTotal);
  }
  return total;
}
