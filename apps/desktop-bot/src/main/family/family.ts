// The family on this computer (one family = one server) and the phones paired to it.
// Pairing: an admin shows a 6-digit code on the PC, the phone types it in once, and gets a
// long random key. Only a hash of that key is stored, so a copied settings file cannot be
// used to pretend to be a phone. Roles come from Family AI's shared rules.

import { canManage, ROLES, type Role } from '@familiai/core';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Actor } from '../agent/types';

export interface FamilyMember {
  id: string;
  name: string;
  role: Role;
  createdAt: number;
}

export interface Device {
  id: string;
  memberId: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeen: number;
}

interface Saved {
  members: FamilyMember[];
  devices: Device[];
}

interface Pairing {
  code: string;
  memberId: string;
  expiresAt: number;
  failures: number;
}

const PAIR_TTL_MS = 5 * 60_000;
const MAX_FAILURES = 5;
const MAX_MEMBERS = 30;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class Family {
  private data: Saved;
  private pairing: Pairing | null = null;

  constructor(private readonly file: string, ownerName: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(file), { recursive: true });
    this.data = this.read();
    if (!this.data.members.some((m) => m.role === 'owner')) {
      this.data.members.unshift({ id: 'owner', name: ownerName.slice(0, 40) || 'Owner', role: 'owner', createdAt: this.now() });
      this.save();
    }
  }

  members(): FamilyMember[] {
    return this.data.members.map((m) => ({ ...m }));
  }

  owner(): FamilyMember {
    return this.data.members.find((m) => m.role === 'owner')!;
  }

  member(id: string): FamilyMember | undefined {
    return this.data.members.find((m) => m.id === id);
  }

  actor(m: FamilyMember, via: Actor['via']): Actor {
    return { id: m.id, name: m.name, role: m.role, via };
  }

  addMember(name: string, role: Role, by: Actor): FamilyMember {
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new Error('Give the family member a name.');
    if (!ROLES.includes(role) || role === 'owner') throw new Error('Pick a role: admin, adult, teen, child, elder or guest.');
    if (this.data.members.length >= MAX_MEMBERS) throw new Error('This family is full.');
    const m: FamilyMember = { id: `mem${this.now().toString(36)}${randomInt(1000)}`, name: clean, role, createdAt: this.now() };
    if (!canManage(this.asMember(by), { id: m.id, familyId: 'local', role })) throw new Error(`${by.name} cannot add a ${role}.`);
    this.data.members.push(m);
    this.save();
    return m;
  }

  removeMember(id: string, by: Actor): FamilyMember {
    const m = this.member(id);
    if (!m) throw new Error('That person is not in this family.');
    if (!canManage(this.asMember(by), { id: m.id, familyId: 'local', role: m.role })) throw new Error(`${by.name} cannot remove ${m.name}.`);
    this.data.members = this.data.members.filter((x) => x.id !== id);
    this.data.devices = this.data.devices.filter((d) => d.memberId !== id); // their phones stop working too
    this.save();
    return m;
  }

  /** Shows a fresh code for pairing a phone to this member. Only admins and the owner may. */
  startPairing(memberId: string, by: Actor): { code: string; expiresAt: number; member: string } {
    if (by.role !== 'owner' && by.role !== 'admin') throw new Error('Only the owner or an admin can pair a phone.');
    const m = this.member(memberId);
    if (!m) throw new Error('Pick a family member first.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pairing = { code, memberId, expiresAt: this.now() + PAIR_TTL_MS, failures: 0 };
    return { code, expiresAt: this.pairing.expiresAt, member: m.name };
  }

  cancelPairing(): void {
    this.pairing = null;
  }

  pairingActive(): boolean {
    return this.pairing !== null && this.now() < this.pairing.expiresAt;
  }

  /** The phone sends the code; it gets a key back exactly once. Five wrong codes end the pairing. */
  completePairing(code: string, deviceName: string): { token: string; member: FamilyMember } {
    const p = this.pairing;
    if (!p || this.now() >= p.expiresAt) {
      this.pairing = null;
      throw new Error('There is no pairing code showing on the computer. Make a new one there.');
    }
    const given = Buffer.from(String(code).replace(/\D/g, '').padEnd(6, 'x').slice(0, 6));
    if (!timingSafeEqual(given, Buffer.from(p.code))) {
      p.failures += 1;
      if (p.failures >= MAX_FAILURES) this.pairing = null;
      throw new Error('That code is wrong.');
    }
    this.pairing = null; // one phone per code
    const member = this.member(p.memberId);
    if (!member) throw new Error('That family member was removed.');
    const token = randomBytes(32).toString('base64url');
    this.data.devices.push({
      id: `dev${this.now().toString(36)}${randomInt(1000)}`,
      memberId: member.id,
      name: deviceName.trim().slice(0, 40) || 'Phone',
      tokenHash: hash(token),
      createdAt: this.now(),
      lastSeen: this.now(),
    });
    this.save();
    return { token, member };
  }

  /** Who is this phone? Null when the key is unknown or was revoked. */
  authenticate(token: string): { member: FamilyMember; device: Device } | null {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const h = Buffer.from(hash(token));
    const device = this.data.devices.find((d) => timingSafeEqual(Buffer.from(d.tokenHash), h));
    const member = device && this.member(device.memberId);
    if (!device || !member) return null;
    device.lastSeen = this.now();
    return { member, device };
  }

  devices(): Array<Omit<Device, 'tokenHash'> & { memberName: string }> {
    return this.data.devices.map(({ tokenHash: _hidden, ...d }) => ({ ...d, memberName: this.member(d.memberId)?.name ?? '?' }));
  }

  revokeDevice(id: string, by: Actor): void {
    const d = this.data.devices.find((x) => x.id === id);
    if (!d) throw new Error('That phone is not paired.');
    if (by.role !== 'owner' && by.role !== 'admin' && by.id !== d.memberId) throw new Error(`${by.name} cannot unpair that phone.`);
    this.data.devices = this.data.devices.filter((x) => x.id !== id);
    this.save();
  }

  private asMember(a: Actor) {
    return { id: a.id, familyId: 'local', role: a.role };
  }

  private read(): Saved {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>;
      return {
        members: Array.isArray(raw.members) ? raw.members.filter((m) => m && typeof m.id === 'string' && ROLES.includes(m.role)) : [],
        devices: Array.isArray(raw.devices) ? raw.devices.filter((d) => d && typeof d.tokenHash === 'string') : [],
      };
    } catch {
      return { members: [], devices: [] };
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}
