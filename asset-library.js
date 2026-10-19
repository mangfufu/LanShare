const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { DatabaseSync } = require("node:sqlite");
const Busboy = require("busboy");
const sharp = require("sharp");
const archiver = require("archiver");

const CATEGORIES = ["角色", "场景", "道具", "群演", "特效", "音频"];
const PRESET_TAGS_BY_CATEGORY = {
  "角色": ["主角", "配角", "男性", "女性", "青年", "老年", "古风", "现代", "写实", "卡通"],
  "场景": ["室内", "室外", "城市", "自然", "白天", "夜晚", "古风", "现代", "写实", "卡通"],
  "道具": ["武器", "服饰", "饰品", "载具", "日用品", "古风", "现代", "写实", "卡通"],
  "群演": ["男性", "女性", "青年", "老年", "士兵", "百姓", "古风", "现代"],
  "特效": ["火焰", "烟雾", "水流", "雷电", "光效", "爆炸", "粒子"],
  "音频": ["男声", "女声", "老年", "低沉", "磁性", "温柔", "旁白", "对白", "音乐", "音效"],
};
const PRESET_TAGS = [...new Set(Object.values(PRESET_TAGS_BY_CATEGORY).flat())];
const TYPES = {
  ".png": ["image", "image/png"],
  ".jpg": ["image", "image/jpeg"],
  ".jpeg": ["image", "image/jpeg"],
  ".webp": ["image", "image/webp"],
  ".gif": ["image", "image/gif"],
  ".avif": ["image", "image/avif"],
  ".tif": ["image", "image/tiff"],
  ".tiff": ["image", "image/tiff"],
  ".mp4": ["video", "video/mp4"],
  ".webm": ["video", "video/webm"],
  ".mov": ["video", "video/quicktime"],
  ".mp3": ["audio", "audio/mpeg"],
  ".wav": ["audio", "audio/wav"],
  ".ogg": ["audio", "audio/ogg"],
  ".m4a": ["audio", "audio/mp4"],
  ".flac": ["audio", "audio/flac"],
  ".aac": ["audio", "audio/aac"],
};
function fail(message, statusCode = 400, extra = {}) {
  throw Object.assign(new Error(message), { statusCode, ...extra });
}
function text(value, max = 160, required = false) {
  if (value != null && typeof value !== "string") fail("文字字段格式错误");
  const result = (value || "").trim();
  if (result.length > max || (required && !result))
    fail(required ? "请填写有效的名称或分类" : "文字过长");
  return result;
}
function filename(value) {
  const result = path
    .basename(String(value).replaceAll("\\", "/"))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 160);
  return !result || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(result)
    ? `素材_${result}`
    : result;
}

