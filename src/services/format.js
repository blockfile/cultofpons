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
function toPublicStats({ stats, unclaimedEth, operatingWallet, market = {} }) {
  const pendingEth = unclaimedEth == null ? 0 : +unclaimedEth.toFixed(9);
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
    // The signer that performs claim/burn.
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
function toPublicSummary({ stats, price, marketCapUsd = null }) {
  const claimedEth = stats.total_eth_claimed || 0;
  return {
    creatorFeesClaimedEth: claimedEth,
    creatorFeesClaimedUsd: +(claimedEth * (price || 0)).toFixed(2),
    marketCapUsd: marketCapUsd ?? null,
    // claim-and-burn totals
    tokensBurned: stats.total_tokens_burned || 0,
    burns: stats.burns || 0,
    cycles: stats.completed || 0,
  };
}

module.exports = {
  toActivityRow,
  toPublicActivityRow,
  toPublicStats,
  toPublicSummary,
  buildUnclaimedPayload,
  TOKEN_SYMBOL,
};
