// Run-time formatting (BRO-1610). Two shapes: a compact label for a finished
// turn ("24s" · "5m 24s" · "1h 03m") and a ticking clock for the live counter
// ("0:24" · "1:05" · "1:02:05"). Pure — unit-tested in duration.test.ts.

/** Compact run-time label for a completed turn. Undefined for missing/negative. */
export function formatDuration(ms: number | undefined | null): string | undefined {
  if (ms === undefined || ms === null || ms < 0 || !Number.isFinite(ms)) return undefined;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${pad(s)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${pad(m % 60)}m`;
}

/** Ticking clock for the live counter. Always shows at least m:ss. */
export function formatClock(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || ms < 0 || !Number.isFinite(ms)) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
