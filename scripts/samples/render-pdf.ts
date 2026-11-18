// Renders a sample document as a PDF with pdfkit, in one of four supplier layouts.
import PDFDocument from 'pdfkit';
import { amounts, type Doc } from './data.ts';

export const BILL_TO = ['Harbourline Plumbing & Heating', 'Unit 4, Feeder Road Trade Park', 'Bristol BS2 0TE'];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const parts = (iso: string) => iso.split('-').map(Number) as [number, number, number];
export const fmtDate = {
  slash: (iso: string) => { const p = parts(iso); return `${String(p[2]).padStart(2, '0')}/${String(p[1]).padStart(2, '0')}/${p[0]}`; },
  words: (iso: string) => { const p = parts(iso); return `${p[2]} ${MONTHS[p[1] - 1]} ${p[0]}`; },
  short: (iso: string) => { const p = parts(iso); return `${p[2]} ${MONTHS[p[1] - 1]!.slice(0, 3)} ${p[0]}`; },
  dots: (iso: string) => { const p = parts(iso); return `${String(p[2]).padStart(2, '0')}.${String(p[1]).padStart(2, '0')}.${p[0]}`; },
};
export const gbp = (n: number) => `${n < 0 ? '-' : ''}£${Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const eur = (n: number) => `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const qtyStr = (q: number) => (Number.isInteger(q) ? String(q) : q.toFixed(2));

type Col = { label: string; x: number; w: number; align: 'left' | 'right' };

export function renderPdf(d: Doc): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: `${d.supplier.name} ${d.number}`, CreationDate: new Date(Date.UTC(2026, 10, 18)) } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  if (d.layout === 'modern') modern(doc, d);
  else if (d.layout === 'statement') statement(doc, d);
  else if (d.layout === 'german') german(doc, d);
  else classic(doc, d);
  if (d.hidden) {
    // Absolute positions below the bottom margin would make pdfkit start a new page.
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(4).fillColor('#f2f2f2').text(d.hidden, 48, 812, { width: 500, lineBreak: true });
  }
  doc.end();
  return done;
}

/** A table that continues onto new pages, returning the y after the last row. */
function table(doc: PDFKit.PDFDocument, cols: Col[], rows: string[][], top: number, opts: { header: (doc: PDFKit.PDFDocument) => number; rowH?: number; zebra?: string; headFill?: string; headColor?: string }) {
  const rowH = opts.rowH ?? 20;
  const head = (y: number) => {
    if (opts.headFill) doc.rect(48, y - 4, 499, rowH).fill(opts.headFill);
    doc.fillColor(opts.headColor ?? '#111').font('Helvetica-Bold').fontSize(8.5);
    for (const c of cols) doc.text(c.label, c.x, y + 1, { width: c.w, align: c.align });
    doc.moveTo(48, y + rowH - 4).lineTo(547, y + rowH - 4).strokeColor('#999').lineWidth(0.6).stroke();
    return y + rowH;
  };
  let y = head(top);
  rows.forEach((r, i) => {
    if (y > 740) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#555').text('Continued on next page', 48, 770, { width: 499, align: 'right' });
      doc.addPage();
      y = head(opts.header(doc));
    }
    if (opts.zebra && i % 2 === 1) doc.rect(48, y - 4, 499, rowH).fill(opts.zebra);
    doc.fillColor('#111').font('Helvetica').fontSize(9);
    for (const [j, c] of cols.entries()) doc.text(r[j] ?? '', c.x, y + 1, { width: c.w, align: c.align, lineBreak: false, ellipsis: true });
    y += rowH;
  });
  return y;
}

function pageNumbers(doc: PDFKit.PDFDocument) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor('#777').text(`Page ${i + 1} of ${range.count}`, 48, 800, { width: 499, align: 'center', lineBreak: false });
  }
}

