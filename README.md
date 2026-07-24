# cult of pons

**Claim → burn → buyback + airdrop bot for ponsfamily.com tokens on Robinhood Chain (EVM).**

Once the creator fees reach 0.01 WETH, claim them from the Pons locker, burn the
claimed tokens, then spend most of the claimed WETH buying a reward token and
airdrop it to holders:

```
every POLL_SCHEDULE (default */5), once pending fees ≥ CLAIM_TRIGGER_ETH (default 0.01 WETH):
  claim the creator fees from the PonsLaunchLocker   (arrive as WETH + the token)
    → BURN the wallet's ENTIRE token balance: the claimed token fees
      + any residue                        (send to 0x…dEaD — gone forever)
    → BUYBACK: spend REWARD_BUY_PCT (default 80%) of the claimed WETH buying
      REWARD_TOKEN on Uniswap V3, then AIRDROP it pro-rata to the token's
      holders (one disperseToken tx per batch — fast)
    → the remaining WETH (dev cut) stays with the wallet
```

While the pending fees are below the trigger, the cycle is skipped and retried
on the following tick, so fees simply accumulate until a claim is worth the gas.
The buyback + airdrop is best-effort: if there are no eligible holders or the
buy can't fill, that leg is skipped and the WETH waits for the next cycle — the
claim and burn still stand.

Everything runs in `DRY_RUN=true` by default — all on-chain calls are simulated
and no funds are ever touched until you flip it off.

## What "burn" means here

Each cycle the bot sends the dev wallet's **entire balance of the token** — the
token-side fees each claim delivers, plus any residue left over from earlier
cycles — to the **dead address** (`0x…dEaD`). The dead address has no private
key, so those tokens can never move again — they're permanently out of
circulation and show up as burned on the explorer.

## How the funding works (verified on-chain)

A ponsfamily.com launch (`PonsLaunchFactory`) mints a **fixed-supply, tax-free
ERC-20** (`PonsLauncherToken`) straight into a **Uniswap V3 pool** paired with
WETH (1% fee tier) and locks the LP position NFT in the **PonsLaunchLocker**.
The pool's trading fees accrue to that locked position **in both tokens**
(WETH + your token).

The token's **deployer wallet** claims the creator share by calling
`collectFees(token)` on the locker (the locker keeps a protocol cut — 10% at
the time of writing — and pays the rest out). So the operating wallet **must be
the wallet that deployed the token** on ponsfamily.com; no other wallet is
allowed to claim. Claimed fees land as **WETH (ERC-20) + the token itself**:
the token side is burned in full; `REWARD_BUY_PCT` of the WETH side funds the
buyback + holder airdrop, and the remaining WETH (dev cut) is yours to keep.

Gas is still paid in native ETH — the bot tops the gas reserve back up by
unwrapping a little of the claimed WETH whenever the native balance runs low.

### Robinhood Chain reference (defaults in `.env.example`)

| What | Value |
|---|---|
| Chain ID | 4663 |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| Reward currency | WETH + the token (claimed from the locker by the deployer) |
| PonsLaunchLocker (claim path) | auto-discovered from the token's `launchFactory().locker()` (force via `LOCKER_ADDRESS`) |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

The token's V3 pool and pair token are read straight off the token contract
(`liquidityPool()`, `pairToken()`), so `TOKEN_ADDRESS` is the only per-token
setting.

## Buyback + airdrop

