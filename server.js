import http from "node:http";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { database as connectDatabase } from "./db/client.js";

const scrypt = promisify(crypto.scrypt);
const SESSION_SECONDS = 60 * 60 * 12;
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_LIMIT = 5;
const BODY_LIMIT = 64 * 1024;
const DUMMY_PASSWORD_HASH = (() => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(crypto.randomBytes(32), salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString("hex")}$${hash.toString("hex")}`;
})();
const capacitorOrigins = new Set([
  "http://localhost",
  "https://localhost",
  "capacitor://localhost",
  ...(process.env.CAPACITOR_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean),
]);
const configuredOrigins = new Set(
  (process.env.APP_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean),
);

function database() {
  if (!process.env.SESSION_PEPPER || process.env.SESSION_PEPPER.length < 32) {
    throw new Error("SESSION_PEPPER must contain at least 32 characters");
  }
  return connectDatabase();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function secureHash(value) {
  return crypto.createHmac("sha256", process.env.SESSION_PEPPER).update(value).digest();
}

function sameSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString("hex")}$${Buffer.from(derived).toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nText, rText, pText, saltHex, hashHex] = parts;
  const N = Number(nText), r = Number(rText), p = Number(pText);
  if (N !== 32768 || r !== 8 || p !== 1 || !/^[a-f0-9]{32}$/.test(saltHex) || !/^[a-f0-9]{128}$/.test(hashHex)) return false;
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, "hex"), 64, { N, r, p, maxmem: 64 * 1024 * 1024 }));
  const expected = Buffer.from(hashHex, "hex");
  return crypto.timingSafeEqual(actual, expected);
}

function originForRequest(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwarded || (req.socket?.encrypted ? "https" : "http");
  return `${protocol}://${req.headers.host}`;
}

function isAllowedOrigin(origin, req) {
  return !!origin && (origin === originForRequest(req) || configuredOrigins.has(origin) || capacitorOrigins.has(origin));
}

function cookieOptions(req, httpOnly) {
  const production = process.env.NODE_ENV === "production";
  const secure = production || originForRequest(req).startsWith("https://");
  return `Path=/; Max-Age=${SESSION_SECONDS}; SameSite=${secure ? "None" : "Lax"}${secure ? "; Secure" : ""}${httpOnly ? "; HttpOnly" : ""}`;
}

function appendCookie(res, name, value, options) {
  const current = res.getHeader("Set-Cookie");
  const next = `${name}=${encodeURIComponent(value)}; ${options}`;
  res.setHeader("Set-Cookie", current ? [...[].concat(current), next] : [next]);
}

