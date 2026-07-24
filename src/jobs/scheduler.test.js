'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('pollOnce: waits below the trigger, claims + burns when pending fees reach it', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000b0b01';
  process.env.DRY_RUN_FEE_PER_POLL = '0'; // no auto-accrual — we control the fee state
  process.env.DRY_RUN_TOKEN_FEE_PER_POLL = '0';
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'bop_test_sched';
  const db = require('../db/index');
  const repo = require('../db/repository');
  const simvault = require('../evm/simvault');
  const price = require('../evm/price');
  const scheduler = require('./scheduler');
  await db.connect();
  try {
    price._prime(3000); // deterministic ETH price — display only, no network fetch

    // No fees anywhere → tick skips silently, no cycle row written.
    simvault.reset();
    const p1 = await scheduler.pollOnce('poll');
    assert.strictEqual(p1.ran, false);
    assert.match(p1.reason, /below trigger/);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0, 'no cycle with no fees');

    // Below the 0.01 WETH trigger → wait, no cycle.
    simvault.reset({ pendingWeth: 0.0005 });
    const p2 = await scheduler.pollOnce('poll');
    assert.strictEqual(p2.ran, false);
    assert.strictEqual(p2.claimableUsd, 1.5); // 0.0005 * $3000
    assert.match(p2.reason, /below trigger/);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0, 'no cycle below the trigger');

    // Trigger reached → the tick claims and burns the token side.
    simvault.reset({ pendingWeth: 0.05, pendingTokens: 500 });
    const p3 = await scheduler.pollOnce('poll');
    assert.strictEqual(p3.ran, true);
    assert.strictEqual(p3.cycle.status, 'complete');
    assert.deepStrictEqual(p3.cycle.steps.map((s) => s.name), ['claim', 'burn']);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 1, 'one cycle once the trigger is hit');

    // The claimed WETH stays with the wallet — never re-enters the loop.
    assert.strictEqual(simvault.peek().walletWeth, 0.05, 'claimed WETH kept as dev income');
  } finally {
    await db.close();
    await mongod.stop();
    delete process.env.DRY_RUN_FEE_PER_POLL;
    delete process.env.DRY_RUN_TOKEN_FEE_PER_POLL;
    delete require.cache[require.resolve('../config')];
  }
});
