// Карта Екатеринбурга с метками — HTTP-сервер.
// Без сторонних зависимостей: встроенный http.
// Авторизация: Supabase Auth (никнейм = email-заглушка), метки с проверкой JWT.
// Локально (без SUPABASE_*) — упрощённый режим без реальной проверки.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOUR = 3600 * 1000;
const HALF_HOUR = 30 * 60 * 1000;
const MAX_TEXT = 200;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const EMAIL_DOMAIN = '@users.kartalgcekb.ru';
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

// Кому разрешена кнопка «Чисто» (никнеймы через запятую, регистр не важен).
// Пусто = разрешено всем (поведение по умолчанию). Задаётся в переменной
// окружения ALLOWED_CLEAR_USERS (в панели Amvera: Настройки → Переменные).
const ALLOWED_CLEAR_USERS = (process.env.ALLOWED_CLEAR_USERS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// Служебный email из никнейма: кириллица -> латиница (база принимает только ASCII).
function nickToEmail(name) {
  const ruMap = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
    щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  let ascii = '';
  for (const ch of String(name).toLowerCase()) {
    ascii += (ruMap[ch] !== undefined ? ruMap[ch] : ch);
  }
  ascii = ascii.replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z0-9]+/, '');
  if (!ascii) {
    // Фолбэк: детерминированный ASCII-хэш (например, ник из одних цифр)
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    ascii = 'user' + h.toString(36);
  }
  return ascii + EMAIL_DOMAIN;
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ---------- Supabase Auth / REST ---------- */

async function sbFetch(path, options = {}, token) {
  const res = await fetch(SUPABASE_URL + path, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + (token || SUPABASE_ANON_KEY),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw httpErr(res.status, 'db/auth error: ' + t.slice(0, 200));
  }
  // База может ответить 204 No Content (пустое тело) — это не ошибка.
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw httpErr(502, 'bad json from db: ' + text.slice(0, 100));
  }
}

async function registerUser(name, pass) {
  const email = nickToEmail(name);
  // Создаём пользователя через Admin API (service_role)
  const user = await sbFetch('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password: pass, email_confirm: true }),
  }, SUPABASE_SERVICE_KEY);
  if (!user || !user.id) {
    throw httpErr(502, 'Сервис регистрации не вернул ответ (проверьте SUPABASE_SERVICE_KEY)');
  }
  // Профиль: никнейм
  await sbFetch('/rest/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ user_id: user.id, nickname: name }),
  }, SUPABASE_SERVICE_KEY);
  return name;
}

async function loginUser(name, pass) {
  const email = nickToEmail(name);
  const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password: pass }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw httpErr(401, 'Неверный никнейм или пароль');
  }
  const data = await res.json().catch(() => null);
  if (!data || !data.access_token) {
    throw httpErr(502, 'Сервис входа не вернул токен');
  }
  return data.access_token;
}

async function userFromToken(token) {
  const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw httpErr(401, 'Требуется вход');
  const data = await res.json().catch(() => null);
  if (!data) throw httpErr(502, 'Сервис входа не ответил');
  return data;
}

async function nicknameOf(userId, token) {
  try {
    const rows = await sbFetch(
      `/rest/v1/profiles?user_id=eq.${userId}&select=nickname`,
      {}, token
    );
    return (rows[0] && rows[0].nickname) || '';
  } catch (e) {
    return '';
  }
}

/* ---------- Хранилище меток ---------- */

