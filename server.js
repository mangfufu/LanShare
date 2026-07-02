const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn, execSync } = require("child_process");
const { URL } = require("url");

// 自动安装依赖
function ensureDeps() {
  const deps = ["busboy", "archiver", "sharp"];
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
let sharp;
try { sharp = require("sharp"); } catch { console.error("错误: sharp 未安装"); process.exit(1); }
const TMP_DIR = path.join(__dirname, "thumb_cache");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8082);
const ROOT_DIR = path.resolve(process.env.SHARED_DIR || path.join(__dirname, "shared"));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, "backup"));
const RECYCLE_DIR = path.resolve(process.env.RECYCLE_DIR || path.join(__dirname, "recycle_bin"));
const LOG_DIR = path.join(__dirname, "logs");
const STATIC_DIR = path.join(__dirname, "static");
const FOLDER_SIZE_CACHE_FILE = path.join(__dirname, "folder_size_cache.json");
const MAX_BODY_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 8 * 1024 * 1024 * 1024);
const BATCH_DOWNLOAD_TTL_MS = 30 * 60 * 1000;
const RECYCLE_RETENTION_DAYS = Number(process.env.RECYCLE_RETENTION_DAYS || 7);
const RECYCLE_CLEANUP_INTERVAL_MS = Number(process.env.RECYCLE_CLEANUP_INTERVAL_MS || 60 * 60 * 1000);
const MAX_PARALLEL_FILE_STREAMS = Number(process.env.MAX_PARALLEL_FILE_STREAMS || 48);
const MAX_THUMB_SOURCE_SIZE = Number(process.env.MAX_THUMB_SOURCE_SIZE || 128 * 1024 * 1024);
const MAX_VIDEO_THUMB_JOBS = Number(process.env.MAX_VIDEO_THUMB_JOBS || 1);
const MAX_FOLDER_SIZE_DEPTH = Number(process.env.MAX_FOLDER_SIZE_DEPTH || 64);
const MAX_FOLDER_SIZE_JOBS = Number(process.env.MAX_FOLDER_SIZE_JOBS || 1);
const FOLDER_SIZE_CACHE_MAX_AGE_MS = Number(process.env.FOLDER_SIZE_CACHE_MAX_AGE_MS || 24 * 60 * 60 * 1000);
const FOLDER_SIZE_CACHE_SAVE_DELAY_MS = 1000;
const THUMB_CACHE_CLEANUP_INTERVAL_MS = Number(process.env.THUMB_CACHE_CLEANUP_INTERVAL_MS || 6 * 60 * 60 * 1000);
const THUMB_CACHE_MAX_AGE_DAYS = Number(process.env.THUMB_CACHE_MAX_AGE_DAYS || 30);
const THUMB_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const batchDownloads = new Map();
const logBuffer = [];
const MAX_LOG_BUFFER = 200;
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB per file
let activeFileStreams = 0;
const pendingFileStreamSlots = [];
const videoThumbQueue = [];
const videoThumbJobs = new Map();
let activeVideoThumbJobs = 0;
const folderSizeCache = new Map();
const folderSizeQueue = [];
const queuedFolderSizePaths = new Set();
let activeFolderSizeJobs = 0;
let folderSizeCacheSaveTimer = null;
const CSRF_TOKEN = crypto.randomBytes(32).toString("hex");
const PROTECTED_POST_PATHS = new Set([
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
  "/api/nickname"
]);

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
  ".zip": "application/zip"
};

const IMAGE_THUMB_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const VIDEO_THUMB_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi"]);

