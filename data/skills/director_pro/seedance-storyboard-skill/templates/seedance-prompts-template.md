---
name: seedance-prompts-template
description: Seedance 2.0 提示词产出模板。纯 XML 输出，包含角色/场景/道具引用。
---

# Seedance 2.0 提示词产出模板

所有剧情点输出完毕后，**统一使用 XML 容器标签包裹所有条目**。

---

## 输出格式（唯一格式）

```xml
<references>
<reference ref="@图1" name="林薇" type="人物参考" />
<reference ref="@图2" name="办公室" type="场景参考" />
<reference ref="@图3" name="长剑" type="道具参考" />
</references>

<shots>
<shot id="P01" duration="8" characters="林薇@图1,夜（黑豹）" scenes="王国大厅@图2" props="长剑@图3">[完整的 Seedance 2.0 提示词内容]</shot>
</shots>
```

**注意：这是唯一输出格式，不要输出 Markdown 标题或表格。** 每个 `<shot>` 标签包含一个完整的剧情点提示词。`characters` 属性列出出场角色及 @引用，`scenes` 列出场景引用，`props` 列出道具引用。duration 最长 15 秒。

---

## 输出规范

- 使用与剧本原文相同的语言，勿擅自翻译
- 提示词采用叙事描述式，不要用关键词堆叠式
- 每条提示词必须完整可用，用户可以直接复制到 Seedance 2.0 生成视频
- 提示词正文中角色/场景/道具名称用 @图N 替代
