'use strict';

const { toUsd } = require('../evm/price');
const config = require('../config');

const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || 'TOKEN';

// The cycle emits these step types: claim, burn (+ error). The `buy` mapping is
// kept for old rows only. Map a stored step to the activity-row shape the
// dashboard renders.
function toActivityRow(s, price) {
  const d = s.detail || {};
  let type;
  let amountEth = null;
  let tokens = null;
  let status = 'Completed';

  switch (s.name) {
    case 'claim':
      type = 'Auto Claim';
      amountEth = d.ethClaimed ?? null;
      status = 'Claimed';
      break;
    case 'buy':
      type = 'Buy';
      amountEth = d.ethSpent ?? null;
      tokens = d.tokensBought ?? null;
      break;
    case 'burn':
      type = 'Burn';
      tokens = d.tokensBurned ?? null;
      status = 'Burned';
      break;
    case 'airdrop':
      type = 'Airdrop';
      tokens = d.sent ?? null; // recipients paid this cycle
      status = 'Airdropped';
      break;
    default:
      type = s.name;
  }
  if (s.status === 'failed') status = 'Failed';

  return {
    id: s.id ?? null,
    cycleId: s.cycle_id,
    type,
    rawType: s.name,
    amountEth,
    usdValue: toUsd(amountEth, price),
    tokens,
    status,
    txHash: s.signature ?? null,
    at: s.created_at,
  };
}

// ── Public (frontend-facing) shapes ──────────────────────────────────────────

// rawType (stored step name) -> the frontend's lowercase activity enum.
const PUBLIC_TYPE = {
  claim: 'claim',
  buy: 'buy',
  burn: 'burn',
  airdrop: 'airdrop',
};

// Map a stored step to the ActivityRow shape the frontend table renders.
// Caller passes steps newest-first (repo.getAllSteps already sorts desc).
function toPublicActivityRow(s, price) {
  const d = s.detail || {};

  let amountEth = null;
  let tokens = null;
  let status = 'completed';
  switch (s.name) {
    case 'claim':
      amountEth = d.ethClaimed ?? null;
      status = 'claimed';
      break;
    case 'buy':
      amountEth = d.ethSpent ?? null;
      tokens = d.tokensBought ?? null;
      break;
    case 'burn':
      tokens = d.tokensBurned ?? null;
      status = 'burned';
      break;
    case 'airdrop':
      tokens = d.sent ?? null; // recipients paid this cycle
      status = 'airdropped';
      break;
    default:
      break;
  }
  if (s.status === 'failed') status = 'failed';

  return {
    id: s.id != null ? String(s.id) : s.signature ?? null,
    type: PUBLIC_TYPE[s.name] ?? s.name,
    amountEth,
    // usdtValue MUST be a number — the frontend table calls .toLocaleString()
    // on it with no null guard.
    usdtValue: toUsd(amountEth, price) ?? 0,
    tokens,
    status,
    txHash: s.signature ?? null,
    timestamp: Date.parse(s.created_at) || null, // ISO -> epoch ms
  };
}

// Map the backend aggregates to the frontend's flat /stats object. tokenInLp and
// marketCap have no backend source until the token is listed -> null.
// A SoftieClone-style hero reads { marketCap, totalBurned, buybackEth,
// buybackTarget }; bop has no buyback, so those last two are kept as ALIASES of
// the honest fields (pendingEth / burnTriggerEth) — the progress bar then shows
// fees accruing toward the next claim+burn.
function toPublicStats({ stats, unclaimedEth, operatingWallet, market = {}, airdropTotals = {}, eligibleHolders = null, rewardSymbol = null }) {
  const pendingEth = unclaimedEth == null ? 0 : +unclaimedEth.toFixed(9);
  const air = Object.values(airdropTotals);
  const totalAirdropped = air.reduce((s, t) => s + (t.totalUi || 0), 0);
  const airdropSends = air.reduce((s, t) => s + (t.sends || 0), 0);
  return {
    tokenInLp: market.tokenInLp ?? null, // tokens in the LP (DexScreener); null until listed
    marketCap: market.marketCap ?? null, // USD market cap (DexScreener); null until listed
    totalBurned: stats.total_tokens_burned || 0, // hero "Total Burned" card
    // Progress toward the next claim+burn: creator WETH pending in the locker
    // vs the claim trigger (0.01 ETH).
    pendingEth,
    burnTriggerEth: config.claimTriggerEth,
    buybackEth: pendingEth, // alias for SoftieClone-style frontends
    buybackTarget: config.claimTriggerEth, // alias for SoftieClone-style frontends
    unclaimedFeesEth: unclaimedEth == null ? null : +unclaimedEth.toFixed(9),
    totalCreatorFeesClaimed: stats.total_eth_claimed,
    tokensBurned: stats.total_tokens_burned || 0,
    burns: stats.burns || 0,
    // Buyback + airdrop totals.
    rewardSymbol: rewardSymbol ?? config.rewardSymbol,
    totalRewardSpentEth: stats.total_eth_spent_buy || 0, // WETH spent buying the reward token
    totalRewardBought: stats.total_tokens_bought || 0, // reward tokens bought
    totalAirdropped, // reward tokens sent to holders
    airdropSends, // successful airdrop payouts
    eligibleHolders, // current wallets ≥ MIN_HOLD (latest snapshot)
    // The signer that performs claim/burn/buyback.
    operatingWallet: operatingWallet ?? null,
  };
}

