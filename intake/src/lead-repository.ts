import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import type { Attribution, FileKind, Lead, PropertyType, Report, StoredFile } from './lead';

export interface LeadListRow {
    id: string;
    createdAt: string;
    propertyType: PropertyType;
    email: string;
    fileCount: number;
    utmSource?: string;
    utmCampaign?: string;
    reportUploadedAt?: string;
    reportSentAt?: string;
    reportViewedAt?: string;
}

interface LeadRow {
    id: string;
    created_at: Date;
    email: string;
    phone: string;
    property_type: PropertyType;
    cadastral_number: string | null;
    fetch_cf: boolean;
    terms_accepted: boolean;
    ai_consent_accepted: boolean;
    attribution: Attribution;
    client: Lead['client'];
    report_s3_key: string | null;
    report_original_name: string | null;
    report_size: string | null;
    report_uploaded_at: Date | null;
    report_token: string | null;
    report_sent_at: Date | null;
    report_sent_count: number;
    report_viewed_at: Date | null;
    report_view_count: number;
}

interface FileRow {
    kind: FileKind;
    s3_key: string;
    original_name: string;
    content_type: string;
    size: string;
    uploaded_at: Date;
}

interface ListRow {
    id: string;
    created_at: Date;
    property_type: PropertyType;
    email: string;
    file_count: string;
    utm_source: string | null;
    utm_campaign: string | null;
    report_uploaded_at: Date | null;
    report_sent_at: Date | null;
    report_viewed_at: Date | null;
}

/**
 * Postgres is the system of record for leads; the uploaded documents themselves live in S3 and
 * lead_files only points at them by key.
 */
export class LeadRepository {

    constructor(private readonly pool: Pool) {
    }

    async insert(lead: Lead): Promise<void> {
        await this.pool.query(
            `INSERT INTO leads (id, created_at, email, phone, property_type, cadastral_number, fetch_cf,
                                terms_accepted, ai_consent_accepted, attribution, client)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)`,
            [
                lead.id, lead.createdAt, lead.email, lead.phone, lead.propertyType, lead.cadastralNumber ?? null,
                lead.fetchCf, lead.termsAccepted, lead.aiConsentAccepted,
                JSON.stringify(lead.attribution), JSON.stringify(lead.client)
            ]
        );
    }

    /** Insert that ignores an existing id (used by the S3 importer). Returns true when a row was written. */
    async insertIfAbsent(lead: Lead): Promise<boolean> {
        const result = await this.pool.query(
            `INSERT INTO leads (id, created_at, email, phone, property_type, cadastral_number, fetch_cf,
                                terms_accepted, ai_consent_accepted, attribution, client)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
             ON CONFLICT (id) DO NOTHING`,
            [
                lead.id, lead.createdAt, lead.email, lead.phone, lead.propertyType, lead.cadastralNumber ?? null,
                lead.fetchCf, lead.termsAccepted, lead.aiConsentAccepted,
                JSON.stringify(lead.attribution), JSON.stringify(lead.client)
            ]
        );
        return (result.rowCount ?? 0) > 0;
    }

