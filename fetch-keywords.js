/**
 * oalur-keyword-reverse - fetch-keywords.js
 *
 * 从 Oalur ASIN 关键词页反查每个产品的真实搜索关键词
 * 流程: ASIN → 流量查询 → 默认排序 Top10 + 月搜索量降序 Top10 → 标题相似度打分 → 选最高分
 *
 * 匹配打分机制:
 *   - 精确短语匹配 (+20)
 *   - 单词长度权重 (单词长度/2, 上限3/词)
 *   - 单词匹配率加分 (matchRate * 5)
 *   - 词序保留加分 (+2)
 *   - 停用词惩罚 (-1/词)
 *
 * 用法: node skills/oalur-keyword-reverse/fetch-keywords.js <products.json> [输出目录]
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CDP_URL = 'http://localhost:9222';
const ASIN_KEYWORD_URL = 'https://vip.oalur.com/asin/keyword?site=US';
const PRODUCT_INFO_URL = 'https://vip.oalur.com/products/information?site=US&asin=';
const DEFAULT_CONCURRENCY = 10;

// ── 参数 ──
const rawArgs = process.argv.slice(2);
const optionValues = {};
const args = [];
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg.startsWith('--')) {
    if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) {
      optionValues[arg] = rawArgs[i + 1];
      i++;
    } else {
      optionValues[arg] = true;
    }
  } else {
    args.push(arg);
  }
}
const inputFile = args[0];
if (!inputFile) {
  console.error('用法: node fetch-keywords.js <products.json> [输出目录]');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
const products = data.products || [];
function resolveDataOutputDir(inputPath, outputArg) {
  const inputDir = path.dirname(inputPath);
  if (!outputArg) return inputDir;
  const normalizedOutput = path.normalize(outputArg);
  const inputParent = path.basename(inputDir).toLowerCase() === 'data'
    ? path.dirname(inputDir)
    : inputDir;

  if (normalizedOutput === path.normalize('output') || path.resolve(outputArg) === path.resolve(inputParent)) {
    return inputDir;
  }
  return path.join(outputArg, 'data');
}
const outDir = resolveDataOutputDir(inputFile, args[1]);
const requestedLimit = Number.parseInt(args[2] || process.env.OALUR_LIMIT || '', 10);
const requestedConcurrency = Number.parseInt(args[3] || process.env.OALUR_CONCURRENCY || '', 10);
const productLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
  ? Math.min(requestedLimit, products.length)
  : products.length;
const targetProducts = products.slice(0, productLimit);
const concurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
  ? Math.min(requestedConcurrency, Math.max(targetProducts.length, 1))
  : Math.min(DEFAULT_CONCURRENCY, Math.max(targetProducts.length, 1));
const AI_RANK_ENABLED = rawArgs.includes('--ai-rank') || process.env.OALUR_AI_RANK === '1';
const RANK_FROM_CANDIDATES = rawArgs.includes('--rank-from-candidates');
const EXPORT_AI_INPUT = optionValues['--export-ai-input'] === true;
const AI_ANALYSIS_FILE = optionValues['--ai-analysis-file'] || process.env.OALUR_AI_ANALYSIS_FILE || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_MODEL = process.env.OALUR_AI_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const requestedAiConcurrency = Number.parseInt(process.env.OALUR_AI_CONCURRENCY || '', 10);
const AI_CONCURRENCY = Number.isFinite(requestedAiConcurrency) && requestedAiConcurrency > 0
  ? requestedAiConcurrency
  : 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeCategoryPath(text) {
  let value = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[›»]/g, '>')
    .replace(/\s*>\s*/g, ' > ')
    .replace(/\s+/g, ' ')
    .trim();

  const pathStart = value.search(/[A-Z][A-Za-z&,\- ]+\s+>\s+/);
  if (pathStart > 0) value = value.slice(pathStart).trim();

  const parts = value
    .split('>')
    .map(part => part.trim().replace(/[：:，,;；]+$/g, ''))
    .filter(Boolean);

  if (parts.length < 3) return null;
  if (parts.some(part => part.length > 90)) return null;
  return parts.join(' > ');
}

function normalizeCategoryPaths(paths) {
  const seen = new Set();
  const result = [];
  for (const pathValue of paths || []) {
    const normalized = normalizeCategoryPath(pathValue);
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    result.push(normalized);
  }
  return result;
}

async function fetchCategoryPathsForAsin(page, asin, fallbackCategory = '') {
  try {
    await page.goto(`${PRODUCT_INFO_URL}${encodeURIComponent(asin)}`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await sleep(2500);

    const rawPaths = await page.evaluate(() => {
      const values = [];
      const addText = (text) => {
        for (const line of String(text || '').split(/\n+/)) {
          const trimmed = line.trim();
          if (trimmed.includes('>') || trimmed.includes('›') || trimmed.includes('»')) {
            values.push(trimmed);
          }
        }
      };

      addText(document.body?.innerText || '');
      for (const el of document.querySelectorAll('td, tr, div, span, p, li')) {
        const text = el.innerText || el.textContent || '';
        if (text.includes('>') || text.includes('›') || text.includes('»')) {
          addText(text);
        }
      }
      return values;
    });

    const normalized = normalizeCategoryPaths(rawPaths);
    if (normalized.length > 0) return normalized;
  } catch (e) {
    console.warn(`  ⚠️ ${asin} 类目路径抓取失败: ${e.message}`);
  }

  return normalizeCategoryPaths([fallbackCategory]);
}

function loadWordSetFromPath(filePath) {
  let words;
  try {
    words = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    throw new Error(`无法读取词表 ${filePath}: ${e.message}`);
  }
  if (!Array.isArray(words) || words.some(word => typeof word !== 'string' || word.trim() === '')) {
    throw new Error(`词表格式无效: ${filePath} 必须是非空字符串数组`);
  }
  return new Set(words.map(word => word.toLowerCase().trim()));
}

function loadWordSet(fileName) {
  return loadWordSetFromPath(path.join('config', fileName));
}

function slugifyConfigName(value) {
  return String(value || '')
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function loadProductHeadWordSet(categoryName) {
  const categorySlug = slugifyConfigName(categoryName);
  const categoryFile = categorySlug
    ? path.join('config', 'product-head-words', `${categorySlug}.json`)
    : '';
  const fallbackFile = path.join('config', 'product-head-words.json');

  if (categoryFile && fs.existsSync(categoryFile)) {
    return {
      words: loadWordSetFromPath(categoryFile),
      filePath: categoryFile,
      isFallback: false
    };
  }

  if (!fs.existsSync(fallbackFile)) {
    throw new Error(`Product head word list not found: ${categoryFile || '(empty category)'} or ${fallbackFile}`);
  }

  console.warn(`Product head word list for category "${categoryName || 'unknown'}" not found; using fallback ${fallbackFile}`);
  return {
    words: loadWordSetFromPath(fallbackFile),
    filePath: fallbackFile,
    isFallback: true
  };
}

const SCORE_STOP_WORDS = loadWordSet('stop-words.json');
const SPEC_ONLY_WORDS = loadWordSet('spec-words.json');
const GENERIC_SINGLE_WORDS = loadWordSet('generic-single-words.json');
const PRODUCT_HEAD_WORD_CONFIG = loadProductHeadWordSet(data.category);
const PRODUCT_HEAD_WORDS = PRODUCT_HEAD_WORD_CONFIG.words;
const INGREDIENT_WORDS = loadWordSet('ingredient-words.json');
const EVENT_WORDS = loadWordSet('event-words.json');
const BRAND_WORDS = loadWordSet('brand-words.json');
const USE_CASE_WORDS = loadWordSet('use-case-words.json');
const MATERIAL_WORDS = loadWordSet('material-words.json');
const SCENE_WORDS = loadWordSet('scene-words.json');
const PRODUCT_HEAD_PHRASES = [...PRODUCT_HEAD_WORDS].filter(word => word.includes(' '));

const KEYWORD_TYPE_PRIORITY = {
  core_product_phrase: 6,
  broad_product_phrase: 5,
  modifier_phrase: 4,
  ingredient_or_material: 3,
  brand_or_entity: 2,
  spec_or_event: 1
};

const AI_ROLE_SCORE = {
  core_product: 25,
  product_variant: 18,
  use_case: 14,
  accessory_or_modifier: 8,
  ingredient: -10,
  brand: -14,
  spec: -12,
  unrelated: -25
};

let activeAiRequests = 0;
const aiWaitQueue = [];
let manualAiAnalysisByAsin = new Map();

function loadManualAiAnalysis(filePath) {
  if (!filePath) return new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const result = new Map();
    const productsList = Array.isArray(raw.products) ? raw.products : [];
    for (const product of productsList) {
      const asin = String(product?.asin || '').trim();
      if (!asin) continue;
      result.set(asin, product);
    }
    console.log(`Manual AI analysis loaded: ${filePath} (${result.size} products)`);
    return result;
  } catch (e) {
    console.warn(`Manual AI analysis ignored: ${filePath} (${e.message})`);
    return new Map();
  }
}

function tokenizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeToken(token) {
  return token.replace(/ies$/, 'y').replace(/s$/, '');
}

function categoryHitScore(keywordLower, categoryLower) {
  const categoryTokens = new Set(tokenizeText(categoryLower).map(normalizeToken));
  const keywordTokens = tokenizeText(keywordLower).filter(w => !SCORE_STOP_WORDS.has(w));
  if (keywordTokens.length === 0) return 0;

  let hits = 0;
  for (const word of keywordTokens) {
    if (categoryTokens.has(normalizeToken(word))) hits++;
  }

  const phraseHit = categoryLower.includes(keywordLower) ? 8 : 0;
  return phraseHit + hits * 4;
}

async function withAiSlot(fn) {
  if (!AI_RANK_ENABLED) return fn();
  if (activeAiRequests >= AI_CONCURRENCY) {
    await new Promise(resolve => aiWaitQueue.push(resolve));
  }
  activeAiRequests++;
  try {
    return await fn();
  } finally {
    activeAiRequests--;
    const next = aiWaitQueue.shift();
    if (next) next();
  }
}

function extractJsonObject(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(value.slice(start, end + 1)); } catch (_) {}
    }
  }
  return null;
}

