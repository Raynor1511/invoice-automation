// Lays out the "Harbourline purchase ledger" Google Sheet: UK locale and London time, the ledger tab
// with its columns, formats and status colours, and an About tab. Safe to run again; rows are kept.
// Run: npx tsx scripts/setup-sheet.ts   (SHEET_ID and GOOGLE_SERVICE_ACCOUNT_KEY_FILE in .env)
import { googleToken } from './lib/google.ts';
import { COLUMNS, LEDGER_TAB, STATUS } from '../n8n/src/ledger.mjs';

process.loadEnvFile('.env');
const id = process.env.SHEET_ID;
const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
if (!id || !keyFile) throw new Error('Set SHEET_ID and GOOGLE_SERVICE_ACCOUNT_KEY_FILE in .env');

const token = await googleToken(keyFile, 'https://www.googleapis.com/auth/spreadsheets');
const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const j = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(j.error?.message ?? j)}`);
  return j;
};
const batch = (requests: unknown[]) => api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
type Tab = { properties: { sheetId: number; title: string; index: number }; conditionalFormats?: unknown[] };
const tabs = async () => ((await api('?fields=sheets(properties(sheetId,title,index),conditionalFormats)')).sheets as Tab[]);

// 1. Locale, time zone, tabs.
let all = await tabs();
const setup: unknown[] = [{ updateSpreadsheetProperties: { properties: { locale: 'en_GB', timeZone: 'Europe/London' }, fields: 'locale,timeZone' } }];
if (!all.some((t) => t.properties.title === LEDGER_TAB)) {
  const blank = all.find((t) => /^Sheet1$/.test(t.properties.title));
  setup.push(blank ? { updateSheetProperties: { properties: { sheetId: blank.properties.sheetId, title: LEDGER_TAB }, fields: 'title' } } : { addSheet: { properties: { title: LEDGER_TAB, index: 0 } } });
}
if (!all.some((t) => t.properties.title === 'About')) setup.push({ addSheet: { properties: { title: 'About' } } });
await batch(setup);
all = await tabs();
const ledger = all.find((t) => t.properties.title === LEDGER_TAB)!;
const about = all.find((t) => t.properties.title === 'About')!;
const sid = ledger.properties.sheetId;

// 2. Header row and About text.
await api(`/values/${encodeURIComponent(`'${LEDGER_TAB}'!A1`)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [COLUMNS.map((c) => c.title)] }) });
const aboutText = [
  ['Harbourline purchase ledger (demo)'],
  [''],
  ['Harbourline Plumbing & Heating is a fictional company. Every supplier, invoice and bank detail here is made up.'],
  ['Rows are added by an n8n workflow when a visitor sends a sample invoice to "Harbourline\'s inbox" on https://invoices.raynors.dev.'],
  ['The workflow reads the document with AI, checks it in code, and asks for approval in Slack when something needs a person.'],
  ['Rows are removed after 7 days.'],
  [''],
  ['Built by Raynors.dev: https://raynors.dev'],
];
await api(`/values/${encodeURIComponent("'About'!A1")}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: aboutText }) });

// 3. Formatting. Old conditional rules are removed first so a re-run doesn't stack them.
const fmt: unknown[] = [];
for (let i = (ledger.conditionalFormats ?? []).length - 1; i >= 0; i--) fmt.push({ deleteConditionalFormatRule: { sheetId: sid, index: i } });
const range = (c0: number, c1: number, r0 = 1, r1 = 2000) => ({ sheetId: sid, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
fmt.push(
  { updateSheetProperties: { properties: { sheetId: sid, index: 0, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } }, fields: 'index,gridProperties.frozenRowCount,gridProperties.frozenColumnCount' } },
  { repeatCell: { range: range(0, COLUMNS.length, 0, 1), cell: { userEnteredFormat: { textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, backgroundColor: { red: 0.031, green: 0.216, blue: 0.2 }, verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(textFormat,backgroundColor,verticalAlignment)' } },
  { repeatCell: { range: range(0, COLUMNS.length), cell: { userEnteredFormat: { verticalAlignment: 'TOP', wrapStrategy: 'CLIP' } }, fields: 'userEnteredFormat(verticalAlignment,wrapStrategy)' } },
);
COLUMNS.forEach((c, i) => {
  fmt.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: c.width, hiddenByUser: Boolean(c.hidden) }, fields: 'pixelSize,hiddenByUser' } });
  const pattern = c.format === 'money' ? { type: 'NUMBER', pattern: '#,##0.00' } : c.format === 'date' ? { type: 'DATE', pattern: 'd mmm yyyy' } : c.format === 'datetime' ? { type: 'DATE_TIME', pattern: 'd mmm yyyy, hh:mm' } : null;
  if (pattern) fmt.push({ repeatCell: { range: range(i, i + 1), cell: { userEnteredFormat: { numberFormat: pattern } }, fields: 'userEnteredFormat.numberFormat' } });
  if (c.key === 'checks') fmt.push({ repeatCell: { range: range(i, i + 1), cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.wrapStrategy' } });
});
const statusCol = COLUMNS.findIndex((c) => c.key === 'status');
const colour = (hex: string) => ({ red: parseInt(hex.slice(0, 2), 16) / 255, green: parseInt(hex.slice(2, 4), 16) / 255, blue: parseInt(hex.slice(4, 6), 16) / 255 });
([[STATUS.review, 'fdf1dc', '7a4a05'], [STATUS.rejected, 'fbe9e5', 'b4321f'], [STATUS.approved, 'e4f4ec', '157a4c'], [STATUS.ready, 'e4f4ec', '157a4c']] as const).forEach(([text, bg, fg], index) =>
  fmt.push({ addConditionalFormatRule: { index, rule: { ranges: [range(statusCol, statusCol + 1)], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: text }] }, format: { backgroundColor: colour(bg), textFormat: { bold: true, foregroundColor: colour(fg) } } } } } }),
);
fmt.push(
  { updateSheetProperties: { properties: { sheetId: about.properties.sheetId, index: 1 }, fields: 'index' } },
  { updateDimensionProperties: { range: { sheetId: about.properties.sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 900 }, fields: 'pixelSize' } },
  { repeatCell: { range: { sheetId: about.properties.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } }, fields: 'userEnteredFormat.textFormat' } },
);
await batch(fmt);
console.log(`Sheet ready: tabs "${LEDGER_TAB}" and "About", ${COLUMNS.length} columns (${COLUMNS.filter((c) => c.hidden).length} hidden), UK locale, London time.`);
