import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { config } from './config.js';
import { addParticipant, drawParticipant, getParticipants } from './database.js';

const ROLL_DURATION_MS = 3_500;
const WINNER_CONFIRMATION_MS = 45_000;

// One module-level record ensures this backend maintains a single live raffle.
let activeRaffle = null;
let winnerTimer = null;
let winnerState = createIdleWinnerState();
const WTV_POLL_INTERVAL_MS = 2_000;
const execFileAsync = promisify(execFile);

function createIdleWinnerState() {
  return { phase: 'idle', winner: null, expiresAt: null };
}

function normalizeChannel(channel) {
  return channel.trim().replace(/^#/, '').toLowerCase();
}

function emitStatus(io, status, extra = {}) {
  io.emit('status_update', { status, ...extra });
}

function decodePusherData(value) {
  if (typeof value !== 'string') return value || {};

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function readChatMessage(payload) {
  const message =
    payload?.content ??
    payload?.message?.content ??
    payload?.message?.message ??
    payload?.message;
  const username =
    payload?.sender?.username ??
    payload?.user?.username ??
    payload?.message?.sender?.username ??
    payload?.message?.user?.username;

  return {
    message: typeof message === 'string' ? message : '',
    username: typeof username === 'string' ? username.trim() : ''
  };
}

function normalizeChatroomId(chatroomId) {
  const value = String(chatroomId || '').trim();
  return /^\d+$/.test(value) ? value : null;
}

async function getChatroomId(channel) {
  const url = `${config.kick.apiBase}/api/v2/channels/${encodeURIComponent(channel)}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': config.kick.userAgent,
      Referer: `${config.kick.apiBase}/${channel}`
    }
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 404) throw new Error('Канал Kick не найден');
    if (response.status === 403) throw new Error('Kick временно заблокировал поиск канала. Повторите попытку.');
    throw new Error(`Не удалось получить чат Kick (${response.status}): ${body.slice(0, 120)}`);
  }

  const data = await response.json();
  const chatroomId = data?.chatroom?.id;
  if (!chatroomId) throw new Error('Kick не вернул чат для этого канала');
  return String(chatroomId);
}

/**
 * Listens to Kick's currently public, undocumented Pusher chat transport.
 * It only reads public messages and never sends a chat message or account data.
 */
export function createRaffleService(io) {
  function getWinnerState() {
    return { ...winnerState };
  }

  function broadcastWinnerState() {
    io.emit('winner_state', getWinnerState());
  }

  function clearWinnerTimer() {
    if (winnerTimer) clearTimeout(winnerTimer);
    winnerTimer = null;
  }

  function resetWinnerState() {
    clearWinnerTimer();
    winnerState = createIdleWinnerState();
    broadcastWinnerState();
  }

  function timeoutWinner(winner) {
    if (winnerState.phase !== 'awaiting_confirmation' || winnerState.winner !== winner) return;

    winnerTimer = null;
    winnerState = { phase: 'timed_out', winner, expiresAt: null };
    console.info(`Winner confirmation expired: ${winner}`);
    io.emit('winner_timeout', { winner });
    broadcastWinnerState();
  }

  function revealWinner(winner) {
    if (winnerState.phase !== 'rolling' || winnerState.winner !== winner) return;

    const expiresAt = Date.now() + WINNER_CONFIRMATION_MS;
    winnerState = { phase: 'awaiting_confirmation', winner, expiresAt };
    io.emit('winner_selected', { winner, expiresAt });
    broadcastWinnerState();

    winnerTimer = setTimeout(() => timeoutWinner(winner), WINNER_CONFIRMATION_MS);
  }

  function confirmWinner(username) {
    if (
      winnerState.phase !== 'awaiting_confirmation' ||
      username.localeCompare(winnerState.winner, undefined, { sensitivity: 'accent' }) !== 0
    ) {
      return false;
    }

    const winner = winnerState.winner;
    clearWinnerTimer();
    winnerState = { phase: 'confirmed', winner, expiresAt: null };
    console.info(`Winner confirmed in chat: ${winner}`);
    io.emit('winner_confirmed', { winner });
    broadcastWinnerState();
    return true;
  }

  function scheduleReconnect(raffle) {
    if (activeRaffle !== raffle || raffle.stoppedByUser || raffle.reconnectTimer) return;

    raffle.reconnectAttempts += 1;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(raffle.reconnectAttempts - 1, 6));
    raffle.status = 'reconnecting';
    console.warn(`Kick chat connection closed; retrying in ${Math.round(delay / 1000)}s`);
    emitStatus(io, 'reconnecting', { channel: raffle.channel, keyword: raffle.keyword });

    raffle.reconnectTimer = setTimeout(() => {
      raffle.reconnectTimer = null;
      if (activeRaffle !== raffle || raffle.stoppedByUser) return;
      openChatSocket(raffle);
    }, delay);
  }

  function processChatMessage(raffle, payload, source = 'kick') {
    const { message, username } = readChatMessage(payload);
    if (!username || !message) return;

    // A winner only needs to send any non-empty chat message before the timer ends.
    confirmWinner(username);

    if (!message.toLocaleLowerCase().includes(raffle.keyword.toLocaleLowerCase())) return;
    if (addParticipant(username, source)) {
      const participants = getParticipants();
      console.info(`Added giveaway participant: ${username}`);
      io.emit('participants_update', { participants });
    }
  }

  function scheduleWtvPoll(raffle) {
    if (activeRaffle !== raffle || raffle.stoppedByUser) return;
    raffle.wtvTimer = setTimeout(() => pollWtvChat(raffle), WTV_POLL_INTERVAL_MS);
  }

  // CloudFront/WAF can reject Node's TLS fingerprint even though the public
  // endpoint is readable without an account. Fall back to curl with the same
  // browser-like headers; no W.TV cookie or session token is ever required.
  async function fetchWtvMessages(endpoint) {
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        Origin: 'https://w.tv',
        Referer: 'https://w.tv/'
      }
    });

    if (response.ok) return response.json();
    if (response.status !== 403) {
      throw new Error(`W.TV chat returned HTTP ${response.status}`);
    }

    try {
      const { stdout } = await execFileAsync(
        'curl',
        [
          '--fail',
          '--silent',
          '--show-error',
          '--compressed',
          '--max-time',
          '10',
          '-A',
          config.kick.userAgent,
          '-H',
          'Accept: application/json',
          '-H',
          'Origin: https://w.tv',
          '-H',
          'Referer: https://w.tv/',
          '--url',
          endpoint
        ],
        { maxBuffer: 1_000_000 }
      );
      return JSON.parse(stdout);
    } catch (error) {
      throw new Error(`W.TV chat request blocked (${error.message || 'HTTP 403'})`);
    }
  }

  async function pollWtvChat(raffle) {
    if (activeRaffle !== raffle || raffle.stoppedByUser) return;

    try {
      const endpoint = `${config.wtv.apiBase}/api/v1/chats/${config.wtv.chatId}/messages?user_lang=ru&platform=web`;
      const payload = await fetchWtvMessages(endpoint);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const freshMessages = messages
        .filter((message) => message?.messageId && !raffle.wtvSeenMessages.has(message.messageId))
        .reverse();

      // Do not enter old messages that were already in the chat when the raffle started.
      if (!raffle.wtvInitialized) {
        messages.forEach((message) => raffle.wtvSeenMessages.add(message.messageId));
        raffle.wtvInitialized = true;
      } else {
        freshMessages.forEach((message) => {
          raffle.wtvSeenMessages.add(message.messageId);
          processChatMessage(raffle, {
            content: message.content,
            sender: { username: message.sender?.nickname }
          }, 'wtv');
        });
      }
    } catch (error) {
      if (activeRaffle === raffle && !raffle.stoppedByUser) {
        console.warn('W.TV chat polling error:', error.message || error);
      }
    } finally {
      scheduleWtvPoll(raffle);
    }
  }

  function startWtvPolling(raffle) {
    raffle.wtvSeenMessages = new Set();
    raffle.wtvInitialized = false;
    pollWtvChat(raffle);
  }

  function openChatSocket(raffle) {
    if (activeRaffle !== raffle || raffle.stoppedByUser) return;

    let socket;
    try {
      socket = new WebSocket(config.kick.pusherUrl);
    } catch (error) {
      console.error('Could not create Kick chat socket:', error.message || error);
      scheduleReconnect(raffle);
      return;
    }
    raffle.socket = socket;

    socket.on('open', () => {
      if (activeRaffle !== raffle || raffle.stoppedByUser || raffle.socket !== socket) {
        socket.close();
        return;
      }

      socket.send(
        JSON.stringify({
          event: 'pusher:subscribe',
          data: { auth: '', channel: `chatrooms.${raffle.chatroomId}.v2` }
        })
      );
    });

    socket.on('message', (rawMessage) => {
      if (activeRaffle !== raffle || raffle.stoppedByUser || raffle.socket !== socket) return;

      let event;
      try {
        event = JSON.parse(rawMessage.toString());
      } catch {
        return;
      }

      if (event.event === 'pusher:ping') {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
        }
        return;
      }

      if (event.event === 'pusher_internal:subscription_succeeded') {
        raffle.status = 'running';
        raffle.reconnectAttempts = 0;
        console.info(`Listening to public Kick chat in #${raffle.channel}`);
        emitStatus(io, 'running', { channel: raffle.channel, keyword: raffle.keyword });
        return;
      }

      if (event.event === 'pusher:error') {
        const error = decodePusherData(event.data);
        console.error('Kick chat subscription error:', error.message || event.data);
        raffle.status = 'error';
        emitStatus(io, 'error', {
          channel: raffle.channel,
          keyword: raffle.keyword,
          message: error.message || 'Не удалось подключиться к чату Kick'
        });
        socket.close();
        return;
      }

      // Kick has used both names across versions, so accept either.
      if (typeof event.event === 'string' && event.event.includes('ChatMessage')) {
        processChatMessage(raffle, decodePusherData(event.data), 'kick');
      }
    });

    socket.on('error', (error) => {
      if (activeRaffle === raffle && !raffle.stoppedByUser) {
        console.error('Kick chat socket error:', error.message || error);
      }
    });

    socket.on('close', (code, reason) => {
      if (activeRaffle !== raffle || raffle.stoppedByUser || raffle.socket !== socket) return;
      const detail = reason.toString();
      console.warn(`Kick chat socket closed (code ${code}${detail ? `: ${detail}` : ''})`);
      scheduleReconnect(raffle);
    });
  }

  function getStatus() {
    if (!activeRaffle) return { status: 'stopped', winner: getWinnerState() };
    return {
      status: activeRaffle.status,
      channel: activeRaffle.channel,
      keyword: activeRaffle.keyword,
      winner: getWinnerState()
    };
  }

  function stop() {
    const raffle = activeRaffle;
    if (!raffle) {
      resetWinnerState();
      emitStatus(io, 'stopped');
      return { success: true, message: 'Розыгрыш не был запущен' };
    }

    activeRaffle = null;
    raffle.stoppedByUser = true;
    if (raffle.reconnectTimer) clearTimeout(raffle.reconnectTimer);
    if (raffle.wtvTimer) clearTimeout(raffle.wtvTimer);
    if (raffle.socket) raffle.socket.close();
    resetWinnerState();

    emitStatus(io, 'stopped');
    return { success: true, message: 'Розыгрыш остановлен' };
  }

  function draw({ reroll = false } = {}) {
    if (winnerState.phase === 'rolling' || winnerState.phase === 'awaiting_confirmation') {
      throw new Error('Дождитесь завершения текущего ролла');
    }

    const previousWinner = reroll && winnerState.phase === 'timed_out' ? winnerState.winner : null;
    const winner = drawParticipant(previousWinner);
    if (!winner) {
      throw new Error(reroll ? 'Нет другого участника для повторного ролла' : 'Нет участников');
    }

    clearWinnerTimer();
    winnerState = { phase: 'rolling', winner, expiresAt: null };
    io.emit('winner_rolling', { winner, durationMs: ROLL_DURATION_MS, reroll });
    broadcastWinnerState();

    winnerTimer = setTimeout(() => revealWinner(winner), ROLL_DURATION_MS);
    return { winner, status: 'rolling' };
  }

  function clearWinner() {
    resetWinnerState();
  }

  async function start({ channel, keyword, chatroomId }) {
    const requestedChannel = typeof channel === 'string' && channel.trim()
      ? channel
      : config.streamerChannel;
    if (!requestedChannel.trim()) throw new Error('Канал стримера не настроен');
    if (typeof keyword !== 'string' || !keyword.trim()) throw new Error('Введите кодовое слово');

    const cleanChannel = normalizeChannel(requestedChannel);
    const cleanKeyword = keyword.trim();
    if (!/^[a-z0-9_-]{1,80}$/i.test(cleanChannel)) {
      throw new Error('В названии канала допустимы буквы, цифры, «_» и «-»');
    }

    if (activeRaffle) stop();

    // The browser resolves this public id first, which avoids Cloudflare's
    // stricter filtering of server-to-server metadata requests. Retain the
    // backend lookup as a convenience for direct REST API consumers.
    const resolvedChatroomId = normalizeChatroomId(chatroomId) || (await getChatroomId(cleanChannel));
    const raffle = {
      channel: cleanChannel,
      keyword: cleanKeyword,
      chatroomId: resolvedChatroomId,
      socket: null,
      status: 'connecting',
      stoppedByUser: false,
      reconnectTimer: null,
      reconnectAttempts: 0,
      wtvTimer: null,
      wtvSeenMessages: new Set(),
      wtvInitialized: false
    };
    activeRaffle = raffle;
    resetWinnerState();
    emitStatus(io, 'connecting', { channel: cleanChannel, keyword: cleanKeyword });
    openChatSocket(raffle);
    startWtvPolling(raffle);

    return { success: true, message: 'Розыгрыш запущен' };
  }

  return { start, stop, draw, clearWinner, getStatus, getWinnerState };
}