function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function getHeaderValue(req, name) {
  return String(req.headers[name] || "").trim();
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

function resolveInsideRoot(relativePath) {
  const fullPath = path.resolve(ROOT_DIR, relativePath);
  if (fullPath !== ROOT_DIR && !fullPath.startsWith(`${ROOT_DIR}${path.sep}`)) {
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
  return "none";
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

function invalidateFolderSizeCacheForPath(relativePath) {
  const key = safeRelative(relativePath);
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
  const key = safeRelative(relativePath);
  const dirPath = resolveInsideRoot(key);
  const beforeStat = await fsp.stat(toFsPath(dirPath)).catch(() => null);
  if (!beforeStat || !beforeStat.isDirectory()) {
    if (folderSizeCache.delete(key)) scheduleFolderSizeCacheSave();
    return;
  }

  const size = await getDirSize(dirPath, 1);
  const currentStat = await fsp.stat(toFsPath(dirPath)).catch(() => null);
  if (!currentStat || !currentStat.isDirectory()) {
    if (folderSizeCache.delete(key)) scheduleFolderSizeCacheSave();
    return;
  }

  folderSizeCache.set(key, {
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

async function readFolderSizeStatus(relativePath) {
  const key = safeRelative(relativePath);
  const fullPath = resolveInsideRoot(key);
  const stat = await fsp.stat(toFsPath(fullPath)).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return { path: key, folderSize: null, folderSizeStatus: "missing", folderSizeCachedAt: null };
  }
  return { path: key, ...getFolderSizeInfo(key, stat) };
}

async function buildListItem(item, normalizedDir) {
  const childRelative = safeRelative(path.posix.join(normalizedDir, item.name));
  const childPath = resolveInsideRoot(childRelative);
  const stat = await fsp.stat(childPath);
  const previewType = item.isDirectory() ? "none" : getPreviewType(item.name);
  const result = {
    name: item.name,
    path: childRelative,
    type: item.isDirectory() ? "directory" : "file",
    previewType,
    size: item.isDirectory() ? null : stat.size,
    updatedAt: stat.mtime.toISOString()
  };
  if (item.isDirectory()) {
    Object.assign(result, getFolderSizeInfo(childRelative, stat));
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

async function collectUploadConflicts(dir, entries) {
  const safeDir = safeRelative(dir);
  const conflictMap = new Map();
  const uploadEntries = Array.isArray(entries) ? entries : [];

  for (const entry of uploadEntries) {
    const uploadRelative = normalizeUploadRelativeName(entry);
    const segments = uploadRelative.split("/");
    let currentDir = safeDir;

    for (const segment of segments.slice(0, -1)) {
      currentDir = safeRelative(path.posix.join(currentDir, segment));
      const currentPath = resolveInsideRoot(currentDir);
      const currentStat = await fsp.stat(toFsPath(currentPath)).catch(() => null);
      if (currentStat && !currentStat.isDirectory()) {
        conflictMap.set(currentDir, makeConflict(currentDir, currentStat));
      }
    }

    const targetRelative = safeRelative(path.posix.join(safeDir, uploadRelative));
    const targetPath = resolveInsideRoot(targetRelative);
    const targetStat = await fsp.stat(toFsPath(targetPath)).catch(() => null);
    if (targetStat) {
      conflictMap.set(targetRelative, makeConflict(targetRelative, targetStat));
    }
  }

  return [...conflictMap.values()];
}

async function ensureUploadParentDirectories(fileRelative, overwriteExisting) {
  const segments = fileRelative.split("/").filter(Boolean);
  let currentRelative = "";

  for (const segment of segments.slice(0, -1)) {
    currentRelative = safeRelative(path.posix.join(currentRelative, segment));
    const currentPath = resolveInsideRoot(currentRelative);
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
    await moveToRecycle(currentRelative);
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

function getDeviceName(req) {
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
  const stat = await fsp.stat(logFile).catch(() => null);
  if (stat && stat.size > MAX_LOG_SIZE) {
    try { await fsp.rename(`${logFile}.1`, `${logFile}.2`); } catch {}
    try { await fsp.rename(logFile, `${logFile}.1`); } catch {}
  }
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
  res.writeHead(200, { "Content-Type": getMimeType(filePath) });
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

function acquireFileStreamSlot() {
  if (activeFileStreams < MAX_PARALLEL_FILE_STREAMS) {
    activeFileStreams += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("文件流槽位超时")), 30000);
    pendingFileStreamSlots.push(() => {
      clearTimeout(timeout);
      activeFileStreams += 1;
      resolve();
    });
  });
}

function releaseFileStreamSlot() {
  activeFileStreams = Math.max(0, activeFileStreams - 1);
  const next = pendingFileStreamSlots.shift();
  if (next) next();
}

async function pipeFileToResponse(res, filePath, options = {}) {
  await acquireFileStreamSlot();
  const stream = fs.createReadStream(filePath, options);
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseFileStreamSlot();
  };
  stream.on("error", (error) => {
    releaseOnce();
    console.error(`文件流读取失败: ${error.message}`);
    if (!res.headersSent) {
      sendText(res, error.code === "EMFILE" ? 503 : 500, "文件读取失败，请稍后重试");
      return;
    }
    res.destroy();
  });
  stream.on("close", releaseOnce);
  res.on("close", () => {
    stream.destroy();
    releaseOnce();
  });
  stream.pipe(res);
  stream.on("end", () => {
    res.end();
  });
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
  if (!isPathInsideOrEqual(ROOT_DIR, fullPath)) return false;
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

async function handleThumbnail(res, url) {
  const q = safeRelative(url.searchParams.get("path") || "");
  const fullPath = resolveInsideRoot(q);
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

async function handleStreamingUpload(req) {
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
    const uploadedNames = [];
    const backupBatchId = makeTimestampId();
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
        filePath = resolveInsideRoot(fileRelative);
        backupPath = path.join(BACKUP_DIR, backupBatchId, fileRelative);
      } catch (error) {
        fileStream.resume();
        fail(error);
        return;
      }

      const task = (async () => {
        await ensureUploadParentDirectories(fileRelative, overwriteExisting);
        const existingStat = await fsp.stat(toFsPath(filePath)).catch(() => null);
        if (existingStat) {
          const conflict = makeConflict(fileRelative, existingStat);
          if (!overwriteExisting) {
            throw createConflictError([conflict], "存在同名项目，请确认是否覆盖");
          }
          await cleanupThumbCacheForPath(filePath, existingStat);
          await moveToRecycle(fileRelative);
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
              const segments = relativeNameRaw.split("/");
              uploadedNames.push(segments[segments.length - 1]);
              invalidateFolderSizeCacheForPath(fileRelative);
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

        // 后台异步备份，不阻塞上传响应
        (async () => {
          try {
            await ensureDir(path.dirname(backupPath));
            await fsp.copyFile(filePath, backupPath);
          } catch (err) {
            console.error(`文件备份失败 ${filePath}: ${err.message}`);
          }
        })();
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
        resolve({ uploaded: uploadedCount, backupBatchId, uploadedNames });
      } catch (error) {
        fail(error);
      }
    });

    req.on("aborted", () => fail(new Error("上传已中断")));
    req.pipe(busboy);
  });
}

async function listDirectory(relativeDir, offset, limit) {
  const dirPath = resolveInsideRoot(relativeDir);
  const items = await fsp.readdir(dirPath, { withFileTypes: true });
  const filtered = items.filter(i => !i.name.startsWith(".bg"));
  const sorted = filtered.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return compareNames(a.name, b.name);
  });
  const total = sorted.length;
  const page = offset !== undefined ? sorted.slice(offset, offset + (limit || 50)) : sorted;
  const normalizedDir = relativeDir.replaceAll("\\", "/");
  var pageResults = await Promise.all(page.map((item) => buildListItem(item, normalizedDir)));
  return { items: pageResults, total };
}

const MAX_SEARCH_RESULTS = 200;

async function searchShared(query) {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return { items: [], stoppedEarly: false, total: 0 };

  const results = [];
  let stoppedEarly = false;

  async function walk(dirRelative) {
    if (results.length >= MAX_SEARCH_RESULTS) {
      stoppedEarly = true;
      return;
    }

    const dirPath = resolveInsideRoot(dirRelative);
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
          const childPath = resolveInsideRoot(childRelative);
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
  return { items: results, stoppedEarly, total: results.length };
}

async function moveToRecycle(relativePath) {
  const sourcePath = resolveInsideRoot(relativePath);
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
  invalidateFolderSizeCacheForPath(relativePath);
  const meta = {
    id,
    name: storedName,
    originalPath: relativePath,
    itemType: stat.isDirectory() ? "directory" : "file",
    deletedAt: new Date().toISOString(),
    storedName
  };
  await fsp.writeFile(path.join(entryDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

async function collectMoveConflicts(paths, targetDir) {
  const safeTargetDir = safeRelative(targetDir);
  const targetDirPath = resolveInsideRoot(safeTargetDir);
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
    const sourcePath = resolveInsideRoot(sourceRelative);
    const sourceStat = await fsp.stat(sourcePath).catch(() => null);
    if (!sourceStat) {
      throw new Error(`源项目不存在：${sourceRelative}`);
    }

    const sourceName = path.posix.basename(sourceRelative);
    const destinationRelative = safeRelative(path.posix.join(safeTargetDir, sourceName));
    const destinationPath = resolveInsideRoot(destinationRelative);

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

async function moveItems(paths, targetDir, options = {}) {
  const overwriteExisting = Boolean(options.overwrite);
  const safeTargetDir = safeRelative(targetDir);
  const targetDirPath = resolveInsideRoot(safeTargetDir);
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

    const sourcePath = resolveInsideRoot(sourceRelative);
    const sourceStat = await fsp.stat(sourcePath).catch(() => null);
    if (!sourceStat) {
      throw new Error(`源项目不存在：${sourceRelative}`);
    }
    const sourceName = path.posix.basename(sourceRelative);
    const destinationRelative = safeRelative(path.posix.join(safeTargetDir, sourceName));
    const destinationPath = resolveInsideRoot(destinationRelative);

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
        await moveToRecycle(item.destinationRelative);
      }
      await fsp.rename(item.sourcePath, item.destinationPath);
      invalidateFolderSizeCacheForPath(item.sourceRelative);
      invalidateFolderSizeCacheForPath(item.destinationRelative);
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

async function copyItems(paths, targetDir) {
  const safeTargetDir = safeRelative(targetDir);
  const targetDirPath = resolveInsideRoot(safeTargetDir);
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

    const sourcePath = resolveInsideRoot(sourceRelative);
    const sourceName = path.posix.basename(sourceRelative);
    let destName = sourceName;
    let destRelative = safeRelative(path.posix.join(safeTargetDir, destName));
    let destPath = resolveInsideRoot(destRelative);

    // 如果目标已存在，添加 _副本 后缀
    let counter = 1;
    while (await fsp.stat(destPath).catch(() => null)) {
      const ext = path.posix.extname(sourceName);
      const base = path.posix.basename(sourceName, ext);
      destName = `${base}_副本${counter > 1 ? counter : ""}${ext}`;
      destRelative = safeRelative(path.posix.join(safeTargetDir, destName));
      destPath = resolveInsideRoot(destRelative);
      counter++;
    }

    await fsp.cp(sourcePath, destPath, { recursive: true });
    invalidateFolderSizeCacheForPath(destRelative);
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
  const targetPath = resolveInsideRoot(targetRelative);
  try {
    await fsp.access(targetPath);
    throw new Error("原位置已有同名文件或文件夹，无法恢复");
  } catch (error) {
    if (error.message === "原位置已有同名文件或文件夹，无法恢复") throw error;
  }
  await ensureDir(path.dirname(targetPath));
  await fsp.rename(sourcePath, targetPath);
  await fsp.rm(entryDir, { recursive: true, force: true });
  invalidateFolderSizeCacheForPath(targetRelative);
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

async function collectBatchDownloadEntries(paths) {
  const entries = [];
  const skipped = [];

  for (const item of paths) {
    const relativePath = safeRelative(item);
    if (!relativePath) continue;

    const fullPath = resolveInsideRoot(relativePath);
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

  return { entries, skipped };
}

function registerBatchDownload(entries, skipped) {
  const token = crypto.randomUUID();
  const fileName = makeBatchDownloadFileName();
  const timer = setTimeout(() => cleanupBatchDownload(token), BATCH_DOWNLOAD_TTL_MS);
  batchDownloads.set(token, { entries, skipped, fileName, timer });
  return { token, fileName };
}

async function createBatchDownload(paths) {
  if (paths.length === 0) {
    throw new Error("没有可下载的目标");
  }
  const { entries, skipped } = await collectBatchDownloadEntries(paths);
  return { ...registerBatchDownload(entries, skipped), skipped };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/list") {
    try {
      const dir = safeRelative(url.searchParams.get("dir"));
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const result = await listDirectory(dir, offset, limit);
      sendJson(res, 200, { currentDir: dir, ...result });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/folder-sizes") {
    try {
      const paths = url.searchParams.getAll("path").slice(0, 200);
      const items = await Promise.all(paths.map((item) => readFolderSizeStatus(item)));
      sendJson(res, 200, { items });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/search") {
    try {
      const query = String(url.searchParams.get("q") || "");
      const result = await searchShared(query);
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

  if (req.method === "GET" && url.pathname === "/api/logs") {
    sendJson(res, 200, { entries: [...logBuffer] });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/security") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify({ csrfToken: CSRF_TOKEN }));
    return true;
  }

  if (req.method === "POST" && PROTECTED_POST_PATHS.has(url.pathname)) {
    try {
      assertTrustedWriteRequest(req);
    } catch (error) {
      sendJson(res, error.statusCode || 403, { error: error.message });
      return true;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/mkdir") {
    try {
      const body = parseJson(await readRequestBody(req));
      const parentDir = safeRelative(body.dir);
      const name = String(body.name || "").trim();
      if (!name) throw new Error("文件夹名称不能为空");
      if (isInvalidFileName(name)) throw new Error("文件夹名称包含非法字符");
      const targetRelative = safeRelative(path.posix.join(parentDir, name));
      await ensureDir(resolveInsideRoot(targetRelative));
      invalidateFolderSizeCacheForPath(targetRelative);
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
      const projectPath = safeRelative(path.posix.join(parentDir, `《${name}》`));
      const projectFull = resolveInsideRoot(projectPath);

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
        const epName = `第${i + 1}集`;
        const epDir = path.join(projectFull, "视频", epName);
        dirs.push(epDir);
        // 补镜头目录
        const buDir = path.join(epDir, `${epName}补`);
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
      invalidateFolderSizeCacheForPath(projectPath);
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
      for (const item of paths) {
        try {
          const fullPath = resolveInsideRoot(safeRelative(item));
          const stat = await fsp.stat(fullPath);
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
        deleted.push(await moveToRecycle(item));
      }
      const itemNames = deleted.map(d => `${d.name}${d.itemType === "directory" ? " (文件夹)" : ""}`);
      const detail = paths.length === 1 ? itemNames[0] : `${paths.length} 项`;
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
      const sourcePath = resolveInsideRoot(sourceRelative);
      const parentRelative = path.posix.dirname(sourceRelative);
      const targetRelative = safeRelative(path.posix.join(parentRelative === "." ? "" : parentRelative, newName));
      const targetPath = resolveInsideRoot(targetRelative);
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
      invalidateFolderSizeCacheForPath(sourceRelative);
      invalidateFolderSizeCacheForPath(targetRelative);
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
      const moved = await moveItems(paths, body.targetDir, { overwrite: body.overwrite === true });
      const movedNames = moved.map(m => m.from.split("/").pop());
      logAction(getDeviceName(req), getClientIp(req), "移动", `${paths.length} 项 → /${body.targetDir || ""}`, movedNames);
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
      const copied = await copyItems(paths, body.targetDir);
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
      if (operation === "upload") {
        conflicts = await collectUploadConflicts(body.dir, body.entries);
      } else if (operation === "move") {
        const paths = (Array.isArray(body.paths) ? body.paths : [body.path]).map((item) => safeRelative(item)).filter(Boolean);
        conflicts = await collectMoveConflicts(paths, body.targetDir);
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
      const result = await handleStreamingUpload(req);
      const names = result.uploadedNames || [];
      const detail = names.length === 1 ? names[0] : `${result.uploaded} 项`;
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
      const data = await createBatchDownload(paths);
      const downloadNames = (data.skipped || []).length > 0
        ? [`${paths.length} 项 (${data.skipped.length} 项已跳过)`]
        : paths.map(p => p.split("/").pop());
      logAction(getDeviceName(req), getClientIp(req), "下载", `${paths.length} 项`, downloadNames);
      sendJson(res, 200, {
        ok: true,
        downloadUrl: `/download-batch?token=${encodeURIComponent(data.token)}&name=${encodeURIComponent(data.fileName)}`,
        skipped: data.skipped
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
      await permanentlyDeleteRecycleEntry(deleteId);
      logAction(getDeviceName(req), getClientIp(req), "彻底删除", deleteName, deleteItems);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/nickname") {
    try {
      const body = parseJson(await readRequestBody(req));
      const oldName = String(body.oldName || "").trim() || "未设置";
      const newName = String(body.newName || "").trim();
      if (!newName) {
        throw new Error("昵称不能为空");
      }
      if (oldName !== newName) {
        await appendLocalLogOnly(
          getDeviceName(req),
          getClientIp(req),
          "修改昵称",
          `${oldName} → ${newName}`
        );
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  return false;
}

async function streamFile(req, res, url, download) {
  try {
    const relativePath = safeRelative(url.searchParams.get("path"));
    const fullPath = resolveInsideRoot(relativePath);
    const stat = await fsp.stat(fullPath);
    if (!stat.isFile()) {
      sendText(res, 400, "仅支持文件访问");
      return;
    }
    const fileName = path.basename(fullPath);
    const mimeType = getMimeType(fullPath);
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
        "Accept-Ranges": "bytes"
      });
      await pipeFileToResponse(res, fullPath, { start, end });
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeType,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(fileName)}`
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

async function streamBatchDownload(res, url) {
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
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (await handleApi(req, res, url)) return;
    if (req.method === "GET" && url.pathname === "/download") return void await streamFile(req, res, url, true);
    if (req.method === "GET" && url.pathname === "/api/thumb") {
      try {
        await handleThumbnail(res, url);
      } catch (e) {
        sendText(res, 400, e.message || "thumb error");
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/file") return void await streamFile(req, res, url, false);
    if (req.method === "GET" && url.pathname === "/download-batch") return void await streamBatchDownload(res, url);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return void await serveStaticFile(res, path.join(STATIC_DIR, "index.html"));
    if (req.method === "GET" && url.pathname === "/app.js") return void await serveStaticFile(res, path.join(STATIC_DIR, "app.js"));
    if (req.method === "GET" && url.pathname === "/styles.css") return void await serveStaticFile(res, path.join(STATIC_DIR, "styles.css"));
    if (req.method === "GET") {
      const p = path.resolve(STATIC_DIR, url.pathname.replace(/^\//, ""));
      if (p.startsWith(STATIC_DIR + path.sep) || p === STATIC_DIR) {
        try { await fsp.access(p); return void await serveStaticFile(res, p); } catch {}
      }
    }
    sendText(res, 404, "Not Found");
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: error.message || "服务器错误" });
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
  await ensureDir(RECYCLE_DIR);
  await ensureDir(LOG_DIR);
  await ensureDir(TMP_DIR);
  await loadFolderSizeCache();
  await restoreLogBuffer();
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
  server.listen(PORT, HOST, () => {
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
