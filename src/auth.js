import crypto from "node:crypto";

export const SESSION_COOKIE = "lista_sid";
const SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pin, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPin(pin, stored) {
  const [scheme, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(String(pin), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function startSession(store, res, req, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  store.createSession(hashToken(token), userId);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  });
}

export function endSession(store, req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) store.deleteSession(hashToken(token));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function sessionUser(store, req) {
  const token = readCookie(req, SESSION_COOKIE);
  return token ? store.getSessionUser(hashToken(token)) ?? null : null;
}

// A 4-digit PIN is easy to guess, so failed attempts are capped per client IP.
export function createLoginLimiter({ maxFailures = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map();
  const entry = (key) => {
    const current = failures.get(key);
    if (!current || current.resetAt < Date.now()) {
      const fresh = { count: 0, resetAt: Date.now() + windowMs };
      failures.set(key, fresh);
      return fresh;
    }
    return current;
  };
  return {
    isBlocked: (key) => entry(key).count >= maxFailures,
    recordFailure: (key) => {
      entry(key).count += 1;
    },
    reset: (key) => failures.delete(key),
  };
}
