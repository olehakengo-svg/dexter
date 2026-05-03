import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, rmSync } from 'fs';

const { getCotReport } = await import('../../src/tools/finance/get_cot_report.js');

const cacheDir = '.dexter/cache/cot';

const sampleSocrata = [
  {
    report_date_as_yyyy_mm_dd: '2026-04-28T00:00:00.000',
    dealer_positions_long_all: '10',
    dealer_positions_short_all: '3',
    asset_mgr_positions_long: '20',
    asset_mgr_positions_short: '5',
    lev_money_positions_long: '30',
    lev_money_positions_short: '7',
    other_rept_positions_long: '40',
    other_rept_positions_short: '11',
  },
  {
    report_date_as_yyyy_mm_dd: '2026-04-21T00:00:00.000',
    dealer_positions_long_all: '8',
    dealer_positions_short_all: '4',
    asset_mgr_positions_long: '16',
    asset_mgr_positions_short: '6',
    lev_money_positions_long: '24',
    lev_money_positions_short: '8',
    other_rept_positions_long: '32',
    other_rept_positions_short: '10',
  },
];

function parseToolResult(raw: unknown): { data: unknown; sourceUrls?: string[] } {
  return JSON.parse(String(raw));
}

describe('get_cot_report', () => {
  beforeEach(() => {
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(sampleSocrata), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
    mock.restore();
  });

  test('parses Socrata JSON into net positioning rows', async () => {
    const result = parseToolResult(await getCotReport.invoke({ currency: 'JPY', weeks: 2 }));

    expect(result.data).toEqual([
      {
        report_date: '2026-04-28',
        dealer_net: 7,
        asset_mgr_net: 15,
        leveraged_net: 23,
        other_rep_net: 29,
      },
      {
        report_date: '2026-04-21',
        dealer_net: 4,
        asset_mgr_net: 10,
        leveraged_net: 16,
        other_rep_net: 22,
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('cache hit avoids a second fetch', async () => {
    await getCotReport.invoke({ currency: 'JPY', weeks: 1 });
    await getCotReport.invoke({ currency: 'JPY', weeks: 1 });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('unknown currency is rejected by zod', async () => {
    await expect(getCotReport.invoke({ currency: 'NZD', weeks: 1 })).rejects.toThrow();
  });
});
