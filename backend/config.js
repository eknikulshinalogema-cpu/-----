// config.js
// Централизованная загрузка конфигурации из переменных окружения.
// Ключи и секреты никогда не хранятся в коде — только в .env (см. .env.example).

require('dotenv').config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    // Явно падаем при старте, если критичная переменная не задана —
    // лучше не запускать приложение, чем запустить его без ключа.
    throw new Error(`Отсутствует обязательная переменная окружения: ${name}`);
  }
  return value;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Ключ доступа к платформе VibeCode. READONLY-режим, скоупы crm + user.
  // Передаётся ТОЛЬКО на бэкенде в заголовке X-Api-Key, никогда на фронтенд.
  vibeApiKey: requireEnv('VIBE_API_KEY'),

  // Базовый адрес API VibeCode.
  vibeApiBaseUrl: process.env.VIBE_API_BASE_URL || 'https://vibecode.bitrix24.tech/v1',

  // Настройки retry/backoff при 429.
  retry: {
    maxAttempts: 4,
    baseDelayMs: 500, // экспоненциальная задержка: 500ms, 1000ms, 2000ms...
  },

  // TTL кэша для справочников (воронки, стадии) — они редко меняются.
  cacheTtlMs: 5 * 60 * 1000, // 5 минут

  // Имена заголовков, которые Gateway VibeCode прокидывает в наш бэкенд,
  // чтобы приложение могло определить, от лица какого сотрудника открыт дашборд.
  // ВАЖНО: точные названия заголовков нужно свериться с актуальной документацией
  // Gateway (https://vibecode.bitrix24.tech/) — здесь заложены наиболее вероятные
  // имена по конвенции "X-Vibe-*", указанной в ТЗ.
  gatewayHeaders: {
    userId: 'x-vibe-user-id',
    userName: 'x-vibe-user-name',
    userEmail: 'x-vibe-user-email',
  },
};

module.exports = config;
