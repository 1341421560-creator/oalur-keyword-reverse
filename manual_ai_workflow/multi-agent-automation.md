# 多 agent 自动化方案

当前方案只基于 `keyword-candidates.json` 和 `keywords.json`。

## 分工

- 采集/JS 选词 agent：运行 `extract.js` 和 `fetch-keywords.js`，生成候选词和 JS 结果。
- Codex 语义复核 agent：读取候选词上下文，独立判断产品主体，再与 JS 当前关键词比对。
- 报告 agent：运行 `generate-report.js`，生成 same/diff/non-exact/unreviewed JSON 和 HTML 报告。

## 输入

```text
output/<task>/data/keyword-candidates.json
output/<task>/data/keywords.json
```

## Codex 分片输出

如果多个 agent 并行复核，可以先写：

```text
output/<task>/data/local-agent-analysis-part-1.json
output/<task>/data/local-agent-analysis-part-2.json
output/<task>/data/local-agent-analysis-part-3.json
```

合并后必须得到：

```text
output/<task>/data/local-agent-analysis.json
```

每个 ASIN 必须包含 `sameAsCurrentKeyword`。

## 最终输出

```text
output/<task>/data/keywords-agent-same.json
output/<task>/data/keywords-agent-diff.json
output/<task>/data/keywords-agent-non-exact.json
output/<task>/data/keywords-agent-unreviewed.json
output/<task>/reports/YYYY-MM-DD_<category>_关键词反推.html
output/<task>/reports/YYYY-MM-DD_<category>_local-agent-30.html
```

缺少 Codex 复核的 exact 产品必须进入 `keywords-agent-unreviewed.json`，不能进入 same。