module.exports = function createAssetLibrary(h) {
  const root = path.resolve(
    process.env.ASSET_LIBRARY_DIR || path.join(__dirname, "asset_library"),
  );
  const objects = path.join(root, "objects");
  const thumbs = path.join(root, "thumbs");
  let db;
  let tail = Promise.resolve();
  let thumbTail = Promise.resolve();
  let cleanupTimer;
  const thumbnailJobs = new Map();
  const scope = (req) => (req._nsfwMode ? 1 : 0);
  const editor = (req) => h.hasPermission(req.authUser, "files.write");
  const disk = (file) => path.join(objects, file.id + file.ext);
  const write = (fn) => {
    const job = tail.then(fn);
    tail = job.catch(() => {});
    return job;
  };
  function init() {
    if (db) return;
    fs.mkdirSync(objects, { recursive: true });
    fs.mkdirSync(thumbs, { recursive: true });
    db = new DatabaseSync(path.join(root, "library.db"));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, project TEXT NOT NULL,
        tags TEXT NOT NULL, cover_id TEXT, scope INTEGER NOT NULL, discarded INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS states (
        id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        name TEXT NOT NULL, prompt TEXT NOT NULL, discarded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,
        state_id TEXT REFERENCES states(id) ON DELETE CASCADE, name TEXT NOT NULL, ext TEXT NOT NULL,
        kind TEXT NOT NULL, size INTEGER NOT NULL, sha TEXT NOT NULL, scope INTEGER NOT NULL,
        owner_id INTEGER NOT NULL, discarded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tags (name TEXT NOT NULL, scope INTEGER NOT NULL, PRIMARY KEY(name,scope));
      CREATE TABLE IF NOT EXISTS tag_categories (name TEXT NOT NULL, scope INTEGER NOT NULL, category TEXT NOT NULL, PRIMARY KEY(name,scope,category));
      INSERT OR IGNORE INTO tag_categories(name,scope,category)
        SELECT j.value,a.scope,a.category FROM assets a,json_each(a.tags) j;
      CREATE TABLE IF NOT EXISTS pending_deletes (id TEXT PRIMARY KEY, ext TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS files_hash ON files(scope,sha);
      CREATE INDEX IF NOT EXISTS files_asset ON files(asset_id,state_id);
      CREATE INDEX IF NOT EXISTS states_asset ON states(asset_id);
      CREATE INDEX IF NOT EXISTS assets_scope ON assets(scope,updated_at);`);
    repairLegacyFilenames();
    cleanupTimer = setInterval(
      () => write(cleanup).catch(console.error),
      3600000,
    );
    cleanupTimer.unref();
    write(cleanup).catch(console.error);
  }
  function repairLegacyFilenames() {
    if (db.prepare("PRAGMA user_version").get().user_version >= 1) return;
    transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS filename_repairs (
        file_id TEXT PRIMARY KEY, original_name TEXT NOT NULL, repaired_name TEXT NOT NULL,
        original_asset_name TEXT, repaired_at INTEGER NOT NULL)`);
      const affectedAssets = new Set();
      for (const file of db
        .prepare("SELECT id,name,asset_id FROM files")
        .all()) {
        // v4.1.0 interpreted browser UTF-8 filename bytes as Latin-1. Only repair
        // fully reversible conversions, retaining the original metadata for recovery.
        if (/[^\u0000-\u00ff]/u.test(file.name)) continue;
        let decoded;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.from(file.name, "latin1"),
          );
        } catch {
          continue;
        }
        if (
          decoded === file.name ||
          !Buffer.from(decoded, "utf8").equals(Buffer.from(file.name, "latin1"))
        )
          continue;
        const repaired = filename(decoded);
        const a = file.asset_id
          ? db.prepare("SELECT name FROM assets WHERE id=?").get(file.asset_id)
          : null;
        db.prepare(
          "INSERT INTO filename_repairs(file_id,original_name,repaired_name,original_asset_name,repaired_at) VALUES(?,?,?,?,?)",
        ).run(file.id, file.name, repaired, a?.name || null, Date.now());
        db.prepare("UPDATE files SET name=? WHERE id=?").run(repaired, file.id);
        if (a?.name === path.parse(file.name).name) {
          db.prepare("UPDATE assets SET name=? WHERE id=?").run(
            path.parse(repaired).name,
            file.asset_id,
          );
        }
        if (file.asset_id) affectedAssets.add(file.asset_id);
      }
      for (const id of affectedAssets)
        db.prepare("UPDATE assets SET revision=revision+1 WHERE id=?").run(id);
      db.exec("PRAGMA user_version=1");
    });
  }
  async function cleanup() {
    // Only expired uncommitted uploads and explicitly deleted files are collected.
    const stale = db
      .prepare("SELECT * FROM files WHERE asset_id IS NULL AND created_at < ?")
      .all(Date.now() - 86400000);
    transaction(() => {
      for (const f of stale) {
        db.prepare(
          "INSERT OR IGNORE INTO pending_deletes(id,ext) VALUES(?,?)",
        ).run(f.id, f.ext);
        db.prepare("DELETE FROM files WHERE id=? AND asset_id IS NULL").run(
          f.id,
        );
      }
    });
    await drainDeleted();
  }
  async function drainDeleted() {
    for (const f of db.prepare("SELECT * FROM pending_deletes").all()) {
      try {
        // A thumbnail may still be rendering when an administrator deletes its source.
        await thumbnailJobs.get(f.id)?.catch(() => {});
        await fsp.rm(disk(f), { force: true });
        await fsp.rm(path.join(thumbs, f.id + ".webp"), { force: true });
        db.prepare("DELETE FROM pending_deletes WHERE id=?").run(f.id);
      } catch (error) {
        console.error("资产文件清理待重试:", f.id, error.code);
      }
    }
  }
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function asset(req, id) {
    const row = db
      .prepare("SELECT * FROM assets WHERE id=? AND scope=?")
      .get(String(id || ""), scope(req));
    if (!row || (row.discarded && !editor(req)))
      fail("资产不存在或已弃用", 404);
    return row;
  }
  function visibleFiles(req, a, includeDiscarded = false) {
    return db
      .prepare(
        `SELECT f.*, s.name AS state_name, s.discarded AS state_discarded
      FROM files f JOIN states s ON s.id=f.state_id WHERE f.asset_id=? ORDER BY f.created_at,f.id`,
      )
      .all(a.id)
      .filter(
        (f) =>
          (includeDiscarded && editor(req)) ||
          (!a.discarded && !f.discarded && !f.state_discarded),
      );
  }
  function publicFile(f) {
    return {
      id: f.id,
      name: f.name,
      kind: f.kind,
      size: f.size,
      discarded: !!f.discarded,
      stateId: f.state_id,
    };
  }
  function detail(req, a) {
    const files = visibleFiles(req, a, true);
    const states = db
      .prepare("SELECT * FROM states WHERE asset_id=? ORDER BY created_at,id")
      .all(a.id)
      .filter((s) => editor(req) || !s.discarded)
      .map((s) => ({
        id: s.id,
        name: s.name,
        prompt: s.prompt,
        discarded: !!s.discarded,
        files: files.filter((f) => f.state_id === s.id).map(publicFile),
      }));
    return { ...summary(req, a), states, revision: a.revision };
  }
  function summary(req, a) {
    const files = visibleFiles(req, a, !!a.discarded);
    const cover =
      files.find((f) => f.id === a.cover_id) ||
      files.find((f) => f.kind === "image") ||
      files[0];
    const hasDiscarded = !!db
      .prepare(
        `SELECT 1 FROM states WHERE asset_id=? AND discarded=1
      UNION ALL SELECT 1 FROM files WHERE asset_id=? AND discarded=1 LIMIT 1`,
      )
      .get(a.id, a.id);
    return {
      id: a.id,
      name: a.name,
      category: a.category,
      project: a.project,
      tags: JSON.parse(a.tags),
      discarded: !!a.discarded,
      hasDiscarded,
      cover: cover ? publicFile(cover) : null,
      fileCount: files.length,
      updatedAt: a.updated_at,
      updatedBy: a.updated_by,
    };
  }
  function duplicates(req, hashes) {
    const rows = [];
    for (const sha of new Set(hashes)) {
      rows.push(
        ...db
          .prepare(
            `SELECT DISTINCT a.id,a.name,a.discarded FROM files f JOIN assets a ON a.id=f.asset_id
        WHERE f.sha=? AND a.scope=?`,
          )
          .all(sha, scope(req)),
      );
    }
    return [...new Map(rows.map((a) => [a.id, a])).values()];
  }
  async function json(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) fail("请求过大", 413);
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      fail("JSON 格式错误");
    }
  }
  async function checkedPath(base, relative, allowMissing = false) {
    if (
      typeof relative !== "string" ||
      relative.includes("\0") ||
      path.isAbsolute(relative)
    )
      fail("路径无效");
    const parts = relative.replaceAll("\\", "/").split("/").filter(Boolean);
    if (parts.some((p) => p === ".." || p.includes(":"))) fail("路径越界");
    const realBase = await fsp.realpath(base);
    let current = realBase;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        if ((await fsp.lstat(current)).isSymbolicLink())
          fail("不能通过链接访问资产文件");
      } catch (error) {
        if (!(allowMissing && error.code === "ENOENT")) throw error;
      }
    }
    return current;
  }
  async function stageFile(req, name, source) {
    const clean = filename(name);
    const ext = path.extname(clean).toLowerCase();
    const type = TYPES[ext];
    if (!type) {
      source.resume();
      fail("不支持的文件类型，请使用图片、视频或音频");
    }
    const f = {
      id: crypto.randomUUID(),
      name: clean,
      ext,
      kind: type[0],
      size: 0,
      sha: "",
      scope: scope(req),
    };
    const hash = crypto.createHash("sha256");
    source.on("data", (chunk) => {
      f.size += chunk.length;
      hash.update(chunk);
      if (f.size > h.maxFileSize) source.destroy(new Error("文件超过大小限制"));
    });
    try {
      await pipeline(source, fs.createWriteStream(disk(f), { flags: "wx" }));
      if (source.truncated) fail("文件超过大小限制", 413);
      if (!f.size) fail("不能存入空文件");
      if (f.kind === "image")
        await sharp(disk(f), { limitInputPixels: 100000000 }).metadata();
      f.sha = hash.digest("hex");
      db.prepare(
        `INSERT INTO files(id,name,ext,kind,size,sha,scope,owner_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        f.id,
        f.name,
        f.ext,
        f.kind,
        f.size,
        f.sha,
        scope(req),
        req.authUser.id,
        Date.now(),
      );
      return f;
    } catch (error) {
      await fsp.rm(disk(f), { force: true });
      throw error;
    }
  }
  async function removeStaged(files) {
    for (const f of files) {
      const row = db
        .prepare("SELECT * FROM files WHERE id=? AND asset_id IS NULL")
        .get(f.id);
      if (row) {
        await thumbnailJobs.get(row.id)?.catch(() => {});
        await fsp.rm(disk(row), { force: true });
        await fsp.rm(path.join(thumbs, row.id + ".webp"), { force: true });
        db.prepare("DELETE FROM files WHERE id=?").run(row.id);
      }
    }
  }
  async function upload(req) {
    const bb = Busboy({
      headers: req.headers,
      defParamCharset: "utf8",
      limits: { files: 64, fileSize: h.maxFileSize, fields: 0 },
    });
    const jobs = [];
    let uploadError;
    bb.on("file", (_name, stream, info) => {
      const job = stageFile(req, info.filename, stream).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      jobs.push(job);
    });
    bb.on("filesLimit", () => {
      uploadError = new Error("一次最多上传 64 个文件");
    });
    bb.on("fieldsLimit", () => {
      uploadError = new Error("上传格式无效");
    });
    try {
      await pipeline(req, bb);
    } catch (error) {
      uploadError = error;
    }
    const results = await Promise.all(jobs);
    const files = results.filter((r) => r.value).map((r) => r.value);
    uploadError ||= results.find((r) => r.error)?.error;
    if (uploadError || !files.length) {
      await removeStaged(files);
      throw uploadError || new Error("请选择文件");
    }
    return {
      files: files.map(publicFile),
      duplicates: duplicates(
        req,
        files.map((f) => f.sha),
      ),
    };
  }
  async function importFiles(req, body) {
    if (
      !Array.isArray(body.paths) ||
      !body.paths.length ||
      body.paths.length > 64
    )
      fail("请选择 1 至 64 个文件");
    const sourceRoot = h.sourceRoot(req);
    const sources = [];
    for (const relative of body.paths) {
      const source = await checkedPath(sourceRoot, relative);
      const stat = await fsp.stat(source);
      if (!stat.isFile() || stat.size > h.maxFileSize)
        fail("来源不是文件或超过大小限制");
      sources.push({ source, stat });
    }
    const files = [];
    try {
      for (const { source, stat } of sources) {
        files.push(
          await stageFile(
            req,
            path.basename(source),
            fs.createReadStream(source),
          ),
        );
        const after = await fsp.stat(source);
        if (
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ino !== stat.ino
        )
          fail("来源文件正在修改，请稍后重试", 409);
      }
      return {
        files: files.map(publicFile),
        duplicates: duplicates(
          req,
          files.map((f) => f.sha),
        ),
      };
    } catch (error) {
      await removeStaged(files);
      throw error;
    }
  }
  function metadata(body) {
    const name = text(body.name, 160, true),
      category = text(body.category, 16, true);
    if (!CATEGORIES.includes(category)) fail("分类无效");
    if (!Array.isArray(body.tags) || body.tags.length > 30)
      fail("标签格式错误，最多 30 个");
    const tags = [...new Set(body.tags.map((t) => text(t, 40, true)))];
    return { name, category, project: text(body.project, 160), tags };
  }
  function rememberTags(req, tags, category) {
    for (const tag of tags) {
      db.prepare("INSERT OR IGNORE INTO tags(name,scope) VALUES(?,?)").run(
        tag,
        scope(req),
      );
      db.prepare("INSERT OR IGNORE INTO tag_categories(name,scope,category) VALUES(?,?,?)")
        .run(tag, scope(req), category);
    }
  }
  function touch(req, id) {
    db.prepare(
      "UPDATE assets SET updated_at=?,updated_by=?,revision=revision+1 WHERE id=?",
    ).run(Date.now(), req.authUser.name, id);
  }
  function commit(req, body) {
    if (
      !Array.isArray(body.files) ||
      !body.files.length ||
      body.files.length > 64 ||
      new Set(body.files).size !== body.files.length
    )
      fail("请选择文件");
    const files = body.files.map((id) =>
      db
        .prepare(
          "SELECT * FROM files WHERE id=? AND asset_id IS NULL AND owner_id=? AND scope=?",
        )
        .get(String(id), req.authUser.id, scope(req)),
    );
    if (files.some((f) => !f)) fail("上传已失效或已入库，请重新选择文件", 409);
    const repeats = duplicates(
      req,
      files.map((f) => f.sha),
    );
    if (repeats.length && body.allowDuplicates !== true)
      fail("发现重复素材", 409, { duplicates: repeats });
    const existing = body.assetId ? asset(req, body.assetId) : null;
    if (existing?.discarded) fail("请先恢复该资产");
    const meta = existing || metadata(body);
    if (files.some((f) => (f.kind === "audio") !== (meta.category === "音频")))
      fail("音频必须使用音频分类，其他分类仅接收图片或视频");
    if (existing?.category === "音频")
      fail("一条音频资产只能有一个文件，请新建音频资产");
    if (meta.category === "音频" && files.length > 1 && body.merge === true)
      fail("每条音频资产只能有一个文件");
    let existingState;
    if (existing && body.stateId) {
      existingState = db
        .prepare(
          "SELECT * FROM states WHERE id=? AND asset_id=? AND discarded=0",
        )
        .get(body.stateId, existing.id);
      if (!existingState) fail("状态不存在或已弃用");
    }
    const stateName =
      meta.category === "音频" ? "音频" : text(body.stateName, 100) || "默认";
    const prompt = text(body.prompt, 20000);
    const ids = [];
    const stateIds = [];
    transaction(() => {
      const groups =
        existing || body.merge === true ? [files] : files.map((f) => [f]);
      for (const group of groups) {
        const id = existing?.id || crypto.randomUUID();
        if (!existing) {
          const name =
            groups.length > 1 ? path.parse(group[0].name).name : meta.name;
          db.prepare(
            `INSERT INTO assets(id,name,category,project,tags,scope,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?)`,
          ).run(
            id,
            name,
            meta.category,
            meta.project,
            JSON.stringify(meta.tags),
            scope(req),
            Date.now(),
            Date.now(),
            req.authUser.name,
          );
          rememberTags(req, meta.tags, meta.category);
        }
        const stateId = existingState?.id || crypto.randomUUID();
        if (!existingState)
          db.prepare(
            "INSERT INTO states(id,asset_id,name,prompt,created_at) VALUES(?,?,?,?,?)",
          ).run(stateId, id, stateName, prompt, Date.now());
        for (const file of group)
          db.prepare("UPDATE files SET asset_id=?,state_id=? WHERE id=?").run(
            id,
            stateId,
            file.id,
          );
        touch(req, id);
        ids.push(id);
        stateIds.push(stateId);
      }
    });
    return { ids, stateIds };
  }
  function edit(req, body) {
    const a = asset(req, body.id);
    if (Number(body.revision) !== a.revision)
      fail("资产已被其他人修改，请重新打开后编辑", 409);
    const meta = metadata(body);
    const files = db.prepare("SELECT * FROM files WHERE asset_id=?").all(a.id);
    if (files.some((f) => (f.kind === "audio") !== (meta.category === "音频")))
      fail("不能把音频与图片分类互换");
    transaction(() => {
      db.prepare(
        "UPDATE assets SET name=?,category=?,project=?,tags=? WHERE id=?",
      ).run(
        meta.name,
        meta.category,
        meta.project,
        JSON.stringify(meta.tags),
        a.id,
      );
      rememberTags(req, meta.tags, meta.category);
      touch(req, a.id);
    });
    return { ok: true };
  }
  function createState(req, body) {
    const a = asset(req, body.id);
    if (Number(body.revision) !== a.revision)
      fail("资产已更新，请重新打开", 409);
    if (a.discarded) fail("请先恢复该资产");
    if (a.category === "音频") fail("音频资产不支持添加状态");
    const name = text(body.name, 100, true);
    const prompt = text(body.prompt, 20000);
    if (db.prepare("SELECT id FROM states WHERE asset_id=? AND name=? AND discarded=0").get(a.id, name))
      fail("已有同名状态，请使用其他名称", 409);
    const id = crypto.randomUUID();
    transaction(() => {
      db.prepare("INSERT INTO states(id,asset_id,name,prompt,created_at) VALUES(?,?,?,?,?)")
        .run(id, a.id, name, prompt, Date.now());
      touch(req, a.id);
    });
    return { id };
  }
  function addTags(req, body) {
    const a = asset(req, body.id);
    if (!Array.isArray(body.tags) || !body.tags.length || body.tags.length > 30)
      fail("请选择或输入标签，最多 30 个");
    const current = JSON.parse(a.tags);
    const tags = [...new Set([...current, ...body.tags.map((tag) => text(tag, 40, true))])];
    if (tags.length > 30) fail("每条资产最多 30 个标签");
    if (tags.length !== current.length) transaction(() => {
      db.prepare("UPDATE assets SET tags=? WHERE id=?").run(JSON.stringify(tags), a.id);
      rememberTags(req, tags, a.category);
      touch(req, a.id);
    });
    return { tags };
  }
  function moveFiles(req, body) {
    const { a, rows } = fileSelection(req, body);
    if (Number(body.revision) !== a.revision)
      fail("资产已更新，请重新打开", 409);
    if (a.discarded) fail("请先恢复该资产");
    if (a.category === "音频") fail("音频资产不支持移动状态");
    const destination = db.prepare("SELECT * FROM states WHERE id=? AND asset_id=? AND discarded=0")
      .get(String(body.stateId || ""), a.id);
    if (!destination) fail("目标状态不存在或已弃用", 404);
    const available = new Set(visibleFiles(req, a).map((f) => f.id));
    if (rows.some((f) => !available.has(f.id))) fail("请先恢复弃用素材");
    if (rows.some((f) => f.state_id === destination.id)) fail("所选文件已在目标状态中");
    transaction(() => {
      const update = db.prepare("UPDATE files SET state_id=? WHERE id=?");
      for (const row of rows) update.run(destination.id, row.id);
      touch(req, a.id);
    });
    return { ok: true, count: rows.length };
  }
  function target(req, body) {
    if (!["asset", "state", "file"].includes(body.kind)) fail("对象类型无效");
    const table = { asset: "assets", state: "states", file: "files" }[
      body.kind
    ];
    const row = db
      .prepare(`SELECT * FROM ${table} WHERE id=?`)
      .get(String(body.id || ""));
    if (!row || (body.kind === "file" && !row.asset_id))
      fail("对象不存在", 404);
    const a = asset(req, body.kind === "asset" ? row.id : row.asset_id);
    return { table, row, a };
  }
  function lifecycle(req, body) {
    if (body.kind === "assets") {
      const assets = assetSelection(req, body);
      if (typeof body.discarded !== "boolean") fail("弃用状态无效");
      const changedIds = assets
        .filter((a) => !!a.discarded !== body.discarded)
        .map((a) => a.id);
      transaction(() => {
        for (const a of assets) {
          db.prepare("UPDATE assets SET discarded=? WHERE id=?").run(
            body.discarded ? 1 : 0,
            a.id,
          );
          if (!body.discarded && body.restoreContents === true) {
            db.prepare("UPDATE states SET discarded=0 WHERE asset_id=?").run(
              a.id,
            );
            db.prepare("UPDATE files SET discarded=0 WHERE asset_id=?").run(
              a.id,
            );
          }
          touch(req, a.id);
        }
      });
      return { ok: true, changedIds };
    }
    if (body.kind === "files") {
      const { a, rows } = fileSelection(req, body);
      if (typeof body.discarded !== "boolean") fail("弃用状态无效");
      if (
        a.discarded ||
        rows.some(
          (f) =>
            db
              .prepare("SELECT discarded FROM states WHERE id=?")
              .get(f.state_id)?.discarded,
        )
      )
        fail("请先恢复所属资产或状态");
      transaction(() => {
        for (const row of rows)
          db.prepare("UPDATE files SET discarded=? WHERE id=?").run(
            body.discarded ? 1 : 0,
            row.id,
          );
        touch(req, a.id);
      });
      return { ok: true };
    }
    const { table, row, a } = target(req, body);
    if (typeof body.discarded !== "boolean") fail("弃用状态无效");
    transaction(() => {
      db.prepare(`UPDATE ${table} SET discarded=? WHERE id=?`).run(
        body.discarded ? 1 : 0,
        row.id,
      );
      touch(req, a.id);
    });
    return { ok: true };
  }
  async function erase(req, body) {
    h.requirePermission(req, "*");
    if (body.kind === "assets") {
      const assets = assetSelection(req, body);
      const plans = assets.map((a) => {
        const states = db
          .prepare("SELECT * FROM states WHERE asset_id=? AND discarded=1")
          .all(a.id);
        const files = db
          .prepare("SELECT * FROM files WHERE asset_id=?")
          .all(a.id)
          .filter(
            (f) =>
              a.discarded ||
              f.discarded ||
              states.some((s) => s.id === f.state_id),
          );
        if (!a.discarded && !states.length && !files.length)
          fail("所选资产已没有弃用内容，请刷新后重试", 409);
        return { a, states, files };
      });
      transaction(() => {
        for (const { a, states, files } of plans) {
          for (const f of files)
            db.prepare(
              "INSERT OR IGNORE INTO pending_deletes(id,ext) VALUES(?,?)",
            ).run(f.id, f.ext);
          if (a.discarded)
            db.prepare("DELETE FROM assets WHERE id=?").run(a.id);
          else {
            for (const f of files)
              db.prepare("DELETE FROM files WHERE id=?").run(f.id);
            for (const s of states)
              db.prepare("DELETE FROM states WHERE id=?").run(s.id);
            touch(req, a.id);
          }
        }
      });
      await drainDeleted();
      return {
        ok: true,
        pendingCleanup: plans.some((p) =>
          p.files.some(
            (f) =>
              !!db
                .prepare("SELECT 1 FROM pending_deletes WHERE id=?")
                .get(f.id),
          ),
        ),
      };
    }
    if (body.kind === "files") {
      const { a, rows } = fileSelection(req, body);
      if (
        rows.some(
          (row) =>
            !row.discarded &&
            !a.discarded &&
            !db
              .prepare("SELECT discarded FROM states WHERE id=?")
              .get(row.state_id)?.discarded,
        )
      )
        fail("请先弃用，再彻底删除");
      transaction(() => {
        for (const row of rows) {
          db.prepare(
            "INSERT OR IGNORE INTO pending_deletes(id,ext) VALUES(?,?)",
          ).run(row.id, row.ext);
          db.prepare("DELETE FROM files WHERE id=?").run(row.id);
        }
        touch(req, a.id);
      });
      await drainDeleted();
      return {
        ok: true,
        pendingCleanup: rows.some(
          (f) =>
            !!db.prepare("SELECT 1 FROM pending_deletes WHERE id=?").get(f.id),
        ),
      };
    }
    const { table, row, a } = target(req, body);
    if (
      !row.discarded &&
      !a.discarded &&
      !(
        row.state_id &&
        db.prepare("SELECT discarded FROM states WHERE id=?").get(row.state_id)
          ?.discarded
      )
    )
      fail("请先弃用，再彻底删除");
    const files =
      body.kind === "file"
        ? [row]
        : db
            .prepare(
              `SELECT * FROM files WHERE ${body.kind === "asset" ? "asset_id" : "state_id"}=?`,
            )
            .all(row.id);
    transaction(() => {
      for (const f of files)
        db.prepare(
          "INSERT OR IGNORE INTO pending_deletes(id,ext) VALUES(?,?)",
        ).run(f.id, f.ext);
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
      if (body.kind !== "asset") touch(req, a.id);
    });
    await drainDeleted();
    return {
      ok: true,
      pendingCleanup: files.some(
        (f) =>
          !!db.prepare("SELECT 1 FROM pending_deletes WHERE id=?").get(f.id),
      ),
    };
  }
  function assetSelection(req, body) {
    if (
      !Array.isArray(body.ids) ||
      !body.ids.length ||
      body.ids.length > 1000 ||
      body.ids.some((id) => typeof id !== "string")
    )
      fail("请选择 1 至 1000 条资产");
    return [...new Set(body.ids)].map((id) => asset(req, id));
  }
  function fileSelection(req, body) {
    if (
      !Array.isArray(body.ids) ||
      !body.ids.length ||
      body.ids.length > 64 ||
      body.ids.some((id) => typeof id !== "string")
    )
      fail("请选择 1 至 64 个文件");
    const a = asset(req, body.id);
    const rows = [...new Set(body.ids)].map((id) =>
      db
        .prepare("SELECT * FROM files WHERE id=? AND asset_id=? AND scope=?")
        .get(id, a.id, scope(req)),
    );
    if (rows.some((row) => !row)) fail("所选文件不存在或不属于此资产", 404);
    return { a, rows };
  }
  function selected(req, body) {
    const selection = body.kind === "files" ? fileSelection(req, body) : null;
    const { row, a } = selection
      ? { row: selection.a, a: selection.a }
      : target(req, body);
    if (a.discarded || row.discarded) fail("请先恢复弃用素材");
    const files = visibleFiles(req, a).filter(
      (f) =>
        body.kind === "asset" ||
        (selection
          ? body.ids.includes(f.id)
          : body.kind === "state"
            ? f.state_id === row.id
            : f.id === row.id),
    );
    if (selection && files.length !== selection.rows.length)
      fail("请先恢复所选的弃用素材");
    if (!files.length) fail("没有可用文件");
    const used = new Set();
    return {
      a,
      entries: files.map((f) => {
        const folder =
          body.kind === "asset" && a.category !== "音频"
            ? `${filename(f.state_name)}_${f.state_id.slice(0, 8)}/`
            : "";
        let name = folder + f.name;
        if (used.has(name.toLowerCase()))
          name =
            folder + path.parse(f.name).name + "_" + f.id.slice(0, 8) + f.ext;
        used.add(name.toLowerCase());
        return { f, name };
      }),
    };
  }
  async function copy(req, body) {
    const { entries } = selected(req, body);
    const base = h.sourceRoot(req);
    const destination = await checkedPath(base, text(body.destination, 3000));
    if (!(await fsp.stat(destination)).isDirectory()) fail("请选择目标目录");
    const plans = [];
    for (const entry of entries) {
      const dest = await checkedPath(
        base,
        path.relative(base, path.join(destination, entry.name)),
        true,
      );
      let stat;
      try {
        stat = await fsp.stat(dest);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (stat && !stat.isFile()) fail(`目标存在同名目录：${entry.name}`, 409);
      plans.push({ ...entry, dest, stat });
    }
    const conflicts = plans.filter((p) => p.stat).map((p) => p.name);
    if (conflicts.length && body.overwrite !== true)
      fail("目标目录存在同名文件", 409, { conflicts });
    const completed = [],
      madeDirs = [];
    try {
      for (const p of plans) {
        const parent = path.dirname(p.dest);
        if (!fs.existsSync(parent)) {
          await fsp.mkdir(parent);
          madeDirs.push(parent);
        }
        await checkedPath(base, path.relative(base, p.dest), true);
        p.temp = path.join(parent, `.asset-copy-${crypto.randomUUID()}.tmp`);
        completed.push(p);
        await fsp.copyFile(disk(p.f), p.temp, fs.constants.COPYFILE_EXCL);
        if (p.stat) {
          const now = await fsp.stat(p.dest);
          if (
            now.size !== p.stat.size ||
            now.mtimeMs !== p.stat.mtimeMs ||
            now.ino !== p.stat.ino
          )
            fail("目标文件已改变，请重新确认", 409);
          p.backup = path.join(
            parent,
            `.asset-previous-${crypto.randomUUID()}.tmp`,
          );
          await fsp.rename(p.dest, p.backup);
        }
        await fsp.copyFile(p.temp, p.dest, fs.constants.COPYFILE_EXCL);
        p.done = true;
      }
    } catch (error) {
      for (const p of completed.reverse()) {
        if (p.done) await fsp.rm(p.dest, { force: true });
        if (p.backup && fs.existsSync(p.backup))
          await fsp.rename(p.backup, p.dest);
      }
      for (const dir of madeDirs.reverse())
        await fsp.rmdir(dir).catch(() => {});
      throw error;
    } finally {
      for (const p of completed)
        if (p.temp) await fsp.rm(p.temp, { force: true });
    }
    for (const p of plans)
      if (p.backup) await fsp.rm(p.backup, { force: true });
    h.invalidate(text(body.destination, 3000), !!scope(req));
    return { ok: true, count: entries.length };
  }
  async function media(req, res, url) {
    const staged = [
      "/api/assets/staged-media",
      "/api/assets/staged-thumb",
    ].includes(url.pathname);
    if (staged) h.requirePermission(req, "files.write");
    const f = db
      .prepare(
        `SELECT * FROM files WHERE id=? AND scope=? AND asset_id IS ${staged ? "NULL" : "NOT NULL"}`,
      )
      .get(url.searchParams.get("id"), scope(req));
    if (!f || (staged && f.owner_id !== req.authUser.id))
      fail("文件不存在", 404);
    const a = staged ? null : asset(req, f.asset_id);
    const state = staged
      ? null
      : db.prepare("SELECT * FROM states WHERE id=?").get(f.state_id);
    const discarded = a?.discarded || state?.discarded || f.discarded;
    if (discarded && !editor(req)) fail("文件已弃用", 404);
    const download = url.pathname.endsWith("/download-file");
    if (download) {
      h.requirePermission(req, "files.download");
      if (discarded) fail("请先恢复素材");
    } else h.requirePermission(req, "files.preview");
    let source = disk(f),
      mime = TYPES[f.ext][1];
    if (
      url.pathname.endsWith("/thumb") ||
      url.pathname.endsWith("/staged-thumb")
    ) {
      if (f.kind !== "image") fail("该文件没有图片缩略图", 404);
      source = path.join(thumbs, f.id + ".webp");
      mime = "image/webp";
      if (!fs.existsSync(source)) {
        if (!thumbnailJobs.has(f.id)) {
          const job = thumbTail
            .catch(() => {})
            .then(() =>
              sharp(disk(f), { limitInputPixels: 100000000 })
                .rotate()
                .resize(560, 420, { fit: "inside", withoutEnlargement: true })
                .webp({ quality: 80 })
                .toFile(source),
            );
          thumbTail = job;
          thumbnailJobs.set(f.id, job);
          job.finally(() => thumbnailJobs.delete(f.id)).catch(() => {});
        }
        await thumbnailJobs.get(f.id);
      }
    }
    const size = (await fsp.stat(source)).size;
    let start = 0,
      end = size - 1,
      status = 200;
    if (req.headers.range && !download) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), end) : end;
      }
      if (start > end || start >= size || !Number.isSafeInteger(start)) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      status = 206;
    }
    res.writeHead(status, {
      "Content-Type": mime,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      ...(status === 206
        ? { "Content-Range": `bytes ${start}-${end}/${size}` }
        : {}),
    });
    await pipeline(fs.createReadStream(source, { start, end }), res);
  }
  async function download(req, res, url) {
    h.requirePermission(req, "files.download");
    const { a, entries } = selected(req, {
      kind: url.searchParams.get("kind"),
      id: url.searchParams.get("id"),
      ids: url.searchParams.getAll("file"),
    });
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename(a.name) + ".zip")}`,
      "Cache-Control": "private, no-store",
    });
    const archive = archiver("zip", { store: true, forceZip64: true });
    res.on("close", () => archive.abort());
    archive.on("warning", (error) => archive.destroy(error));
    const transfer = pipeline(archive, res);
    for (const entry of entries)
      archive.file(disk(entry.f), { name: entry.name });
    await Promise.all([archive.finalize(), transfer]);
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/assets/")) return false;
    init();
    res.setHeader("Cache-Control", "private, no-store");
    try {
      if (req.method === "POST") {
        h.requirePermission(req, "files.write");
        h.assertWrite(req);
      } else if (req.method !== "GET") fail("不支持的请求方法", 405);
      const route = url.pathname.slice("/api/assets/".length);
      let result;
      if (req.method === "GET") {
        if (
          [
            "media",
            "thumb",
            "download-file",
            "staged-media",
            "staged-thumb",
          ].includes(route)
        ) {
          await media(req, res, url);
          return true;
        }
        if (route === "download") {
          await download(req, res, url);
          return true;
        }
        if (route === "meta")
          result = {
            categories: CATEGORIES,
            presetTags: PRESET_TAGS,
            presetTagsByCategory: PRESET_TAGS_BY_CATEGORY,
            tagsByCategory: Object.fromEntries(CATEGORIES.map((category) => [category,
              db.prepare("SELECT name FROM tag_categories WHERE scope=? AND category=? ORDER BY name")
                .all(scope(req), category).map((t) => t.name),
            ])),
            tags: db
              .prepare("SELECT name FROM tags WHERE scope=? ORDER BY name")
              .all(scope(req))
              .map((t) => t.name),
          };
        else if (route === "detail")
          result = detail(req, asset(req, url.searchParams.get("id")));
        else if (route === "list") {
          const discarded = url.searchParams.get("discarded") === "1";
          if (discarded) h.requirePermission(req, "files.write");
          const q = text(url.searchParams.get("q"), 160).toLowerCase();
          const category = url.searchParams.get("category");
          const tag = url.searchParams.get("tag");
          const conditions = ["a.scope=?"];
          const values = [scope(req)];
          if (category) {
            conditions.push("a.category=?");
            values.push(category);
          }
          if (tag) {
            conditions.push(
              "EXISTS (SELECT 1 FROM json_each(a.tags) WHERE value=?)",
            );
            values.push(tag);
          }
          if (q) {
            conditions.push(
              "(instr(lower(a.name),?)>0 OR instr(lower(a.project),?)>0 OR EXISTS (SELECT 1 FROM json_each(a.tags) WHERE instr(lower(value),?)>0))",
            );
            values.push(q, q, q);
          }
          conditions.push(
            discarded
              ? `(a.discarded=1 OR EXISTS (SELECT 1 FROM states WHERE asset_id=a.id AND discarded=1)
            OR EXISTS (SELECT 1 FROM files WHERE asset_id=a.id AND discarded=1))`
              : "a.discarded=0",
          );
          const where = conditions.join(" AND ");
          const offset = Math.max(
            0,
            Math.min(1000000, Number(url.searchParams.get("offset")) || 0),
          );
          const total = db
            .prepare(`SELECT COUNT(*) AS count FROM assets a WHERE ${where}`)
            .get(...values).count;
          const rows = db
            .prepare(
              `SELECT a.* FROM assets a WHERE ${where} ORDER BY a.updated_at DESC,a.id LIMIT 48 OFFSET ?`,
            )
            .all(...values, Math.floor(offset));
          const selectionIds = editor(req) && total <= 1000
            ? db.prepare(`SELECT a.id FROM assets a WHERE ${where} ORDER BY a.updated_at DESC,a.id`).all(...values).map((a) => a.id)
            : null;
          result = { total, items: rows.map((a) => summary(req, a)), selectionIds };
        } else if (route === "projects") {
          h.requirePermission(req, "files.write");
          const root = h.sourceRoot(req);
          const items = [];
          async function scan(relative) {
            const folder = await checkedPath(root, relative);
            const entries = await fsp.readdir(folder, { withFileTypes: true });
            if (
              relative &&
              entries.some(
                (e) =>
                  e.name === ".project" && e.isFile() && !e.isSymbolicLink(),
              )
            ) {
              items.push({
                name: path.posix.basename(relative),
                path: relative,
              });
            }
            for (const entry of entries) {
              if (
                entry.isDirectory() &&
                !entry.isSymbolicLink() &&
                !entry.name.startsWith(".")
              ) {
                await scan(path.posix.join(relative, entry.name));
              }
            }
          }
          await scan("");
          items.sort((a, b) =>
            a.name.localeCompare(b.name, "zh-CN", { numeric: true }),
          );
          result = { items };
        } else if (route === "directories") {
          h.requirePermission(req, "files.write");
          const relative = text(url.searchParams.get("path"), 3000);
          const folder = await checkedPath(h.sourceRoot(req), relative);
          const entries = await fsp.readdir(folder, { withFileTypes: true });
          result = {
            path: relative,
            directories: entries
              .filter((e) => e.isDirectory() && !e.isSymbolicLink())
              .map((e) => e.name)
              .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })),
          };
        } else fail("接口不存在", 404);
      } else {
        if (route === "upload") result = await upload(req);
        else {
          const body = await json(req);
          result = await write(async () => {
            if (route === "import") return importFiles(req, body);
            if (route === "commit") return commit(req, body);
            if (route === "edit") return edit(req, body);
            if (route === "add-tags") return addTags(req, body);
            if (route === "create-state") return createState(req, body);
            if (route === "move-files") return moveFiles(req, body);
            if (route === "lifecycle") return lifecycle(req, body);
            if (route === "delete") return erase(req, body);
            if (route === "copy") return copy(req, body);
            if (route === "cancel-upload") {
              const files = (Array.isArray(body.files) ? body.files : [])
                .slice(0, 64)
                .map((id) =>
                  db
                    .prepare(
                      "SELECT * FROM files WHERE id=? AND asset_id IS NULL AND owner_id=? AND scope=?",
                    )
                    .get(String(id), req.authUser.id, scope(req)),
                )
                .filter(Boolean);
              await removeStaged(files);
              return { ok: true };
            }
            if (route === "state") {
              const { row, a } = target(req, { kind: "state", id: body.id });
              if (Number(body.revision) !== a.revision)
                fail("资产已更新，请重新打开", 409);
              transaction(() => {
                db.prepare("UPDATE states SET name=?,prompt=? WHERE id=?").run(
                  text(body.name, 100, true),
                  text(body.prompt, 20000),
                  row.id,
                );
                touch(req, a.id);
              });
              return { ok: true };
            }
            if (route === "cover") {
              const { row, a } = target(req, { kind: "file", id: body.id });
              if (!visibleFiles(req, a).some((f) => f.id === row.id))
                fail("不能使用弃用文件作为封面");
              db.prepare("UPDATE assets SET cover_id=? WHERE id=?").run(
                row.id,
                a.id,
              );
              touch(req, a.id);
              return { ok: true };
            }
            fail("接口不存在", 404);
          });
        }
        h.audit(req, `资产库/${route}`);
      }
      h.sendJson(res, 200, result);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else
        h.sendJson(res, error.statusCode || 400, {
          error: error.message,
          duplicates: error.duplicates,
          conflicts: error.conflicts,
        });
    }
    return true;
  }
  return { handle, initialize: init };
};
