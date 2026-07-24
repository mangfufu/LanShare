const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn, execSync } = require("child_process");
const { URL } = require("url");
const { DatabaseSync } = require("node:sqlite");

// 自动安装依赖
function ensureDeps() {
  const deps = ["busboy", "archiver", "sharp", "mammoth", "sanitize-html"];
  const missing = [];
  for (const dep of deps) {
    try { require.resolve(dep); } catch { missing.push(dep); }
  }
  if (missing.length > 0) {
    console.log(`正在安装缺失依赖: ${missing.join(", ")}...`);
    try {
      execSync(`npm install ${missing.join(" ")}`, { cwd: __dirname, stdio: "inherit" });
      console.log("依赖安装完成");
    } catch (e) {
      console.error("依赖安装失败:", e.message);
      process.exit(1);
    }
  }
}
ensureDeps();

const Busboy = require("busboy");
const archiver = require("archiver");
const mammoth = require("mammoth");
const sanitizeHtml = require("sanitize-html");
let sharp;
try { sharp = require("sharp"); } catch { console.error("错误: sharp 未安装"); process.exit(1); }
const TMP_DIR = path.resolve(process.env.THUMB_CACHE_DIR || path.join(__dirname, "thumb_cache"));
const NSFW_DIR = path.resolve(process.env.NSFW_DIR || path.join(__dirname, "shared_NSFW"));
const NSFW_PASSWORD_FILE = path.resolve(process.env.NSFW_PASSWORD_FILE || path.join(__dirname, "nsfw_password.txt"));
let nsfwPassword = "";
async function loadNsfwPassword() {
  try { nsfwPassword = (await fsp.readFile(NSFW_PASSWORD_FILE, "utf8")).trim(); } catch { nsfwPassword = ""; }
}
// 每个请求设置 NSFW 模式标记
function setNsfwMode(req) {
  try {
    req._nsfwMode = (new URL(req.url, "http://localhost")).searchParams.get("nsfw") === "1";
  } catch(e) { req._nsfwMode = false; }
}
function _root(req) { return (req && req._nsfwMode) ? NSFW_DIR : ROOT_DIR; }

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);
const ROOT_DIR = path.resolve(process.env.SHARED_DIR || path.join(__dirname, "shared"));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, "backup"));
const DAILY_BACKUP_DIR = path.join(BACKUP_DIR, "daily");
const RECYCLE_DIR = path.resolve(process.env.RECYCLE_DIR || path.join(__dirname, "recycle_bin"));
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(__dirname, "logs"));
const STATIC_DIR = path.join(__dirname, "static");
const FOLDER_SIZE_CACHE_FILE = path.resolve(process.env.FOLDER_SIZE_CACHE_FILE || path.join(__dirname, "folder_size_cache.json"));
const FORUM_DB_FILE = path.resolve(process.env.FORUM_DB_FILE || path.join(__dirname, "forum.db"));
const AUTH_DB_FILE = path.resolve(process.env.AUTH_DB_FILE || path.join(__dirname, "auth.db"));
const MAX_BODY_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 8 * 1024 * 1024 * 1024);

const PER_UPLOAD_BACKUP_ENABLED = process.env.PER_UPLOAD_BACKUP_ENABLED === "1";
const DAILY_BACKUP_ENABLED = process.env.DAILY_BACKUP_ENABLED === "1";
const configuredDailyBackupHour = Number(process.env.DAILY_BACKUP_HOUR);
const configuredDailyBackupMinute = Number(process.env.DAILY_BACKUP_MINUTE);
const DAILY_BACKUP_HOUR = Number.isInteger(configuredDailyBackupHour) && configuredDailyBackupHour >= 0 && configuredDailyBackupHour <= 23
  ? configuredDailyBackupHour
  : 23;
const DAILY_BACKUP_MINUTE = Number.isInteger(configuredDailyBackupMinute) && configuredDailyBackupMinute >= 0 && configuredDailyBackupMinute <= 59
  ? configuredDailyBackupMinute
  : 55;
const DAILY_BACKUP_RUN_ON_START = process.env.DAILY_BACKUP_RUN_ON_START === "1";
const BATCH_DOWNLOAD_TTL_MS = 30 * 60 * 1000;
const RECYCLE_RETENTION_DAYS = Number(process.env.RECYCLE_RETENTION_DAYS || 7);
const RECYCLE_CLEANUP_INTERVAL_MS = Number(process.env.RECYCLE_CLEANUP_INTERVAL_MS || 60 * 60 * 1000);
const MAX_THUMB_SOURCE_SIZE = Number(process.env.MAX_THUMB_SOURCE_SIZE || 128 * 1024 * 1024);
const MAX_VIDEO_THUMB_JOBS = Number(process.env.MAX_VIDEO_THUMB_JOBS || 1);
const MAX_FOLDER_SIZE_DEPTH = Number(process.env.MAX_FOLDER_SIZE_DEPTH || 64);
const MAX_FOLDER_SIZE_JOBS = Number(process.env.MAX_FOLDER_SIZE_JOBS || 1);
const FOLDER_SIZE_CACHE_MAX_AGE_MS = Number(process.env.FOLDER_SIZE_CACHE_MAX_AGE_MS || 24 * 60 * 60 * 1000);
const FOLDER_SIZE_CACHE_SAVE_DELAY_MS = 1000;
const THUMB_CACHE_CLEANUP_INTERVAL_MS = Number(process.env.THUMB_CACHE_CLEANUP_INTERVAL_MS || 6 * 60 * 60 * 1000);
const THUMB_CACHE_MAX_AGE_DAYS = Number(process.env.THUMB_CACHE_MAX_AGE_DAYS || 30);
const THUMB_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const configuredMediaInfoTimeoutMs = Number(process.env.MEDIA_INFO_TIMEOUT_MS);
const MEDIA_INFO_TIMEOUT_MS = Number.isFinite(configuredMediaInfoTimeoutMs) && configuredMediaInfoTimeoutMs >= 1000
  ? configuredMediaInfoTimeoutMs
  : 15 * 1000;
const configuredMediaInfoCacheLimit = Number(process.env.MEDIA_INFO_CACHE_LIMIT);
const MEDIA_INFO_CACHE_LIMIT = Number.isFinite(configuredMediaInfoCacheLimit) && configuredMediaInfoCacheLimit > 0
  ? Math.floor(configuredMediaInfoCacheLimit)
  : 500;
const configuredDocumentPreviewMaxSize = Number(process.env.DOCUMENT_PREVIEW_MAX_SIZE);
const DOCUMENT_PREVIEW_MAX_SIZE = Number.isFinite(configuredDocumentPreviewMaxSize) && configuredDocumentPreviewMaxSize > 0
  ? Math.floor(configuredDocumentPreviewMaxSize)
  : 64 * 1024 * 1024;
const configuredDocumentPreviewMaxHtmlSize = Number(process.env.DOCUMENT_PREVIEW_MAX_HTML_SIZE);
const DOCUMENT_PREVIEW_MAX_HTML_SIZE = Number.isFinite(configuredDocumentPreviewMaxHtmlSize) && configuredDocumentPreviewMaxHtmlSize > 0
  ? Math.floor(configuredDocumentPreviewMaxHtmlSize)
  : 24 * 1024 * 1024;
const configuredDocumentPreviewCacheLimit = Number(process.env.DOCUMENT_PREVIEW_CACHE_LIMIT);
const DOCUMENT_PREVIEW_CACHE_LIMIT = Number.isFinite(configuredDocumentPreviewCacheLimit) && configuredDocumentPreviewCacheLimit > 0
  ? Math.floor(configuredDocumentPreviewCacheLimit)
  : 32;
const configuredDocumentPreviewCacheMaxBytes = Number(process.env.DOCUMENT_PREVIEW_CACHE_MAX_BYTES);
const DOCUMENT_PREVIEW_CACHE_MAX_BYTES = Number.isFinite(configuredDocumentPreviewCacheMaxBytes) && configuredDocumentPreviewCacheMaxBytes > 0
  ? Math.floor(configuredDocumentPreviewCacheMaxBytes)
  : 128 * 1024 * 1024;
const batchDownloads = new Map();
const logBuffer = [];
const MAX_LOG_BUFFER = 200;
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB per file
let workspaceActivityCache = null;
const videoThumbQueue = [];
const videoThumbJobs = new Map();
const mediaInfoCache = new Map();
const mediaInfoJobs = new Map();
const documentPreviewCache = new Map();
const documentPreviewJobs = new Map();
let documentPreviewCacheBytes = 0;
let activeVideoThumbJobs = 0;
const folderSizeCache = new Map();
const folderSizeQueue = [];
const queuedFolderSizePaths = new Set();
let activeFolderSizeJobs = 0;
let folderSizeCacheSaveTimer = null;
let dailyBackupTimer = null;
let dailyBackupRunning = false;
const CSRF_TOKEN = crypto.randomBytes(32).toString("hex");
const NSFW_SESSION_COOKIE = "lanshare_nsfw_session";
const FORUM_OWNER_COOKIE = "lanshare_forum_owner";
// Cookie 本身不支持按端口隔离。测试版（8082）和正式版（8080）使用不同名称，
// 避免在同一浏览器里互相覆盖登录状态。
const AUTH_SESSION_COOKIE = process.env.AUTH_SESSION_COOKIE || `lanshare_auth_session_${PORT}`;
const LEGACY_AUTH_SESSION_COOKIE = "lanshare_auth_session";
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const configuredAuthOnlineWindowMs = Number(process.env.AUTH_ONLINE_WINDOW_MS);
const AUTH_ONLINE_WINDOW_MS = Number.isFinite(configuredAuthOnlineWindowMs) && configuredAuthOnlineWindowMs >= 100
  ? configuredAuthOnlineWindowMs
  : 45 * 1000;
const configuredAuthLastSeenUpdateMs = Number(process.env.AUTH_LAST_SEEN_UPDATE_MS);
const AUTH_LAST_SEEN_UPDATE_MS = Number.isFinite(configuredAuthLastSeenUpdateMs) && configuredAuthLastSeenUpdateMs >= 50
  ? configuredAuthLastSeenUpdateMs
  : 10 * 1000;
const AUTH_ROLES = new Set(["guest", "editor", "admin"]);
const AUTH_ROLE_LABELS = {
  guest: "游客",
  editor: "可编辑",
  admin: "管理员"
};
const ROLE_PERMISSIONS = {
  guest: ["files.read", "files.preview", "forum.read", "tools.use"],
  editor: [
    "files.read",
    "files.preview",
    "files.download",
    "files.write",
    "forum.read",
    "forum.write",
    "forum.delete_own",
    "recycle.read",
    "recycle.restore",
    "tools.use"
  ],
  admin: ["*"]
};
const FORUM_REACTION_EMOJIS = [
  "😀", "😄", "😂", "🤣", "😊", "🥰",
  "😍", "😅", "😭", "😢", "😮", "😱",
  "😡", "🤬", "🤔", "🙄", "👍", "👎",
  "👏", "🙏", "💪", "❤️", "💔", "🔥",
  "🎉", "💯", "👀", "✅", "❌", "🤝"
];
const configuredNsfwSessionTtlMs = Number(process.env.NSFW_SESSION_TTL_MS);
const NSFW_SESSION_TTL_MS = Number.isFinite(configuredNsfwSessionTtlMs) && configuredNsfwSessionTtlMs > 0
  ? configuredNsfwSessionTtlMs
  : 12 * 60 * 60 * 1000;
const nsfwSessions = new Map();
const loginFailures = new Map();
const PROTECTED_POST_PATHS = new Set([
  "/api/auth/register",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/profile",
  "/api/auth/change-password",
  "/api/admin/invite",
  "/api/admin/invite/disable",
  "/api/admin/users/name",
  "/api/admin/users/role",
  "/api/admin/users/reset-password",
  "/api/admin/users/delete",
  "/api/chat/send",
  "/api/chat/clear",
  "/api/forum/posts",
  "/api/forum/posts/delete",
  "/api/forum/posts/delete-batch",
  "/api/forum/reactions",
  "/api/forum/replies",
  "/api/nsfw/setpwd",
  "/api/nsfw/auth",
  "/api/nsfw/logout",
  "/api/nsfw/upload",
  "/api/mkdir",
  "/api/create-project",
  "/api/delete",
  "/api/rename",
  "/api/move",
  "/api/copy",
  "/api/check-conflicts",
  "/api/upload",
  "/api/download-batch",
  "/api/recycle/restore",
  "/api/recycle/delete",
  "/api/nickname",
  "/api/set-status"
]);
const EDITOR_POST_PATHS = new Set([
  "/api/chat/send",
  "/api/forum/posts",
  "/api/forum/posts/delete",
  "/api/forum/posts/delete-batch",
  "/api/forum/reactions",
  "/api/forum/replies",
  "/api/nsfw/auth",
  "/api/nsfw/logout",
  "/api/nsfw/upload",
  "/api/mkdir",
  "/api/create-project",
  "/api/delete",
  "/api/rename",
  "/api/move",
  "/api/copy",
  "/api/check-conflicts",
  "/api/upload",
  "/api/download-batch",
  "/api/recycle/restore",
  "/api/set-status"
]);
const ADMIN_POST_PATHS = new Set([
  "/api/chat/clear",
  "/api/nsfw/setpwd",
  "/api/recycle/delete",
  "/api/admin/invite",
  "/api/admin/invite/disable",
  "/api/admin/users/name",
  "/api/admin/users/role",
  "/api/admin/users/reset-password",
  "/api/admin/users/delete"
]);
const FORUM_WRITE_POST_PATHS = new Set([
  "/api/chat/send",
  "/api/forum/posts",
  "/api/forum/reactions",
  "/api/forum/replies"
]);
const FORUM_DELETE_POST_PATHS = new Set([
  "/api/forum/posts/delete",
  "/api/forum/posts/delete-batch"
]);

let authDb = null;
let forumDb = null;

function initAuthDatabase() {
  if (authDb) return authDb;
  authDb = new DatabaseSync(AUTH_DB_FILE);
  authDb.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('guest', 'editor', 'admin')),
      enabled INTEGER NOT NULL DEFAULT 1,
      is_protected_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      remember_me INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS invite_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      code_value TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_by INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    );
  `);
  const userColumns = authDb.prepare("PRAGMA table_info(users)").all();
  if (!userColumns.some((column) => column.name === "is_protected_admin")) {
    authDb.exec("ALTER TABLE users ADD COLUMN is_protected_admin INTEGER NOT NULL DEFAULT 0");
  }
  const protectedAdminExists = Boolean(authDb.prepare(
    "SELECT 1 FROM users WHERE is_protected_admin = 1 LIMIT 1"
  ).get());
  if (!protectedAdminExists) {
    authDb.exec(`
      UPDATE users
      SET is_protected_admin = 1
      WHERE id = (
        SELECT id
        FROM users
        WHERE role = 'admin' AND enabled = 1
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      );
    `);
  }
  authDb.exec(`
    CREATE TRIGGER IF NOT EXISTS protect_initial_admin_role
    BEFORE UPDATE OF role, enabled ON users
    WHEN OLD.is_protected_admin = 1
      AND (NEW.role <> 'admin' OR NEW.enabled <> 1)
    BEGIN
      SELECT RAISE(ABORT, 'PROTECTED_INITIAL_ADMIN');
    END;
  `);
  return authDb;
}

function countCharacters(value) {
  return Array.from(String(value || "")).length;
}

function normalizeUsername(value) {
  return String(value || "").trim().normalize("NFKC");
}

function usernameKey(value) {
  return normalizeUsername(value).toLocaleLowerCase("en-US");
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  const length = countCharacters(username);
  if (length < 3 || length > 10) {
    throw Object.assign(new Error("账号必须为 3–10 个字符"), { statusCode: 400 });
  }
  if (/[\u0000-\u001f\u007f]/u.test(username)) {
    throw Object.assign(new Error("账号包含不可用字符"), { statusCode: 400 });
  }
  return username;
}

function validatePassword(value, label = "密码") {
  const password = String(value || "");
  const length = countCharacters(password);
  if (length < 6 || length > 16) {
    throw Object.assign(new Error(`${label}必须为 6–16 个字符`), { statusCode: 400 });
  }
  return password;
}

function normalizeInviteCode(value) {
  return String(value || "").trim().normalize("NFKC");
}

function validateInviteCode(value) {
  const code = normalizeInviteCode(value);
  const length = countCharacters(code);
  if (length < 6 || length > 32) {
    throw Object.assign(new Error("邀请码必须为 6–32 个字符"), { statusCode: 400 });
  }
  if (/[\s\u0000-\u001f\u007f]/u.test(code)) {
    throw Object.assign(new Error("邀请码不能包含空格或控制字符"), { statusCode: 400 });
  }
  return code;
}

function inviteCodeHash(value) {
  const normalized = normalizeInviteCode(value).toLocaleLowerCase("en-US");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function validateAccountName(value) {
  const name = String(value || "").trim().normalize("NFKC");
  const length = countCharacters(name);
  if (length < 1 || length > 20) {
    throw Object.assign(new Error("姓名必须为 1–20 个字符"), { statusCode: 400 });
  }
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    throw Object.assign(new Error("姓名包含不可用字符"), { statusCode: 400 });
  }
  return name;
}

function scryptPassword(password, salt, keyLength = 64) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, { N: 16384, r: 8, p: 1 }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptPassword(password, salt);
  return `scrypt$16384$8$1$${salt.toString("base64")}$${derived.toString("base64")}`;
}

async function verifyPassword(password, encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (!salt.length || !expected.length) return false;
  const actual = await scryptPassword(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function getRolePermissions(role) {
  return [...(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.guest)];
}

function publicAuthUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    name: row.name,
    role: row.role,
    roleLabel: AUTH_ROLE_LABELS[row.role] || AUTH_ROLE_LABELS.guest,
    protectedAdmin: Boolean(row.protectedAdmin ?? row.is_protected_admin),
    permissions: getRolePermissions(row.role)
  };
}

function hasPermission(user, permission) {
  if (!user) return false;
  const permissions = ROLE_PERMISSIONS[user.role] || [];
  return permissions.includes("*") || permissions.includes(permission);
}

function cleanupExpiredAuthSessions(database = initAuthDatabase()) {
  database.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(Date.now());
}

function readOnlineUsers(currentUserId) {
  const database = initAuthDatabase();
  const now = Date.now();
  cleanupExpiredAuthSessions(database);
  const rows = database.prepare(`
    SELECT
      u.id,
      u.username,
      u.name,
      u.role,
      COUNT(s.token_hash) AS deviceCount,
      MAX(s.last_seen_at) AS lastActiveAt
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE
      u.enabled = 1
      AND s.expires_at > ?
      AND s.last_seen_at >= ?
    GROUP BY u.id
    ORDER BY
      CASE WHEN u.id = ? THEN 0 ELSE 1 END,
      MAX(s.last_seen_at) DESC,
      u.name COLLATE NOCASE ASC
  `).all(now, now - AUTH_ONLINE_WINDOW_MS, currentUserId);
  return rows.map((row) => ({
    id: Number(row.id),
    username: row.username,
    name: row.name,
    role: row.role,
    roleLabel: AUTH_ROLE_LABELS[row.role] || row.role,
    deviceCount: Number(row.deviceCount || 0),
    lastActiveAt: Number(row.lastActiveAt),
    isSelf: Number(row.id) === Number(currentUserId)
  }));
}

function createAuthSession(userId, rememberMe) {
  const database = initAuthDatabase();
  cleanupExpiredAuthSessions(database);
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const ttl = rememberMe ? AUTH_REMEMBER_TTL_MS : AUTH_SESSION_TTL_MS;
  database.prepare(`
    INSERT INTO auth_sessions
      (token_hash, user_id, remember_me, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(hashSessionToken(token), userId, rememberMe ? 1 : 0, now, now, now + ttl);
  return { token, expiresAt: now + ttl, rememberMe: Boolean(rememberMe) };
}

function getAuthSessionCandidates(req) {
  const candidates = [];
  const scopedToken = getRequestCookie(req, AUTH_SESSION_COOKIE);
  if (/^[a-f0-9]{64}$/.test(scopedToken)) {
    candidates.push({ token: scopedToken, legacy: false });
  }
  if (AUTH_SESSION_COOKIE !== LEGACY_AUTH_SESSION_COOKIE) {
    const legacyToken = getRequestCookie(req, LEGACY_AUTH_SESSION_COOKIE);
    if (/^[a-f0-9]{64}$/.test(legacyToken) && legacyToken !== scopedToken) {
      candidates.push({ token: legacyToken, legacy: true });
    }
  }
  return candidates;
}

function readAuthenticatedUser(req) {
  const database = initAuthDatabase();
  const statement = database.prepare(`
    SELECT
      u.id,
      u.username,
      u.name,
      u.role,
      u.enabled,
      u.is_protected_admin AS protectedAdmin,
      s.remember_me AS rememberMe,
      s.last_seen_at AS lastSeenAt,
      s.expires_at AS expiresAt
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `);
  for (const candidate of getAuthSessionCandidates(req)) {
    const tokenHash = hashSessionToken(candidate.token);
    const row = statement.get(tokenHash);
    if (!row || !row.enabled || Number(row.expiresAt) <= Date.now()) {
      database.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
      continue;
    }
    if (Date.now() - Number(row.lastSeenAt || 0) >= AUTH_LAST_SEEN_UPDATE_MS) {
      database.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?")
        .run(Date.now(), tokenHash);
    }
    req.authSession = {
      token: candidate.token,
      tokenHash,
      expiresAt: Number(row.expiresAt),
      rememberMe: Boolean(row.rememberMe),
      legacy: candidate.legacy
    };
    return publicAuthUser(row);
  }
  return null;
}

function revokeAuthSession(req) {
  const tokenHash = req.authSession && req.authSession.tokenHash;
  if (!tokenHash) return;
  initAuthDatabase().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
}

function revokeLegacyAuthSession(req) {
  if (AUTH_SESSION_COOKIE === LEGACY_AUTH_SESSION_COOKIE) return;
  const legacyToken = getRequestCookie(req, LEGACY_AUTH_SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/.test(legacyToken)) return;
  initAuthDatabase()
    .prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
    .run(hashSessionToken(legacyToken));
}

function migrateLegacyAuthSession(req) {
  if (!req.authUser || !req.authSession || !req.authSession.legacy) return null;
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSessionToken(token);
  const result = initAuthDatabase().prepare(`
    UPDATE auth_sessions
    SET token_hash = ?, last_seen_at = ?
    WHERE token_hash = ?
  `).run(tokenHash, Date.now(), req.authSession.tokenHash);
  if (Number(result.changes || 0) !== 1) return null;
  req.authSession = {
    ...req.authSession,
    token,
    tokenHash,
    legacy: false
  };
  return req.authSession;
}

function revokeOtherAuthSessions(userId, req) {
  const currentHash = req.authSession ? req.authSession.tokenHash : "";
  if (currentHash) {
    initAuthDatabase()
      .prepare("DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?")
      .run(userId, currentHash);
  } else {
    initAuthDatabase().prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
  }
}

function getLoginFailureKey(req, username) {
  return `${getClientIp(req)}|${usernameKey(username)}`;
}

function getLoginRetryAfterMs(req, username) {
  const key = getLoginFailureKey(req, username);
  const state = loginFailures.get(key);
  if (!state) return 0;
  if (state.resetAt <= Date.now()) {
    loginFailures.delete(key);
    return 0;
  }
  return state.blockedUntil > Date.now() ? state.blockedUntil - Date.now() : 0;
}

