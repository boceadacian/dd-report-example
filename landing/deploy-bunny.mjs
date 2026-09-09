// Uploads dist/ to a Bunny storage zone and purges the pull zone.
//
//   BUNNY_STORAGE_ZONE=raportcf BUNNY_STORAGE_KEY=... [BUNNY_STORAGE_HOST=storage.bunnycdn.com] \
//   [BUNNY_API_KEY=... BUNNY_PULL_ZONE_ID=...] node deploy-bunny.mjs
//
// BUNNY_STORAGE_KEY is the storage zone's password (FTP & API Access page), not the account key.
// The purge needs the account API key and the numeric pull zone id; without them the upload
// still happens and the purge is skipped (edge caches expire on their own TTL).
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

const DIST = 'dist';
const zone = process.env.BUNNY_STORAGE_ZONE;
const key = process.env.BUNNY_STORAGE_KEY;
const host = process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';
if (!zone || !key) {
    console.error('BUNNY_STORAGE_ZONE and BUNNY_STORAGE_KEY are required');
    process.exit(1);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

async function walk(dir) {
    const out = [];
    for (const entry of await readdir(dir)) {
        const full = join(dir, entry);
        const info = await stat(full);
        if (info.isDirectory()) {
            out.push(...await walk(full));
        } else {
            out.push(full);
        }
    }
    return out;
}

const files = await walk(DIST);
for (const file of files) {
    const path = relative(DIST, file).split('\\').join('/');
    const body = await readFile(file);
    const response = await fetch(`https://${host}/${zone}/${path}`, {
        method: 'PUT',
        headers: { AccessKey: key, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' },
        body
    });
    if (!response.ok) {
        console.error(`FAILED ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
        process.exit(1);
    }
    console.log(`uploaded ${path} (${body.length} bytes)`);
}

const apiKey = process.env.BUNNY_API_KEY;
const pullZoneId = process.env.BUNNY_PULL_ZONE_ID;
if (apiKey && pullZoneId) {
    const response = await fetch(`https://api.bunny.net/pullzone/${pullZoneId}/purgeCache`, { method: 'POST', headers: { AccessKey: apiKey } });
    console.log(response.ok ? 'pull zone purged' : `purge failed: ${response.status}`);
} else {
    console.log('purge skipped (BUNNY_API_KEY / BUNNY_PULL_ZONE_ID not set)');
}
