# Kick - Nebedolagy

A full-stack giveaway dashboard for Nebedolagy. The dashboard keeps the Kick channel fixed to `/nebedolagy` and the W.TV channel fixed to `/bedolagy`, reads both chats, adds each username only once when their message contains the configured keyword, and updates the dashboard in real time.

## Stack

- Backend: Node.js, Express, Socket.IO, native WebSocket via `ws`, SQLite via `better-sqlite3`
- Frontend: React + Vite + Socket.IO client

## Prerequisites

- Node.js 20 or later
- Network access to `kick.com` and `ws-us2.pusher.com`
- `curl` (used as a fallback when W.TV's CloudFront WAF blocks a Node request; it is already included on most Linux/macOS and modern Windows installations)

## Setup and run

1. Create the local environment file and adjust values only if needed:

   ```bash
   cp backend/.env.example backend/.env
   ```

2. Install all workspace dependencies from the repository root:

   ```bash
   npm install
   ```

3. Start the frontend and backend together:

   ```bash
   npm run dev
   ```

4. Open `http://localhost:5173`. The dashboard is preconfigured for `kick.com/nebedolagy` and `w.tv/bedolagy`; enter only an entry keyword, then select **Запустить эфир**.

The backend runs at `http://localhost:5000`. Vite proxies `/api` and `/socket.io` to it in development.

## Deploy to Render

The repository includes `render.yaml` for a single Render Web Service. Upload/connect the entire repository root (the folder containing `package.json`, `backend/`, `frontend/`, and `render.yaml`) to GitHub, then in Render choose **New → Blueprint** and select that repository. Render will use:

```text
Build Command: npm install && npm run build
Start Command: npm start
Health Check: /health
```

The backend serves the built React frontend from the same Render URL, so no separate frontend service is needed. Render automatically supplies `RENDER_EXTERNAL_URL`, which the backend uses for Socket.IO CORS. Set `WTV_CHAT_ID` in Render Environment only if the W.TV chat room UUID changes.

Do not upload or commit `node_modules/`, `frontend/dist/`, `backend/.env`, or `backend/raffle.sqlite`; they are ignored by `.gitignore`. Render creates dependencies and the frontend build during deployment. The free Render filesystem is temporary, so SQLite data can be lost after a restart or redeploy. For persistent SQLite on a paid service, attach a disk mounted at `/var/data` and set `SQLITE_FILE=/var/data/raffle.sqlite`.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/raffle/start` | Start/restart a raffle. The UI sends `{ "channel": "nebedolagy", "keyword": "!giveaway", "chatroomId": "123" }`; omitted channel defaults to `STREAMER_CHANNEL`. |
| `POST` | `/api/raffle/stop` | Stop the active Kick chat listener. |
| `GET` | `/api/raffle/participants` | List unique participants as `{ "username": "...", "source": "kick" | "wtv" }`. |
| `DELETE` | `/api/raffle/participants/:username` | Remove one participant from the list. |
| `POST` | `/api/raffle/draw` | Start the animated roll and select a random participant. The winner then has 45 seconds to send any chat message. |
| `POST` | `/api/raffle/reroll` | Select a different participant after the previous winner timed out. |
| `DELETE` | `/api/raffle/clear` | Remove all participant records. |
| `GET` | `/api/raffle/status` | Return current raffle state for UI initialization. |

Socket.IO emits `participants_update`, `winner_rolling`, `winner_selected`, `winner_confirmed`, `winner_timeout`, `winner_state`, and `status_update` to connected dashboards.

## Notes

- There is one active chat listener at a time. Starting another raffle stops the existing one first.
- Participant records persist in `backend/raffle.sqlite` until **Clear List** is used; this prevents an accidental reconnect or page refresh from losing entries.
- A selected winner must send any message in the monitored Kick or W.TV chat within 45 seconds. A successful message produces `ник — успел отписать!`; otherwise the dashboard offers a different **Реролл**.
- Channel and keyword are controlled from the UI/API. SQLite and the public realtime endpoint are configurable in `backend/.env`.
- This uses Kick's public, undocumented realtime transport instead of an official IRC service. It needs no Kick credentials, but Kick can change or restrict it at any time. For a production-critical integration, use Kick OAuth and `chat.message.sent` webhooks instead.
- W.TV messages are read from its public `GET` chat messages endpoint every two seconds. The `POST .../messages` request shown in browser developer tools is for sending a message and is not used by this app. `WTV_CHAT_ID` is the chat UUID for `w.tv/bedolagy`; update it if W.TV assigns a new chatroom. No W.TV cookies or login tokens are needed.
