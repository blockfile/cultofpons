'use strict';

require('dotenv').config();

const { Wallet } = require('ethers');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const DRY_RUN = bool(process.env.DRY_RUN, true);

// ── Reward split (of each WETH claim) ────────────────────────────────────────
// REWARD_BUY_PCT of each claim buys the reward token and airdrops it to holders;
// the remainder (dev cut) stays in the wallet as WETH (gas tops up from it).
const rewardBuyPct = num(process.env.REWARD_BUY_PCT, 80);
if (rewardBuyPct < 0 || rewardBuyPct > 100) {
  throw new Error(`invalid split: REWARD_BUY_PCT(${rewardBuyPct}) must be within [0, 100]`);
}
const devPct = +(100 - rewardBuyPct).toFixed(6);

// ── Trigger mode ─────────────────────────────────────────────────────────────
// 'interval'     → every POLL_SCHEDULE tick, claim whatever creator fees have
//                  accrued (skip only when nothing is pending). Default: a claim
//                  every 5 minutes.
// 'accumulation' → wait until the pending creator WETH reaches CLAIM_TRIGGER_ETH
//                  before claiming, so a tiny claim doesn't cost more gas than it
//                  earns.
const triggerMode = ['interval', 'accumulation'].includes(
  String(process.env.TRIGGER_MODE || 'interval').toLowerCase()
)
  ? String(process.env.TRIGGER_MODE || 'interval').toLowerCase()
  : 'interval';

/**
 * Load the signing wallet (0x-prefixed hex private key). It MUST be the wallet
 * that DEPLOYED the token on ponsfamily.com — the locker only lets the token's
 * deployer (or its fee-redirect target) call collectFees, so any other wallet
 * cannot claim the creator fees. In DRY_RUN with no key configured, an
 * ephemeral wallet is generated so the server runs out of the box.
 */