function recordLoginFailure(req, username) {
  const key = getLoginFailureKey(req, username);
  const now = Date.now();
  const previous = loginFailures.get(key);
  const state = previous && previous.resetAt > now
    ? previous
    : { count: 0, resetAt: now + 15 * 60 * 1000, blockedUntil: 0 };
  state.count += 1;
  if (state.count >= 5) state.blockedUntil = now + 15 * 60 * 1000;
  loginFailures.set(key, state);
}

function clearLoginFailures(req, username) {
  loginFailures.delete(getLoginFailureKey(req, username));
}

function initForumDatabase() {
  if (forumDb) return forumDb;
  forumDb = new DatabaseSync(FORUM_DB_FILE);
  forumDb.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author TEXT NOT NULL,
      author_user_id INTEGER,
      owner_token TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      parent_reply_id INTEGER,
      content TEXT NOT NULL,
      author TEXT NOT NULL,
      author_user_id INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_reply_id) REFERENCES replies(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS forum_reactions (
      post_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      owner_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (post_id, emoji, owner_token),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS file_attributions (
      root_key TEXT NOT NULL,
      path TEXT NOT NULL,
      uploader TEXT NOT NULL,
      uploader_user_id INTEGER,
      uploaded_at INTEGER NOT NULL,
      PRIMARY KEY (root_key, path)
    );
    CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_replies_post_id ON replies(post_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_forum_reactions_post_id ON forum_reactions(post_id, emoji);
    CREATE INDEX IF NOT EXISTS idx_file_attributions_root_path ON file_attributions(root_key, path);
  `);
  const postColumns = forumDb.prepare("PRAGMA table_info(posts)").all();
  if (!postColumns.some((column) => column.name === "owner_token")) {
    forumDb.exec("ALTER TABLE posts ADD COLUMN owner_token TEXT");
  }
  if (!postColumns.some((column) => column.name === "author_user_id")) {
    forumDb.exec("ALTER TABLE posts ADD COLUMN author_user_id INTEGER");
  }
  const replyColumns = forumDb.prepare("PRAGMA table_info(replies)").all();
  if (!replyColumns.some((column) => column.name === "parent_reply_id")) {
    forumDb.exec(
      "ALTER TABLE replies ADD COLUMN parent_reply_id INTEGER REFERENCES replies(id) ON DELETE SET NULL"
    );
  }
  if (!replyColumns.some((column) => column.name === "author_user_id")) {
    forumDb.exec("ALTER TABLE replies ADD COLUMN author_user_id INTEGER");
  }
  const attributionColumns = forumDb.prepare("PRAGMA table_info(file_attributions)").all();
  if (!attributionColumns.some((column) => column.name === "uploader_user_id")) {
    forumDb.exec("ALTER TABLE file_attributions ADD COLUMN uploader_user_id INTEGER");
  }
  forumDb.exec("CREATE INDEX IF NOT EXISTS idx_replies_parent_reply_id ON replies(parent_reply_id)");
  forumDb.exec("CREATE INDEX IF NOT EXISTS idx_file_attributions_user_id ON file_attributions(uploader_user_id)");
  const unlinkedUploaderNames = forumDb.prepare(`
    SELECT DISTINCT uploader
    FROM file_attributions
    WHERE uploader_user_id IS NULL AND uploader <> ''
  `).all();
  const accountByName = initAuthDatabase().prepare("SELECT id FROM users WHERE name = ?");
  const linkUploader = forumDb.prepare(`
    UPDATE file_attributions
    SET uploader_user_id = ?
    WHERE uploader_user_id IS NULL AND uploader = ?
  `);
  for (const row of unlinkedUploaderNames) {
    const accounts = accountByName.all(row.uploader);
    if (accounts.length === 1) {
      linkUploader.run(Number(accounts[0].id), row.uploader);
    }
  }
  return forumDb;
}

function getForumAuthor(req) {
  return req.authUser && req.authUser.name ? req.authUser.name.slice(0, 20) : "匿名";
}

function updateAccountName(userId, name) {
  const accountDatabase = initAuthDatabase();
  const target = accountDatabase.prepare("SELECT id, username, name FROM users WHERE id = ?").get(userId);
  if (!target) {
    throw Object.assign(new Error("账号不存在"), { statusCode: 404 });
  }
  const forumDatabase = initForumDatabase();
  let accountTransaction = false;
  let forumTransaction = false;
  try {
    accountDatabase.exec("BEGIN IMMEDIATE");
    accountTransaction = true;
    forumDatabase.exec("BEGIN IMMEDIATE");
    forumTransaction = true;
    accountDatabase.prepare("UPDATE users SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, Date.now(), userId);
    forumDatabase.prepare("UPDATE posts SET author = ? WHERE author_user_id = ?").run(name, userId);
    forumDatabase.prepare("UPDATE replies SET author = ? WHERE author_user_id = ?").run(name, userId);
    forumDatabase.prepare("UPDATE file_attributions SET uploader = ? WHERE uploader_user_id = ?")
      .run(name, userId);
    forumDatabase.exec("COMMIT");
    forumTransaction = false;
    accountDatabase.exec("COMMIT");
    accountTransaction = false;
  } catch (error) {
    if (forumTransaction) {
      try { forumDatabase.exec("ROLLBACK"); } catch {}
    }
    if (accountTransaction) {
      try { accountDatabase.exec("ROLLBACK"); } catch {}
    }
    throw error;
  }
  for (const message of moyuMessages) {
    if (Number(message.userId) === Number(userId)) message.user = name;
  }
  return {
    id: Number(target.id),
    username: target.username,
    previousName: target.name,
    name
  };
}

function getAttributionRootKey(nsfwMode) {
  return nsfwMode ? "nsfw" : "shared";
}

function recordFileAttributions(paths, uploader, uploaderUserId, nsfwMode, overwriteExisting = true) {
  const uniquePaths = [...new Set((paths || []).map((item) => safeRelative(item)).filter(Boolean))];
  if (!uniquePaths.length) return;
  const database = initForumDatabase();
  const statement = database.prepare(overwriteExisting
    ? `
      INSERT INTO file_attributions (root_key, path, uploader, uploader_user_id, uploaded_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(root_key, path) DO UPDATE SET
        uploader = excluded.uploader,
        uploader_user_id = excluded.uploader_user_id,
        uploaded_at = excluded.uploaded_at
    `
    : `
      INSERT INTO file_attributions (root_key, path, uploader, uploader_user_id, uploaded_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(root_key, path) DO NOTHING
    `);
  const rootKey = getAttributionRootKey(nsfwMode);
  const uploadedAt = Date.now();
  database.exec("BEGIN");
  try {
    uniquePaths.forEach((itemPath) => statement.run(
      rootKey,
      itemPath,
      uploader || "未知",
      Number.isInteger(Number(uploaderUserId)) ? Number(uploaderUserId) : null,
      uploadedAt
    ));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function attachFileAttributions(items, nsfwMode) {
  if (!items || !items.length) return items;
  const itemPaths = [...new Set(items.map((item) => item.path).filter(Boolean))];
  if (!itemPaths.length) return items;
  const placeholders = itemPaths.map(() => "?").join(",");
  const rows = initForumDatabase()
    .prepare(`SELECT path, uploader, uploader_user_id AS uploaderUserId, uploaded_at AS uploadedAt FROM file_attributions WHERE root_key = ? AND path IN (${placeholders})`)
    .all(getAttributionRootKey(nsfwMode), ...itemPaths);
  const uploaderUserIds = [...new Set(rows
    .map((row) => Number(row.uploaderUserId))
    .filter((userId) => Number.isInteger(userId) && userId > 0))];
  const currentNames = new Map();
  if (uploaderUserIds.length) {
    const accountPlaceholders = uploaderUserIds.map(() => "?").join(",");
    const accounts = initAuthDatabase()
      .prepare(`SELECT id, name FROM users WHERE id IN (${accountPlaceholders})`)
      .all(...uploaderUserIds);
    accounts.forEach((account) => currentNames.set(Number(account.id), account.name));
  }
  const byPath = new Map(rows.map((row) => [row.path, row]));
  items.forEach((item) => {
    const attribution = byPath.get(item.path);
    if (!attribution) return;
    item.creator = currentNames.get(Number(attribution.uploaderUserId)) || attribution.uploader;
    item.createdByAt = attribution.uploadedAt;
  });
  return items;
}

function copyFileAttributions(sourceRelative, targetRelative, nsfwMode, move = false) {
  const rootKey = getAttributionRootKey(nsfwMode);
  const sourcePrefix = `${sourceRelative}/`;
  const database = initForumDatabase();
  const rows = database.prepare(`
    SELECT path, uploader, uploader_user_id AS uploaderUserId, uploaded_at AS uploadedAt
    FROM file_attributions
    WHERE root_key = ? AND (path = ? OR substr(path, 1, ?) = ?)
  `).all(rootKey, sourceRelative, sourcePrefix.length, sourcePrefix);
  if (!rows.length) return;
  const targetPrefix = `${targetRelative}/`;
  const deleteTarget = database.prepare(`
    DELETE FROM file_attributions
    WHERE root_key = ? AND (path = ? OR substr(path, 1, ?) = ?)
  `);
  const deleteSource = database.prepare("DELETE FROM file_attributions WHERE root_key = ? AND path = ?");
  const upsert = database.prepare(`
    INSERT INTO file_attributions (root_key, path, uploader, uploader_user_id, uploaded_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(root_key, path) DO UPDATE SET
      uploader = excluded.uploader,
      uploader_user_id = excluded.uploader_user_id,
      uploaded_at = excluded.uploaded_at
  `);
  database.exec("BEGIN");
  try {
    deleteTarget.run(rootKey, targetRelative, targetPrefix.length, targetPrefix);
    rows.forEach((row) => {
      const nextPath = `${targetRelative}${row.path.slice(sourceRelative.length)}`;
      upsert.run(rootKey, nextPath, row.uploader, row.uploaderUserId, row.uploadedAt);
      if (move) deleteSource.run(rootKey, row.path);
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".zip": "application/zip",
  ".wasm": "application/wasm",
  ".worker": "application/javascript"
};

const IMAGE_THUMB_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const VIDEO_THUMB_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi"]);

function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function getHeaderValue(req, name) {
  return String(req.headers[name] || "").trim();
}

function getRequestCookie(req, name) {
  const rawCookie = getHeaderValue(req, "cookie");
  for (const part of rawCookie.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 0) continue;
    const key = part.slice(0, separatorIndex).trim();
    if (key !== name) continue;
    const value = part.slice(separatorIndex + 1).trim();
    try { return decodeURIComponent(value); } catch { return ""; }
  }
  return "";
}

function makeNsfwSessionCookie(token, maxAgeSeconds) {
  return `${NSFW_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function isSecureRequest(req) {
  return Boolean(req.socket && req.socket.encrypted)
    || getHeaderValue(req, "x-forwarded-proto").toLowerCase() === "https";
}

function makeAuthSessionCookie(req, token, options = {}, cookieName = AUTH_SESSION_COOKIE) {
  const parts = [
    `${cookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict"
  ];
  if (Number.isFinite(options.maxAgeSeconds)) {
    const maxAgeSeconds = Math.max(0, Math.floor(options.maxAgeSeconds));
    parts.push(`Max-Age=${maxAgeSeconds}`);
    if (maxAgeSeconds === 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function getForumOwnerToken(req) {
  const token = getRequestCookie(req, FORUM_OWNER_COOKIE);
  return /^[a-f0-9]{48}$/.test(token) ? token : "";
}

function createForumOwnerToken() {
  return crypto.randomBytes(24).toString("hex");
}

function getForumReactionOwnerKey(req) {
  return req.authUser ? `user:${req.authUser.id}` : getForumOwnerToken(req);
}

function makeForumOwnerCookie(token) {
  return `${FORUM_OWNER_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
}

function readForumReactions(database, postIds, ownerToken) {
  const uniquePostIds = [...new Set((postIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!uniquePostIds.length) return new Map();
  const placeholders = uniquePostIds.map(() => "?").join(",");
  const counts = database.prepare(`
    SELECT post_id AS postId, emoji, COUNT(*) AS count
    FROM forum_reactions
    WHERE post_id IN (${placeholders})
    GROUP BY post_id, emoji
  `).all(...uniquePostIds);
  const ownReactions = ownerToken
    ? database.prepare(`
        SELECT post_id AS postId, emoji
        FROM forum_reactions
        WHERE owner_token = ? AND post_id IN (${placeholders})
      `).all(ownerToken, ...uniquePostIds)
    : [];
  const ownKeys = new Set(ownReactions.map((row) => `${row.postId}:${row.emoji}`));
  const byPost = new Map(uniquePostIds.map((postId) => [postId, []]));
  const emojiOrder = new Map(FORUM_REACTION_EMOJIS.map((emoji, index) => [emoji, index]));
  for (const row of counts) {
    if (!emojiOrder.has(row.emoji)) continue;
    byPost.get(row.postId)?.push({
      emoji: row.emoji,
      count: Number(row.count) || 0,
      reacted: ownKeys.has(`${row.postId}:${row.emoji}`)
    });
  }
  for (const reactions of byPost.values()) {
    reactions.sort((left, right) =>
      right.count - left.count
      || emojiOrder.get(left.emoji) - emojiOrder.get(right.emoji)
    );
  }
  return byPost;
}

function cleanupExpiredNsfwSessions(now = Date.now()) {
  for (const [token, expiresAt] of nsfwSessions) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) nsfwSessions.delete(token);
  }
}

function createNsfwSession() {
  cleanupExpiredNsfwSessions();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + NSFW_SESSION_TTL_MS;
  nsfwSessions.set(token, expiresAt);
  return { token, expiresAt };
}

function getValidNsfwSessionToken(req) {
  const token = getRequestCookie(req, NSFW_SESSION_COOKIE);
  if (!token) return "";
  const expiresAt = nsfwSessions.get(token);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    nsfwSessions.delete(token);
    return "";
  }
  return token;
}

function isNsfwAuthorized(req) {
  return Boolean(getValidNsfwSessionToken(req));
}

function clearNsfwSession(req) {
  const token = getRequestCookie(req, NSFW_SESSION_COOKIE);
  if (token) nsfwSessions.delete(token);
}

function isLoopbackRequest(req) {
  const address = normalizeSocketAddress(req.socket && req.socket.remoteAddress);
  return address === "127.0.0.1" || address === "::1";
}

function normalizeSocketAddress(value) {
  return String(value || "").replace(/^::ffff:/, "").split("%")[0];
}

function requestNeedsNsfwSession(req, url) {
  if (url.pathname === "/api/nsfw/auth" || url.pathname === "/api/nsfw/session" || url.pathname === "/api/nsfw/logout" || url.pathname === "/api/nsfw/setpwd") {
    return false;
  }
  return Boolean(req._nsfwMode)
    || url.pathname === "/api/nsfw/list"
    || url.pathname === "/api/nsfw/upload"
    || url.pathname === "/nsfw/file";
}

function normalizeOrigin(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function getTrustedOrigins(req) {
  const host = getHeaderValue(req, "x-forwarded-host") || getHeaderValue(req, "host");
  if (!host) return [];
  const protocol = getHeaderValue(req, "x-forwarded-proto") || "http";
  return [`${protocol}://${host}`];
}

function isTrustedWriteOrigin(req) {
  const trustedOrigins = new Set(getTrustedOrigins(req));
  if (trustedOrigins.size === 0) return false;

  const origin = normalizeOrigin(getHeaderValue(req, "origin"));
  if (origin) {
    return trustedOrigins.has(origin);
  }

  const referer = normalizeOrigin(getHeaderValue(req, "referer"));
  if (referer) {
    return trustedOrigins.has(referer);
  }

  return false;
}

function assertTrustedWriteRequest(req) {
  if (!isTrustedWriteOrigin(req)) {
    const error = new Error("非法请求来源");
    error.statusCode = 403;
    throw error;
  }

  const csrfToken = getHeaderValue(req, "x-csrf-token");
  if (!csrfToken || csrfToken !== CSRF_TOKEN) {
    const error = new Error("CSRF 校验失败");
    error.statusCode = 403;
    throw error;
  }
}

function safeRelative(input) {
  const value = String(input || "").replaceAll("\\", "/").trim();
  const normalized = path.posix.normalize(`/${value}`).replace(/^\/+/, "");
  if (normalized.startsWith("..")) {
    throw new Error("非法路径");
  }
  return normalized === "." ? "" : normalized;
}

function nsfwRoot(req) {
  var useNSFW = req && req._nsfwMode;
  return useNSFW ? NSFW_DIR : ROOT_DIR;
}
function resolveInsideRoot(relativePath, req) {
  const root = (req && req._nsfwMode) ? NSFW_DIR : ROOT_DIR;
  const fullPath = path.resolve(root, relativePath);
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error("路径越界");
  }
  return fullPath;
}

function toFsPath(filePath) {
  return process.platform === "win32" ? path.toNamespacedPath(filePath) : filePath;
}

function resolveInsideDirectory(rootDir, relativePath, message = "路径越界") {
  const rootPath = path.resolve(rootDir);
  const fullPath = path.resolve(rootPath, String(relativePath || ""));
  if (fullPath !== rootPath && fullPath.startsWith(`${rootPath}${path.sep}`)) {
    return fullPath;
  }
  throw new Error(message);
}

function resolveRecycleEntryDir(id) {
  const entryId = String(id || "").trim();
  if (!entryId || entryId.includes("/") || entryId.includes("\\") || entryId === "." || entryId === "..") {
    throw new Error("回收站条目ID非法");
  }
  return resolveInsideDirectory(RECYCLE_DIR, entryId, "回收站路径越界");
}

function resolveRecycleStoredPath(entryDir, storedName) {
  const name = String(storedName || "");
  if (!name) {
    throw new Error("回收站条目数据不完整");
  }
  return resolveInsideDirectory(entryDir, name, "回收站条目路径越界");
}

function getPreviewType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".flac"].includes(ext)) return "audio";
  if ([".mp4", ".webm", ".mov", ".mkv", ".avi"].includes(ext)) return "video";
  if (ext === ".docx") return "document";
  return "none";
}

function isStreamPreviewType(previewType) {
  return previewType === "image" || previewType === "audio" || previewType === "video";
}

function parseMediaNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseMediaFrameRate(value) {
  const text = String(value || "").trim();
  if (!text || text === "0/0") return null;
  const parts = text.split("/");
  if (parts.length === 2) {
    const numerator = Number(parts[0]);
    const denominator = Number(parts[1]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      const result = numerator / denominator;
      return Number.isFinite(result) && result > 0 ? result : null;
    }
  }
  const result = Number(text);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function getImageBitDepth(depth) {
  const depths = {
    uchar: 8,
    char: 8,
    ushort: 16,
    short: 16,
    uint: 32,
    int: 32,
    float: 32,
    double: 64,
    complex: 64,
    dpcomplex: 128
  };
  return depths[String(depth || "").toLowerCase()] || null;
}

function runFfprobe(fullPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-show_entries",
      "format=format_name,format_long_name,duration,bit_rate,size:format_tags=major_brand,compatible_brands:stream=index,codec_type,codec_name,codec_long_name,width,height,avg_frame_rate,r_frame_rate,bit_rate,pix_fmt,sample_rate,channels,channel_layout,duration:stream_tags=rotate:stream_side_data=rotation",
      "-of", "json",
      fullPath
    ];
    const child = spawn("ffprobe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(data);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("媒体信息读取超时"));
    }, Math.max(1000, MEDIA_INFO_TIMEOUT_MS));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 2 * 1024 * 1024) {
        child.kill();
        finish(new Error("媒体信息数据异常"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(stderr.trim() || `ffprobe 退出码 ${code}`));
        return;
      }
      try {
        finish(null, JSON.parse(stdout || "{}"));
      } catch {
        finish(new Error("媒体信息解析失败"));
      }
    });
  });
}

function getVideoRotation(stream) {
  const tagRotation = Number(stream && stream.tags && stream.tags.rotate);
  if (Number.isFinite(tagRotation)) return tagRotation;
  const sideData = Array.isArray(stream && stream.side_data_list) ? stream.side_data_list : [];
  const rotation = sideData.map((item) => Number(item.rotation)).find(Number.isFinite);
  return Number.isFinite(rotation) ? rotation : 0;
}

function normalizeDisplayResolution(stream) {
  let width = parseMediaNumber(stream && stream.width);
  let height = parseMediaNumber(stream && stream.height);
  const normalizedRotation = Math.abs(getVideoRotation(stream)) % 180;
  if (normalizedRotation === 90 && width && height) {
    [width, height] = [height, width];
  }
  return { width, height };
}

function detectMediaContainer(fullPath, format) {
  const extension = path.extname(fullPath).toLowerCase();
  const formatNames = String(format && format.format_name || "")
    .toLowerCase()
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const majorBrand = String(format && format.tags && format.tags.major_brand || "")
    .trim()
    .toLowerCase();

  if (formatNames.includes("mov") && formatNames.includes("mp4")) {
    if (majorBrand.startsWith("qt")) return "mov";
    const isoFamilyLabels = {
      ".mp4": "mp4",
      ".m4a": "m4a",
      ".3gp": "3gp",
      ".3g2": "3g2",
      ".mj2": "mj2",
      ".mov": "mov"
    };
    return isoFamilyLabels[extension] || "mp4";
  }
  if (formatNames.includes("matroska") && formatNames.includes("webm")) {
    return extension === ".webm" ? "webm" : "mkv";
  }
  const extensionName = extension.slice(1);
  if (extensionName && formatNames.includes(extensionName)) return extensionName;
  return formatNames[0] || extensionName;
}

async function inspectImageInfo(fullPath) {
  const metadata = await sharp(fullPath, { animated: true, limitInputPixels: 12000 * 12000 }).metadata();
  let width = parseMediaNumber(metadata.autoOrient && metadata.autoOrient.width) || parseMediaNumber(metadata.width);
  let height = parseMediaNumber(metadata.autoOrient && metadata.autoOrient.height) || parseMediaNumber(metadata.height);
  if (
    !(metadata.autoOrient && metadata.autoOrient.width)
    && [5, 6, 7, 8].includes(Number(metadata.orientation))
    && width
    && height
  ) {
    [width, height] = [height, width];
  }
  const delays = Array.isArray(metadata.delay)
    ? metadata.delay.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const averageDelay = delays.length > 0
    ? delays.reduce((total, value) => total + value, 0) / delays.length
    : null;
  return {
    previewType: "image",
    format: String(metadata.format || path.extname(fullPath).slice(1) || "").toUpperCase(),
    width,
    height,
    megapixels: width && height ? width * height / 1000000 : null,
    colorSpace: metadata.space || null,
    channels: parseMediaNumber(metadata.channels),
    bitDepth: getImageBitDepth(metadata.depth),
    density: parseMediaNumber(metadata.density),
    frameCount: parseMediaNumber(metadata.pages) || 1,
    frameRate: averageDelay ? 1000 / averageDelay : null,
    hasAlpha: Boolean(metadata.hasAlpha)
  };
}

