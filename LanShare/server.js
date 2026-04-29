const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const Busboy = require("busboy");
const archiver = require("archiver");
const { URL } = require("url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);
const ROOT_DIR = path.resolve(process.env.SHARED_DIR || path.join(process.cwd(), "shared"));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(process.cwd(), "backup"));
const RECYCLE_DIR = path.resolve(process.env.RECYCLE_DIR || path.join(process.cwd(), "recycle_bin"));
const LOG_DIR = path.join(__dirname, "logs");
const STATIC_DIR = path.join(__dirname, "static");
const MAX_BODY_SIZE = 1024 * 1024 * 1024;
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 4 * 1024 * 1024 * 1024);
const BATCH_DOWNLOAD_TTL_MS = 30 * 60 * 1000;
const RECYCLE_RETENTION_DAYS = Number(process.env.RECYCLE_RETENTION_DAYS || 7);
const RECYCLE_CLEANUP_INTERVAL_MS = Number(process.env.RECYCLE_CLEANUP_INTERVAL_MS || 60 * 60 * 1000);
const MAX_PARALLEL_FILE_STREAMS = Number(process.env.MAX_PARALLEL_FILE_STREAMS || 48);
const batchDownloads = new Map();
const logBuffer = [];
const MAX_LOG_BUFFER = 200;
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB per file
let activeFileStreams = 0;
const pendingFileStreamSlots = [];
const CSRF_TOKEN = crypto.randomBytes(32).toString("hex");
const PROTECTED_POST_PATHS = new Set([
  "/api/mkdir",
  "/api/delete",
  "/api/rename",
  "/api/move",
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

function getPreviewType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".flac"].includes(ext)) return "audio";
  if ([".mp4", ".webm", ".mov", ".mkv", ".avi"].includes(ext)) return "video";
  return "none";
}

async function buildListItem(item, normalizedDir) {
  const childRelative = safeRelative(path.posix.join(normalizedDir, item.name));
  const childPath = resolveInsideRoot(childRelative);
  const stat = await fsp.stat(childPath);
  const previewType = item.isDirectory() ? "none" : getPreviewType(item.name);
  return {
    name: item.name,
    path: childRelative,
    type: item.isDirectory() ? "directory" : "file",
    previewType,
    size: item.isDirectory() ? null : stat.size,
    updatedAt: stat.mtime.toISOString()
  };
}

