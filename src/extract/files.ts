// Uploaded files are checked by their content (magic bytes), not their name or the browser's claim,
// before anything is sent to Claude. Files stay in memory; nothing here writes to disk.
import { PDFDocument } from 'pdf-lib';

export const LIMITS = { maxBytes: 5 * 1024 * 1024, maxPages: 5 };

export type MediaType = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp';
export type CheckedFile = { mediaType: MediaType; bytes: Buffer; pages: number };
export type FileProblem = { ok: false; error: 'empty' | 'too_large' | 'unsupported_type' | 'too_many_pages' | 'unreadable_pdf' | 'encrypted_pdf'; message: string };

export function sniffType(b: Buffer): MediaType | null {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export async function checkFile(bytes: Buffer): Promise<{ ok: true; file: CheckedFile } | FileProblem> {
  if (bytes.length === 0) return { ok: false, error: 'empty', message: 'The file is empty.' };
  if (bytes.length > LIMITS.maxBytes) return { ok: false, error: 'too_large', message: 'The file is larger than 5 MB.' };
  const mediaType = sniffType(bytes);
  if (!mediaType) return { ok: false, error: 'unsupported_type', message: 'Please upload a PDF, JPG, PNG or WebP file.' };
  if (mediaType !== 'application/pdf') return { ok: true, file: { mediaType, bytes, pages: 1 } };
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = pdf.getPageCount();
    if (pages > LIMITS.maxPages) return { ok: false, error: 'too_many_pages', message: `The PDF has ${pages} pages; the demo reads up to ${LIMITS.maxPages}.` };
    return { ok: true, file: { mediaType, bytes, pages } };
  } catch (err) {
    if (err instanceof Error && /encrypt/i.test(err.message)) return { ok: false, error: 'encrypted_pdf', message: 'The PDF is password-protected.' };
    return { ok: false, error: 'unreadable_pdf', message: 'The PDF could not be read.' };
  }
}