function classic(doc: PDFKit.PDFDocument, d: Doc) {
  const a = amounts(d);
  const credit = d.type === 'credit_note';
  const header = (pdf: PDFKit.PDFDocument) => {
    pdf.font('Helvetica-Bold').fontSize(9).fillColor('#333').text(`${d.supplier.name}: ${credit ? 'credit note' : 'invoice'} ${d.number} (continued)`, 48, 48);
    return 78;
  };
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#1d3557').text(d.supplier.name, 48, 48);
  doc.font('Helvetica').fontSize(9).fillColor('#333').text(d.supplier.address, 48, 72).text(`Tel ${d.supplier.phone}${d.supplier.email ? `  ·  ${d.supplier.email}` : ''}`).text(d.supplier.vat ? `VAT reg. no. ${d.supplier.vat}` : '');
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#1d3557').text(credit ? 'CREDIT NOTE' : 'INVOICE', 330, 48, { width: 217, align: 'right' });
  const meta: [string, string][] = [
    [credit ? 'Credit note no.' : 'Invoice no.', d.number],
    ['Date', fmtDate.slash(d.date)],
    ...(d.due ? ([['Payment due', fmtDate.slash(d.due)]] as [string, string][]) : []),
    ...(d.po ? ([['Your order ref.', d.po]] as [string, string][]) : []),
  ];
  let my = 82;
  for (const [k, v] of meta) {
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(k, 360, my, { width: 90 });
    doc.font('Helvetica-Bold').fillColor('#111').text(v, 450, my, { width: 97, align: 'right' });
    my += 14;
  }
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#111').text(credit ? 'Credit to' : 'Invoice to', 48, 140);
  doc.font('Helvetica').text(BILL_TO.join('\n'), 48, 153);
  const cols: Col[] = [
    { label: 'Description', x: 52, w: 250, align: 'left' },
    { label: 'Qty', x: 300, w: 40, align: 'right' },
    { label: 'Unit price', x: 345, w: 70, align: 'right' },
    { label: 'VAT', x: 420, w: 40, align: 'right' },
    { label: 'Amount', x: 465, w: 78, align: 'right' },
  ];
  const rows = d.lines.map((l, i) => [l.description, qtyStr(l.qty), gbp(l.unit), `${l.vat}%`, gbp(a.lineTotals[i]!)]);
  let y = table(doc, cols, rows, 210, { header, zebra: '#f4f6f8', headFill: '#e3e9ef' });
  if (y > 690) { doc.addPage(); y = header(doc); }
  y += 10;
  const tot: [string, string][] = [['Subtotal', gbp(a.net)], ['VAT', gbp(a.vat)], [credit ? 'Total credit' : 'Total due', gbp(a.total)]];
  tot.forEach(([k, v], i) => {
    const bold = i === tot.length - 1;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5).fillColor('#111').text(k, 360, y, { width: 90 }).text(v, 450, y, { width: 93, align: 'right' });
    y += bold ? 18 : 15;
  });
  y += 14;
  if (d.bank) {
    doc.font('Helvetica-Bold').fontSize(9).text('Payment by bank transfer', 48, y);
    doc.font('Helvetica').text(`Account name: ${d.supplier.name}   Sort code: ${d.bank.sortCode}   Account no.: ${d.bank.account}   Reference: ${d.number}`, 48, y + 13, { width: 499 });
    y += 40;
  }
  doc.font('Helvetica').fontSize(8).fillColor('#666').text(credit ? 'This credit will be applied to your account.' : `Terms: payment ${d.due ? 'by the due date shown' : 'on receipt'}. Goods remain our property until paid for in full.`, 48, y, { width: 499 });
  pageNumbers(doc);
}

