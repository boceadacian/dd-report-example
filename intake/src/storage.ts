import {
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    type ListObjectsV2CommandOutput,
    PutObjectCommand,
    S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { AppConfig } from './config';
import type { FileKind, Lead } from './lead';

export interface LeadSummary {
    id: string;
    lastModified?: Date;
}

/**
 * S3 is the system of record: dd-experiment/{leadId}/lead.json plus dd-experiment/{leadId}/files/*.
 * No database, so the box holding this service can be thrown away at any time.
 */
export class LeadStorage {

    private readonly client: S3Client;
    private readonly presignClient: S3Client;

    constructor(private readonly config: AppConfig) {
        this.client = this.buildClient(config.s3Endpoint);
        this.presignClient = config.s3PublicEndpoint != null ? this.buildClient(config.s3PublicEndpoint) : this.client;
    }

    private buildClient(endpoint: string | undefined): S3Client {
        return new S3Client({
            region: this.config.awsRegion,
            credentials: {
                accessKeyId: this.config.awsAccessKeyId,
                secretAccessKey: this.config.awsSecretAccessKey
            },
            endpoint,
            // Path-style is what MinIO speaks; AWS accepts it too but virtual-hosted is the default there.
            forcePathStyle: endpoint != null
        });
    }

    leadKey(leadId: string): string {
        return `${this.config.s3Prefix}/${leadId}/lead.json`;
    }

    fileKey(leadId: string, kind: FileKind, index: number, fileName: string): string {
        return `${this.config.s3Prefix}/${leadId}/files/${kind}/${String(index).padStart(2, '0')}-${fileName}`;
    }

    /** SSE-S3 on AWS; a local MinIO without a KMS rejects the header. */
    private serverSideEncryption(): 'AES256' | undefined {
        return this.config.s3Endpoint == null ? 'AES256' : undefined;
    }

    async saveLead(lead: Lead): Promise<void> {
        await this.client.send(new PutObjectCommand({
            Bucket: this.config.s3Bucket,
            Key: this.leadKey(lead.id),
            Body: JSON.stringify(lead, null, 2),
            ContentType: 'application/json',
            ServerSideEncryption: this.serverSideEncryption()
        }));
    }

    async loadLead(leadId: string): Promise<Lead | undefined> {
        try {
            const response = await this.client.send(new GetObjectCommand({
                Bucket: this.config.s3Bucket,
                Key: this.leadKey(leadId)
            }));
            const body = await response.Body?.transformToString('utf-8');
            if (body == null) {
                return undefined;
            }
            return JSON.parse(body) as Lead;
        } catch (error) {
            if (isNotFound(error)) {
                return undefined;
            }
            throw error;
        }
    }

    async leadExists(leadId: string): Promise<boolean> {
        try {
            await this.client.send(new HeadObjectCommand({
                Bucket: this.config.s3Bucket,
                Key: this.leadKey(leadId)
            }));
            return true;
        } catch (error) {
            if (isNotFound(error)) {
                return false;
            }
            throw error;
        }
    }

    async saveFile(key: string, body: Buffer | Readable, contentType: string, size: number): Promise<void> {
        await this.client.send(new PutObjectCommand({
            Bucket: this.config.s3Bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            ContentLength: size,
            ServerSideEncryption: this.serverSideEncryption()
        }));
    }

    async listLeads(limit: number): Promise<LeadSummary[]> {
        const summaries: LeadSummary[] = [];
        let continuationToken: string | undefined = undefined;
        do {
            const response: ListObjectsV2CommandOutput = await this.client.send(new ListObjectsV2Command({
                Bucket: this.config.s3Bucket,
                Prefix: `${this.config.s3Prefix}/`,
                ContinuationToken: continuationToken
            }));
            for (const object of response.Contents ?? []) {
                if (object.Key != null && object.Key.endsWith('/lead.json')) {
                    const id = object.Key.slice(this.config.s3Prefix.length + 1, -'/lead.json'.length);
                    summaries.push({ id, lastModified: object.LastModified });
                }
            }
            continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
        } while (continuationToken != null && summaries.length < limit * 4);
        summaries.sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0));
        return summaries.slice(0, limit);
    }

    async presignedGetUrl(key: string): Promise<string> {
        return getSignedUrl(this.presignClient, new GetObjectCommand({
            Bucket: this.config.s3Bucket,
            Key: key
        }), { expiresIn: this.config.presignedUrlTtlSeconds });
    }
}

function isNotFound(error: unknown): boolean {
    if (error == null || typeof error !== 'object') {
        return false;
    }
    const named = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    return named.name === 'NoSuchKey' || named.name === 'NotFound' || named.$metadata?.httpStatusCode === 404;
}
