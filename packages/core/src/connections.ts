// Step 21: the Connections page logic: status, scopes and honest revoke.

export type ConnectionStatus = 'connected' | 'needs_reauth' | 'revoked';

export interface Connection {
  id: string;
  userId: string;
  provider: string; // 'google', 'mcp:notion', 'twilio', ...
  accountLabel: string;
  scopes: string[];
  status: ConnectionStatus;
  connectedAt: number;
  lastError?: string;
}

export class ConnectionRegistry {
  private readonly items = new Map<string, Connection>();

  connect(c: Omit<Connection, 'status' | 'connectedAt'> & { connectedAt?: number }): Connection {
    const conn: Connection = { ...c, status: 'connected', connectedAt: c.connectedAt ?? Date.now() };
    this.items.set(conn.id, conn);
    return conn;
  }

  list(userId: string): Connection[] {
    return [...this.items.values()].filter((c) => c.userId === userId);
  }

  markNeedsReauth(id: string, error: string): void {
    const c = this.mustGet(id);
    c.status = 'needs_reauth';
    c.lastError = error;
  }

  /** True only if the connection is live and was granted that scope. */
  hasScope(userId: string, provider: string, scope: string): boolean {
    return this.list(userId).some(
      (c) => c.provider === provider && c.status === 'connected' && c.scopes.includes(scope),
    );
  }

  /**
   * Revoke at the provider FIRST. If that fails we keep the status unchanged and throw,
   * so the page never shows "revoked" while access still exists.
   */
  async revoke(userId: string, id: string, revokeAtProvider: (c: Connection) => Promise<void>): Promise<void> {
    const c = this.mustGet(id);
    if (c.userId !== userId) throw new Error('Not your connection');
    await revokeAtProvider(c);
    c.status = 'revoked';
    c.scopes = [];
  }

  private mustGet(id: string): Connection {
    const c = this.items.get(id);
    if (!c) throw new Error(`Unknown connection ${id}`);
    return c;
  }
}
