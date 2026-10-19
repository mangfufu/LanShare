const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const sharp = require("sharp");

test("asset library integration", { timeout: 180000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "share-assets-test-"));
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DAILY_BACKUP_ENABLED: "0",
    MAX_FILE_SIZE: "1048576",
  };
  for (const [key, name] of Object.entries({
    SHARED_DIR: "shared",
    NSFW_DIR: "private",
    BACKUP_DIR: "backup",
    RECYCLE_DIR: "recycle",
    LOG_DIR: "logs",
    THUMB_CACHE_DIR: "thumbs",
    FOLDER_SIZE_CACHE_FILE: "sizes.json",
    FORUM_DB_FILE: "forum.db",
    AUTH_DB_FILE: "auth.db",
    NSFW_PASSWORD_FILE: "private.txt",
    ASSET_LIBRARY_DIR: "library",
  }))
    env[key] = path.join(temp, name);
  let server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (data) => (output += data));
  server.stderr.on("data", (data) => (output += data));
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
    await fs.rm(temp, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  let ready = false;
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(base + "/api/security")).ok) {
        ready = true;
        break;
      }
    } catch {}
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, output);
  let csrf = (await fetch(base + "/api/security").then((r) => r.json()))
    .csrfToken;
  async function call(route, body, cookie = admin, options = {}) {
    const res = await fetch(base + route, {
      redirect: "manual",
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined
          ? {
              Origin: base,
              "X-CSRF-Token": csrf,
              "Content-Type": "application/json",
            }
          : {}),
        ...options.headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...options,
    });
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
    return { status: res.status, data, headers: res.headers };
  }
  async function register(username) {
    const res = await call(
      "/api/auth/register",
      { username, name: username, password: "TestPass123" },
      "",
    );
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.headers.getSetCookie()[0].split(";")[0];
  }
  const admin = await register("assetadmin");
  const guest = await register("assetguest");
  const editor = await register("assetedit");
  const editor2 = await register("assetedit2");
  const authDb = new DatabaseSync(env.AUTH_DB_FILE);
  authDb
    .prepare(
      "UPDATE users SET role='editor' WHERE username IN ('assetedit','assetedit2')",
    )
    .run();
  authDb.close();
  const picture = await sharp({
    create: { width: 600, height: 400, channels: 3, background: "#7ab49a" },
  })
    .png()
    .toBuffer();
  const secondPicture = await sharp({
    create: { width: 400, height: 600, channels: 3, background: "#82a5c4" },
  })
    .png()
    .toBuffer();
  await fs.writeFile(path.join(env.SHARED_DIR, "front.png"), picture);
  await fs.writeFile(path.join(env.SHARED_DIR, "side.png"), secondPicture);
  await fs.mkdir(path.join(env.SHARED_DIR, "destination"));
  const meta = {
    name: "角色 A",
    category: "角色",
    project: "测试项目",
    tags: ["三视图", "写实"],
    stateName: "日常装",
    prompt: "角色设定图",
  };
  let assetId, fileId, stateId, duplicateIds;
  await t.test("unauthenticated page and API are protected", async () => {
    assert.equal((await call("/assets", undefined, "")).status, 302);
    assert.equal((await call("/api/assets/list", undefined, "")).status, 401);
  });
  await t.test("source import, commit and independent copies", async () => {
    const staged = await call(
      "/api/assets/import",
      { paths: ["front.png", "side.png"] },
      editor,
    );
    assert.equal(staged.status, 200, JSON.stringify(staged.data));
    const saved = await call(
      "/api/assets/commit",
      { ...meta, files: staged.data.files.map((f) => f.id), merge: true },
      editor,
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assetId = saved.data.ids[0];
    const detail = (await call("/api/assets/detail?id=" + assetId)).data;
    assert.equal(detail.states[0].files.length, 2);
    fileId = detail.states[0].files[0].id;
    stateId = detail.states[0].id;
    await fs.rm(path.join(env.SHARED_DIR, "front.png"));
    const media = await fetch(base + "/api/assets/media?id=" + fileId, {
      headers: { Cookie: guest },
    });
    assert.equal(media.status, 200);
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), picture);
    const thumb = await fetch(base + "/api/assets/thumb?id=" + fileId, {
      headers: { Cookie: guest },
    });
    assert.equal(thumb.status, 200);
    assert.ok((await thumb.arrayBuffer()).byteLength > 0);
  });
  await t.test(
    "guest can preview but every write and download route is denied",
    async () => {
      assert.equal(
        (await call("/api/assets/list", undefined, guest)).status,
        200,
      );
      for (const route of [
        "import",
        "commit",
        "edit",
        "state",
        "cover",
        "lifecycle",
        "delete",
        "copy",
        "cancel-upload",
      ]) {
        assert.equal(
          (await call("/api/assets/" + route, {}, guest)).status,
          403,
          route,
        );
      }
      assert.equal((await call("/api/assets/upload", {}, guest)).status, 403);
      for (const route of [
        `download-file?id=${fileId}`,
        `download?kind=asset&id=${assetId}`,
        "directories",
        "list?discarded=1",
      ]) {
        assert.equal(
          (await call("/api/assets/" + route, undefined, guest)).status,
          403,
          route,
        );
      }
      assert.equal(
        (
          await call(
            "/api/assets/lifecycle",
            { kind: "asset", id: assetId, discarded: true },
            editor,
            {
              headers: {
                Cookie: editor,
                Origin: base,
                "Content-Type": "application/json",
              },
            },
          )
        ).status,
        403,
      );
    },
  );
  await t.test("search and shared tag presets", async () => {
    assert.equal(
      (await call("/api/assets/list?q=" + encodeURIComponent("测试项目"))).data
        .total,
      1,
    );
    assert.equal(
      (await call("/api/assets/list?tag=" + encodeURIComponent("三视图"))).data
        .total,
      1,
    );
    assert.ok((await call("/api/assets/meta")).data.tags.includes("写实"));
  });
  await t.test(
    "source projects use workspace project markers, names and scope",
    async () => {
      const project = path.join(env.SHARED_DIR, "分组", "实际项目");
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(
        path.join(project, ".project"),
        JSON.stringify({ episodes: 2 }),
      );
      await fs.mkdir(path.join(env.NSFW_DIR, "私有项目"), { recursive: true });
      await fs.writeFile(path.join(env.NSFW_DIR, "私有项目", ".project"), "");
      const result = await call("/api/assets/projects", undefined, editor);
      assert.equal(result.status, 200);
      assert.deepEqual(result.data.items, [
        { name: "实际项目", path: "分组/实际项目" },
      ]);
      assert.equal(
        (await call("/api/assets/projects", undefined, guest)).status,
        403,
      );
      assert.equal(
        (await call("/api/assets/projects", undefined, "")).status,
        401,
      );
      assert.equal(
        (await call("/api/assets/projects?nsfw=1", undefined, editor)).status,
        401,
      );
      await fs.rename(project, path.join(env.SHARED_DIR, "分组", "改名项目"));
      assert.equal(
        (await call("/api/assets/projects", undefined, editor)).data.items[0]
          .name,
        "改名项目",
      );
    },
  );
  await t.test(
    "duplicate detection requires explicit confirmation and rejects another account token",
    async () => {
      const staged = await call(
        "/api/assets/import",
        { paths: ["side.png"] },
        editor,
      );
      duplicateIds = staged.data.files.map((f) => f.id);
      assert.equal(staged.data.duplicates[0].id, assetId);
      assert.equal(
        (
          await call(
            "/api/assets/commit",
            { ...meta, files: duplicateIds, allowDuplicates: true },
            editor2,
          )
        ).status,
        409,
      );
      const denied = await call(
        "/api/assets/commit",
        { ...meta, files: duplicateIds },
        editor,
      );
      assert.equal(denied.status, 409);
      assert.ok(denied.data.duplicates.length);
      const saved = await call(
        "/api/assets/commit",
        {
          ...meta,
          files: duplicateIds,
          assetId,
          stateName: "战斗装",
          allowDuplicates: true,
        },
        editor,
      );
      assert.equal(saved.status, 200);
      assert.equal(
        (await call("/api/assets/detail?id=" + assetId)).data.states.length,
        2,
      );
    },
  );
  await t.test(
    "all editors can edit, stale metadata edits conflict",
    async () => {
      const before = (await call("/api/assets/detail?id=" + assetId)).data;
      const body = {
        ...meta,
        id: assetId,
        name: "角色 A 更新",
        revision: before.revision,
      };
      assert.equal((await call("/api/assets/edit", body, editor2)).status, 200);
      assert.equal((await call("/api/assets/edit", body, editor)).status, 409);
    },
  );
  await t.test(
    "preflight conflict does not partly copy; overwrite is explicit",
    async () => {
      const detail = (await call("/api/assets/detail?id=" + assetId)).data;
      const files = detail.states.find((s) => s.id === stateId).files;
      await fs.writeFile(
        path.join(env.SHARED_DIR, "destination", files[1].name),
        "original",
      );
      const body = { kind: "state", id: stateId, destination: "destination" };
      const conflict = await call("/api/assets/copy", body, editor);
      assert.equal(conflict.status, 409);
      assert.equal(conflict.data.conflicts.length, 1);
      await assert.rejects(
        fs.access(path.join(env.SHARED_DIR, "destination", files[0].name)),
      );
      assert.equal(
        await fs.readFile(
          path.join(env.SHARED_DIR, "destination", files[1].name),
          "utf8",
        ),
        "original",
      );
      assert.equal(
        (await call("/api/assets/copy", { ...body, overwrite: true }, editor))
          .status,
        200,
      );
      assert.deepEqual(
        await fs.readFile(
          path.join(env.SHARED_DIR, "destination", files[0].name),
        ),
        picture,
      );
      assert.deepEqual(
        await fs.readFile(
          path.join(env.SHARED_DIR, "destination", files[1].name),
        ),
        secondPicture,
      );
      const zip = await fetch(
        base + `/api/assets/download?kind=asset&id=${assetId}`,
        { headers: { Cookie: editor } },
      );
      assert.equal(zip.status, 200);
      assert.equal(
        Buffer.from(await zip.arrayBuffer())
          .subarray(0, 2)
          .toString(),
        "PK",
      );
    },
  );
  await t.test(
    "file, state and asset lifecycle cannot be bypassed by guest or editor delete",
    async () => {
      for (const [kind, id] of [
        ["file", fileId],
        ["state", stateId],
        ["asset", assetId],
      ]) {
        assert.equal(
          (
            await call(
              "/api/assets/lifecycle",
              { kind, id, discarded: true },
              editor2,
            )
          ).status,
          200,
        );
        assert.equal(
          (await call("/api/assets/media?id=" + fileId, undefined, guest))
            .status,
          404,
        );
        assert.equal(
          (await call("/api/assets/delete", { kind, id }, editor)).status,
          403,
        );
        assert.equal(
          (await call("/api/assets/list?discarded=1", undefined, editor)).data
            .total,
          1,
        );
        assert.equal(
          (
            await call(
              "/api/assets/lifecycle",
              { kind, id, discarded: false },
              editor,
            )
          ).status,
          200,
        );
      }
    },
  );
  await t.test(
    "path traversal, junction escape and protected scope are denied",
    async () => {
      assert.equal(
        (await call("/api/assets/import", { paths: ["../auth.db"] }, editor))
          .status,
        400,
      );
      assert.equal(
        (
          await call(
            "/api/assets/copy",
            { kind: "file", id: fileId, destination: "../" },
            editor,
          )
        ).status,
        400,
      );
      await fs.symlink(
        temp,
        path.join(env.SHARED_DIR, "outside-link"),
        process.platform === "win32" ? "junction" : "dir",
      );
      assert.equal(
        (
          await call(
            "/api/assets/import",
            { paths: ["outside-link/auth.db"] },
            editor,
          )
        ).status,
        400,
      );
      assert.equal(
        (await call("/api/assets/list?nsfw=1", undefined, editor)).status,
        401,
      );
    },
  );
  await t.test(
    "multipart upload, batch splitting, cancel and audio constraints",
    async () => {
      const data = new FormData();
      data.append("files", new Blob([picture]), "upload.png");
      data.append("files", new Blob([secondPicture]), "upload-side.png");
      const upload = await fetch(base + "/api/assets/upload", {
        method: "POST",
        headers: { Cookie: editor, Origin: base, "X-CSRF-Token": csrf },
        body: data,
      });
      assert.equal(upload.status, 200);
      const staged = await upload.json();
      const stagedId = staged.files[0].id;
      const preview = await fetch(
        base + "/api/assets/staged-media?id=" + stagedId,
        { headers: { Cookie: editor } },
      );
      assert.equal(preview.status, 200);
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), picture);
      assert.equal(
        (
          await call(
            "/api/assets/staged-media?id=" + stagedId,
            undefined,
            editor2,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await call(
            "/api/assets/staged-media?id=" + stagedId,
            undefined,
            guest,
          )
        ).status,
        403,
      );
      const thumb = await fetch(
        base + "/api/assets/staged-thumb?id=" + stagedId,
        { headers: { Cookie: editor } },
      );
      assert.equal(thumb.status, 200);
      assert.ok((await thumb.arrayBuffer()).byteLength > 0);
      assert.equal(
        (
          await call(
            "/api/assets/commit",
            {
              ...meta,
              category: "音频",
              files: staged.files.map((f) => f.id),
              allowDuplicates: true,
            },
            editor,
          )
        ).status,
        400,
      );
      const saved = await call(
        "/api/assets/commit",
        {
          ...meta,
          files: staged.files.map((f) => f.id),
          allowDuplicates: true,
          merge: false,
        },
        editor,
      );
      assert.equal(saved.status, 200);
      assert.equal(saved.data.ids.length, 2);
      assert.equal(
        (
          await call(
            "/api/assets/staged-media?id=" + stagedId,
            undefined,
            editor,
          )
        ).status,
        404,
      );
      const audio = new FormData();
      audio.append(
        "files",
        new Blob([Buffer.from("RIFF0000WAVEfmt ")]),
        "voice.wav",
      );
      const audioResult = await fetch(base + "/api/assets/upload", {
        method: "POST",
        headers: { Cookie: editor, Origin: base, "X-CSRF-Token": csrf },
        body: audio,
      }).then((r) => r.json());
      const audioSaved = await call(
        "/api/assets/commit",
        {
          ...meta,
          category: "音频",
          name: "男声",
          files: audioResult.files.map((f) => f.id),
          tags: ["男声", "低沉"],
        },
        editor,
      );
      assert.equal(audioSaved.status, 200);
      const stagedAgain = (
        await call("/api/assets/import", { paths: ["side.png"] }, editor)
      ).data;
      await call(
        "/api/assets/cancel-upload",
        { files: stagedAgain.files.map((f) => f.id) },
        editor,
      );
      assert.equal(
        (
          await call(
            "/api/assets/commit",
            {
              ...meta,
              files: stagedAgain.files.map((f) => f.id),
              allowDuplicates: true,
            },
            editor,
          )
        ).status,
        409,
      );
    },
  );
  await t.test(
    "byte ranges support suffix and reject invalid ranges",
    async () => {
      const suffix = await fetch(base + "/api/assets/media?id=" + fileId, {
        headers: { Cookie: guest, Range: "bytes=-10" },
      });
      assert.equal(suffix.status, 206);
      assert.deepEqual(
        Buffer.from(await suffix.arrayBuffer()),
        picture.subarray(-10),
      );
      const invalid = await fetch(base + "/api/assets/media?id=" + fileId, {
        headers: { Cookie: guest, Range: "bytes=99999999-" },
      });
      assert.equal(invalid.status, 416);
    },
  );
  await t.test(
    "invalid uploads reject the whole batch and leave no staged rows",
    async () => {
      const data = new FormData();
      data.append("files", new Blob([picture]), "valid.png");
      data.append("files", new Blob(["no executable content"]), "bad.exe");
      const response = await fetch(base + "/api/assets/upload", {
        method: "POST",
        headers: { Cookie: editor, Origin: base, "X-CSRF-Token": csrf },
        body: data,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 400);
      await response.text();
      const db = new DatabaseSync(
        path.join(env.ASSET_LIBRARY_DIR, "library.db"),
      );
      assert.equal(
        db
          .prepare("SELECT COUNT(*) AS count FROM files WHERE asset_id IS NULL")
          .get().count,
        0,
      );
      db.close();
      const huge = new FormData();
      huge.append("files", new Blob([Buffer.alloc(1048577)]), "big.wav");
      const large = await fetch(base + "/api/assets/upload", {
        method: "POST",
        headers: { Cookie: editor, Origin: base, "X-CSRF-Token": csrf },
        body: huge,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(large.status, 413);
      await large.text();
    },
  );
  await t.test(
    "UTF-8 upload filenames survive preview, downloads and directory copies",
    async () => {
      const name = "三皇子制作本1006_第1集_第10段.jpg";
      const data = new FormData();
      data.append(
        "files",
        new Blob([await sharp(picture).jpeg().toBuffer()]),
        name,
      );
      const response = await fetch(base + "/api/assets/upload", {
        method: "POST",
        headers: { Cookie: editor, Origin: base, "X-CSRF-Token": csrf },
        body: data,
      });
      assert.equal(response.status, 200);
      const staged = await response.json();
      assert.equal(staged.files[0].name, name);
      const saved = await call(
        "/api/assets/commit",
        {
          ...meta,
          name: path.parse(name).name,
          files: staged.files.map((f) => f.id),
        },
        editor,
      );
      assert.equal(saved.status, 200);
      const detail = (await call("/api/assets/detail?id=" + saved.data.ids[0]))
        .data;
      assert.equal(detail.states[0].files[0].name, name);
      const download = await call(
        "/api/assets/download-file?id=" + staged.files[0].id,
        undefined,
        editor,
      );
      assert.equal(
        decodeURIComponent(
          download.headers.get("content-disposition").split("''")[1],
        ),
        name,
      );
      assert.equal(
        (
          await call(
            "/api/assets/copy",
            {
              kind: "file",
              id: staged.files[0].id,
              destination: "destination",
            },
            editor,
          )
        ).status,
        200,
      );
      await fs.access(path.join(env.SHARED_DIR, "destination", name));
    },
  );
  await t.test(
    "restart repairs legacy filename metadata while preserving custom asset names",
    async () => {
      const data = new FormData();
      data.append("files", new Blob([picture]), "旧版中文名字.png");
      const response = await fetch(base + "/api/assets/upload", {
        method: "POST",
        headers: { Cookie: editor, Origin: base, "X-CSRF-Token": csrf },
        body: data,
      });
      const staged = await response.json();
      const saved = await call(
        "/api/assets/commit",
        {
          ...meta,
          name: "旧版中文名字",
          files: staged.files.map((f) => f.id),
          allowDuplicates: true,
        },
        editor,
      );
      assert.equal(saved.status, 200);
      const exited = once(server, "exit");
      server.kill();
      await exited;
      const legacyDb = new DatabaseSync(
        path.join(env.ASSET_LIBRARY_DIR, "library.db"),
      );
      const legacy = Buffer.from("旧版中文名字.png", "utf8").toString("latin1");
      legacyDb
        .prepare("UPDATE files SET name=? WHERE id=?")
        .run(legacy, staged.files[0].id);
      legacyDb
        .prepare("UPDATE assets SET name=? WHERE id=?")
        .run(path.parse(legacy).name, saved.data.ids[0]);
      const customFile = legacyDb
        .prepare("SELECT id FROM files WHERE asset_id=? LIMIT 1")
        .get(assetId).id;
      const oldCustomName = legacyDb
        .prepare("SELECT name FROM assets WHERE id=?")
        .get(assetId).name;
      const originalFileName = legacyDb
        .prepare("SELECT name FROM files WHERE id=?")
        .get(customFile).name;
      legacyDb
        .prepare("UPDATE files SET name=? WHERE id=?")
        .run(
          Buffer.from("自定义资产的中文图片.png", "utf8").toString("latin1"),
          customFile,
        );
      legacyDb.exec("PRAGMA user_version=0");
      legacyDb.close();
      server = spawn(process.execPath, ["server.js"], {
        cwd: path.join(__dirname, ".."),
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      server.stdout.on("data", (data) => (output += data));
      server.stderr.on("data", (data) => (output += data));
      let restarted = false;
      for (let i = 0; i < 100; i++) {
        try {
          const response = await fetch(base + "/api/security");
          if (response.ok) {
            csrf = (await response.json()).csrfToken;
            restarted = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(restarted, output);
      const repaired = (
        await call("/api/assets/detail?id=" + saved.data.ids[0])
      ).data;
      assert.equal(repaired.name, "旧版中文名字");
      assert.equal(repaired.states[0].files[0].name, "旧版中文名字.png");
      assert.equal(
        (await call("/api/assets/detail?id=" + assetId)).data.name,
        oldCustomName,
      );
      const db = new DatabaseSync(
        path.join(env.ASSET_LIBRARY_DIR, "library.db"),
      );
      assert.equal(
        db
          .prepare("SELECT original_name FROM filename_repairs WHERE file_id=?")
          .get(staged.files[0].id).original_name,
        legacy,
      );
      assert.equal(
        db.prepare("SELECT name FROM files WHERE id=?").get(customFile).name,
        "自定义资产的中文图片.png",
      );
      db.prepare("UPDATE files SET name=? WHERE id=?").run(
        originalFileName,
        customFile,
      );
      db.close();
    },
  );
  await t.test(
    "state creation and moves validate permissions, revisions and the whole selection",
    async () => {
      const staged = await call("/api/assets/import", { paths: ["side.png"] }, editor);
      const saved = await call("/api/assets/commit", {
        ...meta, name: "状态移动测试", files: staged.data.files.map((f) => f.id),
        merge: true, allowDuplicates: true,
      }, editor);
      const id = saved.data.ids[0];
      const detail = async () => (await call("/api/assets/detail?id=" + id)).data;
      let before = await detail();
      const original = before.states[0];
      const ids = original.files.map((f) => f.id);
      const create = { id, name: "新造型", prompt: "新状态提示词", revision: before.revision };
      assert.equal((await call("/api/assets/create-state", create, guest)).status, 403);
      const created = await call("/api/assets/create-state", create, editor);
      assert.equal(created.status, 200);
      assert.equal((await call("/api/assets/create-state", create, editor)).status, 409);
      before = await detail();
      assert.equal(before.states.find((s) => s.id === created.data.id).files.length, 0);
      assert.equal((await call("/api/assets/create-state", { ...create, revision: before.revision }, editor)).status, 409);
      const move = { id, ids, stateId: created.data.id, revision: before.revision };
      assert.equal((await call("/api/assets/move-files", move, guest)).status, 403);
      assert.equal((await call("/api/assets/move-files", { ...move, revision: 0 }, editor)).status, 409);
      assert.equal((await call("/api/assets/move-files", { ...move, ids: [...ids, fileId] }, editor)).status, 404);
      assert.equal((await call("/api/assets/move-files", { ...move, stateId }, editor)).status, 404);
      assert.equal((await detail()).states.find((s) => s.id === original.id).files.length, 1);
      await call("/api/assets/lifecycle", { kind: "state", id: created.data.id, discarded: true }, editor);
      move.revision = (await detail()).revision;
      assert.equal((await call("/api/assets/move-files", move, editor)).status, 404);
      await call("/api/assets/lifecycle", { kind: "state", id: created.data.id, discarded: false }, editor);
      await call("/api/assets/lifecycle", { kind: "state", id: original.id, discarded: true }, editor);
      move.revision = (await detail()).revision;
      assert.equal((await call("/api/assets/move-files", move, editor)).status, 400);
      await call("/api/assets/lifecycle", { kind: "state", id: original.id, discarded: false }, editor);
      move.revision = (await detail()).revision;
      assert.equal((await call("/api/assets/move-files", move, editor)).status, 200);
      const after = await detail();
      assert.equal(after.states.find((s) => s.id === original.id).files.length, 0);
      assert.deepEqual(after.states.find((s) => s.id === created.data.id).files.map((f) => f.id), ids);
      assert.equal(after.revision, move.revision + 1);
      assert.equal((await call("/api/assets/media?id=" + ids[0], undefined, guest)).status, 200);
    },
  );
  await t.test(
    "selected file actions validate the whole selection and preserve copy preflight",
    async () => {
      await fs.writeFile(path.join(env.SHARED_DIR, "batch-one.png"), picture);
      await fs.writeFile(
        path.join(env.SHARED_DIR, "batch-two.png"),
        secondPicture,
      );
      const staged = await call(
        "/api/assets/import",
        { paths: ["batch-one.png", "batch-two.png"] },
        editor,
      );
      const saved = await call(
        "/api/assets/commit",
        {
          ...meta,
          name: "批量操作测试",
          files: staged.data.files.map((f) => f.id),
          merge: true,
          allowDuplicates: true,
        },
        editor,
      );
      assert.equal(saved.status, 200);
      const id = saved.data.ids[0];
      const detail = async () =>
        (await call("/api/assets/detail?id=" + id)).data;
      const ids = (await detail()).states[0].files.map((f) => f.id);
      const selection = { kind: "files", id, ids };
      assert.equal(
        (
          await call(
            "/api/assets/lifecycle",
            { ...selection, ids: [ids[0], fileId], discarded: true },
            editor,
          )
        ).status,
        404,
      );
      assert.ok((await detail()).states[0].files.every((f) => !f.discarded));
      assert.equal(
        (
          await call(
            "/api/assets/lifecycle",
            { ...selection, discarded: true },
            guest,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            "/api/assets/lifecycle",
            { ...selection, discarded: true },
            editor,
          )
        ).status,
        200,
      );
      assert.ok((await detail()).states[0].files.every((f) => f.discarded));
      const params = new URLSearchParams({ kind: "files", id });
      ids.forEach((file) => params.append("file", file));
      assert.equal(
        (await call("/api/assets/download?" + params, undefined, editor))
          .status,
        400,
      );
      await call(
        "/api/assets/lifecycle",
        { ...selection, discarded: false },
        editor,
      );
      assert.ok((await detail()).states[0].files.every((f) => !f.discarded));
      const destination = path.join(env.SHARED_DIR, "batch-destination");
      await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, "batch-one.png"), "original");
      assert.equal(
        (
          await call(
            "/api/assets/copy",
            { ...selection, destination: "batch-destination" },
            editor,
          )
        ).status,
        409,
      );
      assert.equal(
        await fs.readFile(path.join(destination, "batch-one.png"), "utf8"),
        "original",
      );
      await assert.rejects(fs.access(path.join(destination, "batch-two.png")));
      const copied = await call(
        "/api/assets/copy",
        { ...selection, destination: "batch-destination", overwrite: true },
        editor,
      );
      assert.equal(copied.status, 200);
      assert.equal(copied.data.count, 2);
      assert.deepEqual(
        await fs.readFile(path.join(destination, "batch-two.png")),
        secondPicture,
      );
      const zipped = await fetch(base + "/api/assets/download?" + params, {
        headers: { Cookie: editor },
      });
      assert.equal(zipped.status, 200);
      const zip = Buffer.from(await zipped.arrayBuffer());
      assert.ok(
        zip.includes(Buffer.from("batch-one.png")) &&
          zip.includes(Buffer.from("batch-two.png")),
      );
      assert.equal(
        (await call("/api/assets/download?" + params, undefined, guest)).status,
        403,
      );
      assert.equal((await call("/api/assets/delete", selection)).status, 400);
      await call(
        "/api/assets/lifecycle",
        { ...selection, ids: [ids[0]], discarded: true },
        editor,
      );
      assert.equal((await call("/api/assets/delete", selection)).status, 400);
      assert.equal((await detail()).states[0].files.length, 2);
      await call(
        "/api/assets/lifecycle",
        { ...selection, discarded: true },
        editor,
      );
      assert.equal(
        (await call("/api/assets/delete", selection, editor)).status,
        403,
      );
      assert.equal((await call("/api/assets/delete", selection)).status, 200);
      assert.equal((await detail()).states[0].files.length, 0);
      await call(
        "/api/assets/lifecycle",
        { kind: "asset", id, discarded: true },
        editor,
      );
      await call("/api/assets/delete", { kind: "asset", id });
    },
  );
  await t.test(
    "batch discarded actions are atomic and preserve active contents",
    async () => {
      const create = async (paths, name) => {
        const staged = (await call("/api/assets/import", { paths }, editor))
          .data;
        const saved = await call(
          "/api/assets/commit",
          {
            ...meta,
            name,
            files: staged.files.map((f) => f.id),
            merge: true,
            allowDuplicates: true,
          },
          editor,
        );
        assert.equal(saved.status, 200);
        return saved.data.ids[0];
      };
      const a = await create(
        ["batch-one.png", "batch-two.png"],
        "批量部分弃用",
      );
      const b = await create(["batch-one.png"], "批量整条弃用");
      const detail = async (id) =>
        (await call("/api/assets/detail?id=" + id)).data;
      const original = await detail(a);
      const f = original.states[0].files[0];
      const body = {
        kind: "assets",
        ids: [a, b],
        discarded: false,
        restoreContents: true,
      };
      await call(
        "/api/assets/lifecycle",
        { kind: "file", id: f.id, discarded: true },
        editor,
      );
      await call(
        "/api/assets/lifecycle",
        { kind: "asset", id: b, discarded: true },
        editor,
      );
      assert.equal(
        (
          await call(
            "/api/assets/lifecycle",
            { ...body, ids: [a, "missing"] },
            editor,
          )
        ).status,
        404,
      );
      assert.ok(
        (await detail(a)).states[0].files.find((file) => file.id === f.id)
          .discarded,
      );
      assert.equal(
        (await call("/api/assets/lifecycle", body, guest)).status,
        403,
      );
      assert.equal(
        (await call("/api/assets/lifecycle", body, editor)).status,
        200,
      );
      assert.ok(
        (await detail(a)).states[0].files.every((file) => !file.discarded),
      );
      assert.equal((await detail(b)).discarded, false);
      await call(
        "/api/assets/lifecycle",
        { kind: "state", id: original.states[0].id, discarded: true },
        editor,
      );
      await call("/api/assets/lifecycle", body, editor);
      assert.equal((await detail(a)).states[0].discarded, false);
      await call(
        "/api/assets/lifecycle",
        { kind: "file", id: f.id, discarded: true },
        editor,
      );
      await call(
        "/api/assets/lifecycle",
        { kind: "assets", ids: [a], discarded: true },
        editor,
      );
      await call(
        "/api/assets/lifecycle",
        { kind: "assets", ids: [a], discarded: false },
        editor,
      );
      assert.ok(
        (await detail(a)).states[0].files.find((file) => file.id === f.id)
          .discarded,
        "undo of whole-asset discard preserves previously discarded children",
      );
      await call("/api/assets/lifecycle", body, editor);
      await call(
        "/api/assets/lifecycle",
        { kind: "asset", id: b, discarded: true },
        editor,
      );
      assert.equal(
        (await call("/api/assets/delete", { kind: "assets", ids: [a, b] }))
          .status,
        409,
      );
      assert.ok(
        await detail(b),
        "invalid batch must not partially delete other assets",
      );
      await call(
        "/api/assets/lifecycle",
        { kind: "file", id: f.id, discarded: true },
        editor,
      );
      assert.equal(
        (
          await call(
            "/api/assets/delete",
            { kind: "assets", ids: [a, b] },
            editor,
          )
        ).status,
        403,
      );
      assert.equal(
        (await call("/api/assets/delete", { kind: "assets", ids: [a, b] }))
          .status,
        200,
      );
      const remaining = await detail(a);
      assert.equal(remaining.discarded, false);
      assert.equal(remaining.states[0].files.length, 1);
      assert.notEqual(remaining.states[0].files[0].id, f.id);
      assert.equal((await call("/api/assets/detail?id=" + b)).status, 404);
      await call(
        "/api/assets/lifecycle",
        { kind: "asset", id: a, discarded: true },
        editor,
      );
      await call("/api/assets/delete", { kind: "asset", id: a });
    },
  );
  if (process.env.ASSET_BROWSER_TEST === "1") {
    await t.test(
      "desktop and mobile browser workflows",
      { timeout: 90000 },
      async () => {
        const {
          chromium, executablePath,
        } = require("./browser.cjs");
        const browser = await chromium.launch({
          executablePath,
          headless: true,
        });
        try {
          const context = await browser.newContext({
            viewport: { width: 1440, height: 1000 },
          });
          const [name, value] = editor.split("=");
          await context.addCookies([{ name, value, url: base }]);
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (e) => errors.push(e.message));
          await page.goto(base + "/");
          const collectSource = page.locator(
            '[data-item-path="side.png"] .asset-collect',
          );
          await collectSource.waitFor();
          const newTabPromise = context.waitForEvent("page");
          await collectSource.click();
          const intakeTab = await newTabPromise;
          await intakeTab.locator("#stagedList li").waitFor();
          await intakeTab.waitForFunction(
            () =>
              document.querySelector("#stagedPreview img")?.naturalWidth > 0,
          );
          await intakeTab.locator("#stagedPreview img").click();
          await intakeTab.waitForFunction(
            () => document.querySelector("#previewImage").naturalWidth > 0,
          );
          await intakeTab.locator("[data-close=previewDialog]").click();
          await intakeTab.locator("[data-close=intakeDialog]").first().click();
          await intakeTab.locator("#confirmDialog[open]").waitFor();
          await intakeTab.locator("#confirmDialog button[value=cancel]").click();
          assert.equal(await intakeTab.locator("#stagedList li").count(), 1);
          await intakeTab.locator("[data-close=intakeDialog]").first().click();
          await intakeTab.locator("#confirmDialog button[value=yes]").click();
          await intakeTab.waitForFunction(() => !document.querySelector("#intakeDialog").open);
          await intakeTab.close();
          await page.goto(base + "/assets");
          await page.locator(".asset-card").first().waitFor();
          assert.equal(
            await page.locator(".forum-brand, .forum-header").count(),
            0,
          );
          assert.ok(
            (await page.locator("h1").boundingBox()).y < 50,
            "asset title starts near the top without a duplicate logo header",
          );
          assert.equal(
            await page.locator(".page-actions #themeButton").count(),
            1,
          );
          const visualStyle = await page.evaluate(() => ({
            background: getComputedStyle(document.body).backgroundColor,
            font: getComputedStyle(document.body).fontFamily,
            radius: getComputedStyle(document.querySelector("#addAsset"))
              .borderRadius,
            navigation: getComputedStyle(
              document.querySelector(".forum-main-nav a"),
            ).writingMode,
          }));
          assert.equal(visualStyle.background, "rgb(244, 241, 234)");
          assert.match(visualStyle.font, /Noto Serif SC/);
          assert.equal(visualStyle.radius, "0px");
          assert.equal(visualStyle.navigation, "vertical-rl");
          async function assertSelectTheme(dark) {
            const styles = await page.locator("select").evaluateAll((selects) =>
              selects.map((select) => ({
                scheme: getComputedStyle(select).colorScheme,
                options: [...select.options].map((option) => ({
                  background: getComputedStyle(option).backgroundColor,
                  color: getComputedStyle(option).color,
                })),
              })),
            );
            for (const style of styles) {
              assert.equal(style.scheme, dark ? "dark" : "light");
              for (const option of style.options) {
                assert.equal(
                  option.background,
                  dark ? "rgb(32, 29, 21)" : "rgb(252, 251, 247)",
                );
                assert.equal(
                  option.color,
                  dark ? "rgb(232, 226, 210)" : "rgb(23, 24, 21)",
                );
              }
            }
          }
          await assertSelectTheme(false);
          await page.locator("#themeButton").click();
          await page.reload();
          await page.locator(".asset-card").first().waitFor();
          assert.equal(
            await page.evaluate(
              () => getComputedStyle(document.body).backgroundColor,
            ),
            "rgb(22, 20, 15)",
          );
          await assertSelectTheme(true);
          await page.locator("#addAsset").click();
          await page.locator("#assetCategory").click();
          await page.screenshot({
            path: path.resolve(
              __dirname,
              "../../.validation/assets/dark-category-dropdown.png",
            ),
          });
          await page.keyboard.press("Escape");
          await page.locator("[data-close=intakeDialog]").first().click();
          await fs.mkdir(path.resolve(__dirname, "../../.validation/assets"), {
            recursive: true,
          });
          await page.screenshot({
            path: path.resolve(
              __dirname,
              "../../.validation/assets/desktop-library-dark.png",
            ),
            fullPage: true,
          });
          await page.locator("#themeButton").click();
          await page.locator("#search").fill("角色 A");
          await page.locator("#searchForm button[type=submit]").click();
          await page.waitForFunction(
            () => document.querySelectorAll(".asset-card").length === 1,
          );
          await page.locator(".cover-button").first().click();
          assert.equal(await page.locator(".asset-check input").first().isChecked(), true);
          assert.equal(await page.locator("#detailDialog").isVisible(), false);
          await page.locator(".tag-add").first().click();
          assert.equal(await page.locator("#detailDialog").isVisible(), false);
          await page.locator("#quickTagOptions").getByRole("button", { name: "古风", exact: true }).click();
          await page.waitForFunction(() => [...document.querySelectorAll(".asset-card .tag")].some((tag) => tag.textContent === "古风"));
          await page.waitForFunction(() => !document.querySelector("#quickTagInput").disabled);
          await page.locator("#quickTagInput").fill("卡片自定义标签");
          await page.locator("#quickTagInput").press("Enter");
          await page.waitForFunction(() => [...document.querySelectorAll(".asset-card .tag")].some((tag) => tag.textContent === "卡片自定义标签"));
          assert.equal(await page.locator(".asset-check input").first().isChecked(), true);
          await page.screenshot({ path: path.resolve(__dirname, "../../.validation/assets/desktop-card-tags.png") });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.waitForFunction(() => {
            const bounds = document.querySelector("#tagPicker").getBoundingClientRect();
            return bounds.x >= 0 && bounds.right <= innerWidth;
          });
          const tagBounds = await page.locator("#tagPicker").boundingBox();
          assert.ok(tagBounds.x >= 0 && tagBounds.x + tagBounds.width <= 390);
          await page.screenshot({ path: path.resolve(__dirname, "../../.validation/assets/mobile-card-tags.png") });
          await page.locator("#tagPickerClose").click();
          await page.setViewportSize({ width: 1440, height: 1000 });
          await page.locator(".asset-title").first().click();
          await page.locator("#detailDialog[open]").waitFor();
          await page
            .getByRole("button", { name: "编辑信息", exact: true })
            .click();
          await page.locator("#editName").fill("角色 A 浏览器");
          await page.locator("#editDialog [data-close=editDialog]").first().click();
          await page.locator("#confirmDialog button[value=cancel]").click();
          assert.equal(await page.locator("#editName").inputValue(), "角色 A 浏览器");
          await page.locator("#editForm button[type=submit]").click();
          await page.waitForFunction(
            () =>
              document.querySelector("#detailName").textContent ===
              "角色 A 浏览器",
          );
          const screenshots = path.resolve(
            __dirname,
            "../../.validation/assets",
          );
          await fs.mkdir(screenshots, { recursive: true });
          await page.screenshot({
            path: path.join(screenshots, "desktop-detail.png"),
          });
          await page.locator("[data-close=detailDialog]").click();
          assert.equal(await page.locator(".asset-check input").first().isChecked(), true, "editing preserves list selection");
          await page.locator("#resetSearch").click();
          const sourceProject = path.join(env.SHARED_DIR, "来源项目");
          await fs.mkdir(path.join(sourceProject, "子目录"), {
            recursive: true,
          });
          await fs.writeFile(path.join(sourceProject, ".project"), "");
          const sourcePicture = await sharp(picture)
            .resize(91, 65)
            .png()
            .toBuffer();
          await fs.writeFile(path.join(sourceProject, "a.png"), sourcePicture);
          await fs.writeFile(
            path.join(sourceProject, "子目录", "b.png"),
            sourcePicture,
          );
          await fs.writeFile(path.join(sourceProject, "zz.png"), sourcePicture);
          for (let i = 0; i < 51; i++) {
            await fs.writeFile(
              path.join(sourceProject, `z${String(i).padStart(3, "0")}.txt`),
              "unsupported",
            );
          }
          let importRequests = 0;
          page.on("request", (req) => {
            if (new URL(req.url()).pathname === "/api/assets/import")
              importRequests++;
          });
          await page.locator("#addAsset").click();
          await page.locator("#chooseSource").click();
          await page
            .locator("#sourceList")
            .getByRole("button", { name: /来源项目/ })
            .click();
          await page
            .locator("#sourceList input:not(:disabled)")
            .first()
            .waitFor();
          await page.locator("#sourceSelectAll").click();
          await page.locator(".source-preview").first().click();
          await page.waitForFunction(() => document.querySelector("#previewImage").naturalWidth === 91);
          assert.equal(await page.locator("#sourceList input:checked").count(), 1, "preview does not change selection");
          await page.locator("[data-close=previewDialog]").click();
          assert.equal(
            await page.locator("#sourceList input:checked").count(),
            1,
          );
          await page.keyboard.press("Control+Shift+A");
          assert.equal(
            await page.locator("#sourceList input:checked").count(),
            0,
          );
          await page.keyboard.press("Control+A");
          assert.equal(
            await page.locator("#sourceList input:checked").count(),
            1,
          );
          await page.keyboard.press("Escape");
          assert.equal(await page.locator("#sourceDialog").isVisible(), true);
          assert.equal(
            await page.locator("#sourceList input:checked").count(),
            0,
          );
          assert.equal(
            await page.locator(".source-foot #sourceSelectAll").count(),
            1,
          );
          await page
            .locator("#sourceList")
            .getByRole("checkbox", { name: "a.png", exact: true })
            .check();
          await page.locator("[data-close=sourceDialog]").last().click();
          assert.equal(
            importRequests,
            0,
            "cancelling the chooser must not import files",
          );
          assert.equal(await page.locator("#stagedList li").count(), 0);
          await page.locator("#chooseSource").click();
          await page
            .locator("#sourceList")
            .getByRole("checkbox", { name: "a.png", exact: true })
            .check();
          assert.equal(
            await page
              .locator("#sourceList")
              .getByRole("checkbox", { name: "z000.txt", exact: true })
              .isDisabled(),
            true,
          );
          await page
            .locator("#sourceList")
            .getByRole("button", { name: /子目录/ })
            .click();
          await page
            .locator("#sourceList")
            .getByRole("checkbox", { name: "b.png", exact: true })
            .check();
          await page
            .locator("#sourcePath")
            .getByRole("button", { name: "来源项目", exact: true })
            .click();
          assert.equal(
            await page
              .locator("#sourceList")
              .getByRole("checkbox", { name: "a.png", exact: true })
              .isChecked(),
            true,
          );
          await page.screenshot({
            path: path.join(screenshots, "desktop-source-picker.png"),
          });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.screenshot({
            path: path.join(screenshots, "mobile-source-picker.png"),
          });
          assert.ok(
            await page
              .locator("#sourceDialog")
              .evaluate((el) => el.scrollWidth <= el.clientWidth),
          );
          await page.locator("#sourceNext").click();
          await page
            .locator("#sourceList")
            .getByRole("checkbox", { name: "zz.png", exact: true })
            .check();
          assert.equal(
            await page.locator("#sourceCount").innerText(),
            "已选 3 个",
          );
          await page.locator("#sourceConfirm").click();
          await page.waitForFunction(
            () => document.querySelectorAll("#stagedList li").length === 3,
          );
          assert.equal(importRequests, 1);
          assert.equal(
            await page.locator("#assetProject").inputValue(),
            "来源项目",
          );
          await page.waitForFunction(
            () =>
              document.querySelector("#stagedPreview img")?.naturalWidth > 0,
          );
          await page.locator("#stagedList .staged-select").nth(1).click();
          assert.equal(
            await page.locator("#stagedPreview img").getAttribute("alt"),
            "b.png",
          );
          await page.screenshot({
            path: path.join(screenshots, "mobile-intake-preview.png"),
          });
          assert.ok(
            await page
              .locator("#intakeDialog")
              .evaluate((el) => el.scrollWidth <= el.clientWidth),
          );
          await page.setViewportSize({ width: 1440, height: 1000 });
          await page.screenshot({
            path: path.join(screenshots, "desktop-intake-preview.png"),
          });
          const previewBounds = await page
            .locator("#stagedPreview")
            .boundingBox();
          const fieldBounds = await page
            .locator(".intake-fields")
            .boundingBox();
          assert.ok(previewBounds.x + previewBounds.width < fieldBounds.x);
          await page.evaluate(() => {
            document.body.dataset.theme = "dark";
          });
          await page.screenshot({
            path: path.join(screenshots, "dark-intake-preview.png"),
          });
          await page.evaluate(() => {
            document.body.dataset.theme = "light";
          });
          assert.equal(
            await page.locator("#assetProjectChoice").inputValue(),
            "project:来源项目",
          );
          assert.equal(
            await page.locator("#assetProjectCustom").isVisible(),
            false,
          );
          await page.locator("#assetName").fill("工作区多选入库");
          await page.locator("#assetCategory").selectOption("角色");
          await page.locator("#mergeFiles").check();
          await page.locator("#commitButton").click();
          await page.waitForFunction(
            () =>
              document.querySelector("#detailDialog").open &&
              document.querySelector("#detailName").textContent ===
                "工作区多选入库",
          );
          assert.equal(
            await page.locator("#fileGallery .file-item").count(),
            3,
          );
          await page.locator("#detailSelectAll").click();
          await page.locator("#addState").click();
          await page.locator("#editName").fill("独立新状态");
          await page.locator("#editForm button[type=submit]").click();
          await page.locator("#moveStateDialog[open]").waitFor();
          assert.equal(await page.locator("#moveStateTarget option:checked").innerText(), "独立新状态");
          await page.locator("#moveStateDialog").getByRole("button", { name: "取消", exact: true }).click();
          assert.equal(await page.locator("#fileGallery .file-item").count(), 3);
          await page.locator("#moveFiles").click();
          await page.locator("#moveStateForm button[type=submit]").click();
          await page.waitForFunction(() => !document.querySelector("#moveStateDialog").open &&
            document.querySelector('#stateTabs [aria-pressed="true"]')?.textContent === "独立新状态");
          assert.equal(await page.locator("#fileGallery .file-item").count(), 3);
          assert.equal(await page.locator("#detailActions #detailSelection").count(), 1);
          assert.equal(await page.locator("#moveFiles").isDisabled(), true);
          await page.locator("#fileGallery .file-item > img").first().click();
          assert.equal(await page.locator("#fileGallery").getByRole("button", { name: "预览", exact: true }).count(), 0);
          assert.equal(await page.locator("#fileGallery input:checked").count(), 1);
          await page.locator("#fileGallery .file-item > img").first().dblclick();
          assert.equal(await page.locator("#previewPosition").innerText(), "1 / 3");
          await page.keyboard.press("ArrowRight");
          assert.equal(await page.locator("#previewPosition").innerText(), "2 / 3");
          await page.keyboard.press("ArrowLeft");
          assert.equal(await page.locator("#previewPosition").innerText(), "1 / 3");
          await page.locator("[data-close=previewDialog]").click();
          assert.equal(await page.locator("#fileGallery input:checked").count(), 1);
          await page.locator("#detailClear").click();
          await page.screenshot({ path: path.join(screenshots, "desktop-state-move.png") });
          await page.locator("#stateTabs").getByRole("button", { name: "默认", exact: true }).click();
          assert.equal(await page.locator("#fileGallery .file-item").count(), 0);
          await page.locator("#stateActions").getByRole("button", { name: "弃用空状态", exact: true }).click();
          await page.waitForFunction(() => ![...document.querySelectorAll("#stateTabs button")].some((b) => b.textContent === "默认"));
          await page.locator("#showDiscarded").check();
          await page.locator("#stateActions").getByRole("button", { name: "恢复空状态", exact: true }).click();
          await page.waitForFunction(() => document.querySelector("#fileGallery").textContent.includes("没有弃用内容"));
          await page.locator("#showDiscarded").uncheck();
          await page.locator("#stateTabs").getByRole("button", { name: "独立新状态", exact: true }).click();
          assert.deepEqual(
            await fs.readFile(path.join(sourceProject, "a.png")),
            sourcePicture,
          );
          await page.locator("[data-close=detailDialog]").click();
          await page.setViewportSize({ width: 1440, height: 1000 });
          await page.locator("#addAsset").click();
          await page.locator("#uploadFiles").setInputFiles({
            name: "角色·夏装_三视图.png",
            mimeType: "image/png",
            buffer: await sharp(picture).resize(120, 80).png().toBuffer(),
          });
          await page.waitForFunction(
            () => !document.querySelector("#commitButton").disabled,
          );
          assert.match(
            await page.locator("#stagedList").innerText(),
            /角色·夏装_三视图\.png/,
          );
          await page.waitForFunction(
            () =>
              document.querySelector("#stagedPreview img")?.naturalWidth > 0,
          );
          await page.locator("#assetName").fill("浏览器上传");
          await page.locator("#assetCategory").selectOption("场景");
          await page
            .locator("#assetProjectChoice")
            .selectOption("project:改名项目");
          assert.equal(
            await page.locator("#assetProject").inputValue(),
            "改名项目",
          );
          await page.locator("#assetProjectChoice").selectOption("custom");
          await page.locator("#assetProject").fill("外部自定义项目");
          await page.locator("#commitButton").click();
          await page.waitForFunction(
            () =>
              document.querySelector("#detailDialog").open &&
              document.querySelector("#detailName").textContent ===
                "浏览器上传",
          );
          assert.match(
            await page.locator("#detailMeta").innerText(),
            /外部自定义项目/,
          );
          await page
            .getByRole("button", { name: "编辑信息", exact: true })
            .click();
          assert.equal(
            await page.locator("#editProjectChoice").inputValue(),
            "custom",
          );
          assert.equal(
            await page.locator("#editProject").inputValue(),
            "外部自定义项目",
          );
          await page
            .locator("#editProjectChoice")
            .selectOption("project:来源项目");
          await page.locator("#editForm button[type=submit]").click();
          await page.waitForFunction(() =>
            document
              .querySelector("#detailMeta")
              .textContent.includes("来源项目：来源项目"),
          );
          await page.locator("[data-close=detailDialog]").click();
          await page.goto(base + "/assets?source=side.png");
          await page.locator("#stagedList li").waitFor();
          await page.locator("#intakeMode").selectOption("existing");
          await page.waitForFunction(
            () => document.querySelector("#existingAsset").options.length > 1,
          );
          await page.locator("#existingAsset").selectOption(assetId);
          await page.waitForFunction(
            () => document.querySelector("#existingState").options.length > 1,
          );
          await page.locator("#stateName").fill("浏览器新状态");
          await page.locator("#allowDuplicates").check();
          await page.locator("#commitButton").click();
          await page.waitForFunction(
            () =>
              document.querySelector("#detailDialog").open &&
              [...document.querySelectorAll("#stateTabs button")].some(
                (b) => b.textContent === "浏览器新状态",
              ),
          );
          assert.equal(await page.locator('#stateTabs [aria-pressed="true"]').innerText(), "浏览器新状态", "append stays in destination state");
          await page.locator("[data-close=detailDialog]").click();
          for (const close of await page.locator("#notifications button").all())
            await close.click();
          await page.screenshot({
            path: path.join(screenshots, "desktop-library.png"),
            fullPage: true,
          });
          const cardHeights = await page.locator(".asset-card").evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height));
          assert.ok(cardHeights.length > 1);
          assert.ok(Math.max(...cardHeights) - Math.min(...cardHeights) < 2, "all asset cards have equal height");
          await page.setViewportSize({ width: 390, height: 844 });
          const mobileNav = await page.locator(".forum-main-nav").boundingBox();
          const mobileHeading = await page
            .locator(".page-heading")
            .boundingBox();
          assert.equal(mobileNav.y, 0);
          assert.ok(
            mobileHeading.y >= mobileNav.y + mobileNav.height,
            "mobile navigation does not cover the title",
          );
          assert.equal(
            await page
              .locator(".forum-main-nav a")
              .first()
              .evaluate((el) => getComputedStyle(el).writingMode),
            "horizontal-tb",
          );
          await page.screenshot({
            path: path.join(screenshots, "mobile-library.png"),
            fullPage: true,
          });
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          );
          await page.locator(".asset-title").first().click();
          await page.locator("#detailDialog[open]").waitFor();
          await page.screenshot({
            path: path.join(screenshots, "mobile-detail.png"),
          });
          assert.ok(
            await page.evaluate(
              () =>
                document.querySelector("#detailDialog").scrollWidth <=
                document.querySelector("#detailDialog").clientWidth,
            ),
          );
          const toolbar = page.locator("#detailActions");
          assert.equal(await page.locator("#detailScope").count(), 0);
          for (const name of ["下载", "复制到目录", "弃用"]) {
            assert.equal(
              await page
                .locator("#detailDialog")
                .getByRole("button", { name, exact: true })
                .count(),
              1,
            );
            assert.equal(
              await toolbar.getByRole("button", { name, exact: true }).count(),
              1,
            );
            assert.equal(await toolbar.getByRole("button", { name, exact: true }).isDisabled(), true);
          }
          const fileChecks = page.locator("#fileGallery input[type=checkbox]");
          await page.locator("#detailSelectAll").click();
          assert.equal(
            await page.locator("#fileGallery input:checked").count(),
            2,
          );
          await page.keyboard.press("Control+Shift+A");
          assert.equal(
            await page.locator("#fileGallery input:checked").count(),
            0,
          );
          await page.keyboard.press("Control+A");
          assert.equal(
            await page.locator("#fileGallery input:checked").count(),
            2,
          );
          await page.keyboard.press("Escape");
          assert.equal(await page.locator("#detailDialog").isVisible(), true);
          assert.equal(
            await page.locator("#fileGallery input:checked").count(),
            0,
          );
          await fileChecks.nth(0).check();
          await fileChecks.nth(1).check();
          const zipDownload = page.waitForEvent("download");
          await toolbar
            .getByRole("button", { name: "下载", exact: true })
            .click();
          const zipResult = await zipDownload;
          assert.match(zipResult.suggestedFilename(), /\.zip$/);
          await zipResult.delete();
          await fileChecks.nth(1).uncheck();
          const fileDownload = page.waitForEvent("download");
          await toolbar
            .getByRole("button", { name: "下载", exact: true })
            .click();
          const fileResult = await fileDownload;
          assert.match(fileResult.suggestedFilename(), /\.png$/);
          await fileResult.delete();
          await fileChecks.nth(0).uncheck();
          assert.equal(
            await toolbar
              .getByRole("button", { name: "弃用", exact: true })
              .isDisabled(),
            true,
          );
          await page.locator("#detailSelectAll").click();
          await toolbar
            .getByRole("button", { name: "弃用", exact: true })
            .click();
          await page.locator(".notice-action").last().waitFor();
          assert.equal(await page.locator("#confirmDialog").isVisible(), false);
          await page.locator(".notice-action").last().click();
          await page.waitForFunction(
            () => !document.querySelector("#detailSelectAll").disabled && document.querySelectorAll("#fileGallery input[type=checkbox]").length === 2,
          );
          assert.equal(await page.locator("#showDiscarded").isChecked(), false);
          await page
            .locator("#fileGallery input[type=checkbox]")
            .first()
            .check();
          await toolbar
            .getByRole("button", { name: "弃用", exact: true })
            .click();
          await page.locator(".notice-action").last().waitFor();
          assert.equal(await page.locator("#confirmDialog").isVisible(), false);
          await page.locator(".notice-action").last().click();
          await page.waitForFunction(
            () => !document.querySelector("#detailSelectAll").disabled,
          );
          await page
            .locator("#fileGallery input[type=checkbox]")
            .first()
            .check();
          await toolbar
            .getByRole("button", { name: "弃用", exact: true })
            .click();
          await page.locator(".notice-action").last().waitFor();
          assert.equal(await page.locator("#confirmDialog").isVisible(), false);
          await page.locator("#showDiscarded").check();
          await page
            .locator("#fileGallery input[type=checkbox]")
            .first()
            .check();
          await toolbar
            .getByRole("button", { name: "恢复", exact: true })
            .click();
          await page.waitForFunction(
            () =>
              document
                .querySelector("#fileGallery")
                .textContent.includes("没有弃用内容") ||
              document
                .querySelector("#fileGallery")
                .textContent.includes("没有文件"),
          );
          await page.locator("#showDiscarded").uncheck();
          await page
            .locator("#fileGallery input[type=checkbox]")
            .first()
            .check();
          await toolbar
            .getByRole("button", { name: "复制到目录", exact: true })
            .click();
          await page
            .locator("#folderList")
            .getByRole("button", { name: "▸ destination", exact: true })
            .click();
          await page.locator("#copyConfirm").click();
          await page.locator("#confirmDialog[open]").waitFor();
          await page.locator("#confirmDialog button[value=cancel]").click();
          assert.equal(await page.locator("#copyDialog").isVisible(), true);
          await page.locator("#copyConfirm").click();
          await page.locator("#confirmDialog button[value=yes]").click();
          await page.waitForFunction(
            () => !document.querySelector("#copyDialog").open,
          );
          assert.deepEqual(errors, []);
          await toolbar.getByRole("button", { name: "复制到目录", exact: true }).click();
          await page.locator("#folderList button").first().waitFor();
          await page.route("**/api/assets/directories?*", async (route) => {
            const folder = new URL(route.request().url()).searchParams.get("path");
            if (folder === "slow") await new Promise((resolve) => setTimeout(resolve, 150));
            await route.fulfill({ status: folder === "failed" ? 500 : 200, contentType: "application/json", body: JSON.stringify(folder === "failed" ? { error: "目录读取失败" } : { path: folder, directories: [] }) });
          });
          await page.evaluate(async () => {
            await Promise.all([browseFolder("slow"), browseFolder("latest")]);
          });
          assert.equal(await page.locator("#folderPath").innerText(), "/latest");
          await page.evaluate(() => browseFolder("failed"));
          assert.equal(await page.locator("#copyConfirm").isDisabled(), true);
          await page.locator("#copyDialog [data-close=copyDialog]").first().click();
          await page.unroute("**/api/assets/directories?*");
          await context.close();
          const guestContext = await browser.newContext();
          const guestCookie = guest.split("=");
          await guestContext.addCookies([
            { name: guestCookie[0], value: guestCookie[1], url: base },
          ]);
          const guestPage = await guestContext.newPage();
          await guestPage.goto(base + "/assets");
          await guestPage.locator(".asset-card").first().waitFor();
          assert.equal(await guestPage.locator("#addAsset").isVisible(), false);
          assert.equal(await guestPage.locator(".tag-add").count(), 0);
          await guestPage.locator(".asset-title").first().click();
          await guestPage.locator("#detailDialog[open]").waitFor();
          assert.equal(
            await guestPage
              .getByRole("button", { name: "下载", exact: true })
              .count(),
            0,
          );
          assert.equal(
            await guestPage
              .getByRole("button", { name: "复制到目录", exact: true })
              .count(),
            0,
          );
          await guestContext.close();
        } finally {
          await browser.close();
        }
      },
    );
  }
  if (process.env.ASSET_BROWSER_TEST === "1") {
    await t.test(
      "discarded library supports batch selection, shortcuts, restore and confirmed deletion",
      { timeout: 90000 },
      async () => {
        const ids = [];
        for (const name of ["批量浏览器甲", "批量浏览器乙"]) {
          const staged = (
            await call("/api/assets/import", { paths: ["side.png"] }, editor)
          ).data;
          const saved = (
            await call(
              "/api/assets/commit",
              {
                ...meta,
                name,
                files: staged.files.map((f) => f.id),
                allowDuplicates: true,
              },
              editor,
            )
          ).data;
          ids.push(saved.ids[0]);
        }
        const {
          chromium, executablePath,
        } = require("./browser.cjs");
        const browser = await chromium.launch({
          executablePath,
          headless: true,
        });
        try {
          const context = await browser.newContext({
            viewport: { width: 1440, height: 1000 },
          });
          const [name, value] = admin.split("=");
          await context.addCookies([{ name, value, url: base }]);
          const page = await context.newPage();
          await page.goto(base + "/assets");
          await page.locator("#search").fill("批量浏览器");
          await page.locator("#searchForm button[type=submit]").click();
          await page.waitForFunction(
            () =>
              document.querySelectorAll(".asset-card").length === 2 &&
              !document.querySelector("#listSelectAll").disabled,
          );
          await page.locator(".asset-check input").first().check();
          await page.keyboard.press("Control+A");
          assert.equal(
            await page.locator(".asset-check input:checked").count(),
            2,
          );
          await page.keyboard.press("Control+Shift+A");
          assert.equal(
            await page.locator(".asset-check input:checked").count(),
            0,
          );
          await page.locator("#listSelectAll").click();
          await page.locator("#search").focus();
          await page.keyboard.press("Control+A");
          assert.equal(
            await page
              .locator("#search")
              .evaluate((input) => input.selectionEnd - input.selectionStart),
            "批量浏览器".length,
          );
          assert.equal(
            await page.locator(".asset-check input:checked").count(),
            2,
          );
          await page.locator("#listDiscard").click();
          await page.locator(".notice-action").last().waitFor();
          assert.equal(await page.locator("#confirmDialog").isVisible(), false);
          await page.locator("#discardedTab").click();
          await page.waitForFunction(
            () =>
              document.querySelectorAll(".asset-card").length === 2 &&
              !document.querySelector("#listSelectAll").disabled,
          );
          await page.locator("#listSelectAll").click();
          await page.locator("#listInvert").click();
          assert.equal(
            await page.locator(".asset-check input:checked").count(),
            0,
          );
          await page.keyboard.press("Control+A");
          await page.locator("#listRestore").click();
          await page.waitForFunction(
            () => document.querySelectorAll(".asset-card").length === 0,
          );
          await page.locator("#activeTab").click();
          await page.waitForFunction(
            () => document.querySelectorAll(".asset-card").length === 2,
          );
          await page.locator("#listSelectAll").click();
          await page.locator("#listDiscard").click();
          await page.waitForFunction(
            () =>
              document.querySelectorAll(".asset-card").length === 0 &&
              document.querySelector("#assetGrid").getAttribute("aria-busy") !==
                "true",
          );
          await page.locator("#discardedTab").click();
          await page.waitForFunction(
            () =>
              document.querySelectorAll(".asset-card").length === 2 &&
              !document.querySelector("#listSelectAll").disabled,
          );
          await page.locator("#listSelectAll").click();
          for (const close of await page
            .locator("#notifications [aria-label='关闭通知']")
            .all())
            await close.click();
          const cardBounds = await page
            .locator(".asset-card")
            .first()
            .boundingBox();
          const searchButtonBounds = await page
            .locator("#searchForm button[type=submit]")
            .boundingBox();
          const selectButtonBounds = await page
            .locator("#listSelectAll")
            .boundingBox();
          assert.ok(
            Math.abs(
              searchButtonBounds.y +
                searchButtonBounds.height / 2 -
                selectButtonBounds.y -
                selectButtonBounds.height / 2,
            ) < 2,
            "selection and search share one desktop toolbar row",
          );
          assert.ok(
            await page
              .locator(".asset-info")
              .first()
              .evaluate(
                (el) => parseFloat(getComputedStyle(el).paddingBottom) < 20,
              ),
            "no extra checkbox footer padding",
          );
          const checkBounds = await page
            .locator(".asset-check")
            .first()
            .boundingBox();
          const coverBounds = await page
            .locator(".cover-button")
            .first()
            .boundingBox();
          assert.ok(checkBounds.y > coverBounds.y + coverBounds.height);
          assert.ok(
            cardBounds.x +
              cardBounds.width -
              checkBounds.x -
              checkBounds.width <
              16,
          );
          assert.ok(
            cardBounds.y +
              cardBounds.height -
              checkBounds.y -
              checkBounds.height <
              16,
          );
          const screenshots = path.resolve(
            __dirname,
            "../../.validation/assets",
          );
          await page.screenshot({
            path: path.join(screenshots, "discarded-batch-desktop.png"),
            fullPage: true,
          });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.screenshot({
            path: path.join(screenshots, "discarded-batch-mobile.png"),
            fullPage: true,
          });
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          );
          await page.locator("#listDelete").click();
          await page.locator("#confirmDialog button[value=cancel]").click();
          assert.equal(await page.locator(".asset-card").count(), 2);
          await page.locator("#listDelete").click();
          await page.locator("#confirmDialog button[value=yes]").click();
          await page.waitForFunction(
            () => document.querySelectorAll(".asset-card").length === 0,
          );
          for (const id of ids)
            assert.equal(
              (await call("/api/assets/detail?id=" + id)).status,
              404,
            );
          await context.close();
        } finally {
          await browser.close();
        }
      },
    );
  }
  await t.test(
    "card tag additions merge latest values without overwriting asset metadata",
    async () => {
      const before = (await call("/api/assets/detail?id=" + assetId)).data;
      assert.equal((await call("/api/assets/add-tags", { id: assetId, tags: ["快速标签A"] }, guest)).status, 403);
      assert.equal((await call("/api/assets/add-tags", { id: assetId, tags: ["快速标签A"] }, editor)).status, 200);
      assert.equal((await call("/api/assets/add-tags", { id: assetId, tags: ["快速标签B", "快速标签A"] }, editor2)).status, 200);
      const after = (await call("/api/assets/detail?id=" + assetId)).data;
      assert.deepEqual(after.tags, [...before.tags, "快速标签A", "快速标签B"]);
      assert.equal(after.name, before.name);
      assert.equal(after.project, before.project);
      assert.equal(after.category, before.category);
      assert.equal(after.revision, before.revision + 2);
      assert.equal((await call("/api/assets/add-tags", { id: assetId, tags: ["快速标签A"] }, editor)).status, 200);
      assert.equal((await call("/api/assets/detail?id=" + assetId)).data.revision, after.revision);
      for (const tags of [[" "], ["x".repeat(41)], Array.from({ length: 30 }, (_, i) => `overflow${i}`)])
        assert.equal((await call("/api/assets/add-tags", { id: assetId, tags }, editor)).status, 400);
      assert.deepEqual((await call("/api/assets/detail?id=" + assetId)).data.tags, after.tags);
      assert.ok((await call("/api/assets/meta")).data.tags.includes("快速标签B"));
    },
  );
  await t.test(
    "selection spans filtered pages and presets do not pollute used tag filters",
    async () => {
      const metadata = (await call("/api/assets/meta")).data;
      for (const tag of ["主角", "古风", "男声", "女声", "低沉", "磁性"])
        assert.ok(metadata.presetTags.includes(tag));
      assert.equal(metadata.tags.includes("磁性"), false);
      const ids = [];
      for (const count of [64, 1]) {
        const paths = [];
        for (let i = 0; i < count; i++) {
          const name = `pagination-${ids.length}-${i}.png`;
          await fs.writeFile(path.join(env.SHARED_DIR, name), picture);
          paths.push(name);
        }
        const imported = await call("/api/assets/import", { paths }, editor);
        assert.equal(imported.status, 200);
        const saved = await call("/api/assets/commit", {
          ...meta, project: "跨页选择验证", files: imported.data.files.map((f) => f.id),
          merge: false, allowDuplicates: true,
        }, editor);
        assert.equal(saved.status, 200);
        ids.push(...saved.data.ids);
      }
      const route = "/api/assets/list?q=" + encodeURIComponent("跨页选择验证");
      const first = (await call(route, undefined, editor)).data;
      assert.equal(first.total, 65);
      assert.equal(first.items.length, 48);
      assert.equal(first.selectionIds.length, 65);
      assert.deepEqual(new Set(first.selectionIds), new Set(ids));
      assert.equal((await call(route, undefined, guest)).data.selectionIds, null);
      if (process.env.ASSET_BROWSER_TEST === "1") {
        const { chromium, executablePath } = require("./browser.cjs");
        const browser = await chromium.launch({ executablePath, headless: true });
        try {
          const context = await browser.newContext();
          const [name, value] = editor.split("=");
          await context.addCookies([{ name, value, url: base }]);
          const page = await context.newPage();
          await page.goto(base + "/assets");
          await page.locator(".asset-card").first().waitFor();
          await page.locator("#search").fill("跨页选择验证");
          await page.locator("#searchForm button[type=submit]").click();
          await page.waitForFunction(() => document.querySelector("#resultCount").textContent === "65 条资产");
          await page.locator("#listSelectAll").click();
          assert.match(await page.locator("#listSelectedCount").innerText(), /已选 65 条/);
          await page.locator("#nextPage").click();
          await page.waitForFunction(() => document.querySelectorAll(".asset-card").length === 17);
          assert.equal(await page.locator(".asset-check input:checked").count(), 17);
          await page.locator("#listInvert").click();
          assert.equal(await page.locator("#listSelectedCount").innerText(), "已选 0 条");
          await page.locator("#listSelectAll").click();
          await page.locator("#resetSearch").click();
          await page.waitForFunction(() => !document.querySelector("#listSelectAll").disabled);
          assert.equal(await page.locator("#listSelectedCount").innerText(), "已选 0 条");
          await page.locator("#addAsset").click();
          await page.locator('#assetCategory').selectOption('音频');
          await page.locator('#assetTagsPicker summary').click();
          await page.locator('#assetTagsPicker').getByRole('button', { name: '磁性', exact: true }).click();
          await page.locator('#assetTagsPicker').getByRole('button', { name: '男声', exact: true }).click();
          assert.equal(await page.locator('#assetTags').inputValue(), '磁性, 男声');
          assert.equal(await page.locator('#assetTagsPicker').getByRole('button', { name: '男性', exact: true }).count(), 0);
          await page.locator('#assetTagsPicker').getByRole('button', { name: '移除标签：男声', exact: true }).click();
          assert.equal(await page.locator('#assetTags').inputValue(), '磁性');
          await page.locator('#assetCategory').selectOption('角色');
          assert.equal(await page.locator('#assetTagsPicker').getByRole('button', { name: '男性', exact: true }).count(), 1);
          assert.equal(await page.locator('#assetTagsPicker').getByRole('button', { name: '女性', exact: true }).count(), 1);
          await page.locator('#assetTags').fill('自定义');
          await page.locator('#assetTagsPicker').getByRole('button', { name: '男性', exact: true }).click();
          assert.equal(await page.locator('#assetTags').inputValue(), '自定义, 男性');
          await page.locator('#assetCategory').selectOption('场景');
          assert.equal(await page.locator('#assetTagsPicker').getByRole('button', { name: '室内', exact: true }).count(), 1);
          assert.equal(await page.locator('#assetTags').inputValue(), '自定义, 男性');
          await context.close();
        } finally { await browser.close(); }
      }
      const discarded = await call("/api/assets/lifecycle", { kind: "assets", ids, discarded: true }, editor);
      assert.equal(discarded.status, 200);
      assert.equal(discarded.data.changedIds.length, 65);
      assert.equal((await call("/api/assets/lifecycle", { kind: "assets", ids: Array(1001).fill(ids[0]), discarded: false }, editor)).status, 400);
      assert.equal((await call("/api/assets/delete", { kind: "assets", ids })).status, 200);
    },
  );
  await t.test('tag suggestions are categorized and remember custom tags without cross-category leakage', async () => {
    const meta = (await call('/api/assets/meta')).data;
    assert.ok(meta.presetTagsByCategory['角色'].includes('男性'));
    assert.ok(meta.presetTagsByCategory['角色'].includes('女性'));
    assert.ok(meta.presetTagsByCategory['群演'].includes('男性'));
    assert.ok(meta.presetTagsByCategory['音频'].includes('男声'));
    assert.ok(!meta.presetTagsByCategory['音频'].includes('男性'));
    assert.ok(!meta.presetTagsByCategory['角色'].includes('磁性'));
    assert.ok(meta.presetTagsByCategory['场景'].includes('室内'));
    assert.equal((await call('/api/assets/add-tags', { id: assetId, tags: ['角色独有测试标签'] }, editor)).status, 200);
    const updated = (await call('/api/assets/meta')).data;
    assert.ok(updated.tagsByCategory['角色'].includes('角色独有测试标签'));
    assert.ok(!updated.tagsByCategory['音频'].includes('角色独有测试标签'));
    const privateMeta = (await call('/api/assets/meta?nsfw=1', undefined, editor)).data;
    assert.ok(!privateMeta.tagsByCategory || !privateMeta.tagsByCategory['角色'].includes('角色独有测试标签'));
  });
  await t.test(
    "only admin can permanently delete discarded assets and files",
    async () => {
      assert.equal(
        (await call("/api/assets/delete", { kind: "asset", id: assetId }))
          .status,
        400,
      );
      await call(
        "/api/assets/lifecycle",
        { kind: "asset", id: assetId, discarded: true },
        editor,
      );
      assert.equal(
        (await call("/api/assets/delete", { kind: "asset", id: assetId }))
          .status,
        200,
      );
      assert.equal(
        (await call("/api/assets/detail?id=" + assetId)).status,
        404,
      );
      await assert.rejects(
        fs.access(path.join(env.ASSET_LIBRARY_DIR, "objects", fileId + ".png")),
      );
    },
  );
});
