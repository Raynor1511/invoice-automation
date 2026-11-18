// Harbourline Plumbing & Heating's supplier records (all fictional). The checks compare each extracted
// invoice against these: an unknown supplier, a VAT number that doesn't match, or bank details that
// differ from the ones on file (a common invoice-fraud pattern) are flagged for a person.

export type Supplier = {
  id: string;
  name: string;
  /** Other names the supplier trades under or prints on documents. */
  aliases?: string[];
  vatNumber: string | null;
  bank: { sortCode: string; accountNumber: string } | null;
  category: 'parts' | 'vehicles' | 'fuel' | 'tools' | 'bathrooms' | 'waste' | 'services';
};

export const suppliers: Supplier[] = [
  { id: 'avon', name: 'Avon Plumbing Supplies Ltd', aliases: ['Avon Plumbing Supplies'], vatNumber: 'GB284719305', bank: { sortCode: '20-45-77', accountNumber: '43817260' }, category: 'parts' },
  { id: 'severn-vans', name: 'Severn Van Hire Ltd', aliases: ['Severn Van Hire'], vatNumber: 'GB397105482', bank: { sortCode: '30-91-12', accountNumber: '61029384' }, category: 'vehicles' },
  { id: 'boiler-spares', name: 'Bristol Boiler Spares', vatNumber: 'GB512866409', bank: { sortCode: '40-12-55', accountNumber: '27719046' }, category: 'parts' },
  { id: 'fuelpoint', name: 'FuelPoint Business Cards', aliases: ['FuelPoint'], vatNumber: 'GB608337214', bank: null, category: 'fuel' },
  { id: 'clifton-hardware', name: 'Clifton Hardware', vatNumber: 'GB731094566', bank: null, category: 'tools' },
  { id: 'westcountry-tile', name: 'Westcountry Tile & Bathroom', aliases: ['Westcountry Tile and Bathroom'], vatNumber: 'GB845201773', bank: { sortCode: '60-83-01', accountNumber: '55102938' }, category: 'bathrooms' },
  { id: 'harbour-waste', name: 'Harbour Waste Removal Ltd', aliases: ['Harbour Waste Removal'], vatNumber: 'GB926618840', bank: { sortCode: '09-01-29', accountNumber: '70834512' }, category: 'waste' },
  { id: 'kingswood-electrical', name: 'Kingswood Electrical Wholesale', vatNumber: 'GB173550926', bank: { sortCode: '20-17-44', accountNumber: '83390175' }, category: 'parts' },
  { id: 'heizteile', name: 'Heizteile Direkt GmbH', vatNumber: null, bank: null, category: 'parts' },
];

const normalise = (s: string) =>
  s.toLowerCase().replace(/&/g, ' and ').replace(/\b(ltd|limited|plc|llp|gmbh)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/** Finds the supplier by VAT number first (exact), then by name or alias. */
export function findSupplier(name: string | null, vatNumber: string | null): Supplier | null {
  const vat = vatNumber?.replace(/\s+/g, '').toUpperCase();
  if (vat) {
    const byVat = suppliers.find((s) => s.vatNumber === vat);
    if (byVat) return byVat;
  }
  if (!name) return null;
  const n = normalise(name);
  return suppliers.find((s) => [s.name, ...(s.aliases ?? [])].some((x) => normalise(x) === n)) ?? null;
}
