import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError } from 'fastify';
import { loadConfig } from './config';
import { registerAdminRoutes } from './routes/admin';
import { registerLeadRoutes } from './routes/leads';
import { registerReportRoutes } from './routes/report';
import { registerStripeRoutes } from './routes/stripe';
import { PaymentGateway } from './payments';
import { applySchema, createPool } from './db';
import { ReportMailer } from './email';
import { FileStorage } from './file-storage';
import { LeadRepository } from './lead-repository';
import { SlackNotifier } from './slack';

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
        methods: ['GET', 'POST', 'OPTIONS'],
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

    // The admin forms post as application/x-www-form-urlencoded (field-less buttons and the multipart
    // upload); without a parser for that type Fastify answers 415 before the handler runs.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
        const fields: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(body as string)) {
            fields[key] = value;
        }
        done(null, fields);
    });

    const pool = createPool(config);
    await applySchema(pool);
    const leads = new LeadRepository(pool);
    const files = new FileStorage(config);
    const slack = new SlackNotifier(config, app.log);
    const mailer = new ReportMailer(config, app.log);
    const payments = new PaymentGateway(config, app.log);

    app.get('/health', async (_request, reply) => {
        try {
            await pool.query('SELECT 1');
            return { status: 'ok' };
        } catch (error) {
            app.log.error({ err: error }, 'health check: database unreachable');
            return reply.code(503).send({ status: 'database unreachable' });
        }
    });

    // Generic not-found body: don't echo the route or the framework's default shape.
    app.setNotFoundHandler((_request, reply) => {
        reply.code(404).send({ errors: [{ field: 'request', reason: 'not found' }] });
    });
    registerLeadRoutes(app, { config, leads, files, slack, payments });
    registerReportRoutes(app, { config, leads, files, slack });
    registerStripeRoutes(app, { leads, payments, slack });
    registerAdminRoutes(app, { config, leads, files, mailer });

    app.setErrorHandler((error: FastifyError, request, reply) => {
        request.log.error({ err: error, url: request.url }, 'request failed');
        const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
        reply.code(status).send({ errors: [{ field: 'request', reason: status === 500 ? 'internal error' : error.message }] });
    });

    app.addHook('onClose', async () => {
        await pool.end();
    });

    await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
