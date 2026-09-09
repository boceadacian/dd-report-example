export interface SniffedType {
    contentType: string;
    extension: string;
}

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heif'];

function startsWith(buffer: Buffer, bytes: number[]): boolean {
    if (buffer.length < bytes.length) {
        return false;
    }
    for (let i = 0; i < bytes.length; i++) {
        if (buffer[i] !== bytes[i]) {
            return false;
        }
    }
    return true;
}

/**
 * Identifies the file by its leading bytes. The client-declared content type is never trusted:
 * the experiment accepts uploads from anonymous callers, so only PDF, JPEG, PNG and HEIC/HEIF pass.
 */
export function sniffFileType(head: Buffer): SniffedType | undefined {
    if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) {
        return { contentType: 'application/pdf', extension: 'pdf' };
    }
    if (startsWith(head, [0xff, 0xd8, 0xff])) {
        return { contentType: 'image/jpeg', extension: 'jpg' };
    }
    if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return { contentType: 'image/png', extension: 'png' };
    }
    if (head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp') {
        const brand = head.toString('ascii', 8, 12).toLowerCase();
        if (HEIC_BRANDS.includes(brand)) {
            return { contentType: 'image/heic', extension: 'heic' };
        }
    }
    return undefined;
}

export function sanitizeFileName(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? 'file';
    const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    if (cleaned.length === 0) {
        return 'file';
    }
    return cleaned.slice(0, 80);
}
