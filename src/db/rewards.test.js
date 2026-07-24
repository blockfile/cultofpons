'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

// getRewardsSummary + getRewardsFeed feed the public GET /rewards endpoint.
test('rewards summary + feed aggregate airdrop payouts', async () => {
  process.env.DRY_RUN = 'true';
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'bop_test_rewards';
  const db = require('./index');
  const repo = require('./repository');
  const { toRewardsPayload } = require('../services/format');
  await db.connect();
  try {
    // Round 1 (cycle 1): a disperse batch — two wallets share ONE tx hash.
    await repo.addAirdrop({ cycleId: 1, rewardToken: '0xpons', recipient: '0xA', amountRaw: '1', amountUi: 100, signature: '0xbatch1', status: 'ok' });
    await repo.addAirdrop({ cycleId: 1, rewardToken: '0xpons', recipient: '0xB', amountRaw: '1', amountUi: 200, signature: '0xbatch1', status: 'ok' });
    // Round 2 (cycle 2): 0xA again (still one distinct wallet) + a new wallet.
    await repo.addAirdrop({ cycleId: 2, rewardToken: '0xpons', recipient: '0xA', amountRaw: '1', amountUi: 50, signature: '0xbatch2', status: 'ok' });
    await repo.addAirdrop({ cycleId: 2, rewardToken: '0xpons', recipient: '0xC', amountRaw: '1', amountUi: 300, signature: '0xbatch2', status: 'ok' });
    // A failed payout must not count.
    await repo.addAirdrop({ cycleId: 2, rewardToken: '0xpons', recipient: '0xD', amountRaw: '1', amountUi: 999, signature: null, status: 'failed' });

    const summary = await repo.getRewardsSummary();
    assert.strictEqual(summary.distributed, 650); // 100+200+50+300
    assert.strictEqual(summary.holdersPaid, 3); // distinct A,B,C
    assert.strictEqual(summary.drops, 2); // two distribution rounds (cycles)

    const feed = await repo.getRewardsFeed(50);
    assert.strictEqual(feed.length, 4); // failed row excluded
    assert.strictEqual(feed[0].recipient, '0xC'); // newest first (last inserted ok row)

    // Total $COP burned comes from the cycles, across two burn cycles.
    const c1 = await repo.createCycle({ dryRun: true });
    await repo.finishCycle(c1, { status: 'complete', tokens_burned: 12_000_000 });
    const c2 = await repo.createCycle({ dryRun: true });
    await repo.finishCycle(c2, { status: 'complete', tokens_burned: 500_000 });
    assert.strictEqual(await repo.getTotalBurned(), 12_500_000);

    // The two rows from a disperse batch share a tx but get distinct ids.
    const burned = await repo.getTotalBurned();
    const payload = toRewardsPayload({ symbol: 'PONS', intervalSec: 300, nextDropAt: 1, explorerTxUrl: 'x/', distributingMs: 9000, market: { marketCap: null }, summary, burned, feed });
    assert.strictEqual(payload.totals.distributed, '650');
    assert.strictEqual(payload.totals.holdersPaid, '3');
    assert.strictEqual(payload.totals.drops, '2');
    assert.strictEqual(payload.totals.burned, '12,500,000');
    assert.strictEqual(payload.totals.marketCap, '—'); // not listed → em dash
    const ids = new Set(payload.drops.map((d) => d.id));
    assert.strictEqual(ids.size, payload.drops.length, 'every drop has a unique id even across a shared tx');
  } finally {
    await db.close();
    await mongod.stop();
  }
});
