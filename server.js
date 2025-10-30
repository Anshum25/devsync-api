import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const app = express();
const PORT = 5001;

app.use(cors());
app.use(express.json());

// Simple in-memory cache
let cache = {
  topHeadlinesIN: { data: null, ts: 0 },
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'devsync-api', time: new Date().toISOString() });
});

app.get('/api/news/top-headlines', async (req, res) => {
  try {
    const country = (req.query.country || 'in').toString();
    const now = Date.now();
    const cacheKey = `topHeadlines_${country}`;

    if (!cache[cacheKey]) cache[cacheKey] = { data: null, ts: 0 };

    // Refresh cache every 10 minutes
    if (!cache[cacheKey].data || now - cache[cacheKey].ts > 30 * 60 * 1000) {
      const url = 'https://newsapi.org/v2/top-headlines';
      const params = {
        country,
        apiKey: process.env.NEWS_API_KEY,
        language: req.query.language || 'en',
        category: 'technology',
        pageSize: req.query.pageSize || 50,
      };

      console.log(`[news] Fetching top-headlines for country=${country}`);
      let { data } = await axios.get(url, { params });
      console.log(`[news] Received status=${data?.status} totalResults=${data?.totalResults}`);

      // Fallback to 'everything' when top-headlines is empty or irrelevant
      if (!data?.articles || data.articles.length === 0) {
        const eUrl = 'https://newsapi.org/v2/everything';
        const eParams = {
          q: req.query.q ||
            '("software development" OR "AI" OR "artificial intelligence" OR "machine learning" OR "automation" OR "cloud computing" OR "DevOps" OR "startups" OR "digital innovation" OR "web development" OR "UI/UX design" OR "product design" OR "data science" OR "engineering" OR "tech companies")',
          sortBy: 'publishedAt',
          language: req.query.language || 'en',
          pageSize: req.query.pageSize || 50,
          // Filter for credible tech and innovation sources
          domains: [
            'techcrunch.com',
            'theverge.com',
            'wired.com',
            'thenextweb.com',
            'venturebeat.com',
            'forbes.com',
            'businessinsider.com',
            'mashable.com',
            'zdnet.com',
            'medium.com',
            'developer-tech.com',
            'analyticsindiamag.com',
            'yourstory.com',
            'inc42.com',
            'techradar.com',
            'gizmodo.com',
          ].join(','),
          apiKey: process.env.NEWS_API_KEY,
        };

        console.log('[news] Top-headlines empty; fetching "everything" with params:', eParams);
        const eRes = await axios.get(eUrl, { params: eParams });
        data = eRes.data;
      }

      // ✅ Filter to ensure only tech-industry articles are returned
      const keywords = [
        'engineer',
        'engineering',
        'software',
        'developer',
        'development',
        'programming',
        'code',
        'coding',
        'technology',
        'tech',
        'it',
        'web',
        'app',
        'mobile',
        'react',
        'node',
        'python',
        'ai',
        'artificial intelligence',
        'machine learning',
        'ml',
        'cloud',
        'aws',
        'azure',
        'gcp',
        'devops',
        'product',
        'startup',
        'saas',
        'company',
        'business',
        'digital',
        'data',
        'innovation',
        'automation',
        'design',
        'ui',
        'ux',
      ];

      const matches = (text) => {
        if (!text) return false;
        const s = text.toLowerCase();
        return keywords.some((k) => s.includes(k));
      };

      const filtered = (data?.articles || []).filter(
        (a) =>
          matches(a?.title) ||
          matches(a?.description) ||
          matches(a?.content) ||
          matches(a?.source?.name)
      );

      data = { ...data, articles: filtered.slice(0, 40) }; // Limit to 40 latest relevant articles
      cache[cacheKey] = { data, ts: now };
      console.log(`[news] Filtered ${filtered.length} tech-relevant articles`);
    }

    res.json(cache[cacheKey].data);
  } catch (err) {
    const status = err.response?.status || 500;
    console.error('[news] Error', status, err.response?.data || err.message);
    res.status(status).json({
      status: 'error',
      message: err.response?.data?.message || err.message || 'Failed to fetch news',
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ DevSync API listening on http://localhost:${PORT}`);
});
