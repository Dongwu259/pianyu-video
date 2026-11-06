# 内置字体清单与许可

片语随软件分发的字体文件（`resources/fonts/`）。分发时保留本目录中的许可证文本。

| 文件 | 字体 | 许可证 | 用途 |
|---|---|---|---|
| MiSans-Regular.woff2 / MiSans-Bold.woff2 | MiSans（小米） | 小米 MiSans 字体知识产权许可（允许免费商用，见 https://hyperos.mi.com/font/） | 缺省「商业冷峻」氛围 |
| LXGWWenKai-Regular.ttf / LXGWWenKai-Medium.ttf | 霞鹜文楷 LXGW WenKai v1.522 | SIL Open Font License 1.1（licenses/OFL-LXGWWenKai.txt） | 「温暖手写」氛围（官方无 Bold；700 粗体请求按 CSS 字重匹配落到 Medium） |
| Poppins-Regular/SemiBold/Bold.ttf | Poppins | SIL Open Font License 1.1（licenses/OFL-Poppins.txt） | 「英文展示」氛围 |
| JetBrainsMono-Regular/Bold.ttf | JetBrains Mono | SIL Open Font License 1.1（licenses/OFL-JetBrainsMono.txt） | 等宽栈首选（代码终端/科技等宽） |
| ZCOOLQingKeHuangYou-Regular.ttf | 站酷庆科黄油体 | SIL Open Font License 1.1（licenses/OFL-zcoolqingkehuangyou.txt） | 3D 挤出标题字体档 1（厚重 display） |
| ZCOOLXiaoWei-Regular.ttf | 站酷小薇 | SIL Open Font License 1.1（licenses/OFL-zcoolxiaowei.txt） | 3D 挤出标题字体档 2（纤细宋感） |
| MaShanZheng-Regular.ttf | 马善政楷书 | SIL Open Font License 1.1（licenses/OFL-mashanzheng.txt） | 3D 挤出标题字体档 3（毛笔手写） |
| ZCOOLKuaiLe-Regular.ttf | 站酷快乐体 | SIL Open Font License 1.1（licenses/OFL-zcoolkuaile.txt） | 3D 挤出标题字体档 4（圆润卡通） |

OFL 1.1 要点：允许随软件捆绑分发与销售；**禁止**把字体文件本身单独出售；
若修改字体必须改名并同样以 OFL 发布。霞鹜文楷的 OFL 要求分发时附许可证原文（已附）。

字体栈定义见 `src/shared/font-presets.ts`；加载见 `src/remotion/config/brandFont.ts`
（headless 渲染走 @remotion/fonts delayRender，Player 预览走 FontFace，两边同一份文件）。
