const { Readable, Writable } = require('node:stream');
const { finished } = require('node:stream/promises');

const READ = new Set(['/api/assets/meta', '/api/assets/list', '/api/assets/detail', '/api/assets/thumb']);
const WRITE = new Set(['/api/mkdir', '/api/rename', '/api/move', '/api/copy', '/api/delete',
  '/api/assets/import', '/api/assets/commit', '/api/assets/cancel-upload', '/api/assets/add-tags',
  '/api/assets/create-state', '/api/assets/move-files', '/api/assets/lifecycle', '/api/assets/copy']);

// Invoke only reviewed routes in-process, preserving their permission and conflict checks.
module.exports = function createApiBridge({ csrf, assetLibrary, handleApi }) {
  return async (parent, route, body, binary = false) => {
    const url = new URL(route, 'http://localhost');
    if (url.origin !== 'http://localhost' || url.searchParams.has('nsfw') || !(body === undefined ? READ : WRITE).has(url.pathname))
      throw new Error('API route is not available through MCP');
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = body === undefined ? 'GET' : 'POST';
    req.url = url.pathname + url.search;
    req.headers = { host: 'localhost', origin: 'http://localhost', 'x-csrf-token': csrf, 'content-type': 'application/json' };
    req.socket = parent.socket;
    req.authUser = parent.authUser;
    req._nsfwMode = false;
    const chunks = [];
    let size = 0;
    const headers = {};
    const res = new Writable({ write(chunk, encoding, callback) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) return callback(new Error('Tool response is too large; narrow your query'));
      chunks.push(Buffer.from(chunk));
      callback();
    } });
    res.statusCode = 200;
    res.headersSent = false;
    res.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
    res.getHeader = (name) => headers[name.toLowerCase()];
    res.writeHead = (status, values) => {
      res.statusCode = status;
      res.headersSent = true;
      for (const [name, value] of Object.entries(values || {})) res.setHeader(name, value);
      return res;
    };
    const completion = finished(res);
    completion.catch(() => {});
    try {
      const handled = await assetLibrary.handle(req, res, url) || await handleApi(req, res, url);
      if (!handled) throw new Error('Unknown tool operation');
      await completion;
    } catch (error) { res.destroy(); throw error; }
    const buffer = Buffer.concat(chunks);
    const mime = String(headers['content-type'] || '').split(';')[0];
    const data = mime === 'application/json' ? JSON.parse(buffer.toString('utf8')) : null;
    if (res.statusCode >= 400) throw Object.assign(new Error(data?.error || 'Operation failed'), { statusCode: res.statusCode });
    if (binary) return { buffer, mime };
    if (!data) throw new Error('Expected a JSON tool response');
    return data;
  };
};
