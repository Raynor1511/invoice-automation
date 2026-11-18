// The purchase ledger's layout, shared by the sheet setup script and the n8n workflows (Code nodes
// get this file inlined at build time, so it is plain JavaScript with no imports).

export const LEDGER_TAB = 'Purchase ledger';

/** Columns in order. `hidden` columns are the workflow's own bookkeeping. */
export const COLUMNS = [
  { key: 'id', title: 'Row ID', width: 130 },
  { key: 'added', title: 'Added', width: 140, format: 'datetime' },
  { key: 'supplier', title: 'Supplier', width: 220 },
  { key: 'onFile', title: 'On file', width: 70 },
  { key: 'number', title: 'Invoice no.', width: 130 },
  { key: 'date', title: 'Invoice date', width: 100, format: 'date' },
  { key: 'due', title: 'Due', width: 100, format: 'date' },
  { key: 'po', title: 'Order ref.', width: 110 },
  { key: 'currency', title: 'Currency', width: 75 },
  { key: 'net', title: 'Net', width: 95, format: 'money' },
  { key: 'vat', title: 'VAT', width: 85, format: 'money' },
  { key: 'total', title: 'Total', width: 100, format: 'money' },
  { key: 'checks', title: 'Checks', width: 420 },
  { key: 'status', title: 'Status', width: 115 },
  { key: 'decidedBy', title: 'Decided by', width: 150 },
  { key: 'decidedAt', title: 'Decided at', width: 140, format: 'datetime' },
  { key: 'source', title: 'Document', width: 190 },
  { key: 'session', title: 'Session', width: 120, hidden: true },
  { key: 'supplierId', title: 'Supplier ID', width: 100, hidden: true },
  { key: 'slack', title: 'Slack message', width: 160, hidden: true },
];

export const STATUS = { ready: 'Ready to pay', review: 'Needs review', approved: 'Approved', rejected: 'Rejected' };

/** Column letter for a key ("A".."T"). */
export function col(key) {
  const i = COLUMNS.findIndex((c) => c.key === key);
  if (i < 0) throw new Error(`No ledger column ${key}`);
  return String.fromCharCode(65 + i);
}

export const LAST_COL = String.fromCharCode(65 + COLUMNS.length - 1);

/** A sheet row (array of cell values, as returned by the Sheets API) as an object keyed by column. */
export function rowToObject(values, rowNumber) {
  const o = { rowNumber };
  COLUMNS.forEach((c, i) => (o[c.key] = values[i] ?? ''));
  return o;
}

/** An object as a sheet row, in column order. */
export function objectToRow(o) {
  return COLUMNS.map((c) => (o[c.key] === undefined || o[c.key] === null ? '' : o[c.key]));
}
