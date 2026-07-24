'use strict';

// GET /rewards — the public "Tithe" feed for the $COP site (src/rewards/vigil.jsx).
// Maps the backend's real airdrop history to the frontend's expected shape:
//   { rewardSymbol, intervalMs, distributingMs, nextDropAt, explorerTxUrl,
//     totals: { marketCap, distributed, holdersPaid, drops }, drops: [...] }
// Mounted at BOTH "/" and "/api" so it works whether VITE_API_BASE_URL is the
// bare host (…/rewards) or the "/api" default (…/api/rewards).

const express = require('express');
const config = require('../config');
const repo = require('../db/repository');
const { getMarketData } = require('../services/marketdata');
const { nextRun } = require('../services/countdown');
const { toRewardsPayload } = require('../services/format');

const router = express.Router();

// Tiny in-memory TTL cache (the feed polls ~every drop; this de-dupes bursts).
function cached(ttlMs, fn) {
  let value;
  let expires = 0;
  let inflight = null;
  return async () => {
    if (Date.now() < expires) return value;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        value = await fn();
        expires = Date.now() + ttlMs;
        return value;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

const loadRewards = cached(3000, async () => {
  const [summary, feed, market] = await Promise.all([
    repo.getRewardsSummary(),
    repo.getRewardsFeed(300), // a few hundred rows; the client pages the rest
    getMarketData().catch(() => ({ marketCap: null })),
  ]);
  const { nextAirdropAt, intervalSec } = nextRun(config.pollSchedule, Date.now());
  return toRewardsPayload({
    symbol: config.rewardSymbol,
    intervalSec,
    nextDropAt: nextAirdropAt, // authoritative epoch ms — every visitor's candle agrees
    explorerTxUrl: `${config.explorerApi}/tx/`,
    distributingMs: config.rewardsDistributingMs,
    market,
    summary,
    feed,
  });
});

router.get('/rewards', async (req, res, next) => {
  try {
    res.json(await loadRewards());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
