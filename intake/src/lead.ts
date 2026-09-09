import { randomBytes } from 'node:crypto';

export const PROPERTY_TYPES = ['apartment', 'land'] as const;
export type PropertyType = typeof PROPERTY_TYPES[number];

export interface Attribution {
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    utmTerm?: string;
    gclid?: string;
    fbclid?: string;
    fbp?: string;
    fbc?: string;
    landingVariant?: string;
    referrer?: string;
    landingUrl?: string;
}

/**
 * Mirrors the original submit flow: the property's CF as one PDF or up to 12 photos,
 * the parking CF as one PDF or up to 4 photos, plus a free "other documents" block to learn
 * what buyers actually have. The multipart field name selects the kind.
 */
export const FILE_KINDS = ['cf', 'cfPhoto', 'parkingCf', 'parkingCfPhoto', 'other'] as const;
export type FileKind = typeof FILE_KINDS[number];

export interface FileKindRule {
    field: string;
    max: number;
    /** 'pdf' or 'photo' restricts the content; 'any' accepts both (the "other documents" block). */
    accepts: 'pdf' | 'photo' | 'any';
}

export const FILE_KIND_RULES: Record<FileKind, FileKindRule> = {
    cf: { field: 'cf', max: 1, accepts: 'pdf' },
    cfPhoto: { field: 'cfPhotos', max: 12, accepts: 'photo' },
    parkingCf: { field: 'parkingCf', max: 1, accepts: 'pdf' },
    parkingCfPhoto: { field: 'parkingCfPhotos', max: 4, accepts: 'photo' },
    other: { field: 'otherDocuments', max: 10, accepts: 'any' }
};

export const CADASTRAL_NUMBER_PATTERN = /^\d{1,10}-C\d{1,4}-U\d{1,4}$/;

export interface StoredFile {
    kind: FileKind;
    key: string;
    originalName: string;
    contentType: string;
    size: number;
    uploadedAt: string;
}

/** The finished report, uploaded from the admin page and stored in S3 next to the lead's files. */
export interface Report {
    key: string;
    originalName: string;
    size: number;
    uploadedAt: string;
    /** Secret in the customer's link; rotating it invalidates every link sent so far. */
    token: string;
    sentAt?: string;
    sentCount: number;
    viewedAt?: string;
    viewCount: number;
}

/** Payment state; only meaningful when paymentRequired is true (a repeat customer). */
export interface Payment {
    required: boolean;
    /** The earlier lead that made this one a repeat. */
    previousLeadId?: string;
    stripeSessionId?: string;
    stripePaymentIntent?: string;
    paidAt?: string;
    /** Minor units (bani). */
    paidAmount?: number;
    paidCurrency?: string;
    /** Set when marked paid by hand (bank transfer, waived). */
    paidNote?: string;
}

export interface Lead {
    id: string;
    createdAt: string;
    email: string;
    phone: string;
    propertyType: PropertyType;
    /** Present when the visitor asked us to obtain the CF instead of uploading it. */
    cadastralNumber?: string;
    fetchCf: boolean;
    termsAccepted: true;
    aiConsentAccepted: true;
    attribution: Attribution;
    client: {
        ip: string;
        userAgent?: string;
        acceptLanguage?: string;
    };
    files: StoredFile[];
    report?: Report;
    payment: Payment;
}

export interface LeadInput {
    email: string;
    phone: string;
    propertyType: PropertyType;
    cadastralNumber?: string;
    fetchCf: boolean;
    termsAccepted: boolean;
    aiConsentAccepted: boolean;
    attribution?: Attribution;
    website?: string;
}

export interface ValidationFailure {
    field: string;
    reason: string;
}

