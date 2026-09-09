import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { AppConfig } from './config';
import type { FileKind } from './lead';

/**
 * Uploaded documents go to S3 under dd-experiment/{leadId}/files/{kind}/NN-name.ext.
 * The lead itself is a Postgres row (see LeadRepository); S3 holds only the binaries.
 */
export class FileStorage {

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

    fileKey(leadId: string, kind: FileKind, index: number, fileName: string): string {
        return `${this.config.s3Prefix}/${leadId}/files/${kind}/${String(index).padStart(2, '0')}-${fileName}`;
    }

    /** One fixed key per lead, so a corrected upload replaces the previous report. */
    reportKey(leadId: string): string {
        return `${this.config.s3Prefix}/${leadId}/report/raport.pdf`;
    }

    /** SSE-S3 on AWS; a local MinIO without a KMS rejects the header. */
    private serverSideEncryption(): 'AES256' | undefined {
        return this.config.s3Endpoint == null ? 'AES256' : undefined;
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

    async presignedGetUrl(key: string): Promise<string> {
        return getSignedUrl(this.presignClient, new GetObjectCommand({
            Bucket: this.config.s3Bucket,
            Key: key
        }), { expiresIn: this.config.presignedUrlTtlSeconds });
    }

    /**
     * Short-lived links for the customer's report page: one that the browser renders inline and one
     * that downloads under a readable file name. S3 honours the response-* overrides only on signed requests.
     */
    async presignedReportUrls(key: string, downloadName: string, ttlSeconds: number): Promise<{ view: string; download: string }> {
        const safeName = downloadName.replace(/[^A-Za-z0-9._-]/g, '_');
        const view = await getSignedUrl(this.presignClient, new GetObjectCommand({
            Bucket: this.config.s3Bucket,
            Key: key,
            ResponseContentType: 'application/pdf',
            ResponseContentDisposition: `inline; filename="${safeName}"`
        }), { expiresIn: ttlSeconds });
        const download = await getSignedUrl(this.presignClient, new GetObjectCommand({
            Bucket: this.config.s3Bucket,
            Key: key,
            ResponseContentType: 'application/pdf',
            ResponseContentDisposition: `attachment; filename="${safeName}"`
        }), { expiresIn: ttlSeconds });
        return { view, download };
    }
}
