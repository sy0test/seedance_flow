---
name: seedance-prompts-template
description: Seedance 2.0 提示词产出模板。输出 XML 格式，包含素材对应表和各剧情点的 Seedance 提示词。
---

# Seedance 2.0 提示词产出模板

所有剧情点输出完毕后，**统一使用 XML 容器标签包裹所有条目**。不再输出 Markdown 格式。

---

## @引用语法

使用 Seedance 2.0 原生 @引用语法：
- @图片1、@图片2... → 参考图片（人物/场景参考）
- @视频1、@视频2... → 参考视频
- @音频1、@音频2... → 参考音频
- 编号与文档头部素材对应表一一对应

---

## 输出格式（唯一格式）

```xml
<references>
<reference ref="@图1" name="林薇" type="人物参考" />
<reference ref="@图2" name="办公室" type="场景参考" />
</references>

<shots>
<shot id="P01" duration="8" characters="林薇@图1,夜（黑豹）" scenes="王国大厅@图3">以 @图片1 的林薇为主角...完整的提示词内容</shot>
<shot id="P02" duration="5" characters="母亲@图1" scenes="庄园主厅@图4">完整的提示词内容</shot>
</shots>
```

注意：
1. 这是唯一输出格式，**不要输出 Markdown 表格或标题**。
2. duration 属性填充该剧情点的建议时长（5/8/10/15 秒）。Seedance 2.0 最长生成时长为 15 秒，duration 不得超过 15。

---

## 输出规范

- 使用与剧本原文相同的语言，勿擅自翻译
- 提示词采用叙事描述式，不要用关键词堆叠式
- 直接输出完整提示词，不要逐条解释设计理由
- 每条提示词必须完整可用，用户可以直接复制到 Seedance 2.0 生成视频
