/**
 * oalur-keyword-reverse - extract.js
 *
 * 从 Oalur 产品筛选页抓取 New Releases TOP100 新品数据
 * 通过拦截 XHR API 获取完整产品数据（含子类目路径）
 *
 * 用法: node extract.js <类目名称> [输出目录] [最低价格] [最高价格]
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const FILTERS = {
  minSales: 70,
  minRating: 4,
  priceMin: 10,
  priceMax: 20,
  maxWeight: 11,
  sellerType: '第三方卖家',
  listingDuration: '近6个月',
  tag: 'New Releases Top100'
};

const MAX_PAGES = 30;
const PAGE_SIZE = 20;
const OALUR_URL = 'https://vip.oalur.com/insight/filter/index?site=US';
const CDP_URL = 'http://localhost:9222';

const args = process.argv.slice(2);
const category = args[0];
const outputDir = args[1];
const priceMinArg = Number.parseFloat(args[2] || '');
const priceMaxArg = Number.parseFloat(args[3] || '');
const requestedProductLimit = Number.parseInt(args[4] || process.env.OALUR_PRODUCT_LIMIT || '', 10);
const productLimit = Number.isFinite(requestedProductLimit) && requestedProductLimit > 0
  ? requestedProductLimit
  : null;
function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
const dateStr = localDateString();

if (!category) {
  console.error('用法: node extract.js <类目名称> [输出目录] [最低价格] [最高价格]');
  process.exit(1);
}

if (Number.isFinite(priceMinArg)) FILTERS.priceMin = priceMinArg;
if (Number.isFinite(priceMaxArg)) FILTERS.priceMax = priceMaxArg;
if (FILTERS.priceMin < 0 || FILTERS.priceMax < 0 || FILTERS.priceMin > FILTERS.priceMax) {
  console.error(`价格参数无效: 最低价格=${FILTERS.priceMin}, 最高价格=${FILTERS.priceMax}`);
  process.exit(1);
}

function slugifyName(value) {
  return String(value || 'unknown')
    .trim()
    .replace(/&/g, 'and')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unknown';
}

function priceLabel(min, max) {
  return `${String(min).replace(/\./g, 'p')}-${String(max).replace(/\./g, 'p')}`;
}

const taskSlug = `${dateStr}_${slugifyName(category)}_price-${priceLabel(FILTERS.priceMin, FILTERS.priceMax)}`;
const taskRoot = outputDir
  ? (path.normalize(outputDir) === path.normalize('output') ? path.join(outputDir, taskSlug) : outputDir)
  : path.join('output', taskSlug);
const dataDir = outputDir
  ? path.join(taskRoot, 'data')
  : path.join(taskRoot, 'data');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeCategoryLabel(value) {
  return normalizeText(value)
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+\d[\d,]*$/g, '')
    .toLowerCase();
}

function splitCategoryPath(value) {
  return String(value || '')
    .split('>')
    .map(part => normalizeText(part))
    .filter(Boolean);
}

function categoryPathMatches(pathValue, categoryName) {
  const target = normalizeCategoryLabel(categoryName);
  if (!target) return false;
  return splitCategoryPath(pathValue).some(part => normalizeCategoryLabel(part) === target);
}

async function checkEdge() {
  const net = require('net');
  return new Promise(resolve => {
    const s = net.createConnection({ host: '127.0.0.1', port: 9222 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => { s.destroy(); resolve(false); });
    s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  });
}

async function launchEdge() {
  const { execSync } = require('child_process');
  console.log('⚠️ Edge 未运行，正在启动...');
  execSync(
    'Start-Process msedge -ArgumentList "--remote-debugging-port=9222","--no-first-run"',
    { shell: 'powershell.exe' }
  );
  for (let i = 0; i < 10; i++) { await sleep(2000); if (await checkEdge()) return; }
  throw new Error('Edge 启动超时');
}

async function setNumberFilter(page, labelText, minValue, maxValue) {
  const result = await page.evaluate(({ text, minVal, maxVal }) => {
    const items = document.querySelectorAll('.el-form-item');
    for (const item of items) {
      const label = item.querySelector('.el-form-item__label');
      if (!label || label.textContent.trim() !== text) continue;

      const inputs = item.querySelectorAll('input[type="number"]');
      if (inputs.length < 2) {
        return { ok: false, reason: `Expected 2 number inputs for ${text}, found ${inputs.length}` };
      }

      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const values = [minVal, maxVal];
      inputs.forEach((input, index) => {
        const nextValue = values[index] === null || values[index] === undefined ? '' : String(values[index]);
        setter.call(input, nextValue);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      return {
        ok: true,
        values: Array.from(inputs).map(input => String(input.value || '').trim())
      };
    }
    return { ok: false, reason: `Filter label not found: ${text}` };
  }, { text: labelText, minVal: minValue, maxVal: maxValue });

  if (!result.ok) throw new Error(result.reason);
  return { label: labelText, min: result.values[0], max: result.values[1] };
}

async function setSelectFilter(page, labelText, optionText) {
  const opened = await page.evaluate((text) => {
    const items = document.querySelectorAll('.el-form-item');
    for (const item of items) {
      const label = item.querySelector('.el-form-item__label');
      if (label && label.textContent.trim() === text) {
        const select = item.querySelector('.el-select');
        if (!select) return { ok: false, reason: `Select not found for ${text}` };
        select.click();
        return { ok: true };
      }
    }
    return { ok: false, reason: `Filter label not found: ${text}` };
  }, labelText);

  if (!opened.ok) throw new Error(opened.reason);
  await sleep(800);

  const picked = await page.evaluate((expected) => {
    const items = Array.from(document.querySelectorAll('.el-select-dropdown__item'));
    const option = items.find(item => item.textContent.trim() === expected);
    if (!option) {
      return {
        ok: false,
        reason: `Option not found: ${expected}`,
        options: items.map(item => item.textContent.trim()).filter(Boolean)
      };
    }
    option.click();
    return { ok: true, text: option.textContent.trim() };
  }, optionText);

  if (!picked.ok) {
    throw new Error(`${picked.reason}. Available: ${(picked.options || []).join(', ')}`);
  }
  await sleep(500);

  const actual = await page.evaluate((text) => {
    const items = document.querySelectorAll('.el-form-item');
    for (const item of items) {
      const label = item.querySelector('.el-form-item__label');
      if (label && label.textContent.trim() === text) {
        return item.querySelector('input')?.value || '';
      }
    }
    return '';
  }, labelText);

  if (actual && actual !== optionText) {
    throw new Error(`${labelText} expected ${optionText}, got ${actual}`);
  }
  return { label: labelText, value: actual || optionText };
}

async function setFilters(page) {
  console.log('⚙️ 设置筛选条件...');
  const checks = {};
  checks.minSales = await setNumberFilter(page, '预估销量', FILTERS.minSales, null);
  console.log('  ✅ 预估销量 > 70');
  await sleep(200);
  checks.minRating = await setNumberFilter(page, '评分', FILTERS.minRating, null);
  console.log('  ✅ 评分 > 4');
  await sleep(200);
  checks.price = await setNumberFilter(page, 'Buybox价格', FILTERS.priceMin, FILTERS.priceMax);
  console.log(`  ✅ Buybox价格 $${FILTERS.priceMin}-$${FILTERS.priceMax}`);
  await sleep(200);
  checks.weight = await setNumberFilter(page, '重量', null, FILTERS.maxWeight);
  console.log(`  ✅ 重量 < ${FILTERS.maxWeight} 磅`);
  await sleep(200);
  checks.sellerType = await setSellerType(page);
  checks.listingDuration = await setListingDuration(page);
  checks.newReleasesTag = await setNewReleasesTag(page);
  await sleep(500);
  return checks;
}

async function setSellerType(page) {
  const result = await setSelectFilter(page, '卖家类型', FILTERS.sellerType);
  console.log(`  ✅ 卖家类型: ${result.value}`);
  return result;
}

async function setListingDuration(page) {
  const result = await setSelectFilter(page, '上架时长', FILTERS.listingDuration);
  console.log(`  ✅ 上架时长: ${result.value}`);
  return result;
}

async function setNewReleasesTag(page) {
  const result = await page.evaluate((tagName) => {
    const labels = document.querySelectorAll('label.el-checkbox');
    for (const label of labels) {
      const text = label.textContent.trim();
      if (!text.includes(tagName)) continue;
      const cb = label.querySelector('.el-checkbox__input');
      const checked = label.classList.contains('is-checked') || cb?.classList.contains('is-checked');
      if (cb && !checked) cb.click();
      return { ok: true, text, clicked: !checked };
    }
    return { ok: false, reason: `Tag not found: ${tagName}` };
  }, FILTERS.tag);

  if (!result.ok) throw new Error(result.reason);
  await sleep(300);

  const verify = await page.evaluate((tagName) => {
    const labels = document.querySelectorAll('label.el-checkbox');
    for (const label of labels) {
      if (!label.textContent.trim().includes(tagName)) continue;
      const cb = label.querySelector('.el-checkbox__input');
      return {
        ok: label.classList.contains('is-checked') || cb?.classList.contains('is-checked'),
        text: label.textContent.trim()
      };
    }
    return { ok: false, text: '' };
  }, FILTERS.tag);

  if (!verify.ok) throw new Error(`${FILTERS.tag} was not checked`);
  console.log(`  ✅ ${FILTERS.tag}`);
  return { label: '鸥鹭标签', value: verify.text };
}

async function selectCategory(page, categoryName) {
  console.log(`📂 选择类目: ${categoryName}`);
  await page.evaluate(() => { document.querySelector('.category-change .config')?.click(); });
  await sleep(4000);
  await page.waitForSelector('.el-dialog.is-align-center', { timeout: 10000 });
  await sleep(2000);

  await page.evaluate(() => {
    const d = document.querySelector('.el-dialog.is-align-center');
    const header = d?.querySelector('.right-title')?.textContent || '';
    if (!/已选（0）|已选\(0\)/.test(header)) d?.querySelector('.right-clear')?.click();
  });
  await sleep(500);

  const matched = await page.evaluate((name) => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const canonical = value => normalize(value)
      .replace(/\([^)]*\)/g, '')
      .replace(/\s+\d[\d,]*$/g, '')
      .toLowerCase();
    const d = document.querySelector('.el-dialog.is-align-center');
    if (!d) return { clicked: false, reason: 'category dialog not found', available: [] };

    const target = canonical(name);
    const itemElements = Array.from(d.querySelectorAll('.category-item'));
    const items = itemElements.map((item, index) => {
      const rawText = normalize(item.textContent);
      const englishName = normalize(rawText.replace(/\([^)]*\).*/, '').replace(/\s+\d[\d,]*$/g, ''));
      return { index, rawText, englishName, key: canonical(englishName) };
    }).filter(item => item.englishName);

    const exact = items.filter(item => item.key === target);
    if (exact.length !== 1) {
      return {
        clicked: false,
        reason: exact.length === 0 ? `no exact top-level category match for ${name}` : `ambiguous category match for ${name}`,
        available: items.map(item => item.englishName)
      };
    }

    const item = itemElements[exact[0].index];
    const cb = item?.querySelector('.el-checkbox__input');
    if (!cb) return { clicked: false, reason: `checkbox not found for ${exact[0].englishName}`, available: items.map(item => item.englishName) };
    if (!cb.classList.contains('is-checked')) cb.click();
    return {
      clicked: true,
      requested: name,
      text: exact[0].englishName,
      rawText: exact[0].rawText,
      available: items.map(item => item.englishName)
    };
  }, categoryName);

  if (!matched.clicked) {
    const available = (matched.available || []).slice(0, 30).join(', ');
    throw new Error(`${matched.reason}. Available top-level categories: ${available}`);
  }

  await sleep(1000);
  const confirmed = await page.evaluate(() => {
    const d = document.querySelector('.el-dialog.is-align-center');
    let clicked = false;
    d?.querySelectorAll('button').forEach(b => {
      if (b.textContent.trim() === '确认选择') {
        b.click();
        clicked = true;
      }
    });
    return { clicked };
  });

  if (!confirmed.clicked) throw new Error('Category confirm button not found');
  console.log(`  ✅ 类目: ${matched.text}`);
  await sleep(2000);
  return matched;
}

