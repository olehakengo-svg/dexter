import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const { getXSentiment } = await import('../../src/tools/finance/get_x_sentiment.js');

function parseToolResult(raw: unknown): { data: unknown; sourceUrls?: string[] } {
  return JSON.parse(String(raw));
}

describe('get_x_sentiment', () => {
  const originalEnv = process.env.X_BEARER_TOKEN;

  beforeEach(() => {
    process.env.X_BEARER_TOKEN = 'token';
    globalThis.fetch = mock(async () => Response.json({
      data: [
        {
          id: '1',
          author_id: 'u1',
          text: 'JPY is moving',
          created_at: '2026-05-03T00:00:00.000Z',
          public_metrics: { like_count: 2, retweet_count: 3 },
        },
        {
          id: '2',
          author_id: 'u2',
          text: 'USDJPY breakout',
          created_at: '2026-05-03T01:00:00.000Z',
          public_metrics: { like_count: 10, retweet_count: 1 },
        },
      ],
      includes: {
        users: [
          { id: 'u1', username: 'macro_one' },
          { id: 'u2', username: 'fx_two' },
        ],
      },
    }));
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.X_BEARER_TOKEN;
    } else {
      process.env.X_BEARER_TOKEN = originalEnv;
    }
    mock.restore();
  });

  test('happy path returns aggregated metrics and top tweets by likes', async () => {
    const result = parseToolResult(await getXSentiment.invoke({
      query: 'USDJPY',
      lookback_hours: 12,
    }));

    expect(result.data).toEqual({
      tweet_count: 2,
      total_likes: 12,
      total_retweets: 4,
      top_5_by_likes: [
        {
          author: 'fx_two',
          text: 'USDJPY breakout',
          likes: 10,
          retweets: 1,
          created_at: '2026-05-03T01:00:00.000Z',
        },
        {
          author: 'macro_one',
          text: 'JPY is moving',
          likes: 2,
          retweets: 3,
          created_at: '2026-05-03T00:00:00.000Z',
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(String((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]));
    expect(url.searchParams.get('tweet.fields')).toBe('public_metrics,created_at,author_id');
  });

  test('429 returns structured error and does not throw', async () => {
    globalThis.fetch = mock(async () => new Response('rate limited', { status: 429 }));

    const result = parseToolResult(await getXSentiment.invoke({ query: 'USDJPY' }));

    expect(result.data).toEqual({
      error: 'X API rate limited',
      status: 429,
    });
  });

  test('missing token returns structured error', async () => {
    delete process.env.X_BEARER_TOKEN;

    const result = parseToolResult(await getXSentiment.invoke({ query: 'USDJPY' }));

    expect(result.data).toEqual({
      error: 'X_BEARER_TOKEN is not set',
    });
    expect(fetch).toHaveBeenCalledTimes(0);
  });
});