async function inspectAvInfo(fullPath, previewType, stat) {
  const probe = await runFfprobe(fullPath);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const format = probe.format && typeof probe.format === "object" ? probe.format : {};
  const videoStream = streams.find((stream) => stream.codec_type === "video") || null;
  const audioStream = streams.find((stream) => stream.codec_type === "audio") || null;
  const durationSeconds = parseMediaNumber(format.duration)
    ?? parseMediaNumber(videoStream && videoStream.duration)
    ?? parseMediaNumber(audioStream && audioStream.duration);
  const measuredBitRate = parseMediaNumber(format.bit_rate);
  const estimatedBitRate = durationSeconds && stat.size > 0 ? stat.size * 8 / durationSeconds : null;
  const resolution = normalizeDisplayResolution(videoStream);
  return {
    previewType,
    container: detectMediaContainer(fullPath, format),
    containerName: format.format_long_name || null,
    durationSeconds,
    bitRate: measuredBitRate || estimatedBitRate,
    video: videoStream ? {
      codec: videoStream.codec_name || null,
      codecName: videoStream.codec_long_name || null,
      width: resolution.width,
      height: resolution.height,
      frameRate: parseMediaFrameRate(videoStream.avg_frame_rate)
        || parseMediaFrameRate(videoStream.r_frame_rate),
      bitRate: parseMediaNumber(videoStream.bit_rate),
      pixelFormat: videoStream.pix_fmt || null,
      rotation: getVideoRotation(videoStream)
    } : null,
    audio: audioStream ? {
      codec: audioStream.codec_name || null,
      codecName: audioStream.codec_long_name || null,
      sampleRate: parseMediaNumber(audioStream.sample_rate),
      channels: parseMediaNumber(audioStream.channels),
      channelLayout: audioStream.channel_layout || null,
      bitRate: parseMediaNumber(audioStream.bit_rate)
    } : null
  };
}

function cacheMediaInfo(key, value) {
  mediaInfoCache.delete(key);
  mediaInfoCache.set(key, value);
  const limit = Number.isFinite(MEDIA_INFO_CACHE_LIMIT) && MEDIA_INFO_CACHE_LIMIT > 0
    ? Math.floor(MEDIA_INFO_CACHE_LIMIT)
    : 500;
  while (mediaInfoCache.size > limit) {
    const oldestKey = mediaInfoCache.keys().next().value;
    mediaInfoCache.delete(oldestKey);
  }
}

async function readMediaInfo(relativePath, rootOverride) {
  const root = rootOverride || ROOT_DIR;
  const safePath = safeRelative(relativePath);
  if (!safePath) throw new Error("没有指定媒体文件");
  const fullPath = path.resolve(root, safePath);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) throw new Error("路径越界");
  const stat = await fsp.stat(toFsPath(fullPath));
  if (!stat.isFile()) throw new Error("仅支持读取文件媒体信息");
  const previewType = getPreviewType(fullPath);
  if (previewType === "none") throw new Error("当前文件不支持媒体信息读取");
  const cacheKey = `${rootOverride ? "nsfw" : "shared"}:${safePath}:${stat.size}:${stat.mtimeMs}`;
  if (mediaInfoCache.has(cacheKey)) return mediaInfoCache.get(cacheKey);
  if (mediaInfoJobs.has(cacheKey)) return mediaInfoJobs.get(cacheKey);
  const job = (previewType === "image"
    ? inspectImageInfo(fullPath)
    : inspectAvInfo(fullPath, previewType, stat))
    .then((result) => {
      const value = { path: safePath, size: stat.size, ...result };
      cacheMediaInfo(cacheKey, value);
      return value;
    })
    .finally(() => {
      mediaInfoJobs.delete(cacheKey);
    });
  mediaInfoJobs.set(cacheKey, job);
  return job;
}

function escapeDocumentHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cacheDocumentPreview(key, value) {
  const previous = documentPreviewCache.get(key);
  if (previous) {
    documentPreviewCacheBytes -= Number(previous.byteLength) || 0;
    documentPreviewCache.delete(key);
  }
  value.byteLength = Buffer.byteLength(String(value.html || ""), "utf8");
  documentPreviewCache.set(key, value);
  documentPreviewCacheBytes += value.byteLength;
  while (
    documentPreviewCache.size > DOCUMENT_PREVIEW_CACHE_LIMIT
    || documentPreviewCacheBytes > DOCUMENT_PREVIEW_CACHE_MAX_BYTES
  ) {
    const oldestKey = documentPreviewCache.keys().next().value;
    const oldest = documentPreviewCache.get(oldestKey);
    documentPreviewCacheBytes -= Number(oldest && oldest.byteLength) || 0;
    documentPreviewCache.delete(oldestKey);
  }
}

function sanitizeDocumentPreviewHtml(html) {
  return sanitizeHtml(String(html || ""), {
    allowedTags: [
      "article", "section", "div", "span", "p", "br", "hr",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "strong", "b", "em", "i", "u", "s", "sup", "sub",
      "blockquote", "pre", "code",
      "ul", "ol", "li", "dl", "dt", "dd",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td",
      "img"
    ],
    allowedAttributes: {
      img: ["src", "alt", "title", "width", "height"],
      ol: ["start"],
      li: ["value"],
      th: ["colspan", "rowspan"],
      td: ["colspan", "rowspan"]
    },
    allowedSchemesByTag: {
      img: ["data"]
    },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard"
  });
}

async function readDocumentPreview(relativePath, rootOverride) {
  const root = rootOverride || ROOT_DIR;
  const safePath = safeRelative(relativePath);
  if (!safePath) throw Object.assign(new Error("没有指定 DOCX 文件"), { statusCode: 400 });
  const fullPath = path.resolve(root, safePath);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
    throw Object.assign(new Error("路径越界"), { statusCode: 400 });
  }
  if (path.extname(fullPath).toLowerCase() !== ".docx") {
    throw Object.assign(new Error("当前仅支持 DOCX 文档预览"), { statusCode: 415 });
  }
  const stat = await fsp.stat(toFsPath(fullPath));
  if (!stat.isFile()) throw Object.assign(new Error("仅支持预览文件"), { statusCode: 400 });
  if (stat.size > DOCUMENT_PREVIEW_MAX_SIZE) {
    throw Object.assign(
      new Error(`DOCX 文件超过预览上限（${Math.floor(DOCUMENT_PREVIEW_MAX_SIZE / 1024 / 1024)}MB）`),
      { statusCode: 413 }
    );
  }

  const cacheKey = `${rootOverride ? "nsfw" : "shared"}:${safePath}:${stat.size}:${stat.mtimeMs}`;
  if (documentPreviewCache.has(cacheKey)) return documentPreviewCache.get(cacheKey);
  if (documentPreviewJobs.has(cacheKey)) return documentPreviewJobs.get(cacheKey);

  const job = mammoth.convertToHtml(
    { path: toFsPath(fullPath) },
    {
      styleMap: [
        "p[style-name='Title'] => h1.docx-title:fresh",
        "p[style-name='Subtitle'] => p.docx-subtitle:fresh"
      ]
    }
  ).then((result) => {
    if (Buffer.byteLength(String(result.value || ""), "utf8") > DOCUMENT_PREVIEW_MAX_HTML_SIZE) {
      throw Object.assign(
        new Error(`DOCX 预览内容超过输出上限（${Math.floor(DOCUMENT_PREVIEW_MAX_HTML_SIZE / 1024 / 1024)}MB）`),
        { statusCode: 413 }
      );
    }
    const html = sanitizeDocumentPreviewHtml(result.value);
    if (Buffer.byteLength(html, "utf8") > DOCUMENT_PREVIEW_MAX_HTML_SIZE) {
      throw Object.assign(new Error("DOCX 预览内容过大"), { statusCode: 413 });
    }
    const value = {
      name: path.basename(fullPath),
      html,
      warningCount: Array.isArray(result.messages) ? result.messages.length : 0
    };
    cacheDocumentPreview(cacheKey, value);
    return value;
  }).finally(() => {
    documentPreviewJobs.delete(cacheKey);
  });
  documentPreviewJobs.set(cacheKey, job);
  return job;
}

function buildDocumentPreviewPage(preview, theme = "light") {
  const dark = theme === "dark";
  const canvas = dark ? "#171814" : "#dfe3df";
  const canvasText = dark ? "#d7d9d3" : "#525850";
  const warning = preview.warningCount > 0
    ? `<div class="conversion-note">已尽量还原文档内容；复杂分页、文本框或浮动版式可能与 Word 略有差异。</div>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeDocumentHtml(preview.name)}</title>
  <style>
    :root { color-scheme: ${dark ? "dark" : "light"}; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      padding: clamp(16px, 3vw, 36px);
      color: ${canvasText};
      background: ${canvas};
      font: 15px/1.72 "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    }
    .document-sheet {
      width: min(816px, 100%);
      min-height: 1056px;
      margin: 0 auto;
      padding: clamp(28px, 6vw, 72px);
      color: #232621;
      background: #fff;
      border: 1px solid rgba(35, 38, 33, .12);
      box-shadow: 0 18px 50px rgba(26, 31, 27, .16);
      overflow-wrap: anywhere;
    }
    h1, h2, h3, h4, h5, h6 { margin: 1.25em 0 .55em; line-height: 1.35; color: #171a17; }
    h1:first-child, h2:first-child, h3:first-child, p:first-child { margin-top: 0; }
    p { margin: 0 0 .9em; }
    ul, ol { margin: .45em 0 1em; padding-left: 2em; }
    blockquote { margin: 1em 0; padding: .15em 1em; border-left: 4px solid #9aa49d; color: #535b55; }
    table { width: 100%; margin: 1.2em 0; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: .55em .65em; border: 1px solid #b8beb9; text-align: left; vertical-align: top; }
    th { background: #eef1ee; }
    img { display: block; max-width: 100%; height: auto; margin: 1em auto; }
    pre, code { font-family: Consolas, "SFMono-Regular", monospace; }
    pre { padding: 1em; overflow: auto; background: #f3f5f3; }
    .conversion-note {
      width: min(816px, 100%);
      margin: 0 auto 12px;
      padding: 9px 12px;
      color: ${canvasText};
      border: 1px solid rgba(127, 137, 130, .35);
      background: ${dark ? "#22251f" : "#f4f6f4"};
      font-size: 12px;
    }
    @media (max-width: 640px) {
      body { padding: 10px; }
      .document-sheet { min-height: calc(100vh - 20px); padding: 24px 18px; }
    }
  </style>
</head>
<body>
  ${warning}
  <article class="document-sheet">${preview.html || "<p>该文档没有可显示的正文内容。</p>"}</article>
</body>
</html>`;
}

function sendDocumentHtml(res, statusCode, html) {
  const body = Buffer.from(html, "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function buildDocumentPreviewErrorPage(message, theme = "light") {
  const dark = theme === "dark";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{color-scheme:${dark ? "dark" : "light"}}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:${dark ? "#171814" : "#eef1ee"};color:${dark ? "#e2e5df" : "#313630"};font:14px/1.6 "Microsoft YaHei UI","Microsoft YaHei",sans-serif}.error{max-width:520px;padding:24px;border:1px solid ${dark ? "#454940" : "#cdd3cd"};background:${dark ? "#22251f" : "#fff"};text-align:center}.error strong{display:block;margin-bottom:6px;font-size:16px}
  </style></head><body><div class="error"><strong>DOCX 预览失败</strong>${escapeDocumentHtml(message)}</div></body></html>`;
}

async function getDirSize(dirPath, depth = 1) {
  const maxDepth = Number.isFinite(MAX_FOLDER_SIZE_DEPTH) && MAX_FOLDER_SIZE_DEPTH > 0
    ? MAX_FOLDER_SIZE_DEPTH
    : 64;
  let total = 0;
  const stack = [{ dirPath, depth }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > maxDepth) continue;

    let entries;
    try {
      entries = await fsp.readdir(toFsPath(current.dirPath), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push({ dirPath: fullPath, depth: current.depth + 1 });
        } else if (entry.isFile()) {
          const stat = await fsp.stat(toFsPath(fullPath));
          total += stat.size;
        }
      } catch {}
    }
  }

  return total;
}

function getFolderSizeParent(relativePath) {
  const normalized = safeRelative(relativePath);
  if (!normalized) return "";
  const parent = path.posix.dirname(normalized);
  return parent === "." ? "" : safeRelative(parent);
}

async function loadFolderSizeCache() {
  try {
    const raw = JSON.parse(await fsp.readFile(FOLDER_SIZE_CACHE_FILE, "utf8"));
    const entries = raw.entries && typeof raw.entries === "object" ? raw.entries : raw;
    for (const [rawKey, rawEntry] of Object.entries(entries || {})) {
      const key = safeRelative(rawKey);
      const size = Number(rawEntry && rawEntry.size);
      if (!Number.isFinite(size) || size < 0) continue;
      folderSizeCache.set(key, {
        size,
        dirMtimeMs: Number(rawEntry.dirMtimeMs) || 0,
        scannedAt: Number(rawEntry.scannedAt) || 0
      });
    }
    if (folderSizeCache.size > 0) {
      console.log(`文件夹大小缓存已加载 ${folderSizeCache.size} 项`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`文件夹大小缓存读取失败: ${error.message}`);
    }
  }
}

async function saveFolderSizeCache() {
  if (folderSizeCacheSaveTimer) {
    clearTimeout(folderSizeCacheSaveTimer);
    folderSizeCacheSaveTimer = null;
  }
  const entries = {};
  for (const [key, entry] of folderSizeCache.entries()) {
    entries[key] = entry;
  }
  const payload = JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries
  }, null, 2);
  const tempPath = `${FOLDER_SIZE_CACHE_FILE}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tempPath, payload, "utf8");
    await fsp.rename(tempPath, FOLDER_SIZE_CACHE_FILE);
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => {});
    console.error(`文件夹大小缓存保存失败: ${error.message}`);
  }
}

function scheduleFolderSizeCacheSave() {
  if (folderSizeCacheSaveTimer) return;
  folderSizeCacheSaveTimer = setTimeout(() => {
    saveFolderSizeCache().catch((error) => {
      console.error(`文件夹大小缓存保存失败: ${error.message}`);
    });
  }, FOLDER_SIZE_CACHE_SAVE_DELAY_MS);
  if (folderSizeCacheSaveTimer.unref) folderSizeCacheSaveTimer.unref();
}

function removeFolderSizeCacheKey(key) {
  if (folderSizeCache.delete(key)) {
    return true;
  }
  return false;
}

function invalidateFolderSizeCacheForPath(relativePath, nsfw) {
  var key = safeRelative(relativePath);
  if (nsfw) key = "nsfw:" + key;
  let changed = false;

  if (!key) {
    if (folderSizeCache.size > 0) {
      folderSizeCache.clear();
      changed = true;
    }
  } else {
    for (const cacheKey of [...folderSizeCache.keys()]) {
      if (cacheKey === key || cacheKey.startsWith(`${key}/`)) {
        changed = removeFolderSizeCacheKey(cacheKey) || changed;
      }
    }
  }

  let current = key ? getFolderSizeParent(key) : "";
  while (true) {
    changed = removeFolderSizeCacheKey(current) || changed;
    if (!current) break;
    current = getFolderSizeParent(current);
  }

  if (changed) scheduleFolderSizeCacheSave();
}

function enqueueFolderSizeCalculation(relativePath) {
  const key = safeRelative(relativePath);
  if (queuedFolderSizePaths.has(key)) return;
  queuedFolderSizePaths.add(key);
  folderSizeQueue.push(key);
  processFolderSizeQueue();
}

function processFolderSizeQueue() {
  const maxJobs = Math.max(1, Number(MAX_FOLDER_SIZE_JOBS) || 1);
  while (activeFolderSizeJobs < maxJobs && folderSizeQueue.length > 0) {
    const key = folderSizeQueue.shift();
    activeFolderSizeJobs += 1;
    calculateFolderSizeJob(key)
      .catch((error) => {
        console.error(`文件夹大小计算失败 ${key || "shared"}: ${error.message}`);
      })
      .finally(() => {
        activeFolderSizeJobs = Math.max(0, activeFolderSizeJobs - 1);
        queuedFolderSizePaths.delete(key);
        processFolderSizeQueue();
      });
  }
}

async function calculateFolderSizeJob(relativePath) {
  var key = safeRelative(relativePath);
  var isNsfw = false;
  if (key.startsWith("nsfw:")) { key = key.slice(5); isNsfw = true; }
  var root = isNsfw ? NSFW_DIR : ROOT_DIR;
  const dirPath = path.resolve(root, key);
  if (dirPath !== root && !dirPath.startsWith(root + path.sep)) return;
  var cacheKey = isNsfw ? "nsfw:" + key : key;
  const beforeStat = await fsp.stat(toFsPath(dirPath)).catch(() => null);
  if (!beforeStat || !beforeStat.isDirectory()) {
    if (folderSizeCache.delete(cacheKey)) scheduleFolderSizeCacheSave();
    return;
  }

  const size = await getDirSize(dirPath, 1);
  const currentStat = await fsp.stat(toFsPath(dirPath)).catch(() => null);
  if (!currentStat || !currentStat.isDirectory()) {
    if (folderSizeCache.delete(cacheKey)) scheduleFolderSizeCacheSave();
    return;
  }

  folderSizeCache.set(cacheKey, {
    size,
    dirMtimeMs: currentStat.mtimeMs,
    scannedAt: Date.now()
  });
  scheduleFolderSizeCacheSave();
}

function getFolderSizeInfo(relativePath, stat) {
  const key = safeRelative(relativePath);
  const entry = folderSizeCache.get(key);
  const now = Date.now();

  if (entry && Number.isFinite(entry.size)) {
    const expired = FOLDER_SIZE_CACHE_MAX_AGE_MS > 0
      && (!Number.isFinite(entry.scannedAt) || now - entry.scannedAt > FOLDER_SIZE_CACHE_MAX_AGE_MS);
    const mtimeChanged = !Number.isFinite(entry.dirMtimeMs)
      || Math.abs(Number(entry.dirMtimeMs) - stat.mtimeMs) > 1;
    const stale = expired || mtimeChanged;
    if (stale) enqueueFolderSizeCalculation(key);
    return {
      folderSize: entry.size,
      folderSizeStatus: stale ? "stale" : "ready",
      folderSizeCachedAt: entry.scannedAt || null
    };
  }

  enqueueFolderSizeCalculation(key);
  return {
    folderSize: null,
    folderSizeStatus: "pending",
    folderSizeCachedAt: null
  };
}

async function readFolderSizeStatus(relativePath, rootOverride) {
  const root = rootOverride || ROOT_DIR;
  const key = safeRelative(relativePath);
  const fullPath = path.resolve(root, key);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) return { path: key, folderSize: null, folderSizeStatus: "missing", folderSizeCachedAt: null };
  const stat = await fsp.stat(toFsPath(fullPath)).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return { path: key, folderSize: null, folderSizeStatus: "missing", folderSizeCachedAt: null };
  }
  var cacheKey = rootOverride ? "nsfw:" + key : key;
  return { path: key, ...getFolderSizeInfo(cacheKey, stat) };
}

async function buildListItem(item, normalizedDir, rootOverride) {
  const root = rootOverride || ROOT_DIR;
  const childRelative = safeRelative(path.posix.join(normalizedDir, item.name));
  const childPath = path.resolve(root, childRelative);
  if (childPath !== root && !childPath.startsWith(root + path.sep)) throw new Error("路径越界");
  const stat = await fsp.stat(childPath);
  const previewType = item.isDirectory() ? "none" : getPreviewType(item.name);
  const result = {
    name: item.name,
    path: childRelative,
    type: item.isDirectory() ? "directory" : "file",
    previewType,
    size: item.isDirectory() ? null : stat.size,
    updatedAt: stat.mtime.toISOString(),
    bornAt: stat.birthtime.toISOString()
  };
  if (item.isDirectory()) {
    var sizeKey = rootOverride ? "nsfw:" + childRelative : childRelative;
    Object.assign(result, getFolderSizeInfo(sizeKey, stat));
    // 读取项目状态：completed / in_progress / not_started
    var status = "not_started"
    try {
      status = (await fsp.readFile(path.join(childPath, ".status"), "utf8")).trim()
    } catch (_) {
      // 兼容旧版 .complete 标记
      try { await fsp.access(path.join(childPath, ".complete")); status = "completed" } catch (_2) {}
    }
    result.status = status
    result.isProject = await fsp.access(path.join(childPath, ".project")).then(function() { return true }).catch(function() { return false })
  }
  return result;
}

function parseChineseNumeral(text) {
  const digits = { "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
  const units = { "十": 10, "百": 100, "千": 1000 };
  let total = 0;
  let current = 0;
  for (const char of text) {
    if (char in digits) {
      current = digits[char];
      continue;
    }
    if (char in units) {
      total += (current || 1) * units[char];
      current = 0;
      continue;
    }
    return null;
  }
  return total + current;
}

function extractOrdinalValue(name) {
  const text = String(name);
  const patterns = [
    /第\s*([零〇一二两三四五六七八九十百千\d]+)\s*(?=集|话|章|回|卷|部|季|期|篇|$)/,
    /\b(?:ep|e)(\d+)\b/i,
    /(^|[^\d])(\d+)\s*(?=集|话|章|回|卷|部|季|期|篇|$)/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const raw = match[1] && /^\d+$/.test(match[1]) ? match[1] : match[2] || match[1];
    if (!raw) continue;
    if (/^\d+$/.test(raw)) return Number(raw);
    const parsed = parseChineseNumeral(raw);
    if (parsed != null) return parsed;
  }
  return null;
}

function compareNames(aName, bName) {
  const aOrdinal = extractOrdinalValue(aName);
  const bOrdinal = extractOrdinalValue(bName);
  if (aOrdinal != null && bOrdinal != null && aOrdinal !== bOrdinal) {
    return aOrdinal - bOrdinal;
  }
  return aName.localeCompare(bName, "zh-CN", { numeric: true, sensitivity: "base" });
}

function isInvalidFileName(name) {
  return /[<>:"/\\|?*]/.test(name);
}

function getStatType(stat) {
  if (!stat) return "unknown";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function makeConflict(relativePath, stat) {
  return {
    path: relativePath,
    name: path.posix.basename(relativePath),
    type: getStatType(stat)
  };
}

function createConflictError(conflicts, message = "目标位置已存在同名项目") {
  const error = new Error(message);
  error.statusCode = 409;
  error.conflicts = conflicts;
  return error;
}

function normalizeUploadRelativeName(relativeNameRaw) {
  const normalized = String(relativeNameRaw || "").replaceAll("\\", "/").trim();
  if (!normalized) throw new Error("存在文件名为空的上传项");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) throw new Error("上传路径无效");
  for (const segment of segments) {
    if (segment === "." || segment === ".." || isInvalidFileName(segment)) {
      throw new Error(`文件名非法: ${normalized}`);
    }
  }
  return segments.join("/");
}

function getUploadTargetRelative(dir, relativeNameRaw) {
  const safeDir = safeRelative(dir);
  const uploadRelative = normalizeUploadRelativeName(relativeNameRaw);
  return safeRelative(path.posix.join(safeDir, uploadRelative));
}

async function collectUploadConflicts(dir, entries, rootOverride) {
  const root = rootOverride || ROOT_DIR;
  const safeDir = safeRelative(dir);
  const conflictMap = new Map();
  const uploadEntries = Array.isArray(entries) ? entries : [];

  for (const entry of uploadEntries) {
    const uploadRelative = normalizeUploadRelativeName(entry);
    const segments = uploadRelative.split("/");
    let currentDir = safeDir;

    for (const segment of segments.slice(0, -1)) {
      currentDir = safeRelative(path.posix.join(currentDir, segment));
      const currentPath = path.resolve(root, currentDir);
      if (currentPath !== root && !currentPath.startsWith(root + path.sep)) continue;
      const currentStat = await fsp.stat(toFsPath(currentPath)).catch(() => null);
      if (currentStat && !currentStat.isDirectory()) {
        conflictMap.set(currentDir, makeConflict(currentDir, currentStat));
      }
    }

    const targetRelative = safeRelative(path.posix.join(safeDir, uploadRelative));
    const targetPath = path.resolve(root, targetRelative);
    if (targetPath !== root && !targetPath.startsWith(root + path.sep)) continue;
    const targetStat = await fsp.stat(toFsPath(targetPath)).catch(() => null);
    if (targetStat) {
      conflictMap.set(targetRelative, makeConflict(targetRelative, targetStat));
    }
  }

  return [...conflictMap.values()];
}

async function ensureUploadParentDirectories(fileRelative, overwriteExisting, rootOverride) {
  var root = rootOverride || ROOT_DIR;
  const segments = fileRelative.split("/").filter(Boolean);
  let currentRelative = "";

  for (const segment of segments.slice(0, -1)) {
    currentRelative = safeRelative(path.posix.join(currentRelative, segment));
    const currentPath = path.resolve(root, currentRelative);
    if (currentPath !== root && !currentPath.startsWith(root + path.sep)) throw new Error("路径越界");
    const currentStat = await fsp.stat(toFsPath(currentPath)).catch(() => null);

    if (!currentStat) {
      await ensureDir(currentPath);
      continue;
    }

    if (currentStat.isDirectory()) continue;

    const conflict = makeConflict(currentRelative, currentStat);
    if (!overwriteExisting) {
      throw createConflictError([conflict], "存在同名项目，请确认是否覆盖");
    }

    await cleanupThumbCacheForPath(currentPath, currentStat);
    await moveToRecycle(currentRelative, root);
    await ensureDir(currentPath);
  }
}

async function getRecycleEntryFileNames(entryId) {
  const names = [];
  try {
    const entryDir = resolveRecycleEntryDir(entryId);
    const meta = JSON.parse(await fsp.readFile(path.join(entryDir, "meta.json"), "utf8"));
    const storedPath = resolveRecycleStoredPath(entryDir, meta.storedName);
    const stat = await fsp.stat(storedPath);
    if (stat.isDirectory()) {
      names.push(...await collectDirFileNames(storedPath));
    } else {
      names.push(meta.name || meta.storedName);
    }
  } catch {}
  return names;
}

async function collectDirFileNames(dirPath, prefix = "") {
  const names = [];
  try {
    const items = await fsp.readdir(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".bg")) continue;
      const label = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        names.push(`${label} (文件夹)`);
        names.push(...await collectDirFileNames(path.join(dirPath, item.name), label));
      } else {
        names.push(label);
      }
    }
  } catch {}
  return names;
}