function pickSmallestCategory(avgBsr, topCategoryName) {
  if (!avgBsr || !Array.isArray(avgBsr)) return { path: '', matched: false };

  const withPath = avgBsr
    .map(c => ({
      path: c.fullPath || c.fullCategoryName || '',
      level: c.level || 0
    }))
    .filter(c => c.path);

  const matched = withPath.filter(c => categoryPathMatches(c.path, topCategoryName));
  const candidates = matched.length > 0 ? matched : withPath;
  candidates.sort((a, b) => b.level - a.level);

  return {
    path: candidates[0]?.path || '',
    matched: matched.length > 0
  };
}

function extractSmallestCategory(avgBsr, topCategoryName) {
  return pickSmallestCategory(avgBsr, topCategoryName).path;
}

function summarizeCategoryValidation(products) {
  const total = products.length;
  const matched = products.filter(p => p.categoryMatched).length;
  const unmatched = total - matched;
  const roots = {};
  for (const product of products) {
    const root = splitCategoryPath(product.smallestCategory)[0] || '(empty)';
    roots[root] = (roots[root] || 0) + 1;
  }
  return { total, matched, unmatched, roots };
}

// ── 主流程 ──
async function main() {
  console.log(`\n🚀 Oalur 新品关键词反推 - 数据抓取`);
  console.log(`📂 目标类目: ${category}`);
  console.log(`⚙️ 条件: 销量>${FILTERS.minSales}, 评分>${FILTERS.minRating}, 价格$${FILTERS.priceMin}-$${FILTERS.priceMax}, 重量<${FILTERS.maxWeight}磅, ${FILTERS.sellerType}, 上架${FILTERS.listingDuration}, ${FILTERS.tag}\n`);

  if (!await checkEdge()) await launchEdge();

  const browser = await puppeteer.connect({
    browserURL: CDP_URL,
    defaultViewport: null
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  try {
    // 拦截 XHR 捕获 API 返回
    await page.evaluateOnNewDocument(() => {
      const origXHR = window.XMLHttpRequest.prototype.open;
      window.__oalurApiData = null;
      window.XMLHttpRequest.prototype.open = function(method, url) {
        this.__oalurUrl = url;
        const self = this;
        this.addEventListener('load', function() {
          if (typeof url === 'string' && url.includes('period-search')) {
            try { window.__oalurApiData = JSON.parse(self.responseText); } catch(e) {}
          }
        });
        return origXHR.apply(this, [method, url]);
      };
    });

    console.log('📍 导航到 Oalur 筛选页...');
    await page.goto(OALUR_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(5000);

    const selectedCategory = await selectCategory(page, category);
    const filterChecks = await setFilters(page);

    console.log('🔍 点击确认查询...');
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(b => {
        if (b.textContent.trim() === '确认查询') b.click();
      });
    });
    await sleep(8000);

    // 读取首页 API 数据
    let apiData = await page.evaluate(() => window.__oalurApiData);
    const totalCount = apiData?.data?.total || 0;
    const totalPages = Math.min(Math.ceil(totalCount / PAGE_SIZE), MAX_PAGES);
    const overLimit = Math.ceil(totalCount / PAGE_SIZE) > MAX_PAGES;

    console.log(`\n📊 查询结果: 共 ${totalCount.toLocaleString()} 条, ${Math.ceil(totalCount / PAGE_SIZE)} 页`);
    if (totalCount === 0) { console.log('❌ 查询结果为空'); await browser.disconnect(); return; }
    if (overLimit) console.log(`⚠️ 超过 ${MAX_PAGES} 页限制，仅抓取前 ${MAX_PAGES} 页`);

    // 提取数据（使用 API 返回的完整数据）
    const allProducts = [];

    function processApiRecords(records) {
      return records.map(r => {
        const categoryInfo = pickSmallestCategory(r.avgBsr, category);
        return {
          asin: r.asin,
          title: r.title,
          smallestCategory: categoryInfo.path,
          categoryMatched: categoryInfo.matched
        };
      }).filter(p => p.asin);
    }

    function countUniqueProducts(list) {
      return new Set(list.map(p => p.asin).filter(Boolean)).size;
    }

    // 首页
    if (apiData?.data?.records) {
      allProducts.push(...processApiRecords(apiData.data.records));
    }
    console.log(`  📄 第 1/${totalPages} 页 (API)`);

    // 翻页
    for (let pn = 2; pn <= totalPages; pn++) {
      if (productLimit && countUniqueProducts(allProducts) >= productLimit) break;
      // 重置捕获
      await page.evaluate(() => { window.__oalurApiData = null; });

      // 点击下一页
      const clicked = await page.evaluate((cp) => {
        const items = document.querySelectorAll('.el-pager li.number');
        for (const item of items) {
          if (parseInt(item.textContent.trim()) === cp) { item.click(); return true; }
        }
        return false;
      }, pn);
      if (!clicked) { console.log(`  ⚠️ 翻页 ${pn} 失败`); break; }

      // 等待 API 返回
      for (let w = 0; w < 20; w++) {
        await sleep(500);
        apiData = await page.evaluate(() => window.__oalurApiData);
        if (apiData?.data?.records) break;
      }

      if (apiData?.data?.records) {
        allProducts.push(...processApiRecords(apiData.data.records));
        console.log(`  📄 第 ${pn}/${totalPages} 页`);
      } else {
        console.log(`  ⚠️ 第 ${pn} 页无 API 数据`);
      }
      await sleep(500);
    }

    // 去重
    const seen = new Set();
    const unique = [];
    for (const p of allProducts) {
      if (!seen.has(p.asin)) { seen.add(p.asin); unique.push(p); }
    }
    const outputProducts = productLimit ? unique.slice(0, productLimit) : unique;
    const categoryValidation = summarizeCategoryValidation(outputProducts);
    const maxAllowedUnmatched = Math.max(5, Math.ceil(categoryValidation.total * 0.15));

    console.log(`\n📂 类目校验: ${categoryValidation.matched}/${categoryValidation.total} 匹配 ${category}`);
    if (categoryValidation.unmatched > maxAllowedUnmatched) {
      const roots = Object.entries(categoryValidation.roots)
        .sort((a, b) => b[1] - a[1])
        .map(([root, count]) => `${root}:${count}`)
        .join(', ');
      throw new Error(`类目校验失败: ${categoryValidation.unmatched}/${categoryValidation.total} 产品不属于 ${category}. Roots: ${roots}`);
    }

    fs.mkdirSync(dataDir, { recursive: true });
    const outputFile = path.join(dataDir, 'products.json');
    fs.writeFileSync(outputFile, JSON.stringify({
      category,
      selectedCategory,
      filters: FILTERS,
      filterChecks,
      categoryValidation,
      extractTime: new Date().toISOString(),
      totalCount, productCount: outputProducts.length, overLimit,
      productLimit,
      products: outputProducts
    }, null, 2), 'utf-8');

    console.log(`\n✅ 完成! 抓取 ${unique.length} 个产品`);
    console.log(`📁 ${outputFile}`);
    if (overLimit) console.log(`\n⚠️ 数据超 ${MAX_PAGES} 页，请缩小类目范围`);

  } finally {
    await page.close().catch(() => {});
    await browser.disconnect();
  }
}

main().catch(err => { console.error('❌ 执行失败:', err.message); process.exit(1); });
