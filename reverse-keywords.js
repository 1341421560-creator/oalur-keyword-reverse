/**
 * oalur-keyword-reverse - reverse-keywords.js
 *
 * 从产品标题反推搜索关键词
 *
 * 用法: node skills/oalur-keyword-reverse/reverse-keywords.js <products.json> [输出目录]
 */

const fs = require('fs');
const path = require('path');

// ── 通用类目描述词（叶子词 fallback 时要过滤掉的） ──
const GENERIC_CATEGORY_WORDS = new Set([
  'accessories', 'parts', 'supplies', 'cleaners', 'cleaning', 'household',
  'kitchen', 'dining', 'tools', 'storage', 'organization', 'air', 'quality',
  'control', 'care', 'decor', 'home', 'garden', 'equipment', 'products',
  'house', 'paper', 'plastic', 'appliance', 'small',
  'heating', 'cooling', 'furniture', 'essentials', 'basics'
]);

// ── 加载产品名词库（从 nouns.json） ──
const PRODUCT_NOUNS = (() => {
  const nounsFile = path.join(__dirname, 'nouns.json');
  return Object.values(JSON.parse(fs.readFileSync(nounsFile, 'utf-8'))).flat();
})();

// ── 冲突词规则：标题含这些上下文时，排除对应名词 ──
const CONFLICT_NOUNS = { mouse: ['repellent','repeller','trap','pest','rodent','bait','poison'] };
function hasConflictContext(titleLower, core) {
  return (CONFLICT_NOUNS[core] || []).some(t => titleLower.includes(t));
}


// ── 停用词（不出现在关键词中） ──
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'at',
  'to', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'this', 'that', 'these', 'those', 'it', 'its',
  'new', 'best', 'top', 'hot', 'sale', 'free', 'shipping',
  'professional', 'premium', 'deluxe', 'classic', 'essential',
  'perfect', 'ideal', 'great', 'super', 'ultra', 'mega',
  'your', 'you', 'our', 'we', 'they',
  'etc', 'more', 'also', 'very', 'much', 'many',
  'set', 'pack', 'kit', 'piece', 'pcs', 'pc', 'count',
  'includes', 'including', 'included',
  'gift', 'present', 'birthday', 'christmas', 'thanksgiving',
  'men', 'women', 'adult', 'kid', 'child', 'baby',
  'home', 'house', 'office', 'school', 'outdoor', 'indoor',
]);

// ── 修饰词库（有意义的描述词） ──
const MODIFIER_KEYWORDS = {
  // 材质
  'stainless steel': 'stainless steel',
  'high carbon': 'high carbon steel',
  'carbon steel': 'carbon steel',
  'cast iron': 'cast iron',
  'nonstick': 'non stick',
  'non-stick': 'non stick',
  'ceramic': 'ceramic',
  'silicone': 'silicone',
  'bamboo': 'bamboo',
  'wooden': 'wood',
  'plastic': 'plastic',
  'glass': 'glass',
  'titanium': 'titanium',
  'copper': 'copper',
  'aluminum': 'aluminum',

  // 特性
  'dishwasher safe': 'dishwasher safe',
  'bpa free': 'bpa free',
  'eco friendly': 'eco friendly',
  'portable': 'portable',
  'foldable': 'foldable',
  'adjustable': 'adjustable',
  'magnetic': 'magnetic',
  'waterproof': 'waterproof',
  'rust resistant': 'rust resistant',
  'anti-slip': 'anti slip',
  'ergonomic': 'ergonomic',
  'compact': 'compact',
  'heavy duty': 'heavy duty',
  'sharp': 'sharp',
  'sharpener': 'sharpener',

  // 尺寸
  'mini': 'mini',
  'large': 'large',
  'small': 'small',
  'extra large': 'extra large',
  'xl': 'xl',

  // 数量
  '6-piece': '6 piece',
  '8-piece': '8 piece',
  '10-piece': '10 piece',
  '12-piece': '12 piece',
  '16-piece': '16 piece',
  '24-piece': '24 piece',
};

// ── 解析参数 ──
const args = process.argv.slice(2);
const inputFile = args[0];
const outputDir = args[1];

