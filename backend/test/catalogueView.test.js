import test from 'node:test';
import assert from 'node:assert/strict';
import { sellable, lookupOf } from '../repo/catalogue.js';

test('a choice bundle is sold out when its available options cannot satisfy the required picks', () => {
  const names = lookupOf([{ id: 'a', available: true }, { id: 'b', available: false }]);
  const bundle = { available: true, isBundle: true, bundleType: 'choice', groups: [{ choose: 2, allowRepeats: false, options: [{ productId: 'a' }, { productId: 'b' }] }] };
  assert.equal(sellable(bundle, names), false);
  assert.equal(sellable({ ...bundle, groups: [{ ...bundle.groups[0], allowRepeats: true }] }, names), true);
  assert.equal(sellable(bundle, lookupOf([{ id: 'a', available: true }, { id: 'b', available: true }])), true);
  assert.equal(sellable(bundle, lookupOf([])), false);
});
