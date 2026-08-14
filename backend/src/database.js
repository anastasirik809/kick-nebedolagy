import Database from 'better-sqlite3';
import { randomInt } from 'node:crypto';
import { config } from './config.js';

const database = new Database(config.sqliteFile);

database.pragma('journal_mode = WAL');
database.exec(`
  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    source TEXT NOT NULL DEFAULT 'kick',
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

// Databases created by an older version do not have the source column yet.
// Keep their participants and mark them as Kick entries during migration.
const participantColumns = database.prepare('PRAGMA table_info(participants)').all();
if (!participantColumns.some(({ name }) => name === 'source')) {
  database.exec("ALTER TABLE participants ADD COLUMN source TEXT NOT NULL DEFAULT 'kick'");
}

const insertParticipant = database.prepare(
  'INSERT OR IGNORE INTO participants (username, source) VALUES (?, ?)'
);
const listParticipants = database.prepare(
  'SELECT username, source FROM participants ORDER BY joined_at ASC, id ASC'
);
const listParticipantsForDraw = database.prepare('SELECT username FROM participants');
const clearParticipants = database.prepare('DELETE FROM participants');
const deleteParticipant = database.prepare('DELETE FROM participants WHERE username = ?');

export function addParticipant(username, source = 'kick') {
  const normalizedSource = source === 'wtv' ? 'wtv' : 'kick';
  return insertParticipant.run(username, normalizedSource).changes === 1;
}

export function getParticipants() {
  return listParticipants.all().map(({ username, source }) => ({ username, source }));
}

export function drawParticipant(excludeUsername = null) {
  const available = listParticipantsForDraw.all()
    .map(({ username }) => username)
    .filter((username) => !excludeUsername || username.localeCompare(excludeUsername, undefined, { sensitivity: 'accent' }) !== 0);
  if (available.length === 0) return null;
  return available[randomInt(available.length)];
}

export function clearAllParticipants() {
  return clearParticipants.run().changes;
}

export function removeParticipant(username) {
  return deleteParticipant.run(username).changes;
}

export function closeDatabase() {
  database.close();
}
