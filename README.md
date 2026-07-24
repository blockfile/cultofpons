# cult of pons

**Claim and burn bot for ponsfamily.com tokens on Robinhood Chain (EVM).**

Once the creator fees reach 0.01 WETH, claim them from the Pons locker and burn
the claimed tokens — no buyback, the claimed WETH stays with the wallet:

```
every POLL_SCHEDULE (default */5), once pending fees ≥ CLAIM_TRIGGER_ETH (default 0.01 WETH):
  claim the creator fees from the PonsLaunchLocker   (arrive as WETH + the token)
    → BURN the wallet's ENTIRE token balance: the claimed token fees
      + any residue                        (send to 0x…dEaD — gone forever)
    → the claimed WETH stays with the wallet (dev income; no buyback)
```

While the pending fees are below the trigger, the cycle is skipped and retried
on the following tick, so fees simply accumulate until a claim is worth the gas.

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
the token side is burned in full, the WETH side is yours to keep.

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

## Config

| Env | Default | Meaning |
|---|---|---|
| `CLAIM_TRIGGER_ETH` | `0.01` | claim + burn once this much creator WETH is pending in the locker |
| `POLL_SCHEDULE` | `*/5 * * * *` | how often the scheduler ticks (every 5 min) |
| `DEAD_ADDRESS` | `0x…dEaD` | burn sink for the claimed tokens |
| `GAS_RESERVE_ETH` | `0.005` | native ETH floor for gas (auto topped-up from claimed WETH) |
| `LOCKER_ADDRESS` | *(auto)* | override for the PonsLaunchLocker; blank = read it off the token's launch factory |

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
   `MONGODB_URI`, set `DRY_RUN=false`. Keep a little native ETH in the wallet
   for gas.
3. `node scripts/check.js` — read-only preflight (verifies the launch wiring,
   that THIS wallet may claim, and the pending fees).
4. Test the legs (`--confirm` to send):
   - `node scripts/claim.js --confirm` — claim the creator fees from the locker
   - `node scripts/burn.js --confirm` — burn the wallet's token balance. **Verify
     on the explorer that the tokens landed at the dead address.**
5. `node scripts/run-once.js --confirm` — one full claim → burn cycle, then
   `npm start` for the scheduled loop.

## Scripts

| Script | What it does |
|---|---|
| `scripts/check.js` | Read-only preflight: config, RPC/chain, launch wiring, claim rights, pending fees |
| `scripts/claim.js` | Claim the creator fees from the locker (`--confirm` to send; preview otherwise) |
| `scripts/burn.js` | Burn the wallet's entire token balance (`--confirm` to send; preview otherwise) |
| `scripts/run-once.js` | One full claim → burn cycle (`--confirm`) |

## API

Storage (MongoDB), the Express API (`/activity`, `/stats`, `/summary`,
`/accrual`, `/countdown`, `/api/*`, SSE stream) and the scheduler are shared
infra. `/api/unclaimed` reports the creator WETH still pending in the locker —
the progress toward the next claim + burn. `/stats` serves a frontend-ready
shape: `{ marketCap, totalBurned, pendingEth, burnTriggerEth }` (with
`buybackEth`/`buybackTarget` kept as aliases for SoftieClone-style progress
bars).