function parseChineseNumeral(text) {
  const digits = { "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
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
    /第([零一二两三四五六七八九十百千\d]+)(?=集|话|章|回|卷|部|季|期|篇|$)/,
    /\b(?:ep|e)(\d+)\b/i,
    /(^|[^\d])(\d+)(?=集|话|章|回|卷|部|季|期|篇|$)/
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

async function getRecycleEntryFileNames(entryId) {
  const names = [];
  try {
    const entryDir = path.join(RECYCLE_DIR, entryId);
    const meta = JSON.parse(await fsp.readFile(path.join(entryDir, "meta.json"), "utf8"));
    const storedPath = path.join(entryDir, meta.storedName);
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
    for (let i = 2; i >= 1; i--) {
      const old = `${logFile}.${i}`;
      const src = i === 1 ? logFile : `${logFile}.${i - 1}`;
      try { await fsp.rename(src, old); } catch {}
    }
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
}

function acquireFileStreamSlot() {
  if (activeFileStreams < MAX_PARALLEL_FILE_STREAMS) {
    activeFileStreams += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => pendingFileStreamSlots.push(resolve)).then(() => {
    activeFileStreams += 1;
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

      if (!relativeNameRaw) {
        fileStream.resume();
        fail(new Error("存在文件名为空的上传项"));
        return;
      }

      const segments = relativeNameRaw.split("/").filter(Boolean);
      if (segments.length === 0) {
        fileStream.resume();
        fail(new Error("上传路径无效"));
        return;
      }
      for (const segment of segments) {
        if (isInvalidFileName(segment)) {
          fileStream.resume();
          fail(new Error(`文件名非法: ${relativeNameRaw}`));
          return;
        }
      }

      let fileRelative;
      let filePath;
      let backupPath;
      try {
        fileRelative = safeRelative(path.posix.join(dir, relativeNameRaw));
        filePath = resolveInsideRoot(fileRelative);
        backupPath = path.join(BACKUP_DIR, backupBatchId, fileRelative);
      } catch (error) {
        fileStream.resume();
        fail(error);
        return;
      }

      const task = (async () => {
        await ensureDir(path.dirname(filePath));
        // 只写 shared 文件，不等待备份
        await new Promise((resolveFile, rejectFile) => {
          const sharedStream = fs.createWriteStream(filePath);

          const onError = (error) => {
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
            uploadedCount += 1;
            const segments = relativeNameRaw.split("/");
            uploadedNames.push(segments[segments.length - 1]);
            resolveFile();
          });

          fileStream.pipe(sharedStream);
        });

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

async function listDirectory(relativeDir) {
  const dirPath = resolveInsideRoot(relativeDir);
  const items = await fsp.readdir(dirPath, { withFileTypes: true });
  const filtered = items.filter(i => !i.name.startsWith(".bg"));
  const sorted = filtered.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return compareNames(a.name, b.name);
  });
  const normalizedDir = relativeDir.replaceAll("\\", "/");
  return await Promise.all(sorted.map((item) => buildListItem(item, normalizedDir)));
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
  await fsp.rename(sourcePath, storedPath);
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

async function moveItems(paths, targetDir) {
  const safeTargetDir = safeRelative(targetDir);
  const targetDirPath = resolveInsideRoot(safeTargetDir);
  const targetStat = await fsp.stat(targetDirPath).catch(() => null);
  if (!targetStat || !targetStat.isDirectory()) {
    throw new Error("目标文件夹不存在");
  }

  const moved = [];
  for (const item of paths) {
    const sourceRelative = safeRelative(item);
    if (!sourceRelative) {
      throw new Error("不能移动 shared 根目录");
    }

    const sourcePath = resolveInsideRoot(sourceRelative);
    const sourceName = path.posix.basename(sourceRelative);
    const destinationRelative = safeRelative(path.posix.join(safeTargetDir, sourceName));
    const destinationPath = resolveInsideRoot(destinationRelative);

    if (sourceRelative === destinationRelative) {
      continue;
    }

    if (destinationRelative.startsWith(`${sourceRelative}/`)) {
      throw new Error(`不能把文件夹移动到它自己的子目录中：${sourceName}`);
    }

    const destinationExists = await fsp.access(destinationPath).then(() => true).catch(() => false);
    if (destinationExists) {
      throw new Error(`目标位置已存在同名项目：${sourceName}`);
    }

    await fsp.rename(sourcePath, destinationPath);
    moved.push({ from: sourceRelative, to: destinationRelative });
  }

  return moved;
}

async function readRecycleEntries() {
  await ensureDir(RECYCLE_DIR);
  const entries = await fsp.readdir(RECYCLE_DIR, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(RECYCLE_DIR, entry.name, "meta.json");
    try {
      const metaRaw = await fsp.readFile(metaPath, "utf8");
      const meta = JSON.parse(metaRaw);
      if (!meta.storedName || !meta.id) throw new Error("meta 不完整");
      const storedPath = path.join(RECYCLE_DIR, entry.name, meta.storedName);
      const stat = await fsp.stat(storedPath);
      result.push({
        ...meta,
        size: stat.isDirectory() ? null : stat.size
      });
    } catch {
      // meta.json 损坏或不完整时，尝试基于目录内容有损恢复
      try {
        const files = await fsp.readdir(path.join(RECYCLE_DIR, entry.name));
        const realFiles = files.filter((f) => f !== "meta.json");
        if (realFiles.length > 0) {
          const storedPath = path.join(RECYCLE_DIR, entry.name, realFiles[0]);
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
  const entryDir = path.join(RECYCLE_DIR, id);
  const meta = JSON.parse(await fsp.readFile(path.join(entryDir, "meta.json"), "utf8"));
  const sourcePath = path.join(entryDir, meta.storedName);
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
}

async function permanentlyDeleteRecycleEntry(id) {
  const entryDir = path.join(RECYCLE_DIR, id);
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
      const items = await listDirectory(dir);
      sendJson(res, 200, { currentDir: dir, rootDir: ROOT_DIR, items });
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
      logAction(getDeviceName(req), getClientIp(req), "创建文件夹", path.posix.join(parentDir, name));
      sendJson(res, 200, { ok: true, path: targetRelative });
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
      await fsp.access(sourcePath);
      try {
        await fsp.access(targetPath);
        throw new Error("目标名称已存在");
      } catch (error) {
        if (error.message === "目标名称已存在") throw error;
      }
      await fsp.rename(sourcePath, targetPath);
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
      const moved = await moveItems(paths, body.targetDir);
      const movedNames = moved.map(m => m.from.split("/").pop());
      logAction(getDeviceName(req), getClientIp(req), "移动", `${paths.length} 项 → /${body.targetDir || ""}`, movedNames);
      sendJson(res, 200, { ok: true, moved });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
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
      sendJson(res, error.statusCode || 400, { error: error.message });
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
        const metaPath = path.join(RECYCLE_DIR, restoreId, "meta.json");
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
        const metaPath = path.join(RECYCLE_DIR, deleteId, "meta.json");
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
    if (item.type === "directory") {
      archive.directory(item.fullPath, item.relativePath);
    } else {
      archive.file(item.fullPath, { name: item.relativePath });
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
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (await handleApi(req, res, url)) return;
    if (req.method === "GET" && url.pathname === "/download") return void await streamFile(req, res, url, true);
    if (req.method === "GET" && url.pathname === "/file") return void await streamFile(req, res, url, false);
    if (req.method === "GET" && url.pathname === "/download-batch") return void await streamBatchDownload(res, url);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return void await serveStaticFile(res, path.join(STATIC_DIR, "index.html"));
    if (req.method === "GET" && url.pathname === "/app.js") return void await serveStaticFile(res, path.join(STATIC_DIR, "app.js"));
    if (req.method === "GET" && url.pathname === "/styles.css") return void await serveStaticFile(res, path.join(STATIC_DIR, "styles.css"));
    sendText(res, 404, "Not Found");
  } catch (error) {
    sendJson(res, 500, { error: error.message || "服务器错误" });
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
  await restoreLogBuffer();
  await cleanupExpiredRecycleEntries();
  setInterval(() => {
    cleanupExpiredRecycleEntries().catch((error) => {
      console.error(`回收站巡检失败: ${error.message}`);
    });
  }, RECYCLE_CLEANUP_INTERVAL_MS);
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
