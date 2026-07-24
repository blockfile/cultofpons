'use strict';

const { formatEther, formatUnits } = require('ethers');
const config = require('../config');
const repo = require('../db/repository');
const { burnToken } = require('../evm/burn');
const { getPendingCreatorFees, collectCreatorFees } = require('../evm/pons');
const { unwrapWeth, readTokenBalance, getDecimals } = require('../evm/erc20');
const { provider, wallet } = require('../evm/provider');
const simvault = require('../evm/simvault');

/**
 * One claim → burn cycle (fired by the scheduler once the pending creator WETH
 * reaches CLAIM_TRIGGER_ETH):
 *
 *   claim the creator share of the locked-LP trading fees from the
 *   PonsLaunchLocker (arrives as WETH + the token itself)
 *     → BURN the wallet's entire token balance: the claimed token-side fees
 *       PLUS any residue (→ DEAD_ADDRESS)
 *     → the claimed WETH stays with the wallet (no buyback)
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

    // 1. Check the trigger: the creator WETH pending in the locker must have
    //    reached CLAIM_TRIGGER_ETH before a claim is worth sending.
    const pending = await getPendingCreatorFees();
    if (pending.weth < config.claimTriggerEth) {
      const authNote =
        !config.dryRun && !pending.authorized && pending.error
          ? ` (claim probe reverted: ${pending.error} — is this wallet the token's deployer?)`
          : '';
      await repo.finishCycle(id, {
        status: 'skipped',
        note: `pending fees below trigger: ${+pending.weth.toFixed(9)} WETH < ${config.claimTriggerEth}${authNote}`,
      });
      log(`skipped: pending ${+pending.weth.toFixed(9)} < ${config.claimTriggerEth} WETH trigger`);
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

    // 3. Claim the creator fees — WETH + tokens land in the wallet.
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

    // 4. Burn the wallet's ENTIRE token balance: the token-side fees this claim
    //    delivered plus any residue from earlier cycles. ponsfamily claims pay
    //    tokens on every claim — all of it goes to dEaD. The claimed WETH is
    //    NOT touched (no buyback).
    let burnRaw;
    let tokensToBurn;
    if (config.dryRun) {
      const t = simvault.takeTokens();
      tokensToBurn = t;
      burnRaw = BigInt(Math.round(t)) * 10n ** 18n;
    } else {
      burnRaw = await readTokenBalance(config.tokenAddress, wallet.address);
      const decimals = await getDecimals(config.tokenAddress);
      tokensToBurn = Number(formatUnits(burnRaw, decimals));
    }

    if (burnRaw <= 0n) {
      await repo.finishCycle(id, {
        status: 'complete',
        mode: 'claim-burn',
        eth_claimed: claim.wethClaimed,
        tokens_burned: 0,
        note: 'claim delivered no tokens — nothing to burn this cycle',
      });
      log('complete (claimed WETH only — no tokens to burn)');
      return repo.getCycleWithSteps(id);
    }

    const burn = await burnToken(config.tokenAddress, burnRaw.toString());
    await repo.addStep({
      cycleId: id,
      name: 'burn',
      status: 'ok',
      signature: burn.signature,
      detail: {
        tokensBurned: burn.burned,
        burnedRaw: burn.burnedRaw,
        deadAddress: burn.deadAddress,
        fromClaimedFees: tokensToBurn,
      },
    });
    log(`burned ${burn.burned} ${config.tokenSymbol} (claimed fees + wallet residue) → ${burn.deadAddress}`);

    // 5. Done. The claimed WETH stays with the wallet.
    await repo.finishCycle(id, {
      status: 'complete',
      mode: 'claim-burn',
      eth_claimed: claim.wethClaimed,
      tokens_burned: burn.burned,
      burn_sig: burn.signature,
    });
    log(`complete (claim-burn) — kept ${claim.wethClaimed} WETH`);
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = { runCycle };
