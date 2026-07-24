'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Accumulation mode: a cycle only fires once the pending creator WETH reaches
// CLAIM_TRIGGER_ETH. Set BEFORE the config module is first required (node --test
// isolates each file in its own process, so one config load serves the file).
process.env.DRY_RUN = 'true';
process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000b0b01';
process.env.REWARD_TOKEN = '0x00000000000000000000000000000000000d0d0d';
process.env.TRIGGER_MODE = 'accumulation';
// CLAIM_TRIGGER_ETH defaults to 0.01.

test('runCycle (accumulation): pending below CLAIM_TRIGGER_ETH → skipped', async () => {
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'bop_test_accum_skip';
  const db = require('../db/index');
  const { runCycle } = require('./cycle');
  const simvault = require('../evm/simvault');
  await db.connect();
  try {
    simvault.reset({ pendingWeth: 0.0005, pendingTokens: 50 }); // below the 0.01 trigger
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'skipped');
    assert.ok(!cycle.steps.some((s) => s.name === 'claim'));
    assert.match(cycle.note, /below trigger/);
    assert.strictEqual(simvault.peek().pendingWeth, 0.0005, 'fees stay in the locker for later');
  } finally {
    await db.close();
    await mongod.stop();
  }
});

test('runCycle (accumulation): pending at/above the trigger → full cycle', async () => {
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'bop_test_accum_run';
  const db = require('../db/index');
  const { runCycle } = require('./cycle');
  const simvault = require('../evm/simvault');
  await db.connect();
  try {
    simvault.reset({ pendingWeth: 0.05, pendingTokens: 500 });
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'complete');
    assert.deepStrictEqual(cycle.steps.map((s) => s.name), ['claim', 'burn', 'buy', 'airdrop']);
    assert.strictEqual(cycle.eth_claimed, 0.05);
  } finally {
    await db.close();
    await mongod.stop();
  }
});
