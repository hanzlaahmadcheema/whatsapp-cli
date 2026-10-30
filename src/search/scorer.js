"use strict";

const SCORE_WEIGHTS = Object.freeze({
  EXACT_SENDER: 100,
  EXACT_FILENAME: 90,
  EXACT_CONTENT: 80,
  WHOLE_WORD_SENDER: 70,
  WHOLE_WORD_FILENAME: 60,
  EXACT_CAPTION: 55,
  WHOLE_WORD_CONTENT: 50,
  PARTIAL_SENDER: 40,
  PARTIAL_FILENAME: 35,
  PARTIAL_CONTENT: 25,
  PARTIAL_CAPTION: 20,
  CHAT_NAME_MATCH: 30,
  RECENCY_TODAY: 10,
  RECENCY_WEEK: 5,
});

/**
 * Tokenizes text into lowercase alphanumeric words.
 */
function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Evaluates the match between a target field and the search query.
 */
function scoreField(fieldValue, queryTokens, rawQueryLower) {
  if (!fieldValue || typeof fieldValue !== "string" || !rawQueryLower) {
    return { score: 0, matched: false, exact: false, partial: false };
  }

  const valLower = fieldValue.toLowerCase().trim();
  if (!valLower) return { score: 0, matched: false, exact: false, partial: false };

  // 1. Exact full-string match
  if (valLower === rawQueryLower) {
    return { score: 1.0, matched: true, exact: true, partial: false };
  }

  // 2. Exact word boundaries match
  const valTokens = tokenize(valLower);
  const matchedTokensCount = queryTokens.filter((qt) => valTokens.includes(qt)).length;
  if (matchedTokensCount > 0 && queryTokens.length > 0) {
    const ratio = matchedTokensCount / queryTokens.length;
    if (ratio === 1.0) {
      return { score: 0.75, matched: true, exact: false, wholeWord: true };
    }
    return { score: 0.5 * ratio, matched: true, exact: false, wholeWord: true };
  }

  // 3. Substring match
  if (valLower.includes(rawQueryLower)) {
    return { score: 0.35, matched: true, exact: false, partial: true };
  }

  return { score: 0, matched: false, exact: false, partial: false };
}

/**
 * Calculates deterministic relevance score and matched fields for an item.
 *
 * @param {object} item - Unified search candidate item
 * @param {string} rawQuery - Search query string
 * @param {number} nowSeconds - Reference time for recency boost
 * @returns {object} { relevanceScore: number, matchedFields: string[], scoreBreakdown: object }
 */
