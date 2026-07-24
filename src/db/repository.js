'use strict';

const { getDb } = require('./index');
const bus = require('../events');

const NO_ID = { projection: { _id: 0 } };

/** Atomic numeric auto-increment, mirroring simple rowids. */
async function nextId(name) {
  const db = getDb();
  const doc = await db.collection('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  // mongodb v6 returns the document directly; older shapes nest it under .value
  return (doc && doc.seq) ?? (doc && doc.value && doc.value.seq);
}

async function createCycle({ dryRun }) {
  const db = getDb();
  const id = await nextId('cycles');
  await db.collection('cycles').insertOne({
    id,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    eth_claimed: null,
    eth_spent_buy: null,
    tokens_bought: null,
    tokens_burned: null,
    eligible_holders: null,
    total_holders: null,
    burn_sig: null,
    dry_run: dryRun ? 1 : 0,
    note: null,
    error: null,
  });
  return id;
}

/** Set only the provided fields; finished_at defaults to now. */
async function finishCycle(id, fields) {
  const db = getDb();
  const allowed = [
    'status',
    'mode',
    'eth_claimed',
    'eth_spent_buy',
    'tokens_bought',
    'tokens_burned',
    'eligible_holders',
    'total_holders',
    'burn_sig',
    'note',
    'error',
  ];
  const $set = { finished_at: fields.finished_at ?? new Date().toISOString() };
  for (const key of allowed) {
    if (fields[key] !== undefined) $set[key] = fields[key];
  }
  await db.collection('cycles').updateOne({ id }, { $set });
  bus.emit('cycle', { id, status: $set.status, mode: $set.mode ?? null }); // push to SSE clients
}

async function addStep({ cycleId, name, status, signature, detail }) {
  const db = getDb();
  const id = await nextId('steps');
  const doc = {
    id,
    cycle_id: cycleId,
    name,
    status,
    signature: signature ?? null,
    detail: detail ?? null,
    created_at: new Date().toISOString(),
  };
  await db.collection('steps').insertOne(doc);
  bus.emit('step', doc); // push to SSE clients
}

async function getCycleWithSteps(id) {
  const db = getDb();
  const cycle = await db.collection('cycles').findOne({ id }, NO_ID);
  if (!cycle) return null;
  const steps = await db
    .collection('steps')
    .find({ cycle_id: id }, NO_ID)
    .sort({ id: 1 })
    .toArray();
  return { ...cycle, steps };
}

async function getCycles(limit, offset) {
  const db = getDb();
  const total = await db.collection('cycles').countDocuments();
  const items = await db
    .collection('cycles')
    .find({}, NO_ID)
    .sort({ id: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();
  return { total, items };
}

async function getLastCycle() {
  const db = getDb();
  const last = await db.collection('cycles').find({}, NO_ID).sort({ id: -1 }).limit(1).toArray();
  return last.length ? getCycleWithSteps(last[0].id) : null;
}

async function getAllSteps(limit, offset) {
  const db = getDb();
  return db
    .collection('steps')
    .find({}, NO_ID)
    .sort({ id: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();
}

async function getStats() {
  const db = getDb();
  const [row] = await db
    .collection('cycles')
    .aggregate([
      {
        $group: {
          _id: null,
          cycles: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'complete'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          skipped: { $sum: { $cond: [{ $eq: ['$status', 'skipped'] }, 1, 0] } },
          total_eth_spent_buy: { $sum: { $ifNull: ['$eth_spent_buy', 0] } },
          total_tokens_bought: { $sum: { $ifNull: ['$tokens_bought', 0] } },
          total_tokens_burned: { $sum: { $ifNull: ['$tokens_burned', 0] } },
        },
      },
    ])
    .toArray();

  // Sum claimed ETH from the claim STEPS, not the cycles: a step is recorded the
  // moment a claim succeeds, while cycles.eth_claimed is only set at finish — a
  // cycle that claims and then fails would silently drop its claim from the total.
  const [claimRow] = await db
    .collection('steps')
    .aggregate([
      { $match: { name: 'claim', status: 'ok' } },
      { $group: { _id: null, eth: { $sum: { $ifNull: ['$detail.ethClaimed', 0] } } } },
    ])
    .toArray();

  // Number of successful burns and reward buys performed.
  const burns = await db.collection('steps').countDocuments({ name: 'burn', status: 'ok' });
  const buys = await db.collection('steps').countDocuments({ name: 'buy', status: 'ok' });

  return {
    ...(row || {
      cycles: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      total_eth_spent_buy: 0,
      total_tokens_bought: 0,
      total_tokens_burned: 0,
    }),
    total_eth_claimed: claimRow ? claimRow.eth : 0,
    burns,
    buys,
  };
}

/**
 * The eligible-holder count from the most recent cycle that recorded one — i.e.
 * the CURRENT number of wallets ≥ MIN_HOLD (each cycle re-snapshots, so this
 * drops as wallets become ineligible). Null if no cycle has snapshotted yet.
 */
async function getLatestEligibleHolders() {
  const db = getDb();
  const row = await db
    .collection('cycles')
    .find({ eligible_holders: { $ne: null } }, { projection: { eligible_holders: 1, _id: 0 } })
    .sort({ id: -1 })
    .limit(1)
    .next();
  return row ? row.eligible_holders : null;
}

async function addAirdrop({ cycleId, rewardToken, recipient, amountRaw, amountUi, signature, status }) {
  const db = getDb();
  const id = await nextId('airdrops');
  const doc = {
    id,
    cycle_id: cycleId,
    reward_token: rewardToken,
    recipient,
    amount_raw: String(amountRaw),
    amount_ui: amountUi ?? null,
    signature: signature ?? null,
    status: status ?? 'ok',
    created_at: new Date().toISOString(),
  };
  await db.collection('airdrops').insertOne(doc);
  bus.emit('airdrop', doc); // push to SSE clients
  return id;
}

async function getAirdrops(limit, offset, rewardToken = null) {
  const db = getDb();
  const filter = rewardToken ? { reward_token: rewardToken } : {};
  const total = await db.collection('airdrops').countDocuments(filter);
  const items = await db
    .collection('airdrops')
    .find(filter, NO_ID)
    .sort({ id: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();
  return { total, items };
}

// Aggregate successful airdrop sends PER reward token: send count, total UI
// amount distributed, and distinct recipient wallets. Keyed by reward_token.
async function getAirdropTotals() {
  const db = getDb();
  const rows = await db
    .collection('airdrops')
    .aggregate([
      { $match: { status: 'ok' } },
      {
        $group: {
          _id: '$reward_token',
          sends: { $sum: 1 },
          totalUi: { $sum: { $ifNull: ['$amount_ui', 0] } },
          recipients: { $addToSet: '$recipient' },
        },
      },
      { $project: { _id: 1, sends: 1, totalUi: 1, holders: { $size: '$recipients' } } },
    ])
    .toArray();
  const byToken = {};
  for (const r of rows) byToken[r._id] = { sends: r.sends, totalUi: r.totalUi, holders: r.holders };
  return byToken;
}

// Headline totals for the public rewards feed (GET /rewards): total reward tokens
// distributed, distinct wallets paid, and the number of distribution ROUNDS
// (distinct cycles that airdropped — one candle "drop" each), across all
// successful airdrops.
async function getRewardsSummary() {
  const db = getDb();
  const [row] = await db
    .collection('airdrops')
    .aggregate([
      { $match: { status: 'ok' } },
      {
        $group: {
          _id: null,
          distributed: { $sum: { $ifNull: ['$amount_ui', 0] } },
          recipients: { $addToSet: '$recipient' },
          rounds: { $addToSet: '$cycle_id' },
        },
      },
      {
        $project: {
          _id: 0,
          distributed: 1,
          holdersPaid: { $size: '$recipients' },
          drops: { $size: '$rounds' },
        },
      },
    ])
    .toArray();
  return row || { distributed: 0, holdersPaid: 0, drops: 0 };
}

// Total launched-token ($COP) burned across all cycles — the "Total $COP Burned"
// figure on the site's Doctrine tablet.
async function getTotalBurned() {
  const db = getDb();
  const [row] = await db
    .collection('cycles')
    .aggregate([{ $group: { _id: null, burned: { $sum: { $ifNull: ['$tokens_burned', 0] } } } }])
    .toArray();
  return row ? row.burned : 0;
}

// Recent successful airdrop payouts, newest first, for the public rewards feed.
// Only rows that actually landed (have a tx signature) are returned.
async function getRewardsFeed(limit) {
  const db = getDb();
  return db
    .collection('airdrops')
    .find({ status: 'ok', signature: { $ne: null } }, NO_ID)
    .sort({ id: -1 })
    .limit(limit)
    .toArray();
}

module.exports = {
  createCycle,
  finishCycle,
  addStep,
  getCycleWithSteps,
  getCycles,
  getLastCycle,
  getAllSteps,
  getStats,
  getLatestEligibleHolders,
  addAirdrop,
  getAirdrops,
  getAirdropTotals,
  getRewardsSummary,
  getRewardsFeed,
  getTotalBurned,
};
