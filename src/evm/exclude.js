'use strict';

// Build the set of owner addresses excluded from the reward airdrop: the
// operating wallet, the dead address, the auto-discovered PonsLaunchLocker and
// the launched token's V3 pool (both read from getLaunchInfo() in live mode),
// the reward token contract itself, plus any AIRDROP_EXCLUDE extras. All
// lowercased for case-insensitive matching.

const config = require('../config');
const { wallet } = require('./provider');
const { getLaunchInfo } = require('./pons');

async function buildExcludeSet(token = config.tokenAddress) {
  const set = new Set();
  const add = (a) => {
    if (a) set.add(String(a).toLowerCase());
  };

  add(wallet.address);
  add(config.deadAddress);
  // The reward token contract itself is the payout asset, not a holder.
  add(config.rewardToken);
  for (const a of config.airdropExclude) add(a);

  // The launch wiring (locker + pool) holds the token as reserves — never real
  // holders. Auto-discovered off the token; skip quietly if unavailable.
  if (!config.dryRun && token) {
    try {
      const info = await getLaunchInfo(token);
      add(info.locker);
      add(info.pool);
    } catch (_err) {
      // launch wiring unavailable — skip
    }
  }
  return set;
}

module.exports = { buildExcludeSet };
