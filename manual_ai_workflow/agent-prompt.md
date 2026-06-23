# Codex 本地 agent 提示词

请读取：

```text
output/<task>/data/keyword-candidates.json
output/<task>/data/keywords.json
```

你的任务不是重新给候选词打分，而是独立判断每个 ASIN 的产品主体，然后与 JS 当前关键词做语义比对。

## 判断步骤

1. 先看 `keyword-candidates.json` 中的 `title`、`category`、`categories`、`defaultTop10`、`volumeTop10`、`mergedCandidates`。
2. 独立输出该 ASIN 的 `productBody`。
3. 再读取 `keywords.json` 中同 ASIN 的 `keyword`、`matchType`、`score`。
4. 判断 `productBody` 和 JS `keyword` 是否语义一致。
5. 写入 `sameAsCurrentKeyword`。

## 输出文件

```text
output/<task>/data/local-agent-analysis.json
output/<task>/data/local-agent-product-body.json
```

## 输出结构

```json
{
  "mode": "codex_local_agent_analysis",
  "products": [
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
  ]
}
```

## 判断规则

- 不改写 JS 的 `keywords.json`。
- `matchType !== "exact"` 的产品后续会单独进入 non-exact，不要强行归入 same/diff。
- 如果 JS 关键词包含容量、尺寸、颜色、数量等属性前缀，且剥离后仍是明确产品主体，应把 `productBody` 写成剥离后的核心产品词。
- 例如：`3 gallon drink dispenser` 的产品主体通常是 `drink dispenser`。