// Supabase: RLS проверяет auth.uid() === user_id
const supabaseStorage = {
  async list() {
    // Истёкшие метки не показываем (фильтр вместо DELETE — в 2 раза быстрее:
    // один запрос к базе вместо двух). Удаляются фоновой чисткой ниже.
    const rows = await sbFetch(
      `/rest/v1/markers?select=*&expires_at=gt.${Date.now()}&order=created_at.asc`
    );
    return rows || [];
  },
  async create(marker, token) {
    const rows = await sbFetch('/rest/v1/markers', {
      method: 'POST',
      body: JSON.stringify(marker),
      headers: { Prefer: 'return=representation' },
    }, token);
    return rows[0];
  },
  async update(id, patch, token) {
    const rows = await sbFetch(`/rest/v1/markers?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      headers: { Prefer: 'return=representation' },
    }, token);
    if (!rows || rows.length === 0) {
      // База не обновила ни одной строки: запись не найдена или RLS-политика
      // запрещает UPDATE. Отдаём понятную ошибку, а не пустое тело.
      throw httpErr(502, 'Метка не обновлена в базе: запись не найдена или политика доступа (RLS) запрещает изменение. Проверьте политики UPDATE в Supabase.');
    }
    return rows[0];
  },
  async delete(id, token) {
    const rows = await sbFetch(`/rest/v1/markers?id=eq.${id}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    }, token);
    if (!rows || rows.length === 0) throw httpErr(404, 'not found');
    return rows[0];
  },
  async get(id) {
    const rows = await sbFetch(`/rest/v1/markers?id=eq.${id}&select=*`);
    return rows[0];
  },
};

// Файловый fallback (локально, без auth)
const DATA_FILE = path.join(__dirname, 'data', 'markers.json');
let fileMarkers = [];
try {
  const raw = fs.readFileSync(DATA_FILE, 'utf8').replace(/^\uFEFF/, '');
  fileMarkers = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
} catch (e) { /* нет файла */ }

