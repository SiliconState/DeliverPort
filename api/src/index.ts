import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { compress } from 'hono/compress';
import { serve } from '@hono/node-server';
import { prisma } from './db.js';

// Route modules
import authRoutes from './routes/auth.js';
import clientRoutes from './routes/clients.js';
import projectRoutes from './routes/projects.js';
import invoiceRoutes from './routes/invoices.js';
import payoutRunRoutes from './routes/payout-runs.js';
import portalRoutes from './routes/portal.js';
import userRoutes from './routes/users.js';
import metaRoutes from './routes/meta.js';
import bootstrapRoutes from './routes/bootstrap.js';
import auditEventRoutes from './routes/audit-events.js';
import auditRoutes from './routes/audit.js';

const app = new Hono();

// ---------------------
// Global middleware
// ---------------------

// Request logging
app.use('*', logger());

// CORS — allow GitHub Pages and local development
const allowedOrigins = (process.env.CORS_ORIGINS || 'https://siliconstate.github.io,http://localhost:8080,http://localhost:8081,http://localhost:3000')
  .split(',')
  .map((o) => o.trim());

app.use(
  '*',
  cors({
    origin: (origin) => allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Length'],
    maxAge: 86400,
    credentials: true,
  })
);

// Compress JSON responses to reduce payload size over slow links
app.use('*', compress());

// ---------------------
// Health check
// ---------------------
app.get('/api/health', (c) => {
  c.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  c.header('Vary', 'Accept-Encoding');
  return c.json({
    status: 'ok',
    version: '1.1.0',
    timestamp: new Date().toISOString(),
  });
});

// ---------------------
// Routes
// ---------------------
app.route('/api/auth', authRoutes);
app.route('/api/bootstrap', bootstrapRoutes);
app.route('/api/clients', clientRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/invoices', invoiceRoutes);
app.route('/api/payout-runs', payoutRunRoutes);
app.route('/api/portal', portalRoutes);
app.route('/api/users', userRoutes);
app.route('/api/meta', metaRoutes);
app.route('/api/audit-events', auditEventRoutes);
app.route('/api/audit', auditRoutes);

// ---------------------
// 404 fallback
// ---------------------
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// ---------------------
// Global error handler
// ---------------------
app.onError((err, c) => {
  console.error(`[ERROR] ${err.message}`, err.stack);
  return c.json({ error: 'Internal server error' }, 500);
});

// ---------------------
// Start server
// ---------------------
const port = parseInt(process.env.PORT || '3000', 10);

console.log(`🚀 DeliverPort API starting on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`✅ DeliverPort API running at http://localhost:${port}`);

// Graceful shutdown
const shutdown = async () => {
  console.log('\n🛑 Shutting down...');
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export default app;
