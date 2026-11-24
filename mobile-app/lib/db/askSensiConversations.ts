import { getDatabase } from './database';
import type { AskConversation } from '../assistant/askSensiConversation';

type Row = Omit<AskConversation, 'turns'> & { messages: string };

export async function listAskConversations(account: string, driver: string): Promise<AskConversation[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<Row>(
    `SELECT c.id, c.drive_id AS driveId, d.started_at AS driveStartedAt, c.title,
      c.created_at AS createdAt, c.updated_at AS updatedAt, c.messages
      FROM ask_sensi_chats c LEFT JOIN drive_sessions d ON d.id = c.drive_id AND d.profile_id = c.profile_id
      WHERE c.account_id = ? AND c.profile_id = ?
      AND NOT EXISTS (SELECT 1 FROM drive_sessions foreign_drive WHERE foreign_drive.id = c.drive_id AND foreign_drive.profile_id <> c.profile_id)
      ORDER BY c.created_at DESC, c.id DESC`,
    [account, driver],
  );
  return rows.map(({ messages, ...row }) => ({ ...row, turns: JSON.parse(messages) }));
}

export async function saveAskConversation(account: string, driver: string, chat: AskConversation): Promise<void> {
  const db = await getDatabase();
  const result = await db.runAsync(
    `INSERT INTO ask_sensi_chats (account_id, profile_id, id, drive_id, title, created_at, updated_at, messages)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ? IS NULL OR EXISTS (SELECT 1 FROM drive_sessions WHERE id = ? AND profile_id = ? AND status <> 'active')
     ON CONFLICT (account_id, profile_id, id) DO UPDATE SET updated_at = excluded.updated_at, messages = excluded.messages
     WHERE ask_sensi_chats.drive_id IS excluded.drive_id`,
    [account, driver, chat.id, chat.driveId, chat.title, chat.createdAt, chat.updatedAt, JSON.stringify(chat.turns), chat.driveId, chat.driveId, driver],
  );
  if (!result.changes) throw new Error('Conversation drive is locked.');
}

export async function deleteAskConversation(account: string, driver: string, id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM ask_sensi_chats WHERE account_id = ? AND profile_id = ? AND id = ?', [account, driver, id]);
}
