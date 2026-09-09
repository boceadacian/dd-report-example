import type { FastifyInstance } from 'fastify';
import type { LeadRepository } from '../lead-repository';
import type { PaymentGateway } from '../payments';
import type { SlackNotifier } from '../slack';

interface StripeRouteDeps {
    leads: LeadRepository;
    payments: PaymentGateway;
    slack: SlackNotifier;
}

/**
 * Stripe webhook. Registered in its own plugin scope so the JSON body stays a raw Buffer for the
 * signature check without touching the parser the rest of the app uses. Stripe retries on non-2xx,
 * so a bad signature is a 400 and everything after a valid signature answers 200, even when the
 * lead is unknown (logged, nothing to retry).
 */
export function registerStripeRoutes(app: FastifyInstance, deps: StripeRouteDeps): void {
    const { leads, payments, slack } = deps;

    app.register(async scope => {
        scope.removeContentTypeParser('application/json');
        scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
            done(null, body);
        });

        scope.post('/stripe/webhook', {
            config: { rateLimit: false }
        }, async (request, reply) => {
            let parsed;
            try {
                parsed = payments.parsePaidEvent(request.body as Buffer, request.headers['stripe-signature'] as string | undefined);
            } catch (error) {
                request.log.warn({ err: error }, 'stripe webhook rejected');
                return reply.code(400).send({ errors: [{ field: 'signature', reason: 'invalid' }] });
            }
            const { event, paid } = parsed;
            if (paid == null) {
                request.log.info({ eventType: event.type, eventId: event.id }, 'stripe event ignored');
                return reply.send({ received: true });
            }
            if (paid.leadId == null) {
                request.log.error({ eventId: event.id, sessionId: paid.sessionId }, 'paid session carries no lead id');
                return reply.send({ received: true });
            }
            const marked = await leads.markPaid(paid.leadId, paid.sessionId, paid.paymentIntent, paid.amount, paid.currency);
            if (!marked) {
                // Already marked by an earlier delivery of the same event, or an unknown lead.
                request.log.info({ leadId: paid.leadId, eventId: event.id }, 'payment already recorded or lead unknown');
                return reply.send({ received: true });
            }
            request.log.info({ leadId: paid.leadId, sessionId: paid.sessionId, amount: paid.amount, currency: paid.currency }, 'lead paid');
            const lead = await leads.find(paid.leadId);
            if (lead != null) {
                await slack.leadPaid(lead);
            }
            return reply.send({ received: true });
        });
    });
}