if (!inputFile) {
  console.error('用法: node reverse-keywords.js <products.json> [输出目录]');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
const products = data.products || [];
const category = data.category || '';

const outDir = outputDir
  ? path.join(outputDir, 'data')
  : path.dirname(inputFile);

// ── 品牌名提取 ──
function getBrandWords(product) {
  const words = new Set();
  if (product.brand) {
    product.brand.toLowerCase().split(/\s+/).forEach(w => {
      if (w.length > 1) words.add(w);
    });
  }
  // 从标题第一个逗号前提取品牌名
  const firstChunk = product.title.split(/[,|]/)[0].trim();
  const brandCandidate = firstChunk.split(/\s+/)[0].toLowerCase();
  if (brandCandidate.length > 2 && brandCandidate.length < 20) {
    words.add(brandCandidate);
  }
  return words;
}

// ── 标题预处理 ──
function cleanTitle(title) {
  return title
    .replace(/\([^)]*\)/g, ' ')    // 去括号内容
    .replace(/\[[^\]]*\]/g, ' ')   // 去方括号内容
    .replace(/[-–—]{2,}/g, ' ')    // 去多余破折号
    .replace(/\s+/g, ' ')          // 合并空格
    .trim();
}

// ── 从标题中提取名词短语 ──
function extractPhrases(title) {
  const phrases = [];
  // 按逗号和竖线分段
  const chunks = title.split(/[,|]/).map(c => c.trim()).filter(Boolean);
  for (const chunk of chunks) {
    // 去掉开头的数字/量词
    const cleaned = chunk.replace(/^\d+[-\s]?(?:piece|pcs|pack|set|count)?\s*/i, '').trim();
    if (cleaned.length > 2 && cleaned.length < 80) {
      phrases.push(cleaned);
    }
  }
  return phrases;
}

// ── 识别产品核心词（与名词库匹配） ──
function findCoreProduct(titleLower) {
  const matches = [];
  // 按长度降序匹配，优先匹配更长的短语
  const sorted = [...PRODUCT_NOUNS].sort((a, b) => b.length - a.length);
  for (const noun of sorted) {
    if (titleLower.includes(noun.toLowerCase())) {
      // 检查是否被已有匹配覆盖
      const covered = matches.some(m => m.includes(noun) || noun.includes(m));
      if (!covered) {
        matches.push(noun);
      }
    }
  }
  return matches;
}

// ── 提取修饰词 ──
function extractModifiers(titleLower) {
  const modifiers = [];
  for (const [key, value] of Object.entries(MODIFIER_KEYWORDS)) {
    if (titleLower.includes(key.toLowerCase())) {
      modifiers.push(value);
    }
  }
  return [...new Set(modifiers)];
}

// ── 从类目路径提取关键词线索 ──
function getCategoryKeywords(categoryPath) {
  if (!categoryPath) return [];
  return categoryPath
    .split('>')
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 2);
}

// ── 主反推逻辑 ──
function reverseEngineerKeywords(product, globalCategory) {
  const title = cleanTitle(product.title);
  const titleLower = title.toLowerCase();
  const brandWords = getBrandWords(product);
  // 优先用产品的最小目标类目，其次全局类目
  const catPath = product.smallestCategory || globalCategory || '';
  const categoryWords = getCategoryKeywords(catPath);

  // 1. 找核心产品词
  let coreProducts = findCoreProduct(titleLower);
  // 排除冲突语境下的误匹配（如 mouse repellent 中的 mouse）
  coreProducts = coreProducts.filter(c => !hasConflictContext(titleLower, c));

  // 2. 提取修饰词
  const modifiers = extractModifiers(titleLower);

  // 3. 从标题分段提取补充名词
  const phrases = extractPhrases(title);
  const supplementaryNouns = [];
  for (const phrase of phrases) {
    const words = phrase.toLowerCase().split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w) && !brandWords.has(w));
    // 找可能的产品名词（不在核心词中的名词）
    for (const word of words) {
      if (!coreProducts.some(c => c.includes(word)) &&
          !modifiers.some(m => m.includes(word)) &&
          !categoryWords.includes(word)) {
        supplementaryNouns.push(word);
      }
    }
  }

  // 4. 组装关键词（标题反推 + 最小类目叶子词参考）
  const keywords = new Set();

  // 核心产品词
  for (const core of coreProducts) {
    keywords.add(core);
  }

  // 修饰词 + 核心词 组合
  for (const modifier of modifiers) {
    for (const core of coreProducts) {
      keywords.add(`${modifier} ${core}`);
    }
  }

  // 最小类目叶子词：仅在没有匹配到核心词时作为参考
  // （如 "Patio, Lawn & Garden > Pest Control > Repellents > Sprays" → repellents, sprays）
  let categoryHint = '';
  if (catPath) {
    const segments = catPath.split('>').map(s => s.trim().toLowerCase()).filter(Boolean);
    const leafWords = new Set();
    for (const seg of segments.slice(-2)) {
      seg.split(/[\s&/]+/).forEach(w => {
        const clean = w.replace(/[^a-z0-9]/g, '');
        if (clean.length > 2 && !STOP_WORDS.has(clean) && !GENERIC_CATEGORY_WORDS.has(clean)) {
          leafWords.add(clean);
        }
      });
    }
    if (coreProducts.length === 0 && leafWords.size > 0) {
      // 标题无匹配 → 叶子词作为关键词
      for (const lw of leafWords) keywords.add(lw);
      categoryHint = Array.from(leafWords).join(', ');
    } else if (leafWords.size > 0) {
      // 有匹配 → 叶子词只做提示，不加入关键词
      categoryHint = Array.from(leafWords).join(', ');
    }
  }

  // 6. 检查类目一致性（用最小子类目）
  let categoryFlag = '';
  if (catPath) {
    const hasCategoryMatch = coreProducts.some(core =>
      categoryWords.some(cw => core.includes(cw) || cw.includes(core.split(' ')[0]))
    );
    if (!hasCategoryMatch && coreProducts.length > 0) {
      categoryFlag = `关键词 "${coreProducts.join(', ')}" 未匹配类目 "${catPath}"`;
    }
  }

  return {
    keywords: Array.from(keywords)
      .filter(k => k.length > 1)
      .filter(k => new Set(k.split(/\s+/)).size === k.split(/\s+/).length),
    coreProducts,
    modifiers,
    categoryFlag,
    categoryHint
  };
}

