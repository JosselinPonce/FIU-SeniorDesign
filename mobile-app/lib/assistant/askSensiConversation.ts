import type { AskTopic } from '../../supabase/functions/_shared/askSensi.ts';

export type AskTurn = { id: string; question: string; answer: string | null; topic?: AskTopic; sharedSafety?: boolean };
export type AskConversation = {
  id: string;
  driveId: string | null;
  driveStartedAt?: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: AskTurn[];
};

export function newAskConversation(id: string, driveId: string | null, question: string, now: string): AskConversation {
  const title = question.replace(/\s+/g, ' ').trim();
  const characters = Array.from(title);
  return { id, driveId, title: characters.length > 48 ? characters.slice(0, 47).join('') + '…' : title,
    createdAt: now, updatedAt: now, turns: [] };
}

export function appendAskTurn(chat: AskConversation, turn: AskTurn, now: string): AskConversation {
  return { ...chat, updatedAt: now, turns: [...chat.turns.filter(previous => previous.id !== turn.id), turn] };
}
