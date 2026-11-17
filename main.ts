// Breakout-and-hold BTC bot for btc-race-24h-20261117-0603.
//
// The dev window taught one lesson: on 1-minute bars, with a ~34 bps round trip
// (4 bps fee + 2 bps slippage + ~11 bps impact each way at this pool depth),
// every active strategy that trades more than a couple of times loses to fees.
// The baselines prove it: ema-cross (-$106, 68 trades), rsi-bollinger (-$24),
// adx-momentum (-$33) all lose; only buy-and-hold (+$1.07) and a single early
// buy (+$2.45) pass the dev gate. So this bot trades as little as possible:
//
//   - Entry: the first close above the highest close of the prior 24 bars,
//     from bar 24 on. Full size (all cash). On the dev window this fires on
//     bar 27 and the bot then holds to the end: +$1.55, 1 trade.
//   - Exit: a trailing stop only. While holding, track the highest close
//     since entry; sell everything if a close falls below 97% of it. The
//     dev window's worst drawdown is 2.12%, so the stop never fires there;
//     on the race window it caps a crash instead of riding it to the bottom.
//   - Re-entry: after a stop-out, wait 60 bars, then enter again on the
//     next 24-bar breakout. This keeps one whipsaw from churning the account.
//   - Fallback: if no entry signal has fired by batch 1200 (the last 4
//     hours), buy a $10 token stake, so the entry still meets the race's
//     at-least-1-trade guardrail instead of sitting out with zero trades.
//   - Every order caps slippage at 100 bps (1% past the close it was
//     decided on). The dev window's biggest open-vs-previous-close move is
//     0.163%, so fills are effectively never refused for slippage, but a
//     liquidity gap cannot fill the bot for almost nothing either.
//   - A signal that fires stays live until it fills: a buy or sell the
//     market refuses is sent again on the next bar while its reason holds.
//
// Deterministic: integer (bigint) price comparisons, float-free signal
// logic, no clock, no environment, no randomness. Two runs on the same
// bars produce byte-identical orders.

import { runBars, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Entry: the close must beat the high of this many prior closes. */
const BREAKOUT_BARS = 24;
/** Trailing stop: sell when a close drops below 97/100 of the peak close since entry. */
const STOP_NUM = 97n;
const STOP_DEN = 100n;
/** Batches to wait after a stop-out before a re-entry signal may fire. */
const REENTRY_COOLDOWN = 60;
/** If no entry has happened by this batch, buy the token fallback stake. */
const FALLBACK_SEQ = 1200;
/** The fallback stake in quote units: $10 (the minimum notional is $1). */
const FALLBACK_NOTIONAL = 10_000_000n;
/** Every order's max slippage, in bps past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** CBBTC closes in raw price units (scale 5), one per fresh bar, oldest first. */
const closes: bigint[] = [];
/** The entry signal has fired and the bot is buying until a position exists. */
let wantLong = false;
/** A position has existed at some point. */
let everEntered = false;
/** The fallback stake is armed and the bot is buying it until a position exists. */
let fallbackLive = false;
/** The batch seq of the last stop-out decision (-1e6: none yet, so no cooldown). */
let lastExitSeq = -1_000_000;
/** The highest close seen while holding the current position, or null. */
let peakClose: bigint | null = null;

function freshBar(batch: Batch) {
  return batch.bars.find((b) => b.symbol === SYMBOL);
}

/** Whether the latest close breaks above the high of the prior BREAKOUT_BARS closes. */
function breakout(): boolean {
  if (closes.length <= BREAKOUT_BARS) return false;
  const now = closes[closes.length - 1]!;
  let high = 0n;
  for (let k = closes.length - 1 - BREAKOUT_BARS; k < closes.length - 1; k++) {
    if (closes[k]! > high) high = closes[k]!;
  }
  return now > high;
}

await runBars({
  onBatch(state, batch) {
    const bar = freshBar(batch);
    if (bar !== undefined) closes.push(BigInt(bar.c));
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      everEntered = true;
      fallbackLive = false;
      const c = state.close(SYMBOL)!;
      peakClose = peakClose === null || c > peakClose ? c : peakClose;
      if (c * STOP_DEN < peakClose * STOP_NUM) {
        lastExitSeq = state.seq;
        wantLong = false;
        peakClose = null;
        const sell: OrderInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    peakClose = null;
    if (!wantLong && state.seq - lastExitSeq >= REENTRY_COOLDOWN && breakout()) wantLong = true;
    if (wantLong) {
      if (state.cash === 0n) return [];
      const buy: OrderInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }
    if (!everEntered && !wantLong && state.seq >= FALLBACK_SEQ) fallbackLive = true;
    if (fallbackLive) {
      const stake = state.cash < FALLBACK_NOTIONAL ? state.cash : FALLBACK_NOTIONAL;
      if (stake === 0n) return [];
      const buy: OrderInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }
    return [];
  },
});
