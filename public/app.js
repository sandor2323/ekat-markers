/* Карта Екатеринбурга с метками — клиентская логика (Leaflet + тайлы Яндекса). */

const LIFETIME = 2 * 60 * 60 * 1000; // 2 часа
const RENEW_TIME = 30 * 60 * 1000; // +30 минут
const POLL_MS = 10 * 1000; // опрос сервера раз в 10 сек

const map = L.map('map', { attributionControl: false }).setView([56.8389, 60.6057], 13);

L.tileLayer(
  'https://core-renderer-tiles.maps.yandex.net/tiles?l=map&v=21.10.5&x={x}&y={y}&z={z}&scale=1&lang=ru_RU',
  { maxZoom: 18 }
).addTo(map);

/* ---------- Вспомогательное ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Цвет активной метки: 100% остатка = красный, 0% = синий (плавно).
function activeColor(expiresAt) {
  const remain = Math.max(0, expiresAt - Date.now());
  const t = Math.min(1, remain / LIFETIME);
  const r = Math.round(255 * t);
  const b = Math.round(255 * (1 - t));
  return `rgb(${r}, 30, ${b})`;
}

function fmtTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h} ч ${mm} мин` : `${mm}:${ss}`;
}

/* ---------- API ---------- */

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Ошибка запроса');
  }
  return res.json();
}

/* ---------- Метки на карте ---------- */

const layerGroup = L.layerGroup().addTo(map);
let markers = [];

function markerIcon(m) {
  const size = m.status === 'cleared' ? 18 : 16;
  const color = m.status === 'cleared' ? '#2ecc40' : activeColor(m.expires_at);
  return L.divIcon({
    className: '',
    html: `<div class="marker-dot" style="width:${size}px;height:${size}px;background:${color}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function popupHtml(m) {
  const remain = m.expires_at - Date.now();
  const cleared = m.status === 'cleared';
  const timeHtml = cleared
    ? `<div class="popup-time dim">Закрыто, осталось ${fmtTime(remain)}</div>`
    : `<div class="popup-time">Осталось: ${fmtTime(remain)}</div>`;
  const actions = cleared
    ? ''
    : `<div class="popup-actions">
        <button class="btn btn-renew" data-act="renew" data-id="${m.id}">Продлить +30 мин</button>
        <button class="btn btn-clear" data-act="clear" data-id="${m.id}">Чисто</button>
       </div>`;
  const textHtml = m.text ? `<div class="popup-text">${esc(m.text)}</div>` : '';
  return `${textHtml}${timeHtml}${actions}`;
}

function updatePopup(marker) {
  marker.setPopupContent(popupHtml(marker.__data));
}

function renderAll() {
  layerGroup.clearLayers();
  markers.forEach((m) => {
    const marker = L.marker([m.lat, m.lng], { icon: markerIcon(m) }).addTo(layerGroup);
    marker.__data = m;
    marker.on('click', () => updatePopup(marker));
    marker.bindPopup(popupHtml(m), { closeButton: true, autoClose: false });
  });
}

// Действия из попапа (делегирование на документе).
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  btn.disabled = true;
  try {
    if (act === 'renew') {
      await api(`/api/markers/${id}/renew`, { method: 'POST' });
    } else if (act === 'clear') {
      await api(`/api/markers/${id}/clear`, { method: 'POST' });
    }
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

/* ---------- Диалог «Поставить метку?» ---------- */

const askBox = document.getElementById('ask-box');
let pendingLatLng = null;

function closeDialogs() {
  askBox.classList.add('hidden');
  pendingLatLng = null;
}

function showDialog(box, point) {
  box.classList.remove('hidden');
  const rect = box.getBoundingClientRect();
  let left = point.x - rect.width / 2;
  let top = point.y - rect.height - 16;
  left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, left));
  top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, top));
  box.style.left = left + 'px';
  box.style.top = top + 'px';
}

map.on('contextmenu', (e) => {
  // Блокируем нативное меню браузера (важно на мобильных при долгом нажатии)
  if (e.originalEvent) e.originalEvent.preventDefault();
  pendingLatLng = e.latlng;
  showDialog(askBox, e.containerPoint);
});

document.getElementById('ask-yes').addEventListener('click', async () => {
  if (!pendingLatLng) return;
  askBox.classList.add('hidden');
  try {
    await api('/api/markers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: pendingLatLng.lat,
        lng: pendingLatLng.lng,
      }),
    });
    closeDialogs();
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('ask-no').addEventListener('click', closeDialogs);

// Закрытие по клику мимо или по Esc
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.ask-box')) closeDialogs();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDialogs();
});

// Долгое нажатие (тач) вместо ПКМ
let longPressTimer = null;
map.on('touchstart', (e) => {
  if (e.touches && e.touches.length !== 1) return;
  clearTimeout(longPressTimer);
  const touch = e.touches[0];
  longPressTimer = setTimeout(() => {
    const latlng = map.mouseEventToLatLng(touch);
    const point = map.mouseEventToContainerPoint(touch);
    map.fire('contextmenu', { latlng, containerPoint: point });
  }, 550);
});
map.on('touchend', () => clearTimeout(longPressTimer));
map.on('touchmove', () => clearTimeout(longPressTimer));

// При повороте экрана пересчитываем размер карты
window.addEventListener('orientationchange', () => {
  setTimeout(() => map.invalidateSize(), 200);
});

/* ---------- Обновление ---------- */

async function refresh() {
  try {
    const data = await api('/api/markers');
    markers = data;
    renderAll();
  } catch (err) {
    console.error('Не удалось обновить метки:', err);
  }
}

// Каждую секунду — цвета активных меток и время в открытом попапе.
setInterval(() => {
  layerGroup.eachLayer((marker) => {
    const m = marker.__data;
    if (!m) return;
    if (m.status !== 'cleared') {
      marker.setIcon(markerIcon(m));
    }
    if (marker.isPopupOpen()) updatePopup(marker);
  });
}, 1000);

setInterval(refresh, POLL_MS);
refresh();