function modern(doc: PDFKit.PDFDocument, d: Doc) {
  const a = amounts(d);
  doc.rect(0, 0, 595, 96).fill('#0f4c5c');
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff').text(d.supplier.name.toUpperCase(), 48, 34, { characterSpacing: 1 });
  doc.font('Helvetica').fontSize(8.5).fillColor('#cfe3e8').text(`${d.supplier.address}  |  ${d.supplier.phone}`, 48, 62);
  doc.font('Helvetica').fontSize(9).fillColor('#555').text('BILLED TO', 48, 122);
  doc.font('Helvetica').fontSize(10).fillColor('#111').text(BILL_TO.join('\n'), 48, 136);
  const meta: [string, string][] = [['Invoice', d.number], ['Issued', fmtDate.words(d.date)], ['Due', d.due ? fmtDate.words(d.due) : ''], ['VAT number', d.supplier.vat ?? '']];
  meta.filter(([, v]) => v).forEach(([k, v], i) => {
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(k, 330, 122 + i * 16, { width: 80 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111').text(v, 405, 122 + i * 16, { width: 142, align: 'right' });
  });
  const cols: Col[] = [
    { label: 'ITEM', x: 52, w: 280, align: 'left' },
    { label: 'QTY', x: 330, w: 45, align: 'right' },
    { label: 'RATE', x: 380, w: 75, align: 'right' },
    { label: 'NET', x: 460, w: 83, align: 'right' },
  ];
  const rows = d.lines.map((l, i) => [l.description, qtyStr(l.qty), gbp(l.unit), gbp(a.lineTotals[i]!)]);
  let y = table(doc, cols, rows, 214, { header: () => 60, rowH: 22, headColor: '#0f4c5c' });
  y += 12;
  doc.rect(330, y, 217, 70).fill('#eef5f6');
  const tot: [string, string][] = [['Net', gbp(a.net)], [`VAT @ ${d.lines[0]?.vat ?? 20}%`, gbp(a.vat)], ['Amount due', gbp(a.total)]];
  tot.forEach(([k, v], i) => {
    const bold = i === 2;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5).fillColor(bold ? '#0f4c5c' : '#111').text(k, 342, y + 9 + i * 19, { width: 90 }).text(v, 430, y + 9 + i * 19, { width: 107, align: 'right' });
  });
  y += 92;
  if (d.bank) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f4c5c').text('HOW TO PAY', 48, y);
    doc.font('Helvetica').fontSize(9).fillColor('#111').text(`Bank transfer to ${d.supplier.name}\nSort code ${d.bank.sortCode}  ·  Account ${d.bank.account}\nPlease quote ${d.number}`, 48, y + 13);
  }
  doc.font('Helvetica').fontSize(8).fillColor('#777').text(d.supplier.email ? `Questions about this invoice? ${d.supplier.email}` : '', 48, 770, { width: 499, align: 'center' });
}

function statement(doc: PDFKit.PDFDocument, d: Doc) {
  const a = amounts(d);
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#c1121f').text('FuelPoint', 48, 48).font('Helvetica').fontSize(9).fillColor('#333').text('Business Cards', 48, 68);
  doc.text(`${d.supplier.address}  ·  Customer services ${d.supplier.phone}`, 48, 82).text(`VAT reg. ${d.supplier.vat}`);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111').text('Fuel card statement', 330, 48, { width: 217, align: 'right' });
  const meta: [string, string][] = [['Statement no.', d.number], ['Statement date', fmtDate.short(d.date)], ['Account', 'HPH-0042 (3 cards)'], ['Direct debit on', d.due ? fmtDate.short(d.due) : '']];
  meta.forEach(([k, v], i) => {
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(k, 360, 72 + i * 14, { width: 90 });
    doc.font('Helvetica-Bold').fillColor('#111').text(v, 450, 72 + i * 14, { width: 97, align: 'right' });
  });
  doc.font('Helvetica').fontSize(9).fillColor('#111').text(BILL_TO.join('\n'), 48, 140);
  const cols: Col[] = [
    { label: 'Transaction', x: 52, w: 300, align: 'left' },
    { label: 'Net', x: 355, w: 60, align: 'right' },
    { label: 'VAT 20%', x: 420, w: 55, align: 'right' },
    { label: 'Gross', x: 480, w: 63, align: 'right' },
  ];
  const rows = d.lines.map((l, i) => {
    const net = a.lineTotals[i]!;
    const v = Math.round(net * l.vat) / 100;
    return [l.description, gbp(net), gbp(v), gbp(Math.round((net + v) * 100) / 100)];
  });
  let y = table(doc, cols, rows, 200, { header: () => 60, zebra: '#fbf3f3' });
  y += 10;
  [['Total net', gbp(a.net)], ['Total VAT', gbp(a.vat)], ['Total to be collected', gbp(a.total)]].forEach(([k, v], i) => {
    doc.font(i === 2 ? 'Helvetica-Bold' : 'Helvetica').fontSize(i === 2 ? 11 : 9.5).fillColor('#111').text(k!, 330, y, { width: 130 }).text(v!, 460, y, { width: 83, align: 'right' });
    y += 16;
  });
  doc.font('Helvetica').fontSize(8).fillColor('#666').text('This statement is your VAT invoice. The total will be collected by Direct Debit on the date shown.', 48, y + 16, { width: 499 });
}

