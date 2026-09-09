import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';
import type { ReportMailer } from '../email';
import type { FileStorage } from '../file-storage';
import { sniffFileType } from '../files';
import { isValidLeadId, type Lead } from '../lead';
import type { LeadRepository } from '../lead-repository';

interface AdminRouteDeps {
    config: AppConfig;
    leads: LeadRepository;
    files: FileStorage;
    mailer: ReportMailer;
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
<style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#222}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;vertical-align:top}th{background:#f3f3f3}a{color:#0b57d0}pre{white-space:pre-wrap;background:#f7f7f7;padding:.6rem}.flash{padding:.6rem .8rem;border-radius:6px;margin:0 0 1rem}.ok{background:#e6f4ea;color:#1e4620}.err{background:#fce8e6;color:#8a1c12}form.inline{display:inline}button{padding:.4rem .8rem}code{background:#f0f0f0;padding:0 .3rem}</style>
</head><body>${body}</body></html>`;
}

function short(iso: string | undefined): string {
    if (iso == null) {
        return '';
    }
    return iso.slice(0, 16).replace('T', ' ');
}

/**
 * Admin pages. Authentication is Caddy (client IP allowlist, then basic auth) on /admin/*; the service
 * has no auth code. The POST handlers additionally refuse cross-site requests, because the browser
 * would attach the basic-auth credentials to a form posted from any other site.
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
    const { config, leads, files, mailer } = deps;

    const rejectCrossSite = (request: FastifyRequest, reply: FastifyReply): boolean => {
        const site = request.headers['sec-fetch-site'];
        if (site != null && site !== 'same-origin' && site !== 'none') {
            reply.code(403).type('text/html; charset=utf-8').send(page('Forbidden', '<p>Cross-site request refused.</p>'));
            return true;
        }
        return false;
    };

    const redirectToLead = (reply: FastifyReply, leadId: string, flash: string): FastifyReply => {
        return reply.redirect(`/admin/leads/${leadId}?m=${encodeURIComponent(flash)}`, 303);
    };

    app.get('/admin/leads', async (_request, reply) => {
        const listed = await leads.list(200);
        const rows = listed
            .map(lead => `<tr>
<td><a href="/admin/leads/${escapeHtml(lead.id)}">${escapeHtml(lead.id)}</a></td>
<td>${escapeHtml(short(lead.createdAt))}</td>
<td>${escapeHtml(lead.propertyType)}</td>
<td>${escapeHtml(lead.email)}</td>
<td>${lead.fileCount}</td>
<td>${escapeHtml(lead.utmSource)} / ${escapeHtml(lead.utmCampaign)}</td>
<td>${paymentStatus(lead.paymentRequired, lead.paidAt)}</td>
<td>${reportStatus(lead.reportUploadedAt, lead.reportSentAt, lead.reportViewedAt)}</td>
</tr>`)
            .join('');
        const body = `<h1>Leads (${listed.length})</h1>
<table><thead><tr><th>Id</th><th>Creat</th><th>Tip</th><th>Email</th><th>Fișiere</th><th>Sursă</th><th>Plată</th><th>Raport</th></tr></thead>
<tbody>${rows}</tbody></table>`;
        return reply.type('text/html; charset=utf-8').send(page('Leads', body));
    });

    app.get<{ Params: { id: string }; Querystring: { m?: string } }>('/admin/leads/:id', async (request, reply) => {
        const leadId = request.params.id;
        if (!isValidLeadId(leadId)) {
            return reply.code(400).type('text/html; charset=utf-8').send(page('Invalid', '<p>Invalid lead id.</p>'));
        }
        const lead = await leads.find(leadId);
        if (lead == null) {
            return reply.code(404).type('text/html; charset=utf-8').send(page('Not found', '<p>Unknown lead.</p>'));
        }
        const fileRows = await Promise.all(lead.files.map(async file => {
            const url = await files.presignedGetUrl(file.key);
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
        const flash = typeof request.query.m === 'string' ? request.query.m.slice(0, 300) : undefined;
        const flashHtml = flash == null ? '' : `<p class="flash ${flash.startsWith('Eroare') ? 'err' : 'ok'}">${escapeHtml(flash)}</p>`;
        const body = `<p><a href="/admin/leads">&larr; toate lead-urile</a></p>
<h1>Lead ${escapeHtml(lead.id)}</h1>
${flashHtml}
<table>${fieldRows}</table>
<h2>Fișiere (${lead.files.length})</h2>
${lead.files.length === 0 ? '<p>Niciun fișier.</p>' : `<ul>${fileRows.join('')}</ul>`}
<p>Linkurile expiră; reîncarcă pagina pentru unele noi.</p>
<h2>Plată</h2>
${paymentSection(lead)}
<h2>Raport</h2>
${await reportSection(lead)}
<h2>Atribuire</h2><pre>${escapeHtml(JSON.stringify(lead.attribution, null, 2))}</pre>
<h2>Client</h2><pre>${escapeHtml(JSON.stringify(lead.client, null, 2))}</pre>`;
        return reply.type('text/html; charset=utf-8').send(page(`Lead ${lead.id}`, body));
    });

    app.post<{ Params: { id: string } }>('/admin/leads/:id/report', async (request, reply) => {
        if (rejectCrossSite(request, reply)) {
            return reply;
        }
        const leadId = request.params.id;
        if (!isValidLeadId(leadId)) {
            return reply.code(400).type('text/html; charset=utf-8').send(page('Invalid', '<p>Invalid lead id.</p>'));
        }
        const lead = await leads.find(leadId);
        if (lead == null) {
            return reply.code(404).type('text/html; charset=utf-8').send(page('Not found', '<p>Unknown lead.</p>'));
        }
        if (!request.isMultipart()) {
            return redirectToLead(reply, leadId, 'Eroare: formularul nu a trimis un fișier.');
        }
        const part = await request.file({ limits: { fileSize: config.maxReportBytes, files: 1 } });
        if (part == null) {
            return redirectToLead(reply, leadId, 'Eroare: niciun fișier selectat.');
        }
        const buffer = await part.toBuffer();
        if (part.file.truncated) {
            return redirectToLead(reply, leadId, `Eroare: fișierul depășește ${Math.round(config.maxReportBytes / 1024 / 1024)} MB.`);
        }
        const sniffed = sniffFileType(buffer.subarray(0, 16));
        if (sniffed == null || sniffed.contentType !== 'application/pdf') {
            return redirectToLead(reply, leadId, 'Eroare: raportul trebuie să fie un PDF.');
        }
        const key = files.reportKey(leadId);
        await files.saveFile(key, buffer, 'application/pdf', buffer.length);
        const originalName = (part.filename ?? 'raport.pdf').slice(0, 200);
        await leads.saveReport(leadId, key, originalName, buffer.length, new Date().toISOString());
        request.log.info({ leadId, size: buffer.length, replaced: lead.report != null }, 'report uploaded');
        return redirectToLead(reply, leadId, lead.report != null ? 'Raport înlocuit. Linkul trimis anterior rămâne valabil.' : 'Raport încărcat. Trimite emailul când e gata.');
    });

    app.post<{ Params: { id: string }; Body: { note?: string } }>('/admin/leads/:id/paid', async (request, reply) => {
        if (rejectCrossSite(request, reply)) {
            return reply;
        }
        const leadId = request.params.id;
        if (!isValidLeadId(leadId)) {
            return reply.code(400).type('text/html; charset=utf-8').send(page('Invalid', '<p>Invalid lead id.</p>'));
        }
        const note = (typeof request.body?.note === 'string' ? request.body.note : '').trim().slice(0, 200) || 'marcat manual';
        const marked = await leads.markPaidManually(leadId, note);
        request.log.info({ leadId, marked }, 'lead marked paid by admin');
        return redirectToLead(reply, leadId, marked ? 'Marcat ca plătit.' : 'Eroare: lead necunoscut sau deja plătit.');
    });

    app.post<{ Params: { id: string } }>('/admin/leads/:id/report/send', async (request, reply) => {
        if (rejectCrossSite(request, reply)) {
            return reply;
        }
        const leadId = request.params.id;
        if (!isValidLeadId(leadId)) {
            return reply.code(400).type('text/html; charset=utf-8').send(page('Invalid', '<p>Invalid lead id.</p>'));
        }
        const lead = await leads.find(leadId);
        if (lead == null) {
            return reply.code(404).type('text/html; charset=utf-8').send(page('Not found', '<p>Unknown lead.</p>'));
        }
        if (lead.report == null) {
            return redirectToLead(reply, leadId, 'Eroare: nu există raport încărcat.');
        }
        const result = await mailer.sendReportReady(lead);
        if (!result.sent) {
            return redirectToLead(reply, leadId, `Eroare: emailul nu a fost trimis (${result.reason ?? 'necunoscut'}).`);
        }
        await leads.recordReportSent(leadId);
        return redirectToLead(reply, leadId, 'Email trimis.');
    });

    function paymentSection(lead: Lead): string {
        if (!lead.payment.required && lead.payment.paidAt == null) {
            return '<p>Primul raport al acestui client: gratuit.</p>';
        }
        const previous = lead.payment.previousLeadId == null ? '' : ` (a mai cerut: <a href="/admin/leads/${escapeHtml(lead.payment.previousLeadId)}">${escapeHtml(lead.payment.previousLeadId)}</a>)`;
        if (lead.payment.paidAt != null) {
            const how = lead.payment.paidNote != null
                ? `manual: ${escapeHtml(lead.payment.paidNote)}`
                : `Stripe ${escapeHtml(lead.payment.stripePaymentIntent ?? lead.payment.stripeSessionId ?? '')}, ${lead.payment.paidAmount != null ? (lead.payment.paidAmount / 100).toFixed(2) : '?'} ${escapeHtml((lead.payment.paidCurrency ?? 'ron').toUpperCase())}`;
            return `<p class="flash ok">Plătit ${escapeHtml(short(lead.payment.paidAt))} (${how})${previous}. Factura se emite manual în SmartBill.</p>`;
        }
        return `<p class="flash err">NEPLĂTIT${previous}. Client recurent, raportul se lucrează după plată.${lead.payment.stripeSessionId != null ? ' Sesiune Stripe deschisă: ' + escapeHtml(lead.payment.stripeSessionId) : ' Nu a ajuns la plată.'}</p>
<form class="inline" method="post" action="/admin/leads/${escapeHtml(lead.id)}/paid" onsubmit="return confirm('Marchez ca plătit fără Stripe?')">
<input type="text" name="note" placeholder="ex. transfer bancar / gratuit" maxlength="200">
<button type="submit">Marchează plătit</button>
</form>`;
    }

    async function reportSection(lead: Lead): Promise<string> {
        const uploadForm = `<form method="post" action="/admin/leads/${escapeHtml(lead.id)}/report" enctype="multipart/form-data">
<input type="file" name="report" accept="application/pdf" required>
<button type="submit">${lead.report == null ? 'Încarcă raportul (PDF)' : 'Înlocuiește raportul'}</button>
</form>`;
        if (lead.report == null) {
            return `<p>Niciun raport încărcat.</p>${uploadForm}`;
        }
        const adminUrl = await files.presignedGetUrl(lead.report.key);
        const customerUrl = mailer.reportUrl(lead);
        const unpaid = lead.payment.required && lead.payment.paidAt == null;
        const sendForm = `<form class="inline" method="post" action="/admin/leads/${escapeHtml(lead.id)}/report/send" onsubmit="return confirm('${unpaid ? 'ATENȚIE: lead NEPLĂTIT. ' : ''}Trimit emailul către ${escapeHtml(lead.email)}?')">
<button type="submit">${lead.report.sentCount === 0 ? 'Trimite emailul cu linkul' : 'Retrimite emailul'}</button>
</form>`;
        return `<table>
<tr><th>Fișier</th><td><a href="${escapeHtml(adminUrl)}" target="_blank" rel="noopener">${escapeHtml(lead.report.originalName)}</a> (${Math.round(lead.report.size / 1024)} KB, încărcat ${escapeHtml(short(lead.report.uploadedAt))})</td></tr>
<tr><th>Link client</th><td><code>${escapeHtml(customerUrl)}</code></td></tr>
<tr><th>Email</th><td>${lead.report.sentCount === 0 ? 'netrimis' : `trimis de ${lead.report.sentCount} ori, ultima dată ${escapeHtml(short(lead.report.sentAt))}`} ${sendForm}</td></tr>
<tr><th>Vizualizat</th><td>${lead.report.viewCount === 0 ? 'încă nu' : `de ${lead.report.viewCount} ori, ultima dată ${escapeHtml(short(lead.report.viewedAt))}`}</td></tr>
</table>
<p>${uploadForm}</p>`;
    }
}

function paymentStatus(required: boolean, paidAt: string | undefined): string {
    if (paidAt != null) {
        return `plătit ${escapeHtml(short(paidAt))}`;
    }
    if (!required) {
        return 'gratuit';
    }
    return '<b style="color:#8a1c12">neplătit</b>';
}

function reportStatus(uploadedAt: string | undefined, sentAt: string | undefined, viewedAt: string | undefined): string {
    if (uploadedAt == null) {
        return '';
    }
    if (viewedAt != null) {
        return `văzut ${escapeHtml(short(viewedAt))}`;
    }
    if (sentAt != null) {
        return `trimis ${escapeHtml(short(sentAt))}`;
    }
    return `încărcat ${escapeHtml(short(uploadedAt))}`;
}
