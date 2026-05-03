import { DynamicStructuredTool } from '@langchain/core/tools';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

const COT_API = 'https://publicreporting.cftc.gov/resource/gpe5-46if.json';
const CACHE_DIR = '.dexter/cache/cot';
const TTL_MS = 24 * 60 * 60 * 1000;

const CurrencySchema = z.enum(['USD', 'JPY', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF']);

const GetCotReportInputSchema = z.object({
  currency: CurrencySchema.describe('Currency futures market to retrieve from the CFTC TFF report.'),
  weeks: z.number().int().min(1).max(52).default(8).describe('Number of weekly rows to return, default 8 and max 52.'),
});

const COMMODITY_NAMES: Record<z.infer<typeof CurrencySchema>, string> = {
  USD: 'U.S. DOLLAR INDEX',
  JPY: 'JAPANESE YEN',
  EUR: 'EURO FX',
  GBP: 'BRITISH POUND',
  AUD: 'AUSTRALIAN DOLLAR',
  CAD: 'CANADIAN DOLLAR',
  CHF: 'SWISS FRANC',
};

interface CotRow {
  report_date: string;
  dealer_net: number;
  asset_mgr_net: number;
  leveraged_net: number;
  other_rep_net: number;
}

interface SocrataRow {
  report_date_as_yyyy_mm_dd?: string;
  dealer_positions_long_all?: string;
  dealer_positions_short_all?: string;
  asset_mgr_positions_long?: string;
  asset_mgr_positions_short?: string;
  lev_money_positions_long?: string;
  lev_money_positions_short?: string;
  other_rept_positions_long?: string;
  other_rept_positions_short?: string;
}

function toNum(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapRow(row: SocrataRow): CotRow {
  return {
    report_date: (row.report_date_as_yyyy_mm_dd ?? '').slice(0, 10),
    dealer_net: toNum(row.dealer_positions_long_all) - toNum(row.dealer_positions_short_all),
    asset_mgr_net: toNum(row.asset_mgr_positions_long) - toNum(row.asset_mgr_positions_short),
    leveraged_net: toNum(row.lev_money_positions_long) - toNum(row.lev_money_positions_short),
    other_rep_net: toNum(row.other_rept_positions_long) - toNum(row.other_rept_positions_short),
  };
}

function buildUrl(currency: z.infer<typeof CurrencySchema>, weeks: number): string {
  const commodity = COMMODITY_NAMES[currency];
  const params = new URLSearchParams();
  params.set('$where', `commodity_name='${commodity}'`);
  params.set('$order', 'report_date_as_yyyy_mm_dd DESC');
  params.set('$limit', String(weeks));
  return `${COT_API}?${params.toString()}`;
}

const ALLOWED_CURRENCIES = new Set(Object.keys(COMMODITY_NAMES));

function cachePath(currency: string, weeks: number): string {
  if (!ALLOWED_CURRENCIES.has(currency)) {
    throw new Error(`Invalid currency: ${currency}`);
  }
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) {
    throw new Error(`Invalid weeks: ${weeks}`);
  }
  const safeName = `${currency}-${weeks}.json`;
  if (!/^[A-Z]{3}-\d{1,2}\.json$/.test(safeName)) {
    throw new Error(`Refused unsafe cache filename: ${safeName}`);
  }
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return join(CACHE_DIR, safeName);
}

function readCached(currency: string, weeks: number): CotRow[] | null {
  const path = cachePath(currency, weeks);
  if (!existsSync(path)) return null;
  const ageMs = Date.now() - statSync(path).mtimeMs;
  if (ageMs > TTL_MS) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CotRow[];
  } catch {
    return null;
  }
}

function writeCached(currency: string, weeks: number, rows: CotRow[]): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(currency, weeks), JSON.stringify(rows, null, 2));
}

export const getCotReport = new DynamicStructuredTool({
  name: 'get_cot_report',
  description:
    'Fetches recent CFTC Traders in Financial Futures positioning for major FX futures and returns dealer, asset manager, leveraged money, and other reportable net positioning. Use for FX macro positioning context.',
  schema: GetCotReportInputSchema,
  func: async (input) => {
    const url = buildUrl(input.currency, input.weeks);

    const cached = readCached(input.currency, input.weeks);
    if (cached) {
      return formatToolResult(cached, [url]);
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        return formatToolResult({
          error: 'CFTC COT request failed',
          status: response.status,
        }, [url]);
      }
      const json = (await response.json()) as SocrataRow[];
      const rows = json.map(mapRow);
      writeCached(input.currency, input.weeks, rows);
      return formatToolResult(rows, [url]);
    } catch (error) {
      return formatToolResult({
        error: 'CFTC COT request failed',
        details: error instanceof Error ? error.message : String(error),
      }, [url]);
    }
  },
});

export const GET_COT_REPORT_DESCRIPTION = `
Fetches and parses the CFTC weekly Financial Futures Traders in Financial Futures report from the CFTC public Socrata dataset (${COT_API}).

## When to Use

- Checking recent futures positioning for USD, JPY, EUR, GBP, AUD, CAD, or CHF
- Comparing dealer, asset manager, leveraged money, and other reportable net positions
- Adding macro positioning context to FX research

Results are cached under .dexter/cache/cot for 24 hours.
`.trim();
