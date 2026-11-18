// Renders the "real world" samples: a till receipt photographed on a counter, and invoices that were
// printed and then scanned or photographed. Drawn as SVG, then aged with sharp (rotation, blur,
// shading, speckle noise) so they read like the documents a small business actually receives.
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { amounts, type Doc } from './data.ts';
import { BILL_TO, fmtDate, gbp } from './render-pdf.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
const seedOf = (id: string) => [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Random dark specks and light dropouts, as on a cheap scan or an old receipt. */
async function noise(width: number, height: number, seed: number, density: number): Promise<Buffer> {
  const r = rng(seed);
  const px = Buffer.alloc(width * height * 4);
  const n = Math.floor(width * height * density);
  for (let i = 0; i < n; i++) {
    const p = Math.floor(r() * width * height) * 4;
    const dark = r() < 0.6;
    px[p] = px[p + 1] = px[p + 2] = dark ? 40 : 255;
    px[p + 3] = Math.floor(60 + r() * 120);
  }
  return sharp(px, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function receiptSvg(d: Doc, faded: boolean): { svg: string; width: number; height: number } {
  const a = amounts(d);
  const width = 560;
  const ink = faded ? '#8a8a8a' : '#2b2b2b';
  const rows: string[] = [];
  let y = 70;
  const line = (left: string, right = '', size = 22, weight = 400) => {
    rows.push(`<text x="36" y="${y}" font-size="${size}" font-weight="${weight}">${esc(left)}</text>`);
    if (right) rows.push(`<text x="${width - 36}" y="${y}" font-size="${size}" font-weight="${weight}" text-anchor="end">${esc(right)}</text>`);
    y += size + 12;
  };
  const centre = (t: string, size = 22, weight = 400) => {
    rows.push(`<text x="${width / 2}" y="${y}" font-size="${size}" font-weight="${weight}" text-anchor="middle">${esc(t)}</text>`);
    y += size + 12;
  };
  centre(d.supplier.name.toUpperCase(), 30, 700);
  centre(d.supplier.address.split(', ').slice(0, 2).join(', '), 18);
  centre(`Tel ${d.supplier.phone}`, 18);
  centre(`VAT No ${d.supplier.vat}`, 18);
  y += 10;
  line(`${fmtDate.slash(d.date).replace(/\/20(\d\d)$/, '/$1')}  14:32`, `Rcpt ${d.number}`, 20);
  rows.push(`<line x1="36" y1="${y - 14}" x2="${width - 36}" y2="${y - 14}" stroke="${ink}" stroke-dasharray="6 6"/>`);
  y += 8;
  d.lines.forEach((l, i) => {
    line(l.description, '', 22);
    line(`  ${l.qty} @ ${gbp(l.unit)}`, `${gbp(a.lineTotals[i]!)} A`, 22);
  });
  rows.push(`<line x1="36" y1="${y - 10}" x2="${width - 36}" y2="${y - 10}" stroke="${ink}" stroke-dasharray="6 6"/>`);
  y += 10;
  line('TOTAL', gbp(a.total), 30, 700);
  line('CARD PAYMENT', gbp(a.total), 20);
  y += 8;
  line('VAT SUMMARY', '', 18, 700);
  line('A  20.0%   Net', gbp(a.net), 18);
  line('           VAT', gbp(a.vat), 18);
  y += 12;
  centre('THANK YOU FOR SHOPPING LOCAL', 18);
  centre('Keep this receipt for returns', 16);
  const height = y + 50;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="100%" height="100%" fill="#fbfaf6"/>
<g font-family="Consolas, 'Courier New', monospace" fill="${ink}">${rows.join('\n')}</g></svg>`;
  return { svg, width, height };
}

function invoiceSvg(d: Doc): { svg: string; width: number; height: number } {
  // A4 at 150 dpi.
  const width = 1240, height = 1754;
  const a = amounts(d);
  const t = (x: number, y: number, s: string, size = 20, opts = '') => `<text x="${x}" y="${y}" font-size="${size}" ${opts}>${esc(s)}</text>`;
  const out: string[] = [];
  out.push(t(100, 130, d.supplier.name, 40, 'font-weight="700" fill="#1d3557"'));
  out.push(t(100, 175, d.supplier.address, 19));
  out.push(t(100, 203, `Tel ${d.supplier.phone}${d.supplier.email ? `  ·  ${d.supplier.email}` : ''}`, 19));
  if (d.supplier.vat) out.push(t(100, 231, `VAT reg. no. ${d.supplier.vat}`, 19));
  out.push(t(1140, 130, 'INVOICE', 46, 'font-weight="700" fill="#1d3557" text-anchor="end"'));
  const meta: [string, string][] = [['Invoice no.', d.number], ['Date', fmtDate.slash(d.date)], ...(d.due ? [['Payment due', fmtDate.slash(d.due)] as [string, string]] : []), ...(d.po ? [['Your order ref.', d.po] as [string, string]] : [])];
  meta.forEach(([k, v], i) => {
    out.push(t(760, 185 + i * 30, k, 19, 'fill="#555"'));
    out.push(t(1140, 185 + i * 30, v, 19, 'font-weight="700" text-anchor="end"'));
  });
  out.push(t(100, 320, 'Invoice to', 19, 'font-weight="700"'));
  BILL_TO.forEach((l, i) => out.push(t(100, 348 + i * 26, l, 19)));
  let y = 470;
  out.push(`<rect x="95" y="${y - 30}" width="1050" height="42" fill="#e3e9ef"/>`);
  const cols: [string, number, string][] = [['Description', 105, 'start'], ['Qty', 700, 'end'], ['Unit price', 840, 'end'], ['VAT', 940, 'end'], ['Amount', 1135, 'end']];
  cols.forEach(([l, x, anchor]) => out.push(t(x, y, l, 19, `font-weight="700" text-anchor="${anchor}"`)));
  y += 48;
  d.lines.forEach((l, i) => {
    out.push(t(105, y, l.description, 20));
    out.push(t(700, y, String(l.qty), 20, 'text-anchor="end"'));
    out.push(t(840, y, gbp(l.unit), 20, 'text-anchor="end"'));
    out.push(t(940, y, `${l.vat}%`, 20, 'text-anchor="end"'));
    out.push(t(1135, y, gbp(a.lineTotals[i]!), 20, 'text-anchor="end"'));
    y += 42;
  });
  y += 30;
  ([['Subtotal', gbp(a.net)], ['VAT', gbp(a.vat)], ['Total due', gbp(a.total)]] as [string, string][]).forEach(([k, v], i) => {
    const bold = i === 2 ? 'font-weight="700"' : '';
    out.push(t(780, y, k, i === 2 ? 25 : 21, bold));
    out.push(t(1135, y, v, i === 2 ? 25 : 21, `${bold} text-anchor="end"`));
    y += 38;
  });
  y += 40;
  if (d.bank) {
    out.push(t(100, y, 'Payment by bank transfer', 20, 'font-weight="700"'));
    out.push(t(100, y + 32, `Account name: ${d.supplier.name}   Sort code: ${d.bank.sortCode}   Account no.: ${d.bank.account}   Reference: ${d.number}`, 18));
  }
  out.push(t(620, 1690, 'Page 1 of 1', 16, 'fill="#777" text-anchor="middle"'));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="100%" height="100%" fill="#ffffff"/>
<g font-family="Arial, Helvetica, sans-serif" fill="#1a1a1a">${out.join('\n')}</g></svg>`;
  return { svg, width, height };
}

/** Puts a document on a background with soft light falloff, as a phone photo would. */
async function photograph(page: Buffer, pw: number, ph: number, opts: { angle: number; bg: string; pad: number; seed: number }): Promise<Buffer> {
  const rotated = await sharp(page).rotate(opts.angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const meta = await sharp(rotated).metadata();
  const W = (meta.width ?? pw) + opts.pad * 2;
  const H = (meta.height ?? ph) + opts.pad * 2;
  const shading = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="g" cx="35%" cy="30%" r="85%"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.7" stop-color="#000" stop-opacity="0.18"/><stop offset="1" stop-color="#000" stop-opacity="0.42"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`,
  );
  return sharp({ create: { width: W, height: H, channels: 3, background: opts.bg } })
    .composite([
      { input: rotated, left: opts.pad, top: opts.pad },
      { input: shading, left: 0, top: 0 },
      { input: await noise(W, H, opts.seed, 0.002), left: 0, top: 0 },
    ])
    .blur(0.7)
    .modulate({ brightness: 0.97, saturation: 0.9 })
    .jpeg({ quality: 72 })
    .toBuffer();
}

export async function renderImage(d: Doc): Promise<{ bytes: Buffer; ext: 'jpg' | 'pdf' }> {
  const seed = seedOf(d.id);
  if (d.layout === 'receipt') {
    const faded = d.id.includes('faded');
    const { svg, width, height } = receiptSvg(d, faded);
    const page = await sharp(Buffer.from(svg)).png().toBuffer();
    return { bytes: await photograph(page, width, height, { angle: faded ? 3.5 : -5, bg: faded ? '#6b5a48' : '#3d4a52', pad: 90, seed }), ext: 'jpg' };
  }
  const { svg, width, height } = invoiceSvg(d);
  const page = await sharp(Buffer.from(svg)).png().toBuffer();
  if (d.render === 'photo') {
    return { bytes: await photograph(page, width, height, { angle: 2.5, bg: '#8c6f52', pad: 70, seed }), ext: 'jpg' };
  }
  // Scan: greyscale, slightly crooked, speckled, compressed, then wrapped in a PDF like a scanner makes.
  const crooked = await sharp(page).rotate(0.9, { background: '#ffffff' }).png().toBuffer();
  const cm = await sharp(crooked).metadata();
  const scanned = await sharp(crooked)
    .composite([{ input: await noise(cm.width!, cm.height!, seed, 0.0015), left: 0, top: 0 }])
    .greyscale()
    .linear(1.15, -18)
    .jpeg({ quality: 55 })
    .toBuffer();
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date(Date.UTC(2026, 10, 18)));
  pdf.setModificationDate(new Date(Date.UTC(2026, 10, 18)));
  const img = await pdf.embedJpg(scanned);
  const p = pdf.addPage([595.28, 841.89]);
  p.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
  return { bytes: Buffer.from(await pdf.save()), ext: 'pdf' };
}
