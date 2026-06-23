# oalur-keyword-reverse Skill

## 功能

输入一个 Oalur/Amazon 类目，抓取符合筛选条件的新品 ASIN，再到 Oalur ASIN 关键词页反查候选关键词。JS 打分系统独立选择当前关键词；Codex 本地 agent 再独立判断产品主体，并只在最终输出中与 JS 结果做一致性比对。

## 默认参数

- 输入类目：用户传入，例如 `Kitchen & Dining`。
- 默认价格：`10-20`，可通过 `extract.js` 第 3、4 个参数覆盖。
- 默认反查并发：`10` 个页面。
- 默认反查范围：全量 ASIN。
- 默认报告范围：前 `30` 个 ASIN。
- 输出目录：`output/<抓取日期>_<输入类目slug>_price-<min>-<max>/`。
- 示例：`output/2026-06-22_Kitchen-and-Dining_price-10-20/`。

## 运行环境

- 需要已登录 Oalur 的 Edge 浏览器。
- 浏览器需要通过 CDP 端口 `9222` 启动。
- 依赖：`puppeteer-core`。
- 默认不需要 OpenAI API Key；Codex 本地 agent 复核由当前 Codex 执行。

检查 Edge 端口：

```powershell
Test-NetConnection -ComputerName localhost -Port 9222 -InformationLevel Quiet
```

如未启动：

```powershell
Start-Process msedge -ArgumentList "--remote-debugging-port=9222","--no-first-run"
```

## 完整流程

### 1. 抓取产品

```bash
node extract.js "Kitchen & Dining" output
node extract.js "Kitchen & Dining" output 7 50
```

输出：

```text
output/<date>_<categorySlug>_price-<min>-<max>/data/products.json
```

筛选条件：销量 > 70、评分 > 4、默认价格 10-20、重量 < 11 磅、第三方卖家、近 3 个月、New Releases Top100。

### 2. 反查关键词

```bash
node fetch-keywords.js output/<task>/data/products.json output
```

只跑前 30 个 ASIN、10 页面并发：

```bash
node fetch-keywords.js output/<task>/data/products.json output 30 10
```

反查流程：

1. 每个 ASIN 打开 Oalur ASIN keyword 页面。
2. 采集默认排序 Top10。
3. 按月搜索量降序采集 Top10。
4. 合并去重，最多约 20 个候选词。
5. JS 基于候选词、标题、类目路径、本地词表做打分，选出当前关键词。
6. 同时抓取产品信息页完整品类路径；少于 3 级的路径不写入参考路径。

输出：

```text
data/keyword-candidates.json
data/keywords.json
data/keywords-agent-same.json
data/keywords-agent-diff.json
data/keywords-agent-non-exact.json
data/keywords-agent-unreviewed.json
```

`keyword-candidates.json` 是原始候选词数据，不保存 JS 最终评分细节：

```json
{
  "asin": "B0XXXX",
  "title": "product title",
  "category": "full category path",
  "categories": ["full category path"],
  "defaultTop10": [],
  "volumeTop10": [],
  "mergedCandidates": []
}
```

`keywords.json` 是 JS 选词结果，产品项保持精简：

```json
{
  "asin": "B0XXXX",
  "category": "full category path",
  "categories": ["full category path"],
  "keyword": "drink dispenser",
  "matchType": "exact",
  "hasExactMatch": true,
  "score": 27.5
}
```

### 3. 离线重排

如果只修改 JS 选词规则，不重新打开网页：

```bash
node fetch-keywords.js output/<task>/data/keyword-candidates.json output --rank-from-candidates
```

该模式只读取 `keyword-candidates.json`，重新生成 `keywords.json` 和初始 split JSON，不采集网页数据。

### 4. Codex 本地 agent 语义复核

Codex 本地 agent 默认参与完整流程，但不影响 JS 打分。

输入：

```text
data/keyword-candidates.json
data/keywords.json
```

判断顺序固定：

