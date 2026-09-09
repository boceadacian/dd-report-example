import { GetObjectCommand, ListObjectsV2Command, type ListObjectsV2CommandOutput, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '../config';
import { applySchema, createPool } from '../db';
import type { Lead } from '../lead';
import { LeadRepository } from '../lead-repository';

/**
 * One-off: copies the leads recorded as dd-experiment/{leadId}/lead.json (the S3-only version of the
 * service) into Postgres. Idempotent: existing lead ids and file keys are skipped. The S3 objects are
 * left in place. Run inside the compose network:
 *
 *   docker compose -f docker-compose.prod.yml run --rm intake node dist/tools/import-from-s3.js
 */
async function main(): Promise<void> {
    const config = loadConfig();
    const s3 = new S3Client({
        region: config.awsRegion,
        credentials: { accessKeyId: config.awsAccessKeyId, secretAccessKey: config.awsSecretAccessKey },
        endpoint: config.s3Endpoint,
        forcePathStyle: config.s3Endpoint != null
    });
    const pool = createPool(config);
    await applySchema(pool);
    const repository = new LeadRepository(pool);

    const keys: string[] = [];
    let continuationToken: string | undefined = undefined;
    do {
        const response: ListObjectsV2CommandOutput = await s3.send(new ListObjectsV2Command({
            Bucket: config.s3Bucket,
            Prefix: `${config.s3Prefix}/`,
            ContinuationToken: continuationToken
        }));
        for (const object of response.Contents ?? []) {
            if (object.Key != null && object.Key.endsWith('/lead.json')) {
                keys.push(object.Key);
            }
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken != null);

    let imported = 0;
    let skipped = 0;
    let filesImported = 0;
    for (const key of keys) {
        const response = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }));
        const body = await response.Body?.transformToString('utf-8');
        if (body == null) {
            console.warn(`empty object ${key}, skipped`);
            skipped++;
            continue;
        }
        const lead = JSON.parse(body) as Lead;
        const written = await repository.insertIfAbsent({ ...lead, attribution: lead.attribution ?? {}, files: lead.files ?? [] });
        if (written) {
            imported++;
        } else {
            skipped++;
        }
        // Files are keyed uniquely, so re-running never duplicates them.
        await repository.addFiles(lead.id, lead.files ?? []);
        filesImported += (lead.files ?? []).length;
    }
    console.log(`lead.json objects found: ${keys.length}, leads inserted: ${imported}, already present: ${skipped}, file rows offered: ${filesImported}`);
    await pool.end();
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
