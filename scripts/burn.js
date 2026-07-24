'use strict';

// Test the burn leg in isolation: send the wallet's ENTIRE balance of the token
// (claimed fees + any residue) to the dead address.
//   node scripts/burn.js [--confirm]
//
// Without --confirm this only PREVIEWS the balance that would be burned.
// Verify on the explorer afterwards that the tokens landed at DEAD_ADDRESS.
const { formatUnits } = require('ethers');
const { config, wallet, hr, requireConfirm } = require('./_util');
const { readTokenBalance, getDecimals } = require('../src/evm/erc20');
const { burnToken } = require('../src/evm/burn');

(async () => {
  hr('BURN WALLET TOKEN BALANCE');
  if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS is required');

  const balRaw = await readTokenBalance(config.tokenAddress, wallet.address);
  const decimals = await getDecimals(config.tokenAddress);
  const bal = Number(formatUnits(balRaw, decimals));
  console.log(`wallet holds: ${bal} ${config.tokenSymbol}`);
  if (balRaw <= 0n) {
    console.log('nothing to burn — claim first (node scripts/claim.js)');
    process.exit(0);
  }

  if (!(await requireConfirm(`BURN ${bal} ${config.tokenSymbol} → ${config.deadAddress}`))) {
    process.exit(0);
  }

  const burn = await burnToken(config.tokenAddress, balRaw.toString());
  console.log('burned:', JSON.stringify(burn, null, 2));
  console.log(`\n✅ verify on the explorer that ${burn.burned} tokens are held by ${config.deadAddress}`);
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});
