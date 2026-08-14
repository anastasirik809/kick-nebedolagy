import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const socket = io({ autoConnect: false });
const REEL_ROW_HEIGHT = 72;
const WINNER_CONFIRMATION_SECONDS = 45;
const STREAMER_CHANNEL = 'nebedolagy';
const KICK_CHANNEL_URL = 'https://kick.com/nebedolagy';
const WTV_CHANNEL_URL = 'https://w.tv/bedolagy';

const statusLabels = {
  stopped: 'Остановлен',
  connecting: 'Подключаемся',
  running: 'Чат активен',
  reconnecting: 'Переподключение',
  error: 'Ошибка'
};

const winnerLabels = {
  idle: 'Готов к розыгрышу',
  rolling: 'Выбираем победителя',
  awaiting_confirmation: 'Ждём сообщение в чате',
  confirmed: 'Победитель подтвердил участие',
  timed_out: 'Время вышло'
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Запрос не выполнен');
  return payload;
}

async function resolveKickChatroom(channel) {
  const cleanChannel = channel.trim().replace(/^#/, '');
  const response = await fetch(
    `https://kick.com/api/v2/channels/${encodeURIComponent(cleanChannel)}`,
    { headers: { Accept: 'application/json, text/plain, */*' } }
  );
  if (!response.ok) {
    throw new Error(response.status === 404 ? 'Канал Kick не найден' : 'Не удалось открыть канал Kick');
  }

  const payload = await response.json();
  if (!payload?.chatroom?.id) throw new Error('У канала Kick нет доступного чата');
  return String(payload.chatroom.id);
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }
  return result;
}

function normalizeParticipants(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === 'string') return { username: item, source: 'kick' };
      if (!item?.username) return null;
      return { username: item.username, source: item.source === 'wtv' ? 'wtv' : 'kick' };
    })
    .filter(Boolean);
}

function makeReel(participants, winner) {
  const pool = participants.length ? participants.map(({ username }) => username) : [winner];
  // Каждый круг перемешан отдельно: барабан не повторяет порядок списка.
  const rounds = Array.from({ length: 6 }, () => shuffle(pool)).flat();
  return { items: [...rounds, winner, ...pool.slice(0, 3)], targetIndex: rounds.length };
}

