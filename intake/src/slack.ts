import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config';
import type { Lead } from './lead';

/**
 * Posts a short notification to Slack, either with the platform's bot token through chat.postMessage
 * (the same integration the stream processing service uses for DD alerts) or, as a fallback, an incoming
 * webhook. The message carries no personal data:
 * the lead id, the property type, the county and a link to the basic-auth admin page are enough
 * to pick it up, and Slack is a third party that should not hold the email or the phone number.
 */
export class SlackNotifier {

    constructor(private readonly config: AppConfig, private readonly log: FastifyBaseLogger) {
    }

    async leadCreated(lead: Lead): Promise<void> {
        const lines = [
            `:house: *Lead nou* \`${lead.id}\``,
            `Tip: *${lead.propertyType}*, ${lead.fetchCf ? 'a lăsat numărul cadastral, de obținut CF-ul' : 'urmează documentele'}`,
            `Sursă: ${lead.attribution.utmSource ?? 'direct'} / ${lead.attribution.utmMedium ?? '-'} / ${lead.attribution.utmCampaign ?? '-'}`,
            `${this.config.publicBaseUrl}/admin/leads/${lead.id}`
        ];
        await this.post(lines.join('\n'), lead.id);
    }

    async filesAttached(lead: Lead, added: number): Promise<void> {
        const counts: Record<string, number> = {};
        for (const file of lead.files) {
            counts[file.kind] = (counts[file.kind] ?? 0) + 1;
        }
        const summary = Object.entries(counts).map(([kind, count]) => `${kind}: ${count}`).join(', ');
        const text = `:paperclip: Lead \`${lead.id}\`: ${added} fișier(e) noi (${summary}). ${this.config.publicBaseUrl}/admin/leads/${lead.id}`;
        await this.post(text, lead.id);
    }

    private async post(text: string, leadId: string): Promise<void> {
        if (this.config.slackBotToken != null && this.config.slackChannel != null) {
            await this.postWithBot(text, leadId);
            return;
        }
        if (this.config.slackWebhookUrl != null) {
            await this.postWithWebhook(text, leadId);
            return;
        }
        this.log.warn({ leadId }, 'neither SLACK_BOT_TOKEN+SLACK_CHANNEL nor SLACK_WEBHOOK_URL set, skipping Slack notification');
    }

    private async postWithBot(text: string, leadId: string): Promise<void> {
        try {
            const response = await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${this.config.slackBotToken}` },
                body: JSON.stringify({ channel: this.config.slackChannel, text }),
                signal: AbortSignal.timeout(10_000)
            });
            if (!response.ok) {
                this.log.error({ leadId, status: response.status }, 'Slack chat.postMessage failed');
                return;
            }
            // Slack reports application errors in the body with HTTP 200 (not_in_channel, channel_not_found,
            // invalid_auth); the status alone would make a message that reached nobody look delivered.
            const body = (await response.json()) as { ok?: boolean; error?: string };
            if (body.ok !== true) {
                this.log.error({ leadId, channel: this.config.slackChannel, error: body.error ?? 'unknown' }, 'Slack rejected the notification');
            }
        } catch (error) {
            this.log.error({ leadId, err: error }, 'Slack chat.postMessage call failed');
        }
    }

    private async postWithWebhook(text: string, leadId: string): Promise<void> {
        try {
            const response = await fetch(this.config.slackWebhookUrl as string, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text }),
                signal: AbortSignal.timeout(10_000)
            });
            if (!response.ok) {
                const body = (await response.text()).slice(0, 500);
                this.log.error({ leadId, status: response.status, body }, 'Slack webhook rejected the notification');
            }
        } catch (error) {
            this.log.error({ leadId, err: error }, 'Slack webhook call failed');
        }
    }
}
