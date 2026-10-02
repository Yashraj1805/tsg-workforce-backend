// AI chat-assistant (see services/aiAssistant.js for how answers stay grounded in real
// data). Gated behind reports.read — the same permission that already governs seeing
// attendance data at all, so the assistant can never show anyone data their role
// couldn't already see through the dashboard/Excel exports.
const express = require('express');
const { requirePermission } = require('../middleware/auth');
const assistant = require('../services/aiAssistant');

const router = express.Router();

router.post('/ask', requirePermission('reports.read'), async (req, res) => {
  const { question, history } = req.body || {};
  if (!(question || '').trim()) return res.status(400).json({ error: 'question is required' });
  if (question.length > 500) return res.status(400).json({ error: 'Question is too long' });
  // Last 3 turns only — enough for "uska?"/"aur kal?" follow-ups without growing the
  // prompt unboundedly on a long chat.
  const recentHistory = Array.isArray(history) ? history.slice(-3).filter(h => h && h.question && h.answer).map(h => ({ question: String(h.question).slice(0, 300), answer: String(h.answer).slice(0, 500) })) : [];
  try {
    const result = await assistant.ask(question.trim(), req.user, recentHistory);
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json({ answer: result.answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
