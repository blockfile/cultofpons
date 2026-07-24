'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Shared dry-run env for every cycle test. REWARD_TOKEN must be set BEFORE the
// config module is first required (node --test isolates each file in its own
// process, so one config load serves the whole file).
process.env.DRY_RUN = 'true';
process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000b0b01';
process.env.REWARD_TOKEN = '0x00000000000000000000000000000000000d0d0d';
process.env.REWARD_SYMBOL = 'PONS';
// REWARD_BUY_PCT defaults to 80; MIN_HOLD defaults to 100000.

test('runCycle (DRY_RUN): claim → burn → buyback + airdrop to holders', async () => {
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
    assert.strictEqual(cycle.mode, 'claim-burn-reward');

    // Claim → burn the launched-token fees → buy the reward token → airdrop it.
    assert.deepStrictEqual(cycle.steps.map((s) => s.name), ['claim', 'burn', 'buy', 'airdrop']);

    // Claims the whole pending WETH side.
    assert.strictEqual(cycle.eth_claimed, 0.05);
    // Burns exactly the claimed token-side fees.
    assert.strictEqual(cycle.tokens_burned, 1000);
    assert.ok(cycle.burn_sig, 'records the burn tx');

    // 80% of the claim (0.04 WETH) funds the buyback; the reward is airdropped.
    assert.strictEqual(cycle.eth_spent_buy, 0.04);
    assert.ok(cycle.tokens_bought > 0, 'bought reward tokens');
    assert.strictEqual(cycle.eligible_holders, 2, '2 eligible holders (operating wallet excluded)');
    assert.strictEqual(cycle.total_holders, 3);

    // Every eligible holder got an airdrop row.
    const airdrops = await repo.getAirdrops(50, 0);
    assert.strictEqual(airdrops.total, 2);
    assert.ok(airdrops.items.every((a) => a.status === 'ok'));

    const stats = await repo.getStats();
    assert.strictEqual(stats.burns, 1);
    assert.strictEqual(stats.buys, 1);
    assert.strictEqual(stats.total_eth_claimed, 0.05);
    assert.strictEqual(stats.total_tokens_burned, 1000);
    assert.strictEqual(stats.total_eth_spent_buy, 0.04);
  } finally {
    await db.close();
    await mongod.stop();
  }
});

test('runCycle (DRY_RUN): pending fees below the trigger → skipped', async () => {
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
    assert.ok(!cycle.steps.some((s) => s.name === 'buy'));
    assert.strictEqual(simvault.peek().pendingWeth, 0.0005, 'fees stay in the locker for later');
  } finally {
    await db.close();
    await mongod.stop();
  }
});

test('runCycle (DRY_RUN): claim delivers no tokens → still buys + airdrops, no burn', async () => {
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
    // No burn step (nothing to burn), but the WETH still funds the buyback+airdrop.
    assert.deepStrictEqual(cycle.steps.map((s) => s.name), ['claim', 'buy', 'airdrop']);
    assert.strictEqual(cycle.eth_claimed, 0.02);
    assert.strictEqual(cycle.tokens_burned, 0);
    assert.strictEqual(cycle.eth_spent_buy, 0.016); // 80% of 0.02
    assert.ok(cycle.tokens_bought > 0);
  } finally {
    await db.close();
    await mongod.stop();
  }
});
