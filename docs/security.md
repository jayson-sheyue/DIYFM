# Key 与本地数据安全边界

DIYFM 公共版采用每位使用者自带 Gemini Developer API Key 的静态架构。网页本身不能为共享凭据提供保密能力；本项目不嵌入站长 Key，也不提供让匿名用户共享额度的代理。

## 凭据生命周期

1. Key 通过密码输入框进入页面，默认不提供长期保存开关。
2. 启用时先校验，再放入模块闭包；输入框立即清空。
3. 普通设置和状态接口只返回是否启用及非秘密模型配置。
4. Google 请求使用固定 HTTPS 主机的请求头，不把 Key 拼入查询参数，不附带浏览器 Cookie，不接受跳转。
5. 新任务捕获内存快照。旧任务不会因换 Key 混用账户；Key 的 SHA-256 指纹仅用于区分试听缓存，不是可用凭据。
6. 清除 Key 阻止新任务，已经发出的请求仍可能继续执行或计费。离开页面会清除内存凭据并中止本页等待，Google 已收到的请求不保证被撤销。

## 不作出的承诺

- 浏览器运行时不能对使用者本人、调试器、已获权限的扩展或被攻陷的同源脚本隐藏 Key。
- 内容安全策略减少非预期脚本和网络来源，但不能代替可信设备、依赖审查及 Google 侧的 Key 限制。
- GitHub Pages 无法为静态项目配置独立的私密服务器或在构建时隐藏共享 Key。同一账户的多个 Pages 项目共享来源，需要信任该来源下的其他应用。
- 不将“清除本页 Key”声称为已取消 Google 服务端请求。

## 存储、输入与发布

- IndexedDB 保存用户自己的频道、台本、音频、工作进度及非秘密模型设置；草稿、界面语言与界面偏好可能使用 localStorage。
- 界面翻译使用本机随站点托管的文案，不向外部翻译服务发送愿望或台本；切换语言不清除 Key 或重新发起生成。
- 模型内容作为数据呈现，标题和台本不执行 HTML；搜索建议使用无脚本权限的 sandbox iframe。来源链接只接受 HTTPS。
- ZIP 导入只接受允许的文件路径、限制解压规模、验证清单与音频，不执行备份内容；导入失败不覆盖现有库。
- 发布采用 `static/ → dist/` 白名单构建，不复制 `data/`、环境文件、ADC 凭据、日志或本机成片。
- Pages 工作流不使用 Gemini Key Secret，检查任务只有仓库只读权限，发布任务仅获得 Pages 与 OIDC 所需权限。
- 运行依赖自托管、版本锁定，并保留第三方许可证；没有第三方统计代码。

## 使用建议与报告问题

在 [Google AI Studio](https://aistudio.google.com/apikey) 管理 Key，在 Google Cloud 中检查适用的 API / 网站限制、额度与预算。不要把 Key 粘贴进 Issue、截图、程序愿望或模型 ID；发现泄露应先撤销，再重新创建。

报告缺陷时提供复现步骤和脱敏错误；不要提交真实 Key、完整浏览器存储导出或私人节目备份。安全相关细节不应直接放到公开 Issue 中；可先联系仓库维护者协商适当的报告方式。

官方依据：[Gemini API Key 保护](https://ai.google.dev/gemini-api/docs/api-key)、[GitHub Pages 托管能力](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)。
