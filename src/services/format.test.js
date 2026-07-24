'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  toPublicSummary,
  buildUnclaimedPayload,
  toActivityRow,
  toPublicActivityRow,
  toPublicStats,
  compactUsd,
  toRewardDrop,
  toRewardsPayload,
} = require('./format');

test('buildUnclaimedPayload reports the live balance and the claim threshold', () => {
  const out = buildUnclaimedPayload(0.5, 3000);
  assert.deepStrictEqual(
    Object.keys(out).sort(),
    ['claimThresholdEth', 'claimThresholdUsd', 'ethPriceUsd', 'unclaimedEth', 'unclaimedUsd']
  );
  assert.strictEqual(out.unclaimedEth, 0.5);
  assert.strictEqual(out.unclaimedUsd, 1500);
  assert.strictEqual(out.ethPriceUsd, 3000);
  // Default trigger is ETH-denominated: 0.01 WETH per cycle (~$30 @ $3000).
  assert.strictEqual(out.claimThresholdEth, 0.01);
  assert.strictEqual(out.claimThresholdUsd, 30);
  assert.strictEqual(buildUnclaimedPayload(null, 3000).unclaimedEth, null);
});

test('toActivityRow maps buy + burn steps', () => {
  const buy = toActivityRow({ name: 'buy', detail: { ethSpent: 0.4, tokensBought: 1000 }, signature: 'sig', created_at: 'x' }, 100);
  assert.strictEqual(buy.type, 'Buy');
  assert.strictEqual(buy.amountEth, 0.4);
  assert.strictEqual(buy.tokens, 1000);

  const burn = toActivityRow({ name: 'burn', detail: { tokensBurned: 1000 }, created_at: 'x' }, 100);
  assert.strictEqual(burn.type, 'Burn');
  assert.strictEqual(burn.status, 'Burned');
  assert.strictEqual(burn.tokens, 1000);
});

test('toPublicActivityRow maps buy + burn steps', () => {
  const row = toPublicActivityRow({ name: 'buy', detail: { ethSpent: 0.2, tokensBought: 500 }, signature: 's', created_at: '2026-07-11T00:00:00Z' }, 100);
  assert.strictEqual(row.type, 'buy');
  assert.strictEqual(row.amountEth, 0.2);
  assert.strictEqual(typeof row.usdtValue, 'number'); // never null

  const burn = toPublicActivityRow({ name: 'burn', detail: { tokensBurned: 500 }, signature: 's', created_at: '2026-07-11T00:00:00Z' }, 100);
  assert.strictEqual(burn.type, 'burn');
  assert.strictEqual(burn.status, 'burned');
  assert.strictEqual(burn.tokens, 500);
});

test('toActivityRow maps an airdrop step', () => {
  const air = toActivityRow(
    { name: 'airdrop', detail: { symbol: 'PONS', recipients: 12, sent: 12, failed: 0 }, created_at: 'x' },
    100
  );
  assert.strictEqual(air.type, 'Airdrop');
  assert.strictEqual(air.status, 'Airdropped');
  assert.strictEqual(air.tokens, 12); // recipients paid
});

test('toPublicStats emits the flat frontend stats object', () => {
  const out = toPublicStats({
    stats: { total_eth_claimed: 12, total_tokens_burned: 1000, burns: 6 },
    unclaimedEth: 0.5,
    operatingWallet: '0xwallet',
    market: { marketCap: 100 },
  });
  assert.strictEqual(out.totalCreatorFeesClaimed, 12);
  assert.strictEqual(out.tokensBurned, 1000);
  assert.strictEqual(out.burns, 6);
  assert.strictEqual(out.operatingWallet, '0xwallet');
  assert.strictEqual(out.unclaimedFeesEth, 0.5);
  assert.strictEqual(out.marketCap, 100);
  // Progress toward the next claim + burn (pending locker WETH vs the trigger).
  assert.strictEqual(out.totalBurned, 1000);
  assert.strictEqual(out.pendingEth, 0.5);
  assert.strictEqual(out.burnTriggerEth, 0.01);
  // SoftieClone-style aliases stay in sync.
  assert.strictEqual(out.buybackEth, 0.5);
  assert.strictEqual(out.buybackTarget, 0.01);
});

