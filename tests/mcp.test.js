const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

test('MCP integration', { timeout: 120000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lanshare-mcp-'));
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), MCP_ENABLED: '1', DAILY_BACKUP_ENABLED: '0' };
  for (const [key, filename] of Object.entries({ SHARED_DIR: 'files', NSFW_DIR: 'private', BACKUP_DIR: 'backup', RECYCLE_DIR: 'recycle', LOG_DIR: 'logs', THUMB_CACHE_DIR: 'thumb', FOLDER_SIZE_CACHE_FILE: 'sizes.json', FORUM_DB_FILE: 'forum.db', AUTH_DB_FILE: 'auth.db', NSFW_PASSWORD_FILE: 'nsfw.txt', ASSET_LIBRARY_DIR: 'library' })) env[key] = path.join(temp, filename);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => output += data);
  child.stderr.on('data', (data) => output += data);
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let csrf;
  for (let i = 0; i < 200; i++) {
    try { csrf = (await fetch(base + '/api/security').then((res) => res.json())).csrfToken; break; } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(csrf, output);
  async function api(route, body, cookie = '', headers = {}) {
    const res = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' });
    return { status: res.status, headers: res.headers, data: await res.json() };
  }
  async function register(username) {
    const result = await api('/api/auth/register', { username, name: username, password: 'TestPass123' });
    assert.equal(result.status, 201);
    return result.headers.getSetCookie()[0].split(';')[0];
  }
  const admin = await register('mcpadmin'), guest = await register('mcpguest'), editor = await register('mcpeditor');
  function sql(query, ...args) { const db = new DatabaseSync(env.AUTH_DB_FILE); try { return db.prepare(query).run(...args); } finally { db.close(); } }
  sql("UPDATE users SET role='editor' WHERE username='mcpeditor'");
  async function token(cookie, scopes = ['files:read', 'assets:read']) {
    const result = await api('/api/mcp/tokens', { action: 'create', name: 'Test agent', password: 'TestPass123', days: 30, scopes }, cookie);
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;
  }
  async function client(token) {
    const instance = new Client({ name: 'integration-test', version: '1.0.0' });
    clients.push(instance);
    await instance.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    return instance;
  }
  function data(result) { assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text); }
  const readonly = await token(guest), writable = await token(editor, ['files:read', 'files:write', 'assets:read', 'assets:write']);
  const reader = await client(readonly.token), writer = await client(writable.token);
  await fs.writeFile(path.join(env.SHARED_DIR, 'note.txt'), 'workspace text');
  await fs.writeFile(path.join(env.SHARED_DIR, '.secret.txt'), 'hidden');
  await fs.writeFile(path.join(env.NSFW_DIR, 'private.txt'), 'not accessible');
  await fs.mkdir(path.join(env.SHARED_DIR, 'destination'));
  const image = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#458a64' } }).png().toBuffer();
  await fs.writeFile(path.join(env.SHARED_DIR, 'sample.png'), image);
  await t.test('token lifecycle requires session, password, CSRF and scoped authority', async () => {
    assert.equal((await api('/api/mcp/tokens')).status, 401);
    assert.equal((await api('/api/mcp/tokens', { action: 'create' }, admin, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await api('/api/mcp/tokens', { action: 'create', name: 'bad', scopes: ['files:write'], days: 30, password: 'TestPass123' }, guest)).status, 403);
    assert.equal((await api('/api/mcp/tokens', { action: 'create', name: 'bad', scopes: ['files:read'], days: 30, password: 'wrong' }, editor)).status, 403);
    const list = await api('/api/mcp/tokens', undefined, editor);
    assert.equal(list.data.items.length, 1);
    assert.ok(!JSON.stringify(list.data).includes(writable.token));
    assert.ok(!JSON.stringify(list.data).includes('token_hash'));
    assert.equal((await api('/api/mcp/tokens', { action: 'revoke', id: writable.id }, guest)).status, 404);
    const db = new DatabaseSync(env.AUTH_DB_FILE);
    assert.notEqual(db.prepare('SELECT token_hash FROM mcp_tokens WHERE id=?').get(writable.id).token_hash, writable.token);
    db.close();
  });
  await t.test('network endpoint rejects missing bearer, cookie-only, bad Host, Origin and query tokens', async () => {
    for (const headers of [{}, { Cookie: admin }]) assert.equal((await fetch(base + '/mcp', { method: 'POST', headers })).status, 401);
    for (const headers of [{ Host: 'attacker.example' }, { Origin: 'https://attacker.example' }]) {
      const status = await new Promise((resolve, reject) => {
        const req = http.request(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + writable.token, ...headers } }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      });
      assert.equal(status, 403);
    }
    assert.equal((await fetch(base + '/mcp?token=no', { headers: { Authorization: 'Bearer ' + writable.token } })).status, 400);
    assert.equal((await fetch(base + '/mcp', { headers: { Authorization: 'Bearer ' + writable.token } })).status, 405);
  });
  await t.test('official SDK handshake, tool discovery, reads and path boundaries', async () => {
    const tools = (await reader.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes('workspace_list'));
    assert.ok(!tools.includes('workspace_mkdir'));
    assert.ok(!tools.some((name) => /permanent|shell|execute|admin/.test(name)));
    const listing = data(await reader.callTool({ name: 'workspace_list', arguments: {} }));
    assert.ok(listing.items.some((item) => item.path === 'note.txt'));
    assert.ok(!listing.items.some((item) => item.path.startsWith('.')));
    assert.equal(data(await reader.callTool({ name: 'workspace_read_text', arguments: { path: 'note.txt' } })).text, 'workspace text');
    for (const p of ['../auth.db', '/etc/passwd', 'C:\\Windows', '.secret.txt', 'destination/../note.txt']) {
      assert.equal((await reader.callTool({ name: 'workspace_read_text', arguments: { path: p } })).isError, true);
    }
    await fs.symlink(env.NSFW_DIR, path.join(env.SHARED_DIR, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await reader.callTool({ name: 'workspace_list', arguments: { dir: 'escape' } })).isError, true);
    assert.equal((await reader.callTool({ name: 'workspace_preview_image', arguments: { path: 'sample.png' } })).content[0].type, 'image');
    assert.equal(data(await reader.callTool({ name: 'workspace_search', arguments: { query: 'note' } })).items[0].path, 'note.txt');
  });
  await t.test('file writes reuse conflict checks and do not operate on directories', async () => {
    data(await writer.callTool({ name: 'workspace_mkdir', arguments: { name: 'newfolder' } }));
    data(await writer.callTool({ name: 'workspace_copy', arguments: { path: 'note.txt', targetDir: 'destination' } }));
    assert.equal((await writer.callTool({ name: 'workspace_move', arguments: { path: 'note.txt', targetDir: 'destination' } })).isError, true);
    assert.equal(await fs.readFile(path.join(env.SHARED_DIR, 'note.txt'), 'utf8'), 'workspace text');
    data(await writer.callTool({ name: 'workspace_rename', arguments: { path: 'destination/note.txt', newName: 'renamed.txt' } }));
    assert.equal((await writer.callTool({ name: 'workspace_recycle', arguments: { path: 'newfolder', confirm: true } })).isError, true);
    assert.equal((await writer.callTool({ name: 'workspace_recycle', arguments: { path: 'destination/renamed.txt' } })).isError, true);
    data(await writer.callTool({ name: 'workspace_recycle', arguments: { path: 'destination/renamed.txt', confirm: true } }));
    await assert.rejects(fs.stat(path.join(env.SHARED_DIR, 'destination/renamed.txt')), { code: 'ENOENT' });
  });
  let assetId;
  await t.test('asset import, tags, preview, state movement, discard and restore', async () => {
    const imported = data(await writer.callTool({ name: 'asset_import_files', arguments: { paths: ['sample.png'], name: 'Character', category: '角色', tags: ['男性'] } }));
    assetId = imported.ids[0];
    let detail = data(await writer.callTool({ name: 'asset_detail', arguments: { id: assetId } }));
    const file = detail.states[0].files[0];
    assert.equal((await reader.callTool({ name: 'asset_preview_image', arguments: { id: file.id } })).content[0].type, 'image');
    data(await writer.callTool({ name: 'asset_add_tags', arguments: { id: assetId, tags: ['常用'] } }));
    detail = data(await writer.callTool({ name: 'asset_detail', arguments: { id: assetId } }));
    const state = data(await writer.callTool({ name: 'asset_create_state', arguments: { id: assetId, name: 'Other', revision: detail.revision } }));
    detail = data(await writer.callTool({ name: 'asset_detail', arguments: { id: assetId } }));
    data(await writer.callTool({ name: 'asset_move_files', arguments: { id: assetId, ids: [file.id], stateId: state.id, revision: detail.revision } }));
    data(await writer.callTool({ name: 'asset_copy_files', arguments: { id: assetId, ids: [file.id], targetDir: 'destination' } }));
    assert.deepEqual(await fs.readFile(path.join(env.SHARED_DIR, 'destination/sample.png')), image);
    for (const discarded of [true, false]) data(await writer.callTool({ name: 'asset_lifecycle', arguments: { kind: 'asset', id: assetId, discarded, confirm: true } }));
    assert.equal((await writer.callTool({ name: 'asset_import_files', arguments: { paths: ['sample.png'], name: 'Duplicate', category: '角色' } })).isError, true);
    const db = new DatabaseSync(path.join(env.ASSET_LIBRARY_DIR, 'library.db'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM files WHERE asset_id IS NULL').get().n, 0); db.close();
  });
  if (process.env.ASSET_BROWSER_TEST === '1') await t.test('token UI works on desktop and mobile without exposing stored secrets', async () => {
    const { chromium, executablePath } = require('./browser.cjs');
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const [name, value] = editor.split('=');
        await context.addCookies([{ name, value, url: base }]);
        const page = await context.newPage(), errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(base);
        await page.locator('#nicknameDisplay').click();
        await page.locator('#accountMcpBtn').click();
        await page.locator('#mcpTokenList .mcp-token-row').first().waitFor();
        await page.locator('#mcpName').fill('Browser token ' + width);
        await page.locator('#mcpPassword').fill('TestPass123');
        await page.locator('#mcpCreate').click();
        await page.locator('#mcpCreated').waitFor({ state: 'visible' });
        const config = JSON.parse(await page.locator('#mcpConfig').inputValue());
        assert.equal(config.mcpServers.lanshare.url, base + '/mcp');
        assert.match(config.mcpServers.lanshare.headers.Authorization, /^Bearer lsm_/);
        const bounds = await page.locator('#mcpDialog').boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        assert.equal(await page.locator('#mcpDialog').evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
        const shots = path.resolve(__dirname, '../../.validation/mcp');
        await fs.mkdir(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, `access-${width}.png`) });
        await page.locator('#mcpClose').click();
        await page.locator('#mcpDialog').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#mcpConfig').inputValue(), '');
        await page.locator('#nicknameDisplay').click();
        await page.locator('#accountMcpBtn').click();
        const row = page.locator('.mcp-token-row').filter({ hasText: 'Browser token ' + width });
        await row.getByRole('button', { name: '撤销' }).click();
        await row.waitFor({ state: 'detached' });
        assert.deepEqual(errors, []);
        await context.close();
      }
    } finally { await browser.close(); }
  });
  await t.test('roles, revoked tokens, disabled accounts and password changes take effect immediately', async () => {
    sql("UPDATE users SET role='guest' WHERE username='mcpeditor'");
    assert.equal((await writer.callTool({ name: 'workspace_mkdir', arguments: { name: 'denied' } })).isError, true);
    sql("UPDATE users SET role='editor' WHERE username='mcpeditor'");
    sql("UPDATE users SET enabled=0 WHERE username='mcpeditor'");
    await assert.rejects(writer.listTools());
    sql("UPDATE users SET enabled=1 WHERE username='mcpeditor'");
    const revoked = await token(editor);
    await api('/api/mcp/tokens', { action: 'revoke', id: revoked.id }, editor);
    assert.equal((await fetch(base + '/mcp', { headers: { Authorization: 'Bearer ' + revoked.token } })).status, 401);
    sql("UPDATE mcp_tokens SET expires_at=0 WHERE id=?", readonly.id);
    await assert.rejects(reader.listTools());
    sql("UPDATE users SET password_hash='changed' WHERE username='mcpeditor'");
    await assert.rejects(writer.listTools());
  });
});
