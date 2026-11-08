# Readnote Atlas

[English](README.md)

**我做 Readnote Atlas，是为了帮助中文母语者更好地理解英文世界，从文本到视频。**

我希望英文原文始终在眼前，同时给我需要的中文语境。遇到真正值得记住的内容时，我可以保存原文段落、视频时间戳或自己的想法，再把它们慢慢沉淀成属于自己的 Obsidian 或 Notion 知识库。

> 翻译只是阅读辅助，不是终点。

[让 agent 帮我安装](#让你的-agent-帮你安装) · [Atlas 能做什么](#atlas-能做什么) · [第一次使用](#我的第一次使用) · [悬浮字幕](#边听边工作) · [隐私](PRIVACY.md)

## 让你的 agent 帮你安装

我可以把下面这段 prompt 交给 Codex、Claude Code 或其他能操作终端的 coding agent，并附上这个仓库 URL。agent 会在本地完成 clone、安装依赖、构建和检查；如果它能控制 Chrome，也可以直接加载扩展。

```text
请从这个仓库帮我完整安装 Readnote Atlas：
https://github.com/pheobepotato/readnote-atlas

请按下面流程执行：
1. 在我的 workspace clone 仓库；如果已经存在，就先检查并更新它。
2. 运行 npm install 安装依赖。
3. 运行 npm run check，确认构建、类型检查、测试和发布审计通过。
4. 把包含 manifest.json 的仓库目录作为 unpacked Chrome extension 加载。
5. 打开 Readnote Atlas settings，告诉我 YouTube 字幕和 AI 翻译分别需要哪些 API Key。
6. 加载完成后刷新已经打开的 YouTube 和文章标签页。

不要把 API Key 写入源代码、日志、截图或 commit，也不要改变产品行为。最后告诉我：本地路径、扩展 ID、检查结果，以及仍然需要我手动确认的步骤。
```

如果 agent 不能直接操作 Chrome，它只需要把本地构建完成，并告诉我最后一步：打开 `chrome://extensions`，开启“开发者模式”，选择“加载已解压的扩展程序”，然后选中包含 `manifest.json` 的目录。

淡色 **T** 入口位于页面右侧中下部。点击 **T** 开启翻译，处理中显示 **…**，显示译文时为 **✓**；再次点击仅隐藏译文，高亮、笔记和翻译缓存均保留。旁边的 **⋯** 菜单提供补译和明确范围的批注删除操作，周围空白区域不影响网页操作。

## Atlas 能做什么

### 阅读文章

我打开英文文章，原页面保持不变。Atlas 帮我渐进翻译可读段落、标记重要句子、添加批注，并保存带来源的摘录。

### 学习视频

我打开英文 YouTube 访谈、课程或对话。Atlas 在播放器画面内居中显示英文与简体中文字幕；侧边栏从中文 Overview 开始，并提供完整、可选择的段落 transcript。

视频体验围绕我正在看的那一刻设计：

- 翻译会提前准备，让当前字幕更快出现；
- 跳到视频中段后，新的播放位置会优先处理；
- 字幕框可以拖动和缩放，文字会随着空间自然重排；
- 侧边栏按 **Overview → Notes → Transcript → Library** 展开，查找路径很清楚。

### 留下笔记

我可以在精彩时刻点击小书签，选中 transcript 段落，或者直接写下自己的想法。每条笔记都会保留时间戳和来源，以后可以回到准确上下文。笔记先保存在本地，也可以同步到 Obsidian 或 Notion。

视频累计真实前台播放 10 分钟后，会进入 Watched Library，方便我回顾真正花时间学习过的内容。

### 边听边工作

在 macOS 上，我可以运行可选的桌面字幕助手。YouTube 继续播放时，即使我切换标签、打开其他 App 或最小化 Chrome，Atlas 也会在工作内容上方显示一个紧凑的半透明字幕框。回到 YouTube 后它会隐藏；鼠标移入可以看到播放、前后 15 秒和书签控制。

```bash
npm run desktop:captions -- --extension-id=YOUR_READNOTE_ATLAS_ID
```

在 `chrome://extensions` 取得 Atlas 的扩展 ID，首次配对后，之后运行 `npm run desktop:captions` 即可。macOS 要求和排错方式见[桌面字幕说明](scripts/desktop-captions/README.md)。

## 我的第一次使用

1. 我打开一个带原生字幕的英文 YouTube 视频并播放。Atlas 开始准备 transcript、翻译和 Overview。
2. 我直接阅读播放器上的双语字幕，再打开 Atlas 查看中文 Overview。
3. 遇到值得留下的时刻，我点击书签；也可以进入 **Notes** 写下个人感想。
4. 我打开 **Transcript**，搜索、选中并保存有意义的段落。时间戳让我随时回到视频原处。
5. 之后从 **Library** 回看累计前台播放满 10 分钟的视频。

阅读文章时，我选中一段文字，再选择高亮、下划线、批注或保存，把当下的理解留下来。

## 使用这些功能需要什么

安装命令可以交给 agent 执行。Atlas 在我启用对应功能时会连接这些服务：

- Chrome 116+ 和 Node.js 22.19+；
- 用于获取 YouTube 原生 transcript 的 Supadata API Key；
- 一个视频 AI provider 的 API Key，例如 DeepSeek、OpenAI、Google Gemini、OpenRouter 或自定义 OpenAI-compatible endpoint；
- 用于文章翻译和 Obsidian/Notion 同步的本地 companion，地址是 `127.0.0.1:8791`；
- 用于桌面字幕的 macOS、Node.js 和 Apple Command Line Tools（`swiftc`）。

服务商可能按用量收费，我会在账户里设置额度。新视频或未缓存位置的翻译仍可能需要片刻；Atlas 会提前翻译并缓存，尽量让播放保持流畅。

<details>
<summary>本地命令</summary>

```bash
npm run build              # 构建文章阅读层
npm test                   # 运行产品与单元测试
npm run typecheck          # 检查 TypeScript
npm run check              # 构建、类型检查、测试并审计发布文件
npm run package            # 生成 dist/readnote-atlas-v0.3.3.zip
npm run companion          # 启动文章翻译和知识库同步
npm run desktop:captions   # 启动可选的 macOS 字幕助手
```

需要文章翻译或知识库同步时，运行 `npm run companion`，然后打开 `http://127.0.0.1:8791/setup`，按需配置 provider 和目标笔记。敏感配置保存在被 Git 忽略的 `.env.local` 中。

</details>

<details>
<summary>我可能会遇到的问题</summary>

**为什么视频没有翻译？** 视频需要原生 YouTube 字幕、Supadata Key 和已配置的视频 AI provider。本版本暂不支持 Shorts、直播、私密视频和没有原生字幕的视频。

**我的数据在哪里？** 笔记、transcript、缓存、设置和观看进度保存在 Chrome 本地。YouTube 加载后可能开始获取字幕、预翻译和生成 Overview；Supadata 会收到视频 URL，选用的 AI provider 会收到当前操作需要的 transcript 文本或上下文。

**为什么翻译有时还要等？** Atlas 会提前翻译、缓存，并在跳播后优先追赶当前字幕。但新视频、未缓存位置、服务限流或网络延迟仍可能产生等待。

**以后怎么更新？** 在本地仓库运行 `git pull --ff-only`、`npm install` 和 `npm run build`，然后在 `chrome://extensions` 重新加载 Atlas，刷新已经打开的页面。桌面字幕代码有变化时，也要重启 helper。

</details>

## 为什么做 Atlas

我做 Readnote 时最在意的，不是把一篇文章翻译完，而是在理解一个观点之后，能够把自己的想法和来源一起留下。访谈、课程和长对话也应该拥有同样的路径。Atlas 把文本和视频放进一个连续的学习过程：

`原始内容 → 双语理解 → 精确选择 → 个人笔记 → Obsidian / Notion`

原文始终是主角。英文保留细节，中文降低理解门槛，笔记让来源可以被重新找回。整个界面遵循 Readnote 的设计语言：安静、直接，让我持续学习，而不是只收集翻译。

## 项目来源与致谢

Readnote Atlas 是一个独立项目，建立在两个基础之上：

- [Readnote](https://github.com/pheobepotato/readnote)：由本项目作者创建，确立了原始内容优先、本地批注和 Obsidian/Notion 知识工作流；
- [YouTube Digest v1.2.0](https://github.com/zarazhangrui/youtube-digest/releases/tag/v1.2.0)：由 **Zara Zhang** 创建，为 transcript 获取、双语视频学习、时间戳导航、解释和视频笔记提供开源基础与灵感。Atlas 视频工作流的部分代码在其 MIT License 下衍生，并进行了实质性的重新设计。

Readnote Atlas 不是 YouTube Digest 的官方版本，也不代表 Zara Zhang 的认可或背书。原始声明保留在 [LICENSE](LICENSE)，项目关系记录在 [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md)。

## 隐私与许可

完整数据流见 [PRIVACY.md](PRIVACY.md)。本项目采用 [MIT License](LICENSE) 开源。
