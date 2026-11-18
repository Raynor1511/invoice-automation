import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { checkFile, LIMITS, sniffType } from '../src/extract/files.ts';

const sample = (f: string) => readFileSync(`samples/docs/${f}`);

async function pdfWithPages(n: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < n; i++) pdf.addPage([595.28, 841.89]);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/** A PDF whose trailer points at an encryption dictionary, as a password-protected PDF's does. */
async function encryptedPdf(): Promise<Buffer> {
  const src = (await pdfWithPages(1)).toString('latin1');
  const obj = '99 0 obj\n<< /Filter /Standard /V 2 /R 3 /Length 128 /P -4 /O <00> /U <00> >>\nendobj\n';
  const withObj = src.replace(/\nxref\n/, `\n${obj}xref\n`);
  return Buffer.from(withObj.replace('trailer\n<<', 'trailer\n<< /Encrypt 99 0 R'), 'latin1');
}

describe('sniffType reads the content, not the name', () => {
  test('PDF, JPEG, PNG and WebP are recognised by their first bytes', () => {
    expect(sniffType(sample('avon-invoice.pdf'))).toBe('application/pdf');
    expect(sniffType(sample('clifton-receipt.jpg'))).toBe('image/jpeg');
    expect(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png');
    expect(sniffType(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('image/webp');
  });

  test('anything else is not', () => {
    expect(sniffType(Buffer.from('<html><body>invoice</body></html>'))).toBeNull();
    expect(sniffType(Buffer.from('PK\x03\x04', 'latin1'))).toBeNull(); // a .docx or .zip
    expect(sniffType(Buffer.from('RIFF\x10\x00\x00\x00WAVE', 'latin1'))).toBeNull();
    expect(sniffType(Buffer.from('%PD'))).toBeNull();
  });
});

describe('checkFile', () => {
  test('every sample document passes, with its page count', async () => {
    const index: { file: string }[] = JSON.parse(readFileSync('samples/index.json', 'utf8'));
    for (const { file } of index) {
      const r = await checkFile(sample(file));
      expect(r.ok, file).toBe(true);
    }
    const long = await checkFile(sample('boiler-long-56-lines.pdf'));
    expect(long.ok && long.file.pages).toBe(3);
    const photo = await checkFile(sample('clifton-receipt.jpg'));
    expect(photo.ok && photo.file).toMatchObject({ mediaType: 'image/jpeg', pages: 1 });
  });

  test('empty and oversized files are refused before anything else', async () => {
    expect(await checkFile(Buffer.alloc(0))).toMatchObject({ ok: false, error: 'empty' });
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(LIMITS.maxBytes)]);
    expect(await checkFile(big)).toMatchObject({ ok: false, error: 'too_large' });
  });

  test('a file renamed to .pdf is refused by its content', async () => {
    expect(await checkFile(Buffer.from('MZ\x90\x00 not really a pdf', 'latin1'))).toMatchObject({ ok: false, error: 'unsupported_type' });
  });

  test('page limit: 5 pages are read, 6 are refused', async () => {
    expect(await checkFile(await pdfWithPages(LIMITS.maxPages))).toMatchObject({ ok: true, file: { pages: 5 } });
    const six = await checkFile(await pdfWithPages(LIMITS.maxPages + 1));
    expect(six).toMatchObject({ ok: false, error: 'too_many_pages' });
    expect(!six.ok && six.message).toBe('The PDF has 6 pages; the demo reads up to 5.');
  });

  test('broken and password-protected PDFs get their own messages', async () => {
    expect(await checkFile(Buffer.from('%PDF-1.7\nthis is not a pdf body'))).toMatchObject({ ok: false, error: 'unreadable_pdf' });
    expect(await checkFile(await encryptedPdf())).toMatchObject({ ok: false, error: 'encrypted_pdf' });
  });
});
