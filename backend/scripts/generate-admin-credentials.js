import { randomBytes, randomInt, scryptSync } from 'node:crypto';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomString(length) {
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

const login = `nebe${randomString(8)}`;
const password = randomString(12);
const sessionSecret = randomBytes(32).toString('base64url');

console.log('Сохрани эти значения в Render → Environment. Пароль не добавляй в GitHub.');
console.log(`ADMIN_LOGIN=${login}`);
console.log(`ADMIN_PASSWORD=${password}`);
console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
console.log(`SESSION_SECRET=${sessionSecret}`);

