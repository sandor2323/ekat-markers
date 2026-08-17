// Карта Екатеринбурга с метками — HTTP-сервер.
// Без сторонних зависимостей: встроенный http.
// Хранение меток: Supabase (если заданы SUPABASE_URL/SUPABASE_KEY) или файл data/markers.json.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOUR = 3600 * 1000;
const HALF_HOUR = 30 * 60 * 1000;
const MAX_TEXT = 200;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_KEY);

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ---------- Хранилище: файл (локально) ---------- */

const DATA_FILE = path.join(__dirname, 'data', 'markers.json');
let markers = loadMarkers();

function loadMarkers() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveMarkers() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(markers, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function fileCleanup() {
  const now = Date.now();
  const before = markers.length;
  markers = markers.filter((m) => m.expires_at > now);
  if (markers.length !== before) saveMarkers();
}

const fileStorage = {
  async list() {
    fileCleanup();
    return markers;
  },
  async create(marker) {
    markers.push(marker);
    saveMarkers();
    return marker;
  },
  async renew(id) {
    const m = markers.find((x) => x.id === id);
    if (!m) throw httpErr(404, 'not found');
    if (m.status !== 'active') throw httpErr(400, 'only active markers can be renewed');
    if (m.expires_at <= Date.now()) {
      fileCleanup();
      throw httpErr(404, 'expired');
    }
    m.expires_at += HALF_HOUR;
    saveMarkers();
    return m;
  },
  async clear(id) {
    const m = markers.find((x) => x.id === id);
    if (!m) throw httpErr(404, 'not found');
    if (m.status !== 'active') throw httpErr(400, 'only active markers can be cleared');
    m.status = 'cleared';
    m.expires_at = Date.now() + 2 * HOUR;
    saveMarkers();
    return m;
  },
};

/* ---------- Хранилище: Supabase (на хостинге) ---------- */

const SB_TABLE = SUPABASE_URL + '/rest/v1/markers';

async function sb(query, options = {}) {
  const res = await fetch(SB_TABLE + query, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw httpErr(502, 'db error: ' + t.slice(0, 200));
  }
  return res.json();
}

const supabaseStorage = {
  async list() {
    const now = Date.now();
    await sb(`?expires_at=lte.${now}`, { method: 'DELETE' });
    return sb('?select=*&order=created_at.asc');
  },
  async create(marker) {
    const rows = await sb('', { method: 'POST', body: JSON.stringify(marker) });
    return rows[0];
  },
  async renew(id) {
    const rows = await sb(`?id=eq.${id}&select=*`);
    const m = rows[0];
    if (!m) throw httpErr(404, 'not found');
    if (m.status !== 'active') throw httpErr(400, 'only active markers can be renewed');
    if (m.expires_at <= Date.now()) throw httpErr(404, 'expired');
    const upd = await sb(`?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expires_at: m.expires_at + HALF_HOUR }),
    });
    return upd[0];
  },
  async clear(id) {
    const rows = await sb(`?id=eq.${id}&select=*`);
    const m = rows[0];
    if (!m) throw httpErr(404, 'not found');
    if (m.status !== 'active') throw httpErr(400, 'only active markers can be cleared');
    const upd = await sb(`?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cleared', expires_at: Date.now() + 2 * HOUR }),
    });
    return upd[0];
  },
};

const storage = USE_SUPABASE ? supabaseStorage : fileStorage;

/* ---------- HTTP-вспомогательное ---------- */

function sendJson(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        req.destroy();
        reject(new Error('too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (e) {
        reject(new Error('bad json'));
      }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ---------- Сервер ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // ---- API меток ----
  if (p === '/api/markers' && req.method === 'GET') {
    try {
      const list = await storage.list();
      return sendJson(res, 200, list);
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }

  if (p === '/api/markers' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'bad request' });
    }
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const text = String(body.text || '').trim().slice(0, MAX_TEXT);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return sendJson(res, 400, { error: 'invalid latitude' });
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      return sendJson(res, 400, { error: 'invalid longitude' });
    }
    const marker = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      lat,
      lng,
      text,
      status: 'active',
      expires_at: Date.now() + 2 * HOUR,
      created_at: Date.now(),
    };
    try {
      const created = await storage.create(marker);
      return sendJson(res, 201, created);
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }

  const renewMatch = p.match(/^\/api\/markers\/([\w-]+)\/renew$/);
  if (renewMatch && req.method === 'POST') {
    try {
      const m = await storage.renew(renewMatch[1]);
      return sendJson(res, 200, m);
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }

  const clearMatch = p.match(/^\/api\/markers\/([\w-]+)\/clear$/);
  if (clearMatch && req.method === 'POST') {
    try {
      const m = await storage.clear(clearMatch[1]);
      return sendJson(res, 200, m);
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }

  // ---- Статика ----
  let file = p === '/' ? '/index.html' : p;
  const full = path.join(__dirname, 'public', file);
  const publicRoot = path.join(__dirname, 'public') + path.sep;
  if (!full.startsWith(publicRoot)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — страница не найдена');
    }
    // Меняющиеся файлы не кэшируем (чтобы правки сразу были видны);
    // сторонние библиотеки в vendor/ можно кэшировать.
    const isVendor = file.startsWith('/vendor/');
    const cacheControl = isVendor ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': cacheControl,
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Карта запущена: http://localhost:${PORT}`);
  console.log(`Хранилище меток: ${USE_SUPABASE ? 'Supabase' : 'файл data/markers.json'}`);
});