function countLoggedFileNames(items) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    const label = String(item || "");
    if (!label || / \(文件夹\)$/.test(label)) return false;
    const name = label.split("/").pop();
    return Boolean(name && !name.startsWith("."));
  }).length;
}

async function measureWorkspaceFiles(fullPath) {
  const initialStat = await fsp.stat(toFsPath(fullPath)).catch(() => null);
  if (!initialStat) return { fileCount: 0, totalBytes: 0 };
  if (initialStat.isFile()) {
    return path.basename(fullPath).startsWith(".")
      ? { fileCount: 0, totalBytes: 0 }
      : { fileCount: 1, totalBytes: initialStat.size };
  }
  if (!initialStat.isDirectory()) return { fileCount: 0, totalBytes: 0 };

  let fileCount = 0;
  let totalBytes = 0;
  const stack = [fullPath];
  while (stack.length > 0) {
    const currentPath = stack.pop();
    const entries = await fsp.readdir(toFsPath(currentPath), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(childPath);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(toFsPath(childPath)).catch(() => null);
        if (!stat) continue;
        fileCount += 1;
        totalBytes += stat.size;
      }
    }
  }
  return { fileCount, totalBytes };
}

async function countWorkspaceFiles(fullPath) {
  return (await measureWorkspaceFiles(fullPath)).fileCount;
}

function getDeviceName(req) {
  if (req.authUser && req.authUser.name) return req.authUser.name;
  const raw = String(req.headers["x-device-name"] || "").trim();
  try { return decodeURIComponent(raw) || "未知"; } catch { return raw || "未知"; }
}

function getClientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

function logAction(deviceName, clientIp, action, detail, items) {
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  const ipLabel = clientIp ? ` (${clientIp})` : "";
  const entry = { time, deviceName, clientIp, action, detail };
  if (items && items.length > 0) entry.items = items;
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();

  const logLine = `[${time}] ${deviceName}${ipLabel} ${action} ${detail}`;
  console.log(logLine);

  (async () => {
    try {
      await appendLogFileEntry(logLine, items);
    } catch {}
  })();
}

async function appendLogFileEntry(logLine, items) {
  const logFile = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
  let fileContent = logLine + "\n";
  if (items && items.length > 0) {
    fileContent += items.map((item) => `  - ${item}\n`).join("");
  }
  await fsp.appendFile(logFile, fileContent, "utf8");
  workspaceActivityCache = null;
  const stat = await fsp.stat(logFile).catch(() => null);
  if (stat && stat.size > MAX_LOG_SIZE) {
    try { await fsp.rename(`${logFile}.1`, `${logFile}.2`); } catch {}
    try { await fsp.rename(logFile, `${logFile}.1`); } catch {}
  }
}

async function readTodayWorkspaceActivity() {
  const dateId = new Date().toISOString().slice(0, 10);
  const logFile = path.join(LOG_DIR, `${dateId}.log`);
  const stat = await fsp.stat(logFile).catch(() => null);
  if (!stat) {
    return {
      uploadedFiles: 0,
      uploadedBytes: 0,
      uploadedBytesComplete: true,
      downloadedFiles: 0,
      downloadedBytes: 0,
      downloadedBytesComplete: true,
      deletedItems: 0,
      deletedBytes: 0,
      deletedBytesComplete: true,
      activeDevices: 0
    };
  }
  if (
    workspaceActivityCache
    && workspaceActivityCache.dateId === dateId
    && workspaceActivityCache.mtimeMs === stat.mtimeMs
    && workspaceActivityCache.size === stat.size
  ) {
    return workspaceActivityCache.result;
  }
  const content = await fsp.readFile(logFile, "utf8");
  let uploadedFiles = 0;
  let uploadedBytes = 0;
  let uploadedBytesComplete = true;
  let downloadedFiles = 0;
  let downloadedBytes = 0;
  let downloadedBytesComplete = true;
  let deletedItems = 0;
  let deletedBytes = 0;
  let deletedBytesComplete = true;
  const activeDevices = new Set();
  let currentEntry = null;
  const addCurrentEntry = () => {
    if (!currentEntry) return;
    const { deviceName, clientIp, action, detail, items } = currentEntry;
    activeDevices.add(clientIp || deviceName);

    const explicitFileCount = detail.match(/[（(](\d+) 个文件[）)]/);
    let itemCount;
    if (explicitFileCount) {
      itemCount = Number(explicitFileCount[1]);
    } else if (items.length > 0) {
      itemCount = action === "删除" || action === "彻底删除"
        ? countLoggedFileNames(items)
        : items.length;
    } else {
      const legacyCount = detail.match(/^(\d+) 项$/);
      itemCount = legacyCount ? Number(legacyCount[1]) : 1;
    }

    const explicitBytes = detail.match(/(?:，|,)\s*(\d+)\s*字节[）)]/);
    const byteCount = explicitBytes ? Number(explicitBytes[1]) : 0;
    if (action === "上传") {
      uploadedFiles += itemCount;
      uploadedBytes += byteCount;
      if (!explicitBytes) uploadedBytesComplete = false;
    }
    if (action === "下载") {
      downloadedFiles += itemCount;
      downloadedBytes += byteCount;
      if (!explicitBytes) downloadedBytesComplete = false;
    }
    if (action === "删除") {
      deletedItems += itemCount;
      deletedBytes += byteCount;
      if (!explicitBytes) deletedBytesComplete = false;
    }
    currentEntry = null;
  };

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\[(.+?)\] (.+?)(?: \(([^)]+)\))? ([^ ]+) (.+)$/);
    if (match) {
      addCurrentEntry();
      if (match[4] !== "修改昵称") {
        currentEntry = {
          deviceName: match[2],
          clientIp: match[3],
          action: match[4],
          detail: match[5],
          items: []
        };
      }
      continue;
    }
    const itemMatch = line.match(/^  - (.+)$/);
    if (itemMatch && currentEntry) {
      currentEntry.items.push(itemMatch[1]);
      continue;
    }
    addCurrentEntry();
  }
  addCurrentEntry();
  const result = {
    uploadedFiles,
    uploadedBytes,
    uploadedBytesComplete,
    downloadedFiles,
    downloadedBytes,
    downloadedBytesComplete,
    deletedItems,
    deletedBytes,
    deletedBytesComplete,
    activeDevices: activeDevices.size
  };
  workspaceActivityCache = { dateId, mtimeMs: stat.mtimeMs, size: stat.size, result };
  return result;
}

async function appendLocalLogOnly(deviceName, clientIp, action, detail, items) {
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  const ipLabel = clientIp ? ` (${clientIp})` : "";
  const logLine = `[${time}] ${deviceName}${ipLabel} ${action} ${detail}`;
  try {
    await appendLogFileEntry(logLine, items);
  } catch {}
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8") || "{}");
  } catch {
    throw new Error("请求 JSON 格式错误");
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        const error = new Error(`上传体积过大，超过 ${Math.floor(MAX_BODY_SIZE / 1024 / 1024)}MB`);
        error.statusCode = 413;
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

async function serveStaticFile(res, filePath) {
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, {
    "Content-Type": getMimeType(filePath),
    "Cache-Control": "no-cache"
  });
  stream.pipe(res);
  stream.on("error", () => {
    if (!res.headersSent) {
      sendText(res, 500, "文件读取失败");
    } else {
      res.destroy();
    }
  });
  res.on("close", () => {
    stream.destroy();
  });
}

async function pipeFileToResponse(res, filePath, options = {}) {
  const stream = fs.createReadStream(filePath, options);
  stream.on("error", (error) => {
    console.error(`文件流读取失败: ${error.message}`);
    if (!res.headersSent) {
      sendText(res, error.code === "EMFILE" ? 503 : 500, "文件读取失败，请稍后重试");
      return;
    }
    res.destroy();
  });
  res.on("close", () => {
    stream.destroy();
  });
  stream.pipe(res);
}

function getThumbCachePath(fullPath, stat, type, ext = "webp") {
  const key = crypto
    .createHash("md5")
    .update(`${type}:${fullPath}:${stat.size}:${stat.mtimeMs}`)
    .digest("hex");
  return path.join(TMP_DIR, `${key}.${ext}`);
}

function getThumbMetaPath(cachePath) {
  return `${cachePath}.json`;
}

function getLegacyThumbCachePaths(fullPath) {
  const key = crypto.createHash("md5").update(fullPath).digest("hex");
  return [
    path.join(TMP_DIR, `${key}.webp`),
    path.join(TMP_DIR, `${key}.jpg`)
  ];
}

function isPathInsideOrEqual(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSameThumbSource(stat, sourceStat) {
  return stat.size === sourceStat.size && Math.abs(stat.mtimeMs - sourceStat.mtimeMs) < 1;
}

async function writeThumbCacheMeta(cachePath, fullPath, stat, type) {
  const meta = {
    fullPath: path.resolve(fullPath),
    type,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    generatedAt: new Date().toISOString()
  };
  await fsp.writeFile(getThumbMetaPath(cachePath), JSON.stringify(meta, null, 2), "utf8").catch(() => {});
}

async function removeThumbCachePath(cachePath) {
  await fsp.unlink(cachePath).catch(() => {});
  await fsp.unlink(getThumbMetaPath(cachePath)).catch(() => {});
}

async function removeThumbCacheForFile(fullPath, stat) {
  const ext = path.extname(fullPath).toLowerCase();
  if (!IMAGE_THUMB_EXTS.has(ext) && !VIDEO_THUMB_EXTS.has(ext)) return;

  const cachePaths = new Set(getLegacyThumbCachePaths(fullPath));
  if (stat && stat.isFile()) {
    if (IMAGE_THUMB_EXTS.has(ext)) {
      cachePaths.add(getThumbCachePath(fullPath, stat, "image"));
    }
    if (VIDEO_THUMB_EXTS.has(ext)) {
      cachePaths.add(getThumbCachePath(fullPath, stat, "video", "jpg"));
    }
  }

  await Promise.all([...cachePaths].map((cachePath) => removeThumbCachePath(cachePath)));
}

function removeQueuedVideoThumbsForPath(fullPath) {
  const resolved = path.resolve(fullPath);
  for (let i = videoThumbQueue.length - 1; i >= 0; i--) {
    const job = videoThumbQueue[i];
    if (!isPathInsideOrEqual(resolved, job.fullPath)) continue;
    videoThumbQueue.splice(i, 1);
    videoThumbJobs.delete(job.cachePath);
    fsp.unlink(job.tempPath).catch(() => {});
  }
}

async function cleanupThumbCacheForPath(fullPath, stat) {
  const currentStat = stat || await fsp.stat(toFsPath(fullPath)).catch(() => null);
  if (!currentStat) return;

  removeQueuedVideoThumbsForPath(fullPath);

  if (currentStat.isFile()) {
    await removeThumbCacheForFile(fullPath, currentStat);
    return;
  }

  if (!currentStat.isDirectory()) return;

  const stack = [fullPath];
  while (stack.length > 0) {
    const dirPath = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(toFsPath(dirPath), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const childPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(childPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const childStat = await fsp.stat(toFsPath(childPath)).catch(() => null);
      if (childStat) {
        await removeThumbCacheForFile(childPath, childStat);
      }
    }
  }
}

async function verifyThumbSource(meta) {
  const fullPath = path.resolve(String(meta.fullPath || ""));
  if (!isPathInsideOrEqual(ROOT_DIR, fullPath) && !isPathInsideOrEqual(NSFW_DIR, fullPath)) return false;
  const stat = await fsp.stat(toFsPath(fullPath)).catch(() => null);
  if (!stat || !stat.isFile()) return false;
  return isSameThumbSource(stat, meta);
}

async function cleanupStaleThumbnailCache() {
  await ensureDir(TMP_DIR);
  const maxAgeMs = Number.isFinite(THUMB_CACHE_MAX_AGE_DAYS) && THUMB_CACHE_MAX_AGE_DAYS > 0
    ? THUMB_CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    : 0;
  const now = Date.now();
  const entries = await fsp.readdir(TMP_DIR, { withFileTypes: true }).catch(() => []);
  let deletedCount = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".json")) continue;

    const cachePath = path.join(TMP_DIR, entry.name);
    const lowerName = entry.name.toLowerCase();
    if (lowerName.includes(".tmp")) {
      const stat = await fsp.stat(cachePath).catch(() => null);
      if (stat && now - stat.mtimeMs > THUMB_TEMP_MAX_AGE_MS) {
        await fsp.unlink(cachePath).catch(() => {});
        deletedCount += 1;
      }
      continue;
    }

    if (!lowerName.endsWith(".webp") && !lowerName.endsWith(".jpg")) continue;

    const metaPath = getThumbMetaPath(cachePath);
    let shouldDelete = false;
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
      shouldDelete = !(await verifyThumbSource(meta));
    } catch {
      if (maxAgeMs > 0) {
        const stat = await fsp.stat(cachePath).catch(() => null);
        shouldDelete = !!stat && now - stat.mtimeMs > maxAgeMs;
      }
    }

    if (shouldDelete) {
      await removeThumbCachePath(cachePath);
      deletedCount += 1;
    }
  }

  if (deletedCount > 0) {
    console.log(`缩略图缓存已清理 ${deletedCount} 项`);
  }
  return deletedCount;
}

async function sendThumbCache(res, cachePath, mimeType = "image/webp") {
  const content = await fsp.readFile(cachePath);
  res.writeHead(200, {
    "Content-Type": mimeType,
    "Content-Length": content.length,
    "Cache-Control": "public,max-age=86400",
    "X-Thumb-Status": "ready"
  });
  res.end(content);
}

function sendThumbPlaceholder(res, label = "VIDEO", status = "pending") {
  const svg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2d536c"/>
      <stop offset="100%" stop-color="#263a53"/>
    </linearGradient>
  </defs>
  <rect width="200" height="120" rx="18" fill="url(#g)"/>
  <path d="M86 39v42l36-21z" fill="rgba(255,255,255,.88)"/>
  <text x="100" y="102" text-anchor="middle" fill="rgba(255,255,255,.82)" font-family="Arial,sans-serif" font-size="16" font-weight="700">${label}</text>
</svg>`.trim());
  res.writeHead(200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Content-Length": svg.length,
    "Cache-Control": "no-store",
    "X-Thumb-Status": status
  });
  res.end(svg);
}

async function generateImageThumb(fullPath, stat, cachePath) {
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await sharp(fullPath, { limitInputPixels: 12000 * 12000 })
      .rotate()
      .resize({
        width: 200,
        height: 200,
        fit: "inside",
        withoutEnlargement: true
      })
      .webp({ quality: 70 })
      .toFile(tempPath);
    const currentStat = await fsp.stat(toFsPath(fullPath));
    if (!isSameThumbSource(currentStat, stat)) {
      await fsp.unlink(tempPath).catch(() => {});
      return;
    }
    await fsp.rename(tempPath, cachePath);
    await writeThumbCacheMeta(cachePath, fullPath, stat, "image");
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function enqueueVideoThumb(fullPath, stat, cachePath) {
  if (videoThumbJobs.has(cachePath)) return;
  const job = {
    fullPath,
    sourceStat: { size: stat.size, mtimeMs: stat.mtimeMs },
    cachePath,
    tempPath: `${cachePath}.${process.pid}.${Date.now()}.tmp.jpg`
  };
  videoThumbJobs.set(cachePath, job);
  videoThumbQueue.push(job);
  processVideoThumbQueue();
}

function processVideoThumbQueue() {
  while (activeVideoThumbJobs < MAX_VIDEO_THUMB_JOBS && videoThumbQueue.length > 0) {
    const job = videoThumbQueue.shift();
    activeVideoThumbJobs += 1;
    generateVideoThumb(job)
      .catch((error) => {
        console.error(`视频缩略图生成失败 ${job.fullPath}: ${error.message}`);
      })
      .finally(() => {
        activeVideoThumbJobs = Math.max(0, activeVideoThumbJobs - 1);
        videoThumbJobs.delete(job.cachePath);
        processVideoThumbQueue();
      });
  }
}

function generateVideoThumb(job) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-analyzeduration", "100M",
      "-probesize", "50M",
      "-ss", "00:00:01",
      "-i", job.fullPath,
      "-map", "0:v:0",
      "-frames:v", "1",
      "-vf", "scale=200:-1",
      "-q:v", "4",
      "-an",
      job.tempPath
    ];
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let settled = false;
    let stderr = "";
    const done = async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        await fsp.unlink(job.tempPath).catch(() => {});
        reject(error);
        return;
      }
      try {
        const currentStat = await fsp.stat(toFsPath(job.fullPath));
        if (!isSameThumbSource(currentStat, job.sourceStat)) {
          await fsp.unlink(job.tempPath).catch(() => {});
          resolve();
          return;
        }
        await fsp.rename(job.tempPath, job.cachePath);
        await writeThumbCacheMeta(job.cachePath, job.fullPath, job.sourceStat, "video");
        resolve();
      } catch (renameError) {
        await fsp.unlink(job.tempPath).catch(() => {});
        reject(renameError);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      void done(new Error("ffmpeg 超时"));
    }, 30000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    child.on("error", (error) => {
      void done(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        void done();
        return;
      }
      void done(new Error(stderr.trim() || `ffmpeg 退出码 ${code}`));
    });
  });
}

async function handleThumbnail(res, url, req) {
  const q = safeRelative(url.searchParams.get("path") || "");
  const root = (req && req._nsfwMode) ? NSFW_DIR : ROOT_DIR;
  const fullPath = path.resolve(root, q);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) throw new Error("路径越界");
  const stat = await fsp.stat(fullPath);
  if (!stat.isFile()) {
    throw new Error("仅支持文件缩略图");
  }

  const ext = path.extname(fullPath).toLowerCase();
  await ensureDir(TMP_DIR);

  if (IMAGE_THUMB_EXTS.has(ext)) {
    if (stat.size > MAX_THUMB_SOURCE_SIZE) {
      throw new Error("图片过大，已跳过缩略图生成");
    }
    const cachePath = getThumbCachePath(fullPath, stat, "image");
    try {
      await sendThumbCache(res, cachePath);
      return;
    } catch {}
    await generateImageThumb(fullPath, stat, cachePath);
    await sendThumbCache(res, cachePath);
    return;
  }

  if (VIDEO_THUMB_EXTS.has(ext)) {
    const cachePath = getThumbCachePath(fullPath, stat, "video", "jpg");
    try {
      await sendThumbCache(res, cachePath, "image/jpeg");
      return;
    } catch {}
    enqueueVideoThumb(fullPath, stat, cachePath);
    sendThumbPlaceholder(res, "VIDEO", "pending");
    return;
  }

  throw new Error("不支持的缩略图类型");
}

function getLanUrls() {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`http://${entry.address}:${PORT}`);
      }
    }
  }
  return urls;
}

function makeTimestampId() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}_${ms}`;
}

async function writeBackupFile(batchId, relativePath, data) {
  const backupPath = path.join(BACKUP_DIR, batchId, relativePath);
  await ensureDir(path.dirname(backupPath));
  await fsp.writeFile(backupPath, data);
}

function makeDailySnapshotId(now = new Date()) {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${yyyy}-${mm}-${dd}_${hh}${mi}${ss}_${ms}`;
}

function makeBackupManifestKey(sourceName, relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/");
  return normalized ? `${sourceName}/${normalized}` : sourceName;
}

function isSameBackupFileState(previousState, stat) {
  return previousState
    && Number(previousState.size) === stat.size
    && Number(previousState.mtimeMs) === Math.trunc(stat.mtimeMs)
    && Number.isFinite(Number(previousState.ctimeMs))
    && Number(previousState.ctimeMs) === Math.trunc(stat.ctimeMs);
}

function isSameSourceFileState(initialStat, finalStat) {
  return finalStat.size === initialStat.size
    && Math.trunc(finalStat.mtimeMs) === Math.trunc(initialStat.mtimeMs)
    && Math.trunc(finalStat.ctimeMs) === Math.trunc(initialStat.ctimeMs)
    && finalStat.ino === initialStat.ino;
}

async function assertBackupSourceStable(sourcePath, initialStat) {
  const finalStat = await fsp.stat(sourcePath);
  if (isSameSourceFileState(initialStat, finalStat)) return;
  const error = new Error("文件在备份过程中仍被写入，已留待下次备份");
  error.code = "BACKUP_SOURCE_CHANGED";
  throw error;
}

async function readDailyBackupManifest(snapshotDir) {
  if (!snapshotDir) return { files: {} };
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(snapshotDir, ".snapshot.json"), "utf8"));
    return manifest && manifest.files && typeof manifest.files === "object" ? manifest : { files: {} };
  } catch {
    return { files: {} };
  }
}

