// server.js
// Точка входа приложения. Поднимает Express-сервер, который:
// 1) отдаёт статику фронтенда (интерфейс дашборда),
// 2) обслуживает BFF-эндпоинты /api/dashboard/*,
// 3) при старте проверяет доступность VibeCode API (GET /v1/me).

const path = require('path');
const express = require('express');
const config = require('./config');
const logger = require('./utils/logger');
const dashboardRouter = require('./routes/dashboard');
const vibeApi = require('./services/vibeApi');

const app = express();

app.use(express.json());

// Базовые заголовки безопасности (без лишних зависимостей вроде helmet).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'ALLOWALL'); // приложение специально встраивается в iframe Битрикс24
  next();
});

// Простой лог каждого запроса без чувствительных данных.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('HTTP запрос', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
});

// API дашборда
app.use('/api/dashboard', dashboardRouter);

// Служебный health-check (полезно для проверки деплоя)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Статика фронтенда
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

// SPA fallback — любой не-API путь отдаёт index.html
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Не найдено' });
  }
  return res.sendFile(path.join(frontendPath, 'index.html'));
});

// Обработчик непойманных ошибок express
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Необработанная ошибка Express', { message: err.message });
  res.status(500).json({ error: 'Произошла ошибка на сервере' });
});

async function start() {
  try {
    // Проверяем, что ключ рабочий и VibeCode API доступен, до приёма трафика.
    await vibeApi.getMe();
    logger.info('Проверка GET /v1/me прошла успешно, ключ валиден');
  } catch (err) {
    logger.error('Не удалось выполнить проверочный вызов GET /v1/me при старте', {
      message: err.message,
    });
    // Не останавливаем сервер полностью — платформа может быть временно
    // недоступна (502/429), а приложение должно поднять health-check
    // и корректно отдавать ошибки по конкретным запросам.
  }

  app.listen(config.port, () => {
    logger.info(`Сервер запущен на порту ${config.port}`, { nodeEnv: config.nodeEnv });
  });
}

start();
