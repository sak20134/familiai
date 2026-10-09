// Step 5: roles and what each role may do. Admins only ever control their own family.

export const ROLES = ['owner', 'admin', 'adult', 'teen', 'child', 'elder', 'guest'] as const;
export type Role = (typeof ROLES)[number];

export type Capability =
  | 'chat'
  | 'manage_members'
  | 'view_activity'
  | 'view_vault'
  | 'use_ai_mode'
  | 'approve_money'
  | 'edit_family_memory'
  | 'use_calls'
  | 'connect_services'
  | 'manage_safe_search';

const ALL: Capability[] = [
  'chat',
  'manage_members',
  'view_activity',
  'view_vault',
  'use_ai_mode',
  'approve_money',
  'edit_family_memory',
  'use_calls',
  'connect_services',
  'manage_safe_search',
];

const CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  owner: new Set(ALL),
  admin: new Set(ALL),
  adult: new Set<Capability>([
    'chat',
    'view_activity',
    'use_ai_mode',
    'approve_money',
    'edit_family_memory',
    'use_calls',
    'connect_services',
  ]),
  teen: new Set<Capability>(['chat', 'edit_family_memory', 'use_calls']),
  child: new Set<Capability>(['chat']),
  elder: new Set<Capability>(['chat', 'use_calls', 'edit_family_memory', 'use_ai_mode']),
  guest: new Set<Capability>(['chat']),
};

export type AgeMode = 'under13' | 'teen' | 'adult' | 'elder';

/** The AI adapts its tone and limits to this mode (onboarding asks age first). */
export function ageModeFor(age: number, isElder = false): AgeMode {
  if (!Number.isFinite(age) || age < 0) throw new RangeError('age must be a non-negative number');
  if (age < 13) return 'under13';
  if (age < 18) return 'teen';
  return isElder || age >= 65 ? 'elder' : 'adult';
}

export interface Member {
  id: string;
  familyId: string;
  role: Role;
}

export function can(member: Member, capability: Capability): boolean {
  return CAPABILITIES[member.role].has(capability);
}

/** Can `actor` add, remove or change the role of `target`? Never across families. */
export function canManage(actor: Member, target: Member): boolean {
  if (actor.familyId !== target.familyId) return false;
  if (!can(actor, 'manage_members')) return false;
  if (actor.id === target.id) return false; // nobody removes or demotes themselves here
  if (target.role === 'owner') return false; // only an ownership transfer changes the owner
  if (target.role === 'admin') return actor.role === 'owner'; // admins cannot remove other admins
  return true;
}