1. Codex 先只根据抓取上下文判断产品主体：`title`、`category`、`categories`、`defaultTop10`、`volumeTop10`、`mergedCandidates`。
2. Codex 得出自己的 `productBody`。
3. Codex 再读取 JS 当前结果：`currentKeyword`、`currentMatchType`、`currentScore`。
4. Codex 判断 `productBody` 与 JS 当前关键词是否语义一致。
5. Codex 写入 `local-agent-analysis.json` 和 `local-agent-product-body.json`。

`local-agent-analysis.json` 必须保留 `sameAsCurrentKeyword`：

```json
{
  "asin": "B0XXXX",
  "productBody": "drink dispenser",
  "currentKeyword": "3 gallon drink dispenser",
  "currentMatchType": "exact",
  "currentScore": 27.5,
  "sameAsCurrentKeyword": false,
  "confidence": 0.9,
  "reason": "3 gallon is a capacity spec; product body is drink dispenser."
}
```

规则：

- JS 和 Codex 独立。
- Codex 不改写 `keywords.json`。
- `sameAsCurrentKeyword` 是后续 same/diff JSON 的依据。
- 如果 JS 关键词带规格、容量、尺寸、颜色等属性词，而去掉属性后仍是明确产品主体，Codex 应优先输出剥离属性后的产品主体，例如 `3 gallon drink dispenser` -> `drink dispenser`。

### 5. 生成 split JSON 和报告

```bash
node generate-report.js output/<task>/data/keywords.json output
```

报告生成前会写入/覆盖：

```text
data/keywords-agent-same.json
data/keywords-agent-diff.json
data/keywords-agent-non-exact.json
data/keywords-agent-unreviewed.json
```

分流规则：

- `matchType === "exact"` 且 `sameAsCurrentKeyword === true`：进入 `keywords-agent-same.json`。
- `matchType === "exact"` 且 `sameAsCurrentKeyword === false`：进入 `keywords-agent-diff.json`，`keyword` 字段为 `[JS关键词, Codex产品主体]`。
- `matchType !== "exact"`：只进入 `keywords-agent-non-exact.json`，不进入 same/diff。
- 如果没有 `local-agent-analysis.json` 或某个 ASIN 缺少 Codex 复核：`exact` 不进入 same，单独进入 `keywords-agent-unreviewed.json`，并标记 `reviewStatus: "missing_codex_local_agent_analysis"`。

报告输出：

```text
reports/YYYY-MM-DD_<输入类目>_关键词反推.html
reports/YYYY-MM-DD_<输入类目>_local-agent-30.html
```

报告中的过滤关键词只展示重新计算后得分较高的前三个候选词。

## JS 选词逻辑

JS 从 `mergedCandidates` 中选词：

1. 找标题中完整包含的 `exact` 候选词。
2. 多个 exact 时进行精排，不直接取搜索量最大。
3. 精排考虑标题完整短语命中、有效词匹配率、词序、类目路径命中、候选词类型、来源排序、搜索量弱加权、品牌/规格/材质/场景词降权。
4. 如果 exact 候选词是规格前缀，且存在干净的核心产品词，规格词强降权，例如 `3 gallon drink dispenser` 优先输给 `drink dispenser`。
5. 没有 exact 时，按分词匹配得分选择 `word_split` 或 `partial`。
6. 仍无法匹配时，使用 `fallback_top1`。

## 本地词表

词表在 `config/` 下，离线使用，不联网搜索：

```text
config/brand-words.json
config/use-case-words.json
config/material-words.json
config/spec-words.json
config/scene-words.json
config/ingredient-words.json
config/event-words.json
config/product-head-words/<category-slug>.json
config/product-head-words.json
config/stop-words.json
config/generic-single-words.json
```

核心产品头词按输入类目加载：`Home & Kitchen` 对应 `config/product-head-words/home-and-kitchen.json`，`Kitchen & Dining` 对应 `config/product-head-words/kitchen-and-dining.json`。如果类目专属文件不存在，脚本会回退到旧的 `config/product-head-words.json`，并在运行日志中提示 fallback。

更新方式：直接编辑对应 JSON 数组，保持小写字符串。新增类目时，按输入类目生成小写短横线文件名，例如 `Pet Supplies` -> `config/product-head-words/pet-supplies.json`。

## 验证

```bash
node --check extract.js
node --check fetch-keywords.js
node --check generate-report.js
```
