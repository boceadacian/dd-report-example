import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError } from 'fastify';
import { loadConfig } from './config';
import { registerAdminRoutes } from './routes/admin';
import { registerLeadRoutes } from './routes/leads';
import { SlackNotifier } from './slack';
import { LeadStorage } from './storage';

async function main(): Promise<void> {
    const config = loadConfig();

    const app = Fastify({
        logger: { level: process.env.LOG_LEVEL ?? 'info' },
        // Exactly one proxy in front (Caddy), which overwrites X-Forwarded-For with the real
        // client IP. Trusting one hop (not `true`, which trusts any forwarder) means a direct
        // caller that bypasses Caddy cannot spoof the client IP, and the hop count survives
        // Caddy's container IP changing on recreate.
        trustProxy: (_address, hop) => hop === 0,
        bodyLimit: 64 * 1024
    });

    await app.register(cors, {
        origin: config.allowedOrigins,
        methods: ['POST', 'OPTIONS'],
        allowedHeaders: ['content-type'],
        maxAge: 3600
    });
    await app.register(rateLimit, {
        global: false
    });
    await app.register(multipart, {
        limits: {
            fileSize: config.maxFileBytes,
            files: config.maxFilesPerRequest,
            fields: 5
        }
    });

    const storage = new LeadStorage(config);
    const slack = new SlackNotifier(config, app.log);

    app.get('/health', async () => ({ status: 'ok' }));

    // Generic not-found body: don't echo the route or the framework's default shape.
    app.setNotFoundHandler((_request, reply) => {
        reply.code(404).send({ errors: [{ field: 'request', reason: 'not found' }] });
    });
    registerLeadRoutes(app, { config, storage, slack });
    registerAdminRoutes(app, { storage });

    app.setErrorHandler((error: FastifyError, request, reply) => {
        request.log.error({ err: error, url: request.url }, 'request failed');
        const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
        reply.code(status).send({ errors: [{ field: 'request', reason: status === 500 ? 'internal error' : error.message }] });
    });

    await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
