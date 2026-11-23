// BounceHunter: a mean-reversion bounce bot for the make.fun BTC race.
//
// The idea, in words: cbBTC's one-minute price spends most of its time
// wiggling within a few basis points of its recent average, and every so
// often it dips clearly below that average and then turns back up. This bot
// buys those dips once the turn is confirmed, and sells when the bounce
// fades, when the dip keeps falling, or when the trade goes flat.
//
// Entry (either signal fires):
//   - Fast: the close is at least 40 bps below the 20-bar mean of closes,
//     and the close is up at least 3 bps on the previous close (a real
//     bounce, not a one-tick uptick).
//   - Slow: the close is at least 40 bps below the 60-bar mean of closes,
//     and the close is up at least 5 bps on the previous close.
//   - Trend filter: no fresh buys while the mean in question fell more
//     than 100 bps over the last 60 bars (a falling knife is not a bounce).
//   - No fresh buys in the last 30 minutes of the 24-hour window: a trade
//     opened there has no time to play out and the forced flatten at the
//     end eats the round-trip cost for nothing.
//
// Exit (from the actual fill price, not the decision price):
//   - Stop: the close falls 40 bps below the fill price — cut the loss.
//   - Trailing: once the trade is up more than 5 bps, sell when the close
//     retraces 35 bps from the highest close seen since entry — let the
//     winners run, then take them when the bounce fades.
//   - Stale: 60 bars after the fill with no exit — give up on a flat trade.
//
// Sizing: each buy spends 50% of equity. A stopped trade then costs about
// 20 bps of equity, so several consecutive small losses cannot wipe out the
// capital. A full round trip costs roughly 20 bps at this size (4 bps fee
// plus 2 bps modelled slippage plus a few bps of pool impact each way), so
// the bot only trades dips whose expected bounce comfortably exceeds that.
//
// Tuning (23 Nov, on the new dev window, verified with the real grader):
// the first version used a 25 bps fast dip, a 25 bps trail and 30% sizing
// and made only +$0.99 on this window (17 trades, 44% wins). A parameter
// sweep found three robust improvements: a deeper 40 bps dip requirement
// (fewer, higher-quality entries — 8 trades, 75% wins at 30% sizing),
// a looser 35 bps trail (lets winners run instead of banking noise), and
// 50% sizing (the edge per trade is positive, so size scales it; PnL rises
// smoothly 30% -> +$4.38, 40% -> +$5.46, 50% -> +$6.35, 60% -> +$7.05).
// Final: +$6.35 net on the new window. Perturbation checks (+-20% on each
// changed value) all stay clearly profitable (+$2.03 to +$4.92), and the
// tuned bot also profits on the previous race's down-day window (+$2.46),
// so the tuning is a plateau, not a spike fitted to one day.
//
// Determinism: every number here is integer math on bigints. The bot never
// reads the wall clock, the environment, or any randomness. Time is the bar
// time in each batch only.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

// ---- strategy parameters (basis points unless noted) ----
const FAST_MA_BARS = 20;
const SLOW_MA_BARS = 60;
const FAST_DIP_BPS = 40n;
const FAST_BOUNCE_BPS = 3n;
const SLOW_DIP_BPS = 40n;
const SLOW_BOUNCE_BPS = 5n;
const TREND_LOOKBACK_BARS = 60;
const TREND_MAX_FALL_BPS = 100n;
const STOP_BPS = 40n;
const TRAIL_BPS = 35n;
const TRAIL_MIN_GAIN_BPS = 5n;
const MAX_HOLD_BARS = 60;
const SIZE_BPS = 5000n;
const NO_BUY_AFTER_MINUTES = 1410;
const MAX_SLIPPAGE_BPS = 100;
const BPS = 10000n;

interface Memory {
  symbol: string;
  firstCloseMs: number;
  closes: bigint[];
  fastMa: (bigint | null)[];
  slowMa: (bigint | null)[];
  entryPrice: bigint | null;
  entrySeq: number;
  peakClose: bigint | null;
}

function meanOf(closes: bigint[], n: number): bigint | null {
  if (closes.length < n) return null;
  let sum = 0n;
  for (let i = closes.length - n; i < closes.length; i++) {
    const c = closes[i];
    if (c !== undefined) sum += c;
  }
  return sum / BigInt(n);
}

/** True unless the mean fell steeply over the lookback (a falling knife). */
function trendOk(history: (bigint | null)[], idx: number): boolean {
  if (idx < TREND_LOOKBACK_BARS) return true;
  const now = history[idx];
  const then = history[idx - TREND_LOOKBACK_BARS];
  if (now == null || then == null || then === 0n) return true;
  const slopeBps = ((now - then) * BPS) / then;
  return slopeBps >= -TREND_MAX_FALL_BPS;
}

const mem: Memory = {
  symbol: '',
  firstCloseMs: 0,
  closes: [],
  fastMa: [],
  slowMa: [],
  entryPrice: null,
  entrySeq: -1,
  peakClose: null,
};

