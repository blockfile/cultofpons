'use strict';

const { parseEther, formatEther, formatUnits } = require('ethers');
const config = require('../config');
const repo = require('../db/repository');
const { burnToken } = require('../evm/burn');
const { getPendingCreatorFees, collectCreatorFees } = require('../evm/pons');
const { unwrapWeth, readTokenBalance, getDecimals } = require('../evm/erc20');
const { provider, wallet } = require('../evm/provider');
const simvault = require('../evm/simvault');
const { buildExcludeSet } = require('../evm/exclude');
const { snapshotEligibleHolders } = require('../evm/holders');
const { computeWeightedAllocations } = require('../services/distribution');
const { buyReward } = require('../evm/reward');
const { airdropToken } = require('../evm/airdrop');

/**
 * Reward leg: spend `ethAmount` (held as WETH) buying the reward token on
 * Uniswap V3, then airdrop it pro-rata to eligible holders of `holderToken`
 * (the launched token).
 *
 * The holder snapshot is taken ONCE, BEFORE the buy — so a buy is never stranded
 * with no one to send to. Only what was actually bought this cycle is distributed
 * (measured from the balance delta), never a holder's own balance.
 *
 * A failed snapshot or buy (no holders, no pool, revert) is recorded and skipped —
 * the cycle still finishes, since the claim + burn already happened.
 *
 * @returns {Promise<{sent, failed, eligibleHolders, totalHolders, bought}>}
 */
async function runRewardLeg(cycleId, { holderToken, ethAmount }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [reward] ${m}`);

  // Snapshot eligible holders once.
  const holderDecimals = config.dryRun ? 18 : await getDecimals(holderToken);
  const minHoldRaw = (BigInt(Math.trunc(config.minHold)) * 10n ** BigInt(holderDecimals)).toString();
  const exclude = await buildExcludeSet(holderToken);
  const { holders, totalHolders } = await snapshotEligibleHolders({ token: holderToken, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${config.minHold}) of ${totalHolders} total`);
  if (!holders.length) {
    log('no eligible holders — skipping the reward buy (nothing to airdrop to)');
    return { sent: 0, failed: 0, eligibleHolders: 0, totalHolders, bought: 0 };
  }

  const rewardWei = parseEther(String(ethAmount));
  const rewardDecimals = config.dryRun ? 18 : await getDecimals(config.rewardToken);
  log(`buying ${config.rewardSymbol} with ${ethAmount} WETH on V3`);

  // One buy funds the whole drop. On failure, record it and skip the airdrop.
  let buy;
  try {
    buy = await buyReward(rewardWei);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({
      cycleId,
      name: 'buy',
      status: 'failed',
      detail: { leg: 'reward', token: config.rewardToken, symbol: config.rewardSymbol, message },
    });
    log(`${config.rewardSymbol} buy SKIPPED — ${message}`);
    return { sent: 0, failed: 0, eligibleHolders: holders.length, totalHolders, bought: 0 };
  }

  const boughtUi = Number(formatUnits(buy.boughtRaw, rewardDecimals));
  await repo.addStep({
    cycleId,
    name: 'buy',
    status: 'ok',
    signature: buy.signature,
    detail: {
      leg: 'reward',
      token: config.rewardToken,
      symbol: config.rewardSymbol,
      ethSpent: Number(ethAmount),
      tokensBought: boughtUi,
    },
  });

  // Pure pro-rata by holdings (no cap, no clusters).
  const allocations = computeWeightedAllocations(holders, buy.boughtRaw.toString(), {
    capPct: null,
    supplyRaw: null,
    clusters: [],
  });
  const air = await airdropToken({ rewardToken: config.rewardToken, allocations, cycleId });
  await repo.addStep({
    cycleId,
    name: 'airdrop',
    status: air.failed ? 'failed' : 'ok',
    detail: {
      token: config.rewardToken,
      symbol: config.rewardSymbol,
      recipients: allocations.length,
      sent: air.sent,
      failed: air.failed,
    },
  });
  log(`${config.rewardSymbol}: bought ${boughtUi} → airdrop sent=${air.sent} failed=${air.failed}`);

  return { sent: air.sent, failed: air.failed, eligibleHolders: holders.length, totalHolders, bought: boughtUi };
}

/**
 * One claim → burn → buyback+airdrop cycle (fired by the scheduler once the
 * pending creator WETH reaches CLAIM_TRIGGER_ETH):
 *
 *   claim the creator share of the locked-LP trading fees from the
 *   PonsLaunchLocker (arrives as WETH + the launched token itself)
 *     → BURN the wallet's entire launched-token balance (→ DEAD_ADDRESS)
 *     → REWARD_BUY_PCT of the claimed WETH: buy REWARD_TOKEN on Uniswap V3 and
 *       airdrop it pro-rata to the launched token's holders
 *     → the remaining WETH (dev cut) stays with the wallet
 *
 * If the pending WETH hasn't reached the trigger yet, the cycle is skipped and
 * retried next tick, so fees simply accumulate until a claim is worth the gas.
 *
 * @returns {Promise<object>} the persisted cycle (with steps)
 */
