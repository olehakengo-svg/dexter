---
id: dexter-fx-phase0-oanda-tools
title: Add FX research tools (oanda_audit / cot_report / x_sentiment) to dexter
status: done
priority: P2
created: 2026-05-03
owner: codex
runtime: bun
working_dir: /Users/jg-n-012/test/dexter
---

# Goal

Add 3 read-only FX research tools to dexter so that the agent can answer FX-context questions (macro events, COT positioning, X sentiment) without touching the existing fx-ai-trader codebase.

# Scope (HARD constraints)

- Edit only files inside `/Users/jg-n-012/test/dexter/`
- DO NOT touch `/Users/jg-n-012/fx-ai-trader/` or any sibling project
- DO NOT add trade-decision logic, promotion-gate logic, or LLM-as-judge for signals — fact retrieval only
- DO NOT introduce dependencies that aren't already in `package.json` unless strictly required (justify in PR description)

# Deliverables

## 1. `src/tools/finance/get_oanda_audit.ts`

Read-only Postgres query tool against the Render-hosted `oanda_audit` table.

- Input (zod schema):
  - `strategy_name: string` — exact match
  - `mode: "sent" | "filled"` — bridge_status; required (no default to enforce explicit choice; see [memory note: oanda_audit.entry_type 二義性])
  - `since_days: number` — default 7, max 90
- Output: aggregate stats (count, win_rate, total_pips, avg_pips, max_dd_pips) grouped by `entry_type`
- Connection: read `RENDER_POSTGRES_URL` from env (DO NOT use a local sqlite). Reject if env missing.
- Security:
  - Reject any non-SELECT keyword: regex-block `/\b(insert|update|delete|drop|alter|truncate|grant|revoke)\b/i` on the final composed SQL even though it's parameterized
  - Hard `LIMIT 1000` appended unconditionally
  - Bind all user-supplied values via `pg` parameterized queries — NEVER string-interpolate

## 2. `src/tools/finance/get_cot_report.ts`

Fetch and parse the CFTC weekly Financial Futures (Traders in Financial Futures, TFF) report.

- Source: https://www.cftc.gov/dea/futures/financial_lf.htm or the CSV mirror (pick a stable URL; document choice)
- Input:
  - `currency: "USD" | "JPY" | "EUR" | "GBP" | "AUD" | "CAD" | "CHF"`
  - `weeks: number` — default 8, max 52
- Output: array of `{ report_date, dealer_net, asset_mgr_net, leveraged_net, other_rep_net }`
- Cache parsed CSV in `.dexter/cache/cot/<currency>-<weeks>.json` with 24h TTL

## 3. `src/tools/finance/get_x_sentiment.ts`

X (Twitter) recent search via `X_BEARER_TOKEN`.

- Input:
  - `query: string` — passed to `tweet.fields=public_metrics`
  - `lookback_hours: number` — default 24, max 168
- Output: `{ tweet_count, total_likes, total_retweets, top_5_by_likes: [{author, text, likes, retweets, created_at}] }`
- Reject if `X_BEARER_TOKEN` env missing
- Rate-limit aware: catch 429, return structured error (not throw)

# Integration

- Register all 3 tools in `src/tools/index.ts` and `src/tools/registry.ts` following the existing `get_income_statements` pattern
- Tool descriptions written for LLM consumption (clear, present-tense, when-to-use)
- Add `RENDER_POSTGRES_URL` and (verify) `X_BEARER_TOKEN` to `env.example` as commented placeholders

# Tests (TDD — write tests first)

- `tests/tools/get_oanda_audit.test.ts` — mock pg client; cases:
  - happy path returns aggregated rows
  - mode missing → zod rejects
  - SQL injection attempt in strategy_name → parameterized query treats it as literal
  - missing env → returns structured error
- `tests/tools/get_cot_report.test.ts` — mock fetch; cases:
  - parses sample CSV correctly
  - cache hit avoids second fetch
  - unknown currency → zod rejects
- `tests/tools/get_x_sentiment.test.ts` — mock fetch; cases:
  - happy path returns aggregated metrics
  - 429 → structured error, not throw
  - missing token → structured error

Use `bun test`. Do not add jest config beyond what exists.

# Definition of Done

- `bun run typecheck` passes
- `bun test tests/tools/` all green (≥9 cases total)
- Tools listed in agent tool catalog (verify via `bun start` and `/help` showing them)
- README has a new `## FX Research Tools` section (3 short paragraphs, one per tool)
- No edits outside `/Users/jg-n-012/test/dexter/`
- Final report written to `.ai/runs/<UTC-timestamp>/final.md` summarizing files changed, tests added, and any deviations from this spec

# Reporting

On completion, write `.ai/runs/YYYYMMDD-HHMMSS/final.md` with:
- Status: PASS / CONDITIONAL PASS / FAIL
- Files created/modified (full list with line counts)
- Test results (`bun test` output summary)
- Any deviations from spec, with justification
- Caveats (e.g., couldn't verify Render connection without secret in sandbox)
