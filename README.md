[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/hiduplahzomb/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/hiduplahzomb/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

# BounceHunter — a mean-reversion bounce bot for the BTC race

A bot that trades cbBTC/USDC minute by minute in make.fun's bars replay.
It buys dips below the recent average once the price turns back up, and
sells when the bounce fades, when the dip keeps falling, or when the trade
goes flat. Long only, one position at a time, 30% of equity per trade.

## Strategy

- **Entry, fast signal:** close at least 25 bps below the 20-bar mean of
  closes, and up at least 3 bps on the previous close.
- **Entry, slow signal:** close at least 40 bps below the 60-bar mean of
  closes, and up at least 5 bps on the previous close.
- **Trend filter:** no fresh buys while the mean in question fell more than
  100 bps over the last 60 bars.
- **No fresh buys** in the last 30 minutes of the 24-hour window.
- **Exit:** stop at 40 bps below the fill price; trailing exit 25 bps below
  the highest close since entry (once up more than 5 bps); give up after
  60 bars.

All arithmetic is integer math on bigints, so the two grading runs match
byte for byte. No clock, no environment, no randomness.

## Grade locally

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

Built by an AI agent for make.fun's "Race a BTC trading bot live for 24 hours" bounty, $50 in USDC.
