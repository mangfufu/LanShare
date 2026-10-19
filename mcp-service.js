const crypto = require('node:crypto');
const os = require('node:os');
const net = require('node:net');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const registerTools = require('./mcp-tools');

const SCOPES = ['files:read', 'files:write', 'assets:read', 'assets:write'];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const address = (ip) => String(ip || '').replace(/^::ffff:/, '').split('%')[0];
function isLan(ip) {
  ip = address(ip);
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  return net.isIP(ip) === 6 && (ip === '::1' || /^(fc|fd|fe[89ab])/i.test(ip));
}
async function json(req, limit = 256 * 1024) {
  let size = 0;
  const chunks = [];
  if (Number(req.headers['content-length']) > limit) fail('Request too large', 413);
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail('Request too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Invalid JSON'); }
}

module.exports = function createMcpService(h) {
  let initialized = false;
  const busy = new Set();
  let active = 0;
  function db() {
    const database = h.database();
    if (!initialized) {
      database.exec(`CREATE TABLE IF NOT EXISTS mcp_tokens (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, password_version TEXT NOT NULL,
        scopes TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        last_used_at INTEGER, revoked_at INTEGER
      )`);
      initialized = true;
    }
    return database;
  }
  function authenticate(req) {
    const match = /^Bearer (lsm_[a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (!match) fail('A Bearer MCP token is required', 401);
    const row = db().prepare(`SELECT t.*,u.username,u.name AS user_name,u.role,u.enabled,u.password_hash
      FROM mcp_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=?`).get(hash(match[1]));
    if (!row || !row.enabled || row.revoked_at || row.expires_at <= Date.now() || row.password_version !== hash(row.password_hash))
      fail('MCP token is invalid, expired or revoked', 401);
    const user = h.publicUser({ ...row, id: row.user_id, name: row.user_name });
    return { id: row.id, name: row.name, user, scopes: JSON.parse(row.scopes) };
  }
  function networkGuard(req) {
    if (!isLan(req.socket.remoteAddress)) fail('MCP is restricted to the local network', 403);
    const hosts = new Set(['localhost', '127.0.0.1', '::1', address(req.socket.localAddress)]);
    for (const items of Object.values(os.networkInterfaces())) for (const item of items || []) hosts.add(address(item.address));
    for (const host of (process.env.MCP_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) hosts.add(host);
    let url;
    try { url = new URL(`http://${req.headers.host}`); } catch { fail('Invalid Host', 403); }
    if (!hosts.has(url.hostname.replace(/^\[|\]$/g, '').toLowerCase()) || url.username || url.password) fail('Host is not allowed', 403);
    if (req.headers.origin && req.headers.origin !== `${req.socket.encrypted ? 'https' : 'http'}://${url.host}`)
      fail('Origin is not allowed', 403);
  }
  async function tokens(req, res) {
    if (!req.authUser) fail('Please sign in', 401);
    res.setHeader('Cache-Control', 'no-store');
    const database = db();
    if (req.method === 'GET') {
      const items = database.prepare(`SELECT id,name,scopes,created_at AS createdAt,expires_at AS expiresAt,last_used_at AS lastUsedAt
        FROM mcp_tokens WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC`).all(req.authUser.id)
        .map((row) => ({ ...row, scopes: JSON.parse(row.scopes) }));
      h.sendJson(res, 200, { items, canWrite: h.hasPermission(req.authUser, 'files.write'), enabled: process.env.MCP_ENABLED !== '0' });
      return;
    }
    if (req.method !== 'POST') fail('Method not allowed', 405);
    h.assertWrite(req);
    const body = await json(req, 8192);
    if (body.action === 'revoke') {
      if (typeof body.id !== 'string') fail('Invalid token ID');
      const changed = database.prepare('UPDATE mcp_tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL')
        .run(Date.now(), body.id, req.authUser.id).changes;
      if (!changed) fail('Token not found', 404);
      h.audit(req, 'MCP/revoke');
      h.sendJson(res, 200, { ok: true });
      return;
    }
    if (body.action !== 'create') fail('Unknown action');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60) fail('Name must be 1-60 characters');
    if (!Array.isArray(body.scopes) || !body.scopes.length || body.scopes.some((s) => !SCOPES.includes(s))) fail('Invalid scopes');
    const scopes = [...new Set(body.scopes)];
    if (scopes.some((s) => s.endsWith(':write')) && !h.hasPermission(req.authUser, 'files.write')) fail('Account is read-only', 403);
    for (const scope of [...scopes]) if (scope.endsWith(':write') && !scopes.includes(scope.replace(':write', ':read'))) scopes.push(scope.replace(':write', ':read'));
    if (!Number.isInteger(body.days) || body.days < 1 || body.days > 90) fail('Expiry must be 1-90 days');
    const user = database.prepare('SELECT password_hash FROM users WHERE id=? AND enabled=1').get(req.authUser.id);
    if (!user || typeof body.password !== 'string' || body.password.length > 128 || !await h.verifyPassword(body.password, user.password_hash)) fail('Password is incorrect', 403);
    if (database.prepare('SELECT count(*) AS n FROM mcp_tokens WHERE user_id=? AND revoked_at IS NULL AND expires_at>?').get(req.authUser.id, Date.now()).n >= 10)
      fail('Revoke an existing token first (maximum 10 active tokens)', 409);
    const token = 'lsm_' + crypto.randomBytes(32).toString('hex');
    const id = crypto.randomUUID(), now = Date.now(), expiresAt = now + body.days * 86400000;
    database.prepare('INSERT INTO mcp_tokens(id,user_id,name,token_hash,password_version,scopes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, req.authUser.id, name, hash(token), hash(user.password_hash), JSON.stringify(scopes), now, expiresAt);
    h.audit(req, 'MCP/create-token');
    h.sendJson(res, 201, { id, token, scopes, expiresAt });
  }
  async function handle(req, res, url) {
    if (url.pathname !== '/mcp' && url.pathname !== '/api/mcp/tokens') return false;
    let mcp, transport, identity, acquired = false;
    const pending = new Set();
    try {
      if (active >= 16) fail('MCP is busy; retry later', 429);
      active++;
      try {
        if (url.pathname === '/api/mcp/tokens') { await tokens(req, res); return true; }
        if (process.env.MCP_ENABLED === '0') fail('MCP is disabled', 503);
        networkGuard(req);
        if (url.search) fail('Query parameters are not accepted');
        identity = authenticate(req);
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          fail('Only POST is supported (stateless Streamable HTTP)', 405);
        }
        if (busy.has(identity.id)) fail('Another request is running for this token; retry later', 429);
        busy.add(identity.id);
        acquired = true;
        const body = await json(req);
        db().prepare('UPDATE mcp_tokens SET last_used_at=? WHERE id=?').run(Date.now(), identity.id);
        mcp = new McpServer({ name: 'lanshare', version: require('./package.json').version });
        registerTools(mcp, {
          ...h,
          request: req,
          authorize(scope) {
            const current = authenticate(req);
            const write = scope.endsWith(':write');
            if (!current.scopes.includes(scope) || !h.hasPermission(current.user, write ? 'files.write' : 'files.read')) fail('Permission denied', 403);
            return current.user;
          },
          identity,
          pending,
        });
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await mcp.connect(transport);
        const completed = new Promise((resolve) => { res.once('finish', resolve); res.once('close', resolve); });
        await transport.handleRequest(req, res, body);
        await completed;
        await Promise.allSettled(pending);
      } finally { active--; }
    } catch (error) {
      if (!res.headersSent) {
        if (error.statusCode === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="LanShare MCP"');
        h.sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'MCP request failed' }, { 'Cache-Control': 'no-store' });
      }
    } finally {
      if (transport) await transport.close().catch(() => {});
      if (mcp) await mcp.close().catch(() => {});
      if (acquired) busy.delete(identity.id);
    }
    return true;
  }
  return { handle };
};
