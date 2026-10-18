// Activity log: one line per event in a JSON-lines file that is only ever appended to.
// Nothing is rewritten or removed, so a family admin can still see what happened after
// something was deleted. Secrets are never written: text is cut short and keys are masked.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type ActivityKind =
  | 'request' // someone asked for something
  | 'action' // a tool ran (status says how it went)
  | 'approval' // a request was approved, rejected or is waiting
  | 'rule' // a family rule fired (warning, limit reached)
  | 'safety' // stop, resume, take-over, AI Mode changes
  | 'memory' // remembered or deleted something
  | 'stream'; // chat moderation, stream events

export type ActivityStatus = 'info' | 'waiting' | 'done' | 'verified' | 'failed' | 'blocked';

export interface ActivityEntry {
  at: number;
  kind: ActivityKind;
  status: ActivityStatus;
  actor: string;
  text: string;
}

const MAX_TEXT = 300;
const READ_TAIL_BYTES = 256 * 1024;

/** Masks things that look like keys or tokens, so they never land in the log. */
export function redact(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|oauth:[A-Za-z0-9]{8,})/g, '[hidden]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[hidden]');
}

export class ActivityLog {
  private recentCache: ActivityEntry[] = [];
  private listeners = new Set<(e: ActivityEntry) => void>();

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(file), { recursive: true });
    this.recentCache = this.readTail(200);
  }

  add(kind: ActivityKind, status: ActivityStatus, actor: string, text: string): ActivityEntry {
    const entry: ActivityEntry = { at: this.now(), kind, status, actor: actor.slice(0, 60), text: redact(text).slice(0, MAX_TEXT) };
    try {
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // A full disk must not crash the bot; the entry still shows in this session.
    }
    this.recentCache.push(entry);
    if (this.recentCache.length > 200) this.recentCache.splice(0, this.recentCache.length - 200);
    for (const l of this.listeners) l(entry);
    return entry;
  }

  recent(limit = 50): ActivityEntry[] {
    return this.recentCache.slice(-limit).reverse();
  }

  onEntry(listener: (e: ActivityEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reads only the end of the file, so a log that grew for years still opens fast. */
  private readTail(limit: number): ActivityEntry[] {
    if (!existsSync(this.file)) return [];
    try {
      const size = statSync(this.file).size;
      const text = readFileSync(this.file, 'utf8');
      const tail = size > READ_TAIL_BYTES ? text.slice(-READ_TAIL_BYTES) : text;
      const out: ActivityEntry[] = [];
      for (const line of tail.split('\n')) {
        try {
          const e = JSON.parse(line) as ActivityEntry;
          if (typeof e.at === 'number' && typeof e.text === 'string') out.push(e);
        } catch {
          // skip a broken or cut-off line
        }
      }
      return out.slice(-limit);
    } catch {
      return [];
    }
  }
}
