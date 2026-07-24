'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('config exposes the claim-burn defaults', () => {
  const config = require('./config');
  assert.strictEqual(config.claimTriggerEth, 0.01);
  assert.strictEqual(config.pollSchedule, '*/5 * * * *');
  assert.strictEqual(config.dryRunFeePerPoll, 0.01);
  assert.strictEqual(config.chainId, 4663);
  assert.strictEqual(config.deadAddress, '0x000000000000000000000000000000000000dead');
  // Pons launchpad infra on Robinhood Chain (ponsfamily.com deployment).
  // The locker is auto-discovered from the token's launchFactory() at runtime;
  // config only carries an explicit LOCKER_ADDRESS override.
  assert.strictEqual(config.locker, null);
  assert.strictEqual(config.weth, '0x0bd7d308f8e1639fab988df18a8011f41eacad73');
});

test('CLAIM_TRIGGER_ETH and DEAD_ADDRESS are overridable', () => {
  delete require.cache[require.resolve('./config')];
  process.env.CLAIM_TRIGGER_ETH = '0.05';
  process.env.DEAD_ADDRESS = '0x000000000000000000000000000000000000DEAD';
  const config = require('./config');
  assert.strictEqual(config.claimTriggerEth, 0.05);
  assert.strictEqual(config.deadAddress, '0x000000000000000000000000000000000000dead');
  delete process.env.CLAIM_TRIGGER_ETH;
  delete process.env.DEAD_ADDRESS;
  delete require.cache[require.resolve('./config')];
});