function normalizeAiRole(role) {
  const value = String(role || '').toLowerCase().trim();
  return AI_ROLE_SCORE[value] != null ? value : 'accessory_or_modifier';
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function normalizeAiAnalysis(raw, allKeywords) {
  const allowed = new Set(allKeywords.map(item => item.keyword.toLowerCase()));
  const result = new Map();
  const rows = Array.isArray(raw?.candidateAnalysis) ? raw.candidateAnalysis : [];

  for (const row of rows) {
    const keyword = String(row?.keyword || '').trim();
    const lower = keyword.toLowerCase();
    if (!allowed.has(lower)) continue;
    const role = normalizeAiRole(row.role);
    result.set(lower, {
      keyword,
      role,
      intentFit: clamp01(row.intentFit),
      isBrand: row.isBrand === true,
      isIngredient: row.isIngredient === true,
      isSpec: row.isSpec === true,
      reason: String(row.reason || '').slice(0, 240)
    });
  }

  return result;
}

function aiFeatureForKeyword(aiAnalysis, keywordLower) {
  const item = aiAnalysis?.get(keywordLower);
  if (!item) {
    return {
      aiSemanticScore: 0,
      aiPenalty: 0,
      aiRole: null,
      aiIntentFit: null,
      aiReason: null
    };
  }

  const roleScore = AI_ROLE_SCORE[item.role] || 0;
  const intentScore = item.intentFit * 20;
  const aiPenalty =
    (item.isBrand ? 14 : 0) +
    (item.isIngredient ? 10 : 0) +
    (item.isSpec ? 8 : 0) +
    (item.role === 'unrelated' ? 25 : 0);

  return {
    aiSemanticScore: Math.round((roleScore + intentScore) * 100) / 100,
    aiPenalty,
    aiRole: item.role,
    aiIntentFit: item.intentFit,
    aiReason: item.reason
  };
}

async function analyzeCandidatesWithAi(asin, title, categoryText, allKeywords) {
  if (manualAiAnalysisByAsin.has(asin)) {
    return normalizeAiAnalysis(manualAiAnalysisByAsin.get(asin), allKeywords);
  }
  if (!AI_RANK_ENABLED || !OPENAI_API_KEY) return new Map();

  return withAiSlot(async () => {
    try {
      const payload = {
        model: AI_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'You classify Amazon search keyword candidates for one ASIN.',
              'Use product title, category paths, and candidate keywords only.',
              'Do not invent keywords. Return JSON only.',
              'Roles must be one of: core_product, product_variant, use_case, accessory_or_modifier, ingredient, brand, spec, unrelated.'
            ].join(' ')
          },
          {
            role: 'user',
            content: JSON.stringify({
              asin,
              title,
              category: categoryText,
              candidates: allKeywords.map(item => ({
                keyword: item.keyword,
                volume: item.volume
              })),
              outputShape: {
                asin: 'same ASIN',
                candidateAnalysis: [
                  {
                    keyword: 'must exactly match one candidate keyword',
                    role: 'core_product | product_variant | use_case | accessory_or_modifier | ingredient | brand | spec | unrelated',
                    intentFit: 'number from 0 to 1',
                    isBrand: 'boolean',
                    isIngredient: 'boolean',
                    isSpec: 'boolean',
                    reason: 'short reason'
                  }
                ]
              }
            })
          }
        ]
      };

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45000)
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.warn(`  AI rank skipped for ${asin}: ${response.status} ${body.slice(0, 160)}`);
        return new Map();
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content || '';
      return normalizeAiAnalysis(extractJsonObject(content), allKeywords);
    } catch (e) {
      console.warn(`  AI rank skipped for ${asin}: ${e.message}`);
      return new Map();
    }
  });
}

function countProductHeadHits(words, keywordLower) {
  let hits = 0;
  for (const word of words) {
    if (PRODUCT_HEAD_WORDS.has(word)) hits++;
  }
  for (const phrase of PRODUCT_HEAD_PHRASES) {
    if (keywordLower.includes(phrase)) hits++;
  }
  return hits;
}

function isSpecModifierWord(word) {
  return SPEC_ONLY_WORDS.has(word) || /^\d+(\.\d+)?$/.test(word);
}

function stripLeadingSpecWords(words) {
  let index = 0;
  while (index < words.length && isSpecModifierWord(words[index])) index++;
  return words.slice(index);
}

