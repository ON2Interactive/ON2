const crypto = require("crypto");

const COOKIE_NAME = "on2_admin_session";
const SESSION_MAX_AGE = 60 * 60 * 12;

function getEnv(name, fallback = "") {
  const value = String(process.env[name] || fallback).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const [key, ...valueParts] = part.split("=");
      if (!key) return cookies;
      cookies[key] = decodeURIComponent(valueParts.join("=") || "");
      return cookies;
    }, {});
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function signValue(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function createSessionCookie(username) {
  const secret = getEnv("SESSION_SECRET", "on2-interactive-session-secret");
  const payload = JSON.stringify({
    username,
    exp: Date.now() + SESSION_MAX_AGE * 1000,
  });
  const encoded = toBase64Url(payload);
  const signature = signValue(encoded, secret);
  const token = `${encoded}.${signature}`;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}; Secure`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Secure`;
}

function getSession(request) {
  const cookies = parseCookies(request.headers.cookie);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;

  const [encoded, signature] = String(raw).split(".");
  if (!encoded || !signature) return null;

  const secret = getEnv("SESSION_SECRET", "on2-interactive-session-secret");
  const expectedSignature = signValue(encoded, secret);
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encoded));
    if (!payload || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function isValidAdmin(username, password) {
  const adminUsername = getEnv("ADMIN_USERNAME").toLowerCase();
  const adminPassword = getEnv("ADMIN_PASSWORD");
  const normalizedUsername = String(username || "").trim().toLowerCase();
  const normalizedPassword = String(password || "").trim();
  return normalizedUsername === adminUsername && normalizedPassword === adminPassword;
}

function hasAdminCredentials() {
  return Boolean(getEnv("ADMIN_USERNAME") && getEnv("ADMIN_PASSWORD"));
}

function sendJson(response, status, payload, headers = {}) {
  response.status(status).set({
    "Cache-Control": "no-store",
    ...headers,
  });
  response.json(payload);
}

function requireAdmin(request, response) {
  const session = getSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Unauthorized." });
    return null;
  }
  return session;
}

module.exports = {
  clearSessionCookie,
  createSessionCookie,
  hasAdminCredentials,
  getSession,
  isValidAdmin,
  requireAdmin,
  sendJson,
};
