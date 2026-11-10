# DIYFM v2.3.0 验证记录

日期：2026-11-06。目标产物：GitHub Pages 项目子路径下的纯静态站点，每位使用者自带 API Key。旧 Python 后端仅保留兼容和迁移用途。

## 验收范围

- 没有 Python API 时也能打开主页、设置、创建和保存频道、读取与播放已保存音频。
- Key 启用、替换、清除，只在本页内存保留；普通状态、IndexedDB、备份和发布产物不包含 Key。
- 编排保持独立虚构来信、按需核查、目标语和难度约束、结构检查与最多一次审稿修订。
- 声线、底乐、首次配置快照、播放、暂停、倍速、单曲 / 连播、MP3、删除和备份导入形成完整流程。
- 失败记录留在消息中，重试复用已完成内容；停止或换页不会被旧音频回调抢播。
- 支持现代 Chrome、Edge、Firefox、Safari 所需的 ES modules、IndexedDB、Web Audio、Worker；实际人工浏览器验收范围单独列出，未验收的浏览器不冒充已验证。

## 可重复执行

```bash
npm ci --ignore-scripts
npm run vendor
npm test
npm run build

# 原 Python 环境可额外执行：
./scripts/check.sh
```

静态版自动检查覆盖：固定 Google 请求来源、Key 仅进请求头、错误正文脱敏、Key 清除与刷新、真实 IndexedDB 事务的受控替代、参数快照、幂等提交、失败后复用已检查台本、音频文件与进度清理、ZIP 合并与失败原子性、PCM / WAV、事实来源、语言与表达检查，以及原有播放竞态和循环模式。

音频测试使用明确标注的短静音 WAV，文本 / 语音 / 音乐服务使用受控返回验证请求与保存契约，不冒充真实 Google 账户联调。Key 保密测试使用无效的合成测试字符串，不包含真实凭据。

发布检查：`static/` 白名单构建到 `dist/`，不复制本机 `data/`、环境文件、日志、旧成片和私人验收截图；凭据模式检查扫描整个产物。GitHub Actions 使用相同 npm 检查与构建入口。

## 真实服务边界

本次尚未收到使用者的真实 AI Studio Key，不从聊天收集 Key。Google 文本、Search、TTS、Lyria 的成功调用与教学效果不能仅凭受控测试声明通过；公开页面可由使用者自行填写 Key 后验证。旧版 ADC 的成功调用不算新版 Key 接口成功。

需要分别验证：Key 检查、一次英语完整制作、一次日语完整制作、一次涉及真实背景的 Search、Lyria 音乐、Key 对应账户的地区与费用限制。模型是否开放、额度和网络状况以使用者账户为准。

## 浏览器与发布记录