    async find(leadId: string): Promise<Lead | undefined> {
        const leadResult = await this.pool.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [leadId]);
        const row = leadResult.rows[0];
        if (row == null) {
            return undefined;
        }
        return this.withFiles(row);
    }

    /** The lead whose report link carries this token; undefined when the id and token do not match. */
    async findByReportToken(leadId: string, token: string): Promise<Lead | undefined> {
        const leadResult = await this.pool.query<LeadRow>(
            'SELECT * FROM leads WHERE id = $1 AND report_token = $2 AND report_s3_key IS NOT NULL',
            [leadId, token]
        );
        const row = leadResult.rows[0];
        if (row == null) {
            return undefined;
        }
        return this.withFiles(row);
    }

    private async withFiles(row: LeadRow): Promise<Lead> {
        const filesResult = await this.pool.query<FileRow>(
            'SELECT kind, s3_key, original_name, content_type, size, uploaded_at FROM lead_files WHERE lead_id = $1 ORDER BY id',
            [row.id]
        );
        return {
            id: row.id,
            createdAt: row.created_at.toISOString(),
            email: row.email,
            phone: row.phone,
            propertyType: row.property_type,
            cadastralNumber: row.cadastral_number ?? undefined,
            fetchCf: row.fetch_cf,
            termsAccepted: true,
            aiConsentAccepted: true,
            attribution: row.attribution ?? {},
            client: row.client ?? { ip: '' },
            files: filesResult.rows.map(file => ({
                kind: file.kind,
                key: file.s3_key,
                originalName: file.original_name,
                contentType: file.content_type,
                size: Number(file.size),
                uploadedAt: file.uploaded_at.toISOString()
            })),
            report: this.reportOf(row)
        };
    }

    private reportOf(row: LeadRow): Report | undefined {
        if (row.report_s3_key == null || row.report_token == null || row.report_uploaded_at == null) {
            return undefined;
        }
        return {
            key: row.report_s3_key,
            originalName: row.report_original_name ?? 'raport.pdf',
            size: Number(row.report_size ?? 0),
            uploadedAt: row.report_uploaded_at.toISOString(),
            token: row.report_token,
            sentAt: row.report_sent_at?.toISOString(),
            sentCount: row.report_sent_count,
            viewedAt: row.report_viewed_at?.toISOString(),
            viewCount: row.report_view_count
        };
    }

    /**
     * Records an uploaded report. The link token is created on the first upload and kept on
     * re-uploads, so a corrected PDF does not invalidate the link the customer already has.
     */
    async saveReport(leadId: string, key: string, originalName: string, size: number, uploadedAt: string): Promise<void> {
        const token = randomBytes(24).toString('base64url');
        await this.pool.query(
            `UPDATE leads
             SET report_s3_key = $2, report_original_name = $3, report_size = $4, report_uploaded_at = $5,
                 report_token = coalesce(report_token, $6)
             WHERE id = $1`,
            [leadId, key, originalName, size, uploadedAt, token]
        );
    }

    async recordReportSent(leadId: string): Promise<void> {
        await this.pool.query(
            'UPDATE leads SET report_sent_at = now(), report_sent_count = report_sent_count + 1 WHERE id = $1',
            [leadId]
        );
    }

    /** Returns the view count after this view, so the first one can be reported. */
    async recordReportView(leadId: string): Promise<number> {
        const result = await this.pool.query<{ report_view_count: number }>(
            'UPDATE leads SET report_viewed_at = now(), report_view_count = report_view_count + 1 WHERE id = $1 RETURNING report_view_count',
            [leadId]
        );
        return result.rows[0]?.report_view_count ?? 0;
    }

    async addFiles(leadId: string, files: StoredFile[]): Promise<void> {
        if (files.length === 0) {
            return;
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            for (const file of files) {
                await client.query(
                    `INSERT INTO lead_files (lead_id, kind, s3_key, original_name, content_type, size, uploaded_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (s3_key) DO NOTHING`,
                    [leadId, file.kind, file.key, file.originalName, file.contentType, file.size, file.uploadedAt]
                );
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async list(limit: number): Promise<LeadListRow[]> {
        const result = await this.pool.query<ListRow>(
            `SELECT l.id, l.created_at, l.property_type, l.email,
                    (SELECT count(*) FROM lead_files f WHERE f.lead_id = l.id) AS file_count,
                    l.attribution->>'utmSource' AS utm_source,
                    l.attribution->>'utmCampaign' AS utm_campaign,
                    l.report_uploaded_at, l.report_sent_at, l.report_viewed_at
             FROM leads l
             ORDER BY l.created_at DESC
             LIMIT $1`,
            [limit]
        );
        return result.rows.map(row => ({
            id: row.id,
            createdAt: row.created_at.toISOString(),
            propertyType: row.property_type,
            email: row.email,
            fileCount: Number(row.file_count),
            utmSource: row.utm_source ?? undefined,
            utmCampaign: row.utm_campaign ?? undefined,
            reportUploadedAt: row.report_uploaded_at?.toISOString(),
            reportSentAt: row.report_sent_at?.toISOString(),
            reportViewedAt: row.report_viewed_at?.toISOString()
        }));
    }

    /** Earlier leads from the same person, by normalized email or phone. Ready for the free-then-paid gate. */
    async countPrevious(email: string, phone: string, excludingLeadId?: string): Promise<number> {
        const result = await this.pool.query<{ count: string }>(
            `SELECT count(*) AS count FROM leads
             WHERE (lower(email) = lower($1) OR phone = $2) AND id <> coalesce($3, '')`,
            [email, phone, excludingLeadId ?? null]
        );
        return Number(result.rows[0]?.count ?? 0);
    }
}
