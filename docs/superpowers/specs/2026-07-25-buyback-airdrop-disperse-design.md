# Buyback + holder airdrop (with disperse) for cult-of-pons

**Date:** 2026-07-25
**Status:** approved, implementing

## Goal

Extend the cult-of-pons claim→burn bot with a **buyback + holder airdrop** leg, and
add a **Disperse** fast path so rewards go out in one tx per batch. Ported and
adapted from the sibling projects `ozzyretard` and `swogebaby`, which target the
same chain (Robinhood Chain), launchpad (ponsfamily.com), and claim path.

## Decisions (confirmed with the user)

1. **Reward token:** a **separate** reward token (configured `REWARD_TOKEN`), not
   the launched token itself. Same model as the references (which buy PONS).
2. **Burn:** **kept.** Each claim still burns 100% of the launched-token-side fees
   to `dEaD`. The buyback is funded from the WETH side only.
3. **WETH split:** **80% buyback / 20% dev** (configurable via `REWARD_BUY_PCT`,
   default 80). The dev remainder stays as WETH in the wallet (as today); gas keeps
   topping up from it when native ETH runs low.
4. **Eligibility:** holders of the launched token above `MIN_HOLD`. Pure pro-rata
   (no per-wallet cap, no clusters wired to config — the distribution function
   still supports them as optional params).
5. **Disperse:** `DISPERSE_ADDRESS` defaults to the verified Robinhood Chain
   Disperse contract `0xDDB6A9b9E2D6C5636B444C0cDA907c9944c6cEC7`. One
   `disperseToken(token, recipients[], values[])` tx per batch. Pipelined
   per-transfer sending remains the fallback if the address is blanked.

## New cycle shape

```
every POLL_SCHEDULE, once pending WETH >= CLAIM_TRIGGER_ETH:
  1. gas top-up (live only)                                (unchanged)
  2. CLAIM creator fees -> WETH + launched token           (unchanged)
  3. BURN entire launched-token balance -> dEaD            (kept; now best-effort)
  4. REWARD LEG (REWARD_BUY_PCT% of the claimed WETH):
       a. snapshot eligible holders of the launched token (Blockscout)
       b. buy REWARD_TOKEN on Uniswap V3 with that WETH
       c. airdrop the bought reward tokens pro-rata:
            - disperseToken batches if DISPERSE_ADDRESS set
            - else pipelined sliding-window transfers
  5. dev remainder (the rest of the WETH) stays in the wallet
```

Ordering rationale: snapshot → buy → airdrop means a buy is never stranded with no
recipients. If there are no eligible holders or the holder snapshot fails, the buy
is skipped (WETH stays for next cycle) and the cycle still completes — the claim
and burn already succeeded. Burn is made best-effort so a burn failure cannot
strand the reward leg.

## New modules (ported from ozzyretard, adapted)

| File | Purpose |
|---|---|
| `src/services/fetchJson.js` | Retrying JSON GET (Blockscout 5xx/429/520) |
| `src/services/distribution.js` | Pure weighted pro-rata allocation (BigInt, exact via largest-remainder) |
| `src/evm/send.js` | Nonce-safe `sendTx` (stale-nonce retry on RH's load-balanced RPC) |
| `src/evm/holders.js` | Holder snapshot via Blockscout `/api/v2/tokens/{token}/holders` |
| `src/evm/exclude.js` | Exclude set: wallet, dead, **auto-discovered** locker+pool, reward token, extras |
| `src/evm/reward.js` | Buy `REWARD_TOKEN` with WETH via SwapRouter02 `exactInputSingle`; amount = balance delta |
| `src/evm/airdrop.js` | Disperse fast path + pipelined fallback; records every recipient |

Adaptation note: `exclude.js` uses cult-of-pons's `getLaunchInfo()` (auto-discovery
of locker + pool) instead of the references' hardcoded `PONS_LOCKER`/`PONS_FACTORY`.

## Config additions (`src/config.js` + `.env.example`)

```
SWAP_ROUTER        0xCaf681a66D020601342297493863E78C959E5cb2
REWARD_TOKEN       (required for live buyback) / REWARD_SYMBOL / REWARD_POOL_FEE=10000
REWARD_BUY_PCT     80        # % of each claim -> buyback+airdrop (rest = dev)
SLIPPAGE_PCT       5
MIN_HOLD           100000    # min launched-token balance to qualify
DISPERSE_ADDRESS   0xDDB6A9b9E2D6C5636B444C0cDA907c9944c6cEC7
AIRDROP_BATCH_SIZE 300       # recipients per disperse tx (or max pipelined in flight)
AIRDROP_GAS_LIMIT  120000    # fixed gas per pipelined transfer
AIRDROP_EXCLUDE    (csv)
```

## Persistence + API

- New `airdrops` collection + `repo.addAirdrop`/`getAirdrops`/`getAirdropTotals`
  (one row per recipient — partial failures visible/retriable).
- Cycle rows gain `eth_spent_buy`, `tokens_bought`, `eligible_holders`,
  `total_holders`; `finishCycle` allowed-fields list extended.
- `buy` + `airdrop` steps flow into the existing `/activity` feed and SSE stream.
- `/stats` + `/status` gain reward totals (`totalRewardBought`, `totalAirdropped`,
  `eligibleHolders`).

## Testing

Port + adapt reference unit tests for each new module (`fetchJson`, `distribution`,
`send`, `holders`, `exclude`, `reward`, `airdrop`) and extend `cycle.test.js` to
cover the new reward leg. All run under the existing in-memory MongoDB / `node --test`.
```
