# Invoice automation

Two connected pieces, built for **Harbourline Plumbing & Heating, a fictional company** (every supplier, invoice and bank detail in this repo is made up):

1. **AI document extraction:** reads supplier invoices and receipts into structured data, then checks every figure in code.
2. **An n8n workflow, "Supplier invoices: inbox to ledger":** files each invoice in a purchase ledger (Google Sheets) and asks for approval in Slack when something needs a person.

**Live demo:** https://invoices.raynors.dev. Pick a sample or upload your own document, then send a sample to Harbourline's inbox and approve or reject it.

## 1. Document extraction

1. **Reads the document.** Claude (Haiku 5.5) reads a PDF, scan or phone photo and returns the supplier, invoice number, dates, order reference, line items, totals and bank details as JSON. Structured outputs validate the JSON against a schema (`src/extract/schema.ts`). Values are recorded as printed, including wrong ones, and anything unreadable is null.
2. **Checks it in code**, not in the model (`src/extract/checks.ts`):
   - line maths, lines against the net, VAT rates and amounts, net + VAT = total
   - dates that are valid and in order
   - the supplier against Harbourline's records: VAT number, and bank details that have changed
   - duplicate invoice numbers
   Each problem becomes a flag with a plain-English message.
3. **Treats the document as data.** Text in a document addressed to "an AI" or "the accounts system" is reported as suspicious, never followed. Changed bank details are flagged by the code regardless of what the document says.

### Evaluation

22 generated documents with answer keys (`samples/`), including multi-page invoices, a credit note, a German invoice in euros, a scan, phone photos, and planted problems. 8 documents were held out of all tuning and read once at the end.

On the held-out set, Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 each read 112/112 fields and 73/73 line items correctly and caught 4/4 planted problems. Haiku 5.5 costs about $0.001 per document, so the demo uses it. Method, results, the answer-key corrections and the limits: [`eval/REPORT.md`](eval/REPORT.md).

## 2. The n8n workflow

Five workflows, generated from code by `n8n/build.mjs` (the JSON in `n8n/workflows/` is the build output, ready to import):

| Workflow | What it does |
| --- | --- |
| **Inbox** | An invoice arrives → it is read and checked through the extraction service → its invoice number is compared with the ledger (duplicates) → a row is added to the purchase ledger → if anything is flagged, an approval card (Approve / Reject) is posted to `#invoices` |
| **Decision** | Approve or Reject, from Slack or the demo page → the ledger row and the Slack card are updated with who decided and when |
| **Weekly summary** | Mondays at 8: invoices recorded in the last 7 days, totals by supplier, and what still waits for approval |
| **Tidy ledger** | Nightly: demo rows older than 7 days are removed |
| **Alerts** | Any failed run posts to `#alerts` |

The workflow logic lives in plain, tested modules (`n8n/src/`), inlined into n8n's Code nodes at build time. The tests run the generated Code nodes, not just the modules.

How it is put together:
- **n8n has no public address.** It sits on a private Docker network. The demo service forwards the page's requests to it with a shared key, and receives Slack's button clicks itself: it checks Slack's signature (Node's crypto, a five-minute window), answers within Slack's three seconds, and passes the click on.
- **n8n reads documents through an internal-only API** on the demo service (`POST /internal/extract`, key required, not routed by the proxy).
- **Each n8n credential is locked to its one host:** the Google service account to `sheets.googleapis.com`, the Slack token to `slack.com`, the internal key to the demo service.
- **The sheet is written in RAW mode**, so text from a document can never become a spreadsheet formula. Document text in Slack messages is escaped, so it can't mention `@channel` or add links.
- **Approvals are scoped.** On the demo page, a visitor can only decide invoices from their own visit, and an invoice can be decided once.

## The demo service

`src/server/` is a small Node service (no framework) serving the page (`web/`, Astro) and the API:
- **Uploads:** checked by content (magic bytes), at most 5 MB and 5 pages. Kept in memory for the request only; never written to disk or logged. Only the samples can be sent to the workflow.
- **Protection:** Cloudflare Turnstile before each reading or send, per-visitor limits (keyed by a salted hash of the IP address), and a daily spending cap. Past the cap, the samples use saved readings.
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
node n8n/build.mjs     # regenerate the n8n workflows
```

Deployment, the n8n setup and the checks after a deploy: [`docs/deploy.md`](docs/deploy.md).

## Layout

| Path | Contents |
| --- | --- |
| `src/extract/` | Schema, Claude call, checks, upload validation |
| `src/data/suppliers.ts` | Harbourline's (fictional) supplier records |
| `src/server/` | HTTP service, abuse protection, the Slack endpoint and n8n's internal API |
| `web/` | The demo page |
| `n8n/` | Workflow logic, build, credentials and deploy scripts, the built workflows |
| `samples/` | Generator, documents, answer keys, saved demo readings |
| `eval/` | Scoring, runner, held-out results and report |
| `scripts/` | Sample generator, sheet setup, smoke test |
| `deploy/` | Slack app manifest |
| `test/` | Unit tests |
