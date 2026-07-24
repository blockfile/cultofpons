'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('runCycle (DRY_RUN): claim → burn the claimed tokens, keep the WETH', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000b0b01';
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'bop_test_cycle';
  const db = require('../db/index');
  const repo = require('../db/repository');
  const simvault = require('../evm/simvault');
  const { runCycle } = require('./cycle');
  await db.connect();
  try {
    // 0.05 WETH + 1000 tokens of creator fees pending in the locker.
    simvault.reset({ pendingWeth: 0.05, pendingTokens: 1000 });
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'complete');
    assert.strictEqual(cycle.mode, 'claim-burn');

    // Claim from the locker, then burn — NO buy step, ever.
    assert.deepStrictEqual(cycle.steps.map((s) => s.name), ['claim', 'burn']);

    // Claims the whole pending WETH side and keeps it (no buyback).
    assert.strictEqual(cycle.eth_claimed, 0.05);

    // Burns exactly the claimed token-side fees.
    assert.strictEqual(cycle.tokens_burned, 1000);
    assert.ok(cycle.burn_sig, 'records the burn tx');

    const burn = cycle.steps.find((s) => s.name === 'burn');
    assert.strictEqual(burn.detail.deadAddress, '0x000000000000000000000000000000000000dead');

    // The claim emptied the simulated locker; the WETH stayed in the wallet.
    const s = simvault.peek();
    assert.strictEqual(s.pendingWeth, 0);
    assert.strictEqual(s.walletWeth, 0.05, 'claimed WETH is kept — no buyback');
    assert.strictEqual(s.walletTokens, 0, 'claimed tokens were burned');

    const stats = await repo.getStats();
    assert.strictEqual(stats.burns, 1);
    assert.strictEqual(stats.total_eth_claimed, 0.05);
    assert.strictEqual(stats.total_tokens_burned, 1000);
  } finally {
    await db.close();
    await mongod.stop();
    delete require.cache[require.resolve('../config')];
  }
});

test('runCycle (DRY_RUN): pending fees below the trigger → skipped', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000b0b01';
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'bop_test_skip';
  const db = require('../db/index');
  const simvault = require('../evm/simvault');
  const { runCycle } = require('./cycle');
  await db.connect();
  try {
    simvault.reset({ pendingWeth: 0.0005, pendingTokens: 50 }); // below the 0.01 trigger
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'skipped');
    assert.ok(!cycle.steps.some((s) => s.name === 'claim'));
    assert.ok(!cycle.steps.some((s) => s.name === 'burn'));
    assert.strictEqual(simvault.peek().pendingWeth, 0.0005, 'fees stay in the locker for later');
  } finally {
    await db.close();
    await mongod.stop();
    delete require.cache[require.resolve('../config')];
  }
});

test('runCycle (DRY_RUN): claim delivers no tokens → complete without a burn', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000b0b01';
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'bop_test_notokens';
  const db = require('../db/index');
  const simvault = require('../evm/simvault');
  const { runCycle } = require('./cycle');
  await db.connect();
  try {
    simvault.reset({ pendingWeth: 0.02, pendingTokens: 0 }); // WETH-only claim
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'complete');
    assert.deepStrictEqual(cycle.steps.map((s) => s.name), ['claim']);
    assert.strictEqual(cycle.eth_claimed, 0.02);
    assert.strictEqual(cycle.tokens_burned, 0);
  } finally {
    await db.close();
    await mongod.stop();
    delete require.cache[require.resolve('../config')];
  }
});