function specPrefixedCoreCandidate(keywordLower, exactCandidates) {
  const words = tokenizeText(keywordLower).filter(w => !SCORE_STOP_WORDS.has(w));
  const coreWords = stripLeadingSpecWords(words);
  if (coreWords.length === words.length || coreWords.length < 2) return '';

  const coreKeyword = coreWords.join(' ');
  if (countProductHeadHits(coreWords, coreKeyword) === 0) return '';

  const exactCoreExists = exactCandidates.some(item => {
    const candidateLower = item.keyword.toLowerCase();
    return candidateLower === coreKeyword || normalizeToken(candidateLower) === normalizeToken(coreKeyword);
  });

  return exactCoreExists ? coreKeyword : '';
}

function isLikelyBrandOrEntity(words, titleIndex, categoryScore) {
  if (words.length !== 1 || categoryScore > 0) return false;
  const word = words[0];
  return titleIndex === 0 || GENERIC_SINGLE_WORDS.has(word);
}

function classifyKeyword(keywordLower, titleLower, categoryLower) {
  const words = tokenizeText(keywordLower).filter(w => !SCORE_STOP_WORDS.has(w));
  const wordCount = words.length;
  const titleIndex = titleLower.indexOf(keywordLower);
  const categoryScore = categoryHitScore(keywordLower, categoryLower);
  const productHeadHits = countProductHeadHits(words, keywordLower);
  const brandHits = words.filter(w => BRAND_WORDS.has(w)).length;
  const ingredientHits = words.filter(w => INGREDIENT_WORDS.has(w) || MATERIAL_WORDS.has(w)).length;
  const specHits = words.filter(w => SPEC_ONLY_WORDS.has(w) || /^\d+$/.test(w)).length;
  const eventHits = words.filter(w => EVENT_WORDS.has(w) || SCENE_WORDS.has(w)).length;
  const useCaseHits = words.filter(w => USE_CASE_WORDS.has(w)).length;

  if (brandHits > 0 && productHeadHits === 0) return 'brand_or_entity';
  if (isLikelyBrandOrEntity(words, titleIndex, categoryScore)) return 'brand_or_entity';
  if (wordCount > 0 && specHits + eventHits >= Math.max(1, wordCount - 1) && productHeadHits === 0) {
    return 'spec_or_event';
  }
  if (wordCount >= 2 && productHeadHits > 0 && categoryScore > 0) return 'core_product_phrase';
  if (wordCount >= 2 && productHeadHits > 0) return 'broad_product_phrase';
  if (wordCount >= 2 && ingredientHits > 0 && productHeadHits === 0) return 'ingredient_or_material';
  if (wordCount >= 2 && useCaseHits > 0 && productHeadHits === 0) return 'modifier_phrase';
  if (wordCount >= 2) return 'modifier_phrase';
  if (ingredientHits > 0) return 'ingredient_or_material';
  return 'broad_product_phrase';
}

function singularWords(keywordLower) {
  return tokenizeText(keywordLower)
    .filter(w => !SCORE_STOP_WORDS.has(w))
    .map(normalizeToken);
}

function containmentScore(keywordLower, exactCandidates) {
  const words = singularWords(keywordLower);
  if (words.length === 0) return 0;
  const wordSet = new Set(words);
  let score = 0;

  for (const other of exactCandidates) {
    const otherLower = other.keyword.toLowerCase();
    if (otherLower === keywordLower) continue;
    const otherWords = singularWords(otherLower);
    if (otherWords.length === 0) continue;
    const otherSet = new Set(otherWords);
    const currentContainsOther = otherWords.every(w => wordSet.has(w));
    const otherContainsCurrent = words.every(w => otherSet.has(w));

    if (currentContainsOther && words.length > otherWords.length) {
      const extraWords = words.length - otherWords.length;
      score += extraWords <= 2 ? 5 : 2;
    } else if (otherContainsCurrent && otherWords.length > words.length) {
      const extraWords = otherWords.length - words.length;
      score -= extraWords <= 2 ? 4 : 2;
    }
  }

  return Math.max(-8, Math.min(8, score));
}

// ── 关键词与标题的相似度打分 ──
// 策略:
//   1. 完整短语匹配 → 最高分 (+20)
//   2. 逐个单词匹配 → 按长度加权 (长词更有价值)
//   3. 匹配率加成 (越多词命中越好)
//   4. 词序保留加分 (越接近原始顺序越好)
//   5. 停用词惩罚 (减少无意义词的干扰)
function scoreKeyword(titleLower, keywordLower) {
  const kwWords = keywordLower.split(/\s+/).filter(w => w.length > 0);
  if (kwWords.length === 0) return 0;

  let score = 0;
  let significantWordCount = 0;

  // 1. 精确短语匹配 → 最强信号
  if (titleLower.includes(keywordLower)) {
    score += 20;
  }

  // 2. 逐个单词分析
  let matchCount = 0;
  let lastMatchIndex = -1;
  let orderPreserved = true;

  for (const word of kwWords) {
    const idx = titleLower.indexOf(word);

    // 跳过停用词（不贡献分数但也不惩罚）
    if (SCORE_STOP_WORDS.has(word)) {
      continue;
    }

    significantWordCount++;

    if (idx >= 0) {
      matchCount++;
      // 长词权重：长度/2，上限 3 分
      score += Math.min(word.length / 2, 3);
      // 词序检查
      if (idx < lastMatchIndex) orderPreserved = false;
      lastMatchIndex = idx;
    } else {
      // 停用词之外的词没匹配上 → 轻微惩罚
      score -= Math.min(word.length / 4, 1);
    }
  }

  // 如果没有有意义的词，返回 0
  if (significantWordCount === 0) return 0;

  // 3. 匹配率加成: 匹配的词 / 有意义的词 * 5
  const matchRate = matchCount / significantWordCount;
  score += matchRate * 5;

  // 4. 词序保留加分
  if (orderPreserved && matchCount >= 2) {
    score += 2;
  }

  return score;
}

// ── 从候选关键词列表中选出与标题最匹配的 ──
function matchKeyword(title, keywordList) {
  const titleLower = title.toLowerCase();
  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i < keywordList.length; i++) {
    const kw = keywordList[i];
    const score = scoreKeyword(titleLower, kw.toLowerCase());
    if (score > bestScore) {
      bestScore = score;
      best = { keyword: kw, index: i, score };
    }
  }

  if (!best) return null;

  // 判定匹配类型
  const kwLower = best.keyword.toLowerCase();
  let type;

  if (titleLower.includes(kwLower)) {
    type = 'exact';           // 精确短语匹配
  } else if (bestScore >= 5) {
    type = 'word_split';      // 高分分词匹配（大部分有意义词都命中了）
  } else if (bestScore > 0) {
    type = 'partial';         // 低分分词匹配（部分词命中）
  } else {
    type = 'no_match';        // 毫无关系
  }

  return { keyword: best.keyword, type, score: Math.round(bestScore * 100) / 100, index: best.index };
}

function candidateMatchType(titleLower, keywordLower, titleScore) {
  if (titleLower.includes(keywordLower)) return 'exact';
  if (titleScore >= 5) return 'word_split';
  if (titleScore > 0) return 'partial';
  return 'no_match';
}