After the token-side fees are burned, `REWARD_BUY_PCT` (default **80%**) of the
claimed WETH buys `REWARD_TOKEN` on its Uniswap V3 pool (via `SWAP_ROUTER` at
`REWARD_POOL_FEE`) and the bot airdrops it **pro-rata to the launched token's
holders**. The holder set is snapshotted from Blockscout each cycle; anyone below
`MIN_HOLD` — plus the operating wallet, the dead address, the locker and the
token's own V3 pool — is excluded. Only what was bought **this** cycle is
distributed (measured from the wallet's balance delta), never a holder's own bag.

**Disperse (the fast path):** with `DISPERSE_ADDRESS` set (default: the verified
Robinhood Chain Disperse contract), each batch of up to `AIRDROP_BATCH_SIZE`
holders is paid in **one `disperseToken` transaction** instead of one transfer
each — ~100× fewer txs. The reward token is auto-approved to the disperse
contract on first use. Blank `DISPERSE_ADDRESS` to fall back to pipelined
per-transfer sends (a sliding window of `AIRDROP_BATCH_SIZE` txs in flight, local
nonce — still fast and stall-free). Every recipient is recorded in the `airdrops`
collection, so partial failures are visible and retriable.

## Config

| Env | Default | Meaning |
|---|---|---|
| `CLAIM_TRIGGER_ETH` | `0.01` | claim once this much creator WETH is pending in the locker |
| `POLL_SCHEDULE` | `*/5 * * * *` | how often the scheduler ticks (every 5 min) |
| `DEAD_ADDRESS` | `0x…dEaD` | burn sink for the claimed tokens |
| `GAS_RESERVE_ETH` | `0.005` | native ETH floor for gas (auto topped-up from claimed WETH) |
| `LOCKER_ADDRESS` | *(auto)* | override for the PonsLaunchLocker; blank = read it off the token's launch factory |
| `REWARD_TOKEN` | *(none)* | token bought with the WETH and airdropped to holders (**required live**) |
| `REWARD_SYMBOL` | `PONS` | display symbol for the reward token |
| `REWARD_POOL_FEE` | `10000` | reward token's Uniswap V3 fee tier (10000 = 1%) |
| `REWARD_BUY_PCT` | `80` | % of each claim spent on the buyback + airdrop (rest = dev cut) |
| `SWAP_ROUTER` | *(RH V3)* | Uniswap V3 SwapRouter02 used for the buyback |
| `SLIPPAGE_PCT` | `5` | buyback (WETH→reward) slippage tolerance |
| `MIN_HOLD` | `100000` | min launched-token balance to qualify for the airdrop |
| `DISPERSE_ADDRESS` | *(RH Disperse)* | batch-transfer contract; blank = pipelined per-transfer sends |
| `AIRDROP_BATCH_SIZE` | `300` | recipients per disperse tx (or max pipelined txs in flight) |
| `AIRDROP_EXCLUDE` | *(none)* | extra owner addresses excluded from airdrops, comma-separated |

## Quick start

```bash
npm install
cp .env.example .env       # defaults are safe: DRY_RUN=true, ephemeral wallet
npm start                  # needs a local MongoDB (or set MONGODB_URI)
npm test                   # unit + integration tests (in-memory MongoDB)
```

## Going live

1. Deploy your token on **ponsfamily.com** from the wallet the bot will run
   with — the locker only pays creator fees to the token's **deployer**.
2. Fill `.env`: `WALLET_PRIVATE_KEY` (the deployer wallet), `TOKEN_ADDRESS`,
   `REWARD_TOKEN` (the token to buy + airdrop), `MONGODB_URI`, set
   `DRY_RUN=false`. Keep a little native ETH in the wallet for gas. The default
   `DISPERSE_ADDRESS` is the verified Robinhood Chain Disperse contract — leave
   it as-is for the fast airdrop, or blank it for pipelined transfers.
3. `node scripts/check.js` — read-only preflight (verifies the launch wiring,
   that THIS wallet may claim, and the pending fees).
4. Test the legs (`--confirm` to send):
   - `node scripts/claim.js --confirm` — claim the creator fees from the locker
   - `node scripts/burn.js --confirm` — burn the wallet's token balance. **Verify
     on the explorer that the tokens landed at the dead address.**
5. `node scripts/run-once.js --confirm` — one full claim → burn → buyback +
   airdrop cycle, then `npm start` for the scheduled loop.

## Scripts

| Script | What it does |
|---|---|
| `scripts/check.js` | Read-only preflight: config, RPC/chain, launch wiring, claim rights, pending fees |
| `scripts/claim.js` | Claim the creator fees from the locker (`--confirm` to send; preview otherwise) |
| `scripts/burn.js` | Burn the wallet's entire token balance (`--confirm` to send; preview otherwise) |
| `scripts/run-once.js` | One full claim → burn → buyback + airdrop cycle (`--confirm`) |

## API

Storage (MongoDB), the Express API (`/activity`, `/stats`, `/summary`,
`/accrual`, `/countdown`, `/api/*`, SSE stream) and the scheduler are shared
infra. `/api/unclaimed` reports the creator WETH still pending in the locker —
the progress toward the next claim. `GET /api/airdrops` lists the reward payouts
(one row per recipient), and `buy`/`airdrop` events stream live over
`/api/stream`. `/stats` serves a frontend-ready shape: `{ marketCap,
totalBurned, pendingEth, burnTriggerEth, totalRewardBought, totalAirdropped,
eligibleHolders }` (with `buybackEth`/`buybackTarget` kept as aliases for
SoftieClone-style progress bars).