function calculateRelevance(item, rawQuery, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!rawQuery || typeof rawQuery !== "string" || !rawQuery.trim()) {
    // Empty query matches all items with base recency scoring
    const ageSec = Math.max(0, nowSeconds - (item.timestamp || nowSeconds));
    let recency = 0;
    if (ageSec <= 86400) recency = SCORE_WEIGHTS.RECENCY_TODAY;
    else if (ageSec <= 7 * 86400) recency = SCORE_WEIGHTS.RECENCY_WEEK;

    return {
      relevanceScore: Math.round(10 + recency),
      matchedFields: [],
      scoreBreakdown: { base: 10, recency },
    };
  }

  const qLower = rawQuery.toLowerCase().trim();
  const qTokens = tokenize(qLower);

  let totalScore = 0;
  const matchedFields = [];
  const scoreBreakdown = {};

  // 1. Sender Match
  const senderMatch = scoreField(item.senderName || item.senderId || item.author, qTokens, qLower);
  if (senderMatch.matched) {
    matchedFields.push("sender");
    let pts = senderMatch.exact
      ? SCORE_WEIGHTS.EXACT_SENDER
      : senderMatch.wholeWord
      ? SCORE_WEIGHTS.WHOLE_WORD_SENDER
      : SCORE_WEIGHTS.PARTIAL_SENDER;
    totalScore += pts;
    scoreBreakdown.sender = pts;
  }

  // 2. Filename Match
  if (item.filename) {
    const fnMatch = scoreField(item.filename, qTokens, qLower);
    if (fnMatch.matched) {
      matchedFields.push("filename");
      let pts = fnMatch.exact
        ? SCORE_WEIGHTS.EXACT_FILENAME
        : fnMatch.wholeWord
        ? SCORE_WEIGHTS.WHOLE_WORD_FILENAME
        : SCORE_WEIGHTS.PARTIAL_FILENAME;
      totalScore += pts;
      scoreBreakdown.filename = pts;
    }
  }

  // 3. Content / Body Match
  if (item.content) {
    const contentMatch = scoreField(item.content, qTokens, qLower);
    if (contentMatch.matched) {
      matchedFields.push("content");
      let pts = contentMatch.exact
        ? SCORE_WEIGHTS.EXACT_CONTENT
        : contentMatch.wholeWord
        ? SCORE_WEIGHTS.WHOLE_WORD_CONTENT
        : SCORE_WEIGHTS.PARTIAL_CONTENT;
      totalScore += pts;
      scoreBreakdown.content = pts;
    }
  }

  // 4. Caption Match
  if (item.caption && item.caption !== item.content) {
    const capMatch = scoreField(item.caption, qTokens, qLower);
    if (capMatch.matched) {
      matchedFields.push("caption");
      let pts = capMatch.exact
        ? SCORE_WEIGHTS.EXACT_CAPTION
        : SCORE_WEIGHTS.PARTIAL_CAPTION;
      totalScore += pts;
      scoreBreakdown.caption = pts;
    }
  }

  // 5. Chat Name Match
  if (item.chatName && item.chatName !== item.senderName) {
    const chatMatch = scoreField(item.chatName, qTokens, qLower);
    if (chatMatch.matched) {
      matchedFields.push("chatName");
      const pts = SCORE_WEIGHTS.CHAT_NAME_MATCH;
      totalScore += pts;
      scoreBreakdown.chatName = pts;
    }
  }

  // If no fields matched the non-empty query, score is 0
  if (matchedFields.length === 0) {
    return {
      relevanceScore: 0,
      matchedFields: [],
      scoreBreakdown: {},
    };
  }

  // 6. Recency Boost
  if (item.timestamp) {
    const ageSec = Math.max(0, nowSeconds - item.timestamp);
    if (ageSec <= 86400) {
      totalScore += SCORE_WEIGHTS.RECENCY_TODAY;
      scoreBreakdown.recency = SCORE_WEIGHTS.RECENCY_TODAY;
    } else if (ageSec <= 7 * 86400) {
      totalScore += SCORE_WEIGHTS.RECENCY_WEEK;
      scoreBreakdown.recency = SCORE_WEIGHTS.RECENCY_WEEK;
    }
  }

  return {
    relevanceScore: Math.round(totalScore),
    matchedFields,
    scoreBreakdown,
  };
}

/**
 * Deduplicates results by composite key `${resultType}:${id}` retaining the highest score.
 */
function deduplicateResults(items) {
  if (!Array.isArray(items)) return [];
  const map = new Map();

  for (const item of items) {
    const key = `${item.resultType}:${item.id || item.messageId || item.chatId || item.content}`;
    if (!map.has(key)) {
      map.set(key, item);
    } else {
      const existing = map.get(key);
      if ((item.relevanceScore || 0) > (existing.relevanceScore || 0)) {
        // Merge matched fields and take highest score
        const mergedFields = Array.from(new Set([...(existing.matchedFields || []), ...(item.matchedFields || [])]));
        map.set(key, { ...item, matchedFields: mergedFields });
      }
    }
  }

  return Array.from(map.values());
}

module.exports = {
  SCORE_WEIGHTS,
  tokenize,
  scoreField,
  calculateRelevance,
  deduplicateResults,
};