function rankAiMatchedCandidates(titleLower, categoryLower, allKeywords, aiAnalysis = new Map()) {
  return allKeywords
    .map((item, candidateIndex) => {
      const keywordLower = item.keyword.toLowerCase();
      const titleScore = scoreKeyword(titleLower, keywordLower);
      const matchType = candidateMatchType(titleLower, keywordLower, titleScore);
      const aiFeature = aiFeatureForKeyword(aiAnalysis, keywordLower);
      const defaultRankScore = Math.max(0, 8 - candidateIndex * 0.7);
      const searchVolumeScore = Math.log10((item.volume || 0) + 1) * 0.8;
      const categoryScore = categoryHitScore(keywordLower, categoryLower);
      const qualityScore = titleScore
        + categoryScore
        + defaultRankScore
        + searchVolumeScore
        + aiFeature.aiSemanticScore
        - aiFeature.aiPenalty;

      return {
        ...item,
        score: Math.round(titleScore * 100) / 100,
        qualityScore: Math.round(qualityScore * 100) / 100,
        categoryScore,
        matchType,
        candidateIndex,
        aiSemanticScore: aiFeature.aiSemanticScore,
        aiPenalty: aiFeature.aiPenalty,
        aiRole: aiFeature.aiRole,
        aiIntentFit: aiFeature.aiIntentFit,
        aiReason: aiFeature.aiReason
      };
    })
    .filter(item => item.matchType !== 'no_match')
    .sort((a, b) => {
      if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
      if ((b.aiSemanticScore || 0) !== (a.aiSemanticScore || 0)) return (b.aiSemanticScore || 0) - (a.aiSemanticScore || 0);
      if (b.score !== a.score) return b.score - a.score;
      if (a.candidateIndex !== b.candidateIndex) return a.candidateIndex - b.candidateIndex;
      return b.volume - a.volume;
    });
}

function scoreExactCandidate(titleLower, categoryLower, item, allKeywords, exactCandidates, aiAnalysis = new Map()) {
  const keywordLower = item.keyword.toLowerCase();
  const words = tokenizeText(keywordLower).filter(w => !SCORE_STOP_WORDS.has(w));
  const wordCount = words.length;
  const titleIndex = titleLower.indexOf(keywordLower);
  const candidateIndex = allKeywords.findIndex(k => k.keyword.toLowerCase() === keywordLower);
  const titleScore = scoreKeyword(titleLower, keywordLower);
  const catScore = categoryHitScore(keywordLower, categoryLower);
  const keywordType = classifyKeyword(keywordLower, titleLower, categoryLower);
  const typeScore = (KEYWORD_TYPE_PRIORITY[keywordType] || 0) * 5;
  const containsScore = containmentScore(keywordLower, exactCandidates);
  const defaultRankScore = Math.max(0, 8 - candidateIndex * 0.7);
  const searchVolumeScore = Math.log10((item.volume || 0) + 1) * 0.8;
  const aiFeature = aiFeatureForKeyword(aiAnalysis, keywordLower);

  let phraseLengthScore = 0;
  if (wordCount >= 2 && wordCount <= 4) phraseLengthScore += 8;
  if (wordCount === 1) phraseLengthScore -= 8;
  if (wordCount > 5) phraseLengthScore -= 4;

  const specWords = words.filter(w => SPEC_ONLY_WORDS.has(w) || /^\d+$/.test(w)).length;
  const productHeadHits = countProductHeadHits(words, keywordLower);
  const specPenalty = specWords * (productHeadHits > 0 ? 1 : 3);
  const specCoreCandidate = specPrefixedCoreCandidate(keywordLower, exactCandidates);
  const specPrefixPenalty = specCoreCandidate ? 32 : 0;
  const brandPenalty = keywordType === 'brand_or_entity' ? 16 : 0;
  const broadPenalty = wordCount === 1 && (item.volume || 0) > 300000 && catScore === 0 ? 10 : 0;
  const ingredientPenalty = keywordType === 'ingredient_or_material' ? 6 : 0;
  const titlePositionScore = titleIndex >= 0 ? Math.max(0, 10 - titleIndex / 10) : 0;

  const qualityScore = titleScore
    + typeScore
    + catScore
    + containsScore
    + phraseLengthScore
    + defaultRankScore
    + searchVolumeScore
    + aiFeature.aiSemanticScore
    + titlePositionScore
    - specPenalty
    - specPrefixPenalty
    - brandPenalty
    - broadPenalty
    - ingredientPenalty
    - aiFeature.aiPenalty;

  return {
    ...item,
    titleIndex,
    score: Math.round(titleScore * 100) / 100,
    qualityScore: Math.round(qualityScore * 100) / 100,
    categoryScore: catScore,
    type: keywordType,
    typeScore,
    aiSemanticScore: aiFeature.aiSemanticScore,
    aiPenalty: aiFeature.aiPenalty,
    aiRole: aiFeature.aiRole,
    aiIntentFit: aiFeature.aiIntentFit,
    aiReason: aiFeature.aiReason,
    containmentScore: containsScore,
    specCoreCandidate,
    specPrefixPenalty,
    candidateIndex
  };
}

function rankExactCandidates(titleLower, categoryLower, exactCandidates, allKeywords, aiAnalysis = new Map()) {
  return exactCandidates
    .map(item => scoreExactCandidate(titleLower, categoryLower, item, allKeywords, exactCandidates, aiAnalysis))
    .sort((a, b) => {
      if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
      if ((b.aiSemanticScore || 0) !== (a.aiSemanticScore || 0)) return (b.aiSemanticScore || 0) - (a.aiSemanticScore || 0);
      if (b.categoryScore !== a.categoryScore) return b.categoryScore - a.categoryScore;
      if (b.score !== a.score) return b.score - a.score;
      if (a.candidateIndex !== b.candidateIndex) return a.candidateIndex - b.candidateIndex;
      return b.volume - a.volume;
    });
}

function chooseBestExactCandidate(titleLower, categoryLower, exactCandidates, allKeywords, aiAnalysis = new Map()) {
  return rankExactCandidates(titleLower, categoryLower, exactCandidates, allKeywords, aiAnalysis)[0];
}

// ── 从当前表格提取 Top N 关键词 ──
function extractTopN(page, n) {
  return page.evaluate((limit) => {
    const rows = document.querySelectorAll('.el-table__body-wrapper tbody tr, .el-table__body tbody tr');
    const result = [];
    for (let i = 0; i < Math.min(limit, rows.length); i++) {
      const cells = rows[i].querySelectorAll('td');
      if (cells.length < 8) continue;
      // col 2 = 流量关键词, col 8 = 月搜索量
      const keyword = cells[1]?.innerText?.trim()?.split('\n')[0] || '';
      const volText = cells[7]?.innerText?.trim() || '';
      // 月搜索量格式: "229,665\n日均：7,655" → 取第一段,去逗号
      const vol = parseInt(volText.split('\n')[0].replace(/,/g, '')) || 0;
      if (keyword && keyword.length > 1) result.push({ keyword, volume: vol });
    }
    return result;
  }, n);
}

