import { Pool } from 'pg';
import type { AppConfig } from './config';

/**
 * Schema is applied at boot and is idempotent, so a fresh Postgres and an existing one both work.
 * Add new statements at the end; never edit an existing CREATE, use ALTER ... IF NOT EXISTS.
 */
const SCHEMA_STATEMENTS: string[] = [
    `CREATE TABLE IF NOT EXISTS leads (
        id                  text PRIMARY KEY,
        created_at          timestamptz NOT NULL,
        email               text NOT NULL,
        phone               text NOT NULL,
        property_type       text NOT NULL,
        cadastral_number    text,
        fetch_cf            boolean NOT NULL DEFAULT false,
        terms_accepted      boolean NOT NULL DEFAULT false,
        ai_consent_accepted boolean NOT NULL DEFAULT false,
        attribution         jsonb NOT NULL DEFAULT '{}'::jsonb,
        client              jsonb NOT NULL DEFAULT '{}'::jsonb,
        report_s3_key        text,
        report_original_name text,
        report_size          bigint,
        report_uploaded_at   timestamptz,
        report_token         text,
        report_sent_at       timestamptz,
        report_sent_count    integer NOT NULL DEFAULT 0,
        report_viewed_at     timestamptz,
        report_view_count    integer NOT NULL DEFAULT 0
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS leads_report_token_idx ON leads (report_token)`,
    `CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS leads_email_idx ON leads (lower(email))`,
    `CREATE INDEX IF NOT EXISTS leads_phone_idx ON leads (phone)`,
    `CREATE TABLE IF NOT EXISTS lead_files (
        id            bigserial PRIMARY KEY,
        lead_id       text NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
        kind          text NOT NULL,
        s3_key        text NOT NULL UNIQUE,
        original_name text NOT NULL,
        content_type  text NOT NULL,
        size          bigint NOT NULL,
        uploaded_at   timestamptz NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS lead_files_lead_id_idx ON lead_files (lead_id, id)`,
    // Payment for the second and later report of the same person (Stripe Checkout + webhook).
    `ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS payment_required      boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS previous_lead_id      text,
        ADD COLUMN IF NOT EXISTS stripe_session_id     text,
        ADD COLUMN IF NOT EXISTS stripe_payment_intent text,
        ADD COLUMN IF NOT EXISTS paid_at               timestamptz,
        ADD COLUMN IF NOT EXISTS paid_amount           integer,
        ADD COLUMN IF NOT EXISTS paid_currency         text,
        ADD COLUMN IF NOT EXISTS paid_note             text`,
    `CREATE INDEX IF NOT EXISTS leads_stripe_session_idx ON leads (stripe_session_id)`
];

export function createPool(config: AppConfig): Pool {
    return new Pool({
        host: config.pgHost,
        port: config.pgPort,
        database: config.pgDatabase,
        user: config.pgUser,
        password: config.pgPassword,
        max: 5,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000
    });
}

export async function applySchema(pool: Pool): Promise<void> {
    const client = await pool.connect();
    try {
        // Serialise concurrent boots (compose restart races) on one advisory lock.
        await client.query('SELECT pg_advisory_lock(7268311)');
        for (const statement of SCHEMA_STATEMENTS) {
            await client.query(statement);
        }
        await client.query('SELECT pg_advisory_unlock(7268311)');
    } finally {
        client.release();
    }
}
