// Copies pdf.js's standard fonts into the page build, so PDFs that don't embed their fonts
// (common for invoices from accounting software) preview with the right letter shapes.
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('web/public/pdfjs', { recursive: true });
cpSync('node_modules/pdfjs-dist/standard_fonts', 'web/public/pdfjs/standard_fonts', { recursive: true });
console.log('Copied pdf.js standard fonts to web/public/pdfjs/standard_fonts');
