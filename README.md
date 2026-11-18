# Invoice automation

AI document extraction for supplier invoices and receipts, with the checks done in code. Built for **Harbourline Plumbing & Heating, a fictional company**: every supplier, invoice and bank detail in this repo is made up.

**Live demo:** https://invoices.raynors.dev. Pick a sample or upload your own document.

## What it does

1. **Reads the document.** Claude (Haiku 5.5) reads a PDF, scan or phone photo and returns the supplier, invoice number, dates, order reference, line items, totals and bank details as JSON. Structured outputs validate the JSON against a schema (`src/extract/schema.ts`). Values are recorded as printed, including wrong ones, and anything unreadable is null.
2. **Checks it in code**, not in the model (`src/extract/checks.ts`):
   - line maths, lines against the net, VAT rates and amounts, net + VAT = total
   - dates that are valid and in order
   - the supplier against Harbourline's records: VAT number, and bank details that have changed
   - duplicate invoice numbers
   Each problem becomes a flag with a plain-English message.
3. **Treats the document as data.** Text in a document addressed to "an AI" or "the accounts system" is reported as suspicious, never followed. Changed bank details are flagged by the code regardless of what the document says.

## Evaluation

22 generated documents with answer keys (`samples/`), including multi-page invoices, a credit note, a German invoice in euros, a scan, phone photos, and planted problems. 8 documents were held out of all tuning and read once at the end.

On the held-out set, Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 each read 112/112 fields and 73/73 line items correctly and caught 4/4 planted problems. Haiku 5.5 costs about $0.001 per document, so the demo uses it. Method, results, the answer-key corrections and the limits: [`eval/REPORT.md`](eval/REPORT.md).

## The demo service

`src/server/` is a small Node service (no framework) serving the page (`web/`, Astro) and the API:
- **Uploads:** checked by content (magic bytes), at most 5 MB and 5 pages. Kept in memory for the request only; never written to disk or logged.
- **Protection:** Cloudflare Turnstile before each reading, per-visitor limits (keyed by a salted hash of the IP address), and a daily spending cap. When a limit applies, the samples show saved readings.
- **Hardening:** same-origin requests only, and a strict Content Security Policy with no inline scripts. Document text is only ever inserted into the page as text.

## Run it

Node 24. `ANTHROPIC_API_KEY` in `.env`.

```
npm ci
npm run check          # type check and tests (no API calls)
npm run build          # the page
npm start              # http://localhost:8080 (Turnstile off locally unless its keys are set)
npm run samples        # regenerate the sample documents and answer keys
npx tsx eval/run.ts    # evaluation on the tuning set (billed API calls)
```

Deployment: `compose.yml` (read-only container, no capabilities, behind a reverse proxy).

## Layout

| Path | Contents |
| --- | --- |
| `src/extract/` | Schema, Claude call, checks, upload validation |
| `src/data/suppliers.ts` | Harbourline's (fictional) supplier records |
| `src/server/` | HTTP service and abuse protection |
| `web/` | The demo page |
| `samples/` | Generator, documents, answer keys, saved demo readings |
| `eval/` | Scoring, runner, held-out results and report |
| `test/` | Unit tests |
