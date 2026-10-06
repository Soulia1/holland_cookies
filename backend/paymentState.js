/** Only normalized, authenticated provider data reaches this decision. */
export function paymentDecision(order, txn) {
  if (order.paymentMethod !== 'online') return { outcome: 'not_online' };
  if (!order.paymob?.orderIds?.includes(txn.paymobOrderId)) return { outcome: 'order_mismatch' };
  if (!txn.id || !Number.isSafeInteger(txn.amountCents) || txn.amountCents <= 0 || txn.currency !== 'EGP') {
    return { outcome: 'amount_mismatch' };
  }
  if (txn.followUp) return { outcome: 'follow_up' };
  if (txn.pending || txn.auth) return { outcome: 'pending' };
  if (!txn.success || txn.error) return { outcome: 'declined' };
  if (txn.amountCents !== Math.round(order.total * 100)) return { outcome: 'amount_mismatch' };
  if (order.paymentRef && order.paymentRef !== txn.id) return { outcome: 'duplicate_charge' };
  const previousRefund = order.paymob?.refundedCents ?? 0;
  const refundedCents = txn.verifiedInquiry ? (txn.voided ? txn.amountCents : txn.refundedCents) : previousRefund;
  if (!Number.isSafeInteger(refundedCents) || refundedCents < 0 || refundedCents > txn.amountCents) {
    return { outcome: 'refund_mismatch' };
  }
  if (refundedCents < previousRefund) return { outcome: 'stale', order };
  const paymentStatus = refundedCents === txn.amountCents ? 'refunded' : 'paid';
  if (order.paymentStatus === paymentStatus && refundedCents === previousRefund) {
    return { outcome: 'already_paid', order };
  }
  const methodUpdate = txn.method ? { 'paymob.lastMethod': txn.method } : {};
  const source = txn.method?.toLowerCase();
  const onlineMethodUpdate = source === 'wallet' || source === 'card' ? { onlineMethod: source } : {};
  return {
    outcome: refundedCents > 0 ? (paymentStatus === 'refunded' ? 'refunded' : 'partially_refunded') : 'paid',
    update: { paymentStatus, paymentRef: txn.id, 'paymob.refundedCents': refundedCents, ...methodUpdate, ...onlineMethodUpdate },
  };
}
