import type { FastifyInstance } from 'fastify';
import { isValidLeadId, type Lead } from '../lead';
import type { LeadStorage } from '../storage';

interface AdminRouteDeps {
    storage: LeadStorage;
}

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

function page(title: string, body: string): string {
    return `<!doctype html><html lang="ro"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex">
<style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#222}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;vertical-align:top}th{background:#f3f3f3}a{color:#0b57d0}pre{white-space:pre-wrap;background:#f7f7f7;padding:.6rem}</style>
</head><body>${body}</body></html>`;
}

/**
 * Read-only admin pages. Authentication is Caddy basic auth on /admin/*, the service has no auth code.
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
    const { storage } = deps;

    app.get('/admin/leads', async (_request, reply) => {
        const summaries = await storage.listLeads(200);
        const leads = await Promise.all(summaries.map(summary => storage.loadLead(summary.id)));
        const rows = leads
            .filter((lead): lead is Lead => lead != null)
            .map(lead => `<tr>
<td><a href="/admin/leads/${escapeHtml(lead.id)}">${escapeHtml(lead.id)}</a></td>
<td>${escapeHtml(lead.createdAt)}</td>
<td>${escapeHtml(lead.propertyType)}</td>
<td>${escapeHtml(lead.email)}</td>
<td>${lead.files.length}</td>
<td>${escapeHtml(lead.attribution.utmSource)} / ${escapeHtml(lead.attribution.utmCampaign)}</td>
</tr>`)
            .join('');
        const body = `<h1>Leads (${leads.length})</h1>
<table><thead><tr><th>Id</th><th>Creat</th><th>Tip</th><th>Email</th><th>Fișiere</th><th>Sursă</th></tr></thead>
<tbody>${rows}</tbody></table>`;
        return reply.type('text/html; charset=utf-8').send(page('Leads', body));
    });

    app.get<{ Params: { id: string } }>('/admin/leads/:id', async (request, reply) => {
        const leadId = request.params.id;
        if (!isValidLeadId(leadId)) {
            return reply.code(400).type('text/html; charset=utf-8').send(page('Invalid', '<p>Invalid lead id.</p>'));
        }
        const lead = await storage.loadLead(leadId);
        if (lead == null) {
            return reply.code(404).type('text/html; charset=utf-8').send(page('Not found', '<p>Unknown lead.</p>'));
        }
        const fileRows = await Promise.all(lead.files.map(async file => {
            const url = await storage.presignedGetUrl(file.key);
            return `<li><b>${escapeHtml(file.kind)}</b> <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(file.originalName)}</a> (${escapeHtml(file.contentType)}, ${Math.round(file.size / 1024)} KB, ${escapeHtml(file.uploadedAt)})</li>`;
        }));
        const fields: [string, unknown][] = [
            ['Creat', lead.createdAt],
            ['Email', lead.email],
            ['Telefon', lead.phone],
            ['Tip', lead.propertyType],
            ['Nr. cadastral', lead.cadastralNumber],
            ['De obținut CF', lead.fetchCf ? 'da' : 'nu'],
            ['Accept T&C + confid.', lead.termsAccepted ? 'da' : 'nu'],
            ['Accept prelucrare + IA', lead.aiConsentAccepted ? 'da' : 'nu']
        ];
        const fieldRows = fields
            .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
            .join('');
        const body = `<p><a href="/admin/leads">&larr; toate lead-urile</a></p>
<h1>Lead ${escapeHtml(lead.id)}</h1>
<table>${fieldRows}</table>
<h2>Fișiere (${lead.files.length})</h2>
${lead.files.length === 0 ? '<p>Niciun fișier.</p>' : `<ul>${fileRows.join('')}</ul>`}
<p>Linkurile expiră; reîncarcă pagina pentru unele noi.</p>
<h2>Atribuire</h2><pre>${escapeHtml(JSON.stringify(lead.attribution, null, 2))}</pre>
<h2>Client</h2><pre>${escapeHtml(JSON.stringify(lead.client, null, 2))}</pre>`;
        return reply.type('text/html; charset=utf-8').send(page(`Lead ${lead.id}`, body));
    });
}
