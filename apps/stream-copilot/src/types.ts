// Shared shapes for chat. Platform-neutral, so Twitch today and YouTube later share the same logic.

export interface Badges {
  broadcaster: boolean;
  moderator: boolean;
  vip: boolean;
  subscriber: boolean;
}

export interface ChatMessage {
  /** The platform's message id, needed to delete it. */
  id: string;
  userId: string;
  login: string;
  displayName: string;
  text: string;
  at: number;
  badges: Badges;
  /** True for someone chatting in this channel for the very first time. */
  firstMessage?: boolean;
}

/** Staff are never moderated or rate-limited by the copilot. */
export const isStaff = (b: Badges): boolean => b.broadcaster || b.moderator;