function clearCookie(res, name, req, httpOnly) {
  appendCookie(res, name, "", `${cookieOptions(req, httpOnly).replace(/Max-Age=\d+/, "Max-Age=0")}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}

function readCookies(req) {
  const result = {};
  for (const item of String(req.headers.cookie || "").split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    const key = item.slice(0, index).trim();
    try { result[key] = decodeURIComponent(item.slice(index + 1).trim()); } catch { /* ignore malformed cookie */ }
  }
  return result;
}

function json(res, status, value, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    ...extraHeaders,
  });
  res.end(JSON.stringify(value));
}

async function requestBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

function cleanUser(row, viewer = row) {
  const result = {
    id: row.id,
    name: row.display_name,
    role: row.role,
    regionId: row.region_id,
    mustChangePassword: row.must_change_password,
  };
  if (viewer && (viewer.id === row.id || viewer.role === "super_admin" || viewer.role === "manager")) result.loginId = row.login_id;
  return result;
}

function safeRegion(row) {
  return { id: row.id, name: row.name, code: row.code, lat: row.latitude ?? null, lng: row.longitude ?? null };
}

function validUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRole(user, ...roles) {
  return roles.includes(user.role);
}

function safeReport(row, events = []) {
  return {
    ...row.extra_data,
    id: row.id,
    crn: row.crn,
    incidentType: row.incident_type,
    severity: row.severity,
    status: row.status === "completed" ? "done" : row.status,
    reporterName: row.reporter_name,
    reporterPhone: row.reporter_phone,
    phone: row.reporter_phone,
    address: row.customer_address,
    subscriptionNumber: row.subscription_number,
    regionId: row.region_id,
    region: row.region_id,
    createdById: row.created_by,
    createdBy: row.creator_name || row.extra_data?.createdBy || row.created_by,
    assigneeId: row.assignee_id,
    lat: row.latitude,
    lng: row.longitude,
    startedAt: row.started_at ? new Date(row.started_at).getTime() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).getTime() : null,
    opsCard: row.ops_card,
    version: row.version,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    timeline: events.map((event) => ({
      id: event.id,
      ts: new Date(event.occurred_at).getTime(),
      event: event.event_type,
      by: event.actor_name || "النظام",
      note: event.note,
    })),
  };
}

async function reportEvents(sql, ids) {
  if (!ids.length) return new Map();
  const events = await sql`
    SELECT e.id, e.report_id, e.event_type, e.note, e.occurred_at, u.display_name AS actor_name
    FROM report_events e
    LEFT JOIN app_users u ON u.id = e.actor_id
    WHERE e.report_id IN ${sql(ids)}
    ORDER BY e.occurred_at, e.id`;
  const byReport = new Map();
  for (const event of events) {
    const key = String(event.report_id);
    if (!byReport.has(key)) byReport.set(key, []);
    byReport.get(key).push(event);
  }
  return byReport;
}

function validSeverity(value) {
  return ["1", "2", "3"].includes(String(value));
}

function validStatus(value) {
  return ["new", "processing", "done", "completed", "cancelled"].includes(String(value));
}

function databaseStatus(value) {
  return String(value) === "done" ? "completed" : String(value);
}

function newReportNumber() {
  return `GAS-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

async function createSession(res, req, user) {
  const sql = database();
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);
  await sql`INSERT INTO auth_sessions (token_hash, csrf_token, user_id, expires_at) VALUES (${tokenHash}, ${csrf}, ${user.id}, ${expiresAt})`;
  appendCookie(res, "gas_session", token, cookieOptions(req, true));
  appendCookie(res, "gas_csrf", csrf, cookieOptions(req, false));
  return { user: cleanUser(user), csrf };
}

async function currentSession(req) {
  const cookies = readCookies(req);
  const token = cookies.gas_session;
  if (!token || token.length > 128) return null;
  const sql = database();
  const rows = await sql`
    SELECT s.token_hash, s.csrf_token, u.id, u.display_name, u.login_id, u.role,
           u.region_id, u.must_change_password
    FROM auth_sessions s
    JOIN app_users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha256(token)}
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
      AND u.is_active = true
    LIMIT 1`;
  if (!rows.length) return null;
  return { user: rows[0], csrf: rows[0].csrf_token, tokenHash: rows[0].token_hash };
}

async function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!isAllowedOrigin(origin, req)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, X-Initial-Setup-Token");
  res.setHeader("Vary", "Origin");
  return true;
}

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase().slice(0, 120);
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim().slice(0, 80);
}