await runBars({
  onHello(state: BarsState): void {
    const first = state.hello.symbols[0];
    mem.symbol = first !== undefined ? first.symbol : 'CBBTC';
    mem.firstCloseMs = state.hello.first_close_ms;
  },

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Track fills first: a buy fill sets the entry price, a sell fill ends it.
    for (const fill of batch.fills) {
      if (fill.symbol !== mem.symbol) continue;
      if (fill.side === 'buy' && fill.status === 'filled') {
        mem.entryPrice = BigInt(fill.price);
        mem.entrySeq = state.seq;
        mem.peakClose = mem.entryPrice;
      }
    }

    // Fold the new bar into the close history (some minutes have no bar).
    for (const bar of batch.bars) {
      if (bar.symbol !== mem.symbol) continue;
      mem.closes.push(BigInt(bar.c));
      mem.fastMa.push(meanOf(mem.closes, FAST_MA_BARS));
      mem.slowMa.push(meanOf(mem.closes, SLOW_MA_BARS));
    }

    // Reconcile the entry bookkeeping with the account the harness reports.
    const pos = state.positions.get(mem.symbol);
    const holding = pos !== undefined && pos.qty > 0n;
    if (!holding) {
      mem.entryPrice = null;
      mem.entrySeq = -1;
      mem.peakClose = null;
    } else if (mem.entryPrice === null && pos !== undefined) {
      // Fallback if a fill record was missed: derive the average entry
      // price from the position's cost basis (fees included).
      const sym = state.symbols.get(mem.symbol);
      if (sym !== undefined && pos.qty > 0n) {
        const scale = 10n ** BigInt(sym.qty_scale + sym.price_scale);
        const quote = 10n ** BigInt(state.hello.capital.quote_scale);
        mem.entryPrice = (pos.cost * scale) / (pos.qty * quote);
        mem.entrySeq = state.seq;
        mem.peakClose = mem.entryPrice;
      }
    }

    if (state.warmingUp) return [];
    const close = state.close(mem.symbol);
    if (close === null) return [];

    if (!holding) {
      return maybeBuy(state);
    }
    return maybeSell(state, close);
  },
});

function maybeBuy(state: BarsState): OrderInput[] {
  const idx = mem.closes.length - 1;
  if (idx < 1) return [];
  const close = mem.closes[idx];
  const prevClose = mem.closes[idx - 1];
  if (close === undefined || prevClose === undefined || prevClose === 0n) return [];

  // No fresh buys in the last 30 minutes of the window.
  const elapsedMin = Math.floor((state.t - mem.firstCloseMs) / 60000);
  if (elapsedMin >= NO_BUY_AFTER_MINUTES) return [];

  const bounceBps = ((close - prevClose) * BPS) / prevClose;

  let signal = false;
  const fast = mem.fastMa[idx];
  if (fast != null && fast !== 0n) {
    const dipBps = ((fast - close) * BPS) / fast;
    if (dipBps >= FAST_DIP_BPS && bounceBps >= FAST_BOUNCE_BPS && trendOk(mem.fastMa, idx)) {
      signal = true;
    }
  }
  if (!signal) {
    const slow = mem.slowMa[idx];
    if (slow != null && slow !== 0n) {
      const dipBps = ((slow - close) * BPS) / slow;
      if (dipBps >= SLOW_DIP_BPS && bounceBps >= SLOW_BOUNCE_BPS && trendOk(mem.slowMa, idx)) {
        signal = true;
      }
    }
  }
  if (!signal) return [];

  const notional = (state.equity * SIZE_BPS) / BPS;
  const spend = notional < state.cash ? notional : state.cash;
  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  if (spend < minNotional) return [];
  return [
    {
      side: 'buy',
      symbol: mem.symbol,
      notional_quote_units: spend,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    },
  ];
}

function maybeSell(state: BarsState, close: bigint): OrderInput[] {
  if (mem.entryPrice === null) return [];
  if (mem.peakClose === null || close > mem.peakClose) {
    mem.peakClose = close;
  }
  const entry = mem.entryPrice;
  const gainBps = ((close - entry) * BPS) / entry;

  // Each exit is checked on its own: a trade that is in profit must still
  // be given up on after MAX_HOLD_BARS, even when it has not retraced
  // enough to trip the trailing exit. (Chaining these as else-if let a
  // profitable-but-flat trade run past its hold limit.)
  let sell = false;
  if (gainBps <= -STOP_BPS) {
    sell = true; // stop: the dip kept falling, cut the loss
  }
  if (!sell && mem.peakClose > entry && gainBps > TRAIL_MIN_GAIN_BPS) {
    const retraceBps = ((mem.peakClose - close) * BPS) / mem.peakClose;
    if (retraceBps >= TRAIL_BPS) sell = true; // trailing: the bounce faded
  }
  if (!sell && mem.entrySeq >= 0 && state.seq - mem.entrySeq >= MAX_HOLD_BARS) {
    sell = true; // stale: a flat trade that never went anywhere
  }
  if (!sell) return [];

  const pos = state.positions.get(mem.symbol);
  if (pos === undefined || pos.qty <= 0n) return [];
  return [
    {
      side: 'sell',
      symbol: mem.symbol,
      qty: pos.qty,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    },
  ];
}
