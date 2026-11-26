# Speed changes (v6.1)

- Telegram no longer blocks the transfer (sent after, not before)
- Removed extra round-trips on the hot path: getBlockNumber, RPC health probe, duplicate getBalance
- Fee data + network nonce cached in the background every block; gasLimit fixed 21000 for EOA destination
- Transaction signed locally and broadcast to ALL RPCs in parallel (first accept wins)
- Mempool monitor ON by default and drives a PRE-SIGNED sweep fired the moment the block arrives
  (falls back to the normal path automatically if anything does not match)
- Optional PRIORITY_FEE_GWEI

Not tested on a live network. Test on Sepolia first. Keep your own .env (add ENABLE_MEMPOOL_MONITOR=true).
Primary RPC must be wss://.

# tools/rescue-usdc.js
Gasless USDC rescue via EIP-3009 (see header of the file). Not tested on a live network - use DRY_RUN=true first.

# v6.2 - dust minimization
- The plain-ETH sweep (destination is a wallet, fixed 21000 gas) now uses the exact current
  base fee + a small configurable headroom (FEE_HEADROOM_PERCENT, default 20%) instead of the
  generic ~2x estimate, and drops the extra safety buffer (not needed: gas usage is fixed).
  This leaves much less ETH behind after each transfer.
- Trade-off: if the base fee jumps more than the headroom in one block (rare), the transfer
  is not included immediately; the bot's existing Replace-by-Fee logic bumps it automatically
  after ~180s. Exactly zero leftover ETH is not possible under EIP-1559 without this risk.
- Mock-tested the fee math; not tested on a live network.

# v6.3 - two detection-reliability bugs fixed
1. Silent 429 swallowing: checkBalance() and the polling loop used to fully ignore
   "Too Many Requests" errors (no log, no error counter). If the RPC rate-limited the bot
   (easy to hit now that the mempool monitor uses up to 50 req/s by default), every deposit
   check could silently fail forever with zero trace. Now: still skips that single check
   (the next block retries automatically, so nothing is force-failed), but logs after the
   1st/5th/10th consecutive 429 and sends a Telegram alert at 10 in a row so it is never silent.
2. No watchdog for a WebSocket that dies WITHOUT firing 'close' or 'error' (a known real-world
   failure mode - TCP reset, idle-proxy timeout). Previously the whole detection pipeline relied
   100% on the 'block' event continuing to fire, with nothing checking whether it actually did.
   Added a watchdog (WATCHDOG_STALL_MS, default 45s): if no block arrives for that long, it
   force-closes the socket and reconnects through the existing recovery path, instead of waiting
   forever for an event that may never come.
Both confirmed by code review + mock tests of the exact logic branches; not run against a live,
actually-rate-limited or actually-stalled RPC.
