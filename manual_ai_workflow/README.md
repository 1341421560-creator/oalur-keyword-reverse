# 半自动 Codex 复核流程

这个目录只描述当前有效的半自动方案：JS 负责反查和选词，Codex 负责独立判断产品主体，并把结果与 JS 当前关键词做比对。

## 输入文件

```text
output/<task>/data/keyword-candidates.json
output/<task>/data/keywords.json
```

- `keyword-candidates.json`：原始候选词上下文，包含 `title`、`category`、`categories`、`defaultTop10`、`volumeTop10`、`mergedCandidates`。
- `keywords.json`：JS 当前选词结果，包含 `asin`、`category`、`categories`、`keyword`、`matchType`、`score`。

## Codex 判断顺序

1. 先读取 `keyword-candidates.json`，根据标题、类目路径和候选词上下文独立判断产品主体 `productBody`。
2. 再读取 `keywords.json` 中同 ASIN 的 JS 当前结果。
3. 判断 `productBody` 是否与 JS `keyword` 语义一致。
4. 写入 `local-agent-analysis.json` 和 `local-agent-product-body.json`。

## local-agent-analysis.json 要求

每个产品至少保留：

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

`sameAsCurrentKeyword` 必须保留，因为报告阶段用它生成：

```text
data/keywords-agent-same.json
data/keywords-agent-diff.json
data/keywords-agent-non-exact.json
data/keywords-agent-unreviewed.json
```

## 报告生成

```bash
node generate-report.js output/<task>/data/keywords.json output
```

报告脚本不会调用旧规则脚本。没有 `local-agent-analysis.json` 或某个 ASIN 缺少 Codex 复核时，exact 产品不会进入 same，会单独进入 `keywords-agent-unreviewed.json`，并标记为 `missing_codex_local_agent_analysis`。

## 类目词表

JS 选词仍然使用离线词表，不联网扩展规则。核心产品头词按输入类目加载：

```text
config/product-head-words/home-and-kitchen.json
config/product-head-words/kitchen-and-dining.json
```

新增类目时，把该类目的核心产品词写入 `config/product-head-words/<category-slug>.json`。如果类目文件不存在，脚本会回退到 `config/product-head-words.json`。

