import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'nebe_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function base64Url(value) {
  return value.toString('base64url');
}

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, item) => {
    const separator = item.indexOf('=');
    if (separator < 0) return cookies;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = '';
      }
    }
    return cookies;
  }, {});
}

function passwordMatches(password, storedHash) {
  const [saltHex, keyHex] = String(storedHash || '').split(':');
  if (!saltHex || !keyHex || !password) return false;

  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function createPasswordHash(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

function createSession(login, secret) {
  const payload = base64Url(Buffer.from(JSON.stringify({
    sub: login,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000
  })));
  const signature = base64Url(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${signature}`;
}

function verifySession(token, secret) {
  if (!token || !secret) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

export function createAuth(config) {
  const login = config.auth.login;
  const password = config.auth.password;
  const passwordHash = config.auth.passwordHash || (password ? createPasswordHash(password) : '');
  const secret = config.auth.sessionSecret;

  function isConfigured() {
    return Boolean(login && passwordHash && secret);
  }

  function getSession(req) {
    return verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE], secret);
  }

  function requireAuth(req, res, next) {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Авторизация не настроена на сервере' });
    }
    if (!getSession(req)) return res.status(401).json({ error: 'Требуется вход в аккаунт' });
    return next();
  }

  function socketIsAuthorized(socket) {
    if (!isConfigured()) return false;
    return Boolean(verifySession(parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE], secret));
  }

  function loginUser(req, res) {
    if (!isConfigured()) return res.status(503).json({ error: 'Авторизация не настроена на сервере' });
    const candidateLogin = typeof req.body?.login === 'string' ? req.body.login : '';
    const candidatePassword = typeof req.body?.password === 'string' ? req.body.password : '';
    const candidateLoginBytes = Buffer.from(candidateLogin);
    const configuredLoginBytes = Buffer.from(login);
    const loginMatches = candidateLoginBytes.length === configuredLoginBytes.length && timingSafeEqual(candidateLoginBytes, configuredLoginBytes);
    if (!loginMatches || !passwordMatches(candidatePassword, passwordHash)) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const secure = process.env.NODE_ENV === 'production';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(createSession(login, secret))}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? '; Secure' : ''}`);
    return res.json({ success: true });
  }

  function logoutUser(_req, res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    return res.json({ success: true });
  }

  return { createPasswordHash, isConfigured, getSession, requireAuth, socketIsAuthorized, loginUser, logoutUser };
}