// The rewards-available card payload (used by /api/unclaimed and the SSE stream).
// `unclaimedEth` is the creator WETH still pending in the locker; the
// claimThreshold* fields carry the claim trigger.
function buildUnclaimedPayload(eth, price) {
  return {
    unclaimedEth: eth == null ? null : +eth.toFixed(9),
    unclaimedUsd: toUsd(eth, price),
    ethPriceUsd: price,
    claimThresholdEth: config.claimTriggerEth,
    claimThresholdUsd: toUsd(config.claimTriggerEth, price),
  };
}

// Headline numbers for the frontend hero.
function toPublicSummary({ stats, price, marketCapUsd = null, airdropTotals = {}, eligibleHolders = null }) {
  const claimedEth = stats.total_eth_claimed || 0;
  const totalAirdropped = Object.values(airdropTotals).reduce((s, t) => s + (t.totalUi || 0), 0);
  return {
    creatorFeesClaimedEth: claimedEth,
    creatorFeesClaimedUsd: +(claimedEth * (price || 0)).toFixed(2),
    marketCapUsd: marketCapUsd ?? null,
    // claim-and-burn totals
    tokensBurned: stats.total_tokens_burned || 0,
    burns: stats.burns || 0,
    cycles: stats.completed || 0,
    // buyback + airdrop totals
    rewardSymbol: config.rewardSymbol,
    rewardTokensBought: stats.total_tokens_bought || 0,
    tokensAirdropped: totalAirdropped,
    eligibleHolders,
  };
}

// ── Public rewards feed (GET /rewards, for the $COP site's "Tithe") ──────────

// Compact USD display string, e.g. 4_280_000 → "$4.28M". Null/NaN → "—".
function compactUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(2)}K`;
  return `${sign}$${a.toFixed(2)}`;
}

const intComma = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const money2 = (n) =>
  (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// One airdrop DB row → one rewards-feed "drop". Carries a unique `id` (the
// airdrop row id) IN ADDITION to `tx`: with the disperse contract a whole batch
// of recipients shares ONE tx hash, so the frontend must key/dedupe on `id`, not
// `tx` (tx stays the real, explorer-linkable hash).
function toRewardDrop(a) {
  return {
    id: a.id != null ? String(a.id) : a.signature ?? null,
    wallet: a.recipient,
    amount: money2(a.amount_ui),
    at: Date.parse(a.created_at) || null, // epoch ms
    tx: a.signature ?? null,
  };
}

// Build the GET /rewards payload the frontend's vigil feed expects. All display
// numbers are preformatted strings; drops are newest-first.
function toRewardsPayload({
  symbol,
  intervalSec,
  nextDropAt,
  explorerTxUrl,
  distributingMs,
  market = {},
  summary = {},
  burned = 0,
  feed = [],
}) {
  return {
    rewardSymbol: symbol,
    intervalMs: (Number(intervalSec) || 0) * 1000,
    distributingMs,
    nextDropAt,
    explorerTxUrl,
    totals: {
      marketCap: compactUsd(market.marketCap ?? null),
      distributed: intComma(summary.distributed || 0),
      burned: intComma(burned || 0), // total $COP burned — Doctrine tablet only
      holdersPaid: intComma(summary.holdersPaid || 0),
      drops: intComma(summary.drops || 0),
    },
    drops: feed.map(toRewardDrop),
  };
}

module.exports = {
  toActivityRow,
  toPublicActivityRow,
  toPublicStats,
  toPublicSummary,
  buildUnclaimedPayload,
  compactUsd,
  toRewardDrop,
  toRewardsPayload,
  TOKEN_SYMBOL,
};
