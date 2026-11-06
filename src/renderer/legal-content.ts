/**
 * 法律与致谢文案（内置于客户端，离线可读）
 * 关于弹窗的「使用协议 / 隐私政策 / 开源致谢」共用这份内容。
 * 注意：服务端官网 public/terms.html 与 public/privacy.html 是同一内容的网页版，
 * 修改时请两边同步。
 */

import {SFX_CREDITS} from '../shared/sfx-credits';

export const TERMS_OF_USE = `片语 使用协议

最近更新：2026 年 8 月

欢迎使用片语（以下简称"本软件"）。使用本软件即表示你已阅读并同意本协议。

一、授权许可与版本
1. 本软件采用「应用免费 + 专有资产订阅」模式：
   - 应用本体开源免费：全部剪辑功能可用，导出无水印、不限制分辨率。
   - 月度订阅：6 元/月，解锁专有本地模型权重下载与后续更新，到期后需续订方可继续使用。
   - 年度订阅：68 元/年，到期后需续订方可继续使用。
   - 终身授权：168 元一次买断，绑定一台设备长期使用。
2. 订阅对应的是专有资产（专有模型权重 / 模板包 / 更新服务），不是「解锁软件」——软件本身不订阅也能完整使用，也可接入第三方模型。
3. 激活码实行"一码一机"：一个激活码同一时间仅可在一台设备上激活使用。
4. 禁止分享、转售、出租或破解激活码，禁止在多台设备上同时使用同一激活码。
5. 禁止对本软件进行反向工程、反编译，法律法规明确允许的除外。

二、设备绑定与重装
1. 激活时本软件会生成设备指纹（详见隐私政策），用于将授权绑定到当前设备。
2. 在同一台设备上卸载并重新安装本软件，授权不会丢失：卸载默认不删除授权数据，且本软件会在本机额外保存一份经系统加密的授权凭证，用于重装后自动恢复，无需重新输入激活码。
3. 若需更换设备，应先在原设备上"解绑"以释放该激活码的设备占用，再于新设备激活；原设备无法操作时（如遗失、损坏），可凭购买凭证联系作者协助释放。

三、用户内容与素材
1. 你应对上传到本软件的视频、图片、音频、文案等素材（以下简称"用户内容"）拥有合法权利或已获得授权。
2. 用户内容的权利归你所有，本软件不会声称对其拥有任何权利。
3. 不得使用本软件制作、导出违法违规、侵权或含有恶意的作品。

四、AI 创作助手
1. AI 创作助手由你自行配置的第三方大模型服务提供能力，生成内容仅供参考，其准确性与合规性由你自行判断与负责。
2. 你向第三方模型服务发送的内容，同时受该服务商的协议与隐私政策约束。
3. 若你的作品包含 AI 生成的文案、AI 合成语音（TTS 旁白）等内容，发布到各内容平台时请按该平台规则如实进行 AI 生成内容声明；相应的发布合规责任由你自行承担。

五、授权校验与离线使用
1. 本软件会定期（不超过每 7 天一次）联网校验授权有效性，并据此刷新授权状态。
2. 在无法联网时，自上次成功校验起 30 天内仍可继续使用授权版功能（离线宽限期）；超过 30 天仍未联网校验的，将暂时回退为免费版，联网后自动恢复。

六、退款
1. 月度 / 年度订阅为按周期付费，到期后不续费即自动停止，已支付周期内的权益不退款。
2. 终身授权属于数字授权商品，激活码一经激活，原则上不支持退款；法律另有规定的除外。

七、免责
1. 本软件按"现状"提供，不保证完全无错误、不中断。因使用本软件产生的直接或间接损失，在法律允许的范围内我们不承担责任。
2. 因第三方服务（大模型接口、授权服务器等）不可用导致的功能受限，不属于本软件的违约。

八、其他
1. 我们可能不时更新本协议，更新后在软件内或官网公布即生效。
2. 如对本协议有疑问，可通过作者个人网站 dwphoto.top 与我们联系。`;