async function failLogin(identity, ip) {
  const sql = database();
  const identityHash = secureHash(`login:${identity}`);
  const ipHash = secureHash(`ip:${ip}`);
  await sql`
    INSERT INTO login_attempts (identity_hash, ip_hash, window_started_at, failure_count, updated_at)
    VALUES (${identityHash}, ${ipHash}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT (identity_hash, ip_hash) DO UPDATE SET
      failure_count = CASE
        WHEN login_attempts.window_started_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-15 minutes') THEN 1
        ELSE login_attempts.failure_count + 1
      END,
      window_started_at = CASE
        WHEN login_attempts.window_started_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-15 minutes') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now')
        ELSE login_attempts.window_started_at
      END,
      locked_until = CASE
        WHEN login_attempts.window_started_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-15 minutes') THEN NULL
        WHEN login_attempts.failure_count + 1 >= ${LOGIN_LIMIT} THEN strftime('%Y-%m-%dT%H:%M:%fZ','now', '+15 minutes')
        ELSE login_attempts.locked_until
      END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
}

export async function handler(req, res) {
  const requestUrl = new URL(req.url, originForRequest(req));
  const path = requestUrl.pathname.replace(/\/+$/, "") || "/";
  const method = req.method || "GET";
  if (!await applyCors(req, res)) return json(res, 403, { error: "Origin is not allowed" });
  if (method === "OPTIONS") {
    res.writeHead(204, { "Cache-Control": "no-store" });
    return res.end();
  }
  if (!path.startsWith("/api/")) return json(res, 404, { error: "Not found" });

  try {
    const sql = database();
    if (path === "/api/health" && method === "GET") {
      await sql`SELECT 1`;
      return json(res, 200, { ok: true });
    }

    if (path === "/api/auth/status" && method === "GET") {
      const rows = await sql`SELECT EXISTS (SELECT 1 FROM app_users WHERE role = 'super_admin') AS ready`;
      return json(res, 200, { setupComplete: Boolean(rows[0].ready) });
    }

    if (path === "/api/auth/setup" && method === "POST") {
      const configuredToken = process.env.INITIAL_SETUP_TOKEN;
      const providedToken = String(req.headers["x-initial-setup-token"] || "");
      if (!configuredToken || configuredToken.length < 32 || !sameSecret(configuredToken, providedToken)) {
        return json(res, 403, { error: "Initial setup is unavailable" });
      }
      const body = await requestBody(req);
      const name = String(body.name || "").trim().slice(0, 120);
      const loginId = normalizeLogin(body.loginId);
      const password = String(body.password || "");
      if (!name || !/^[\p{L}\p{N}._-]{3,60}$/u.test(loginId) || password.length < 12 || password.length > 200) {
        return json(res, 400, { error: "Use a valid login name and a password of at least 12 characters" });
      }
      const passwordHash = await hashPassword(password);
      const created = await sql.begin(async (tx) => {
        const existing = await tx`SELECT id FROM app_users WHERE role = 'super_admin' LIMIT 1`;
        if (existing.length) return null;
        const rows = await tx`
          INSERT INTO app_users (id, display_name, login_id, password_hash, role)
          VALUES (${crypto.randomUUID()}, ${name}, ${loginId}, ${passwordHash}, 'super_admin')
          RETURNING id, display_name, login_id, role, region_id, must_change_password`;
        return rows[0];
      });
      if (!created) return json(res, 409, { error: "Initial setup has already been completed" });
      const session = await createSession(res, req, created);
      await sql`INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES (${created.id}, 'initial_setup', 'user', ${created.id})`;
      return json(res, 201, session);
    }

    if (path === "/api/auth/login" && method === "POST") {
      const body = await requestBody(req);
      const identity = normalizeLogin(body.loginId);
      const password = String(body.password || "");
      if (!identity || !password || password.length > 200) return json(res, 400, { error: "Enter your login and password" });
      const identityHash = secureHash(`login:${identity}`);
      const ipHash = secureHash(`ip:${clientIp(req)}`);
      const lock = await sql`
        SELECT locked_until FROM login_attempts
        WHERE identity_hash = ${identityHash} AND ip_hash = ${ipHash} AND locked_until > now()
        LIMIT 1`;
      if (lock.length) return json(res, 429, { error: "Too many attempts. Try again later." }, { "Retry-After": "900" });
      const users = await sql`SELECT * FROM app_users WHERE login_id = ${identity} AND is_active = true LIMIT 1`;
      const user = users[0];
      const valid = await verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
      if (!user || !valid) {
        await failLogin(identity, clientIp(req));
        return json(res, 401, { error: "Login or password is incorrect" });
      }
      await sql`DELETE FROM login_attempts WHERE identity_hash = ${identityHash} AND ip_hash = ${ipHash}`;
      const session = await createSession(res, req, user);
      await sql`INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES (${user.id}, 'login', 'user', ${user.id})`;
      return json(res, 200, session);
    }

    const session = await currentSession(req);
    if (!session) return json(res, 401, { error: "Authentication required" });

    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const suppliedCsrf = req.headers["x-csrf-token"];
      if (!sameSecret(session.csrf, suppliedCsrf)) return json(res, 403, { error: "Invalid CSRF token" });
    }

    if (path === "/api/auth/password" && method === "POST") {
      const body = await requestBody(req);
      const currentPassword = String(body.currentPassword || "");
      const newPassword = String(body.newPassword || "");
      if (newPassword.length < 12 || newPassword.length > 200) return json(res, 400, { error: "New password must contain at least 12 characters" });
      const rows = await sql`SELECT password_hash FROM app_users WHERE id = ${session.user.id} AND is_active = true LIMIT 1`;
      if (!rows.length || !await verifyPassword(currentPassword, rows[0].password_hash)) return json(res, 401, { error: "Current password is incorrect" });
      const passwordHash = await hashPassword(newPassword);
      await sql.begin(async (tx) => {
        await tx`UPDATE app_users SET password_hash = ${passwordHash}, must_change_password = false, updated_at = now() WHERE id = ${session.user.id}`;
        await tx`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = ${session.user.id} AND token_hash <> ${session.tokenHash} AND revoked_at IS NULL`;
        await tx`INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES (${session.user.id}, 'change_password', 'user', ${session.user.id})`;
      });
      return json(res, 200, { ok: true });
    }

    if (path === "/api/users" && method === "GET") {
      if (!isRole(session.user, "super_admin", "manager")) return json(res, 403, { error: "Insufficient permission" });
      const rows = await sql`SELECT id, display_name, login_id, role, region_id, must_change_password FROM app_users WHERE is_active = true ORDER BY display_name, id`;
      return json(res, 200, rows.map((row) => cleanUser(row, session.user)));
    }

    if (path === "/api/users" && method === "POST") {
      if (!isRole(session.user, "super_admin")) return json(res, 403, { error: "Insufficient permission" });
      const body = await requestBody(req);
      const name = String(body.name || "").trim().slice(0, 120);
      const loginId = normalizeLogin(body.loginId);
      const password = String(body.password || "");
      const role = String(body.role || "");
      const regionId = body.regionId || null;
      if (!name || !/^[\p{L}\p{N}._-]{3,60}$/u.test(loginId) || password.length < 12 || password.length > 200 || !["manager", "response", "observer", "reporter"].includes(role)) {
        return json(res, 400, { error: "Provide a valid name, login, role, and password of at least 12 characters" });
      }
      if (regionId && !validUuid(regionId)) return json(res, 400, { error: "Invalid region" });
      const passwordHash = await hashPassword(password);
      const rows = await sql`
        INSERT INTO app_users (id, display_name, login_id, password_hash, role, region_id)
        VALUES (${crypto.randomUUID()}, ${name}, ${loginId}, ${passwordHash}, ${role}, ${regionId})
        RETURNING id, display_name, login_id, role, region_id, must_change_password`;
      await sql`INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES (${session.user.id}, 'create', 'user', ${rows[0].id})`;
      return json(res, 201, cleanUser(rows[0], session.user));
    }

    const userPath = path.match(/^\/api\/users\/([0-9a-f-]{36})$/i);
    if (userPath && method === "PATCH") {
      if (!isRole(session.user, "super_admin")) return json(res, 403, { error: "Insufficient permission" });
      const body = await requestBody(req);
      const allowedRoles = ["manager", "response", "observer", "reporter"];
      if (body.role !== undefined && !allowedRoles.includes(body.role)) return json(res, 400, { error: "Invalid role" });
      if (body.regionId != null && !validUuid(body.regionId)) return json(res, 400, { error: "Invalid region" });
      const rows = await sql`
        UPDATE app_users SET
          display_name = COALESCE(${body.name === undefined ? null : String(body.name).trim().slice(0, 120)}, display_name),
          role = COALESCE(${body.role || null}, role),
          region_id = CASE WHEN ${body.regionId === undefined} THEN region_id ELSE ${body.regionId}::uuid END,
          updated_at = now()
        WHERE id = ${userPath[1]} AND is_active = true
        RETURNING id, display_name, login_id, role, region_id, must_change_password`;
      if (!rows.length) return json(res, 404, { error: "User not found" });
      await sql`INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES (${session.user.id}, 'update', 'user', ${rows[0].id})`;
      return json(res, 200, cleanUser(rows[0], session.user));
    }
    if (userPath && method === "DELETE") {
      if (!isRole(session.user, "super_admin")) return json(res, 403, { error: "Insufficient permission" });
      if (userPath[1] === session.user.id) return json(res, 400, { error: "You cannot deactivate your own account" });
      const rows = await sql`UPDATE app_users SET is_active = false, updated_at = now() WHERE id = ${userPath[1]} AND is_active = true RETURNING id`;
      if (!rows.length) return json(res, 404, { error: "User not found" });
      await sql`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = ${rows[0].id} AND revoked_at IS NULL`;
      await sql`INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES (${session.user.id}, 'deactivate', 'user', ${rows[0].id})`;
      return json(res, 200, { ok: true });
    }

    if (path === "/api/regions" && method === "GET") {
      const rows = await sql`SELECT id, name, code, latitude, longitude FROM regions ORDER BY name, id`;
      return json(res, 200, rows.map(safeRegion));
    }
    if (path === "/api/regions" && method === "POST") {
      if (!isRole(session.user, "super_admin", "manager")) return json(res, 403, { error: "Insufficient permission" });
      const body = await requestBody(req);
      const name = String(body.name || "").trim().slice(0, 120);
      const code = String(body.code || "").trim().toUpperCase().slice(0, 40);
      if (!name || !/^[A-Z0-9_-]{2,40}$/.test(code)) return json(res, 400, { error: "Enter a region name and a valid region code" });
      const lat = body.lat == null || body.lat === "" ? null : Number(body.lat);
      const lng = body.lng == null || body.lng === "" ? null : Number(body.lng);
      if ((lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) || (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) || ((lat === null) !== (lng === null))) return json(res, 400, { error: "Invalid region coordinates" });
      const id = validUuid(body.id) ? body.id : crypto.randomUUID();
      const rows = await sql`INSERT INTO regions (id, name, code, latitude, longitude) VALUES (${id}, ${name}, ${code}, ${lat}, ${lng}) RETURNING id, name, code, latitude, longitude`;
      await sql`INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES (${session.user.id}, 'create', 'region', ${rows[0].id})`;
      return json(res, 201, safeRegion(rows[0]));
    }

    if (path === "/api/settings" && method === "GET") {
      const rows = await sql`SELECT value FROM app_settings WHERE key = 'system' LIMIT 1`;
      return json(res, 200, rows[0]?.value ?? null);
    }
    if (path === "/api/settings" && method === "PUT") {
      if (!isRole(session.user, "super_admin")) return json(res, 403, { error: "Insufficient permission" });
      const body = await requestBody(req);
      const settings = body && typeof body === "object" && !Array.isArray(body) ? body : null;
      if (!settings) return json(res, 400, { error: "Invalid settings" });
      await sql`INSERT INTO app_settings (key, value, updated_by, updated_at)
        VALUES ('system', ${sql.json(settings)}, ${session.user.id}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      await sql`INSERT INTO audit_log (actor_id, action, entity_type) VALUES (${session.user.id}, 'update', 'settings')`;
      return json(res, 200, settings);
    }

    if (path === "/api/alerts" && method === "GET") {
      const rows = await sql`SELECT id, message, created_at FROM alerts WHERE dismissed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 100`;
      return json(res, 200, rows.map((row) => ({ id: row.id, text: row.message, ts: new Date(row.created_at).getTime() })));
    }
    if (path === "/api/alerts" && method === "POST") {
      const body = await requestBody(req);
      const message = String(body.text || "").trim().slice(0, 1000);
      if (!message) return json(res, 400, { error: "Alert text is required" });
      const id = validUuid(body.id) ? body.id : crypto.randomUUID();
      const rows = await sql`INSERT INTO alerts (id, message, created_by) VALUES (${id}, ${message}, ${session.user.id}) RETURNING id, message, created_at`;
      return json(res, 201, { id: rows[0].id, text: rows[0].message, ts: new Date(rows[0].created_at).getTime() });
    }
    if (path === "/api/alerts" && method === "DELETE") {
      if (!isRole(session.user, "super_admin", "manager")) return json(res, 403, { error: "Insufficient permission" });
      await sql`UPDATE alerts SET dismissed_at = now() WHERE dismissed_at IS NULL`;
      await sql`INSERT INTO audit_log (actor_id, action, entity_type) VALUES (${session.user.id}, 'dismiss_all', 'alerts')`;
      return json(res, 200, { ok: true });
    }

    if (path === "/api/reports/summary" && method === "GET") {
      const rows = await sql`
        SELECT CASE WHEN status = 'completed' THEN 'done' ELSE status END AS status,
               severity, count(*)::integer AS count
        FROM reports
        WHERE deleted_at IS NULL
          AND (${session.user.role !== "reporter"} OR created_by = ${session.user.id})
          AND (${session.user.role !== "response"} OR region_id = ${session.user.region_id})
        GROUP BY status, severity`;
      return json(res, 200, rows);
    }

    if (path === "/api/reports" && method === "GET") {
      const limit = Math.min(100, Math.max(1, Number(requestUrl.searchParams.get("limit")) || 50));
      const status = requestUrl.searchParams.get("status");
      const severity = requestUrl.searchParams.get("severity");
      const regionFilter = requestUrl.searchParams.get("regionId");
      if (status && !validStatus(status)) return json(res, 400, { error: "Invalid status filter" });
      const filteredStatus = status ? databaseStatus(status) : null;
      if (severity && !validSeverity(severity)) return json(res, 400, { error: "Invalid severity filter" });
      if (regionFilter && !/^[0-9a-f-]{36}$/i.test(regionFilter)) return json(res, 400, { error: "Invalid region filter" });
      let cursorTime = null, cursorId = null;
      const cursor = requestUrl.searchParams.get("cursor");
      if (cursor) {
        try {
          const [timeText, idText] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
          if (!Number.isFinite(Date.parse(timeText)) || !/^[0-9a-f-]{36}$/i.test(idText)) throw new Error();
          cursorTime = new Date(timeText);
          cursorId = idText;
        } catch { return json(res, 400, { error: "Invalid page cursor" }); }
      }
      const restrictRegion = session.user.role === "response";
      const rows = await sql`
        SELECT * FROM reports
        WHERE deleted_at IS NULL
          AND (${session.user.role !== "reporter"} OR created_by = ${session.user.id})
          AND (NOT ${restrictRegion} OR region_id = ${session.user.region_id})
          AND (${filteredStatus} IS NULL OR status = ${filteredStatus})
          AND (${severity} IS NULL OR severity = ${severity})
          AND (${regionFilter} IS NULL OR region_id = ${regionFilter})
          AND (${cursorTime} IS NULL OR created_at < ${cursorTime} OR (created_at = ${cursorTime} AND id < ${cursorId}))
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}`;
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const events = await reportEvents(sql, rows.map((row) => row.id));
      const next = hasMore && rows.length
        ? Buffer.from(`${new Date(rows.at(-1).created_at).toISOString()}|${rows.at(-1).id}`).toString("base64url")
        : null;
      return json(res, 200, { items: rows.map((row) => safeReport(row, events.get(String(row.id)) || [])), nextCursor: next });
    }

    if (path === "/api/reports" && method === "POST") {
      if (!isRole(session.user, "super_admin", "manager", "response", "reporter")) return json(res, 403, { error: "Insufficient permission" });
      const body = await requestBody(req);
      const reporterName = String(body.reporterName || "").trim().slice(0, 160);
      const incidentType = String(body.incidentType || "").trim().slice(0, 120);
      const severity = String(body.severity || "");
      if (!reporterName || !incidentType || !validSeverity(severity)) return json(res, 400, { error: "Report name, incident type, and severity are required" });
      const regionId = ["reporter", "response"].includes(session.user.role)
        ? session.user.region_id
        : (body.regionId || body.region || null);
      if (["reporter", "response"].includes(session.user.role) && !regionId) {
        return json(res, 403, { error: "Your account must be assigned to a region" });
      }
      const crn = String(body.crn || newReportNumber()).trim().slice(0, 80);
      const id = validUuid(body.id) ? body.id : crypto.randomUUID();
      const extraData = body.extraData && typeof body.extraData === "object" && !Array.isArray(body.extraData) ? { ...body.extraData } : {};
      for (const key of ["details", "comments", "assignee", "reportSenderName", "createdBy", "escalatedAt", "geocoded", "location"]) {
        if (body[key] !== undefined) extraData[key] = body[key];
      }
      const opsCard = body.opsCard && typeof body.opsCard === "object" && !Array.isArray(body.opsCard) ? body.opsCard : {};
      const created = await sql.begin(async (tx) => {
        const rows = await tx`
          INSERT INTO reports (id, crn, incident_type, severity, reporter_name, reporter_phone,
            customer_address, subscription_number, region_id, created_by, latitude, longitude,
            ops_card, extra_data)
          VALUES (${id}, ${crn}, ${incidentType}, ${severity}, ${reporterName}, ${String(body.reporterPhone || body.phone || "").trim().slice(0, 40) || null},
            ${String(body.address || "").trim().slice(0, 500) || null}, ${String(body.subscriptionNumber || body.subscriberNumber || "").trim().slice(0, 80) || null},
            ${regionId}, ${session.user.id}, ${Number.isFinite(Number(body.lat ?? body.location?.lat)) ? Number(body.lat ?? body.location.lat) : null},
            ${Number.isFinite(Number(body.lng ?? body.location?.lng)) ? Number(body.lng ?? body.location.lng) : null}, ${tx.json(opsCard)}, ${tx.json(extraData)})
          RETURNING *`;
        const row = rows[0];
        await tx`INSERT INTO report_events (id, report_id, actor_id, event_type) VALUES (${crypto.randomUUID()}, ${row.id}, ${session.user.id}, 'تسجيل البلاغ')`;
        await tx`INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES (${session.user.id}, 'create', 'report', ${row.id})`;
        return row;
      });
      const events = await reportEvents(sql, [created.id]);
      return json(res, 201, safeReport(created, events.get(String(created.id)) || []));
    }

    if (path === "/api/reports" && method === "DELETE") {
      if (!isRole(session.user, "super_admin")) return json(res, 403, { error: "Insufficient permission" });
      const rows = await sql`UPDATE reports SET deleted_at = now(), updated_at = now(), version = version + 1 WHERE deleted_at IS NULL RETURNING id`;
      await sql`INSERT INTO audit_log (actor_id, action, entity_type, details) VALUES (${session.user.id}, 'delete_all', 'report', ${sql.json({ count: rows.length })})`;
      return json(res, 200, { ok: true, count: rows.length });
    }

    const reportPath = path.match(/^\/api\/reports\/([0-9a-f-]{36})$/i);
    if (reportPath && method === "GET") {
      const rows = await sql`SELECT r.*, u.display_name AS creator_name FROM reports r LEFT JOIN app_users u ON u.id = r.created_by WHERE r.id = ${reportPath[1]} AND r.deleted_at IS NULL LIMIT 1`;
      const row = rows[0];
      if (!row) return json(res, 404, { error: "Report not found" });
      if (session.user.role === "reporter" && row.created_by !== session.user.id) return json(res, 404, { error: "Report not found" });
      if (session.user.role === "response" && row.region_id !== session.user.region_id) return json(res, 404, { error: "Report not found" });
      const events = await reportEvents(sql, [row.id]);
      return json(res, 200, safeReport(row, events.get(String(row.id)) || []));
    }

    if (reportPath && ["PATCH", "PUT"].includes(method)) {
      const body = await requestBody(req);
      if (!Number.isInteger(Number(body.expectedVersion)) || Number(body.expectedVersion) < 1) return json(res, 400, { error: "A report version is required" });
      const result = await sql.begin(async (tx) => {
        const rows = await tx`
          SELECT * FROM reports
          WHERE id = ${reportPath[1]} AND deleted_at IS NULL
            AND (${session.user.role !== "response"} OR region_id = ${session.user.region_id})
          FOR UPDATE`;
        const current = rows[0];
        if (!current) return { error: "not_found" };
        if (Number(current.version) !== Number(body.expectedVersion)) return { error: "conflict" };
        const mayManage = isRole(session.user, "super_admin", "manager", "response");
        const ownReporterUpdate = session.user.role === "reporter" && current.created_by === session.user.id && current.status === "new";
        if (!mayManage && !ownReporterUpdate) return { error: "forbidden" };
        const status = body.status === undefined ? current.status : databaseStatus(body.status);
        const severity = body.severity === undefined ? current.severity : String(body.severity);
        if (!validStatus(status) || !validSeverity(severity)) return { error: "invalid" };
        const opsCard = body.opsCard === undefined ? current.ops_card : body.opsCard;
        const extraData = body.extraData === undefined ? current.extra_data : body.extraData;
        if (!opsCard || typeof opsCard !== "object" || Array.isArray(opsCard) || !extraData || typeof extraData !== "object" || Array.isArray(extraData)) return { error: "invalid" };
        const setTime = (value, fallback) => value === undefined ? fallback : value === null ? null : new Date(value);
        const rowsAfter = await tx`
          UPDATE reports SET
            incident_type = ${body.incidentType === undefined ? current.incident_type : String(body.incidentType).trim().slice(0, 120)},
            severity = ${severity}, status = ${status},
            reporter_name = ${body.reporterName === undefined ? current.reporter_name : String(body.reporterName).trim().slice(0, 160)},
            reporter_phone = ${body.reporterPhone === undefined ? current.reporter_phone : String(body.reporterPhone).trim().slice(0, 40) || null},
            customer_address = ${body.address === undefined ? current.customer_address : String(body.address).trim().slice(0, 500) || null},
            subscription_number = ${body.subscriptionNumber === undefined && body.subscriberNumber === undefined ? current.subscription_number : String(body.subscriptionNumber ?? body.subscriberNumber).trim().slice(0, 80) || null},
            region_id = ${body.regionId === undefined && body.region === undefined ? current.region_id : (body.regionId ?? body.region) || null},
            assignee_id = ${body.assigneeId === undefined ? current.assignee_id : body.assigneeId},
            started_at = ${setTime(body.startedAt, current.started_at)},
            completed_at = ${setTime(body.completedAt, current.completed_at)},
            ops_card = ${tx.json(opsCard)}, extra_data = ${tx.json(extraData)},
            version = version + 1, updated_at = now()
          WHERE id = ${reportPath[1]}
          RETURNING *`;
        const updated = rowsAfter[0];
        if (body.eventType) {
          await tx`INSERT INTO report_events (id, report_id, actor_id, event_type, note) VALUES (${crypto.randomUUID()}, ${updated.id}, ${session.user.id}, ${String(body.eventType).slice(0, 120)}, ${String(body.eventNote || "").slice(0, 1000)})`;
        }
        await tx`INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details) VALUES (${session.user.id}, 'update', 'report', ${updated.id}, ${tx.json({ version: updated.version })})`;
        return { updated };
      });
      if (result.error === "not_found") return json(res, 404, { error: "Report not found" });
      if (result.error === "conflict") return json(res, 409, { error: "This report changed elsewhere. Refresh and retry." });
      if (result.error === "forbidden") return json(res, 403, { error: "Insufficient permission" });
      if (result.error === "invalid") return json(res, 400, { error: "Invalid report update" });
      const events = await reportEvents(sql, [result.updated.id]);
      return json(res, 200, safeReport(result.updated, events.get(String(result.updated.id)) || []));
    }

    if (reportPath && method === "DELETE") {
      if (!isRole(session.user, "super_admin", "manager")) return json(res, 403, { error: "Insufficient permission" });
      const rows = await sql`UPDATE reports SET deleted_at = now(), updated_at = now(), version = version + 1 WHERE id = ${reportPath[1]} AND deleted_at IS NULL RETURNING id`;
      if (!rows.length) return json(res, 404, { error: "Report not found" });
      await sql`INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES (${session.user.id}, 'delete', 'report', ${rows[0].id})`;
      return json(res, 200, { ok: true });
    }

    if (path === "/api/auth/me" && method === "GET") {
      await sql`UPDATE auth_sessions SET last_seen_at = now() WHERE token_hash = ${session.tokenHash}`;
      return json(res, 200, { user: cleanUser(session.user), csrf: session.csrf });
    }

    if (path === "/api/auth/logout" && method === "POST") {
      await sql`UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = ${session.tokenHash}`;
      clearCookie(res, "gas_session", req, true);
      clearCookie(res, "gas_csrf", req, false);
      await sql`INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES (${session.user.id}, 'logout', 'user', ${session.user.id})`;
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("API request failed", { path, method, name: error?.name || "Error" });
    return json(res, status, { error: status >= 500 ? "Service temporarily unavailable" : error.message });
  }
}

export default handler;

if (process.env.NODE_ENV !== "production" && process.argv[1]?.replaceAll("\\", "/").endsWith("/server.js")) {
  const port = Number(process.env.PORT || 3001);
  http.createServer(handler).listen(port, "127.0.0.1", () => console.log(`API listening on 127.0.0.1:${port}`));
}

