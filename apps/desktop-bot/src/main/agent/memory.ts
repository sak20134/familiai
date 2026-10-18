// What the bot remembers, with Family AI's scopes enforced here in code (never by the model):
//   private - only the person who saved it, admins included
//   family  - everyone in the family (sensitive notes stay away from children and teens)
//   house   - facts about the home everyone may read
// Deleting moves the item to a vault that only admins can see, so nothing silently disappears.

import { canRead, canWrite, can, type MemoryItem, type MemoryScope } from '@familiai/core';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Actor } from './types';

interface Saved {
  items: MemoryItem[];
  vault: Array<MemoryItem & { deletedAt: number; deletedBy: string }>;
}

const MAX_ITEMS = 2000;
const MAX_TEXT = 500;

const member = (a: Actor) => ({ id: a.id, familyId: 'local', role: a.role });

/** Words worth matching on: lowercase, no tiny words. */
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9\u0080-￿]+/).filter((w) => w.length > 2));
}

export class MemoryStore {
  private data: Saved;
  private counter = 0;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(file), { recursive: true });
    this.data = this.read();
  }

  remember(actor: Actor, text: string, scope: MemoryScope = 'private'): MemoryItem {
    const clean = text.trim().slice(0, MAX_TEXT);
    if (!clean) throw new Error('There is nothing to remember.');
    if (!canWrite(member(actor), scope)) throw new Error(`${actor.name} can only save private notes.`);
    const item: MemoryItem = {
      id: `m${this.now().toString(36)}${(++this.counter).toString(36)}`,
      familyId: 'local',
      ownerId: actor.id,
      scope,
      text: clean,
      sensitivity: 'normal',
      source: actor.via,
      confidence: 1,
      createdAt: this.now(),
    };
    this.data.items.push(item);
    if (this.data.items.length > MAX_ITEMS) this.data.items.splice(0, this.data.items.length - MAX_ITEMS);
    this.save();
    return item;
  }

  /** Only what this person is allowed to read, best matches first. */
  recall(actor: Actor, query: string, limit = 8): MemoryItem[] {
    const readable = this.data.items.filter((i) => canRead(member(actor), i, this.now()));
    const q = words(query);
    if (q.size === 0) return readable.slice(-limit).reverse();
    return readable
      .map((i) => ({ i, score: [...words(i.text)].filter((w) => q.has(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.i.createdAt - a.i.createdAt)
      .slice(0, limit)
      .map((x) => x.i);
  }

  list(actor: Actor): MemoryItem[] {
    return this.data.items.filter((i) => canRead(member(actor), i, this.now())).reverse();
  }

  /** Owners delete their own notes; admins may delete family and house notes, never private ones. */
  forget(actor: Actor, id: string): MemoryItem {
    const idx = this.data.items.findIndex((i) => i.id === id);
    const item = this.data.items[idx];
    if (!item || !canRead(member(actor), item, this.now())) throw new Error('I could not find that note.');
    const isAdmin = can(member(actor), 'manage_members');
    if (item.ownerId !== actor.id && !(isAdmin && item.scope !== 'private')) throw new Error('Only the person who saved it can delete that note.');
    this.data.items.splice(idx, 1);
    this.data.vault.push({ ...item, deletedAt: this.now(), deletedBy: actor.name });
    this.save();
    return item;
  }

  /** Deleted family and house notes, for admins. Deleted private notes stay private. */
  vault(actor: Actor): Saved['vault'] {
    if (!can(member(actor), 'view_vault')) return [];
    return this.data.vault.filter((v) => v.scope !== 'private' || v.ownerId === actor.id).reverse();
  }

  private read(): Saved {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>;
      return { items: Array.isArray(raw.items) ? raw.items : [], vault: Array.isArray(raw.vault) ? raw.vault : [] };
    } catch {
      return { items: [], vault: [] };
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
    renameSync(tmp, this.file);
  }
}