function loadWallet() {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    if (!DRY_RUN) {
      throw new Error('WALLET_PRIVATE_KEY is required when DRY_RUN=false');
    }
    return { wallet: Wallet.createRandom(), ephemeral: true };
  }
  try {
    const key = raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`;
    return { wallet: new Wallet(key), ephemeral: false };
  } catch (err) {
    throw new Error(`Could not parse WALLET_PRIVATE_KEY: ${err.message}`);
  }
}

const { wallet, ephemeral: walletIsEphemeral } = loadWallet();

const lowerOrNull = (v) => (v ? String(v).trim().toLowerCase() : null);

const config = {
  port: num(process.env.PORT, 3000),
  dryRun: DRY_RUN,

  // Robinhood Chain mainnet defaults.
  rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: num(process.env.CHAIN_ID, 4663),
  explorerApi: (process.env.EXPLORER_API || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),

  wallet,
  walletIsEphemeral,

  // Pons launchpad infra (ponsfamily.com) on Robinhood Chain. A launch pairs the
  // token with WETH in a Uniswap V3 pool and locks the LP position in the
  // PonsLaunchLocker; the creator's share of the pool's trading fees is claimed
  // from the locker via collectFees(token). The pool + fee tier are read straight
  // off the token contract at runtime (see src/evm/pons.js).
  weth: lowerOrNull(process.env.WETH_ADDRESS) || '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  // PonsLaunchLocker override. Leave unset (null) to auto-discover the locker
  // from the token's launchFactory().locker() at runtime — factory deployments
  // change, and claiming against the wrong locker silently never pays.
  locker: lowerOrNull(process.env.LOCKER_ADDRESS) || null,

  // Your ponsfamily.com token. The creator share of its locked-LP trading fees
  // arrives as WETH + the token itself; the token side is burned, the WETH
  // stays with the wallet.
  tokenAddress: lowerOrNull(process.env.TOKEN_ADDRESS),
  tokenSymbol: process.env.TOKEN_SYMBOL || 'BOP',

  // ── Buyback + airdrop (Uniswap V3) ───────────────────────────────────────
  // After the token-side fees are burned, REWARD_BUY_PCT of each WETH claim buys
  // this REWARD_TOKEN on its V3 pool (via SWAP_ROUTER at REWARD_POOL_FEE) and
  // airdrops it pro-rata to the launched token's holders. The buy spends WETH
  // directly (no unwrap); the amount received is measured from the balance delta.
  swapRouter: lowerOrNull(process.env.SWAP_ROUTER) || '0xcaf681a66d020601342297493863e78c959e5cb2',
  rewardToken: lowerOrNull(process.env.REWARD_TOKEN),
  rewardSymbol: process.env.REWARD_SYMBOL || 'PONS',
  rewardPoolFee: num(process.env.REWARD_POOL_FEE, 10000),
  rewardBuyPct, // % of each claim → buyback + airdrop (rest = dev, kept as WETH)
  devPct,
  slippagePct: num(process.env.SLIPPAGE_PCT, 5), // buyback (WETH→reward) slippage, percent

  // ── Airdrop (reward token → launched-token holders) ──────────────────────
  minHold: num(process.env.MIN_HOLD, 100000), // min launched-token balance to qualify
  // The verified Disperse contract on Robinhood Chain — one disperseToken tx pays a
  // whole batch of recipients. Blank it to fall back to pipelined ERC-20 transfers.
  disperseAddress: lowerOrNull(process.env.DISPERSE_ADDRESS) || '0xddb6a9b9e2d6c5636b444c0cda907c9944c6cec7',
  airdropBatchSize: num(process.env.AIRDROP_BATCH_SIZE, 300), // recipients per disperse tx / max pipelined in flight
  airdropGasLimit: num(process.env.AIRDROP_GAS_LIMIT, 120000), // fixed gas per pipelined transfer
  // Extra owner addresses excluded from airdrops (treasury, CEX, etc.), comma-separated.
  airdropExclude: (process.env.AIRDROP_EXCLUDE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ── Claim → burn loop ────────────────────────────────────────────────────
  // Every POLL_SCHEDULE, once the creator WETH pending in the locker reaches
  // CLAIM_TRIGGER_ETH, claim the fees (WETH + tokens) and BURN the wallet's
  // entire token balance (send to DEAD_ADDRESS — gone forever). There is NO
  // buyback: all claimed WETH stays with the wallet.
  claimTriggerEth: num(process.env.CLAIM_TRIGGER_ETH, 0.01),
  gasReserveEth: num(process.env.GAS_RESERVE_ETH, 0.005), // native ETH floor for gas; topped up by unwrapping WETH
  // Burn sink for the claimed tokens. Default is the canonical EVM dead address.
  deadAddress: lowerOrNull(process.env.DEAD_ADDRESS) || '0x000000000000000000000000000000000000dead',

  // Trigger — the scheduler ticks on this timer (default every 5 minutes). In
  // 'interval' mode (default) every tick claims whatever has accrued; in
  // 'accumulation' mode a tick only fires once the pending creator WETH reaches
  // CLAIM_TRIGGER_ETH.
  triggerMode,
  pollSchedule: process.env.POLL_SCHEDULE || '*/5 * * * *',
  // DRY_RUN only: simulated creator fees accrued per tick, so cycles have
  // something to claim without real rewards.
  dryRunFeePerPoll: num(process.env.DRY_RUN_FEE_PER_POLL, 0.01), // WETH side
  dryRunTokenFeePerPoll: num(process.env.DRY_RUN_TOKEN_FEE_PER_POLL, 25000), // token side

  // DexScreener chain slug for /stats market data (graceful nulls until listed).
  dexscreenerChainId: process.env.DEXSCREENER_CHAIN_ID || 'robinhood',

  // Frontend rewards feed (GET /rewards): how long the UI shows the "distributing"
  // state after each drop fires (display only — matches the site's candle animation).
  rewardsDistributingMs: num(process.env.REWARDS_DISTRIBUTING_MS, 9000),

  // Storage (MongoDB)
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGODB_DB || 'bop',

  // CORS allowlist (comma-separated). Default: localhost dev origins. Set to your
  // frontend domain(s) in production, or "*" to allow any origin.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Secret protecting the POST control endpoints. Blank = open (dev); set in prod.
  apiKey: process.env.API_KEY || null,
};

module.exports = config;
