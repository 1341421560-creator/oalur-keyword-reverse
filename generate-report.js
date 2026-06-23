/**
 * oalur-keyword-reverse - generate-report.js
 *
 * 鐢熸垚 HTML 鎶ュ憡锛氫骇鍝佽〃鏍?+ 鍏抽敭璇嶅尮閰嶇粺璁? * 閰嶅悎 fetch-keywords.js 鐨勮緭鍑烘牸寮? *
 * 鐢ㄦ硶: node skills/oalur-keyword-reverse/generate-report.js <keywords.json> [杈撳嚭鐩綍]
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_REPORT_LIMIT = 30;
const args = process.argv.slice(2);
const inputFile = args[0];
if (!inputFile) {
  console.error('鐢ㄦ硶: node generate-report.js <keywords.json> [杈撳嚭鐩綍]');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
function resolveReportOutputDir(inputPath, outputArg) {
  const inputDir = path.dirname(inputPath);
  const taskRoot = path.basename(inputDir).toLowerCase() === 'data'
    ? path.dirname(inputDir)
    : path.dirname(inputPath);
  if (!outputArg) return path.join(taskRoot, 'reports');
  if (path.normalize(outputArg) === path.normalize('output') || path.resolve(outputArg) === path.resolve(taskRoot)) {
    return path.join(taskRoot, 'reports');
  }
  return path.join(outputArg, 'reports');
}
const outDir = resolveReportOutputDir(inputFile, args[1]);
const requestedReportLimit = Number.parseInt(args[2] || process.env.OALUR_REPORT_LIMIT || '', 10);
const requestedLocalAgentFile = args[3] || process.env.OALUR_LOCAL_AGENT_FILE || '';

fs.mkdirSync(outDir, { recursive: true });

const dateStr = new Date().toISOString().slice(0, 10);
const categorySlug = (data.category || 'unknown')
  .replace(/[<>:"/\\|?*]/g, '-')
  .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .substring(0, 30) || 'unknown';
const reportFile = path.join(outDir, `${dateStr}_${categorySlug}_关键词反推.html`);
const localAgent30ReportFile = path.join(outDir, `${dateStr}_${categorySlug}_local-agent-30.html`);

let sourceProducts = [];
const sourceProductsFile = path.join(path.dirname(inputFile), 'products.json');
if (fs.existsSync(sourceProductsFile)) {
  try {
    sourceProducts = JSON.parse(fs.readFileSync(sourceProductsFile, 'utf-8')).products || [];
  } catch (_) {
    sourceProducts = [];
  }
}
const sourceProductByAsin = new Map(sourceProducts.map(p => [p.asin, p]));
let keywordCandidates = [];
const keywordCandidatesFile = path.join(path.dirname(inputFile), 'keyword-candidates.json');
if (fs.existsSync(keywordCandidatesFile)) {
  try {
    keywordCandidates = JSON.parse(fs.readFileSync(keywordCandidatesFile, 'utf-8')).products || [];
  } catch (_) {
    keywordCandidates = [];
  }
}
const keywordCandidateByAsin = new Map(keywordCandidates.map(p => [p.asin, p]));
const REPORT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'into',
  'is', 'of', 'on', 'or', 'the', 'to', 'with'
]);

function normalizeCandidateList(row) {
  const source = Array.isArray(row?.mergedCandidates)
    ? row.mergedCandidates
    : [];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const keyword = String(item.keyword || item || '').trim();
    if (!keyword) continue;
    const lower = keyword.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push({
      keyword,
      volume: Number.parseInt(item.volume || 0, 10) || 0
    });
  }
  return result;
}

function reportScoreKeyword(titleLower, keywordLower) {
  const words = keywordLower.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let score = titleLower.includes(keywordLower) ? 20 : 0;
  let significant = 0;
  let matches = 0;
  let lastIndex = -1;
  let ordered = true;
  for (const word of words) {
    if (REPORT_STOP_WORDS.has(word)) continue;
    significant++;
    const index = titleLower.indexOf(word);
    if (index >= 0) {
      matches++;
      score += Math.min(word.length / 2, 3);
      if (index < lastIndex) ordered = false;
      lastIndex = index;
    } else {
      score -= Math.min(word.length / 4, 1);
    }
  }
  if (significant === 0) return 0;
  score += (matches / significant) * 5;
  if (ordered && matches >= 2) score += 2;
  return Math.round(score * 100) / 100;
}

function reportCandidateMatchType(titleLower, keywordLower, score) {
  if (titleLower.includes(keywordLower)) return 'exact';
  if (score >= 5) return 'word_split';
  if (score > 0) return 'partial';
  return 'filtered';
}

function reportCandidateContext(candidateRow, keywordRow) {
  if (!candidateRow) return {};
  const title = candidateRow.title || keywordRow.title || '';
  const titleLower = String(title).toLowerCase();
  const selected = String(keywordRow.keyword || '').toLowerCase();
  const candidates = normalizeCandidateList(candidateRow);
  const scored = candidates
    .filter(item => item.keyword.toLowerCase() !== selected)
    .map(item => {
      const keywordLower = item.keyword.toLowerCase();
      const score = reportScoreKeyword(titleLower, keywordLower);
      return {
        keyword: item.keyword,
        volume: item.volume,
        reason: titleLower.includes(keywordLower) ? 'exact_not_selected' : 'not_exact_match',
        matchType: reportCandidateMatchType(titleLower, keywordLower, score),
        score
      };
    });
  const exactAlternatives = scored
    .filter(item => item.matchType === 'exact')
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.volume - a.volume))
    .slice(0, 8);
  const filteredKeywords = scored
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.volume - a.volume))
    .slice(0, 10);
  return {
    title,
    category: candidateRow.category || '',
    categories: Array.isArray(candidateRow.categories) ? candidateRow.categories : [],
    exactAlternatives,
    filteredKeywords
  };
}

const allProducts = (data.products || []).map(p => ({
  ...(sourceProductByAsin.get(p.asin) || {}),
  ...(reportCandidateContext(keywordCandidateByAsin.get(p.asin), p) || {}),
  ...p
}));
const reportLimit = Number.isFinite(requestedReportLimit) && requestedReportLimit > 0
  ? Math.min(requestedReportLimit, allProducts.length)
  : Math.min(DEFAULT_REPORT_LIMIT, allProducts.length);
const products = allProducts.slice(0, reportLimit);

function loadLocalAgentAnalysis(dataDir, limit) {
  const candidates = [];
  if (requestedLocalAgentFile) candidates.push(requestedLocalAgentFile);
  candidates.push(path.join(dataDir, 'local-agent-analysis.json'));
  candidates.push(path.join(dataDir, `local-agent-analysis-${limit}.json`));

  try {
    for (const fileName of fs.readdirSync(dataDir)) {
      if (/^local-agent-analysis.*\.json$/i.test(fileName) && fileName !== 'local-agent-analysis-all.json') {
        candidates.push(path.join(dataDir, fileName));
      }
    }
  } catch (_) {}

  for (const filePath of candidates) {
    if (!filePath || !fs.existsSync(filePath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const rows = Array.isArray(raw.products) ? raw.products : [];
      return {
        filePath,
        mode: raw.mode || '',
        byAsin: new Map(rows.map(row => [row.asin, row]).filter(([asin]) => asin))
      };
    } catch (_) {}
  }

  return { filePath: '', mode: '', byAsin: new Map() };
}

const localAgentAnalysis = loadLocalAgentAnalysis(path.dirname(inputFile), reportLimit);
const hasLocalAgentAnalysis = localAgentAnalysis.byAsin.size > 0;
if (!hasLocalAgentAnalysis) {
  console.warn('No Codex local-agent analysis found. Exact JS results will go to keywords-agent-unreviewed.json, not same.');
}

function localAgentCompareValue(row) {
  if (!row) return null;
  if (typeof row.sameAsCurrentKeyword === 'boolean') return row.sameAsCurrentKeyword;
  if (typeof row.changed === 'boolean') return !row.changed;
  return null;
}

function localAgentProductBody(row) {
  if (!row) return '';
  return row.productBody || row.coreProduct || row.agentProductBody || row.agentKeyword || '';
}

function localAgentModeLabel() {
  if (!hasLocalAgentAnalysis) return 'missing_codex_local_agent_analysis';
  return 'codex_local_agent_analysis';
}

function writeLocalAgentSplitKeywordFiles() {
  const dataDir = path.dirname(inputFile);
  const splitProducts = data.products || [];
  const sameProducts = [];
  const diffProducts = [];
  const nonExactProducts = [];
  const unreviewedProducts = [];

  for (const product of splitProducts) {
    if (product.matchType !== 'exact') {
      nonExactProducts.push({ ...product });
      continue;
    }

    const row = localAgentAnalysis.byAsin.get(product.asin);
    if (!row) {
      unreviewedProducts.push({
        ...product,
        reviewStatus: 'missing_codex_local_agent_analysis'
      });
      continue;
    }

    const same = localAgentCompareValue(row);
    if (same === true) {
      sameProducts.push({ ...product });
      continue;
    }

    if (same === false) {
      diffProducts.push({
        ...product,
        keyword: [product.keyword || '', localAgentProductBody(row) || '']
      });
    }
  }

  const baseMeta = {
    ...data,
    sourceFile: inputFile,
    splitFrom: path.basename(inputFile),
    localAgentFile: localAgentAnalysis.filePath || null,
    localAgentMode: localAgentModeLabel(),
    splitTime: new Date().toISOString()
  };
  delete baseMeta.products;

  const sameOutput = {
    ...baseMeta,
    splitType: 'js_agent_same',
    productCount: sameProducts.length,
    products: sameProducts
  };
  const diffOutput = {
    ...baseMeta,
    splitType: 'js_agent_different',
    productCount: diffProducts.length,
    keywordFormat: ['jsKeyword', 'agentProductBody'],
    products: diffProducts
  };
  const nonExactOutput = {
    ...baseMeta,
    splitType: 'js_non_exact',
    productCount: nonExactProducts.length,
    products: nonExactProducts
  };
  const unreviewedOutput = {
    ...baseMeta,
    splitType: 'js_agent_unreviewed',
    productCount: unreviewedProducts.length,
    products: unreviewedProducts
  };

  const sameFile = path.join(dataDir, 'keywords-agent-same.json');
  const diffFile = path.join(dataDir, 'keywords-agent-diff.json');
  const nonExactFile = path.join(dataDir, 'keywords-agent-non-exact.json');
  const unreviewedFile = path.join(dataDir, 'keywords-agent-unreviewed.json');
  fs.writeFileSync(sameFile, JSON.stringify(sameOutput, null, 2), 'utf-8');
  fs.writeFileSync(diffFile, JSON.stringify(diffOutput, null, 2), 'utf-8');
  fs.writeFileSync(nonExactFile, JSON.stringify(nonExactOutput, null, 2), 'utf-8');
  fs.writeFileSync(unreviewedFile, JSON.stringify(unreviewedOutput, null, 2), 'utf-8');
  return [sameFile, diffFile, nonExactFile, unreviewedFile];
}

const localAgentSplitFiles = writeLocalAgentSplitKeywordFiles();

// 鈹€鈹€ 鍖归厤绫诲瀷鏄犲皠 鈹€鈹€
const MATCH_MAP = {
  exact:        { icon: 'OK', label: 'exact', cls: 'm-exact' },
  word_split:   { icon: 'WS', label: 'word_split', cls: 'm-split' },
  partial:      { icon: 'PT', label: 'partial', cls: 'm-partial' },
  fallback_top1:{ icon: 'FB', label: 'fallback', cls: 'm-fallback' },
  error:        { icon: 'ER', label: 'error', cls: 'm-error' },
};
const DEFAULT_MATCH = { icon: 'NA', label: 'unknown', cls: 'm-unknown' };

// 鈹€鈹€ 杈呭姪鍑芥暟 鈹€鈹€
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function truncate(s, n) {
  return s && s.length > n ? s.slice(0, n) + '...' : s;
}

function renderExactAlternatives(p) {
  const alternatives = Array.isArray(p.exactAlternatives) ? p.exactAlternatives : [];
  if (alternatives.length === 0) return '';

  const tags = alternatives.map(item => {
    const volume = Number.isFinite(item.volume) ? item.volume.toLocaleString() : '-';
    const title = `${item.keyword} | type ${item.type || '-'} | volume ${volume} | quality ${item.qualityScore ?? '-'}`;
    return `<span class="alt-tag" title="${escapeHtml(title)}">${escapeHtml(truncate(item.keyword, 24))}</span>`;
  }).join('');

  return `<div class="exact-alts"><span class="alt-label">鍏朵粬 exact:</span>${tags}</div>`;
}

function renderFilteredKeywords(p) {
  const filtered = Array.isArray(p.filteredKeywords) ? p.filteredKeywords : [];
  if (filtered.length === 0) return '';

  const tags = filtered
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 3)
    .map(item => {
    const volume = Number.isFinite(item.volume) ? item.volume.toLocaleString() : '-';
    const title = `${item.keyword} | ${item.reason || 'filtered'} | volume ${volume} | score ${item.score ?? '-'}`;
    return `<span class="filtered-tag" title="${escapeHtml(title)}">${escapeHtml(truncate(item.keyword, 24))}</span>`;
  }).join('');

  return `<div class="filtered-kws"><span class="alt-label">杩囨护:</span>${tags}</div>`;
}

function renderExactStatus(p) {
  if (p.hasExactMatch !== false) return '';
  return '<span class="no-exact-tag" title="鍊欓€夎瘝涓病鏈夋爣棰?exact 鍛戒腑锛屽綋鍓嶅叧閿瘝鏉ヨ嚜鍒嗚瘝鍖归厤鎴?fallback">鏃?exact</span>';
}

function renderCategoryPaths(p) {
  const paths = Array.isArray(p.categories) && p.categories.length > 0
    ? p.categories
    : [p.category || p.smallestCategory || data.category || '-'];

  return paths
    .filter(Boolean)
    .map(pathValue => `<div class="cat-path">${escapeHtml(pathValue)}</div>`)
    .join('');
}

function localAgentRow(p) {
  return hasLocalAgentAnalysis ? localAgentAnalysis.byAsin.get(p.asin) : null;
}

function renderLocalAgentProduct(p) {
  const row = localAgentRow(p);
  if (!row) return '<span class="agent-missing">-</span>';

  const productBody = localAgentProductBody(row) || '-';
  const confidence = row.confidence ?? row.agentIntentFit ?? null;
  const reason = row.reason || row.agentReason || '';
  const confidenceText = confidence == null ? '' : `<div class="agent-conf">confidence ${escapeHtml(confidence)}</div>`;
  return `<span class="agent-body" title="${escapeHtml(reason)}">${escapeHtml(productBody)}</span>${confidenceText}`;
}

function renderLocalAgentCompare(p) {
  const row = localAgentRow(p);
  if (!row) return '<span class="agent-missing">-</span>';

  const same = localAgentCompareValue(row);
  const label = same ? 'same' : 'different';
  const cls = same ? 'agent-same' : 'agent-diff';
  const reason = row.reason || row.agentReason || '';
  return `<span class="${cls}" title="${escapeHtml(reason)}">${label}</span>`;
}

// 鈹€鈹€ 鐢熸垚鎽樿鍗＄墖 鈹€鈹€
function summaryCards() {
  const total = products.length;
  const exact = products.filter(p => p.matchType === 'exact').length;
  const split = products.filter(p => p.matchType === 'word_split').length;
  const partial = products.filter(p => p.matchType === 'partial').length;
  const fallback = products.filter(p => p.matchType === 'fallback_top1').length;
  const errors = products.filter(p => p.matchType === 'error' || !p.matchType).length;
  const agentCompared = hasLocalAgentAnalysis
    ? products.filter(p => localAgentAnalysis.byAsin.has(p.asin)).length
    : 0;
  const agentDiff = hasLocalAgentAnalysis
    ? products.filter(p => {
        const row = localAgentAnalysis.byAsin.get(p.asin);
        if (!row) return false;
        return localAgentCompareValue(row) === false;
      }).length
    : 0;
  const matched = exact + split + partial;
  const matchRate = total > 0 ? ((matched / total) * 100).toFixed(1) : '0.0';

  return `
    <div class="card"><div class="num">${total}</div><div class="label">浜у搧鏁?/div></div>
    <div class="card"><div class="num" style="color:#2e7d32">${matched}</div><div class="label">宸插尮閰?(${matchRate}%)</div></div>
    <div class="card"><div class="num" style="color:#1976d2">${exact}</div><div class="label">鉁?绮剧‘鍖归厤</div></div>
    <div class="card"><div class="num" style="color:#f57c00">${split}</div><div class="label">馃攢 鍒嗚瘝鍖归厤</div></div>
    <div class="card"><div class="num" style="color:#ffa000">${partial}</div><div class="label">鈿狅笍 閮ㄥ垎鍖归厤</div></div>
    <div class="card"><div class="num" style="color:#888">${fallback}</div><div class="label">猬囷笍 Fallback</div></div>
    <div class="card"><div class="num" style="color:#d32f2f">${errors}</div><div class="label">鉂?閿欒</div></div>
    ${hasLocalAgentAnalysis ? `<div class="card"><div class="num" style="color:#b45309">${agentDiff}</div><div class="label">Agent 宸紓 / ${agentCompared}</div></div>` : ''}`;
}

// 鈹€鈹€ 鍖归厤绫诲瀷鍒嗗竷鏉?鈹€鈹€
function matchBar() {
  const total = products.length || 1;
  const exact = (products.filter(p => p.matchType === 'exact').length / total * 100).toFixed(1);
  const split = (products.filter(p => p.matchType === 'word_split').length / total * 100).toFixed(1);
  const partial = (products.filter(p => p.matchType === 'partial').length / total * 100).toFixed(1);
  const fallback = (products.filter(p => p.matchType === 'fallback_top1').length / total * 100).toFixed(1);
  const errors = (products.filter(p => p.matchType === 'error' || !p.matchType).length / total * 100).toFixed(1);
  return `
    <div class="match-bar">
      <div class="bar-exact" style="width:${exact}%" title="鉁?绮剧‘鍖归厤 ${exact}%">${exact}%</div>
      <div class="bar-split" style="width:${split}%" title="馃攢 鍒嗚瘝鍖归厤 ${split}%">${split}%</div>
      <div class="bar-partial" style="width:${partial}%" title="鈿狅笍 閮ㄥ垎鍖归厤 ${partial}%">${partial}%</div>
      <div class="bar-fallback" style="width:${fallback}%" title="猬囷笍 Fallback ${fallback}%">${fallback}%</div>
      <div class="bar-error" style="width:${errors}%" title="鉂?閿欒 ${errors}%">${errors}%</div>
    </div>
    <div class="match-legend">
      <span class="legend-item"><span class="dot" style="background:#4caf50"></span> 绮剧‘鍖归厤 ${exact}%</span>
      <span class="legend-item"><span class="dot" style="background:#ff9800"></span> 鍒嗚瘝鍖归厤 ${split}%</span>
      <span class="legend-item"><span class="dot" style="background:#ffa000"></span> 閮ㄥ垎鍖归厤 ${partial}%</span>
      <span class="legend-item"><span class="dot" style="background:#bdbdbd"></span> Fallback ${fallback}%</span>
      <span class="legend-item"><span class="dot" style="background:#ef5350"></span> 閿欒 ${errors}%</span>
    </div>`;
}

// 鈹€鈹€ 鐢熸垚浜у搧琛ㄦ牸琛?鈹€鈹€
function productRows() {
  return products.map((p, i) => {
    const catPath = Array.isArray(p.categories) && p.categories.length > 0
      ? p.categories.join('\n')
      : (p.category || p.smallestCategory || data.category || '-');
    const mt = MATCH_MAP[p.matchType] || DEFAULT_MATCH;
    const agentCells = hasLocalAgentAnalysis
      ? `<td class="agent-cell">${renderLocalAgentProduct(p)}</td><td>${renderLocalAgentCompare(p)}</td>`
      : '';
    return `<tr>
      <td>${i + 1}</td>
      <td><code>${escapeHtml(p.asin || '-')}</code></td>
      <td class="title-cell" title="${escapeHtml(p.title)}">${escapeHtml(truncate(p.title, 80))}</td>
      <td class="cate-cell" title="${escapeHtml(catPath)}">${renderCategoryPaths(p)}</td>
      <td class="kw-cell">${p.keyword ? `<span class="kw-tag">${escapeHtml(p.keyword)}</span>${renderExactStatus(p)}${renderFilteredKeywords(p)}` : '<span class="no-kw">-</span>'}</td>
      <td><span class="match-badge ${mt.cls}">${mt.icon} ${mt.label}</span></td>
      <td class="score-cell">${p.score != null ? p.score.toFixed(1) : '-'}</td>
      ${agentCells}
    </tr>`;
  }).join('\n');
}

function writeLocalAgent30Report() {
  const localAgentProducts = allProducts.slice(0, DEFAULT_REPORT_LIMIT);
  const compared = localAgentProducts.filter(product => localAgentAnalysis.byAsin.has(product.asin));
  const same = compared.filter(product => localAgentCompareValue(localAgentAnalysis.byAsin.get(product.asin)) === true).length;
  const different = compared.filter(product => localAgentCompareValue(localAgentAnalysis.byAsin.get(product.asin)) === false).length;

  const rows = localAgentProducts.map((product, index) => {
    const row = localAgentAnalysis.byAsin.get(product.asin);
    const productBody = row ? localAgentProductBody(row) : '';
    const sameValue = row ? localAgentCompareValue(row) : null;
    const status = sameValue === true ? 'same' : sameValue === false ? 'different' : '-';
    const rowClass = sameValue === false ? 'diff' : sameValue === true ? 'same' : 'missing';
    const reason = row ? (row.reason || row.agentReason || '') : 'local-agent-analysis.json 涓病鏈夎 ASIN 鐨勬湰鍦?agent 鍒嗘瀽缁撴灉';
    const confidence = row && row.confidence != null ? row.confidence : '';
    return `<tr class="${rowClass}">
  <td>${index + 1}</td>
  <td><code>${escapeHtml(product.asin || '-')}</code></td>
  <td class="title">${escapeHtml(product.title || '-')}</td>
  <td>${product.keyword ? escapeHtml(product.keyword) : '-'}</td>
  <td>${productBody ? escapeHtml(productBody) : '-'}</td>
  <td>${escapeHtml(product.matchType || '-')}</td>
  <td>${product.score != null ? escapeHtml(Number(product.score).toFixed(1)) : '-'}</td>
  <td>${escapeHtml(status)}</td>
  <td>${confidence !== '' ? escapeHtml(confidence) : '-'}</td>
  <td>${escapeHtml(reason)}</td>
</tr>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(data.category || '')} 鍓?30 ASIN 鏈湴 agent 鍒嗘瀽</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:#f6f7f9;color:#222;margin:0;padding:24px}
.wrap{max-width:1400px;margin:0 auto}
h1{font-size:24px;margin:0 0 8px}
.meta{color:#666;margin-bottom:16px;font-size:13px}
.cards{display:flex;gap:12px;margin:16px 0;flex-wrap:wrap}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px 18px;min-width:130px}
.num{font-size:28px;font-weight:700}
.label{font-size:12px;color:#666}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:13px}
th,td{border-bottom:1px solid #eef0f3;padding:9px 10px;text-align:left;vertical-align:top}
th{background:#f3f4f6}
tr.diff td{background:#fff7ed}
tr.missing td{background:#f9fafb;color:#666}
.title{max-width:420px;line-height:1.35}
code{background:#f0f2f5;padding:2px 5px;border-radius:4px}
</style>
</head>
<body>
<div class="wrap">
<h1>${escapeHtml(data.category || '鏈煡绫荤洰')} 鍓?30 ASIN锛氭湰鍦?agent 鏍稿績浜у搧鍒嗘瀽</h1>
<div class="meta">鏉ユ簮锛?code>${escapeHtml(inputFile)}</code> | Agent 鏂囦欢锛?code>${escapeHtml(localAgentAnalysis.filePath || '-')}</code> | 鐢熸垚鏃堕棿锛?{escapeHtml(new Date().toISOString())}</div>
<div class="cards">
  <div class="card"><div class="num">${localAgentProducts.length}</div><div class="label">灞曠ず ASIN</div></div>
  <div class="card"><div class="num">${compared.length}</div><div class="label">宸叉瘮瀵?/div></div>
  <div class="card"><div class="num">${same}</div><div class="label">璇箟涓€鑷?/div></div>
  <div class="card"><div class="num">${different}</div><div class="label">璇箟涓嶄竴鑷?/div></div>
</div>
<table>
<thead><tr><th>#</th><th>ASIN</th><th>鏍囬</th><th>JS 鍏抽敭璇?/th><th>Agent 鏍稿績浜у搧</th><th>matchType</th><th>JS 寰楀垎</th><th>姣斿</th><th>缃俊搴?/th><th>鍒ゆ柇渚濇嵁</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>
</body>
</html>`;

  fs.writeFileSync(localAgent30ReportFile, html, 'utf-8');
  return localAgent30ReportFile;
}

// 鈹€鈹€ 鐢熸垚 HTML 鈹€鈹€
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>鍏抽敭璇嶅弽鎺ㄦ姤鍛?- ${escapeHtml(data.category || '')}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; color: #333; padding: 20px; }
  .container { max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 8px; color: #1a1a1a; }
  h2 { font-size: 18px; margin: 24px 0 12px; color: #444; border-bottom: 2px solid #e0e0e0; padding-bottom: 6px; }
  .meta { color: #888; font-size: 13px; margin-bottom: 20px; }
  .meta span { margin-right: 16px; }

  /* 鎽樿鍗＄墖 */
  .summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-align: center; }
  .card .num { font-size: 28px; font-weight: 700; color: #4a90d9; }
  .card .label { font-size: 12px; color: #999; margin-top: 4px; }

  /* 鍖归厤鍒嗗竷鏉?*/
  .match-bar { display: flex; height: 28px; border-radius: 6px; overflow: hidden; margin-bottom: 8px; font-size: 11px; font-weight: 600; color: #fff; text-align: center; line-height: 28px; }
  .bar-exact { background: #4caf50; transition: width 0.5s; }
  .bar-split { background: #ff9800; transition: width 0.5s; }
  .bar-partial { background: #ffa000; transition: width 0.5s; }
  .bar-fallback { background: #bdbdbd; transition: width 0.5s; }
  .bar-error { background: #ef5350; transition: width 0.5s; }
  .match-legend { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; font-size: 13px; color: #555; }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }

  /* 琛ㄦ牸 */
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 20px; font-size: 13px; }
  th { background: #f8f9fa; padding: 10px 12px; text-align: left; font-weight: 600; color: #555; border-bottom: 2px solid #e0e0e0; }
  td { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  tr:hover td { background: #f8f9fb; }
  .title-cell { max-width: 300px; }
  .cate-cell { max-width: 360px; font-size: 12px; color: #666; }
  .cat-path { margin-bottom: 6px; line-height: 1.35; }
  .cat-path:last-child { margin-bottom: 0; }
  .kw-cell { max-width: 200px; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  .kw-tag { display: inline-block; background: #e8f4fd; color: #2d7ab8; padding: 2px 10px; border-radius: 12px; font-size: 12px; white-space: nowrap; }
  .no-exact-tag { display: inline-block; margin-left: 6px; background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; padding: 1px 6px; border-radius: 10px; font-size: 11px; line-height: 1.5; vertical-align: middle; }
  .agent-cell { max-width: 220px; }
  .agent-body { display: inline-block; background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; padding: 2px 9px; border-radius: 12px; font-size: 12px; }
  .agent-conf { color: #777; font-size: 11px; margin-top: 4px; }
  .agent-same, .agent-diff, .agent-missing { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; white-space: nowrap; }
  .agent-same { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
  .agent-diff { background: #fff7ed; color: #c2410c; border: 1px solid #fed7aa; }
  .agent-missing { background: #f3f4f6; color: #777; border: 1px solid #e5e7eb; }
  .exact-alts { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; max-width: 260px; }
  .filtered-kws { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; max-width: 320px; }
  .alt-label { color: #777; font-size: 11px; }
  .alt-tag { display: inline-block; background: #f3f4f6; color: #555; border: 1px solid #e0e0e0; padding: 1px 6px; border-radius: 10px; font-size: 11px; line-height: 1.5; }
  .filtered-tag { display: inline-block; background: #fff7ed; color: #9a3412; border: 1px solid #fed7aa; padding: 1px 6px; border-radius: 10px; font-size: 11px; line-height: 1.5; }
  .no-kw { color: #ccc; }

  /* 鍖归厤绫诲瀷寰界珷 */
  .match-badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .m-exact { background: #e8f5e9; color: #2e7d32; }
  .m-split { background: #fff3e0; color: #e65100; }
  .m-partial { background: #fff8e1; color: #f57f17; }
  .m-fallback { background: #f5f5f5; color: #757575; }
  .m-error { background: #ffebee; color: #c62828; }
  .m-unknown { background: #f3e5f5; color: #7b1fa2; }

  .section { background: #fff; border-radius: 8px; padding: 20px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 20px; }

  @media (max-width: 768px) {
    body { padding: 12px; }
    table { font-size: 11px; display: block; overflow-x: auto; }
    .summary-cards { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<div class="container">
  <h1>馃敜 鍏抽敭璇嶅弽鎺ㄦ姤鍛?/h1>
  <div class="meta">
    <span>馃搨 绫荤洰: <strong>${escapeHtml(data.category || '鏈煡')}</strong></span>
    <span>馃搮 ${data.fetchTime?.slice(0, 10) || dateStr}</span>
    <span>馃敆 鏉ユ簮: <code>${escapeHtml(data.sourceFile || '-')}</code></span>
    ${hasLocalAgentAnalysis ? `<span>馃Л Agent 姣斿: <code>${escapeHtml(path.basename(localAgentAnalysis.filePath))}</code></span>` : ''}
  </div>

  <h2>馃搳 鎽樿</h2>
  <div class="summary-cards">
    ${summaryCards()}
  </div>
  ${matchBar()}

  <h2>馃摝 浜у搧鏄庣粏 (${products.length} / ${allProducts.length})</h2>
  <table>
    <thead><tr>
      <th>#</th><th>ASIN</th><th>鏍囬</th><th>鐩爣绫荤洰</th><th>JS 鍙嶆煡鍏抽敭璇?/th><th>鍖归厤绫诲瀷</th><th>JS 寰楀垎</th>${hasLocalAgentAnalysis ? '<th>Agent 鏍稿績浜у搧</th><th>JS vs Agent</th>' : ''}
    </tr></thead>
    <tbody>
      ${productRows()}
    </tbody>
  </table>

  <div class="meta" style="margin-top:30px; text-align:center;">
    鐢熸垚鏃堕棿: ${new Date().toISOString()} | 宸ュ叿: oalur-keyword-reverse (fetch-keywords.js)
  </div>
</div>
</body>
</html>`;

fs.writeFileSync(reportFile, html, 'utf-8');
const localAgent30File = writeLocalAgent30Report();
console.log(`\n鉁?鎶ュ憡宸茬敓鎴? ${reportFile}`);
console.log(`馃搧 ${localAgent30File}`);
if (localAgentSplitFiles.length > 0) {
  for (const filePath of localAgentSplitFiles) {
    console.log(`馃搧 ${filePath}`);
  }
}