function german(doc: PDFKit.PDFDocument, d: Doc) {
  const a = amounts(d);
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#222').text(d.supplier.name, 48, 48);
  doc.font('Helvetica').fontSize(8.5).fillColor('#444').text(`${d.supplier.address}  ·  Tel. ${d.supplier.phone}  ·  USt-IdNr. ${d.supplier.vat}`, 48, 70);
  doc.font('Helvetica').fontSize(9).fillColor('#111').text(BILL_TO.join('\n') + '\nUnited Kingdom', 48, 120);
  doc.font('Helvetica-Bold').fontSize(18).text('Rechnung / Invoice', 300, 120, { width: 247, align: 'right' });
  const meta: [string, string][] = [['Rechnungsnummer', d.number], ['Rechnungsdatum', fmtDate.dots(d.date)], ['Fällig am', d.due ? fmtDate.dots(d.due) : ''], ['Ihre Bestellung', d.po ?? '']];
  meta.forEach(([k, v], i) => {
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(k, 340, 150 + i * 14, { width: 100 });
    doc.font('Helvetica-Bold').fillColor('#111').text(v, 440, 150 + i * 14, { width: 107, align: 'right' });
  });
  const cols: Col[] = [
    { label: 'Pos.', x: 52, w: 25, align: 'left' },
    { label: 'Bezeichnung', x: 80, w: 250, align: 'left' },
    { label: 'Menge', x: 330, w: 40, align: 'right' },
    { label: 'Einzelpreis', x: 375, w: 80, align: 'right' },
    { label: 'Gesamt', x: 460, w: 83, align: 'right' },
  ];
  const rows = d.lines.map((l, i) => [String(i + 1), l.description, qtyStr(l.qty), eur(l.unit), eur(a.lineTotals[i]!)]);
  let y = table(doc, cols, rows, 230, { header: () => 60, headFill: '#eeeeee' });
  y += 10;
  [['Nettobetrag', eur(a.net)], ['Umsatzsteuer 0 %', eur(a.vat)], ['Rechnungsbetrag', eur(a.total)]].forEach(([k, v], i) => {
    doc.font(i === 2 ? 'Helvetica-Bold' : 'Helvetica').fontSize(i === 2 ? 11 : 9.5).fillColor('#111').text(k!, 340, y, { width: 110 }).text(v!, 450, y, { width: 93, align: 'right' });
    y += 16;
  });
  doc.font('Helvetica').fontSize(8.5).fillColor('#444').text('Steuerfreie Ausfuhrlieferung / zero-rated export to the United Kingdom.', 48, y + 14, { width: 499 });
  doc.text(`Bankverbindung: IBAN ${d.iban ?? ''}  ·  BIC SOLADEST600  ·  Verwendungszweck: ${d.number}`, 48, y + 30, { width: 499 });
}
