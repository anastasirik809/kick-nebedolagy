import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendDirectory = path.resolve(sourceDirectory, '..');
dotenv.config({ path: path.join(backendDirectory, '.env') });

export const config = {
  port: Number(process.env.PORT || 5000),
  clientOrigin: process.env.CLIENT_ORIGIN || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5173',
  auth: {
    login: process.env.ADMIN_LOGIN || '',
    password: process.env.ADMIN_PASSWORD || '',
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
    sessionSecret: process.env.SESSION_SECRET || ''
  },
  streamerChannel: process.env.STREAMER_CHANNEL || 'nebedolagy',
  wtv: {
    channelUrl: process.env.WTV_CHANNEL_URL || 'https://w.tv/bedolagy',
    chatId: process.env.WTV_CHAT_ID || '019b3308-bce6-712a-9deb-85ed439c4c1a',
    apiBase: process.env.WTV_CHAT_API || 'https://chats-service.w.tv'
  },
  sqliteFile: path.resolve(backendDirectory, process.env.SQLITE_FILE || './raffle.sqlite'),
  kick: {
    apiBase: process.env.KICK_API_BASE || 'https://kick.com',
    pusherUrl:
      process.env.KICK_PUSHER_URL ||
      'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false',
    userAgent:
      process.env.KICK_USER_AGENT ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
  }
};
