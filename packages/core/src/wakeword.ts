// Step 24: wake word. The detector model (openWakeWord / Porcupine) gives a score per audio frame.
// This gate decides when a score really means "wake up", so one noisy frame does not trigger it.

export interface WakeGateOptions {
  threshold?: number; // score needed, 0..1
  consecutive?: number; // frames in a row above the threshold
  cooldownMs?: number; // ignore wakes right after one
}

export class WakeGate {
  private readonly threshold: number;
  private readonly consecutive: number;
  private readonly cooldownMs: number;
  private streak = 0;
  private lastWake = Number.NEGATIVE_INFINITY;

  constructor(opts: WakeGateOptions = {}) {
    this.threshold = opts.threshold ?? 0.5;
    this.consecutive = opts.consecutive ?? 2;
    this.cooldownMs = opts.cooldownMs ?? 3000;
    if (this.threshold <= 0 || this.threshold > 1) throw new RangeError('threshold must be in (0, 1]');
    if (!Number.isInteger(this.consecutive) || this.consecutive < 1) throw new RangeError('consecutive must be >= 1');
  }

  /** Feed one frame score. Returns true exactly when the assistant should wake. */
  feed(score: number, nowMs: number): boolean {
    if (nowMs - this.lastWake < this.cooldownMs) {
      this.streak = 0;
      return false;
    }
    this.streak = score >= this.threshold ? this.streak + 1 : 0;
    if (this.streak >= this.consecutive) {
      this.streak = 0;
      this.lastWake = nowMs;
      return true;
    }
    return false;
  }
}

/**
 * Removes the wake phrase from what was heard, so the AI gets the request only.
 * Returns null when no wake phrase was said (hands-free listening should ignore it).
 */
export function stripWake(heard: string, phrases: readonly string[]): string | null {
  const text = heard.trim();
  const lower = text.toLowerCase();
  let best: { at: number; len: number } | null = null;
  for (const phrase of phrases) {
    const p = phrase.trim().toLowerCase();
    if (!p) continue;
    const at = lower.indexOf(p);
    if (at !== -1 && (best === null || at < best.at)) best = { at, len: p.length };
  }
  if (best === null) return null;
  const rest = text.slice(best.at + best.len).replace(/^[\s,.!?:;-]+/, '').trim();
  return rest.length > 0 ? rest : null;
}

/** Phrases to listen for, built from the names the user chose ("Hey Nova"). */
export function wakePhrases(aiNames: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of aiNames) {
    const name = raw.trim().toLowerCase();
    if (name) out.add(`hey ${name}`);
  }
  return [...out];
}