function fileSave() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(fileMarkers, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

const fileStorage = {
  async list() {
    const now = Date.now();
    fileMarkers = fileMarkers.filter((m) => m.expires_at > now);
    return fileMarkers;
  },
  async create(marker) {
    fileMarkers.push(marker);
    fileSave();
    return marker;
  },
  async update(id, patch) {
    const m = fileMarkers.find((x) => x.id === id);
    if (!m) throw httpErr(404, 'not found');
    Object.assign(m, patch);
    fileSave();
    return m;
  },
  async delete(id) {
    const i = fileMarkers.findIndex((x) => x.id === id);
    if (i < 0) throw httpErr(404, 'not found');
    fileMarkers.splice(i, 1);
    fileSave();
    return { ok: true };
  },
  async get(id) {
    return fileMarkers.find((x) => x.id === id);
  },
};

const storage = USE_SUPABASE ? supabaseStorage : fileStorage;

// Фоновая чистка истёкших меток: раз в 10 минут, чтобы не тормозить запросы
// списка (раньше DELETE выполнялся при каждом обращении к /api/markers).
if (USE_SUPABASE) {
  setInterval(async () => {
    try {
      await sbFetch(`/rest/v1/markers?expires_at=lte.${Date.now()}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      });
    } catch (e) { /* фоновая чистка не должна ронять сервер */ }
  }, 10 * 60 * 1000);
}

/* ---------- HTTP ---------- */

function sendJson(res, code, data) {
  const body = JSON.stringify(data === undefined ? null : data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) { req.destroy(); reject(new Error('too large')); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(new Error('bad json')); }
    });
  });
}

function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // ---- Регистрация ----
  if (p === '/api/register' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'bad request' }); }
    const name = String(body.name || '').trim().slice(0, 30);
    const pass = String(body.pass || '');
    if (!/^[^\s]{1,30}$/.test(name)) return sendJson(res, 400, { error: 'Никнейм: 1-30 символов, без пробелов' });
    if (pass.length < 4) return sendJson(res, 400, { error: 'Пароль: минимум 4 символа' });
    try {
      let token = 'local';
      if (USE_SUPABASE) {
        await registerUser(name, pass);
        token = await loginUser(name, pass);
      }
      return sendJson(res, 200, { ok: true, name, token });
    } catch (e) {
      const msg = e.status === 422 ? 'Никнейм уже занят' : e.message;
      return sendJson(res, e.status || 500, { error: msg });
    }
  }

  // ---- Вход ----
  if (p === '/api/login' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'bad request' }); }
    const name = String(body.name || '').trim().slice(0, 30);
    const pass = String(body.pass || '');
    try {
      const token = USE_SUPABASE ? await loginUser(name, pass) : 'local';
      return sendJson(res, 200, { ok: true, name, token });
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }

  // ---- Конфигурация для клиента (видимость кнопки «Чисто») ----
  if (p === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      allowedClear: ALLOWED_CLEAR_USERS,
      clearAll: ALLOWED_CLEAR_USERS.length === 0,
    });
  }

  // ---- Метки: список ----
  if (p === '/api/markers' && req.method === 'GET') {
    try {
      const list = await storage.list();
      return sendJson(res, 200, list);
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }

  // ---- Метки: создать ----
  if (p === '/api/markers' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'bad request' }); }
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const text = String(body.text || '').trim().slice(0, MAX_TEXT);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return sendJson(res, 400, { error: 'invalid latitude' });
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return sendJson(res, 400, { error: 'invalid longitude' });

    try {
      let userId = null;
      let createdBy = '';
      if (USE_SUPABASE) {
        const token = bearerToken(req);
        if (!token) throw httpErr(401, 'Требуется вход');
        const user = await userFromToken(token);
        userId = user.id;
        createdBy = await nicknameOf(user.id, token);
      } else {
        createdBy = String(body.created_by || '').trim().slice(0, 30);
      }
      const marker = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        lat, lng, text,
        user_id: userId,
        created_by: createdBy,
        status: 'active',
        expires_at: Date.now() + 2 * HOUR,
        created_at: Date.now(),
      };
      const created = await storage.create(marker, bearerToken(req));
      return sendJson(res, 201, created);
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }

  // ---- Метки: продлить / чисто / удалить ----
  const actionMatch = p.match(/^\/api\/markers\/([\w-]+)\/(renew|clear|delete)$/);
  if (actionMatch && req.method === 'POST') {
    const id = actionMatch[1];
    const act = actionMatch[2];
    try {
      const existing = await storage.get(id);
      if (!existing) throw httpErr(404, 'not found');
      if (existing.status !== 'active') throw httpErr(400, 'only active markers can be ' + (act === 'renew' ? 'renewed' : (act === 'clear' ? 'cleared' : 'deleted')));
      if (existing.expires_at <= Date.now()) throw httpErr(404, 'expired');
      // «Чисто» и «Удалить» — только пользователям из списка ALLOWED_CLEAR_USERS
      if (act !== 'renew' && ALLOWED_CLEAR_USERS.length > 0) {
        if (!USE_SUPABASE) throw httpErr(403, '«Чисто» и «Удалить» доступны только определённым пользователям');
        const token = bearerToken(req);
        if (!token) throw httpErr(401, 'Требуется вход');
        const user = await userFromToken(token);
        const nick = String(await nicknameOf(user.id, token) || '').toLowerCase();
        if (!ALLOWED_CLEAR_USERS.includes(nick)) {
          throw httpErr(403, 'Нет прав: «Чисто» и «Удалить» доступны только определённым пользователям');
        }
      }
      if (act === 'delete') {
        await storage.delete(id, bearerToken(req));
        return sendJson(res, 200, { ok: true });
      }
      const patch = act === 'renew'
        ? { expires_at: existing.expires_at + HALF_HOUR }
        : { status: 'cleared', expires_at: Date.now() + 2 * HOUR };
      const updated = await storage.update(id, patch, bearerToken(req));
      return sendJson(res, 200, updated);
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }

  // ---- Статика ----
  let file = p === '/' ? '/index.html' : p;
  const full = path.join(__dirname, 'public', file);
  const publicRoot = path.join(__dirname, 'public') + path.sep;
  if (!full.startsWith(publicRoot)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — страница не найдена');
    }
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
  console.log(`Хранилище: ${USE_SUPABASE ? 'Supabase (Auth + RLS)' : 'файл (локально)'}`);
});