// ── 为单个 ASIN 获取关键词 ──
async function fetchKeywordForAsin(page, asin, title, smallestCategory = '') {
  try {
    await page.goto(ASIN_KEYWORD_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    // 输入 ASIN
    await page.evaluate((a) => {
      const inputs = document.querySelectorAll('input');
      for (const inp of inputs) {
        if (inp.placeholder && (inp.placeholder.includes('ASIN') || inp.placeholder.includes('请输入'))) {
          const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          ns.call(inp, a);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    }, asin);
    await sleep(500);

    // 点击"流量查询"
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        if (btn.textContent.includes('流量查询')) { btn.click(); return; }
      }
    });
    await sleep(8000);

    // ── 第一组: 默认排序下的 Top 10 ──
    const default10 = await extractTopN(page, 10);

    // ── 第二组: 按月搜索量从高到低排序的 Top 10 ──
    // 直接点击月搜索量列头的 ▼ 图标，一次到位降序
    await page.evaluate(() => {
      const ths = document.querySelectorAll('th');
      for (const th of ths) {
        if (th.textContent.trim().includes('月搜索量')) {
          const down = th.querySelector('.sort-caret.descending');
          if (down) { down.click(); return; }
          // 兜底：点击整个列头（第一次升序，第二次降序）
          th.querySelector('.cell')?.click();
          return;
        }
      }
    });
    await sleep(2000);

    // 如果第一次是升序，再点一次变降序
    const isDesc = await page.evaluate(() => {
      const th = [...document.querySelectorAll('th')].find(t => t.textContent.includes('月搜索量'));
      return th?.className.includes('descending');
    });
    if (!isDesc) {
      await page.evaluate(() => {
        const th = [...document.querySelectorAll('th')].find(t => t.textContent.includes('月搜索量'));
        th?.querySelector('.sort-caret.descending')?.click() || th?.querySelector('.cell')?.click();
      });
      await sleep(2000);
    }

    const volume10 = await extractTopN(page, 10);

    // ── 合并去重（保留搜索量，优先取更大的） ──
    const seen = new Set();
    const allKeywords = [];  // [{keyword, volume}, ...]
    const kwVolume = {};    // {lowercase kw: volume}

    for (const list of [default10, volume10]) {
      for (const item of list) {
        const lower = item.keyword.toLowerCase().trim();
        if (lower.length <= 1) continue;
        if (!seen.has(lower)) {
          seen.add(lower);
          allKeywords.push(item);
          kwVolume[lower] = item.volume;
        } else {
          // 已存在则更新为更大的 volume
          if (item.volume > kwVolume[lower]) {
            kwVolume[lower] = item.volume;
          }
        }
      }
    }

    // 更新 allKeywords 中的 volume
    for (const item of allKeywords) {
      item.volume = kwVolume[item.keyword.toLowerCase().trim()];
    }

    if (allKeywords.length === 0) {
      return {
        asin,
        title,
        keyword: null,
        matchType: 'no_data',
        score: 0,
        exactAlternatives: [],
        defaultTop10: default10,
        volumeTop10: volume10,
        mergedCandidates: []
      };
    }

    // ── 标题相似度匹配 ──
    const titleLower = title.toLowerCase();
    const categoryLower = String(smallestCategory || '').toLowerCase();
    const aiAnalysis = await analyzeCandidatesWithAi(asin, title, smallestCategory, allKeywords);
    const match = matchKeyword(title, allKeywords.map(k => k.keyword));

    // 调试日志
    const kwList = allKeywords.map(k => `${k.keyword}(${k.volume.toLocaleString()})`);
    console.log(`     [候选词(${allKeywords.length})] ${kwList.join(' | ')}`);
    console.log(`     [得分] ${match ? `${match.keyword} = ${match.score} (${match.type})` : '无匹配'}`);

    // ── 在多组 exact 匹配中选搜索量最大的 ──
    if (match && match.type !== 'no_match') {
      let finalKeyword = match.keyword;
      let finalType = match.type;

      // 找出所有 exact 匹配的候选词
      const exactCandidates = allKeywords.filter(k => titleLower.includes(k.keyword.toLowerCase()));
      const hasExactMatch = exactCandidates.length > 0;
      const rankedExactCandidates = exactCandidates.length
        ? rankExactCandidates(titleLower, categoryLower, exactCandidates, allKeywords, aiAnalysis)
        : [];

      const rankedAiMatches = aiAnalysis.size > 0
        ? rankAiMatchedCandidates(titleLower, categoryLower, allKeywords, aiAnalysis)
        : [];

      if (rankedExactCandidates.length === 0 && rankedAiMatches.length > 0) {
        finalKeyword = rankedAiMatches[0].keyword;
        finalType = rankedAiMatches[0].matchType;
      }

      if (rankedExactCandidates.length > 0) {
        const best = rankedExactCandidates[0];
        if (best.keyword.toLowerCase() !== finalKeyword.toLowerCase()) {
          finalKeyword = best.keyword;
          finalType = 'exact';
          console.log(`     → 优先标题主词精确词: ${finalKeyword} (标题位置 ${best.titleIndex}, 月搜索量 ${best.volume.toLocaleString()})`);
        }
      }

      const selectedExact = rankedExactCandidates.find(item => item.keyword.toLowerCase() === finalKeyword.toLowerCase());
      const exactAlternatives = rankedExactCandidates
        .filter(item => item.keyword.toLowerCase() !== finalKeyword.toLowerCase())
        .slice(0, 8)
        .map(item => ({
          keyword: item.keyword,
          volume: item.volume,
          score: item.score,
          qualityScore: item.qualityScore,
          categoryScore: item.categoryScore,
          type: item.type,
          typeScore: item.typeScore,
          aiSemanticScore: item.aiSemanticScore,
          aiPenalty: item.aiPenalty,
          aiRole: item.aiRole,
          aiIntentFit: item.aiIntentFit,
          aiReason: item.aiReason,
          containmentScore: item.containmentScore,
          titleIndex: item.titleIndex,
          rank: item.candidateIndex + 1
        }));
      const exactKeywordSet = new Set(rankedExactCandidates.map(item => item.keyword.toLowerCase()));
      const aiMatchedByKeyword = new Map(rankedAiMatches.map(item => [item.keyword.toLowerCase(), item]));
      const filteredKeywords = allKeywords
        .filter(item => item.keyword.toLowerCase() !== finalKeyword.toLowerCase())
        .map(item => {
          const lower = item.keyword.toLowerCase();
          const ranked = rankedExactCandidates.find(candidate => candidate.keyword.toLowerCase() === lower) || aiMatchedByKeyword.get(lower);
          return {
            keyword: item.keyword,
            volume: item.volume,
            reason: exactKeywordSet.has(lower) ? 'exact_not_selected' : 'not_exact_match',
            matchType: ranked?.matchType || (exactKeywordSet.has(lower) ? 'exact' : 'filtered'),
            score: ranked?.qualityScore ?? ranked?.score ?? Math.round(scoreKeyword(titleLower, lower) * 100) / 100,
            aiRole: ranked?.aiRole ?? null,
            aiIntentFit: ranked?.aiIntentFit ?? null,
            aiReason: ranked?.aiReason ?? null
          };
        });

      const selectedAi = aiMatchedByKeyword.get(finalKeyword.toLowerCase());

      return {
        asin, title,
        keyword: finalKeyword,
        matchType: finalType,
        hasExactMatch,
        score: selectedExact?.score ?? selectedAi?.score ?? (finalType === 'exact'
          ? Math.round(scoreKeyword(titleLower, finalKeyword.toLowerCase()) * 100) / 100
          : match.score),
        candidates: allKeywords.length,
        qualityScore: selectedExact?.qualityScore ?? selectedAi?.qualityScore ?? null,
        categoryScore: selectedExact?.categoryScore ?? selectedAi?.categoryScore ?? null,
        keywordType: selectedExact?.type ?? null,
        aiSemanticScore: selectedExact?.aiSemanticScore ?? selectedAi?.aiSemanticScore ?? null,
        aiPenalty: selectedExact?.aiPenalty ?? selectedAi?.aiPenalty ?? null,
        aiRole: selectedExact?.aiRole ?? selectedAi?.aiRole ?? null,
        aiIntentFit: selectedExact?.aiIntentFit ?? selectedAi?.aiIntentFit ?? null,
        aiReason: selectedExact?.aiReason ?? selectedAi?.aiReason ?? null,
        exactAlternatives,
        filteredKeywords,
        defaultTop10: default10,
        volumeTop10: volume10,
        mergedCandidates: allKeywords.map(item => ({ keyword: item.keyword, volume: item.volume }))
      };
    }

    // Fallback: 取候选词列表中的第一个（默认排序的优先）
    return {
      asin, title,
      keyword: allKeywords[0].keyword,
      matchType: 'fallback_top1',
      hasExactMatch: false,
      score: 0,
      candidates: allKeywords.length,
      exactAlternatives: [],
      defaultTop10: default10,
      volumeTop10: volume10,
      mergedCandidates: allKeywords.map(item => ({ keyword: item.keyword, volume: item.volume })),
      filteredKeywords: allKeywords.slice(1).map(item => ({
        keyword: item.keyword,
        volume: item.volume,
        reason: 'fallback_not_selected',
        matchType: 'filtered',
        score: 0
      }))
    };

  } catch (e) {
    return {
      asin,
      title,
      keyword: null,
      matchType: 'error',
      hasExactMatch: false,
      score: 0,
      error: e.message,
      exactAlternatives: [],
      filteredKeywords: [],
      defaultTop10: [],
      volumeTop10: [],
      mergedCandidates: []
    };
  }
}

