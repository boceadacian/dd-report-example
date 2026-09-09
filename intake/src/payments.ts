import Stripe from 'stripe';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config';
import type { Lead } from './lead';

export interface CheckoutSession {
    id: string;
    url: string;
}

export interface PaidEvent {
    leadId: string | undefined;
    sessionId: string;
    paymentIntent: string | undefined;
    amount: number | undefined;
    currency: string | undefined;
}

/**
 * Stripe Checkout for the paid (second and later) report. The intake never sees card data: it creates
 * a hosted Checkout Session and learns about the payment from the signed webhook. Empty STRIPE_SECRET_KEY
 * disables payments entirely: every lead is treated as free.
 */
export class PaymentGateway {

    private readonly stripe: Stripe | undefined;

    constructor(private readonly config: AppConfig, private readonly log: FastifyBaseLogger) {
        if (config.stripeSecretKey != null) {
            this.stripe = new Stripe(config.stripeSecretKey, { apiVersion: '2025-08-27.basil' as Stripe.LatestApiVersion });
        }
    }

    enabled(): boolean {
        return this.stripe != null && this.config.paymentEnabled;
    }

    async createCheckoutSession(lead: Lead): Promise<CheckoutSession> {
        if (this.stripe == null) {
            throw new Error('Stripe is not configured');
        }
        const successUrl = `${this.config.landingBaseUrl}/multumim.html?id=${lead.id}&plata=ok`;
        const cancelUrl = `${this.config.landingBaseUrl}/multumim.html?id=${lead.id}&plata=anulata`;
        try {
            const session = await this.stripe.checkout.sessions.create({
                mode: 'payment',
                locale: 'ro',
                customer_email: lead.email,
                client_reference_id: lead.id,
                metadata: { leadId: lead.id },
                line_items: [{
                    quantity: 1,
                    // The advertised price is what the customer pays; VAT (21% RO) is shown inside it.
                    tax_rates: this.config.stripeTaxRateId != null ? [this.config.stripeTaxRateId] : undefined,
                    price_data: {
                        currency: 'ron',
                        unit_amount: this.config.reportPriceRon * 100,
                        tax_behavior: 'inclusive',
                        product_data: {
                            name: 'Raport de verificare a proprietății',
                            description: `Cererea ${lead.id}`
                        }
                    }
                }],
                payment_intent_data: { metadata: { leadId: lead.id } },
                success_url: successUrl,
                cancel_url: cancelUrl,
                expires_at: Math.floor(Date.now() / 1000) + 30 * 60
            }, { idempotencyKey: `checkout-${lead.id}-${Date.now()}` });
            if (session.url == null) {
                throw new Error('Checkout session has no url');
            }
            this.log.info({ leadId: lead.id, sessionId: session.id }, 'checkout session created');
            return { id: session.id, url: session.url };
        } catch (error) {
            const named = error as { type?: string; code?: string; message?: string; statusCode?: number };
            this.log.error({ leadId: lead.id, type: named.type, code: named.code, status: named.statusCode, message: named.message?.slice(0, 300) }, 'Stripe checkout session creation failed');
            throw error;
        }
    }

    /**
     * Verifies the webhook signature and returns the paid session, or undefined for events that do
     * not mean "money received" (async_payment_failed, anything else subscribed by mistake).
     */
    parsePaidEvent(rawBody: Buffer, signature: string | undefined): { event: Stripe.Event; paid: PaidEvent | undefined } {
        if (this.stripe == null || this.config.stripeWebhookSecret == null) {
            throw new Error('Stripe webhook is not configured');
        }
        if (signature == null) {
            throw new Error('missing stripe-signature header');
        }
        const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.config.stripeWebhookSecret);
        const paidTypes: string[] = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
        if (!paidTypes.includes(event.type)) {
            return { event, paid: undefined };
        }
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status !== 'paid') {
            // completed fires for delayed methods before the money arrives; async_payment_succeeded follows.
            return { event, paid: undefined };
        }
        return {
            event,
            paid: {
                leadId: session.metadata?.leadId ?? session.client_reference_id ?? undefined,
                sessionId: session.id,
                paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
                amount: session.amount_total ?? undefined,
                currency: session.currency ?? undefined
            }
        };
    }
}