async function findLatestDailySnapshot() {
  const entries = await fsp.readdir(DAILY_BACKUP_DIR, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{6}_\d{3}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  return names.length > 0 ? path.join(DAILY_BACKUP_DIR, names[0]) : "";
}

async function copyStableBackupFile(sourcePath, targetPath, initialStat) {
  await fsp.copyFile(sourcePath, targetPath);
  try {
    await assertBackupSourceStable(sourcePath, initialStat);
  } catch (error) {
    await fsp.unlink(targetPath).catch(() => {});
    throw error;
  }
  await fsp.utimes(targetPath, initialStat.atime, initialStat.mtime).catch(() => {});
}

async function backupDailyDirectory(options, relativeDir = "") {
  const { sourceName, sourceRoot, snapshotDir, previousSnapshotDir, previousFiles, nextFiles, summary } = options;
  const sourceDir = path.join(sourceRoot, relativeDir);
  const targetDir = path.join(snapshotDir, sourceName, relativeDir);
  await ensureDir(targetDir);

  let entries;
  try {
    entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    summary.skipped += 1;
    summary.errors.push(`${makeBackupManifestKey(sourceName, relativeDir)}: ${error.message}`);
    return;
  }

  for (const entry of entries) {
    const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await backupDailyDirectory(options, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      summary.skipped += 1;
      summary.errors.push(`${makeBackupManifestKey(sourceName, relativePath)}: 已跳过非普通文件`);
      continue;
    }

    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(snapshotDir, sourceName, relativePath);
    const manifestKey = makeBackupManifestKey(sourceName, relativePath);
    try {
      const stat = await fsp.stat(sourcePath);
      await ensureDir(path.dirname(targetPath));
      const previousState = previousFiles[manifestKey];
      const previousPath = previousSnapshotDir ? path.join(previousSnapshotDir, sourceName, relativePath) : "";
      let linked = false;

      if (previousPath && isSameBackupFileState(previousState, stat)) {
        const previousStat = await fsp.stat(previousPath).catch(() => null);
        if (previousStat && previousStat.isFile() && previousStat.size === stat.size) {
          try {
            await fsp.link(previousPath, targetPath);
            await assertBackupSourceStable(sourcePath, stat);
            linked = true;
            summary.linked += 1;
          } catch (error) {
            await fsp.unlink(targetPath).catch(() => {});
            if (error.code === "BACKUP_SOURCE_CHANGED") throw error;
            linked = false;
          }
        }
      }

      if (!linked) {
        await copyStableBackupFile(sourcePath, targetPath, stat);
        summary.copied += 1;
        summary.copiedBytes += stat.size;
      }

      nextFiles[manifestKey] = {
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        ctimeMs: Math.trunc(stat.ctimeMs)
      };
      summary.files += 1;
    } catch (error) {
      summary.skipped += 1;
      summary.errors.push(`${manifestKey}: ${error.message}`);
    }
  }
}

function assertDailyBackupLayout() {
  for (const sourceRoot of [ROOT_DIR, NSFW_DIR]) {
    if (isPathInsideOrEqual(sourceRoot, DAILY_BACKUP_DIR) || isPathInsideOrEqual(DAILY_BACKUP_DIR, sourceRoot)) {
      throw new Error(`每日备份目录不能与共享目录互相包含: ${sourceRoot}`);
    }
  }
}

async function createDailyBackupSnapshot() {
  if (dailyBackupRunning) {
    return { skipped: true, reason: "已有每日备份正在运行" };
  }
  dailyBackupRunning = true;
  const startedAt = new Date();
  const snapshotId = makeDailySnapshotId(startedAt);
  const snapshotDir = path.join(DAILY_BACKUP_DIR, snapshotId);
  const tempDir = path.join(DAILY_BACKUP_DIR, `.${snapshotId}.in-progress-${crypto.randomUUID()}`);
  try {
    assertDailyBackupLayout();
    await ensureDir(DAILY_BACKUP_DIR);
    const previousSnapshotDir = await findLatestDailySnapshot();
    const previousManifest = await readDailyBackupManifest(previousSnapshotDir);
    const nextFiles = {};
    const summary = { files: 0, copied: 0, linked: 0, skipped: 0, copiedBytes: 0, errors: [] };
    await ensureDir(tempDir);

    for (const source of [
      { sourceName: "shared", sourceRoot: ROOT_DIR },
      { sourceName: "shared_NSFW", sourceRoot: NSFW_DIR }
    ]) {
      await backupDailyDirectory({
        ...source,
        snapshotDir: tempDir,
        previousSnapshotDir,
        previousFiles: previousManifest.files || {},
        nextFiles,
        summary
      });
    }

    const manifest = {
      version: 1,
      snapshotId,
      createdAt: new Date().toISOString(),
      previousSnapshot: previousSnapshotDir ? path.basename(previousSnapshotDir) : null,
      complete: summary.errors.length === 0,
      summary: {
        files: summary.files,
        copied: summary.copied,
        linked: summary.linked,
        skipped: summary.skipped,
        copiedBytes: summary.copiedBytes
      },
      errors: summary.errors.slice(0, 200),
      files: nextFiles
    };
    await fsp.writeFile(path.join(tempDir, ".snapshot.json"), JSON.stringify(manifest, null, 2), "utf8");
    await fsp.rename(tempDir, snapshotDir);

    const detail = `${snapshotId}：${summary.files} 个文件，新增占用 ${summary.copied} 个，硬链接复用 ${summary.linked} 个，跳过 ${summary.skipped} 个`;
    console.log(`每日备份完成: ${detail}`);
    logAction("系统", "127.0.0.1", "每日备份", detail);
    return { snapshotId, snapshotDir, ...summary };
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    console.error(`每日备份失败: ${error.message}`);
    throw error;
  } finally {
    dailyBackupRunning = false;
  }
}

function getNextDailyBackupTime(now = new Date()) {
  const next = new Date(now);
  next.setHours(DAILY_BACKUP_HOUR, DAILY_BACKUP_MINUTE, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function scheduleDailyBackup() {
  if (!DAILY_BACKUP_ENABLED) {
    console.log("每日备份: 已关闭");
    return;
  }
  const next = getNextDailyBackupTime();
  const delay = Math.max(1000, next.getTime() - Date.now());
  if (dailyBackupTimer) clearTimeout(dailyBackupTimer);
  dailyBackupTimer = setTimeout(async () => {
    try {
      await createDailyBackupSnapshot();
    } catch {}
    scheduleDailyBackup();
  }, delay);
  console.log(`每日备份: 下一次 ${next.toLocaleString("zh-CN", { hour12: false })}`);
}

async function handleStreamingUpload(req, rootDir) {
  var root = rootDir || ROOT_DIR;
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        fileSize: MAX_FILE_SIZE,
        files: 10000,
        fields: 20000
      }
    });

    let dir = "";
    let overwriteExisting = false;
    const relativePathMap = {};
    const fileTasks = [];
    let fileIndex = 0;
    let uploadedCount = 0;
    let uploadedBytes = 0;
    const uploadedNames = [];
    const uploadedPaths = [];
    const createdDirectoryPaths = new Set();
    const backupBatchId = PER_UPLOAD_BACKUP_ENABLED ? makeTimestampId() : null;
    let aborted = false;

    const fail = (error) => {
      if (aborted) return;
      aborted = true;
      reject(error);
    };

    busboy.on("field", (name, value) => {
      if (name === "dir") {
        try {
          dir = safeRelative(value);
        } catch (error) {
          fail(error);
        }
        return;
      }
      if (name === "overwrite") {
        overwriteExisting = value === "1" || value === "true";
        return;
      }
      const idxMatch = /^relativePath_(\d+)$/.exec(name);
      if (idxMatch) {
        relativePathMap[idxMatch[1]] = value;
      }
    });

    busboy.on("file", (name, fileStream, info) => {
      if (aborted) {
        fileStream.resume();
        return;
      }
      if (name !== "files") {
        fileStream.resume();
        return;
      }

      const relativeNameRaw = String(relativePathMap[String(fileIndex)] || info.filename || "").replaceAll("\\", "/").trim();
      fileIndex += 1;

      let fileRelative;
      let filePath;
      let backupPath;
      try {
        fileRelative = getUploadTargetRelative(dir, relativeNameRaw);
        filePath = path.resolve(root, fileRelative);
        if (filePath !== root && !filePath.startsWith(root + path.sep)) throw new Error("路径越界");
        backupPath = backupBatchId ? path.join(BACKUP_DIR, backupBatchId, fileRelative) : "";
      } catch (error) {
        fileStream.resume();
        fail(error);
        return;
      }

      const task = (async () => {
        const parentSegments = fileRelative.split("/").slice(0, -1);
        let parentRelative = "";
        for (const segment of parentSegments) {
          parentRelative = parentRelative ? `${parentRelative}/${segment}` : segment;
          const parentPath = path.resolve(root, parentRelative);
          const parentStat = await fsp.stat(toFsPath(parentPath)).catch(() => null);
          if (!parentStat) createdDirectoryPaths.add(parentRelative);
        }
        await ensureUploadParentDirectories(fileRelative, overwriteExisting, root);
        const existingStat = await fsp.stat(toFsPath(filePath)).catch(() => null);
        if (existingStat) {
          const conflict = makeConflict(fileRelative, existingStat);
          if (!overwriteExisting) {
            throw createConflictError([conflict], "存在同名项目，请确认是否覆盖");
          }
          await cleanupThumbCacheForPath(filePath, existingStat);
          await moveToRecycle(fileRelative, root);
        }
        await ensureDir(path.dirname(filePath));
        // 只写 shared 文件，不等待备份
        let writeCompleted = false;
        try {
          await new Promise((resolveFile, rejectFile) => {
            const sharedStream = fs.createWriteStream(filePath);
            let writeFailed = false;

            const onError = (error) => {
              writeFailed = true;
              sharedStream.destroy();
              rejectFile(error);
            };

            fileStream.on("limit", () => {
              const error = new Error(`单个文件体积过大，超过 ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}MB`);
              error.statusCode = 413;
              onError(error);
            });
            fileStream.on("error", onError);
            sharedStream.on("error", onError);

            sharedStream.on("finish", () => {
              if (writeFailed || fileStream.truncated) {
                const error = new Error(`单个文件体积过大，超过 ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}MB`);
                error.statusCode = 413;
                rejectFile(error);
                return;
              }
              writeCompleted = true;
              uploadedCount += 1;
              uploadedBytes += Number(sharedStream.bytesWritten) || 0;
              const segments = relativeNameRaw.split("/");
              uploadedNames.push(segments[segments.length - 1]);
              uploadedPaths.push(fileRelative);
              invalidateFolderSizeCacheForPath(fileRelative, root !== ROOT_DIR);
              resolveFile();
            });

            fileStream.pipe(sharedStream);
          });
        } catch (error) {
          fileStream.resume();
          if (!writeCompleted) {
            await fsp.unlink(filePath).catch(() => {});
          }
          throw error;
        }

        // 兼容旧模式；逐次上传备份默认关闭，仅显式设置环境变量时启用。
        if (backupPath) {
          (async () => {
            try {
              await ensureDir(path.dirname(backupPath));
              await fsp.copyFile(filePath, backupPath);
            } catch (err) {
              console.error(`文件备份失败 ${filePath}: ${err.message}`);
            }
          })();
        }
      })();

      fileTasks.push(task);
      task.catch(fail);
    });

    busboy.on("error", fail);
    busboy.on("finish", async () => {
      if (aborted) return;
      try {
        await Promise.all(fileTasks);
        if (uploadedCount === 0) {
          throw new Error("没有可上传的文件");
        }
        try {
          const uploader = getDeviceName(req);
          recordFileAttributions(uploadedPaths, uploader, req.authUser.id, root !== ROOT_DIR);
          recordFileAttributions([...createdDirectoryPaths], uploader, req.authUser.id, root !== ROOT_DIR, false);
        } catch (error) {
          console.error(`上传者记录写入失败: ${error.message}`);
        }
        resolve({ uploaded: uploadedCount, uploadedBytes, backupBatchId, uploadedNames });
      } catch (error) {
        fail(error);
      }
    });

    req.on("aborted", () => fail(new Error("上传已中断")));
    req.pipe(busboy);
  });
}

async function listDirectory(relativeDir, offset, limit, rootOverride) {
  const root = rootOverride || ROOT_DIR;
  const dirPath = path.resolve(root, relativeDir);
  if (dirPath !== root && !dirPath.startsWith(root + path.sep)) throw new Error("路径越界");
  const items = await fsp.readdir(dirPath, { withFileTypes: true });
  const filtered = items.filter(i => !i.name.startsWith("."));
  const sorted = filtered.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return compareNames(a.name, b.name);
  });
  const total = sorted.length;
  const page = offset !== undefined ? sorted.slice(offset, offset + (limit || 50)) : sorted;
  const normalizedDir = relativeDir.replaceAll("\\", "/");
  var pageResults = await Promise.all(page.map((item) => buildListItem(item, normalizedDir, root)));
  attachFileAttributions(pageResults, root !== ROOT_DIR);
  return { items: pageResults, total };
}

const MAX_SEARCH_RESULTS = 200;