function normalizeExistingCandidates(detail) {
  const source = Array.isArray(detail.mergedCandidates) ? detail.mergedCandidates : [];
  const seen = new Set();
  const candidates = [];
  for (const item of source) {
    const keyword = String(item.keyword || item || '').trim();
    if (!keyword) continue;
    const lower = keyword.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    candidates.push({
      keyword,
      volume: Number.parseInt(item.volume || 0, 10) || 0
    });
  }
  return candidates;
}

function rankExistingKeywordDetail(detail) {
  const asin = detail.asin;
  const title = detail.title || '';
  const allKeywords = normalizeExistingCandidates(detail);
  const defaultTop10 = Array.isArray(detail.defaultTop10) ? detail.defaultTop10 : [];
  const volumeTop10 = Array.isArray(detail.volumeTop10) ? detail.volumeTop10 : [];
  const categoryPaths = Array.isArray(detail.categoryPaths) && detail.categoryPaths.length > 0
    ? detail.categoryPaths
    : (Array.isArray(detail.categories) ? detail.categories : []);
  const smallestCategory = categoryPaths[0] || detail.category || detail.smallestCategory || '';

  if (allKeywords.length === 0) {
    return {
      asin,
      title,
      smallestCategory,
      categoryPaths,
      keyword: null,
      matchType: 'no_data',
      hasExactMatch: false,
      score: 0,
      exactAlternatives: [],
      filteredKeywords: [],
      defaultTop10,
      volumeTop10,
      mergedCandidates: []
    };
  }

  const titleLower = title.toLowerCase();
  const categoryLower = String(categoryPaths.length ? categoryPaths.join(' > ') : smallestCategory).toLowerCase();
  const match = matchKeyword(title, allKeywords.map(item => item.keyword));

  if (match && match.type !== 'no_match') {
    let finalKeyword = match.keyword;
    let finalType = match.type;
    const exactCandidates = allKeywords.filter(item => titleLower.includes(item.keyword.toLowerCase()));
    const hasExactMatch = exactCandidates.length > 0;
    const rankedExactCandidates = exactCandidates.length
      ? rankExactCandidates(titleLower, categoryLower, exactCandidates, allKeywords, new Map())
      : [];

    if (rankedExactCandidates.length > 0) {
      finalKeyword = rankedExactCandidates[0].keyword;
      finalType = 'exact';
    }

    const selectedExact = rankedExactCandidates.find(item => item.keyword.toLowerCase() === finalKeyword.toLowerCase());
    const exactKeywordSet = new Set(rankedExactCandidates.map(item => item.keyword.toLowerCase()));
    const exactAlternatives = rankedExactCandidates
      .filter(item => item.keyword.toLowerCase() !== finalKeyword.toLowerCase())
      .slice(0, 8)
      .map(item => ({
        keyword: item.keyword,
        volume: item.volume,
        score: item.score,
        qualityScore: item.qualityScore,
        categoryScore: item.categoryScore,
        type: item.type,
        typeScore: item.typeScore,
        aiSemanticScore: item.aiSemanticScore,
        aiPenalty: item.aiPenalty,
        aiRole: item.aiRole,
        aiIntentFit: item.aiIntentFit,
        aiReason: item.aiReason,
        containmentScore: item.containmentScore,
        specCoreCandidate: item.specCoreCandidate,
        specPrefixPenalty: item.specPrefixPenalty,
        titleIndex: item.titleIndex,
        rank: item.candidateIndex + 1
      }));
    const filteredKeywords = allKeywords
      .filter(item => item.keyword.toLowerCase() !== finalKeyword.toLowerCase())
      .map(item => {
        const lower = item.keyword.toLowerCase();
        const ranked = rankedExactCandidates.find(candidate => candidate.keyword.toLowerCase() === lower);
        return {
          keyword: item.keyword,
          volume: item.volume,
          reason: exactKeywordSet.has(lower) ? 'exact_not_selected' : 'not_exact_match',
          matchType: ranked?.matchType || (exactKeywordSet.has(lower) ? 'exact' : 'filtered'),
          score: ranked?.qualityScore ?? ranked?.score ?? Math.round(scoreKeyword(titleLower, lower) * 100) / 100,
          aiRole: null,
          aiIntentFit: null,
          aiReason: null
        };
      });

    return {
      asin,
      title,
      smallestCategory,
      categoryPaths,
      keyword: finalKeyword,
      matchType: finalType,
      hasExactMatch,
      score: selectedExact?.score ?? (finalType === 'exact'
        ? Math.round(scoreKeyword(titleLower, finalKeyword.toLowerCase()) * 100) / 100
        : match.score),
      candidates: allKeywords.length,
      qualityScore: selectedExact?.qualityScore ?? null,
      categoryScore: selectedExact?.categoryScore ?? null,
      keywordType: selectedExact?.type ?? null,
      aiSemanticScore: null,
      aiPenalty: null,
      aiRole: null,
      aiIntentFit: null,
      aiReason: null,
      exactAlternatives,
      filteredKeywords,
      defaultTop10,
      volumeTop10,
      mergedCandidates: allKeywords.map(item => ({ keyword: item.keyword, volume: item.volume }))
    };
  }

  return {
    asin,
    title,
    smallestCategory,
    categoryPaths,
    keyword: allKeywords[0].keyword,
    matchType: 'fallback_top1',
    hasExactMatch: false,
    score: 0,
    candidates: allKeywords.length,
    exactAlternatives: [],
    defaultTop10,
    volumeTop10,
    mergedCandidates: allKeywords.map(item => ({ keyword: item.keyword, volume: item.volume })),
    filteredKeywords: allKeywords.slice(1).map(item => ({
      keyword: item.keyword,
      volume: item.volume,
      reason: 'fallback_not_selected',
      matchType: 'filtered',
      score: 0
    }))
  };
}