// ── 执行反推 ──
console.log(`\n🔤 开始反推关键词...`);
console.log(`📦 输入产品数: ${products.length}`);
console.log(`📂 目标类目: ${category}\n`);

const results = [];
const allKeywords = new Map(); // keyword -> { count, asins, categoryMatch }

for (const product of products) {
  const analysis = reverseEngineerKeywords(product, category);
  results.push({
    asin: product.asin,
    title: product.title,
    smallestCategory: product.smallestCategory || '',
    ...analysis
  });

  // 汇总关键词
  for (const kw of analysis.keywords) {
    if (!allKeywords.has(kw)) {
      allKeywords.set(kw, { count: 0, asins: [], categoryMatch: true });
    }
    const entry = allKeywords.get(kw);
    entry.count++;
    if (product.asin) entry.asins.push(product.asin);
    if (analysis.categoryFlag) entry.categoryMatch = false;
  }
}

// 按出现次数排序关键词
const sortedKeywords = Array.from(allKeywords.entries())
  .sort((a, b) => b[1].count - a[1].count)
  .map(([keyword, info]) => ({
    keyword,
    productCount: info.count,
    asins: info.asins,
    categoryConsistent: info.categoryMatch
  }));

// 统计类目标记
const flaggedProducts = results.filter(r => r.categoryFlag);

const outputData = {
  sourceFile: inputFile,
  category,
  reverseTime: new Date().toISOString(),
  productCount: products.length,
  keywordCount: sortedKeywords.length,
  flaggedCount: flaggedProducts.length,
  products: results,
  keywords: sortedKeywords,
  flaggedProducts: flaggedProducts.map(p => ({
    asin: p.asin,
    title: p.title,
    categoryPath: p.categoryPath,
    flag: p.categoryFlag,
    keywords: p.keywords
  }))
};

// 保存结果
fs.mkdirSync(outDir, { recursive: true });
const outputFile = path.join(outDir, 'keywords.json');
fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2), 'utf-8');

// 控制台输出摘要
console.log('─'.repeat(60));
console.log(`📊 反推结果摘要`);
console.log('─'.repeat(60));
console.log(`产品数: ${products.length}`);
console.log(`关键词总数: ${sortedKeywords.length}`);
console.log(`类目标记产品: ${flaggedProducts.length}`);
console.log();

console.log('🔑 关键词列表 (按出现频率排序):');
console.log('─'.repeat(60));
for (const kw of sortedKeywords) {
  const flag = kw.categoryConsistent ? '' : ' ⚠️';
  console.log(`  ${kw.keyword}  (${kw.productCount} 个产品)${flag}`);
}

if (flaggedProducts.length > 0) {
  console.log();
  console.log('⚠️ 类目不一致的产品:');
  console.log('─'.repeat(60));
  for (const p of flaggedProducts) {
    console.log(`  ${p.asin}: ${p.categoryFlag}`);
    console.log(`    关键词: ${p.keywords.join(', ')}`);
  }
}

console.log();
console.log(`✅ 结果已保存到: ${outputFile}`);