async function searchShared(query, rootOverride) {
  const root = rootOverride || ROOT_DIR;
  const keyword = query.trim().toLowerCase();
  if (!keyword) return { items: [], stoppedEarly: false, total: 0 };

  const results = [];
  let stoppedEarly = false;

  async function walk(dirRelative) {
    if (results.length >= MAX_SEARCH_RESULTS) {
      stoppedEarly = true;
      return;
    }

    const dirPath = path.resolve(root, dirRelative);
    if (dirPath !== root && !dirPath.startsWith(root + path.sep)) return;
    let items;
    try {
      items = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    const normalizedDir = dirRelative.replaceAll("\\", "/");
    const subDirs = [];

    for (const item of items) {
      if (item.name.startsWith(".bg")) continue;
      if (results.length >= MAX_SEARCH_RESULTS) break;

      const childRelative = safeRelative(path.posix.join(normalizedDir, item.name));

      if (item.name.toLowerCase().includes(keyword)) {
        try {
          const childPath = path.resolve(root, childRelative);
          if (childPath !== root && !childPath.startsWith(root + path.sep)) continue;
          const stat = await fsp.stat(childPath);
          results.push({
            name: item.name,
            path: childRelative,
            type: item.isDirectory() ? "directory" : "file",
            previewType: item.isDirectory() ? "none" : getPreviewType(item.name),
            size: item.isDirectory() ? null : stat.size,
            updatedAt: stat.mtime.toISOString()
          });
        } catch {
          // skip unreadable items
        }
      }

      if (item.isDirectory()) {
        subDirs.push(childRelative);
      }
    }

    // Walk subdirectories in parallel at each level
    await Promise.all(subDirs.map((subDir) => walk(subDir)));
  }

  await walk("");
  attachFileAttributions(results, root !== ROOT_DIR);
  return { items: results, stoppedEarly, total: results.length };
}

async function moveToRecycle(relativePath, rootOverride) {
  const root = rootOverride || ROOT_DIR;
  const sourcePath = path.resolve(root, relativePath);
  if (sourcePath !== root && !sourcePath.startsWith(root + path.sep)) throw new Error("路径越界");
  const stat = await fsp.stat(sourcePath);
  const id = `${makeTimestampId()}_${crypto.randomUUID()}`;
  const entryDir = path.join(RECYCLE_DIR, id);
  const storedName = path.basename(sourcePath);
  const storedPath = path.join(entryDir, storedName);
  await ensureDir(entryDir);
  try {
    await fsp.rename(sourcePath, storedPath);
  } catch (err) {
    console.error(`删除失败: ${err.message} (${storedName})`);
    throw new Error("无法删除：文件正在被使用，请稍后重试。");
  }
  invalidateFolderSizeCacheForPath(relativePath, !!rootOverride);
  const meta = {
    id,
    name: storedName,
    originalPath: relativePath,
    itemType: stat.isDirectory() ? "directory" : "file",
    deletedAt: new Date().toISOString(),
    storedName,
    _nsfw: !!rootOverride
  };
  await fsp.writeFile(path.join(entryDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

async function collectMoveConflicts(paths, targetDir, rootOverride) {
  const root = rootOverride || ROOT_DIR;
  const safeTargetDir = safeRelative(targetDir);
  const targetDirPath = path.resolve(root, safeTargetDir);
  if (targetDirPath !== root && !targetDirPath.startsWith(root + path.sep)) throw new Error("路径越界");
  const targetStat = await fsp.stat(targetDirPath).catch(() => null);
  if (!targetStat || !targetStat.isDirectory()) {
    throw new Error("目标文件夹不存在");
  }

  const sourceRelatives = [...new Set(paths.map((item) => safeRelative(item)).filter(Boolean))];
  if (sourceRelatives.length === 0) {
    throw new Error("没有可移动的项目");
  }

  for (const sourceRelative of sourceRelatives) {
    if (!sourceRelative) {
      throw new Error("不能移动 shared 根目录");
    }
    for (const otherRelative of sourceRelatives) {
      if (sourceRelative !== otherRelative && otherRelative.startsWith(`${sourceRelative}/`)) {
        throw new Error(`不能同时移动父目录和它的子项：${sourceRelative}`);
      }
    }
  }

  const destinationSet = new Set();
  const conflictMap = new Map();
  for (const sourceRelative of sourceRelatives) {
    const sourcePath = path.resolve(root, sourceRelative);
    if (sourcePath !== root && !sourcePath.startsWith(root + path.sep)) continue;
    const sourceStat = await fsp.stat(sourcePath).catch(() => null);
    if (!sourceStat) {
      throw new Error(`源项目不存在：${sourceRelative}`);
    }

    const sourceName = path.posix.basename(sourceRelative);
    const destinationRelative = safeRelative(path.posix.join(safeTargetDir, sourceName));
    const destinationPath = path.resolve(root, destinationRelative);
    if (destinationPath !== root && !destinationPath.startsWith(root + path.sep)) continue;

    if (sourceRelative === destinationRelative) {
      continue;
    }

    if (destinationRelative.startsWith(`${sourceRelative}/`)) {
      throw new Error(`不能把文件夹移动到它自己的子目录中：${sourceName}`);
    }

    if (destinationSet.has(destinationRelative)) {
      throw new Error(`移动目标发生重名冲突：${sourceName}`);
    }
    destinationSet.add(destinationRelative);

    const existingDestination = await fsp.stat(destinationPath).catch(() => null);
    if (existingDestination) {
      conflictMap.set(destinationRelative, makeConflict(destinationRelative, existingDestination));
    }
  }

  return [...conflictMap.values()];
}

async function moveItems(paths, targetDir, options = {}, rootOverride) {
  const root = rootOverride || ROOT_DIR;
  const overwriteExisting = Boolean(options.overwrite);
  const safeTargetDir = safeRelative(targetDir);
  const targetDirPath = path.resolve(root, safeTargetDir);
  if (targetDirPath !== root && !targetDirPath.startsWith(root + path.sep)) throw new Error("路径越界");
  const targetStat = await fsp.stat(targetDirPath).catch(() => null);
  if (!targetStat || !targetStat.isDirectory()) {
    throw new Error("目标文件夹不存在");
  }

  const sourceRelatives = [...new Set(paths.map((item) => safeRelative(item)).filter(Boolean))];
  if (sourceRelatives.length === 0) {
    throw new Error("没有可移动的项目");
  }

  for (const sourceRelative of sourceRelatives) {
    if (!sourceRelative) {
      throw new Error("不能移动 shared 根目录");
    }
    for (const otherRelative of sourceRelatives) {
      if (sourceRelative !== otherRelative && otherRelative.startsWith(`${sourceRelative}/`)) {
        throw new Error(`不能同时移动父目录和它的子项：${sourceRelative}`);
      }
    }
  }

  const planned = [];
  const destinationSet = new Set();
  const conflicts = [];
  for (const sourceRelative of sourceRelatives) {

    const sourcePath = path.resolve(root, sourceRelative);
    if (sourcePath !== root && !sourcePath.startsWith(root + path.sep)) throw new Error("路径越界");
    const sourceStat = await fsp.stat(sourcePath).catch(() => null);
    if (!sourceStat) {
      throw new Error(`源项目不存在：${sourceRelative}`);
    }
    const sourceName = path.posix.basename(sourceRelative);
    const destinationRelative = safeRelative(path.posix.join(safeTargetDir, sourceName));
    const destinationPath = path.resolve(root, destinationRelative);
    if (destinationPath !== root && !destinationPath.startsWith(root + path.sep)) throw new Error("路径越界");

    if (sourceRelative === destinationRelative) {
      continue;
    }

    if (destinationRelative.startsWith(`${sourceRelative}/`)) {
      throw new Error(`不能把文件夹移动到它自己的子目录中：${sourceName}`);
    }

    if (destinationSet.has(destinationRelative)) {
      throw new Error(`移动目标发生重名冲突：${sourceName}`);
    }
    destinationSet.add(destinationRelative);

    const existingDestination = await fsp.stat(destinationPath).catch(() => null);
    if (existingDestination) {
      conflicts.push(makeConflict(destinationRelative, existingDestination));
    }

    planned.push({ sourceRelative, sourcePath, sourceStat, destinationRelative, destinationPath, existingDestination });
  }

  if (conflicts.length > 0 && !overwriteExisting) {
    throw createConflictError(conflicts);
  }

  const moved = [];
  for (const item of planned) {
    try {
      await cleanupThumbCacheForPath(item.sourcePath, item.sourceStat);
      if (item.existingDestination) {
        await cleanupThumbCacheForPath(item.destinationPath, item.existingDestination);
        await moveToRecycle(item.destinationRelative, root);
      }
      await fsp.rename(item.sourcePath, item.destinationPath);
      var nsfwFlag = root !== ROOT_DIR;
      invalidateFolderSizeCacheForPath(item.sourceRelative, nsfwFlag);
      invalidateFolderSizeCacheForPath(item.destinationRelative, nsfwFlag);
    } catch (err) {
      if (err.code === "EEXIST") {
        throw createConflictError([makeConflict(item.destinationRelative, item.existingDestination)]);
      }
      throw err;
    }
    moved.push({ from: item.sourceRelative, to: item.destinationRelative });
  }

  return moved;
}

async function copyItems(paths, targetDir, rootOverride) {
  const root = rootOverride || ROOT_DIR;
  const safeTargetDir = safeRelative(targetDir);
  const targetDirPath = path.resolve(root, safeTargetDir);
  if (targetDirPath !== root && !targetDirPath.startsWith(root + path.sep)) throw new Error("路径越界");
  const targetStat = await fsp.stat(targetDirPath).catch(() => null);
  if (!targetStat || !targetStat.isDirectory()) {
    throw new Error("目标文件夹不存在");
  }

  const copied = [];
  for (const item of paths) {
    const sourceRelative = safeRelative(item);
    if (!sourceRelative) {
      throw new Error("不能复制 shared 根目录");
    }

    const sourcePath = path.resolve(root, sourceRelative);
    if (sourcePath !== root && !sourcePath.startsWith(root + path.sep)) throw new Error("路径越界");
    const sourceName = path.posix.basename(sourceRelative);
    let destName = sourceName;
    let destRelative = safeRelative(path.posix.join(safeTargetDir, destName));
    let destPath = path.resolve(root, destRelative);
    if (destPath !== root && !destPath.startsWith(root + path.sep)) throw new Error("路径越界");

    // 如果目标已存在，添加 _副本 后缀
    let counter = 1;
    while (await fsp.stat(destPath).catch(() => null)) {
      const ext = path.posix.extname(sourceName);
      const base = path.posix.basename(sourceName, ext);
      destName = `${base}_副本${counter > 1 ? counter : ""}${ext}`;
      destRelative = safeRelative(path.posix.join(safeTargetDir, destName));
      destPath = path.resolve(root, destRelative);
      if (destPath !== root && !destPath.startsWith(root + path.sep)) throw new Error("路径越界");
      counter++;
    }

    await fsp.cp(sourcePath, destPath, { recursive: true });
    invalidateFolderSizeCacheForPath(destRelative, root !== ROOT_DIR);
    copied.push({ from: sourceRelative, to: destRelative });
  }

  return copied;
}

async function readRecycleEntries() {
  await ensureDir(RECYCLE_DIR);
  const entries = await fsp.readdir(RECYCLE_DIR, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryDir = resolveRecycleEntryDir(entry.name);
    const metaPath = path.join(entryDir, "meta.json");
    try {
      const metaRaw = await fsp.readFile(metaPath, "utf8");
      const meta = JSON.parse(metaRaw);
      if (!meta.storedName || !meta.id) throw new Error("meta 不完整");
      const storedPath = resolveRecycleStoredPath(entryDir, meta.storedName);
      const stat = await fsp.stat(storedPath);
      result.push({
        ...meta,
        size: stat.isDirectory() ? null : stat.size
      });
    } catch {
      // meta.json 损坏或不完整时，尝试基于目录内容有损恢复
      try {
        const files = await fsp.readdir(entryDir);
        const realFiles = files.filter((f) => f !== "meta.json");
        if (realFiles.length > 0) {
          const storedPath = resolveRecycleStoredPath(entryDir, realFiles[0]);
          const stat = await fsp.stat(storedPath);
          result.push({
            id: entry.name,
            name: realFiles[0],
            originalPath: "(未知，meta 损坏)",
            itemType: stat.isDirectory() ? "directory" : "file",
            deletedAt: stat.mtime.toISOString(),
            storedName: realFiles[0],
            size: stat.isDirectory() ? null : stat.size
          });
        }
      } catch {
        // 无法读取目录内容，静默跳过
      }
    }
  }
  return result.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}

async function restoreRecycleEntry(id) {
  const entryDir = resolveRecycleEntryDir(id);
  const meta = JSON.parse(await fsp.readFile(path.join(entryDir, "meta.json"), "utf8"));
  const sourcePath = resolveRecycleStoredPath(entryDir, meta.storedName);
  const targetRelative = safeRelative(meta.originalPath);
  const root = meta._nsfw ? NSFW_DIR : ROOT_DIR;
  const targetPath = path.resolve(root, targetRelative);
  if (targetPath !== root && !targetPath.startsWith(root + path.sep)) throw new Error("路径越界");
  try {
    await fsp.access(targetPath);
    throw new Error("原位置已有同名文件或文件夹，无法恢复");
  } catch (error) {
    if (error.message === "原位置已有同名文件或文件夹，无法恢复") throw error;
  }
  await ensureDir(path.dirname(targetPath));
  await fsp.rename(sourcePath, targetPath);
  await fsp.rm(entryDir, { recursive: true, force: true });
  invalidateFolderSizeCacheForPath(targetRelative, meta._nsfw);
}

async function permanentlyDeleteRecycleEntry(id) {
  const entryDir = resolveRecycleEntryDir(id);
  await fsp.rm(entryDir, { recursive: true, force: true });
}

function getRecycleExpiryCutoff() {
  return Date.now() - RECYCLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

function getRecycleDeletedTime(entry) {
  const time = Date.parse(String(entry.deletedAt || ""));
  return Number.isNaN(time) ? 0 : time;
}

async function cleanupExpiredRecycleEntries() {
  if (RECYCLE_RETENTION_DAYS <= 0) return 0;
  const cutoff = getRecycleExpiryCutoff();
  const items = await readRecycleEntries();
  let deletedCount = 0;
  for (const item of items) {
    if (getRecycleDeletedTime(item) > cutoff) continue;
    try {
      await permanentlyDeleteRecycleEntry(item.id);
      deletedCount += 1;
    } catch (error) {
      console.error(`回收站自动清理失败 ${item.id}: ${error.message}`);
    }
  }
  if (deletedCount > 0) {
    console.log(`回收站已自动清理 ${deletedCount} 项（保留 ${RECYCLE_RETENTION_DAYS} 天）`);
  }
  return deletedCount;
}

function cleanupBatchDownload(token) {
  const entry = batchDownloads.get(token);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  batchDownloads.delete(token);
}

function makeBatchDownloadFileName() {
  return `${String.fromCharCode(25209, 37327, 19979, 36733)}_${makeTimestampId()}.zip`;
}

async function collectBatchDownloadEntries(paths, rootOverride) {
  const root = rootOverride || ROOT_DIR;
  const entries = [];
  const skipped = [];

  for (const item of paths) {
    const relativePath = safeRelative(item);
    if (!relativePath) continue;

    const fullPath = path.resolve(root, relativePath);
    if (fullPath !== root && !fullPath.startsWith(root + path.sep)) { skipped.push(relativePath); continue; }
    try {
      const stat = await fsp.stat(fullPath);
      entries.push({
        relativePath,
        fullPath,
        type: stat.isDirectory() ? "directory" : "file"
      });
    } catch {
      skipped.push(relativePath);
    }
  }

  if (entries.length === 0) {
    throw new Error("没有可下载的有效目标");
  }
  const measurements = await Promise.all(entries.map((entry) => measureWorkspaceFiles(entry.fullPath)));
  const fileCount = measurements.reduce((total, measurement) => total + measurement.fileCount, 0);
  const totalBytes = measurements.reduce((total, measurement) => total + measurement.totalBytes, 0);

  // 计算公共父目录前缀，压缩时去掉，避免解压后路径过深
  const parts = entries.map((e) => e.relativePath.split("/"));
  let prefixLen = 0;
  const first = parts[0];
  outer:
  for (let i = 0; i < first.length - 1; i++) {
    for (let j = 1; j < parts.length; j++) {
      if (i >= parts[j].length - 1 || parts[j][i] !== first[i]) break outer;
    }
    prefixLen = i + 1;
  }

  if (prefixLen > 0) {
    for (const entry of entries) {
      entry.archivePath = entry.relativePath.split("/").slice(prefixLen).join("/");
    }
    for (let i = 0; i < skipped.length; i++) {
      skipped[i] = skipped[i].split("/").slice(prefixLen).join("/") || skipped[i];
    }
  }

  return { entries, skipped, fileCount, totalBytes };
}

function registerBatchDownload(entries, skipped) {
  const token = crypto.randomUUID();
  const fileName = makeBatchDownloadFileName();
  const timer = setTimeout(() => cleanupBatchDownload(token), BATCH_DOWNLOAD_TTL_MS);
  batchDownloads.set(token, { entries, skipped, fileName, timer });
  return { token, fileName };
}

async function createBatchDownload(paths, rootOverride) {
  if (paths.length === 0) {
    throw new Error("没有可下载的目标");
  }
  const { entries, skipped, fileCount, totalBytes } = await collectBatchDownloadEntries(paths, rootOverride);
  return { ...registerBatchDownload(entries, skipped), skipped, fileCount, totalBytes };
}

// --- 摸鱼板 ---
const moyuMessages = [];
const moyuClients = [];
let moyuNextId = 1;
const MOYU_MAX = 1000;

function moyuBroadcast(msg) {
  moyuClients.forEach(function(c) {
    try { c.write("data: " + JSON.stringify(msg) + "\n\n") } catch(e) {}
  })
}

function sendAuthRequired(res, message = "请先登录") {
  sendJson(res, 401, { error: message, code: "AUTH_REQUIRED" }, {
    "Cache-Control": "no-store",
    "X-Auth-Required": "1"
  });
}

function sendAuthCookieResponse(req, res, statusCode, payload, session) {
  // 普通登录也写入 12 小时持久 Cookie，保证服务更新、重启或浏览器重开后
  // 仍可恢复数据库中的有效会话；“记住我”则延长为 30 天。
  const cookieOptions = {
    maxAgeSeconds: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000))
  };
  const cookies = [makeAuthSessionCookie(req, session.token, cookieOptions)];
  if (AUTH_SESSION_COOKIE !== LEGACY_AUTH_SESSION_COOKIE) {
    revokeLegacyAuthSession(req);
    cookies.push(makeAuthSessionCookie(req, "", { maxAgeSeconds: 0 }, LEGACY_AUTH_SESSION_COOKIE));
  }
  sendJson(res, statusCode, payload, {
    "Set-Cookie": cookies,
    "Cache-Control": "no-store"
  });
}

function requirePermission(req, permission) {
  if (hasPermission(req.authUser, permission)) return;
  const error = new Error("当前账号没有执行此操作的权限");
  error.statusCode = 403;
  error.code = "PERMISSION_DENIED";
  throw error;
}

function assertApiPermission(req, url) {
  if (req.method === "POST" && ADMIN_POST_PATHS.has(url.pathname)) {
    requirePermission(req, "*");
    return;
  }
  if (req.method === "POST" && FORUM_DELETE_POST_PATHS.has(url.pathname)) {
    requirePermission(req, "forum.delete_own");
    return;
  }
  if (req.method === "POST" && FORUM_WRITE_POST_PATHS.has(url.pathname)) {
    requirePermission(req, "forum.write");
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/download-batch") {
    requirePermission(req, "files.download");
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/recycle/restore") {
    requirePermission(req, "recycle.restore");
    return;
  }
  if (req.method === "POST" && EDITOR_POST_PATHS.has(url.pathname)) {
    requirePermission(req, "files.write");
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/logs") {
    requirePermission(req, "*");
    return;
  }
  if (
    req.method === "GET"
    && (url.pathname === "/api/media-info" || url.pathname === "/api/document-preview")
  ) {
    requirePermission(req, "files.preview");
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/recycle/list") {
    requirePermission(req, "recycle.read");
    return;
  }
  if (
    req.method === "GET"
    && (
      url.pathname === "/api/nsfw/list"
      || url.pathname === "/nsfw/file"
      || url.pathname === "/api/nsfw/session"
    )
  ) {
    requirePermission(req, "files.write");
  }
}

async function handleAuthApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/security") {
    sendJson(res, 200, { csrfToken: CSRF_TOKEN }, { "Cache-Control": "no-store" });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/session") {
    const database = initAuthDatabase();
    const adminExists = Boolean(database.prepare(
      "SELECT 1 FROM users WHERE role = 'admin' AND enabled = 1 LIMIT 1"
    ).get());
    const headers = { "Cache-Control": "no-store" };
    const migratedSession = migrateLegacyAuthSession(req);
    if (migratedSession) {
      headers["Set-Cookie"] = [
        makeAuthSessionCookie(req, migratedSession.token, {
          maxAgeSeconds: Math.max(1, Math.floor((migratedSession.expiresAt - Date.now()) / 1000))
        }),
        makeAuthSessionCookie(req, "", { maxAgeSeconds: 0 }, LEGACY_AUTH_SESSION_COOKIE)
      ];
    }
    sendJson(res, 200, {
      authenticated: Boolean(req.authUser),
      user: req.authUser || null,
      initialAdminAvailable: !adminExists && isLoopbackRequest(req)
    }, headers);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    try {
      assertTrustedWriteRequest(req);
      const body = parseJson(await readRequestBody(req));
      const username = validateUsername(body.username);
      const password = validatePassword(body.password);
      const name = validateAccountName(body.name);
      const inviteCode = normalizeInviteCode(body.inviteCode);
      const rememberMe = body.rememberMe === true;
      const passwordHash = await hashPassword(password);
      const database = initAuthDatabase();
      let role = "guest";
      let protectedAdmin = false;
      let registeredWithInvite = false;
      let result;
      database.exec("BEGIN IMMEDIATE");
      try {
        const adminExists = Boolean(database.prepare(
          "SELECT 1 FROM users WHERE role = 'admin' AND enabled = 1 LIMIT 1"
        ).get());
        if (!adminExists && isLoopbackRequest(req)) {
          role = "admin";
          protectedAdmin = true;
        } else if (inviteCode) {
          const invite = database.prepare(`
            SELECT code_hash AS codeHash
            FROM invite_config
            WHERE id = 1 AND enabled = 1
          `).get();
          if (!invite || invite.codeHash !== inviteCodeHash(inviteCode)) {
            throw Object.assign(new Error("邀请码无效，请检查后重试"), { statusCode: 400 });
          }
          role = "editor";
          registeredWithInvite = true;
        }
        const now = Date.now();
        result = database.prepare(`
          INSERT INTO users
            (username, username_key, password_hash, name, role, enabled, is_protected_admin, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
        `).run(username, usernameKey(username), passwordHash, name, role, protectedAdmin ? 1 : 0, now, now);
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
      }
      const userId = Number(result.lastInsertRowid);
      const row = database.prepare(
        "SELECT id, username, name, role, is_protected_admin AS protectedAdmin FROM users WHERE id = ?"
      ).get(userId);
      const user = publicAuthUser(row);
      const session = createAuthSession(userId, rememberMe);
      logAction(user.name, getClientIp(req), "注册账号", `${user.username}（${user.roleLabel}）`);
      sendAuthCookieResponse(req, res, 201, {
        ok: true,
        user,
        becameInitialAdmin: role === "admin",
        registeredWithInvite
      }, session);
    } catch (error) {
      const duplicate = String(error.code || "").includes("SQLITE_CONSTRAINT")
        || /UNIQUE constraint failed/i.test(String(error.message || ""));
      sendJson(res, duplicate ? 409 : (error.statusCode || 400), {
        error: duplicate ? "该账号已被注册" : error.message
      }, { "Cache-Control": "no-store" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    try {
      assertTrustedWriteRequest(req);
      const body = parseJson(await readRequestBody(req));
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");
      const rememberMe = body.rememberMe === true;
      const retryAfterMs = getLoginRetryAfterMs(req, username);
      if (retryAfterMs > 0) {
        sendJson(res, 429, {
          error: `尝试次数过多，请在 ${Math.ceil(retryAfterMs / 60000)} 分钟后重试`
        }, { "Cache-Control": "no-store" });
        return true;
      }
      const database = initAuthDatabase();
      const row = database.prepare(`
        SELECT
          id,
          username,
          name,
          role,
          enabled,
          is_protected_admin AS protectedAdmin,
          password_hash AS passwordHash
        FROM users
        WHERE username_key = ?
      `).get(usernameKey(username));
      const valid = Boolean(row && row.enabled && await verifyPassword(password, row.passwordHash));
      if (!valid) {
        recordLoginFailure(req, username);
        sendJson(res, 401, { error: "账号或密码错误" }, { "Cache-Control": "no-store" });
        return true;
      }
      clearLoginFailures(req, username);
      database.prepare("UPDATE users SET last_login_at = ?, updated_at = updated_at WHERE id = ?")
        .run(Date.now(), row.id);
      const user = publicAuthUser(row);
      const session = createAuthSession(Number(row.id), rememberMe);
      logAction(user.name, getClientIp(req), "登录", `${user.username}（${user.roleLabel}）`);
      sendAuthCookieResponse(req, res, 200, { ok: true, user }, session);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message }, { "Cache-Control": "no-store" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    try {
      assertTrustedWriteRequest(req);
      if (req.authUser) {
        logAction(req.authUser.name, getClientIp(req), "退出登录", req.authUser.username);
      }
      revokeAuthSession(req);
      const activeCookieName = req.authSession && req.authSession.legacy
        ? LEGACY_AUTH_SESSION_COOKIE
        : AUTH_SESSION_COOKIE;
      sendJson(res, 200, { ok: true }, {
        "Set-Cookie": makeAuthSessionCookie(req, "", { maxAgeSeconds: 0 }, activeCookieName),
        "Cache-Control": "no-store"
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/profile") {
    if (!req.authUser) {
      sendAuthRequired(res);
      return true;
    }
    try {
      assertTrustedWriteRequest(req);
      const body = parseJson(await readRequestBody(req));
      const name = validateAccountName(body.name);
      const database = initAuthDatabase();
      updateAccountName(req.authUser.id, name);
      const row = database.prepare(`
        SELECT id, username, name, role, is_protected_admin AS protectedAdmin
        FROM users
        WHERE id = ?
      `)
        .get(req.authUser.id);
      const user = publicAuthUser(row);
      logAction(user.name, getClientIp(req), "修改姓名", `${req.authUser.name} → ${name}`);
      sendJson(res, 200, { ok: true, user }, { "Cache-Control": "no-store" });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/change-password") {
    if (!req.authUser) {
      sendAuthRequired(res);
      return true;
    }
    try {
      assertTrustedWriteRequest(req);
      const body = parseJson(await readRequestBody(req));
      const currentPassword = String(body.currentPassword || "");
      const newPassword = validatePassword(body.newPassword, "新密码");
      const database = initAuthDatabase();
      const row = database.prepare("SELECT password_hash AS passwordHash FROM users WHERE id = ?")
        .get(req.authUser.id);
      if (!row || !(await verifyPassword(currentPassword, row.passwordHash))) {
        sendJson(res, 403, { error: "当前密码错误" });
        return true;
      }
      const passwordHash = await hashPassword(newPassword);
      database.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(passwordHash, Date.now(), req.authUser.id);
      revokeOtherAuthSessions(req.authUser.id, req);
      logAction(req.authUser.name, getClientIp(req), "修改密码", req.authUser.username);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/invite") {
    if (!req.authUser) {
      sendAuthRequired(res);
      return true;
    }
    try {
      requirePermission(req, "*");
      const row = initAuthDatabase().prepare(`
        SELECT
          c.code_value AS code,
          c.enabled,
          c.updated_at AS updatedAt,
          u.name AS updatedByName,
          u.username AS updatedByUsername
        FROM invite_config c
        LEFT JOIN users u ON u.id = c.updated_by
        WHERE c.id = 1
      `).get();
      sendJson(res, 200, {
        configured: Boolean(row),
        enabled: Boolean(row?.enabled),
        code: row?.code || "",
        updatedAt: row ? Number(row.updatedAt) : null,
        updatedBy: row ? {
          name: row.updatedByName || "已删除的管理员",
          username: row.updatedByUsername || ""
        } : null
      }, { "Cache-Control": "no-store" });
    } catch (error) {
      sendJson(res, error.statusCode || 403, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/invite") {
    if (!req.authUser) {
      sendAuthRequired(res);
      return true;
    }
    try {
      assertTrustedWriteRequest(req);
      requirePermission(req, "*");
      const body = parseJson(await readRequestBody(req));
      const code = validateInviteCode(body.code);
      const now = Date.now();
      initAuthDatabase().prepare(`
        INSERT INTO invite_config
          (id, code_value, code_hash, enabled, updated_by, updated_at)
        VALUES (1, ?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          code_value = excluded.code_value,
          code_hash = excluded.code_hash,
          enabled = 1,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).run(code, inviteCodeHash(code), req.authUser.id, now);
      logAction(req.authUser.name, getClientIp(req), "设置注册邀请码", "可编辑账号邀请码已更新并启用");
      sendJson(res, 200, { ok: true, code, enabled: true, updatedAt: now });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/invite/disable") {
    if (!req.authUser) {
      sendAuthRequired(res);
      return true;
    }
    try {
      assertTrustedWriteRequest(req);
      requirePermission(req, "*");
      const now = Date.now();
      const result = initAuthDatabase().prepare(`
        UPDATE invite_config
        SET enabled = 0, updated_by = ?, updated_at = ?
        WHERE id = 1
      `).run(req.authUser.id, now);
      if (Number(result.changes || 0) === 0) {
        throw Object.assign(new Error("尚未设置邀请码"), { statusCode: 404 });
      }
      logAction(req.authUser.name, getClientIp(req), "停用注册邀请码", "邀请码注册已关闭");
      sendJson(res, 200, { ok: true, enabled: false, updatedAt: now });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/users") {
    if (!req.authUser) {
      sendAuthRequired(res);
      return true;
    }
    try {
      requirePermission(req, "*");
      cleanupExpiredAuthSessions();
      const rows = initAuthDatabase().prepare(`
        SELECT
          u.id,
          u.username,
          u.name,
          u.role,
          u.enabled,
          u.is_protected_admin AS protectedAdmin,
          u.created_at AS createdAt,
          u.last_login_at AS lastLoginAt,
          COUNT(s.token_hash) AS sessionCount
        FROM users u
        LEFT JOIN auth_sessions s ON s.user_id = u.id AND s.expires_at > ?
        GROUP BY u.id
        ORDER BY
          CASE u.role WHEN 'admin' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
          u.created_at ASC
      `).all(Date.now());
      sendJson(res, 200, {
        users: rows.map((row) => ({
          id: Number(row.id),
          username: row.username,
          name: row.name,
          role: row.role,
          roleLabel: AUTH_ROLE_LABELS[row.role] || row.role,
          enabled: Boolean(row.enabled),
          protectedAdmin: Boolean(row.protectedAdmin),
          createdAt: Number(row.createdAt),
          lastLoginAt: row.lastLoginAt == null ? null : Number(row.lastLoginAt),
          sessionCount: Number(row.sessionCount || 0),
          isSelf: Number(row.id) === req.authUser.id
        }))
      }, { "Cache-Control": "no-store" });
    } catch (error) {
      sendJson(res, error.statusCode || 403, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/users/name") {
    if (!req.authUser) {
      sendAuthRequired(res);
      return true;
    }
    try {
      assertTrustedWriteRequest(req);
      requirePermission(req, "*");
      const body = parseJson(await readRequestBody(req));
      const userId = Number(body.userId);
      const name = validateAccountName(body.name);
      if (!Number.isInteger(userId) || userId <= 0) {
        throw Object.assign(new Error("账号无效"), { statusCode: 400 });
      }
      if (userId === req.authUser.id) {
        throw Object.assign(new Error("自己的姓名请在账户中心修改"), { statusCode: 400 });
      }
      const updated = updateAccountName(userId, name);
      logAction(
        req.authUser.name,
        getClientIp(req),
        "修改账号姓名",
        `${updated.previousName}（${updated.username}）→ ${updated.name}`
      );
      sendJson(res, 200, {
        ok: true,
        userId: updated.id,
        username: updated.username,
        name: updated.name,
        changedSelf: updated.id === req.authUser.id
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/users/role") {
    if (!req.authUser) {
      sendAuthRequired(res);
      return true;
    }
    try {
      assertTrustedWriteRequest(req);
      requirePermission(req, "*");
      const body = parseJson(await readRequestBody(req));
      const userId = Number(body.userId);
      const role = String(body.role || "");
      if (!Number.isInteger(userId) || userId <= 0 || !AUTH_ROLES.has(role)) {
        throw Object.assign(new Error("账号或角色无效"), { statusCode: 400 });
      }
      const database = initAuthDatabase();
      const target = database.prepare(`
        SELECT id, username, name, role, is_protected_admin AS protectedAdmin
        FROM users
        WHERE id = ?
      `).get(userId);
      if (!target) {
        throw Object.assign(new Error("账号不存在"), { statusCode: 404 });
      }
      if (target.protectedAdmin && role !== "admin") {
        throw Object.assign(new Error("本机初始管理员的权限不可修改"), { statusCode: 403 });
      }
      if (target.role === "admin" && role !== "admin") {
        const adminCount = Number(database.prepare(
          "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND enabled = 1"
        ).get().count || 0);
        if (adminCount <= 1) {
          throw Object.assign(new Error("必须至少保留一名管理员"), { statusCode: 400 });
        }
      }
      database.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?")
        .run(role, Date.now(), userId);
      logAction(
        req.authUser.name,
        getClientIp(req),
        "分配账号角色",
        `${target.name}（${target.username}）：${AUTH_ROLE_LABELS[target.role]} → ${AUTH_ROLE_LABELS[role]}`
      );
      sendJson(res, 200, { ok: true, role, roleLabel: AUTH_ROLE_LABELS[role] });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/users/reset-password") {
    if (!req.authUser) {
      sendAuthRequired(res);
      return true;
    }
    try {
      assertTrustedWriteRequest(req);
      requirePermission(req, "*");
      const body = parseJson(await readRequestBody(req));
      const userId = Number(body.userId);
      const newPassword = validatePassword(body.newPassword, "新密码");
      if (!Number.isInteger(userId) || userId <= 0) {
        throw Object.assign(new Error("账号无效"), { statusCode: 400 });
      }
      const database = initAuthDatabase();
      const target = database.prepare(`
        SELECT id, username, name, is_protected_admin AS protectedAdmin
        FROM users
        WHERE id = ?
      `).get(userId);
      if (!target) {
        throw Object.assign(new Error("账号不存在"), { statusCode: 404 });
      }
      if (Number(target.id) === req.authUser.id) {
        throw Object.assign(new Error("请在账户中心验证当前密码后修改"), { statusCode: 400 });
      }
      if (target.protectedAdmin) {
        throw Object.assign(new Error("本机初始管理员密码不可由其他管理员重置"), { statusCode: 403 });
      }
      const passwordHash = await hashPassword(newPassword);
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
          .run(passwordHash, Date.now(), userId);
        database.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
      }
      logAction(
        req.authUser.name,
        getClientIp(req),
        "重置账号密码",
        `${target.name}（${target.username}）`
      );
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/users/delete") {
    if (!req.authUser) {
      sendAuthRequired(res);
      return true;
    }
    try {
      assertTrustedWriteRequest(req);
      requirePermission(req, "*");
      const body = parseJson(await readRequestBody(req));
      const userId = Number(body.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        throw Object.assign(new Error("账号无效"), { statusCode: 400 });
      }
      const database = initAuthDatabase();
      const target = database.prepare(`
        SELECT id, username, name, role, is_protected_admin AS protectedAdmin
        FROM users
        WHERE id = ?
      `).get(userId);
      if (!target) {
        throw Object.assign(new Error("账号不存在"), { statusCode: 404 });
      }
      if (target.protectedAdmin) {
        throw Object.assign(new Error("本机初始管理员账号不可删除"), { statusCode: 403 });
      }
      const deletedSelf = Number(target.id) === req.authUser.id;
      database.prepare("DELETE FROM users WHERE id = ?").run(userId);
      try {
        initForumDatabase()
          .prepare("DELETE FROM forum_reactions WHERE owner_token = ?")
          .run(`user:${userId}`);
      } catch (error) {
        console.error(`删除账号表情反应失败 ${target.username}: ${error.message}`);
      }
      logAction(
        req.authUser.name,
        getClientIp(req),
        "删除账号",
        `${target.name}（${target.username}，${AUTH_ROLE_LABELS[target.role]}）`
      );
      const headers = { "Cache-Control": "no-store" };
      if (deletedSelf) {
        headers["Set-Cookie"] = makeAuthSessionCookie(req, "", { maxAgeSeconds: 0 });
      }
      sendJson(res, 200, { ok: true, deletedSelf }, headers);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  return false;
}

async function handleApi(req, res, url) {
  if (req.method === "POST" && PROTECTED_POST_PATHS.has(url.pathname)) {
    try {
      assertTrustedWriteRequest(req);
    } catch (error) {
      sendJson(res, error.statusCode || 403, { error: error.message });
      return true;
    }
  }
  try {
    assertApiPermission(req, url);
  } catch (error) {
    sendJson(res, error.statusCode || 403, {
      error: error.message,
      code: error.code || "PERMISSION_DENIED"
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/chat/send") {
    const body = parseJson(await readRequestBody(req));
    const text = String(body.text || "").trim().slice(0, 500);
    if (!text) { sendJson(res, 400, { error: "不能为空" }); return true; }
    const user = getDeviceName(req).slice(0, 20);
    const msg = {
      id: moyuNextId++,
      user,
      userId: req.authUser.id,
      text,
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false })
    };
    moyuMessages.push(msg);
    if (moyuMessages.length > MOYU_MAX) moyuMessages.splice(0, moyuMessages.length - MOYU_MAX);
    moyuBroadcast(msg);
    sendJson(res, 200, { id: msg.id, time: msg.time });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/chat/clear") {
    moyuMessages.length = 0;
    var nextId = moyuNextId;
    // 存入清除标记，轮询客户端会自动清空
    var clearMsg = { id: moyuNextId++, user: "", text: "", time: "", clear: true };
    moyuMessages.push(clearMsg);
    sendJson(res, 200, { ok: true, nextId: nextId });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/chat/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    res.write("data: " + JSON.stringify([]) + "\n\n");
    moyuClients.push(res);
    req.on("close", function() {
      var idx = moyuClients.indexOf(res);
      if (idx >= 0) moyuClients.splice(idx, 1);
    });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/chat/messages") {
    const since = parseInt(url.searchParams.get("since") || "0");
    const result = moyuMessages.filter(m => m.id > since);
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/workspace/status") {
    try {
      const disk = await fsp.statfs(ROOT_DIR);
      const blockSize = Number(disk.bsize) || 0;
      const totalBytes = Number(disk.blocks) * blockSize;
      const freeBytes = Number(disk.bavail) * blockSize;
      const latestSnapshot = await findLatestDailySnapshot();
      const latestStat = latestSnapshot ? await fsp.stat(latestSnapshot).catch(() => null) : null;
      const activity = await readTodayWorkspaceActivity();
      const onlineUsers = readOnlineUsers(req.authUser.id);
      sendJson(res, 200, {
        storage: {
          volume: path.parse(ROOT_DIR).root.replace(/[\\/]+$/, ""),
          totalBytes,
          freeBytes,
          usedBytes: Math.max(0, totalBytes - freeBytes)
        },
        backup: {
          enabled: DAILY_BACKUP_ENABLED,
          running: dailyBackupRunning,
          nextAt: DAILY_BACKUP_ENABLED ? getNextDailyBackupTime().toISOString() : null,
          latestAt: latestStat ? latestStat.mtime.toISOString() : null
        },
        activity,
        onlineUsers,
        onlineWindowMs: AUTH_ONLINE_WINDOW_MS
      }, { "Cache-Control": "no-store" });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/forum/posts") {
    try {
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit")) || 12));
      const database = initForumDatabase();
      const rows = database.prepare(`
        SELECT
          p.id,
          p.title,
          p.content,
          p.author,
          p.author_user_id AS authorUserId,
          p.owner_token AS ownerToken,
          p.created_at AS createdAt,
          p.updated_at AS updatedAt,
          COUNT(r.id) AS replyCount
        FROM posts p
        LEFT JOIN replies r ON r.post_id = p.id
        GROUP BY p.id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ?
      `).all(limit);
      const ownerToken = getForumOwnerToken(req);
      const reactionOwnerKey = getForumReactionOwnerKey(req);
      const adminRequest = hasPermission(req.authUser, "*");
      const canDeleteOwn = hasPermission(req.authUser, "forum.delete_own");
      const reactionsByPost = readForumReactions(database, rows.map((post) => post.id), reactionOwnerKey);
      const posts = rows.map(({ ownerToken: postOwnerToken, authorUserId, ...post }) => ({
        ...post,
        canDelete: adminRequest
          || Boolean(canDeleteOwn && (
            (authorUserId && Number(authorUserId) === req.authUser.id)
            || (!authorUserId && ownerToken && postOwnerToken && ownerToken === postOwnerToken)
          )),
        reactions: reactionsByPost.get(post.id) || []
      }));
      sendJson(res, 200, { posts }, { "Cache-Control": "no-store" });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/forum/reactions") {
    try {
      const body = parseJson(await readRequestBody(req));
      const postId = Number(body.postId);
      const emoji = String(body.emoji || "");
      if (!Number.isInteger(postId) || postId <= 0 || !FORUM_REACTION_EMOJIS.includes(emoji)) {
        sendJson(res, 400, { error: "反应内容无效" });
        return true;
      }
      const database = initForumDatabase();
      const post = database.prepare("SELECT id FROM posts WHERE id = ?").get(postId);
      if (!post) {
        sendJson(res, 404, { error: "动态不存在" });
        return true;
      }
      const ownerToken = getForumReactionOwnerKey(req);
      const existing = database
        .prepare("SELECT 1 FROM forum_reactions WHERE post_id = ? AND emoji = ? AND owner_token = ?")
        .get(postId, emoji, ownerToken);
      let active;
      if (existing) {
        database
          .prepare("DELETE FROM forum_reactions WHERE post_id = ? AND emoji = ? AND owner_token = ?")
          .run(postId, emoji, ownerToken);
        active = false;
      } else {
        database
          .prepare("INSERT INTO forum_reactions (post_id, emoji, owner_token, created_at) VALUES (?, ?, ?, ?)")
          .run(postId, emoji, ownerToken, Date.now());
        active = true;
      }
      const reactions = readForumReactions(database, [postId], ownerToken).get(postId) || [];
      sendJson(res, 200, { ok: true, active, reactions });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/forum/posts") {
    try {
      const body = parseJson(await readRequestBody(req));
      const title = String(body.title || "").trim().slice(0, 80);
      const content = String(body.content || "").trim().slice(0, 1200);
      if (!title || !content) {
        sendJson(res, 400, { error: "标题和正文不能为空" });
        return true;
      }
      const createdAt = Date.now();
      const ownerToken = getForumOwnerToken(req) || createForumOwnerToken();
      const database = initForumDatabase();
      const result = database
        .prepare(`
          INSERT INTO posts (title, content, author, author_user_id, owner_token, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(title, content, getForumAuthor(req), req.authUser.id, ownerToken, createdAt);
      sendJson(res, 201, { id: Number(result.lastInsertRowid), createdAt }, {
        "Set-Cookie": makeForumOwnerCookie(ownerToken)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/forum/posts/delete") {
    try {
      const body = parseJson(await readRequestBody(req));
      const postId = Number(body.id);
      if (!Number.isInteger(postId) || postId <= 0) {
        sendJson(res, 400, { error: "动态编号无效" });
        return true;
      }
      const database = initForumDatabase();
      const post = database.prepare(`
        SELECT id, author_user_id AS authorUserId, owner_token AS ownerToken
        FROM posts
        WHERE id = ?
      `).get(postId);
      if (!post) {
        sendJson(res, 404, { error: "动态不存在" });
        return true;
      }
      const ownerToken = getForumOwnerToken(req);
      const canDelete = hasPermission(req.authUser, "*")
        || Boolean(post.authorUserId && Number(post.authorUserId) === req.authUser.id)
        || Boolean(!post.authorUserId && ownerToken && post.ownerToken && ownerToken === post.ownerToken);
      if (!canDelete) {
        sendJson(res, 403, { error: "仅动态发布者或管理员可删除" });
        return true;
      }
      database.prepare("DELETE FROM posts WHERE id = ?").run(postId);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/forum/posts/delete-batch") {
    try {
      const body = parseJson(await readRequestBody(req));
      const postIds = [...new Set((Array.isArray(body.ids) ? body.ids : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0))]
        .slice(0, 30);
      if (!postIds.length) {
        sendJson(res, 400, { error: "请选择要删除的动态" });
        return true;
      }
      const database = initForumDatabase();
      const placeholders = postIds.map(() => "?").join(",");
      const posts = database
        .prepare(`
          SELECT id, author_user_id AS authorUserId, owner_token AS ownerToken
          FROM posts
          WHERE id IN (${placeholders})
        `)
        .all(...postIds);
      if (posts.length !== postIds.length) {
        sendJson(res, 404, { error: "部分动态不存在，请刷新后重试" });
        return true;
      }
      const ownerToken = getForumOwnerToken(req);
      const adminRequest = hasPermission(req.authUser, "*");
      const canDeleteAll = posts.every((post) =>
        adminRequest
        || Boolean(post.authorUserId && Number(post.authorUserId) === req.authUser.id)
        || Boolean(!post.authorUserId && ownerToken && post.ownerToken === ownerToken)
      );
      if (!canDeleteAll) {
        sendJson(res, 403, { error: "只能批量删除自己发布的动态" });
        return true;
      }
      database.prepare(`DELETE FROM posts WHERE id IN (${placeholders})`).run(...postIds);
      sendJson(res, 200, { ok: true, deleted: postIds.length });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/forum/replies") {
    try {
      const postId = Number(url.searchParams.get("postId"));
      if (!Number.isInteger(postId) || postId <= 0) {
        sendJson(res, 400, { error: "动态编号无效" });
        return true;
      }
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 4));
      const offset = Math.min(100000, Math.max(0, Number(url.searchParams.get("offset")) || 0));
      const database = initForumDatabase();
      const total = Number(
        database.prepare("SELECT COUNT(*) AS count FROM replies WHERE post_id = ?").get(postId).count
      ) || 0;
      const rows = database
        .prepare(`
          WITH numbered_replies AS (
            SELECT
              id,
              post_id,
              parent_reply_id,
              content,
              author,
              created_at,
              ROW_NUMBER() OVER (ORDER BY created_at, id) + 1 AS floor_number
            FROM replies
            WHERE post_id = ?
          )
          SELECT
            reply.id,
            reply.post_id AS postId,
            reply.parent_reply_id AS parentReplyId,
            reply.content,
            reply.author,
            reply.created_at AS createdAt,
            reply.floor_number AS floorNumber,
            parent.author AS replyToAuthor,
            parent.floor_number AS replyToFloor
          FROM numbered_replies reply
          LEFT JOIN numbered_replies parent ON parent.id = reply.parent_reply_id
          ORDER BY reply.created_at, reply.id
          LIMIT ? OFFSET ?
        `)
        .all(postId, limit, offset);
      sendJson(res, 200, {
        replies: rows,
        total,
        hasMore: offset + rows.length < total
      }, { "Cache-Control": "no-store" });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/forum/replies") {
    try {
      const body = parseJson(await readRequestBody(req));
      const postId = Number(body.postId);
      const parentReplyId = body.parentReplyId == null || body.parentReplyId === ""
        ? null
        : Number(body.parentReplyId);
      const content = String(body.content || "").trim().slice(0, 500);
      if (!Number.isInteger(postId) || postId <= 0 || !content) {
        sendJson(res, 400, { error: "回复内容不能为空" });
        return true;
      }
      if (parentReplyId !== null && (!Number.isInteger(parentReplyId) || parentReplyId <= 0)) {
        sendJson(res, 400, { error: "回复楼层无效" });
        return true;
      }
      const database = initForumDatabase();
      const post = database.prepare("SELECT id FROM posts WHERE id = ?").get(postId);
      if (!post) {
        sendJson(res, 404, { error: "动态不存在" });
        return true;
      }
      let parentReply = null;
      if (parentReplyId !== null) {
        parentReply = database
          .prepare("SELECT id, author FROM replies WHERE id = ? AND post_id = ?")
          .get(parentReplyId, postId);
        if (!parentReply) {
          sendJson(res, 404, { error: "要回复的楼层不存在" });
          return true;
        }
      }
      const createdAt = Date.now();
      const result = database
        .prepare(`
          INSERT INTO replies (post_id, parent_reply_id, content, author, author_user_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(postId, parentReplyId, content, getForumAuthor(req), req.authUser.id, createdAt);
      sendJson(res, 201, {
        id: Number(result.lastInsertRowid),
        createdAt,
        parentReplyId,
        replyToAuthor: parentReply ? parentReply.author : null
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/list") {
    try {
      const dir = safeRelative(url.searchParams.get("dir"));
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const rootOverride = req._nsfwMode ? NSFW_DIR : null;
      const result = await listDirectory(dir, offset, limit, rootOverride);
      sendJson(res, 200, { currentDir: dir, ...result });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/media-info") {
    try {
      const mediaInfo = await readMediaInfo(
        url.searchParams.get("path"),
        req._nsfwMode ? NSFW_DIR : null
      );
      sendJson(res, 200, mediaInfo, { "Cache-Control": "no-store" });
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : 400;
      if (statusCode !== 404) {
        console.error(`媒体信息读取失败: ${error.message}`);
      }
      sendJson(res, statusCode, {
        error: statusCode === 404 ? "媒体文件不存在" : "媒体信息读取失败"
      }, {
        "Cache-Control": "no-store"
      });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/document-preview") {
    const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    try {
      const preview = await readDocumentPreview(
        url.searchParams.get("path"),
        req._nsfwMode ? NSFW_DIR : null
      );
      sendDocumentHtml(res, 200, buildDocumentPreviewPage(preview, theme));
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : error.statusCode || 400;
      if (statusCode !== 404) {
        console.error(`DOCX 预览失败: ${error.message}`);
      }
      const message = statusCode === 404 ? "文档不存在或已被移动" : error.message || "文档解析失败";
      sendDocumentHtml(res, statusCode, buildDocumentPreviewErrorPage(message, theme));
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/folder-sizes") {
    try {
      const paths = url.searchParams.getAll("path").slice(0, 200);
      var fsRoot = req._nsfwMode ? NSFW_DIR : null;
      const items = await Promise.all(paths.map((item) => readFolderSizeStatus(item, fsRoot)));
      sendJson(res, 200, { items });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/search") {
    try {
      const query = String(url.searchParams.get("q") || "");
      const result = await searchShared(query, req._nsfwMode ? NSFW_DIR : null);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/recycle/list") {
    try {
      const items = await readRecycleEntries();
      sendJson(res, 200, { items });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  // 已完成项目列表
  if (req.method === "GET" && url.pathname === "/api/completed-projects") {
    try {
      var cpRoot = req._nsfwMode ? NSFW_DIR : ROOT_DIR
      var projects = []
      async function scan(dir) {
        var entries
        try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
        for (var entry of entries) {
          if (!entry.isDirectory()) continue
          var full = path.join(dir, entry.name)
          // 检查 .status 文件
          var status = null
          try { status = (await fsp.readFile(path.join(full, ".status"), "utf8")).trim() } catch {}
          if (status === "completed") {
            var relativePath = path.relative(cpRoot, full).replace(/\\/g, "/")
            projects.push({ name: entry.name, path: relativePath })
          }
          // 递归扫描子目录
          await scan(full)
        }
      }
      await scan(cpRoot)
      sendJson(res, 200, { items: projects })
    } catch (error) {
      sendJson(res, 500, { error: error.message })
    }
    return true
  }

  if (req.method === "POST" && url.pathname === "/api/nsfw/setpwd") {
    const body = parseJson(await readRequestBody(req));
    var newPwd = String(body.password || "").trim();
    if (newPwd.length < 1) { sendJson(res, 400, { error: "密码不能为空" }); return true; }
    if (newPwd.length > 50) { sendJson(res, 400, { error: "密码太长" }); return true; }
    await fsp.writeFile(NSFW_PASSWORD_FILE, newPwd, "utf8");
    nsfwPassword = newPwd;
    nsfwSessions.clear();
    sendJson(res, 200, { ok: true }, { "Set-Cookie": makeNsfwSessionCookie("", 0) });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/nsfw/auth") {
    const body = parseJson(await readRequestBody(req));
    if (body.password === nsfwPassword) {
      const session = createNsfwSession();
      sendJson(res, 200, { ok: true, expiresAt: session.expiresAt }, {
        "Set-Cookie": makeNsfwSessionCookie(session.token, Math.max(1, Math.floor(NSFW_SESSION_TTL_MS / 1000))),
        "Cache-Control": "no-store"
      });
    } else {
      sendJson(res, 403, { error: "密码错误" });
    }
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/nsfw/session") {
    if (!isNsfwAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: "海外剧会话已失效" }, {
        "Set-Cookie": makeNsfwSessionCookie("", 0),
        "Cache-Control": "no-store"
      });
      return true;
    }
    sendJson(res, 200, { ok: true }, { "Cache-Control": "no-store" });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/nsfw/logout") {
    clearNsfwSession(req);
    sendJson(res, 200, { ok: true }, {
      "Set-Cookie": makeNsfwSessionCookie("", 0),
      "Cache-Control": "no-store"
    });
    return true;
  }
  // NSFW 列表（复用 getPreviewType/buildListItem，指向 NSFW_DIR）
  if (req.method === "GET" && url.pathname === "/api/nsfw/list") {
    try {
      const dir = safeRelative(url.searchParams.get("dir") || "");
      const dirPath = path.resolve(NSFW_DIR, dir);
      if (dirPath !== NSFW_DIR && !dirPath.startsWith(NSFW_DIR + path.sep)) throw new Error("路径越界");
      const entries = await fsp.readdir(dirPath, { withFileTypes: true });
      const filtered = entries.filter(function(i) { return !i.name.startsWith(".") });
      const sorted = filtered.sort(function(a, b) {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-CN");
      });
      const items = await Promise.all(sorted.map(async function(entry) {
        var stat;
        try { stat = await fsp.stat(path.join(dirPath, entry.name)); } catch { stat = { mtime: new Date(), size: 0 }; }
        var name = entry.name;
        return {
          name: name,
          path: (dir ? dir + "/" : "") + name,
          type: entry.isDirectory() ? "directory" : "file",
          previewType: entry.isDirectory() ? "none" : getPreviewType(name),
          size: entry.isDirectory() ? null : stat.size,
          updatedAt: stat.mtime.toISOString()
        };
      }));
      sendJson(res, 200, { items: items, total: items.length, currentDir: dir });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }
  // NSFW 文件下载/预览
  if (req.method === "GET" && url.pathname === "/nsfw/file") {
    try {
      const relativePath = safeRelative(url.searchParams.get("path"));
      const fullPath = path.resolve(NSFW_DIR, relativePath);
      if (fullPath !== NSFW_DIR && !fullPath.startsWith(NSFW_DIR + path.sep)) throw new Error("路径越界");
      const stat = await fsp.stat(fullPath);
      if (!stat.isFile()) { sendText(res, 400, "仅支持文件"); return true; }
      const mimeType = getMimeType(fullPath);
      res.writeHead(200, { "Content-Type": mimeType, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
      await pipeFileToResponse(res, fullPath);
    } catch (error) {
      sendText(res, 400, error.message);
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/nsfw/upload") {
    try {
      const contentType = String(req.headers["content-type"] || "");
      if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
        throw new Error("上传请求格式错误");
      }
      const result = await handleStreamingUpload(req, NSFW_DIR);
      const names = result.uploadedNames || [];
      const targetLabel = names.length === 1 ? names[0] : `${result.uploaded} 项`;
      const detail = `${targetLabel}（${result.uploaded} 个文件，${result.uploadedBytes} 字节）`;
      logAction(getDeviceName(req), getClientIp(req), "上传", detail, names);
      sendJson(res, 200, { ok: true, uploaded: result.uploaded, backupBatchId: result.backupBatchId });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message, conflicts: error.conflicts || [] });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    sendJson(res, 200, { entries: [...logBuffer] });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/mkdir") {
    try {
      const body = parseJson(await readRequestBody(req));
      const parentDir = safeRelative(body.dir);
      const name = String(body.name || "").trim();
      if (!name) throw new Error("文件夹名称不能为空");
      if (isInvalidFileName(name)) throw new Error("文件夹名称包含非法字符");
      const targetRelative = safeRelative(path.posix.join(parentDir, name));
      await ensureDir(resolveInsideRoot(targetRelative, req));
      recordFileAttributions(
        [targetRelative],
        getDeviceName(req),
        req.authUser.id,
        req._nsfwMode,
        false
      );
      invalidateFolderSizeCacheForPath(targetRelative, req._nsfwMode);
      logAction(getDeviceName(req), getClientIp(req), "创建文件夹", path.posix.join(parentDir, name));
      sendJson(res, 200, { ok: true, path: targetRelative });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/create-project") {
    try {
      const body = parseJson(await readRequestBody(req));
      const name = String(body.name || "").trim();
      const episodes = Math.max(1, Math.floor(Number(body.episodes) || 1));
      const parentDir = safeRelative(body.parentDir);
      if (!name) throw new Error("项目名称不能为空");
      if (isInvalidFileName(name)) throw new Error("项目名称包含非法字符");
      const projectPath = safeRelative(path.posix.join(parentDir, name));
      const projectFull = resolveInsideRoot(projectPath, req);

      // 中文数字映射
      // 资产子文件夹
      const assetSubs = ["人物", "道具", "场景", "特效", "群演", "音频"];
      const dirs = [projectFull];

      // 资产
      for (const sub of assetSubs) {
        dirs.push(path.join(projectFull, "资产", sub));
      }

      // 视频
      const txtFiles = [];
      for (let i = 0; i < episodes; i++) {
        const epNum = String(i + 1).padStart(2, "0");
        const epName = `第${epNum}集`;
        const epDir = path.join(projectFull, "视频", epName);
        dirs.push(epDir);
        // 补充镜头目录
        const buDir = path.join(epDir, `${epName}补充镜头`);
        dirs.push(buDir);
        txtFiles.push(path.join(buDir, `${epNum}-001-01-b1.txt`));
        // 粗剪素材目录
        const roughDir = path.join(epDir, `${epName}粗剪素材`);
        dirs.push(roughDir);
        txtFiles.push(path.join(roughDir, `${epNum}-001-01.txt`));
        // 未使用素材目录
        dirs.push(path.join(epDir, `${epName}未使用素材`));
      }

      // 剧本
      dirs.push(path.join(projectFull, "剧本"));

      // 先创建所有目录
      for (const dir of dirs) {
        await fsp.mkdir(dir, { recursive: true });
      }
      // 再创建txt模板文件
      for (const f of txtFiles) {
        await fsp.writeFile(f, "").catch(() => {});
      }
      // 标记为项目目录
      await fsp.writeFile(path.join(projectFull, ".project"), "").catch(() => {});
      recordFileAttributions(
        [projectPath],
        getDeviceName(req),
        req.authUser.id,
        req._nsfwMode,
        false
      );
      invalidateFolderSizeCacheForPath(projectPath, req._nsfwMode);
      logAction(getDeviceName(req), getClientIp(req), "创建项目文件夹", projectPath);
      sendJson(res, 200, { ok: true, path: projectPath });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/delete") {
    try {
      const body = parseJson(await readRequestBody(req));
      const paths = (Array.isArray(body.paths) ? body.paths : [body.path]).map((item) => safeRelative(item)).filter(Boolean);
      if (paths.length === 0) throw new Error("没有可删除的目标");
      // Collect file names from folders before moving
      const deletedNames = [];
      let deletedFileCount = 0;
      let deletedBytes = 0;
      for (const item of paths) {
        try {
          const fullPath = resolveInsideRoot(safeRelative(item), req);
          const stat = await fsp.stat(fullPath);
          const measurement = await measureWorkspaceFiles(fullPath);
          deletedFileCount += measurement.fileCount;
          deletedBytes += measurement.totalBytes;
          if (stat.isDirectory()) {
            deletedNames.push(...await collectDirFileNames(fullPath));
          } else {
            deletedNames.push(path.basename(fullPath));
          }
          await cleanupThumbCacheForPath(fullPath, stat);
        } catch {}
      }
      const deleted = [];
      for (const item of paths) {
        deleted.push(await moveToRecycle(item, req._nsfwMode ? NSFW_DIR : null));
      }
      const itemNames = deleted.map(d => `${d.name}${d.itemType === "directory" ? " (文件夹)" : ""}`);
      const targetLabel = paths.length === 1 ? itemNames[0] : `${paths.length} 项`;
      const detail = `${targetLabel}（${deletedFileCount} 个文件，${deletedBytes} 字节）`;
      logAction(getDeviceName(req), getClientIp(req), "删除", detail, deletedNames);
      sendJson(res, 200, { ok: true, deleted });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/rename") {
    try {
      const body = parseJson(await readRequestBody(req));
      const sourceRelative = safeRelative(body.path);
      const newName = String(body.newName || "").trim();
      if (!sourceRelative) throw new Error("不允许重命名 shared 根目录");
      if (!newName) throw new Error("新名称不能为空");
      if (isInvalidFileName(newName)) throw new Error("新名称包含非法字符");
      const sourcePath = resolveInsideRoot(sourceRelative, req);
      const parentRelative = path.posix.dirname(sourceRelative);
      const targetRelative = safeRelative(path.posix.join(parentRelative === "." ? "" : parentRelative, newName));
      const targetPath = resolveInsideRoot(targetRelative, req);
      if (sourceRelative === targetRelative) throw new Error("新名称不能与原名称相同");
      const sourceStat = await fsp.stat(toFsPath(sourcePath));
      try {
        await fsp.access(targetPath);
        throw new Error("目标名称已存在");
      } catch (error) {
        if (error.message === "目标名称已存在") throw error;
      }
      await cleanupThumbCacheForPath(sourcePath, sourceStat);
      await fsp.rename(sourcePath, targetPath);
      try {
        copyFileAttributions(sourceRelative, targetRelative, req._nsfwMode, true);
      } catch (error) {
        console.error(`上传者记录重命名失败: ${error.message}`);
      }
      invalidateFolderSizeCacheForPath(sourceRelative, req._nsfwMode);
      invalidateFolderSizeCacheForPath(targetRelative, req._nsfwMode);
      logAction(getDeviceName(req), getClientIp(req), "重命名", `${sourceRelative} → ${newName}`);
      sendJson(res, 200, { ok: true, oldPath: sourceRelative, newPath: targetRelative });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/move") {
    try {
      const body = parseJson(await readRequestBody(req));
      const paths = (Array.isArray(body.paths) ? body.paths : [body.path]).map((item) => safeRelative(item)).filter(Boolean);
      if (paths.length === 0) throw new Error("没有可移动的项目");
      const moved = await moveItems(paths, body.targetDir, { overwrite: body.overwrite === true }, req._nsfwMode ? NSFW_DIR : null);
      moved.forEach((item) => {
        try {
          copyFileAttributions(item.from, item.to, req._nsfwMode, true);
        } catch (error) {
          console.error(`上传者记录移动失败: ${error.message}`);
        }
      });
      const movedNames = moved.map(m => m.from.split("/").pop());
      if (moved.length > 0) {
        logAction(getDeviceName(req), getClientIp(req), "移动", `${moved.length} 项 → /${body.targetDir || ""}`, movedNames);
      }
      sendJson(res, 200, { ok: true, moved });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message, conflicts: error.conflicts || [] });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/copy") {
    try {
      const body = parseJson(await readRequestBody(req));
      const paths = (Array.isArray(body.paths) ? body.paths : [body.path]).map((item) => safeRelative(item)).filter(Boolean);
      if (paths.length === 0) throw new Error("没有可复制的项目");
      const copied = await copyItems(paths, body.targetDir, req._nsfwMode ? NSFW_DIR : null);
      copied.forEach((item) => {
        try {
          copyFileAttributions(item.from, item.to, req._nsfwMode, false);
        } catch (error) {
          console.error(`上传者记录复制失败: ${error.message}`);
        }
      });
      const copiedNames = copied.map(m => m.from.split("/").pop());
      logAction(getDeviceName(req), getClientIp(req), "复制", `${paths.length} 项 → /${body.targetDir || ""}`, copiedNames);
      sendJson(res, 200, { ok: true, copied: copied.length });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/check-conflicts") {
    try {
      const body = parseJson(await readRequestBody(req));
      const operation = String(body.operation || "");
      let conflicts = [];
      var chkRoot = req._nsfwMode ? NSFW_DIR : null
      if (operation === "upload") {
        conflicts = await collectUploadConflicts(body.dir, body.entries, chkRoot);
      } else if (operation === "move") {
        const paths = (Array.isArray(body.paths) ? body.paths : [body.path]).map((item) => safeRelative(item)).filter(Boolean);
        conflicts = await collectMoveConflicts(paths, body.targetDir, chkRoot);
      } else {
        throw new Error("未知的冲突检查类型");
      }
      sendJson(res, 200, { ok: true, conflicts });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message, conflicts: error.conflicts || [] });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/upload") {
    try {
      const contentType = String(req.headers["content-type"] || "");
      if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
        throw new Error("上传请求格式错误");
      }
      const result = await handleStreamingUpload(req, req._nsfwMode ? NSFW_DIR : null);
      const names = result.uploadedNames || [];
      const targetLabel = names.length === 1 ? names[0] : `${result.uploaded} 项`;
      const detail = `${targetLabel}（${result.uploaded} 个文件，${result.uploadedBytes} 字节）`;
      logAction(getDeviceName(req), getClientIp(req), "上传", detail, names);
      sendJson(res, 200, { ok: true, uploaded: result.uploaded, backupBatchId: result.backupBatchId });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message, conflicts: error.conflicts || [] });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/download-batch") {
    try {
      const body = parseJson(await readRequestBody(req));
      const paths = (Array.isArray(body.paths) ? body.paths : []).map((item) => safeRelative(item)).filter(Boolean);
      const data = await createBatchDownload(paths, req._nsfwMode ? NSFW_DIR : null);
      const downloadNames = (data.skipped || []).length > 0
        ? [`${paths.length} 项 (${data.skipped.length} 项已跳过)`]
        : paths.map(p => p.split("/").pop());
      logAction(
        getDeviceName(req),
        getClientIp(req),
        "下载",
        `${paths.length} 项（${data.fileCount} 个文件，${data.totalBytes} 字节）`,
        downloadNames
      );
      sendJson(res, 200, {
        ok: true,
        downloadUrl: `/download-batch?token=${encodeURIComponent(data.token)}&name=${encodeURIComponent(data.fileName)}`,
        skipped: data.skipped,
        fileCount: data.fileCount
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/recycle/restore") {
    try {
      const body = parseJson(await readRequestBody(req));
      const restoreId = String(body.id || "");
      let restoreName = "回收站项目";
      let restoreItems = [];
      try {
        const metaPath = path.join(resolveRecycleEntryDir(restoreId), "meta.json");
        const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
        if (meta.name) restoreName = meta.name;
        restoreItems = await getRecycleEntryFileNames(restoreId);
      } catch {}
      await restoreRecycleEntry(restoreId);
      logAction(getDeviceName(req), getClientIp(req), "恢复", restoreName, restoreItems);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/recycle/delete") {
    try {
      const body = parseJson(await readRequestBody(req));
      const deleteId = String(body.id || "");
      let deleteName = "回收站项目";
      let deleteItems = [];
      try {
        const metaPath = path.join(resolveRecycleEntryDir(deleteId), "meta.json");
        const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
        if (meta.name) deleteName = meta.name;
        deleteItems = await getRecycleEntryFileNames(deleteId);
      } catch {}
      const deletedFileCount = countLoggedFileNames(deleteItems);
      await permanentlyDeleteRecycleEntry(deleteId);
      logAction(
        getDeviceName(req),
        getClientIp(req),
        "彻底删除",
        `${deleteName}（${deletedFileCount} 个文件）`,
        deleteItems
      );
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/nickname") {
    try {
      const body = parseJson(await readRequestBody(req));
      const oldName = req.authUser.name;
      const newName = validateAccountName(body.newName);
      initAuthDatabase().prepare("UPDATE users SET name = ?, updated_at = ? WHERE id = ?")
        .run(newName, Date.now(), req.authUser.id);
      if (oldName !== newName) {
        logAction(newName, getClientIp(req), "修改姓名", `${oldName} → ${newName}`);
      }
      const row = initAuthDatabase()
        .prepare(`
          SELECT id, username, name, role, is_protected_admin AS protectedAdmin
          FROM users
          WHERE id = ?
        `)
        .get(req.authUser.id);
      sendJson(res, 200, { ok: true, user: publicAuthUser(row) }, { "Cache-Control": "no-store" });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  // 设置项目状态
  if (req.method === "POST" && url.pathname === "/api/set-status") {
    try {
      const body = parseJson(await readRequestBody(req));
      const dir = safeRelative(body.path || "");
      const fullPath = resolveInsideRoot(dir, req);
      const stat = await fsp.stat(fullPath);
      if (!stat.isDirectory()) throw new Error("只能设置目录状态");
      var status = String(body.status || "not_started").trim()
      if (!["completed", "in_progress", "not_started"].includes(status)) throw new Error("无效的状态");
      var marker = path.join(fullPath, ".status")
      // 删除旧版 .complete 标记
      var oldMarker = path.join(fullPath, ".complete")
      try { await fsp.unlink(oldMarker) } catch (_) {}
      await fsp.writeFile(marker, status, "utf8")
      sendJson(res, 200, { ok: true, status });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  return false;
}

async function streamFile(req, res, url, download, previewOnly = false) {
  try {
    const relativePath = safeRelative(url.searchParams.get("path"));
    const root = nsfwRoot(req);
    const fullPath = path.resolve(root, relativePath);
    if (fullPath !== root && !fullPath.startsWith(root + path.sep)) throw new Error("路径越界");
    const stat = await fsp.stat(fullPath);
    if (!stat.isFile()) {
      sendText(res, 400, "仅支持文件访问");
      return;
    }
    const fileName = path.basename(fullPath);
    const mimeType = getMimeType(fullPath);
    if (previewOnly && !isStreamPreviewType(getPreviewType(fileName))) {
      sendText(res, 403, "该文件类型不支持在线预览");
      return;
    }
    if (download) {
      logAction(getDeviceName(req), getClientIp(req), "下载", `${fileName}（1 个文件，${stat.size} 字节）`, [fileName]);
    }
    const range = req.headers.range;
    if (range && !download) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (!match) {
        sendText(res, 416, "无效的 Range 请求");
        return;
      }
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": mimeType,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": previewOnly ? "private, no-store" : "no-cache",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin"
      });
      await pipeFileToResponse(res, fullPath, { start, end });
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeType,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": previewOnly ? "private, no-store" : "no-cache",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin"
    });
    await pipeFileToResponse(res, fullPath);
  } catch (error) {
    sendText(res, 400, error.message);
  }
}

function appendBatchDownloadEntries(archive, entry) {
  if (entry.skipped.length > 0) {
    const content = [
      "以下项目在创建下载任务时不存在，已自动跳过：",
      ...entry.skipped.map((item) => `- ${item}`),
      ""
    ].join("\n");
    archive.append(content, { name: "下载说明.txt" });
  }

  for (const item of entry.entries) {
    const name = item.archivePath || item.relativePath;
    if (item.type === "directory") {
      archive.directory(item.fullPath, name);
    } else {
      archive.file(item.fullPath, { name });
    }
  }
}

async function streamBatchDownload(req, res, url) {
  requirePermission(req, "files.download");
  const token = String(url.searchParams.get("token") || "");
  const entry = batchDownloads.get(token);
  if (!entry) {
    sendText(res, 404, "Download package not found or expired");
    return;
  }
  const fileName = String(url.searchParams.get("name") || entry.fileName || "batch_download.zip");
  let completed = false;

  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Cache-Control": "no-store"
  });

  const archive = archiver("zip", {
    forceZip64: true,
    store: true
  });

  archive.on("warning", (error) => {
    if (error.code === "ENOENT") {
      console.warn(`批量下载跳过不存在项目: ${error.message}`);
      return;
    }
    archive.emit("error", error);
  });

  archive.on("error", (error) => {
    console.error(`批量下载失败: ${error.message}`);
    if (!res.headersSent) {
      sendText(res, 500, "批量下载失败");
      return;
    }
    res.destroy(error);
  });

  archive.pipe(res);
  appendBatchDownloadEntries(archive, entry);
  archive.finalize();

  res.on("finish", () => {
    completed = true;
    cleanupBatchDownload(token);
  });

  res.on("close", () => {
    if (!completed) {
      archive.abort();
    }
    cleanupBatchDownload(token);
  });
}

const server = http.createServer(async (req, res) => {
  res.on("error", () => {});
  setNsfwMode(req);
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    req.authUser = readAuthenticatedUser(req);
    if (await handleAuthApi(req, res, url)) return;

    const isLoginAsset = req.method === "GET" && (
      url.pathname === "/login"
      || url.pathname === "/login.html"
      || url.pathname === "/login.css"
      || url.pathname === "/login.js"
    );
    if (isLoginAsset) {
      if (req.authUser && (url.pathname === "/login" || url.pathname === "/login.html")) {
        res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const loginFile = url.pathname === "/login.css"
        ? "login.css"
        : url.pathname === "/login.js"
          ? "login.js"
          : "login.html";
      await serveStaticFile(res, path.join(STATIC_DIR, loginFile));
      return;
    }

    if (!req.authUser) {
      if (req.method === "GET" && (
        url.pathname === "/"
        || url.pathname === "/index.html"
        || url.pathname === "/player"
        || url.pathname === "/player/"
      )) {
        res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" });
        res.end();
      } else {
        sendAuthRequired(res);
      }
      return;
    }

    if (requestNeedsNsfwSession(req, url) && !isNsfwAuthorized(req)) {
      sendJson(res, 401, { error: "请先验证海外剧访问密码" }, { "Set-Cookie": makeNsfwSessionCookie("", 0) });
      return;
    }
    if (await handleApi(req, res, url)) return;
    if (req.method === "GET" && url.pathname === "/download") {
      requirePermission(req, "files.download");
      return void await streamFile(req, res, url, true);
    }
    if (req.method === "GET" && url.pathname === "/api/thumb") {
      requirePermission(req, "files.preview");
      try {
        await handleThumbnail(res, url, req);
      } catch (e) {
        sendText(res, 400, e.message || "thumb error");
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/file") {
      requirePermission(req, "files.download");
      return void await streamFile(req, res, url, false);
    }
    if (req.method === "GET" && url.pathname === "/preview") {
      requirePermission(req, "files.preview");
      return void await streamFile(req, res, url, false, true);
    }
    if (req.method === "GET" && url.pathname === "/download-batch") {
      return void await streamBatchDownload(req, res, url);
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return void await serveStaticFile(res, path.join(STATIC_DIR, "index.html"));
    if (req.method === "GET" && url.pathname === "/app.js") return void await serveStaticFile(res, path.join(STATIC_DIR, "app.js"));
    if (req.method === "GET" && url.pathname === "/styles.css") return void await serveStaticFile(res, path.join(STATIC_DIR, "styles.css"));
    if (req.method === "GET") {
      // 播放器页面
      if (url.pathname === "/player" || url.pathname === "/player/") {
        return void await serveStaticFile(res, path.join(STATIC_DIR, "player", "index.html"))
      }
      const p = path.resolve(STATIC_DIR, url.pathname.replace(/^\//, ""));
      if (p.startsWith(STATIC_DIR + path.sep) || p === STATIC_DIR) {
        try { await fsp.access(p); return void await serveStaticFile(res, p); } catch {}
      }
      // 为播放器提供 node_modules 访问
      const nm = path.resolve(__dirname, "node_modules", url.pathname.replace(/^\/node_modules\//, ""));
      if (nm.startsWith(path.resolve(__dirname, "node_modules") + path.sep)) {
        try { await fsp.access(nm); return void await serveStaticFile(res, nm); } catch {}
      }
      // ffmpeg.wasm 核心文件
      if (url.pathname === "/wasm/ffmpeg-core.js" || url.pathname === "/wasm/ffmpeg-core.wasm") {
        const wasmPath = path.join(__dirname, "node_modules", "@ffmpeg", "core", "dist", "esm", path.basename(url.pathname))
        try { await fsp.access(wasmPath); return void await serveStaticFile(res, wasmPath); } catch {}
      }
    }
    sendText(res, 404, "Not Found");
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, error.statusCode || 500, {
        error: error.message || "服务器错误",
        code: error.code
      });
    } else {
      res.destroy();
    }
  }
});

async function restoreLogBuffer() {
  try {
    const today = `${new Date().toISOString().slice(0, 10)}.log`;
    const logFile = path.join(LOG_DIR, today);
    const content = await fsp.readFile(logFile, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    // Parse log lines back into entry objects
    for (const line of lines.slice(-MAX_LOG_BUFFER)) {
      const match = line.match(/^\[(.+?)\] (.+?)(?: \(([^)]+)\))? ([^ ]+) (.+)$/);
      if (match) {
        if (match[4] === "修改昵称") {
          continue;
        }
        logBuffer.push({ time: match[1], deviceName: match[2], clientIp: match[3], action: match[4], detail: match[5] });
      } else {
        // Lines that don't match (e.g., detailed file lists) get attached to the previous entry
        const itemMatch = line.match(/^\s*-\s*(.+)$/);
        if (itemMatch && logBuffer.length > 0) {
          const last = logBuffer[logBuffer.length - 1];
          if (!last.items) last.items = [];
          last.items.push(itemMatch[1]);
        }
      }
    }
  } catch {}
}

async function start() {
  await ensureDir(ROOT_DIR);
  await ensureDir(BACKUP_DIR);
  await ensureDir(DAILY_BACKUP_DIR);
  await ensureDir(RECYCLE_DIR);
  await ensureDir(LOG_DIR);
  await ensureDir(TMP_DIR);
  await ensureDir(NSFW_DIR);
  await loadNsfwPassword();
  await loadFolderSizeCache();
  await restoreLogBuffer();
  const accountDatabase = initAuthDatabase();
  initForumDatabase();
  await cleanupExpiredRecycleEntries();
  setInterval(() => {
    cleanupExpiredRecycleEntries().catch((error) => {
      console.error(`回收站巡检失败: ${error.message}`);
    });
  }, RECYCLE_CLEANUP_INTERVAL_MS);
  cleanupStaleThumbnailCache().catch((error) => {
    console.error(`缩略图缓存巡检失败: ${error.message}`);
  });
  if (THUMB_CACHE_CLEANUP_INTERVAL_MS > 0) {
    setInterval(() => {
      cleanupStaleThumbnailCache().catch((error) => {
        console.error(`缩略图缓存巡检失败: ${error.message}`);
      });
    }, THUMB_CACHE_CLEANUP_INTERVAL_MS);
  }
  scheduleDailyBackup();
  if (DAILY_BACKUP_ENABLED && DAILY_BACKUP_RUN_ON_START) {
    createDailyBackupSnapshot().catch(() => {});
  }
  server.listen(PORT, HOST, () => {
    const adminCount = Number(accountDatabase.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND enabled = 1"
    ).get().count || 0);
    console.log(
      adminCount > 0
        ? `账号系统: 已配置 ${adminCount} 名管理员`
        : "账号系统: 尚未创建管理员，请从本机登录页注册首个账号"
    );
    console.log(`共享目录: ${ROOT_DIR}`);
    console.log(`备份目录: ${BACKUP_DIR}`);
    console.log(`回收站目录: ${RECYCLE_DIR}`);
    console.log(`本机访问: http://127.0.0.1:${PORT}`);
    for (const url of getLanUrls()) {
      console.log(`局域网访问: ${url}`);
    }
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
