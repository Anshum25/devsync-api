import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { Resend } from 'resend';

dotenv.config();

const app = express();
const PORT = 5001;

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Simple in-memory cache
let cache = {
  topHeadlinesIN: { data: null, ts: 0 },
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'devsync-api', time: new Date().toISOString() });
});

// Generic email sender with fallback: SMTP -> Resend API (if available)
const resend = new Resend(process.env.RESEND_API_KEY || '');

async function sendEmail({ to, subject, text, html, attachments = [], replyTo }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  // 1) Try SMTP first if configured
  if (host && user && pass) {
    try {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      const sendPromise = transporter.sendMail({ from: user, to, subject, text, html, attachments });
      const timeoutMs = 5000; // 5s SMTP timeout
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('smtp_timeout')), timeoutMs));
      await Promise.race([sendPromise, timeoutPromise]);
      return { ok: true, via: 'smtp' };
    } catch (e) {
      if (e?.message === 'smtp_timeout') {
        console.warn('[email] SMTP timed out after 5s, falling back');
      } else {
        console.warn('[email] SMTP failed, falling back:', e?.message || e);
      }
    }
  }

  // 2) Fallback to Resend if key present
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
  if (RESEND_API_KEY) {
    try {
      const send = resend.emails.send({
        from: FROM_EMAIL,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
        reply_to: replyTo,
        attachments: (attachments || []).map(a => ({
          filename: a.filename || 'attachment',
          content: a.content ? (Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content) : undefined,
        })).filter(x => x.content),
      });
      const timeoutMs = 10000;
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('resend_timeout')), timeoutMs));
      await Promise.race([send, timeoutPromise]);
      return { ok: true, via: 'resend' };
    } catch (e) {
      if (e?.message === 'resend_timeout') {
        console.error('[email] Resend timeout after 10s');
      } else {
        console.error('[email] Resend fallback failed:', e?.response?.status, e?.response?.data || e?.message || e);
      }
    }
  } else {
    console.warn('[email] RESEND_API_KEY not set; fallback unavailable');
  }

  return { ok: false };
}

// Contact: send simple message
app.post('/api/contact/send', async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, message: 'Missing required fields' });
    }

    const subject = `New Contact Message — ${name}`;
    const text = `New contact message received\n\nName: ${name}\nEmail: ${email}\n\nMessage:\n${message}`;
    const html = `
      <h2>New Contact Message</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Message:</strong></p>
      <pre style="white-space:pre-wrap;font-family:inherit;">${message}</pre>
    `;

    const to = process.env.CAREERS_TO_EMAIL || 'anshum25506@gmail.com';
    const sent = await sendEmail({ to, subject, text, html, replyTo: email });
    if (!sent.ok) return res.status(500).json({ ok: false, message: 'Failed to send message' });
    return res.json({ ok: true, via: sent.via });
  } catch (err) {
    console.error('[contact] send error:', err.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to send message' });
  }
});
// Careers: application email
app.post('/api/careers/apply', async (req, res) => {
  try {
    const { name, email, position, message, resume } = req.body || {};
    if (!name || !email || !position || !message) {
      return res.status(400).json({ ok: false, message: 'Missing required fields' });
    }

    const subject = `New Job Application: ${position} — ${name}`;
    const text = `New application received\n\nName: ${name}\nEmail: ${email}\nPosition: ${position}\n\nMessage:\n${message}`;
    const html = `
      <h2>New Job Application</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Position:</strong> ${position}</p>
      <p><strong>Message:</strong></p>
      <pre style="white-space:pre-wrap;font-family:inherit;">${message}</pre>
    `;

    const attachments = [];
    if (resume?.contentBase64 && resume?.filename) {
      try {
        const content = Buffer.from(resume.contentBase64, 'base64');
        attachments.push({
          filename: resume.filename,
          content,
          contentType: resume.mime || 'application/octet-stream',
        });
      } catch (e) {
        console.warn('[careers] failed to parse resume attachment:', e?.message || e);
      }
    }

    const to = process.env.CAREERS_TO_EMAIL || 'anshum25506@gmail.com';
    const sent = await sendEmail({ to, subject, text, html, attachments, replyTo: email });
    if (!sent.ok) return res.status(500).json({ ok: false, message: 'Failed to send application' });
    return res.json({ ok: true, via: sent.via });
  } catch (err) {
    console.error('[careers] apply error:', err.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to send application' });
  }
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