async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (msg) => console.log(`[cycle ${id}] ${msg}`);

  try {
    if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS is required');

    // 1. Gate the cycle. In 'interval' mode (default) claim whatever has accrued
    //    each tick — skip only when nothing is pending. In 'accumulation' mode
    //    the pending creator WETH must reach CLAIM_TRIGGER_ETH first.
    const pending = await getPendingCreatorFees();
    const belowTrigger =
      config.triggerMode === 'accumulation'
        ? pending.weth < config.claimTriggerEth
        : pending.weth <= 0;
    if (belowTrigger) {
      const authNote =
        !config.dryRun && !pending.authorized && pending.error
          ? ` (claim probe reverted: ${pending.error} — is this wallet the token's deployer?)`
          : '';
      const note =
        config.triggerMode === 'accumulation'
          ? `pending fees below trigger: ${+pending.weth.toFixed(9)} WETH < ${config.claimTriggerEth}${authNote}`
          : `nothing pending to claim${authNote}`;
      await repo.finishCycle(id, { status: 'skipped', note });
      log(`skipped: ${note}`);
      return repo.getCycleWithSteps(id);
    }

    // 2. Keep gas alive (live only): fees arrive as WETH, but gas is paid in
    //    native ETH — top the reserve back up from WETH when it runs low.
    if (!config.dryRun) {
      const native = Number(formatEther(await provider.getBalance(wallet.address)));
      if (native < config.gasReserveEth / 2) {
        const unwrapped = await unwrapWeth(config.gasReserveEth);
        log(`gas top-up: unwrapped ${unwrapped} WETH (native was ${native.toFixed(6)} ETH)`);
      }
    }

    // 3. Claim the creator fees — WETH + launched tokens land in the wallet.
    const claim = await collectCreatorFees();
    await repo.addStep({
      cycleId: id,
      name: 'claim',
      status: 'ok',
      signature: claim.signature,
      detail: {
        ethClaimed: claim.wethClaimed,
        tokensClaimed: claim.tokensClaimed,
        tokensClaimedRaw: claim.tokensClaimedRaw,
      },
    });
    log(`claimed ${claim.wethClaimed} WETH + ${claim.tokensClaimed} ${config.tokenSymbol} from the locker`);

    // 4. Burn the wallet's ENTIRE launched-token balance: the token-side fees
    //    this claim delivered plus any residue from earlier cycles → dEaD.
    //    Best-effort: a burn failure must never strand the reward airdrop below.
    let burned = 0;
    let burnSig = null;
    let burnRaw;
    if (config.dryRun) {
      const t = simvault.takeTokens();
      burnRaw = BigInt(Math.round(t)) * 10n ** 18n;
    } else {
      burnRaw = await readTokenBalance(config.tokenAddress, wallet.address).catch(() => 0n);
    }
    if (burnRaw > 0n) {
      try {
        const burn = await burnToken(config.tokenAddress, burnRaw.toString());
        await repo.addStep({
          cycleId: id,
          name: 'burn',
          status: 'ok',
          signature: burn.signature,
          detail: { tokensBurned: burn.burned, burnedRaw: burn.burnedRaw, deadAddress: burn.deadAddress },
        });
        burned = burn.burned;
        burnSig = burn.signature;
        log(`burned ${burn.burned} ${config.tokenSymbol} (claimed fees + wallet residue) → ${burn.deadAddress}`);
      } catch (err) {
        await repo.addStep({ cycleId: id, name: 'burn', status: 'failed', detail: { message: err.message } });
        log(`burn ${config.tokenSymbol} failed (non-fatal): ${err.message}`);
      }
    }

    // 5. Reward leg — split REWARD_BUY_PCT of the claimed WETH to the buyback +
    //    holder airdrop; the remainder (dev cut) stays with the wallet as WETH.
    const rewardEth = +(claim.wethClaimed * (config.rewardBuyPct / 100)).toFixed(9);
    const devEth = +(claim.wethClaimed - rewardEth).toFixed(9);
    let reward = { sent: 0, failed: 0, eligibleHolders: 0, totalHolders: 0, bought: 0 };
    if (rewardEth > 0) {
      log(`split: ${rewardEth} → ${config.rewardSymbol} buyback (${config.rewardBuyPct}%), keep ${devEth} WETH for dev/gas`);
      reward = await runRewardLeg(id, { holderToken: config.tokenAddress, ethAmount: rewardEth });
    }

    // 6. Done. The dev remainder stays as WETH in the wallet.
    await repo.finishCycle(id, {
      status: 'complete',
      mode: 'claim-burn-reward',
      eth_claimed: claim.wethClaimed,
      eth_spent_buy: reward.bought > 0 ? rewardEth : 0,
      tokens_bought: reward.bought,
      tokens_burned: burned,
      eligible_holders: reward.eligibleHolders,
      total_holders: reward.totalHolders,
      burn_sig: burnSig,
      note: `burned ${burned} ${config.tokenSymbol}; bought ${reward.bought} ${config.rewardSymbol}, airdropped to ${reward.sent} (${reward.failed} failed); kept ${devEth} WETH`,
    });
    log(`complete (claim-burn-reward) — kept ${devEth} WETH for dev`);
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = { runCycle, runRewardLeg };