function runRankFromCandidates() {
  const results = targetProducts.map(rankExistingKeywordDetail);
  const summary = saveKeywordResults(results);
  console.log(`\nRanked existing keyword candidates: ${summary.products.length} products`);
  console.log(`  exact: ${summary.exactMatches}`);
  console.log(`  word_split: ${summary.splitMatches}`);
  console.log(`  partial: ${summary.partialMatches}`);
  console.log(`  fallback_top1: ${summary.fallbacks}`);
  console.log(`  errors: ${summary.errors}`);
  console.log(`Output: ${path.join(outDir, 'keywords.json')}`);
  console.log(`Output: ${path.join(outDir, 'keyword-candidates.json')}`);
}

function summarizeResults(results) {
  const done = results.filter(Boolean);
  return {
    exactMatches: done.filter(r => r.matchType === 'exact').length,
    splitMatches: done.filter(r => r.matchType === 'word_split').length,
    partialMatches: done.filter(r => r.matchType === 'partial').length,
    fallbacks: done.filter(r => r.matchType === 'fallback_top1').length,
    errors: done.filter(r => !['exact', 'word_split', 'partial', 'fallback_top1'].includes(r.matchType)).length,
    products: done
  };
}

function saveKeywordResults(results) {
  const summary = summarizeResults(results);
  const cleanProducts = summary.products.map(p => {
    const categories = normalizeCategoryPaths(
      Array.isArray(p.categoryPaths) && p.categoryPaths.length > 0
        ? p.categoryPaths
        : [p.smallestCategory]
    );
    return {
      asin: p.asin,
      category: categories[0] || '',
      categories,
      keyword: p.keyword,
      matchType: p.matchType,
      hasExactMatch: p.hasExactMatch === true,
      score: p.score
    };
  });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'keywords.json'), JSON.stringify({
    sourceFile: inputFile,
    category: data.category,
    fetchTime: new Date().toISOString(),
    productCount: summary.products.length,
    totalInputProducts: products.length,
    requestedLimit: targetProducts.length,
    concurrency,
    exactMatches: summary.exactMatches,
    splitMatches: summary.splitMatches,
    partialMatches: summary.partialMatches,
    fallbacks: summary.fallbacks,
    errors: summary.errors,
    products: cleanProducts
  }, null, 2), 'utf-8');
  const candidateProducts = summary.products.map(p => {
    const categories = normalizeCategoryPaths(
      Array.isArray(p.categoryPaths) && p.categoryPaths.length > 0
        ? p.categoryPaths
        : [p.smallestCategory]
    );
    const mergedCandidates = Array.isArray(p.mergedCandidates) ? p.mergedCandidates : [];
    return {
      asin: p.asin,
      title: p.title,
      category: categories[0] || '',
      categories,
      defaultTop10: Array.isArray(p.defaultTop10) ? p.defaultTop10 : [],
      volumeTop10: Array.isArray(p.volumeTop10) ? p.volumeTop10 : [],
      mergedCandidates: mergedCandidates.map(item => ({
        keyword: item.keyword,
        volume: item.volume
      }))
    };
  });
  fs.writeFileSync(path.join(outDir, 'keyword-candidates.json'), JSON.stringify({
    sourceFile: inputFile,
    category: data.category,
    fetchTime: new Date().toISOString(),
    productCount: candidateProducts.length,
    totalInputProducts: products.length,
    requestedLimit: targetProducts.length,
    concurrency,
    products: candidateProducts
  }, null, 2), 'utf-8');
  const baseKeywordOutput = {
    sourceFile: inputFile,
    category: data.category,
    fetchTime: new Date().toISOString(),
    productCount: cleanProducts.length,
    totalInputProducts: products.length,
    requestedLimit: targetProducts.length,
    concurrency,
    exactMatches: summary.exactMatches,
    splitMatches: summary.splitMatches,
    partialMatches: summary.partialMatches,
    fallbacks: summary.fallbacks,
    errors: summary.errors
  };
  const exactProducts = cleanProducts.filter(product => product.matchType === 'exact');
  const nonExactProducts = cleanProducts.filter(product => product.matchType !== 'exact');
  fs.writeFileSync(path.join(outDir, 'keywords-agent-same.json'), JSON.stringify({
    ...baseKeywordOutput,
    splitType: 'js_agent_same',
    productCount: exactProducts.length,
    products: exactProducts
  }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outDir, 'keywords-agent-diff.json'), JSON.stringify({
    ...baseKeywordOutput,
    splitType: 'js_agent_different',
    productCount: 0,
    keywordFormat: ['jsKeyword', 'agentProductBody'],
    products: []
  }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outDir, 'keywords-agent-non-exact.json'), JSON.stringify({
    ...baseKeywordOutput,
    splitType: 'js_non_exact',
    productCount: nonExactProducts.length,
    products: nonExactProducts
  }, null, 2), 'utf-8');
  if (EXPORT_AI_INPUT) {
    fs.writeFileSync(path.join(outDir, 'candidate-analysis-input.json'), JSON.stringify({
      sourceFile: inputFile,
      category: data.category,
      exportTime: new Date().toISOString(),
      products: summary.products.map(p => {
        const titleLower = String(p.title || '').toLowerCase();
        const categories = normalizeCategoryPaths(
          Array.isArray(p.categoryPaths) && p.categoryPaths.length > 0
            ? p.categoryPaths
            : [p.smallestCategory]
        );
        return {
          asin: p.asin,
          title: p.title,
          categories,
          candidates: (p.mergedCandidates || []).map(item => {
            const keywordLower = String(item.keyword || '').toLowerCase();
            const score = scoreKeyword(titleLower, keywordLower);
            return {
              keyword: item.keyword,
              volume: item.volume,
              matchType: candidateMatchType(titleLower, keywordLower, score)
            };
          })
        };
      })
    }, null, 2), 'utf-8');
  }
  return summary;
}