export const PRIVACY_POLICY = `片语 隐私政策

最近更新：2026 年 8 月

我们重视你的隐私。本政策说明本软件收集、使用与保护信息的方式。

一、我们收集的信息
1. 本地数据：你的工程文件、素材、设置均保存在你自己的设备上，我们不会上传。
2. 设备指纹：激活与在线校验时，本软件会生成一个设备指纹用于绑定与识别设备。在 Windows 上，该指纹基于操作系统的 MachineGuid（系统安装时生成）经 SHA-256 不可逆哈希得到，不包含可直接还原的硬件序列号；无法读取时退化为网卡 MAC 与主机名的哈希。我们不会收集你的原始硬件标识，仅保存其不可逆哈希值。
3. 授权信息：激活与校验时，我们会接收激活码、上述设备指纹哈希及主机名（用于在你的授权列表中显示设备名），用于验证授权有效性。
4. AI 创作助手：仅在你主动使用时，将对话内容与你提供的产品信息发送至你自行配置的第三方大模型服务端点。API Key 经系统安全存储加密后仅保存在本机。
5. 崩溃报告（默认关闭）：仅当你在设置中开启"匿名崩溃报告"后，应用发生崩溃时才会向我们发送一次崩溃报告，内容包括应用版本号、操作系统平台与架构、错误类型，以及错误信息与堆栈首部（文件路径中的用户名已做脱敏处理）。报告不包含你的文件内容、工程数据、激活码等个人信息。崩溃报告仅用于定位与修复缺陷。你可以随时在设置中关闭该开关，关闭后不再发送。
6. 录屏鼠标轨迹：使用内置录屏功能录制屏幕时，本软件会在录制期间记录鼠标的移动与点击位置（仅鼠标，不含键盘输入），用于"鼠标跟随运镜"等模板效果。这些数据仅作为本地文件（与录像同目录的 .cursor.json）保存在你自己的设备上，不会上传，删除录像文件后即可一并删除。

二、我们不做的事
1. 不收集你的视频、图片等素材内容。
2. 不收集与授权无关的个人身份信息。
3. 不向任何第三方出售你的数据。

三、信息的存储与保护
1. 授权校验数据在服务端仅用于授权管理，采取访问控制措施保护。
2. 本地敏感信息（如 API Key、授权令牌）使用操作系统提供的加密能力（Windows 下为 DPAPI）存储。
3. 为支持在同设备重装后恢复授权，本软件会在本机注册表（HKCU\\Software\\PromoVideoGenerator）额外保存一份经系统加密的授权凭证。该凭证绑定当前设备与 Windows 用户账户，复制到其他设备或其他用户账户无法解密使用，且仍受服务端设备指纹校验约束，不会破坏"一码一机"。

四、第三方服务
1. 你配置的第三方大模型服务由对应服务商独立运营，其数据行为受该服务商隐私政策约束，请自行查阅。

五、你的选择
1. 你可以在设置中清除已保存的 API Key。
2. 你可以在授权管理中"解绑"当前设备：解绑会同时清除本机的授权记录与上述注册表凭证，该激活码可在新设备上重新激活。
3. 卸载本软件默认不会删除上述注册表凭证（以便重装恢复）；如需彻底清除，可使用"解绑"功能，或手动删除注册表项 HKCU\\Software\\PromoVideoGenerator。卸载后本地工程与素材数据可由你自行删除。
4. 匿名崩溃报告默认关闭，你可以在设置中随时开启或关闭；关闭后不再发送任何崩溃报告。

六、联系我们
如对本政策有任何疑问，可通过作者个人网站 dwphoto.top 与我们联系。`;

export const OPEN_SOURCE_NOTICES = `第三方开源项目致谢

本软件站在巨人的肩膀上，感谢以下开源项目及其贡献者：

Electron - MIT License
跨平台桌面应用框架。https://www.electronjs.org

React - MIT License
用户界面库。Copyright (c) Meta Platforms, Inc. and affiliates.
https://react.dev

Remotion - Remotion License
用 React 以编程方式创作视频。https://www.remotion.dev

three.js - MIT License
WebGL 3D 渲染库（3D 模板场景的地基）。Copyright © 2010-2026 three.js authors.
https://threejs.org

@react-three/fiber & @react-three/drei - MIT License
three.js 的 React 渲染器与常用件库。https://docs.pmnd.rs

opentype.js - MIT License
TrueType/OpenType 字体解析（3D 挤出文字的字形来源）。
https://github.com/opentypejs/opentype.js

@modelcontextprotocol/sdk - MIT License
Model Context Protocol 官方 SDK（AI 助手 MCP 接入）。
https://github.com/modelcontextprotocol

Zustand - MIT License
轻量状态管理。https://github.com/pmndrs/zustand

Lucide - ISC License
美观一致的图标集。https://lucide.dev

FFmpeg - LGPL v2.1+ / GPL（依构建配置）
音视频处理基石，经 Remotion 内置用于渲染导出。https://ffmpeg.org

Express - MIT License
Web 服务框架（授权服务端）。https://expressjs.com

better-sqlite3 - MIT License
SQLite 数据库驱动（授权服务端）。https://github.com/WiseLibs/better-sqlite3

jsonwebtoken - MIT License
JWT 签发与校验（授权服务端）。https://github.com/auth0/node-jsonwebtoken

上述项目的完整许可证文本可在各自项目主页获得。

内置字体致谢（随软件分发，均可免费商用；许可证原文见安装目录 resources/fonts/licenses/）

MiSans - 小米 MiSans 字体知识产权许可（允许免费商用）
https://hyperos.mi.com/font

霞鹜文楷 LXGW WenKai - SIL Open Font License 1.1
https://github.com/lxgw/LxgwWenKai

Poppins - SIL Open Font License 1.1
https://fonts.google.com/specimen/Poppins

JetBrains Mono - SIL Open Font License 1.1
https://www.jetbrains.com/l/mono

站酷庆科黄油体 - SIL Open Font License 1.1
https://www.zcool.com.cn/special/zcoolfonts

站酷小薇 - SIL Open Font License 1.1
https://www.zcool.com.cn/special/zcoolfonts

马善政楷书 - SIL Open Font License 1.1
https://fonts.google.com/specimen/Ma+Shan+Zheng

站酷快乐体 - SIL Open Font License 1.1
https://www.zcool.com.cn/special/zcoolfonts

OFL 1.1 要点：允许随软件捆绑分发与销售；禁止把字体文件本身单独出售；
若修改字体必须改名并同样以 OFL 发布。

内置音效致谢（CC0 实录音效，来自 Freesound 社区）

本软件内置的转场与氛围音效为 Freesound 社区贡献者发布的 CC0 1.0 公有领域录音
（https://creativecommons.org/publicdomain/zero/1.0/），可自由用于商业用途，无署名义务。
我们仍在此署名致谢（按音效类别排序）：

${SFX_CREDITS.map((c) => `${c.title} — ${c.author}（${c.license}）\n${c.url}`).join('\n\n')}`;
