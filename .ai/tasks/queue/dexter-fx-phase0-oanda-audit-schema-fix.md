---
id: dexter-fx-phase0-oanda-audit-schema-fix
title: Rewrite get_oanda_audit to match real oanda_audit schema (no pips/strategy_name)
status: cancelled
cancelled_reason: Tool deleted entirely — Render Postgres does not exist. fx-ai-trader is SQLite-only.
priority: P1
created: 2026-05-03
owner: codex
runtime: bun
working_dir: /Users/jg-n-012/test/dexter
predecessor: dexter-fx-phase0-oanda-tools
---

# Why

The prior task (`dexter-fx-phase0-oanda-tools`) shipped `get_oanda_audit` with an **assumed schema** (`strategy_name`, `pips`) that does NOT match the real `oanda_audit` table in fx-ai-trader. The current SQL would error out on every real query with `column "strategy_name" does not exist`. Mock tests passed because they reflected the false assumption.

This task rewrites the tool to align with the actual schema and the dual-meaning rule for `entry_type`.

# Real schema (Source of Truth)

From `/Users/jg-n-012/test/fx-ai-trader/modules/demo_db.py:341-354` (verified 2026-05-03):

```sql
CREATE TABLE oanda_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL,
    demo_trade_id   TEXT,
    entry_type      TEXT,
    direction       TEXT,
    instrument      TEXT,
    units           INTEGER DEFAULT 0,
    is_live         INTEGER DEFAULT 0,
    bridge_status   TEXT,
    block_reason    TEXT DEFAULT '',
    oanda_trade_id  TEXT DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now'))
);
```

There is NO `strategy_name`, NO `pips`, NO `is_shadow` column on this table. P&L lives on `oanda_trades.pnl_pips` (separate table), shadow flag lives on `demo_trades.is_shadow` (separate table). Do NOT JOIN — keep this tool to single-table audit aggregates only.

# Twin-meaning rule for `entry_type` (memory: reference_oanda_audit_twin_meaning)

- When `bridge_status='sent'`: `entry_type` = real strategy name (e.g. `bb_rsi_reversion_v2`, `gbp_deep_pullback`)
- When `bridge_status='filled'`: `entry_type` = MODE name (e.g. `daytrade_gbpusd`)
- PYR_ children (`demo_trade_id LIKE 'PYR_%'`) only have 'filled' rows — strategy resolution requires JOIN, out of scope here

The tool MUST require explicit `bridge_status` (`mode` parameter) and surface this in the description.

# New tool surface

Replace the entire body of `src/tools/finance/get_oanda_audit.ts`.

## Input (zod)

- `entry_type: string` — exact match. Description: "When mode='sent', this is a strategy name; when mode='filled', this is a MODE name. See twin-meaning note in tool description."
- `mode: 'sent' | 'filled'` — required, no default.
- `since_days: number` — default 7, min 1, max 90, integer.
- `live_only: boolean` — default true. When true, filter `is_live = 1`.

## SQL (parameterized, single SELECT, hard LIMIT)

```sql
SELECT
  bridge_status,
  is_live,
  direction,
  instrument,
  COUNT(*)::int AS count,
  SUM(CASE WHEN block_reason IS NOT NULL AND block_reason <> '' THEN 1 ELSE 0 END)::int AS blocked_count,
  -- top block_reason (NULL if no blocks)
  (SELECT block_reason
     FROM oanda_audit oa2
     WHERE oa2.entry_type = oa.entry_type
       AND oa2.bridge_status = oa.bridge_status
       AND COALESCE(oa2.is_live, 0) = oa.is_live
       AND oa2.direction = oa.direction
       AND oa2.instrument = oa.instrument
       AND oa2.created_at >= NOW() - ($3::int * INTERVAL '1 day')
       AND oa2.block_reason IS NOT NULL
       AND oa2.block_reason <> ''
     GROUP BY block_reason
     ORDER BY COUNT(*) DESC
     LIMIT 1) AS top_block_reason
FROM oanda_audit oa
WHERE entry_type = $1
  AND bridge_status = $2
  AND created_at >= NOW() - ($3::int * INTERVAL '1 day')
  AND ($4::boolean IS FALSE OR is_live = 1)
GROUP BY bridge_status, is_live, direction, instrument
ORDER BY count DESC
LIMIT 1000
```

Bind values: `[entry_type, mode, since_days, live_only]`.

## Output

```typescript
{
  entry_type: string,
  mode: 'sent' | 'filled',
  since_days: number,
  live_only: boolean,
  rows: Array<{
    bridge_status: string,
    is_live: number,
    direction: string,
    instrument: string,
    count: number,
    blocked_count: number,
    top_block_reason: string | null,
  }>,
}
```

## Description for the LLM

Update both the `description` field on `DynamicStructuredTool` and the exported `GET_OANDA_AUDIT_DESCRIPTION` so the LLM knows:

- This tool returns audit-event aggregates, NOT trade P&L. For pips/win-rate, a separate tool is needed (not yet built).
- `entry_type` semantics depend on `mode`. Be explicit.
- `live_only=true` is the safer default; setting false includes paper trades.
- Ask LLM to never call with `live_only=false` unless the user explicitly asked for paper-trade diagnostics.

# Security requirements (unchanged)

- Read-only DB tool. Reject non-SELECT statements via the existing `assertReadOnlySql` regex check on the final composed SQL.
- Parameterized query via `pg` Client. NEVER string-interpolate user values into SQL.
- Hard LIMIT 1000.
- Connection comes from `RENDER_POSTGRES_URL` env. Reject if missing.

# Tests (replace existing tests/tools/get_oanda_audit.test.ts)

Use `bun:test` with mocked `pg.Client`. Cases (≥6):

1. happy path: returns aggregated rows for given entry_type/mode/live_only=true
2. mode missing → zod rejects
3. invalid mode value → zod rejects
4. SQL injection attempt in entry_type → still parameterized; mock pg verifies the value reaches `query()` as a bind param, not interpolated
5. missing RENDER_POSTGRES_URL env → returns structured error (not throw)
6. live_only=false → SQL emits the OR branch (verify via captured query string check)
7. since_days out of range (e.g. 0, 91) → zod rejects

Use `mock.module('pg', ...)` or jest-style mock to capture the `query()` call args.

# README update

Edit the `## FX Research Tools` section's get_oanda_audit paragraph in `README.md` to reflect:
- Surface change (entry_type instead of strategy_name)
- Twin-meaning note
- "audit aggregates only — for pips, JOIN tool will come separately"

# DoD

- `bun run typecheck` exits 0
- `bun test tests/tools/` all green (≥7 cases for get_oanda_audit + existing 4 cases for cot_report + 3 for x_sentiment = ≥14 total)
- `tests/tools/get_oanda_audit.test.ts` no longer references `strategy_name` or `pips` anywhere
- `src/tools/registry.ts` description updated to match new surface
- README updated
- Final report at `.ai/runs/<UTC-timestamp>/final.md` listing exact LOC changes and any deviations

# Out of scope (DO NOT do)

- Add JOINs to `demo_trades` or `oanda_trades` (separate future task)
- Run live queries against Render (sandbox can't reach external network anyway)
- Touch `get_cot_report.ts` or `get_x_sentiment.ts`
- Touch fx-ai-trader source code

# Reporting

Final report MUST state:
- Status: PASS / CONDITIONAL PASS / FAIL
- Files changed (paths + LOC delta)
- Test summary (numbers, names of new cases)
- Any spec deviations with justification
- Caveat about no live verification (acknowledge but do not block on)
