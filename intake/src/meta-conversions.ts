import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config';
import type { Lead } from './lead';

interface MetaUserData {
    em?: string[];
    ph?: string[];
    client_ip_address?: string;
    client_user_agent?: string;
    fbp?: string;
    fbc?: string;
}

interface MetaEvent {
    event_name: string;
    event_time: number;
    event_id: string;
    action_source: 'website';
    event_source_url?: string;
    user_data: MetaUserData;
    custom_data?: Record<string, string | number>;
}

interface MetaResponse {
    events_received?: number;
    fbtrace_id?: string;
    error?: { message?: string; type?: string; code?: number; fbtrace_id?: string };
}

/**
 * Meta Conversions API: the server-side copy of the pixel events the GTM container fires in the
 * browser. Both carry the same event id (the lead id, or "<lead id>-paid" for the purchase), so Meta
 * keeps one when both arrive and still gets the event when the pixel is blocked. Nothing is sent for a
 * lead whose visitor did not accept the measurement cookies. Email and phone leave the box only as
 * SHA-256 hashes, which is what Meta matches on; the logs carry the lead id and Meta's trace id, never
 * the contact data.
 */
export class MetaConversionsApi {

    constructor(private readonly config: AppConfig, private readonly log: FastifyBaseLogger) {
    }

    async leadCreated(lead: Lead): Promise<void> {
        await this.send(lead, 'Lead', lead.id, undefined);
    }

    async leadPaid(lead: Lead): Promise<void> {
        const customData: Record<string, string | number> = {
            currency: (lead.payment.paidCurrency ?? 'ron').toUpperCase(),
            value: (lead.payment.paidAmount ?? this.config.reportPriceRon * 100) / 100
        };
        await this.send(lead, 'Purchase', `${lead.id}-paid`, customData);
    }

    private enabled(): boolean {
        return this.config.metaPixelId != null && this.config.metaCapiToken != null;
    }

    private async send(lead: Lead, eventName: string, eventId: string, customData: Record<string, string | number> | undefined): Promise<void> {
        if (!this.enabled()) {
            this.log.debug({ leadId: lead.id, eventName }, 'META_PIXEL_ID / META_CAPI_TOKEN not set, skipping Conversions API event');
            return;
        }
        if (lead.client.marketingConsent !== true) {
            this.log.info({ leadId: lead.id, eventName }, 'no measurement consent, skipping Conversions API event');
            return;
        }
        const event: MetaEvent = {
            event_name: eventName,
            event_time: Math.floor(Date.now() / 1000),
            event_id: eventId,
            action_source: 'website',
            event_source_url: lead.attribution.landingUrl,
            user_data: this.userData(lead),
            custom_data: customData
        };
        const body: Record<string, unknown> = { data: [event] };
        if (this.config.metaTestEventCode != null) {
            body.test_event_code = this.config.metaTestEventCode;
        }
        const url = `https://graph.facebook.com/${this.config.metaGraphVersion}/${this.config.metaPixelId}/events`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.metaCapiToken}` },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10_000)
            });
            const text = (await response.text()).slice(0, 500);
            if (!response.ok) {
                // The error body is Meta's own message (bad token, unknown pixel, malformed event), no personal data.
                this.log.error({ leadId: lead.id, eventName, eventId, status: response.status, body: text }, 'Meta Conversions API rejected the event');
                return;
            }
            const parsed = this.parse(text);
            if (parsed.error != null || parsed.events_received !== 1) {
                this.log.error({ leadId: lead.id, eventName, eventId, status: response.status, body: text }, 'Meta Conversions API did not accept the event');
                return;
            }
            this.log.info({ leadId: lead.id, eventName, eventId, fbtraceId: parsed.fbtrace_id, test: this.config.metaTestEventCode != null }, 'Meta Conversions API event sent');
        } catch (error) {
            // Timeout or network: the pixel in the browser is the other copy of the same event.
            this.log.error({ leadId: lead.id, eventName, eventId, err: error }, 'Meta Conversions API call failed');
        }
    }

    private parse(text: string): MetaResponse {
        try {
            return JSON.parse(text) as MetaResponse;
        } catch (error) {
            return {};
        }
    }

    private userData(lead: Lead): MetaUserData {
        const data: MetaUserData = {
            em: [this.hash(lead.email.trim().toLowerCase())],
            // Meta wants digits only, country code included, no plus: +40712345678 -> 40712345678.
            ph: [this.hash(lead.phone.replace(/\D/g, ''))]
        };
        if (lead.client.ip !== '') {
            data.client_ip_address = lead.client.ip;
        }
        if (lead.client.userAgent != null) {
            data.client_user_agent = lead.client.userAgent;
        }
        if (lead.attribution.fbp != null) {
            data.fbp = lead.attribution.fbp;
        }
        if (lead.attribution.fbc != null) {
            data.fbc = lead.attribution.fbc;
        }
        return data;
    }

    private hash(value: string): string {
        return createHash('sha256').update(value, 'utf8').digest('hex');
    }
}
