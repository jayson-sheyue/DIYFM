# Google API 与静态部署依据

核实日期：2026-11-06。公共版使用 Gemini Developer API，不使用 Vertex / Cloud TTS 的 ADC 路径。默认模型来自对应官方目录；模型是否对某个 Key 开放仍需由账户实际权限确认。

| 功能 | 实际集成 | 官方文档 |
| --- | --- | --- |
| API Key | HTTPS `x-goog-api-key` 请求头；只发往 `generativelanguage.googleapis.com` | [Key 管理与保护](https://ai.google.dev/gemini-api/docs/api-key) |
| 文本 | `POST /v1beta/models/{model}:generateContent`；JSON 输出，不使用过时采样参数 | [生成接口](https://ai.google.dev/api/generate-content)、[Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/latest-model) |
| 背景核查 | 同一生成接口，`tools: [{googleSearch: {}}]`；只保存实际 `groundingMetadata` 中的 HTTPS 来源 | [Google Search grounding](https://ai.google.dev/gemini-api/docs/google-search) |
| 双人语音 | `responseModalities: [AUDIO]`，`speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs`，Host / Guest 对应两位所选声线 | [TTS](https://ai.google.dev/gemini-api/docs/speech-generation)、[3.1 Flash TTS](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-tts-preview) |
| 音乐 | `POST /v1beta/interactions`；`model`, `input`, `store: false`；从 `steps[].content[]` 的 audio block 读取 Base64 音频 | [音乐生成](https://ai.google.dev/gemini-api/docs/music-generation)、[Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview) |
| Key 检查 | `GET /v1beta/models/{文本模型}`，不发起内容生成 | [Models API](https://ai.google.dev/api/models) |
| 静态托管 | GitHub Actions 检查、构建、上传 Pages artifact、部署；不注入 Gemini Secret | [创建 Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)、[自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) |

文本与 TTS 保留官方支持的 `generateContent` 路径。Lyria 使用官方当前 Interactions 音乐接口；没有把旧 Vertex `predict` 请求直接加上 Key 冒充兼容。

Gemini 3.1 TTS 通常返回单声道 24kHz、16-bit PCM；程序读取 MIME 中的采样率并封装 WAV，也支持有 WAV 头或浏览器可解码的音频。多段语音在浏览器中拼接，底乐解码后按小音量循环混入。MP3 编码使用本地 Worker，不上传音频给额外服务。

每次任务使用启动时的模型与内存凭据快照；只有非秘密的模型配置进入节目记录。模型访问失败、限额或 429 不自动无限重试，也不切换其他模型。音乐失败保留人声结果；内容未通过检查或语音不完整时保留失败状态及进度。

最新费用与地区 / 账户限制请查看 [Google 定价](https://ai.google.dev/gemini-api/docs/pricing) 和 [支持地区](https://ai.google.dev/gemini-api/docs/available-regions)。不承诺 GitHub 免费托管等于免费生成。