- 本机快速检查：38 个 Python、44 个 Node 测试通过，语法 / 编译检查通过，静态产物凭据模式检查通过。
- Key 格式回归：合成的 `AQ.` 授权 Key 可启用，含句点与超过旧 256 字符上限的字符串可原样进入请求头；换行、网址和超限输入被拒绝且不覆盖原 Key。不根据前缀切换到 Vertex，也不使用真实 Key 联调来冒充格式测试。
- Chrome 内核内嵌浏览器：在只有静态 HTTP 文件服务的 `/DIYFM/` 子路径验收，主页与设置可用。未填 Key 时会引导到设置并保留愿望；使用合成无效 Key 只测试本地启用状态，启用后输入框清空，刷新后显示未填写。
- ZIP：通过真实文件选择器导入两段明确标注的 4 秒静音 WAV，频道和台本显示正常。
- MP3：实际浏览器 Worker 下载后，用 FFmpeg 解码检查有效性；此处不是假下载或仅断言按钮存在。
- 播放：导入的静音成片通过 `blob:` 音频源实际进入播放状态，浏览器读取时长为 4 秒；停止按钮可以结束播放。
- 窄屏：390 × 844 的设置页正常换行，页面宽度与视口均为 390，没有横向溢出。
- 预览浏览器控制台未发现 error / warn；没有把本机成片发布为公共示例。
- 本机旧库：重启更新后的本机入口，实际复制显示 3 个频道、4 集已完成节目；未删除旧 `data/` 文件，未将其上传。
- 公开发布：仓库 `jayson-sheyue/DIYFM` 已确认为 public。首次 [Actions 构建与部署](https://github.com/jayson-sheyue/DIYFM/actions/runs/42174041618) 成功，静态产物通过检查；[HTTPS 站点](https://jayson-sheyue.github.io/DIYFM/) 实际返回 HTTP 200。
- 线上浏览器：从空节目库打开公开站点，主页和 Key 设置正常，控制台无 error / warn。没有使用本机后端或共享 Key。

Firefox / Safari 独立系统浏览器、长期容量和真实 Google Key 成功调用仍未验证。

## v2.1.1 MP3 底乐下载修复

- 修复前回归用例实际失败：成片 WAV 已包含底乐时，未校验的旧 MP3 缓存仍被直接下载。修复后对成片计算 SHA-256，并核对编码器版本；旧版、导入或源音频变化的缓存重新本地编码。
- 47 个 Node 测试及静态构建通过。新增用例覆盖底乐与人声进入编码器、缓存复用与失效、并发下载独立可读、失败保留旧文件、删除清理元数据；Python 路径本次未改动，沿用此前 38 项通过记录。
- 实际浏览器在纯静态 `/DIYFM/` 子路径导入明确标注的 4 秒合成测试备份：WAV 包含 880 Hz 主音轨与 220 Hz 底乐音轨，另带有效但缺少底乐的旧 MP3。使用真实文件选择器导入和真实 MP3 Worker 下载，没有注入浏览器内部状态。
- FFmpeg 实际解码下载文件：主音轨幅度约 0.23745，底乐幅度约 0.02375；旧缓存的底乐幅度小于 0.000001。两条音轨均保留，浏览器控制台无 warn / error。截图仅保留在本机忽略目录，不发布测试音频或私人节目。
- 下载与缓存重建无需 Key 或模型请求；本次没有云端生成调用。原本未包含底乐的成片不会凭空增加音乐。

## v2.1 国际化验收

- 首次进入固定英语；在设置中切换 English / 日本語 / 中文，不读取 OS / 浏览器语言来覆盖用户选择。浏览器实际验证三语切换及刷新恢复，文档 `lang` 与页面标题同步。
- Key、草稿和未保存模型：在纯静态候选页面使用无效合成 Key 仅做本地启用检查；切换后 Key 仍启用、输入框为空、原愿望与听力语言及未保存模型保持。刷新后界面语言恢复，Key 消失。未向 Google 提交该合成 Key。
- 制作与播放：受控测试验证语言切换不改播放器来源、播放时间、倍速、暂停状态、Key 与在途任务标志；制作的辅助信息语言单独快照，切换和备份导入不改变该字段。
- 既有作品：实际导入明确标记的短静音测试备份，英语界面播放有效 `blob:` 音频；切换日语后，中文频道 / 单集标题和原始英语台本不被翻译或改写。
- 交互与布局：实际检查三语 390 × 844 设置页、日语声音选项和中文主页，页面宽度均未超出视口。错误提示可随界面切换；试音提示的格式化换行、台本文案渲染和愿望空白保留有回归用例。
- 文案：集中维护三语消息；缺失日语译文回退英语；翻译仅作用于静态模板与已知系统消息，不处理用户内容插值。动态系统参数及三语插值槽位通过检查。
- 文档：英文 `README.md`、`README.ja.md`、`README.zh-CN.md` 完整互链；已检查本地链接、相同模型 ID 与快速开始命令。
- 本次没有真实 Google Key，不声明新语言下的实际云端生成或教学效果已经验证。Firefox / Safari 独立浏览器和长期容量仍未验证。

## v2.1.2 MP3 Worker 启动兼容

- 用户反馈公开站点 Chrome / Edge 出现 Worker 启动失败；当时两个站点的 Worker 和编码库均返回 HTTP 200，未取得用户浏览器底层错误，不能将具体原因断言为脚本权限。
- 修复前的 Worker 不可用回归用例实际失败。新增启动握手、8 秒启动期限及页面内分块备用编码，构造异常、加载错误和消息错误均可回退；编码总超时与失败仍保留原成果。备用路径使用自托管的固定版 lamejs，不使用 eval、第三方转码或 Key。
- 52 项 Node 测试与静态构建通过；新增真实编码器回退、迟到回调隔离、批次间让出页面、正常握手、无法加载编码库、编码失败以及无响应 Worker 的回归。
- Chrome 内核内嵌浏览器实际访问 `/blocked/` 候选站点，HTTP CSP 明确设为 `worker-src 'none'`。通过正式导入与下载按钮取得 MP3；服务日志确认没有 Worker 请求，而是加载备用编码模块。未关闭浏览器保护或注入应用内部状态。
- 同一候选产物在不限制 Worker 的 `/DIYFM/` 子路径也完成实际下载，日志确认加载带版本号 Worker 与编码库。两条路径均用 FFmpeg 解码下载文件，880 Hz 主音轨幅度约 0.23745，220 Hz 底乐幅度约 0.02375，保留原混音。
- 使用明确标注的 4 秒合成测试样本，不涉及真实 Key 或收费模型调用。用户的具体扩展、网络和浏览器策略未在本机复制；独立系统 Edge / Firefox / Safari 未实测。

## v2.2 原生客户端验收（2026-11-09）

- 采用用户选定的“共享现有界面＋原生能力”：资源内置、无新后台、各端独立本地库、Key 仅运行内存、三语界面。详细支持与分发条件见 [客户端说明](clients.md)。
- 自动检查：61 项 Node 测试通过；新增文件分块/取消/中断、原生队列准备、A→B 与停止后的迟到回调、系统轨道/暂停同步、删除与队列准备交错、拒绝远程媒体来源。它们是受控契约测试，不冒充平台实际运行。
- Mac 原生文件测试实际通过：完整提交、顺序检查、哈希、拒绝路径穿越、失败保留原导出、原子替换、缓存清理。Mac arm64 / x86_64 均编译，Apple Silicon 实际运行；无 Intel 实机与全新普通账户验证。
- Mac 实际界面：从系统文件选择器导入明确标注的两集 4 秒合成 WAV；真实 AVPlayer 频道连播自动从 A 切到 B，暂停和时间进度可见；重开程序仍保留频道与节目。英语首次打开、日语和中文切换通过，作品原名不变，原生更新入口翻译跟随。
- Mac 文件闭环：实际 MP3 保存后使用 FFmpeg 解码，人声测试频率 880 Hz 幅度约 0.171、BGM 测试频率 220 Hz 幅度约 0.019，两条音轨均保留。备份取消后可再次导出，原两集保留；实际导出的 ZIP 经程序导入验证为 1 个频道、2 条可用成片。
- Android：在隔离的 API 36 / ARM64 模拟器，debug 与本地签名 release 两种构建各 3 项真实平台集成测试通过，覆盖真实文件校验、Media3 自动换集、Activity 后台播放、暂停/恢复、倍速单曲循环、停止后的旧请求拒绝，系统 MediaController 暂停/恢复/定位与返回应用的 PendingIntent，以及内置前端英语启动与原生桥。测试不使用真实 Key、不发模型请求。Android 实机、不同厂商节电策略、系统锁屏按钮和文件提供器的完整人工验收仍未完成；不将集成测试称为全部手动 UI 验收。
- 首次 Android 停止测试发现 ExoPlayer.stop 不会清除 playWhenReady，已修复为先 pause，再 stop/clear，并通过原用例回归。Mac 首次读取音频失败定位在 WebKit 对 Blob 的连接策略，CSP 明确允许本机 Blob 读取后实际播放通过；没有放宽外部 Google API 来源或绕过 TLS 校验。
- 当前没有 Apple Developer ID 身份，Mac 采用 ad-hoc 签名，未公证；不声明下载到其他 Mac 的 Gatekeeper 验收通过。Android 本地发布密钥仅在忽略目录，不公开；包应在最终源码提交后重建并校验签名与来源。
- 未验证真实 Google Key 在新客户端内的付费生成成功；原有模型契约、缓存和 Key 保密回归通过，合成测试音轨不能代表云端合成或教学效果。


## v2.2.1 手机竖屏适配（2026-11-09）

- 原始实际 Android WebView 为 412×915 CSS px，主按钮仅 42 px；新增回归先在旧样式上失败。改为 native 容器处理 Insets 后可用视窗为 412×839，顶部约 125 px。第一次样式修正仍因 `.primary` 优先级覆盖通用按钮规则而失败；修正对应组件规则后，实际 Android 初始页可见按钮和选择器均达到 48 px，无横向溢出。
- 内容区独立滚动，播放器留在可用视窗内；消息图标保留三语无障碍名称，手机频道条横向滚动，页面本身不横向滚动。320×700、360×800、430×932 和 800×360 浏览器尺寸实际检查了正文滚动、播放器边界以及横竖往返。窄屏下实际操作了三语设置、单曲/频道与倍速、展开声线/BGM、缺少 Key 时提交→设置→返回；原愿望和声音偏好保留，没有收费调用。
- 61 项共享 Node 测试通过；Android 发布构建的 4 项平台集成回归覆盖原有播放/文件、竖屏几何、48 px 触摸区、实际 Activity 横竖往返和受控 IME Insets 收缩/恢复。IME 验证向真实 View 层发送受控 WindowInsets，读取真实 WebView 布局；不冒充人工点开系统软键盘或 Android 真机验收。
- 本轮没有 Android 真机和厂商键盘环境；浏览器截图仅作为共享竖屏布局预览。网页与 Mac 同步共享布局，按用户后续选择更新 Mac 常用安装；升级前的本地备份保留在忽略目录，绝不上传到仓库或 Release。原生数据存储格式和 Android 签名身份不变。最终包、升级保留和公开下载校验结果记录在对应 Release，未公开的中间包不作为交付包。

- 升级夹具通过本地节目库 API 在已发布的 Android 2.2.0 上创建明确标注的测试频道、合成 WAV 和自定义模型偏好；不使用 UI 脚本点击或真实 Key。复验命令在安装新 APK 前后分别运行 `adb shell am instrument -w -e class io.github.jaysonsheyue.diyfm.ClientIntegrationTest#bundledFrontendStartsEnglishAndNativeBridgeWithoutNetwork -e upgradePhase seed -e expectedVersion 2.2.0 io.github.jaysonsheyue.diyfm.test/androidx.test.runner.AndroidJUnitRunner` 与 `-e upgradePhase verify -e expectedVersion 2.2.1`。先在隔离设备安装签名测试 APK；中间仅 `adb install -r 新APK`，不能卸载，否则无法验证保留。最终阶段结果见 Release。

- 一轮签名候选回归在首个布局 DOM 回调等待阶段超时；原始报告保存在本地 `build/qa/portrait-cold-start-timeout.xml`。此前测试没有等待 WebView 首次导航提交，现先验证应用 URL 和页面进度完成再读取，并保留有界回调期限与全部布局断言；未将这一失败直接归因为 CSS 或放宽尺寸断言。

- 另一轮受控 IME 测试发现一次性 `dispatchApplyWindowInsets` 不能持续代表键盘状态：真实系统仍报告键盘关闭，后续重新分发布局 Insets 可覆盖夹具。诊断日志实际记录到布局期间 1 次真实关闭键盘回调。测试现在在该检查期间固定受控 Insets 来源，仍调用生产处理函数并断言真实 WebView 收缩、频道条折叠和恢复；结束时恢复系统来源。生产逻辑继续服从真实系统，不锁定或忽略系统 Insets。原始失败报告仅保留本地 `build/qa/portrait-controlled-insets-overridden.xml`。

## v2.3 单频道分享与精选目录（2026-11-10）

- 用户选择「官网精选目录」：目录与经审核的频道包随 Pages 发布，无账号、上传后台、P2P 服务或第三方目录订阅。公开目录初始为空；所有本轮 QA 音轨和真实用户备份只保存在忽略目录及本机，不作为公开频道上传。
- Web、Mac、Android 共用 `diyfm-channel` v1 ZIP；仅选定的完整混音 WAV、台本、公开资料及署名进入包。每条音轨验证字节数、SHA-256、PCM 格式与时长；拒绝未来版本、重复记录、非法路径、缺音频、额外文件和目录资料不一致。最多 50 集、100 MiB。署名为分享者申报，哈希不代表身份认证或安全背书。
- 82 项 Node 检查通过，覆盖原有生成/Key/播放契约与新包的字段白名单、原混音逐字节保留、预览无写入、取消/过期预览、并发重复提交与跨标签去重、不同版本另存、源署名再分享/备份恢复、存储失败可重试、无凭据目录请求及下载边界。导入/导出不发模型请求。
- 隔离 API 36 ARM64 模拟器的签名发布构建，5 项平台检查通过：保留文件/Media3/前端/旋转与受控 IME 原有回归，新增在真实 WebView 用本地库 API 完成分享导出→预览→提交→重复导入，读取导入音频并与原合成音轨 SHA-256 比较。平台测试不冒充 Android 系统文件选择器完整人工验收。
- 浏览器实际操作：同源静态目录加载→预览/台本展开→关闭（未增频道）→语言筛选→一键加入→实际 `blob:` 音频播放（8 秒）→停止→分享仅勾选一集→真实下载 ZIP→文件选择器重复导入→打开已有频道（未重复新增）。下载包实读只有一集 WAV、台本和原来源署名，无设置或制作中间文件。另用损坏 ZIP 验证错误后已有节目保留。
- 英/日/中界面在 320 px 窄屏实查无横向溢出、可见按钮/选择器至少 48 px；预览正文独立滚动，顶部关闭与底部确认在视窗内。测试频道明确标为合成测试音，不是语言教学节目或真实云端生成结果。
- 资源更新统一入口与 API 所用的国际化模块 URL；一项旧单例测试最初导入了未带版本的另一份模块而失败，同步为实际入口的同一模块后回归通过。未通过删除断言或放宽结果处理。
- 最终安装包、2.2.1→2.3.0 升级、Mac 本机数据保留和公开下载校验在对应 Release 记录。源代码/中间构建测试不替代最终包核验。Android 真机与系统文件提供器、物理 Intel Mac、独立系统浏览器和 100 MiB 上限压力场景尚未全面验收。Windows/iOS 未开发，不列为本轮已交付平台。


## v2.3.1 Listening-first phone layout (2026-11-10)

- The supplied Android portrait recording exposed a gap in earlier checks: zero horizontal overflow and 48 px targets did not prove a coherent screen hierarchy or that existing episodes were reachable before the production form. The revised layout separates bottom app navigation, the top channel selector, episode listening, production/preferences, and contextual management.
- Shared regression suite: **84 Node tests** passed, including saving a retained draft when the composer is absent and refreshing the header count after episode changes. Native contract tests remain applicable; no model requests are used for this layout change.
- A signed Android candidate passed **6 integration tests** on the isolated API 36 ARM64 emulator. The new test uses actual bundled WebView DOM controls to open a two-episode synthetic fixture, verifies the first Play action is above bottom navigation, walks content → sound → content → episodes → content, checks the missing-Key detour preserves input, and switches English/Japanese/Chinese. Existing file, player/background, sharing, rotation and controlled IME checks remain enabled. A test screenshot contains only synthetic QA content; this is emulator evidence, not physical-device review.
- Real browser checks at 320×740, 360×800 and 412×839 across English/Japanese/Chinese found no horizontal page overflow or visible button/select below 48 px. Tested menu → share → close, playback → open options → change mode/speed → stop, new draft → first voice/BGM choices → missing Key → return, expanded model settings → save, and desktop-width rendering. Deletion was exercised on a recoverable synthetic test episode and exposed a stale header count, now fixed. Browser-native confirmation cancellation was not reliably observed in that manual attempt; the pre-existing controlled cancellation regression remains in the Node suite. No private user episode was used.
- First-run English remains the policy; existing user language choices are retained. Sharing format, keys, storage origin, Android signing identity and channel data format are unchanged. Installer hashes, final source revision, actual upgrade paths and public download checks are recorded in the release notes after final artifact verification.
- No physical Android device or vendor IME, physical Intel Mac, independent iPad/iOS client or paid Google generation was exercised in this layout work. The controlled IME test is not a claim of real keyboard manual QA. UI checks cover the documented affected paths, not every possible action permutation.
