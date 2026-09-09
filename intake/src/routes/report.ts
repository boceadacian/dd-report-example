import type { FastifyInstance } from 'fastify';
import type { FileStorage } from '../file-storage';
import { isValidLeadId } from '../lead';
import type { LeadRepository } from '../lead-repository';
import type { SlackNotifier } from '../slack';
import type { AppConfig } from '../config';

interface ReportRouteDeps {
    config: AppConfig;
    leads: LeadRepository;
    files: FileStorage;
    slack: SlackNotifier;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function escapeHtml(value: unknown): string {
    if (value == null) {
        return '';
    }
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function shell(title: string, body: string): string {
    return `<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:#f5f6f8;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2933}
a{color:#34861a}
.card{max-width:560px;margin:64px auto;background:#fff;border-radius:12px;padding:32px}
@media (max-width:720px){.card{margin:24px 16px}}
</style></head><body>${body}</body></html>`;
}

/**
 * Report links for the customer's page on the landing (raport.html#{leadId}.{token}). The page asks
 * GET /raport/{id}/{token}/links and gets short-lived presigned S3 URLs: one the browser renders
 * inline, one that downloads. The lead id alone opens nothing. The old /raport/{id}/{token} HTML URL
 * redirects to the landing page so links sent before the move keep working.
 */
export function registerReportRoutes(app: FastifyInstance, deps: ReportRouteDeps): void {
    const { config, leads, files, slack } = deps;

    app.get<{ Params: { id: string; token: string } }>('/raport/:id/:token/links', {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        reply.header('cache-control', 'no-store');
        const { id, token } = request.params;
        if (!isValidLeadId(id) || !TOKEN_PATTERN.test(token)) {
            return reply.code(404).send({ errors: [{ field: 'request', reason: 'not found' }] });
        }
        const lead = await leads.findByReportToken(id, token);
        if (lead?.report == null) {
            request.log.info({ leadId: id }, 'report link rejected');
            return reply.code(404).send({ errors: [{ field: 'request', reason: 'not found' }] });
        }
        const urls = await files.presignedReportUrls(lead.report.key, `raport-${lead.id}.pdf`, config.reportLinkTtlSeconds);
        const views = await leads.recordReportView(lead.id);
        if (views === 1) {
            await slack.reportViewed(lead);
        }
        return reply.send({ view: urls.view, download: urls.download, expiresInSeconds: config.reportLinkTtlSeconds });
    });

    app.get<{ Params: { id: string; token: string } }>('/raport/:id/:token', {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        reply.header('cache-control', 'no-store');
        const { id, token } = request.params;
        if (!isValidLeadId(id) || !TOKEN_PATTERN.test(token)) {
            return reply.code(404).type('text/html; charset=utf-8').send(shell('Raport', notFound()));
        }
        return reply.redirect(`${config.landingBaseUrl}/raport.html#${id}.${token}`, 302);
    });
}

function notFound(): string {
    return `<div class="card"><h1 style="margin-top:0">Raportul nu a fost găsit</h1>
<p>Linkul nu este valid sau raportul nu a fost încă publicat. Deschide exact linkul din email; dacă problema persistă, răspunde la emailul primit.</p></div>`;
}
