export interface AppConfig {
    port: number;
    publicBaseUrl: string;
    /** The static site; the customer's report page lives there (raport.html#id.token). */
    landingBaseUrl: string;
    allowedOrigins: string[];
    awsRegion: string;
    awsAccessKeyId: string;
    awsSecretAccessKey: string;
    s3Bucket: string;
    s3Prefix: string;
    s3Endpoint: string | undefined;
    s3PublicEndpoint: string | undefined;
    pgHost: string;
    pgPort: number;
    pgDatabase: string;
    pgUser: string;
    pgPassword: string;
    slackWebhookUrl: string | undefined;
    /** Bot token + channel, the same integration the platform's stream processing uses (chat.postMessage). */
    slackBotToken: string | undefined;
    slackChannel: string | undefined;
    presignedUrlTtlSeconds: number;
    /** Lifetime of the S3 links behind the customer's report page; the page itself does not expire. */
    reportLinkTtlSeconds: number;
    maxReportBytes: number;
    /** Empty means "do not send": the email is logged instead (local compose). */
    sesFrom: string | undefined;
    sesReplyTo: string | undefined;
    sesRegion: string;
    /** Empty disables payments: every lead is free. */
    stripeSecretKey: string | undefined;
    stripeWebhookSecret: string | undefined;
    reportPriceRon: number;
    paymentEnabled: boolean;
    /** Stripe tax rate (txr_...) applied to the report line; the price is VAT-inclusive. Empty = no tax line. */
    stripeTaxRateId: string | undefined;
    maxFileBytes: number;
    maxFilesPerLead: number;
    maxFilesPerRequest: number;
}

function required(name: string): string {
    const value = process.env[name];
    if (value == null || value.trim() === '') {
        throw new Error(`Missing required environment variable ${name}`);
    }
    return value.trim();
}

function optional(name: string, fallback: string): string {
    const value = process.env[name];
    if (value == null || value.trim() === '') {
        return fallback;
    }
    return value.trim();
}

function trimTrailingSlash(value: string): string {
    if (value.endsWith('/')) {
        return value.slice(0, -1);
    }
    return value;
}

export function loadConfig(): AppConfig {
    const prefix = optional('S3_PREFIX', 'dd-experiment').replace(/^\/+|\/+$/g, '');
    return {
        port: Number(optional('PORT', '3000')),
        publicBaseUrl: trimTrailingSlash(optional('PUBLIC_BASE_URL', 'https://api.raportcf.ro')),
        landingBaseUrl: trimTrailingSlash(optional('LANDING_BASE_URL', 'https://raportcf.ro')),
        allowedOrigins: optional('ALLOWED_ORIGINS', 'https://raportcf.ro,https://www.raportcf.ro')
            .split(',')
            .map(origin => origin.trim())
            .filter(origin => origin.length > 0),
        awsRegion: optional('AWS_REGION', 'eu-central-1'),
        awsAccessKeyId: required('AWS_ACCESS_KEY_ID'),
        awsSecretAccessKey: required('AWS_SECRET_ACCESS_KEY'),
        s3Bucket: optional('S3_BUCKET', 'imobile-private-files'),
        s3Prefix: prefix,
        // Set only for a local S3 stand-in (MinIO). Empty means real AWS.
        s3Endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
        // Host the browser can reach for presigned links when the API-side endpoint is a compose hostname.
        s3PublicEndpoint: process.env.S3_PUBLIC_ENDPOINT?.trim() || undefined,
        // Postgres in the same compose network; only the password is a secret.
        pgHost: optional('PGHOST', 'postgres'),
        pgPort: Number(optional('PGPORT', '5432')),
        pgDatabase: optional('PGDATABASE', 'ddintake'),
        pgUser: optional('PGUSER', 'ddintake'),
        pgPassword: required('PGPASSWORD'),
        slackWebhookUrl: process.env.SLACK_WEBHOOK_URL?.trim() || undefined,
        slackBotToken: process.env.SLACK_BOT_TOKEN?.trim() || undefined,
        slackChannel: process.env.SLACK_CHANNEL?.trim() || undefined,
        presignedUrlTtlSeconds: Number(optional('PRESIGNED_URL_TTL_SECONDS', String(7 * 24 * 3600))),
        reportLinkTtlSeconds: Number(optional('REPORT_LINK_TTL_SECONDS', String(15 * 60))),
        maxReportBytes: Number(optional('MAX_REPORT_BYTES', String(40 * 1024 * 1024))),
        sesFrom: process.env.SES_FROM?.trim() || undefined,
        sesReplyTo: process.env.SES_REPLY_TO?.trim() || undefined,
        sesRegion: optional('SES_REGION', optional('AWS_REGION', 'eu-central-1')),
        stripeSecretKey: process.env.STRIPE_SECRET_KEY?.trim() || undefined,
        stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || undefined,
        reportPriceRon: Number(optional('REPORT_PRICE_RON', '150')),
        paymentEnabled: optional('PAYMENT_ENABLED', 'true') === 'true',
        stripeTaxRateId: process.env.STRIPE_TAX_RATE_ID?.trim() || undefined,
        maxFileBytes: Number(optional('MAX_FILE_BYTES', String(10 * 1024 * 1024))),
        maxFilesPerLead: Number(optional('MAX_FILES_PER_LEAD', '28')),
        maxFilesPerRequest: Number(optional('MAX_FILES_PER_REQUEST', '28'))
    };
}
