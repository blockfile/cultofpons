'use strict';

// Read-only preflight. Sends NO transactions. Verifies your config + on-chain state:
// RPC/chain, wallet balances, the token's launch wiring (V3 pool, WETH pair),
// the locker's pending creator fees (and whether THIS wallet may claim them).
//   node scripts/check.js
const { formatEther } = require('ethers');
const { config, provider, wallet, hr } = require('./_util');

(async () => {
  hr('CONFIG');
  console.log('dryRun     :', config.dryRun);
  console.log('rpcUrl     :', config.rpcUrl, `(chain ${config.chainId})`);
  console.log('wallet     :', wallet.address, config.walletIsEphemeral ? '⚠️ EPHEMERAL — set WALLET_PRIVATE_KEY' : '');
  console.log('token      :', config.tokenAddress || '⚠️ MISSING — set TOKEN_ADDRESS');
  console.log('claim/burn :', `claim + burn once ${config.claimTriggerEth} WETH of fees is pending (${config.pollSchedule})`);
  console.log('deadAddr   :', config.deadAddress, '(burn sink)');
  console.log('locker     :', config.locker || 'auto — discovered from the token\'s launchFactory()', '(PonsLaunchLocker — collectFees claims the creator fees)');
  console.log('weth       :', config.weth);
  console.log('buyback    :', `${config.rewardBuyPct}% of each claim → buy ${config.rewardSymbol} (${config.rewardToken || '⚠️ set REWARD_TOKEN'}) and airdrop to holders ≥ ${config.minHold}`);
  console.log('disperse   :', config.disperseAddress || 'off — pipelined per-transfer sends', `(batch ${config.airdropBatchSize})`);

  hr('RPC + WALLET BALANCES');
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== config.chainId) {
    console.log(`⚠️ RPC reports chain ${net.chainId}, expected ${config.chainId}`);
  } else {
    console.log('chainId    :', Number(net.chainId), '✓');
  }
  const wei = await provider.getBalance(wallet.address);
  console.log('ETH balance:', formatEther(wei), 'ETH (gas)');
  if (wei === 0n) console.log('⚠️ wallet has 0 ETH — fund it before any live test');

  if (!config.tokenAddress) {
    console.log('\nSet TOKEN_ADDRESS to run the remaining checks.');
    process.exit(0);
  }

  if (config.dryRun) {
    console.log('\n(DRY_RUN — on-chain reads are simulated; set DRY_RUN=false to check the real launch wiring)');
    console.log('\n✅ preflight complete (no transactions sent)');
    process.exit(0);
  }

  hr('PONS LAUNCH WIRING (read from the token)');
  const { getLaunchInfo, getPendingCreatorFees, lockerContract } = require('../src/evm/pons');
  const { getWethBalanceEth } = require('../src/evm/erc20');
  const info = await getLaunchInfo();
  console.log('V3 pool    :', info.pool, `(fee tier ${info.poolFee / 10000}%)`);
  console.log('locker     :', info.locker, config.locker ? '(LOCKER_ADDRESS override)' : '(auto-discovered from the launch factory ✓)');
  console.log('pairToken  :', info.pairToken, info.pairToken === config.weth ? '(WETH ✓)' : '⚠️ NOT the configured WETH');
  console.log('deployer   :', info.deployer, info.deployer === wallet.address.toLowerCase() ? '(this wallet ✓)' : '⚠️ NOT this wallet — only the deployer can claim the creator fees');
  try {
    const redirect = await lockerContract().feeRedirects(config.tokenAddress);
    const zero = '0x0000000000000000000000000000000000000000';
    if (redirect !== zero && redirect.toLowerCase() !== wallet.address.toLowerCase()) {
      console.log(`⚠️ feeRedirect is set to ${redirect} — claimed fees will land THERE, not in this wallet`);
    }
    const share = await lockerContract().tokenProtocolFeeShares(config.tokenAddress);
    console.log('protocolFee:', `${share}% kept by the locker; ${100n - share}% of LP fees is yours`);
  } catch (_e) { /* informational only */ }

  hr('CREATOR FEES');
  const wethBal = await getWethBalanceEth();
  console.log('wallet WETH:', wethBal, `(${config.rewardBuyPct}% of each claim funds the buyback; the rest is dev income)`);
  const pending = await getPendingCreatorFees();
  if (pending.authorized) {
    console.log('pending    :', pending.weth, 'WETH +', pending.tokens, `${config.tokenSymbol} claimable from the locker`);
    console.log('trigger    :', `claim + burn fires at ${config.claimTriggerEth} WETH pending`);
  } else {
    console.log('⚠️ collectFees probe reverted:', pending.error);
    console.log('             (either no fees have accrued yet, or this wallet is not allowed to claim)');
  }

  console.log('\n✅ preflight complete (no transactions sent)');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ check failed:', e.message);
  process.exit(1);
});
