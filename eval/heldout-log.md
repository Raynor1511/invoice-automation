# Held-out runs

Every run that included the held-out documents, in order. The first run per model is the published result.

- 2026-11-18T21:21:18.061Z  claude-haiku-5-5 (effort low), set heldout: fields 99.1%, lines 100.0%, problems 4/4, $0.009 → eval/runs/2026-11-18T21-21-18_claude-haiku-5-5_low_heldout.json
- 2026-11-18T21:21:19.985Z  claude-sonnet-5-5 (effort low), set heldout: fields 99.1%, lines 100.0%, problems 4/4, $0.145 → eval/runs/2026-11-18T21-21-19_claude-sonnet-5-5_low_heldout.json
- 2026-11-18T21:21:25.387Z  claude-opus-5-5 (effort low), set heldout: fields 99.1%, lines 100.0%, problems 4/4, $0.292 → eval/runs/2026-11-18T21-21-25_claude-opus-5-5_low_heldout.json
- 2026-11-18  Answer-key correction after the runs above: avon-lines-vs-net uses the modern layout, which prints no PO number, but its key expected HPH-PO-2318. All three models had recorded null, which is correct. The key now expects null; the saved readings were re-scored with eval/rescore.ts (no new API calls): fields 111/112 -> 112/112 for each model.
