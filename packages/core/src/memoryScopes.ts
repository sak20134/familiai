// Step 16: private, family and house memory. Server-side rules, never left to the AI model.

import type { Member } from './roles';

export type MemoryScope = 'private' | 'family' | 'house';
export type Sensitivity = 'normal' | 'sensitive';

export interface MemoryItem {
  id: string;
  familyId: string;
  ownerId: string;
  scope: MemoryScope;
  text: string;
  sensitivity: Sensitivity;
  source: string;
  confidence: number; // 0..1
  createdAt: number;
  expiresAt?: number;
}

export function canRead(viewer: Member, item: MemoryItem, now = Date.now()): boolean {
  if (viewer.familyId !== item.familyId) return false;
  if (item.expiresAt !== undefined && item.expiresAt <= now) return false;
  if (viewer.role === 'guest') return false;

  switch (item.scope) {
    case 'private':
      // Only the owner. Admins do NOT get a back door here.
      return item.ownerId === viewer.id;
    case 'family':
      if (item.sensitivity === 'sensitive' && (viewer.role === 'child' || viewer.role === 'teen')) {
        return item.ownerId === viewer.id;
      }
      return true;
    case 'house':
      return true;
  }
}

export function filterReadable(viewer: Member, items: readonly MemoryItem[], now = Date.now()): MemoryItem[] {
  return items.filter((i) => canRead(viewer, i, now));
}

export function canWrite(viewer: Member, scope: MemoryScope): boolean {
  if (viewer.role === 'guest' || viewer.role === 'child') return scope === 'private';
  return true;
}