test('toPublicStats surfaces the buyback + airdrop totals', () => {
  const out = toPublicStats({
    stats: { total_eth_claimed: 12, total_eth_spent_buy: 0.8, total_tokens_bought: 50000 },
    unclaimedEth: 0,
    operatingWallet: '0xwallet',
    airdropTotals: { '0xpons': { sends: 40, totalUi: 49000, holders: 40 } },
    eligibleHolders: 42,
    rewardSymbol: 'PONS',
  });
  assert.strictEqual(out.totalRewardSpentEth, 0.8);
  assert.strictEqual(out.totalRewardBought, 50000);
  assert.strictEqual(out.totalAirdropped, 49000);
  assert.strictEqual(out.airdropSends, 40);
  assert.strictEqual(out.eligibleHolders, 42);
  assert.strictEqual(out.rewardSymbol, 'PONS');
});

test('toPublicSummary reports claimed fees and burned totals', () => {
  const out = toPublicSummary({
    stats: { total_eth_claimed: 10, total_tokens_burned: 1234, burns: 8, completed: 8 },
    price: 3000,
    marketCapUsd: 55_620_000,
  });
  assert.strictEqual(out.creatorFeesClaimedEth, 10);
  assert.strictEqual(out.creatorFeesClaimedUsd, 30000);
  assert.strictEqual(out.tokensBurned, 1234);
  assert.strictEqual(out.burns, 8);
  assert.strictEqual(out.marketCapUsd, 55_620_000);
});

test('toPublicSummary marketCapUsd defaults to null when not provided', () => {
  const out = toPublicSummary({ stats: {}, price: 0 });
  assert.strictEqual(out.marketCapUsd, null);
});

test('compactUsd formats magnitudes and handles null', () => {
  assert.strictEqual(compactUsd(4_280_000), '$4.28M');
  assert.strictEqual(compactUsd(1_234), '$1.23K');
  assert.strictEqual(compactUsd(55_620_000), '$55.62M');
  assert.strictEqual(compactUsd(2_500_000_000), '$2.50B');
  assert.strictEqual(compactUsd(42), '$42.00');
  assert.strictEqual(compactUsd(null), '—');
  assert.strictEqual(compactUsd(undefined), '—');
});

test('toRewardDrop carries a unique id, preformatted amount, and the real tx', () => {
  const d = toRewardDrop({
    id: 42,
    recipient: '0xWallet',
    amount_ui: 12408.55,
    signature: '0xbatchtx',
    created_at: '2026-07-25T00:00:00.000Z',
  });
  assert.strictEqual(d.id, '42'); // stable key even when a disperse batch shares tx
  assert.strictEqual(d.wallet, '0xWallet');
  assert.strictEqual(d.amount, '12,408.55');
  assert.strictEqual(d.tx, '0xbatchtx');
  assert.strictEqual(d.at, Date.parse('2026-07-25T00:00:00.000Z'));
});

test('toRewardsPayload builds the vigil feed shape', () => {
  const out = toRewardsPayload({
    symbol: 'PONS',
    intervalSec: 300,
    nextDropAt: 1730000000000,
    explorerTxUrl: 'https://exp/tx/',
    distributingMs: 9000,
    market: { marketCap: 4_280_000 },
    summary: { distributed: 48920441, holdersPaid: 1284, drops: 607 },
    burned: 12_500_000,
    feed: [{ id: 2, recipient: '0xB', amount_ui: 9117.2, signature: '0xt', created_at: '2026-07-25T00:00:00Z' }],
  });
  assert.strictEqual(out.rewardSymbol, 'PONS');
  assert.strictEqual(out.intervalMs, 300000);
  assert.strictEqual(out.distributingMs, 9000);
  assert.strictEqual(out.nextDropAt, 1730000000000);
  assert.strictEqual(out.explorerTxUrl, 'https://exp/tx/');
  assert.deepStrictEqual(out.totals, {
    marketCap: '$4.28M',
    distributed: '48,920,441',
    burned: '12,500,000',
    holdersPaid: '1,284',
    drops: '607',
  });
  assert.strictEqual(out.drops.length, 1);
  assert.strictEqual(out.drops[0].amount, '9,117.20');
  assert.strictEqual(out.drops[0].id, '2');
});
