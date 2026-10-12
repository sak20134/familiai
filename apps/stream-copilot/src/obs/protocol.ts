// The obs-websocket v5 protocol (built into OBS 28+). Pure helpers, no network here.
// Spec: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md

import { createHash } from 'node:crypto';

export const OP = {
  Hello: 0,
  Identify: 1,
  Identified: 2,
  Event: 5,
  Request: 6,
  RequestResponse: 7,
} as const;

export const RPC_VERSION = 1;

export interface Message {
  op: number;
  d: Record<string, unknown>;
}

/** OBS closes the socket with this code when the password is wrong. */
export const AUTH_FAILED_CLOSE = 4009;

const sha256b64 = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64');

/**
 * The auth string OBS expects:
 * secret = base64(sha256(password + salt)), auth = base64(sha256(secret + challenge)).
 */
export function authString(password: string, salt: string, challenge: string): string {
  return sha256b64(sha256b64(password + salt) + challenge);
}

export function identify(hello: Record<string, unknown>, password: string | undefined): Message {
  const auth = hello.authentication as { challenge?: string; salt?: string } | undefined;
  const d: Record<string, unknown> = { rpcVersion: RPC_VERSION };
  if (auth?.challenge && auth.salt) {
    if (!password) throw new Error('OBS wants a password. Put it in OBS_PASSWORD in your .env file.');
    d.authentication = authString(password, auth.salt, auth.challenge);
  }
  return { op: OP.Identify, d };
}

export function request(requestType: string, requestId: string, requestData?: Record<string, unknown>): Message {
  return { op: OP.Request, d: { requestType, requestId, ...(requestData ? { requestData } : {}) } };
}

export function parse(raw: string): Message | null {
  try {
    const m = JSON.parse(raw) as Message;
    return typeof m?.op === 'number' && m.d && typeof m.d === 'object' ? m : null;
  } catch {
    return null;
  }
}
