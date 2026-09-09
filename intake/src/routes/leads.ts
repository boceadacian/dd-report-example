import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config';
import { sanitizeFileName, sniffFileType } from '../files';
import { FILE_KIND_RULES, fileKindForField, isValidLeadId, newLeadId, validateLeadInput, type FileKind, type Lead, type StoredFile } from '../lead';
import type { FileStorage } from '../file-storage';
import type { LeadRepository } from '../lead-repository';
import type { SlackNotifier } from '../slack';

interface LeadRouteDeps {
    config: AppConfig;
    leads: LeadRepository;
    files: FileStorage;
    slack: SlackNotifier;
}

interface RejectedFile {
    name: string;
    reason: string;
}

export function registerLeadRoutes(app: FastifyInstance, deps: LeadRouteDeps): void {
    const { config, leads, files, slack } = deps;

    app.post('/leads', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const { lead: input, failures, honeypot } = validateLeadInput(request.body);
        if (honeypot) {
            request.log.info({ ip: request.ip }, 'honeypot filled, dropping submission');
            return reply.code(201).send({ id: newLeadId() });
        }
        if (input == null) {
            return reply.code(400).send({ errors: failures });
        }

        const lead: Lead = {
            id: newLeadId(),
            createdAt: new Date().toISOString(),
            ...input,
            attribution: input.attribution ?? {},
            termsAccepted: true,
            aiConsentAccepted: true,
            client: {
                ip: request.ip,
                userAgent: request.headers['user-agent']?.slice(0, 300),
                acceptLanguage: request.headers['accept-language']?.slice(0, 100)
            },
            files: []
        };

        await leads.insert(lead);
        request.log.info({ leadId: lead.id, propertyType: lead.propertyType, fetchCf: lead.fetchCf }, 'lead saved');
        await slack.leadCreated(lead);
        return reply.code(201).send({ id: lead.id });
    });

    app.post<{ Params: { id: string } }>('/leads/:id/files', {
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const leadId = request.params.id;
        if (!isValidLeadId(leadId)) {
            return reply.code(400).send({ errors: [{ field: 'id', reason: 'invalid' }] });
        }
        if (!request.isMultipart()) {
            return reply.code(400).send({ errors: [{ field: 'body', reason: 'multipart/form-data expected' }] });
        }
        const lead = await leads.find(leadId);
        if (lead == null) {
            return reply.code(404).send({ errors: [{ field: 'id', reason: 'unknown lead' }] });
        }

        const stored: StoredFile[] = [];
        const rejected: RejectedFile[] = [];
        const countByKind = (kind: FileKind): number => lead.files.filter(file => file.kind === kind).length + stored.filter(file => file.kind === kind).length;
        let nextIndex = lead.files.length + 1;

        for await (const part of request.files({ limits: { files: config.maxFilesPerRequest, fileSize: config.maxFileBytes } })) {
            const originalName = sanitizeFileName(part.filename ?? 'file');
            const kind = fileKindForField(part.fieldname);
            if (kind == null) {
                rejected.push({ name: originalName, reason: `unknown field ${part.fieldname}; expected cf, cfPhotos, parkingCf, parkingCfPhotos or otherDocuments` });
                await part.toBuffer();
                continue;
            }
            const rule = FILE_KIND_RULES[kind];
            if (countByKind(kind) >= rule.max || lead.files.length + stored.length >= config.maxFilesPerLead) {
                rejected.push({ name: originalName, reason: `too many files for ${part.fieldname} (max ${rule.max})` });
                await part.toBuffer();
                continue;
            }
            const buffer = await part.toBuffer();
            if (part.file.truncated) {
                rejected.push({ name: originalName, reason: 'file too large' });
                continue;
            }
            const sniffed = sniffFileType(buffer.subarray(0, 16));
            if (sniffed == null) {
                rejected.push({ name: originalName, reason: 'unsupported type, only PDF, JPEG, PNG and HEIC are accepted' });
                continue;
            }
            const isPdf = sniffed.contentType === 'application/pdf';
            if ((rule.accepts === 'pdf' && !isPdf) || (rule.accepts === 'photo' && isPdf)) {
                rejected.push({ name: originalName, reason: rule.accepts === 'pdf' ? 'a PDF is expected here' : 'a photo (JPEG, PNG or HEIC) is expected here' });
                continue;
            }
            const key = files.fileKey(leadId, kind, nextIndex, originalName);
            await files.saveFile(key, buffer, sniffed.contentType, buffer.length);
            stored.push({
                kind,
                key,
                originalName,
                contentType: sniffed.contentType,
                size: buffer.length,
                uploadedAt: new Date().toISOString()
            });
            nextIndex++;
        }

        if (stored.length > 0) {
            await leads.addFiles(leadId, stored);
            lead.files.push(...stored);
            request.log.info({ leadId, added: stored.length, rejected: rejected.length }, 'files attached');
            await slack.filesAttached(lead, stored.length);
        }

        return reply.code(stored.length > 0 || rejected.length === 0 ? 200 : 400).send({
            id: leadId,
            stored: stored.map(file => ({ kind: file.kind, name: file.originalName, size: file.size, contentType: file.contentType })),
            rejected
        });
    });
}
