// Step 19: Google Calendar tools. Tokens come from the per-user OAuth store (never hardcoded).

import type { ToolSpec } from './approvals';

export const CALENDAR_LIST_TOOL: ToolSpec = {
  name: 'google.calendar.list',
  risk: 'low',
  description: 'Read upcoming calendar events',
};

export const CALENDAR_CREATE_TOOL: ToolSpec = {
  name: 'google.calendar.create',
  risk: 'medium',
  description: 'Create a calendar event',
};

export interface TokenProvider {
  getAccessToken(userId: string): Promise<string>;
}

export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
  /** 401 means the user must sign in to Google again. */
  get needsReauth(): boolean {
    return this.status === 401;
  }
}

export interface CalendarEvent {
  id?: string;
  summary: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  description?: string;
}

const BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export class GoogleCalendar {
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly tokens: TokenProvider,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async listUpcoming(userId: string, now: Date, max = 5): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin: now.toISOString(),
      maxResults: String(max),
      singleEvents: 'true',
      orderBy: 'startTime',
    });
    const res = await this.fetchImpl(`${BASE}?${params}`, { headers: await this.headers(userId) });
    await this.assertOk(res);
    const json = (await res.json()) as {
      items?: Array<{ id?: string; summary?: string; description?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }>;
    };
    return (json.items ?? []).map((i) => ({
      ...(i.id ? { id: i.id } : {}),
      summary: i.summary ?? '(no title)',
      start: i.start?.dateTime ?? i.start?.date ?? '',
      end: i.end?.dateTime ?? i.end?.date ?? '',
      ...(i.description ? { description: i.description } : {}),
    }));
  }

  /** Call this only AFTER the user approved (medium risk). Returns the created event with its id. */
  async createEvent(userId: string, ev: CalendarEvent): Promise<CalendarEvent> {
    if (Date.parse(ev.end) <= Date.parse(ev.start)) throw new RangeError('Event must end after it starts');
    const res = await this.fetchImpl(BASE, {
      method: 'POST',
      headers: { ...(await this.headers(userId)), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: ev.summary,
        description: ev.description,
        start: { dateTime: ev.start },
        end: { dateTime: ev.end },
      }),
    });
    await this.assertOk(res);
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw new Error('Google did not return an event id');
    return { ...ev, id: json.id };
  }

  /** Used as the result check: does the event really exist now? */
  async eventExists(userId: string, eventId: string): Promise<boolean> {
    const res = await this.fetchImpl(`${BASE}/${encodeURIComponent(eventId)}`, { headers: await this.headers(userId) });
    if (res.status === 404) return false;
    await this.assertOk(res);
    return true;
  }

  private async headers(userId: string): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.tokens.getAccessToken(userId)}` };
  }

  private async assertOk(res: Response): Promise<void> {
    if (res.ok) return;
    throw new GoogleApiError(res.status, `Google Calendar error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}