// Same rules as the app: EmailValidationStrategy and PhoneNumberValidationStrategy for +40.
const EMAIL_PATTERN = /^(?=.{0,255}$)(?=.{0,64}@)(?:[a-zA-Z0-9!#$%&'*+/=?^_'{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_'{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f]){1,62}")@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?=[a-zA-Z0-9-]*[a-zA-Z][a-zA-Z0-9-]*$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const LEAD_ID_PATTERN = /^[0-9a-z]{8,32}$/;
const MAX_SHORT = 200;

function cleanString(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return undefined;
    }
    return trimmed.slice(0, max);
}

function cleanAttribution(value: unknown): Attribution {
    if (value == null || typeof value !== 'object') {
        return {};
    }
    const raw = value as Record<string, unknown>;
    const attribution: Attribution = {};
    const keys: (keyof Attribution)[] = [
        'utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm',
        'gclid', 'fbclid', 'fbp', 'fbc', 'landingVariant', 'referrer', 'landingUrl'
    ];
    for (const key of keys) {
        const cleaned = cleanString(raw[key], 500);
        if (cleaned != null) {
            attribution[key] = cleaned;
        }
    }
    return attribution;
}

export function isValidLeadId(value: string): boolean {
    return LEAD_ID_PATTERN.test(value);
}

export function newLeadId(): string {
    const time = Date.now().toString(36);
    const random = randomBytes(6).toString('hex');
    return `${time}${random}`;
}

export function validateLeadInput(body: unknown): { lead?: LeadInput; failures: ValidationFailure[]; honeypot: boolean } {
    const failures: ValidationFailure[] = [];
    if (body == null || typeof body !== 'object') {
        return { failures: [{ field: 'body', reason: 'expected a JSON object' }], honeypot: false };
    }
    const raw = body as Record<string, unknown>;

    const honeypot = cleanString(raw.website, 50) != null;

    const email = cleanString(raw.email, MAX_SHORT);
    if (email == null || !EMAIL_PATTERN.test(email)) {
        failures.push({ field: 'email', reason: 'invalid' });
    }

    const phone = normalizeRomanianPhone(cleanString(raw.phone, 50));
    if (phone == null) {
        failures.push({ field: 'phone', reason: 'invalid Romanian mobile number' });
    }

    const propertyType = cleanString(raw.propertyType, 20) as PropertyType | undefined;
    if (propertyType == null || !PROPERTY_TYPES.includes(propertyType)) {
        failures.push({ field: 'propertyType', reason: 'must be one of apartment, land' });
    }

    // Either the visitor uploads the CF afterwards, or leaves the cadastral number for us to obtain it.
    const cadastralNumber = cleanString(raw.cadastralNumber, 30)?.toUpperCase().replace(/\s+/g, '');
    if (cadastralNumber != null && !CADASTRAL_NUMBER_PATTERN.test(cadastralNumber)) {
        failures.push({ field: 'cadastralNumber', reason: 'expected the format XXXXXX-CX-UX' });
    }

    if (raw.termsAccepted !== true) {
        failures.push({ field: 'termsAccepted', reason: 'must be true' });
    }
    if (raw.aiConsentAccepted !== true) {
        failures.push({ field: 'aiConsentAccepted', reason: 'must be true' });
    }

    if (failures.length > 0) {
        return { failures, honeypot };
    }

    return {
        honeypot,
        failures,
        lead: {
            email: email as string,
            phone: phone as string,
            propertyType: propertyType as PropertyType,
            cadastralNumber,
            fetchCf: cadastralNumber != null,
            termsAccepted: true,
            aiConsentAccepted: true,
            attribution: cleanAttribution(raw.attribution)
        }
    };
}

export function fileKindForField(field: string | undefined): FileKind | undefined {
    if (field == null) {
        return undefined;
    }
    for (const kind of FILE_KINDS) {
        if (FILE_KIND_RULES[kind].field === field) {
            return kind;
        }
    }
    return undefined;
}

/**
 * Accepts what people type for a Romanian mobile number and returns it as +407XXXXXXXX,
 * or undefined when it is not one. National part follows the app's rule for +40:
 * 10 digits starting with 07, or 9 digits starting with 7.
 */
export function normalizeRomanianPhone(raw: string | undefined): string | undefined {
    if (raw == null) {
        return undefined;
    }
    let digits = raw.replace(/[\s().-]/g, '');
    if (digits.startsWith('+')) {
        digits = digits.slice(1);
    }
    if (!/^\d+$/.test(digits)) {
        return undefined;
    }
    if (digits.startsWith('0040')) {
        digits = digits.slice(4);
    } else if (digits.startsWith('40') && digits.length >= 11) {
        digits = digits.slice(2);
    }
    const valid = (digits.length === 10 && digits.startsWith('07')) || (digits.length === 9 && digits.startsWith('7'));
    if (!valid) {
        return undefined;
    }
    return '+40' + digits.slice(-9);
}