async function runConcurrentFetch(browser) {
  const results = new Array(targetProducts.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker(workerId) {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    try {
      while (true) {
        const index = nextIndex++;
        if (index >= targetProducts.length) break;

        const p = targetProducts[index];
        let categoryPaths = [];
        let categoryContext = p.smallestCategory;
        if (AI_RANK_ENABLED) {
          categoryPaths = await fetchCategoryPathsForAsin(page, p.asin, p.smallestCategory);
          categoryContext = categoryPaths.length ? categoryPaths.join(' > ') : p.smallestCategory;
        }
        const result = await fetchKeywordForAsin(page, p.asin, p.title, categoryContext);
        if (!AI_RANK_ENABLED) {
          categoryPaths = await fetchCategoryPathsForAsin(page, p.asin, p.smallestCategory);
        }

        results[index] = {
          asin: result.asin,
          title: result.title,
          smallestCategory: p.smallestCategory,
          categoryPaths,
          keyword: result.keyword,
          matchType: result.matchType,
          hasExactMatch: result.hasExactMatch === true,
          score: result.score ?? 0,
          qualityScore: result.qualityScore ?? null,
          categoryScore: result.categoryScore ?? null,
          keywordType: result.keywordType ?? null,
          aiSemanticScore: result.aiSemanticScore ?? null,
          aiPenalty: result.aiPenalty ?? null,
          aiRole: result.aiRole ?? null,
          aiIntentFit: result.aiIntentFit ?? null,
          aiReason: result.aiReason ?? null,
          exactAlternatives: result.exactAlternatives || [],
          defaultTop10: result.defaultTop10 || [],
          volumeTop10: result.volumeTop10 || [],
          mergedCandidates: result.mergedCandidates || [],
          filteredKeywords: result.filteredKeywords || []
        };

        completed++;
        const scoreStr = result.score != null ? `[${result.score}]` : '';
        console.log(`  [${completed}/${targetProducts.length}] W${workerId} #${index + 1} ${result.asin} -> ${result.keyword || 'N/A'} ${scoreStr}(${result.matchType})`);

        if (completed % 10 === 0 || completed === targetProducts.length) {
          saveKeywordResults(results);
          console.log(`  Saved ${completed} records`);
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i + 1)));
  const summary = saveKeywordResults(results);

  console.log(`\nDone: ${summary.products.length} products`);
  console.log(`  exact: ${summary.exactMatches}`);
  console.log(`  word_split: ${summary.splitMatches}`);
  console.log(`  partial: ${summary.partialMatches}`);
  console.log(`  fallback_top1: ${summary.fallbacks}`);
  console.log(`  errors: ${summary.errors}`);
  console.log(`Output: ${path.join(outDir, 'keywords-agent-same.json')}`);
  console.log(`Output: ${path.join(outDir, 'keywords-agent-diff.json')}`);
  console.log(`Output: ${path.join(outDir, 'keywords-agent-non-exact.json')}`);
}

// ── 主流程 ──
async function main() {
  console.log(`\n🔤 Oalur ASIN 关键词反查`);
  console.log(`📦 输入产品数: ${products.length}\n`);

  manualAiAnalysisByAsin = loadManualAiAnalysis(AI_ANALYSIS_FILE);

  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  console.log(`Target products: ${targetProducts.length}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Product head words: ${PRODUCT_HEAD_WORD_CONFIG.filePath}${PRODUCT_HEAD_WORD_CONFIG.isFallback ? ' (fallback)' : ''}\n`);
  if (EXPORT_AI_INPUT) {
    console.log(`AI input export: ${path.join(outDir, 'candidate-analysis-input.json')}\n`);
  }
  if (AI_ANALYSIS_FILE) {
    console.log(`Manual AI analysis file: ${AI_ANALYSIS_FILE}\n`);
  }
  if (AI_RANK_ENABLED && OPENAI_API_KEY) {
    console.log(`AI rank: enabled (${AI_MODEL}, concurrency ${AI_CONCURRENCY})\n`);
  } else if (AI_RANK_ENABLED && !OPENAI_API_KEY) {
    console.log('AI rank: requested but OPENAI_API_KEY is missing, fallback to JS rules\n');
  }
  try {
    await runConcurrentFetch(browser);
  } finally {
    await browser.disconnect();
  }
  return;

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  const results = [];
  let exactMatches = 0, splitMatches = 0, partialMatches = 0, fallbacks = 0, errors = 0;

  try {
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      let categoryPaths = [];
      let categoryContext = p.smallestCategory;
      if (AI_RANK_ENABLED) {
        categoryPaths = await fetchCategoryPathsForAsin(page, p.asin, p.smallestCategory);
        categoryContext = categoryPaths.length ? categoryPaths.join(' > ') : p.smallestCategory;
      }
      const result = await fetchKeywordForAsin(page, p.asin, p.title, categoryContext);
      if (!AI_RANK_ENABLED) {
        categoryPaths = await fetchCategoryPathsForAsin(page, p.asin, p.smallestCategory);
      }

      switch (result.matchType) {
        case 'exact':        exactMatches++; break;
        case 'word_split':   splitMatches++; break;
        case 'partial':      partialMatches++; break;
        case 'fallback_top1': fallbacks++; break;
        default:             errors++; break;
      }

      results.push({
        asin: result.asin,
        title: result.title,
        smallestCategory: p.smallestCategory,
        categoryPaths,
        keyword: result.keyword,
        matchType: result.matchType,
        hasExactMatch: result.hasExactMatch === true,
        score: result.score ?? 0,
        qualityScore: result.qualityScore ?? null,
        categoryScore: result.categoryScore ?? null,
        keywordType: result.keywordType ?? null,
        aiSemanticScore: result.aiSemanticScore ?? null,
        aiPenalty: result.aiPenalty ?? null,
        aiRole: result.aiRole ?? null,
        aiIntentFit: result.aiIntentFit ?? null,
        aiReason: result.aiReason ?? null,
        exactAlternatives: result.exactAlternatives || [],
        defaultTop10: result.defaultTop10 || [],
        volumeTop10: result.volumeTop10 || [],
        mergedCandidates: result.mergedCandidates || [],
        filteredKeywords: result.filteredKeywords || []
      });

      const icon = result.matchType === 'exact' ? '✅' :
                   result.matchType === 'word_split' ? '🔀' :
                   result.matchType === 'partial' ? '⚠️' :
                   result.matchType === 'fallback_top1' ? '⬇️' : '❌';
      const scoreStr = result.score != null ? `[${result.score}]` : '';
      console.log(`  ${icon} [${i+1}/${products.length}] ${result.asin} → ${result.keyword || 'N/A'} ${scoreStr}(${result.matchType})`);

      // 保存中间结果（避免中断丢失）
      if ((i + 1) % 50 === 0 || i === products.length - 1) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'keywords.json'), JSON.stringify({
          sourceFile: inputFile,
          category: data.category,
          fetchTime: new Date().toISOString(),
          productCount: results.length,
          exactMatches, splitMatches, partialMatches, fallbacks, errors,
          products: results
        }, null, 2), 'utf-8');
        console.log(`  💾 已保存 ${results.length} 条`);
      }
    }
  } finally {
    await browser.disconnect();
  }

  console.log(`\n✅ 完成! ${results.length} 个产品`);
  console.log(`   ✅ 精确匹配: ${exactMatches}`);
  console.log(`   🔀 分词匹配: ${splitMatches}`);
  console.log(`   ⚠️ 部分匹配: ${partialMatches}`);
  console.log(`   ⬇️ Fallback:  ${fallbacks}`);
  console.log(`   ❌ 错误:      ${errors}`);
  console.log(`📁 ${path.join(outDir, 'keywords.json')}`);
}

// ── 启动前检查 Edge ──
async function checkEdge() {
  const net = require('net');
  return new Promise(resolve => {
    const s = net.createConnection({ host: '127.0.0.1', port: 9222 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => { s.destroy(); resolve(false); });
    s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  });
}

(async () => {
  if (RANK_FROM_CANDIDATES) {
    runRankFromCandidates();
    return;
  }

  if (!await checkEdge()) {
    const { execSync } = require('child_process');
    console.log('⚠️ Edge 未运行，正在启动...');
    execSync('Start-Process "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" -ArgumentList "--remote-debugging-port=9222","--no-first-run"', { shell: 'powershell.exe' });
    for (let i = 0; i < 10; i++) { await sleep(2000); if (await checkEdge()) break; }
  }
  await main();
})().catch(err => { console.error('❌ 执行失败:', err.message); process.exit(1); });
