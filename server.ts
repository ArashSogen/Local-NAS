import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNasApp } from './server/app.ts';
import { loadEnvConfig } from './server/config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const config = loadEnvConfig();
  const ctx = createNasApp(config, { startWorker: false });

  // Always reconcile DB with local staging disk BEFORE accepting traffic or starting workers
  await ctx.syncEngine.reconcileOnStartup();
  ctx.syncEngine.start(600);

  const distDir = path.resolve(__dirname, 'dist');
  const isProduction = config.nodeEnv === 'production' && fs.existsSync(path.join(distDir, 'index.html'));

  if (isProduction) {
    ctx.app.use(express.static(distDir, { index: false }));
    ctx.app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    ctx.app.use(vite.middlewares);
  }

  const server = ctx.app.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[VaultStage NAS] Listening on http://0.0.0.0:${config.port} (staging=${config.hardDiskPath}, remote=${config.cloudRemote}, driver=${ctx.cloudDriver.engine})`
    );
  });

  const shutdown = (signal: string) => {
    console.log(`[VaultStage NAS] Received ${signal}, shutting down cleanly...`);
    server.close(() => {
      ctx.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('[VaultStage NAS] Fatal startup error:', err);
  process.exit(1);
});
