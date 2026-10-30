const wait = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** Delay after `fails` consecutive failed rounds: interval doubled per failure, capped at maxBackoff. */
export const backoff = (fails, intervalMs, maxBackoffMs) => (fails ? Math.min(intervalMs * 2 ** fails, maxBackoffMs) : intervalMs);

/**
 * Runs `tick` every interval until `signal` aborts (or `rounds` are done). A failing round is logged and
 * retried with exponential backoff instead of killing the daemon; one success resets the delay.
 */
export async function loop(tick, { intervalMs = 60_000, maxBackoffMs = 15 * 60_000, rounds = Infinity, signal, log = () => {}, sleep = wait } = {}) {
  let fails = 0, round = 0;
  const stats = { ok: 0, failed: 0 };
  while (!signal?.aborted && round < rounds) {
    round++;
    const started = Date.now();
    try {
      await tick(round);
      fails = 0; stats.ok++;
      log(`round ${round} done in ${Date.now() - started} ms`, { event: 'round.ok', round, ms: Date.now() - started });
    } catch (e) {
      fails++; stats.failed++;
      log(`round ${round} failed (${fails} in a row): ${e.shortMessage || e.message}`, { event: 'round.error', level: 'error', round, fails, error: e.shortMessage || e.message, retryInMs: backoff(fails, intervalMs, maxBackoffMs) });
    }
    if (round < rounds && !signal?.aborted) await sleep(backoff(fails, intervalMs, maxBackoffMs), signal);
  }
  return stats;
}
