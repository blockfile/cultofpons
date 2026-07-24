'use strict';

const cron = require('node-cron');
const config = require('../config');
const { runCycle } = require('./cycle');
const { getPendingCreatorFees, simulateFeeAccrual } = require('../evm/pons');
const { getEthPriceUsd } = require('../evm/price');
const bus = require('../events');

const state = {
  task: null,
  paused: false,
  isRunning: false,
  lastRunAt: null,
  lastResult: null, // { id, status }
  lastClaimable: null,
  lastClaimableUsd: null,
  startedAt: null,
};

/**
 * One timer tick (every POLL_SCHEDULE, default 5 minutes). Advances the simulated
 * fee accrual (DRY_RUN only), reads the creator WETH pending in the locker, and
 * runs a claim → burn cycle once it reaches CLAIM_TRIGGER_ETH. Skips silently
 * (no cycle row) otherwise. Overlap-guarded.
 * @param {string} trigger 'poll' | 'manual'
 * @returns {Promise<{ran:boolean, claimable?:number, claimableUsd?:number, reason?:string, cycle?:object}>}
 */
async function pollOnce(trigger) {
  if (state.paused) return { ran: false, reason: 'paused' };
  if (state.isRunning) {
    console.log(`[scheduler] ${trigger} tick ignored — a cycle is already running`);
    return { ran: false, reason: 'cycle already running' };
  }

  // Hold the run flag through the balance/price reads too — a manual
  // POST /api/run landing between these awaits and the cycle start must not
  // spawn a second concurrent cycle (wallet-nonce contention in live mode).
  state.isRunning = true;
  try {
    simulateFeeAccrual(); // no-op in live mode
    const pending = await getPendingCreatorFees();
    state.lastClaimable = pending.weth;

    // The ETH price is display-only (USD equivalents on the frontend).
    const price = await getEthPriceUsd();
    const claimableUsd = price == null ? null : +(pending.weth * price).toFixed(2);
    state.lastClaimableUsd = claimableUsd;

    // Gate the cycle. In 'interval' mode we claim whatever has accrued each tick
    // (skip only when nothing is pending); in 'accumulation' mode we wait until
    // the pending WETH reaches the trigger so a claim is worth the gas.
    const belowTrigger =
      config.triggerMode === 'accumulation'
        ? pending.weth < config.claimTriggerEth
        : pending.weth <= 0;
    if (belowTrigger) {
      const reason =
        config.triggerMode === 'accumulation'
          ? `pending fees below trigger (${+pending.weth.toFixed(9)} < ${config.claimTriggerEth} WETH)`
          : 'nothing pending to claim';
      return { ran: false, claimable: pending.weth, claimableUsd, reason };
    }

    state.lastRunAt = new Date().toISOString();
    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    return { ran: true, claimable: pending.weth, claimableUsd, cycle };
  } finally {
    state.isRunning = false;
  }
}

function start() {
  if (state.task) return;
  if (!cron.validate(config.pollSchedule)) {
    throw new Error(`Invalid POLL_SCHEDULE: ${config.pollSchedule}`);
  }
  state.startedAt = new Date().toISOString();
  state.task = cron.schedule(config.pollSchedule, () => {
    pollOnce('poll').catch((err) => console.error('[scheduler] poll error:', err));
  });
  const gate =
    config.triggerMode === 'accumulation'
      ? `once ${config.claimTriggerEth} WETH of fees is pending`
      : 'whatever fees have accrued';
  console.log(
    `[scheduler] started — claims ${gate} on schedule "${config.pollSchedule}" (mode=${config.triggerMode}, dryRun=${config.dryRun})`
  );
}

function pause() {
  state.paused = true;
  const s = getState();
  bus.emit('scheduler', s);
  return s;
}

function resume() {
  state.paused = false;
  const s = getState();
  bus.emit('scheduler', s);
  return s;
}

/** Manual trigger from the API — forces a cycle immediately, off-schedule. */
async function triggerNow() {
  if (state.isRunning) return { skipped: true, reason: 'cycle already running' };
  state.isRunning = true;
  state.lastRunAt = new Date().toISOString();
  try {
    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    return cycle;
  } finally {
    state.isRunning = false;
  }
}

function getState() {
  return {
    pollSchedule: config.pollSchedule,
    claimTriggerEth: config.claimTriggerEth,
    paused: state.paused,
    isRunning: state.isRunning,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
    lastClaimable: state.lastClaimable,
    lastClaimableUsd: state.lastClaimableUsd,
    startedAt: state.startedAt,
  };
}

module.exports = { start, pause, resume, triggerNow, pollOnce, getState };
