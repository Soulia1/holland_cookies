import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentDecision } from '../paymentState.js';

const order = { total: 200, paymentMethod: 'online', paymentStatus: 'unpaid', paymob: { orderIds: ['555'] } };
const txn = { id: '9001', paymobOrderId: '555', currency: 'EGP', amountCents: 20000, success: true };

test('only the bound Paymob order and exact charge can settle an order', () => {
  assert.equal(paymentDecision(order, txn).outcome, 'paid');
  for (const [change, expected] of [
    [{ paymobOrderId: '556' }, 'order_mismatch'], [{ amountCents: 1 }, 'amount_mismatch'],
    [{ currency: 'USD' }, 'amount_mismatch'], [{ amountCents: NaN }, 'amount_mismatch'],
    [{ success: false }, 'declined'], [{ error: true }, 'declined'],
    [{ pending: true }, 'pending'], [{ auth: true }, 'pending'], [{ followUp: true }, 'follow_up'],
  ]) assert.equal(paymentDecision(order, { ...txn, ...change }).outcome, expected);
});

test('refund totals require authenticated inquiry and never decrease on stale delivery', () => {
  const paid = { ...order, paymentStatus: 'paid', paymentRef: '9001', paymob: { ...order.paymob, refundedCents: 5000 } };
  assert.equal(paymentDecision(paid, { ...txn, refundedCents: 20000 }).outcome, 'already_paid');
  assert.equal(paymentDecision(paid, { ...txn, verifiedInquiry: true, refundedCents: 1000 }).outcome, 'stale');
  const partial = paymentDecision(paid, { ...txn, verifiedInquiry: true, refundedCents: 7000 });
  assert.equal(partial.outcome, 'partially_refunded');
  assert.equal(partial.update['paymob.refundedCents'], 7000);
  assert.equal(partial.update.paymentStatus, 'paid');
  assert.equal(paymentDecision(paid, { ...txn, verifiedInquiry: true, refundedCents: 20000 }).update.paymentStatus, 'refunded');
  assert.equal(paymentDecision(paid, { ...txn, verifiedInquiry: true, refundedCents: 20001 }).outcome, 'refund_mismatch');
  assert.equal(paymentDecision(paid, { ...txn, verifiedInquiry: true, refundedCents: 0, voided: true }).update.paymentStatus, 'refunded');
});

test('a second charge is flagged and a payment replay cannot erase a full refund', () => {
  const refunded = { ...order, paymentStatus: 'refunded', paymentRef: '9001', paymob: { ...order.paymob, refundedCents: 20000 } };
  assert.equal(paymentDecision(refunded, txn).outcome, 'already_paid');
  assert.equal(paymentDecision(refunded, { ...txn, id: '9002' }).outcome, 'duplicate_charge');
});
