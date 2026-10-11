// Outside services the server can use. Each is optional: features say "not connected" when missing.

import type { CallProvider } from '@familiai/core';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface Services {
  /** 32-byte key used to encrypt stored OAuth tokens. */
  secretKey: Buffer;
  calls?: { provider: CallProvider; from: string };
  google?: GoogleConfig;
  /** Swappable for tests. */
  fetchImpl?: typeof fetch;
}