export default function App() {
  const [keyword, setKeyword] = useState('!giveaway');
  const [participants, setParticipants] = useState([]);
  const [status, setStatus] = useState('stopped');
  const [winner, setWinner] = useState('');
  const [winnerPhase, setWinnerPhase] = useState('idle');
  const [expiresAt, setExpiresAt] = useState(null);
  const [remainingSeconds, setRemainingSeconds] = useState(WINNER_CONFIRMATION_SECONDS);
  const [reel, setReel] = useState({ items: [], targetIndex: 0 });
  const [reelOffset, setReelOffset] = useState(0);
  const [reelRolling, setReelRolling] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const participantsRef = useRef([]);
  const reelTimer = useRef(null);
  const audioContextRef = useRef(null);

  const ensureAudioContext = useCallback(() => {
    if (typeof window === 'undefined') return null;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;

    if (!audioContextRef.current) audioContextRef.current = new AudioContext();
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().catch(() => {});
    }
    return audioContextRef.current;
  }, []);

  const playTone = useCallback((frequency, duration, options = {}) => {
    const context = ensureAudioContext();
    if (!context) return;

    const { start = 0, end = frequency, type = 'sine', volume = 0.05 } = options;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const at = context.currentTime + start;

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, end), at + duration);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.02);
  }, [ensureAudioContext]);

  const playSound = useCallback((sound) => {
    if (sound === 'roll') {
      playTone(115, 3.25, { end: 245, type: 'triangle', volume: 0.025 });
      for (let index = 0; index < 20; index += 1) {
        playTone(180 + (index % 3) * 28, 0.06, {
          start: index * 0.16,
          end: 120 + (index % 2) * 25,
          type: 'square',
          volume: 0.018
        });
      }
    }
    if (sound === 'winner') {
      [523, 659, 784, 1046].forEach((frequency, index) => {
        playTone(frequency, 0.24, { start: index * 0.12, end: frequency * 1.04, type: 'sine', volume: 0.07 });
      });
    }
    if (sound === 'success') {
      playTone(660, 0.18, { end: 880, type: 'sine', volume: 0.06 });
      playTone(880, 0.3, { start: 0.16, end: 1100, type: 'sine', volume: 0.07 });
    }
    if (sound === 'timeout') {
      playTone(260, 0.24, { end: 180, type: 'sawtooth', volume: 0.045 });
      playTone(180, 0.35, { start: 0.2, end: 110, type: 'sawtooth', volume: 0.04 });
    }
    if (sound === 'remove') playTone(190, 0.08, { end: 95, type: 'square', volume: 0.035 });
  }, [playTone]);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  const startReel = useCallback((selectedWinner) => {
    const nextReel = makeReel(participantsRef.current, selectedWinner);
    playSound('roll');
    setReel(nextReel);
    setWinner('');
    setWinnerPhase('rolling');
    setReelOffset(0);
    setReelRolling(true);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // The track starts at the window center. Offset by half a row as well,
        // so the selected row's center lands exactly inside the marker.
        setReelOffset(-((nextReel.targetIndex * REEL_ROW_HEIGHT) + REEL_ROW_HEIGHT / 2));
      });
    });

    if (reelTimer.current) clearTimeout(reelTimer.current);
    reelTimer.current = setTimeout(() => setReelRolling(false), 3_600);
  }, [playSound]);

  const refreshParticipants = useCallback(async () => {
    try {
      const data = await request('/api/raffle/participants');
      setParticipants(normalizeParticipants(data.participants));
    } catch (error) {
      setNotice(error.message);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await request('/api/raffle/status');
      setStatus(data.status);
      if (data.keyword) setKeyword(data.keyword);
      if (data.winner) {
        setWinnerPhase(data.winner.phase);
        setWinner(data.winner.winner || '');
        setExpiresAt(data.winner.expiresAt || null);
      }
    } catch (error) {
      setNotice(error.message);
    }
  }, []);

  useEffect(() => {
    socket.connect();
    socket.on('participants_update', ({ participants: nextParticipants }) => {
      setParticipants(normalizeParticipants(nextParticipants));
    });
    socket.on('winner_rolling', ({ winner: selectedWinner }) => {
      startReel(selectedWinner);
    });
    socket.on('winner_selected', ({ winner: selectedWinner, expiresAt: nextExpiresAt }) => {
      playSound('winner');
      setWinner(selectedWinner);
      setWinnerPhase('awaiting_confirmation');
      setExpiresAt(nextExpiresAt);
      setNotice(`${selectedWinner}, напиши любое сообщение в чат за 45 секунд`);
    });
    socket.on('winner_confirmed', ({ winner: confirmedWinner }) => {
      playSound('success');
      setWinner(confirmedWinner);
      setWinnerPhase('confirmed');
      setExpiresAt(null);
      setNotice(`${confirmedWinner} — успел отписать!`);
    });
    socket.on('winner_timeout', ({ winner: timedOutWinner }) => {
      playSound('timeout');
      setWinner(timedOutWinner);
      setWinnerPhase('timed_out');
      setExpiresAt(null);
      setNotice(`${timedOutWinner} — не успел отписать`);
    });
    socket.on('winner_state', (nextWinnerState) => {
      setWinnerPhase(nextWinnerState.phase);
      setWinner(nextWinnerState.winner || '');
      setExpiresAt(nextWinnerState.expiresAt || null);
    });
    socket.on('status_update', (nextStatus) => {
      setStatus(nextStatus.status);
      if (nextStatus.keyword) setKeyword(nextStatus.keyword);
    });

    refreshParticipants();
    refreshStatus();

    return () => {
      if (reelTimer.current) clearTimeout(reelTimer.current);
      socket.off('participants_update');
      socket.off('winner_rolling');
      socket.off('winner_selected');
      socket.off('winner_confirmed');
      socket.off('winner_timeout');
      socket.off('winner_state');
      socket.off('status_update');
      socket.disconnect();
    };
  }, [playSound, refreshParticipants, refreshStatus, startReel]);

  useEffect(() => {
    if (winnerPhase !== 'awaiting_confirmation' || !expiresAt) return undefined;

    const updateCountdown = () => {
      setRemainingSeconds(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    };
    updateCountdown();
    const countdownTimer = setInterval(updateCountdown, 250);
    return () => clearInterval(countdownTimer);
  }, [winnerPhase, expiresAt]);

  async function runAction(action) {
    setBusy(true);
    setNotice('');
    try {
      await action();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  function startRaffle(event) {
    event.preventDefault();
    runAction(async () => {
      const chatroomId = await resolveKickChatroom(STREAMER_CHANNEL);
      const data = await request('/api/raffle/start', {
        method: 'POST',
        body: JSON.stringify({ channel: STREAMER_CHANNEL, keyword, chatroomId })
      });
      setNotice(data.message);
    });
  }

  function stopRaffle() {
    runAction(async () => {
      const data = await request('/api/raffle/stop', { method: 'POST' });
      setNotice(data.message);
    });
  }

  function drawWinner() {
    ensureAudioContext();
    runAction(() => request('/api/raffle/draw', { method: 'POST' }));
  }

  function rerollWinner() {
    ensureAudioContext();
    runAction(() => request('/api/raffle/reroll', { method: 'POST' }));
  }

  function removeParticipant(participant) {
    playSound('remove');
    runAction(async () => {
      const data = await request(`/api/raffle/participants/${encodeURIComponent(participant.username)}`, { method: 'DELETE' });
      setParticipants((current) => current.filter(({ username }) => username.toLocaleLowerCase() !== participant.username.toLocaleLowerCase()));
      setNotice(data.message);
    });
  }

  function clearList() {
    runAction(async () => {
      const data = await request('/api/raffle/clear', { method: 'DELETE' });
      setParticipants([]);
      setWinner('');
      setWinnerPhase('idle');
      setNotice(data.message);
    });
  }

  const running = ['running', 'connecting', 'reconnecting'].includes(status);
  const drawLocked = ['rolling', 'awaiting_confirmation'].includes(winnerPhase);
  const statusLabel = statusLabels[status] || status;
  const winnerLabel = winnerLabels[winnerPhase] || winnerPhase;

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <section className="dashboard">
        <header className="hero-header">
          <div className="brand-lockup">
            <div className="brand-mark">N<span>R</span></div>
            <div>
              <p className="brand-kicker">розыгрыш для Nebedolagy</p>
              <h1>Kick <span>- Nebedolagy</span></h1>
            </div>
          </div>
          <div className={`connection-pill connection-${status}`}>
            <i />
            {statusLabel}
          </div>
        </header>

        <div className="hero-copy">
          <div>
            <p className="eyebrow">чатовый розыгрыш</p>
            <h2>Пусть удача<br /><em>найдёт своего.</em></h2>
          </div>
          <p className="hero-note">Собирай зрителей из чатов Kick и W.TV<br />и выбирай победителя красиво.</p>
        </div>

        <section className="setup-card">
          <div className="section-heading">
            <div>
              <span className="step-index">01</span>
              <div>
                <p className="section-label">Настройка эфира</p>
                <h3>Откуда собираем участников?</h3>
              </div>
            </div>
            <span className="live-dot">LIVE READY</span>
          </div>

          <form className="raffle-form" onSubmit={startRaffle}>
            <div className="fixed-channels">
              <span className="fixed-label">Каналы стримера</span>
              <div className="channel-links">
                <a href={KICK_CHANNEL_URL} target="_blank" rel="noreferrer"><b className="channel-icon kick-icon">K</b><span><small>Kick</small><strong>/nebedolagy</strong></span><i>↗</i></a>
                <a href={WTV_CHANNEL_URL} target="_blank" rel="noreferrer"><b className="channel-icon wtv-icon">W</b><span><small>W.TV</small><strong>/bedolagy</strong></span><i>↗</i></a>
              </div>
            </div>
            <label>
              <span>Ключевое слово</span>
              <div className="input-wrap"><b className="spark">✦</b><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="!giveaway" autoComplete="off" disabled={busy} /></div>
            </label>
            <div className="actions">
              <button className="button button-primary" type="submit" disabled={busy}><span>Запустить эфир</span><b>↗</b></button>
              <button className="button button-quiet" type="button" onClick={stopRaffle} disabled={busy || !running}>Остановить</button>
            </div>
          </form>
        </section>

        <div className="content-grid">
          <section className={`winner-card phase-${winnerPhase}`}>
            <div className="winner-card-head">
              <div><span className="step-index">02</span><div><p className="section-label">Главный момент</p><h3>Кто забирает приз?</h3></div></div>
              <span className="phase-label">{winnerLabel}</span>
            </div>

            <div className="winner-display" aria-live="polite">
              <div className="winner-glow" />
              {winnerPhase === 'rolling' ? (
                <div className="reel-window">
                  <div className="reel-marker" />
                  <div className={`reel-track ${reelRolling ? 'reel-track-moving' : ''}`} style={{ transform: `translate3d(0, ${reelOffset}px, 0)` }}>
                    {reel.items.map((name, index) => <div className="reel-row" key={`${name}-${index}`}>{name}</div>)}
                  </div>
                </div>
              ) : (
                <div className="winner-name">{winner || '—'}</div>
              )}
            </div>

            {winnerPhase === 'awaiting_confirmation' && (
              <div className="confirmation-box"><span>Напиши любое сообщение в чат</span><strong>{remainingSeconds}<small> сек</small></strong></div>
            )}
            {winnerPhase === 'confirmed' && <div className="result-message result-success">✓ {winner} — успел отписать!</div>}
            {winnerPhase === 'timed_out' && <div className="result-message result-timeout">⌁ {winner} — не успел отписать</div>}

            <div className="winner-actions">
              <button className="button button-draw" type="button" onClick={drawWinner} disabled={busy || drawLocked || participants.length === 0}>Крутить барабан <span>✦</span></button>
              {winnerPhase === 'timed_out' && <button className="button button-reroll" type="button" onClick={rerollWinner} disabled={busy}>Реролл <span>↻</span></button>}
            </div>
          </section>

          <section className="participants-card">
            <div className="participants-head"><div><p className="section-label">В прямом эфире</p><h3>Участники</h3></div><span className="count-badge">{participants.length}</span></div>
            <div className="list-caption"><span>Никнейм</span><span className="source-legend"><i className="source-indicator source-kick" /> Kick <i className="source-indicator source-wtv" /> W.TV</span><span>№</span></div>
            <ol className="participants-list" aria-live="polite">
              {participants.length === 0 ? <li className="empty"><span>✦</span><p>Пока пусто</p><small>Запусти розыгрыш и жди сообщения с ключевым словом</small></li> : participants.map((participant, index) => {
                const sourceName = participant.source === 'wtv' ? 'W.TV' : 'Kick';
                return <li key={participant.username}><span className="participant-number">{String(index + 1).padStart(2, '0')}</span><strong>{participant.username}</strong><span className={`source-indicator source-${participant.source}`} title={`Источник: ${sourceName}`} aria-label={`Источник: ${sourceName}`} /><button className="remove-participant" type="button" onClick={() => removeParticipant(participant)} disabled={busy} title={`Удалить ${participant.username}`} aria-label={`Удалить ${participant.username}`}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M9 7l1-2h4l1 2m-9 0 1 13h8l1-13" /></svg></button></li>;
              })}
            </ol>
          </section>
        </div>

        <footer className="dashboard-footer">
          <span>KICK <b>×</b> NEBEDOLAGY</span>
          <button className="clear-button" type="button" onClick={clearList} disabled={busy || participants.length === 0}>Очистить список <span>⌫</span></button>
          {notice && <span className="notice" role="status">{notice}</span>}
        </footer>
      </section>
    </main>
  );
}
