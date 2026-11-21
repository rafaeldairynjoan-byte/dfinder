// Local server: the API from server/app.ts plus the web page.
//   npm run dev                     -> live-reloading page (Vite)
//   NODE_ENV=production npm start   -> serves the built page from dist/
// Not used on Vercel, which serves dist/ itself and runs api/index.ts.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import app from './server/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

async function start() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dallas County Vacant Lot Finder server running on http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
