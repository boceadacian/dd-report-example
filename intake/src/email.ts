import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config';
import type { Lead } from './lead';

export interface SendResult {
    sent: boolean;
    /** Set when the email was not sent: the reason to show on the admin page. Never contains the address. */
    reason?: string;
}

/**
 * Sends the "your report is ready" email through SES with the dd-intake IAM user (ses:SendEmail on
 * the verified raportcf.ro identity). Without SES_FROM the email is written to the log instead, which
 * is what the local compose does.
 */
export class ReportMailer {

    private readonly client: SESv2Client | undefined;

    constructor(private readonly config: AppConfig, private readonly log: FastifyBaseLogger) {
        if (config.sesFrom != null) {
            this.client = new SESv2Client({
                region: config.sesRegion,
                credentials: {
                    accessKeyId: config.awsAccessKeyId,
                    secretAccessKey: config.awsSecretAccessKey
                }
            });
        }
    }

    reportUrl(lead: Lead): string | undefined {
        if (lead.report == null) {
            return undefined;
        }
        // Fragment, not path or query: the token never appears in the CDN's or the API's access logs.
        return `${this.config.landingBaseUrl}/raport.html#${lead.id}.${lead.report.token}`;
    }

    async sendReportReady(lead: Lead): Promise<SendResult> {
        const url = this.reportUrl(lead);
        if (url == null) {
            return { sent: false, reason: 'no report uploaded' };
        }
        const subject = 'Raportul tău de verificare a proprietății este gata';
        const text = this.textBody(url);
        const html = this.htmlBody(url);

        if (this.client == null || this.config.sesFrom == null) {
            this.log.warn({ leadId: lead.id, subject, url }, 'SES_FROM not set: email not sent, logged instead');
            return { sent: false, reason: 'SES_FROM not configured, email logged only' };
        }

        try {
            const response = await this.client.send(new SendEmailCommand({
                FromEmailAddress: this.config.sesFrom,
                Destination: { ToAddresses: [lead.email] },
                ReplyToAddresses: this.config.sesReplyTo != null ? [this.config.sesReplyTo] : undefined,
                Content: {
                    Simple: {
                        Subject: { Data: subject, Charset: 'UTF-8' },
                        Body: {
                            Text: { Data: text, Charset: 'UTF-8' },
                            Html: { Data: html, Charset: 'UTF-8' }
                        }
                    }
                }
            }));
            this.log.info({ leadId: lead.id, messageId: response.MessageId }, 'report email sent');
            return { sent: true };
        } catch (error) {
            const named = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
            this.log.error(
                { leadId: lead.id, errorName: named.name, status: named.$metadata?.httpStatusCode, message: named.message?.slice(0, 500) },
                'SES SendEmail failed'
            );
            return { sent: false, reason: `${named.name ?? 'error'}: ${named.message?.slice(0, 200) ?? 'unknown'}` };
        }
    }

    private textBody(url: string): string {
        return [
            'Bună,',
            '',
            'Raportul de verificare a proprietății pe care l-ai cerut pe raportcf.ro este gata.',
            '',
            'Îl poți vedea și descărca aici:',
            url,
            '',
            'Linkul este personal și deschide un document cu date despre proprietate, așa că te rugăm să nu îl trimiți mai departe.',
            '',
            'Dacă ai întrebări despre raport, răspunde la acest email.',
            '',
            'Echipa raportcf.ro'
        ].join('\n');
    }

    private htmlBody(url: string): string {
        const safeUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        return `<!doctype html><html lang="ro"><body style="margin:0;padding:24px;background:#f5f6f8;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2933">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px">
<tr><td style="font-size:16px;line-height:1.55">
<p style="margin:0 0 16px">Bună,</p>
<p style="margin:0 0 16px">Raportul de verificare a proprietății pe care l-ai cerut pe raportcf.ro este gata.</p>
<p style="margin:0 0 24px"><a href="${safeUrl}" style="display:inline-block;background:#34861a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">Vezi raportul</a></p>
<p style="margin:0 0 16px;font-size:14px;color:#52606d">Dacă butonul nu funcționează, copiază linkul în browser:<br><a href="${safeUrl}" style="color:#34861a;word-break:break-all">${safeUrl}</a></p>
<p style="margin:0 0 16px;font-size:14px;color:#52606d">Linkul este personal și deschide un document cu date despre proprietate, așa că te rugăm să nu îl trimiți mai departe.</p>
<p style="margin:0">Dacă ai întrebări despre raport, răspunde la acest email.<br>Echipa raportcf.ro</p>
</td></tr></table></td></tr></table></body></html>`;
    }
}
