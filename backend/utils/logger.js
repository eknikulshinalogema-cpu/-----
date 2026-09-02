// logger.js
// Простой логгер, который НИКОГДА не пишет в лог персональные данные,
// содержимое сделок или сам API-ключ. Логируем только техническую
// информацию: метод, путь, код ответа, время выполнения, тип ошибки.

function timestamp() {
  return new Date().toISOString();
}

function info(message, meta = {}) {
  console.log(`[${timestamp()}] [INFO] ${message}`, safeMeta(meta));
}

function warn(message, meta = {}) {
  console.warn(`[${timestamp()}] [WARN] ${message}`, safeMeta(meta));
}

function error(message, meta = {}) {
  console.error(`[${timestamp()}] [ERROR] ${message}`, safeMeta(meta));
}

// Список ключей, которые запрещено логировать, даже если их случайно передадут.
const FORBIDDEN_KEYS = [
  'apikey', 'api_key', 'x-api-key', 'authorization', 'token',
  'title', 'opportunity', 'comment', 'email', 'phone',
];

function safeMeta(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const clean = {};
  for (const [key, value] of Object.entries(meta)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
      clean[key] = '[скрыто]';
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

module.exports = { info, warn, error };
