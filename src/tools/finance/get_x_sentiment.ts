import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

const X_RECENT_SEARCH_URL = 'https://api.x.com/2/tweets/search/recent';

const GetXSentimentInputSchema = z.object({
  query: z.string().min(1).describe('X recent-search query. Supports X search operators.'),
  lookback_hours: z.number().int().min(1).max(168).default(24).describe('Lookback window in hours, default 24 and max 168.'),
});

interface XApiTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
  };
}

interface XApiUser {
  id: string;
  username?: string;
  name?: string;
}

interface XApiResponse {
  data?: XApiTweet[];
  includes?: {
    users?: XApiUser[];
  };
}

export const getXSentiment = new DynamicStructuredTool({
  name: 'get_x_sentiment',
  description:
    'Searches recent X/Twitter posts and returns aggregate public engagement metrics plus the top five posts by likes. Use for current FX sentiment and macro-event discussion on X.',
  schema: GetXSentimentInputSchema,
  func: async (input) => {
    const token = process.env.X_BEARER_TOKEN;
    if (!token) {
      return formatToolResult({ error: 'X_BEARER_TOKEN is not set' });
    }

    const startTime = new Date(Date.now() - input.lookback_hours * 60 * 60 * 1000).toISOString();
    const url = new URL(X_RECENT_SEARCH_URL);
    url.searchParams.set('query', input.query);
    url.searchParams.set('tweet.fields', 'public_metrics,created_at,author_id');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'username,name');
    url.searchParams.set('max_results', '100');
    url.searchParams.set('start_time', startTime);

    try {
      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 429) {
        return formatToolResult({ error: 'X API rate limited', status: 429 });
      }

      if (!response.ok) {
        return formatToolResult({ error: 'X API request failed', status: response.status });
      }

      const raw = await response.json() as XApiResponse;
      const users = new Map((raw.includes?.users ?? []).map((user) => [user.id, user]));
      const tweets = raw.data ?? [];
      const enriched = tweets.map((tweet) => {
        const metrics = tweet.public_metrics ?? {};
        const author = tweet.author_id ? users.get(tweet.author_id) : undefined;
        return {
          author: author?.username ?? author?.name ?? tweet.author_id ?? 'unknown',
          text: tweet.text,
          likes: metrics.like_count ?? 0,
          retweets: metrics.retweet_count ?? 0,
          created_at: tweet.created_at ?? '',
        };
      });

      const totalLikes = enriched.reduce((sum, tweet) => sum + tweet.likes, 0);
      const totalRetweets = enriched.reduce((sum, tweet) => sum + tweet.retweets, 0);
      const topFive = [...enriched]
        .sort((a, b) => b.likes - a.likes)
        .slice(0, 5);

      return formatToolResult({
        tweet_count: tweets.length,
        total_likes: totalLikes,
        total_retweets: totalRetweets,
        top_5_by_likes: topFive,
      });
    } catch (error) {
      return formatToolResult({
        error: 'X API request failed',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

export const GET_X_SENTIMENT_DESCRIPTION = `
Searches X/Twitter recent search for current public discussion and engagement around an FX query.

## When to Use

- Gauging recent X sentiment for a currency pair, central-bank event, or macro headline
- Summarizing tweet volume, likes, retweets, and the top five posts by likes
- Checking the last 1-168 hours of X discussion with X search operators

Requires X_BEARER_TOKEN. A 429 response returns a structured rate-limit error.
`.trim();
