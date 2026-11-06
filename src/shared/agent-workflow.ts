/**
 * Agent 成片工作流指南 - 唯一事实源（按体裁分册）。
 *
 * 同一份构建入口服务两类读者：
 * - 内置 AI 助手：buildSystemPrompt(videoType)（llm-prompt.ts）嵌入对应分册；
 * - 第三方 agent：MCP 工具 get_workflow_guide（mcpBridge.ts）按工程当前体裁返回。
 * 结构 = 共用工序主干（素材采集 → 成片 → 发布，全体裁通用）+ 按体裁的分册剧本
 * （叙事结构 / 模板推荐 / 剪辑原则）。工作流知识有改动只改这里。
 *
 * 本文件不 import 任何运行时依赖，主进程 / preload / 渲染端 / 单测都可直接引用。
 */
import type {VideoType} from './video-type.ts';
import {VIDEO_TYPE_LABEL} from './video-type.ts';

/** 共用工序主干：三阶段流程 + 全自动模式 + 前置条件 + 调参纪律（全体裁通用） */
const WORKFLOW_SPINE = `完整流程分三个阶段：先把素材采齐，再搭片渲染审片，最后备好发布物料（封面 + 元数据）。素材都没有就谈不到成片——用户说「帮我做条片子」时，第一反应应该是按上方分册剧本规划要哪些画面、引导采集，而不是直接空写故事板。

### 全自动模式（run_auto_pipeline）
用户只想给一句话需求、不想走交互流程时（「帮我做条 XX 视频」），直接 run_auto_pipeline(brief)：应用内流水线自动完成 写脚本建故事板 → 配素材（复用已有 → stock 搜索 → 文生图，都不行换零素材模板）→ 旁白/BGM → 渲染 → 审片 → 高危自动改稿重渲 → 封面 + 发布元数据，一步到位。它异步执行，启动后用 get_app_status 轮询 autoPipeline 字段（steps/log/outputs）直到 status=done。你不需要再逐工具操作——除非流水线报错或用户对结果不满意，才按常规三阶段流程局部修改（此时已有故事板与素材，从阶段二第 4 步开始；⚠️ set_storyboard 是整体重建、会清空全部片段素材，已有素材时禁用）。
计划先行（可编辑计划层）：用户想先过目再执行、或需求较重不敢一把梭时，用两段式——run_auto_pipeline(plan_only=true) 只出成片计划（segments JSON + 可读 planText，不改工程），把 planText 原样给用户看；用户确认就 run_auto_pipeline(segments=计划原样) 执行，要改哪段就先改 segments 再执行（执行时校验失败会原样报错、不会自动重写，人工修改受保护）。这一层让「AI 全自动」与「用户拍板」不再互斥。

### 阶段一 · 素材采集（6 步）
素材四个来源，按成本从低到高：用户已有录好的视频/图片（import_segment_media 直接导入，优先）→ stock 免费素材（search_stock_media + import_stock_media）→ 文生图（generate_image，适合背景/插画类空镜）→ 录屏采集（最贴合但要用户配合操作）。另有 3D 素材途径：需要 .glb 模型素材（配 ModelTurntable 等 3D 模板）时用 generate_model 文生 3D（需先在「设置 → 文生 3D」配 Key，生成约 1-3 分钟）。录屏流程：
1. 与用户对齐：这条片子要讲什么（按分册剧本的结构）、需要哪几个画面（每个画面对应成片的一段）；
2. 搭骨架：故事板为空时可先 set_storyboard 按分册剧本结构建空骨架（此时无素材可清，安全）。⚠️ 已有素材的故事板严禁 set_storyboard——它是整体重建，会清空全部片段素材，不可恢复；
3. list_capture_sources：列出可录的屏幕/窗口，让用户选被录目标（优先窗口源：画面干净无干扰；窗口被最小化会采集失败，提醒用户先还原）。选源也可以不查清单直接 start_screen_recording({sourceName: "窗口标题关键词"})——唯一命中直接起录，多命中会返回候选让你改用 sourceId；
4. take_screenshot：看一眼目标当前画面，确认窗口状态正常、内容就是要录的；
5. start_screen_recording 起录（可带 countdownSec 倒计时，给用户留出切到目标窗口的时间；屏幕源可带 region{x,y,width,height} 视频像素选区只录一块区域——建议先 take_screenshot 看过画面再定；fps/maxHeight 控画质，4K 屏出 1080p 素材传 maxHeight:1080 省体积；layout 让摄像头与屏幕一起烧录：pip 画中画 / side 左右分屏 / stack 上下分屏 / camera 仅摄像头口播——适合「真人讲解 + 演示」类素材，给了 layout 自动开启摄像头）→ 立即用文字告诉用户「已开始录制，请开始操作，完成后说一声」，然后结束本轮回复——你无法在单次对话中计时等待。用户说完成后调用 stop_screen_recording(segmentIndex) 停录，素材自动加入指定段；停录时可直接带 trimStartSec/trimEndSec 掐头去尾；
6. view_media_frames 抽帧验收素材内容；头尾还有多余准备动作用 set_segment_trim 再裁，中间的口误/加载等待/无关操作用 set_segment_trim 的 cuts 挖段抠掉（抠掉的部分成片时前后无缝拼接，有效时长相应缩短）；手持/走动拍摄的素材画面发抖，先 stabilize_clip 一键跟踪稳定再排片（自动选跟踪点，返回的跟丢率 >0.15 就换点重试）。每个画面重复第 3-6 步，直到各段素材齐备。
录屏直出：用户要的就是原始录像成片（不做包装）时，建段用「屏幕录制」模板（templateId: ScreenRecord）——整段只渲染录屏素材本身，无文字/动效/淡入淡出/收尾渐黑，画面完整显示不裁剪；素材入段后段时长自动对齐素材可用时长，掐头去尾后可直接渲染交付。
录屏即成品：用户要「软件操作演示片」（FocuSee/Screen Studio 那种光标跟随+自动切景别）时，录完直接 auto_screen_demo——一段带光标轨迹的录屏自动重建故事板为「标题钩子 + 导播演示主段 + CTA」（导播分析器按光标活动自动切大/中/小景：点击落小景特写+浮卡+高亮描边、停顿出大景、whoosh 转场、倾斜-摆正循环），并自动配 BGM 压拍。传 path 指定录屏文件（不传则用故事板第一个视频素材）；title/cta 参数把标题与行动出口一并写好。只有本软件录制的素材带轨迹，其他来源素材主段退化为宽景缓推。导播演示/鼠标跟随运镜的「舞台底色/窗口卡」参数可让录屏以圆角卡悬浮在品牌色舞台上（不再满屏贴死）。
教程一键成片：用户要「操作教程/使用教学」（怎么做 XXX，一步步跟着做）时，录完直接 auto_tutorial——点击聚簇自动切步骤，重建故事板为「片头卡 + (步骤卡「第 N 步」+ 该步导播主段) ×N + 收束卡」（教程无 CTA）。用 stepTitles 逐步给一句动词短语标题（如「新建项目」「导入素材」）；review_render 审片自带教程体检（单步 ≤20s、每步有标题）。同一段录屏：要「演示片」用 auto_screen_demo（有钩子有 CTA），要「教程」用 auto_tutorial（有步骤结构）。多素材快节奏混剪段用新模板 Montage（蒙太奇卡点：1.5-2.5s 快闪轮切+变焦冲击+甩切）；产品呼吸感展示段用 ProductFloat（产品悬浮：白境/黑底轮廓光/品牌渐变三舞台）。
长素材先挖高光：一段很长的录像（vlog/口播/教程原片）直接 mine_highlights——静音检测 + ASR 转写 + 抽帧交给视觉模型，返回带理由的高光区间清单；一条素材浓缩成片用 apply_cut_list 一次落地，或 split_segment 拆成多个镜头分别包装。
stock 搜索要点：搜索词用英文命中更多（"city timelapse" 而非「城市延时」）；先搜后挑（search_stock_media 返回候选与缩略图），选中再把 provider/id/type/downloadUrl 原样传给 import_stock_media。素材多而杂时先 analyze_media_tags 给全部素材视觉打标（结果随工程记住、get_project_info 可查），再按 description/scene 与文案对位分配——这一步让「素材多但不知放哪段」的问题消失。

### 阶段二 · 成片（10 步）
素材齐备后：
1. get_app_status：确认应用版本、授权状态、工程与渲染是否空闲；
2. 先确定每段叙事职责、视觉风格和画面动作，再用 search_templates 按体裁/槽位/style/action/query 检索少量候选（模板库可能有数百个，避免把全库塞进上下文）；只有需要查看完整参数时才用 get_templates。含云端市场模板与 AI 生成模板，与内置模板同等可用。内置/市场模板都不满足创意需求时，可用 generate_template 现场写一个受限 TSX 个性化模板（编译即入库、可覆盖迭代；已注入 three.js 3D 原语——ThreeStage 舞台/ThreeText 挤出字/TurntableModel 模型台/设备壳，可写真 3D 场景模板），写完用 review_template 审查实际渲染效果，按问题清单覆盖迭代直到 pass 再全片使用；
3. get_storyboard（配合 get_segment_media / view_segment_frame）：盘点故事板与每段素材；
4. 逐段 update_segment 选模板、定时长、调参数（保留素材）；
5. 填文案/字幕：update_segment 写标题/副标题/要点与 narration.text 旁白（可 synthesize_narration 合成语音，speed 可调语速），再 set_segment_captions 配烧录字幕（素材里有人说话可 transcribe_segment_captions 自动识别）。写要点时逐行自查「卖点-素材对位」：每行要点要么配一块真实展示该卖点的画中画素材（没有就老实让它做文字板——不要文案说了、画面没拍），取窗把关键动作放在素材开头（观众看一块展板只有几秒）；录屏/截图素材优先特写关键 UI，素材在画中画里会二次缩小，全窗口大而空等于没拍；
6. set_logo / BGM / 卡点 / 色调：需要时用 set_logo 调整 Logo 位置大小；没配 BGM 时 set_bgm 选曲（不传 track 先看曲库清单——内置 12 首 CC BY 配乐开箱即用、本地曲库需用户在「声音 → 背景音乐」指定目录，清单含自动推导的情绪/能量档，也可只给 wantMood/wantEnergy 自动挑；内置曲成片片尾自动附署名）；同时有 BGM 和旁白时 set_bgm_ducking 开自动避让；有 BGM 时 align_beats 把各段切点和转场时长一起吸附到鼓点上（切点压拍、转场落半拍——节奏感的关键一步，别漏）；需要免责/标注时用 set_fine_print 加全片常驻边缘小字；多源素材亮度不一时 set_color_grade 统一色调与曝光；
7. preview_storyboard_frame 或 view_segment_frame 抽查画面，不满意就调参后再看（可多次迭代）；
8. request_render 请求渲染（MCP 模式下后台直接开始，不弹确认卡）；
9. get_app_status 轮询渲染进度，完成后从 renderOutputPath 取成片路径；
10. 双审片闭环：review_render 先跑本地可读性体检（零成本：13 字/秒停留、行 ≤30 字、hook 前 3 秒密度，成片未渲染时也先返回体检结果）再看画面（首帧钩子/文字可读性/动效一致性/色调统一/字幕安全区/整体商业感，1-5 分，问题带 segmentIndex——各体裁的侧重见分册剧本），analyze_render_audio 听声音（响度对照 -14 LUFS、爆音、中段静音，可 ASR 比对旁白文案查漏读错读）。按两份报告用 update_segment 局部改稿（只动被点名的段；响度问题开渲染面板的「响度归一化」重渲即修复），重渲后可再审，直到 verdict=pass 且音频 issues 为空。review_render 需用户 LLM 配置为多模态视觉模型。

### 阶段三 · 发布准备（2 步，审片通过后）
成片可投放后，顺手把发布物料也备齐（用户在各平台发布时直接用）：
1. export_cover 生成封面：挑全片最有代表性的一帧（建议首段标题入场后或高潮画面），选版式预设（通用选 bottomLeft；主体居中选 centerPoster；主体在下半选 topBand）出封面图。可加 add3dText 追加 3D 立体大字（默认渲染到画面主体后面，形成前后遮挡、突出主体）。返回封面图供自查——文字必须清晰、不能遮挡画面主体；不满意调 title/preset/scrim/timeSec 再出；
2. set_publish_metadata 写发布元数据：标题（注意各平台上限：抖音 55 / B站 80 / 小红书 20 / YouTube 100 字）、简介、话题标签（不带 #）。返回值含各平台组装好的文案与字数警告。用户在「渲染导出 → 封面与发布信息」可一键复制。
封面与元数据都随工程文件保存，改稿重渲后重出封面即可。
工程要交付/换机/归档时调 consolidate_project(dir)：把工程引用的全部素材复制到 dir/media/ 并重写引用，工程存为 <dir>/<工程名>.vtproj——整个目录可搬走，换机打开不丢素材；只是保存引用不复制素材时用 save_project。

### 前置条件清单
- 默认输出目录：渲染前用户须在「设置 → 默认输出目录」配置，否则 request_render 会被拒绝（MCP 模式不弹目录选择框）；
- TTS/ASR API key：synthesize_narration、transcribe_segment_captions 分别需用户先在「设置 → TTS」「设置 → ASR」配置；
- Stock 素材：search_stock_media 需用户在「设置 → Stock 素材搜索」配好 Pexels 或 Pixabay 的免费 Key（配一家即可）；未配置时引导配置或改用其他素材来源；
- 文生图：generate_image 需用户在「设置 → 文生图」填模型名（与 AI 助手共用端点与 Key）；
- 文生 3D：generate_model 需用户在「设置 → 文生 3D」配 API Key（独立于 AI 助手，去 meshy.ai 申请）；
- 录屏/截图确认：内置助手模式下 take_screenshot、start_screen_recording 会弹确认卡请用户批准（截图/录屏内容会发往用户配置的 AI 端点）；MCP 模式自动批准。录制系统声音需真实用户手势，AI 无法代点，需引导用户在录屏弹窗手动开始；
- CursorFollow（鼠标跟随运镜）：仅本软件「整屏录制」的录屏带鼠标轨迹，窗口录制与上传视频没有轨迹，用它会退化为缓慢推拉镜头。

### 调参纪律
按 get_templates 返回的 paramSpecs 结合素材比例与内容刻意调参（画框大小、运镜速度、字号等），不要一律留默认值；无单位参数是倍率语义（1 = 模板内置效果），有单位按单位取值（如 °/s）。用 set_storyboard / update_segment 的 customParams 字段按段设置，键越界会被丢弃、值会被钳到范围内（工具结果会说明）。`;

/** 按体裁的分册剧本：叙事结构 + 模板推荐 + 剪辑原则（buildWorkflowGuide 拼在主干之前） */
const GENRE_PLAYBOOKS: Record<VideoType, string> = {
  promo: `### 分册剧本 · ${VIDEO_TYPE_LABEL.promo}（Hook → 展示 → 佐证 → CTA）

#### 经典成片结构
完整叙事链（Hook → 展示 → 佐证 → CTA）：品牌片头（BrandIntro）→ Hook/痛点大字（KineticType 节拍大字）→ 2-4 段功能展示（穿插 FeatureList 功能清单收拢卖点）→ 数据佐证（StatCounter 数据页）→ 客户口碑（Testimonial 客户证言）→ 结尾行动号召（OutroCTA）。短版（20s 内）可砍佐证段。整部宣传片建议 20-60 秒，单段 0.5-60 秒。OutroCTA 要展示二维码时，把二维码图片作为该段素材上传（import_segment_media / 上传）即可，模板自动垫白色底卡展示（qrScale 调大小）；不上传素材则纯文字结尾。

#### 说服力场景（零素材模板组，文案即画面）
展示类模板负责「好看」，这四个负责「信服」——全都不需要素材，靠文案驱动，适合放在功能展示之后、CTA 之前把说服力打满：
- StatCounter 数据页：要点每行一条数据「数值 后缀 标签」，如「99.9% 服务可用率」「3000万+ 累计用户」「3x 效率提升」（数字会从 0 滚动到目标值，≤4 条）；
- Testimonial 客户证言：要点依次 = 引言 / 「姓名，职位」/ 星级 0-5（缺省 5），标题可作卡内小标签；
- FeatureList 功能清单：标题 + 要点 ≤6 条逐条勾选入场，可选 1 段素材作侧卡；
- KineticType 节拍大字：要点每行一句大字（≤8 行），用「」包住关键词会品牌色高亮；卡点玩法同 CardConverge——先 align_beats 吸鼓点，再把 lineInterval 调成鼓点间隔（60÷BPM 秒）的整数倍。

#### 叙事补充与进阶装置（按需选配）
- TimelineRoadmap 流程时间线：要点每行「标签 描述」（如「v1.0 内测发布」≤5 节点），横版水平轴/竖版垂直轴；
- PricingTiers 定价档位：要点每行「档位名 价格 描述」（≤4 档），highlight 参数指定推荐档（0 无 / 1-4 序号）；
- ComingSoon 新品预告：标题 = 主文案、要点第 1 行 = 日期（数字滚动）、副标题 = 行动句；
- LogoCloud 客户云：放 1-8 张客户 logo 图（无素材时要点填客户名），社会证明页；
- UICallout 录屏标注：1 段录屏 + focusX/focusY 焦点坐标（0-1 画面比例）推近放大，标题 = 标注文案——讲清某个 UI 细节时用；
- BeforeAfter 前后对比：2 段素材（先旧后新），中点擦除揭示；要点 = 指标行「16小时 → 5分钟」翻牌；
- CodeTerminal 代码滚动：要点每行一条代码（≤14 行），标题 = 文件名，开发者工具向；
- GlobePoints 环球点阵：标题 + 要点数据行（同 StatCounter 格式），「全球规模」表达。

#### 节奏曲线（像宣传片，不像 PPT 的关键）
专业宣传片的节奏不是匀速的，而是「慢-快-慢」的张力曲线，且剪辑点压在音乐鼓点上：
1. 片头 1.5-2.5s 立品牌；
2. 引入段 3-5s 抛问题/场景；
3. **快切蒙太奇** 4-8s：8-12 个镜头、每个 0.5-1.2s，快速扫过产品各功能画面（刷刷刷的信息密度就是宣传感的来源）；
4. 功能展示段 3-5s/段，把 2-4 个核心功能讲透；
5. 高潮快切 2-4s 再收一次；
6. 结尾 CTA 3-5s。
快切做法：用 VideoCut 模板（全屏裸素材，无画框）建多个短段，每段配同一段录屏的不同裁剪区间（set_segment_trim 切镜头）或不同素材，转场用 none（硬切）/flash/whip，然后 align_beats 把所有切点吸附到 BGM 鼓点上——先配 BGM 再卡点，顺序别反。全程 align_beats 一次即可，它对 0.5s 的短段同样生效。
更高级的卡点用 CardConverge 模板（卡片汇聚）：2-8 段素材作为卡片按 stagger 间隔从四边/四角依次飞入、弹性落位，结尾 heroZoom 整体推近接下一段。把 stagger/firstHit 调成 BGM 鼓点间隔的整数倍，每张卡就压一拍——节奏靠元素落位表达，比 flash 闪烁高级得多，适合蒙太奇和高潮段。鼓点间隔用 set_bgm 返回的 BPM 换算（60÷BPM 秒），不要自己估。
对照：整片每段 5 秒 + 交叉淡化 = 幻灯片；节奏曲线 + 卡点 = 宣传片。

#### 非模板图层（宣传片的图层语言）
- 悬浮 UI（capture_element + set_segment_overlay）：把应用界面元素（输入框、按钮组、数据卡片）截成透明 PNG 浮在任意片段上，带投影与缓浮——这是 K3 式「悬浮输入框」镜头的做法。先让用户把目标面板展开，再 capture_element(selector, attachToSegment)；
- 下三分之一字幕条：VideoCut / LowerThird 模板内置（标题进字幕条），也可单独用 LowerThird 模板做纯解说段；
- 边缘小字（set_fine_print）：全片常驻的免责声明/「本片由 AI 生成」标注，放底部边缘，透明度 0.4-0.6 最自然；
- 色调统一（set_color_grade）：多源素材（录屏/截图/本地文件）亮度色调不一会有拼凑感——autoMatch 自动拉齐曝光，再按产品气质选色调预设（科技工具 cleanCool、生活消费 warmFilm、硬件游戏 tealOrange）；这是商业感的临门一脚，渲染前必做；
- 品牌样式（set_brand_style）：品牌色统一全片强调色（有用户 Logo/网站时从中取主色，一片一色；传 "default" 回默认蓝），字体氛围按体裁选——promo 用 sleek、vlog/餐饮文创用 warm（霞鹜文楷）、开发者工具用 tech、出海英文片用 display；与色调统一叠加用，品牌一致性是专业模板的第一特征。`,

  vlog: `### 分册剧本 · ${VIDEO_TYPE_LABEL.vlog}
目标观感：真实、有节奏、像人剪的——不是广告。模板包装从简，功夫在高光选取、切点与字幕。

#### 制作主线（长素材 → 成片）
1. 素材进段：用户的长录像/录屏/相册素材 import_segment_media 导入（「录制素材」录的已在段里）；
2. 挖高光：mine_highlights(index) 对该段素材挖出带理由的高光区间清单（静音检测 + ASR 转写 + 抽帧给视觉模型评估；未配 ASR 也能跑，只是没有文字线索）；
3. 落地剪辑：一条素材浓缩成一条片子用 apply_cut_list(keepRanges=高光清单)——保留区间无缝拼接、其余全挖掉，段时长自动对齐；想把不同高光做成不同镜头/配不同文案，则 split_segment 拆段后逐段 set_segment_trim 精修；
4. 字幕：素材里有人说话 transcribe_segment_captions 自动生成逐句字幕（已配 ASR 时优先）；没说话就按画面节奏手写短句 set_segment_captions；
5. 音乐与质感：set_bgm 选 upbeat/calm 曲（音量 0.25-0.35，别盖环境音）+ set_bgm_ducking；set_color_grade 的 warmFilm + autoMatch 统一多机位色差；
6. 包装从简：VideoCut 全屏快切做主体（无画框最真实）；开头 VlogStamp 日期地点打卡（手帐风：标题填日期或 DAY N、副标题填地点、要点每行一枚小标签）或 KineticType 一句话点题；地点/人物用 LowerThird 字幕条标注；照片集锦用 VlogPolaroid 拍立得堆（要点第 i 行 = 第 i 张照片的手写小注，入场间隔对齐鼓点即卡点）或 CardConverge。

#### 剪辑原则
- 前 3 秒放最抓人的画面（钩子前置，别按时间顺序开头）；
- 每个镜头 2-8 秒；走神、等待、重复画面全砍——mine_highlights 每段会给留/砍理由；
- 切点尽量落在动作或音乐上：配了 BGM 就 align_beats 一次；
- 文案口语化、第一人称，不用营销腔。
审片侧重：节奏（无冗余镜头）、字幕同步、真实感。review_render 的「整体商业感」维度对 vlog 仅作参考，不以它否片。`,

  talkingHead: `### 分册剧本 · ${VIDEO_TYPE_LABEL.talkingHead}
结构：钩子（抛问题/结论先行，3-5s）→ 逐个观点（每观点一段：口播画面 + 大字要点）→ 总结收束。整片 30-90 秒。

#### 素材与录制
- 出镜口播用「录制素材」的 camera 构图（start_screen_recording layout:"camera"，仅摄像头全画幅）；边讲边演示用 pip 画中画；
- 口播原素材的口误/停顿/长气口用 set_segment_trim 的 cuts 挖掉——跳切（jump cut）是口播视频的常态，不必回避；挖完 transcribe_segment_captions 重新对字幕；
- 长素材（访谈/直播回放）先 mine_highlights 找表达最完整的段落，再 apply_cut_list 落地。

#### 每观点一段的标配
- 模板：TalkingPoint 口播观点卡（出镜画面 + 大字观点一体成卡，每观点一段的标配——标题填观点句先给结论，要点 ≤3 条作论据）；纯文字要点页用 KineticType 大字（「」关键词高亮）或 TextSlide；出镜画面用 VideoCut / LowerThird；
- 旁白：优先用原声（录在素材里）；需补解说写 narration.text + synthesize_narration；
- 字幕全程烧录（信息流多静音播放，口播不烧字幕等于白讲）。

#### 音频
BGM 选 calm/corporate 低能量、音量 0.2-0.3，set_bgm_ducking 必开；analyze_render_audio 查中段静音与语速。
审片侧重：观点是否逐条立住、大字要点与口播是否同步、语速节奏不赶不拖。`,

  tutorial: `### 分册剧本 · ${VIDEO_TYPE_LABEL.tutorial}
结构：结果先行（先看成品/效果，3-5s）→ 步骤分解（每步一段）→ 收尾（成果 + 提示）。每步 3-8 秒，操作与解说严格对齐——「讲到的就是看到的」。

#### 素材与录制
- 操作画面用「录制素材」录屏（start_screen_recording；整屏源带鼠标轨迹，CursorFollow 模板让镜头自动跟住操作、点击处自动推近）；真人讲解加 layout:"pip"；
- 重点区域 set_segment_viewport 推近，或用 UICallout 标注（focusX/focusY 指到控件，圆环 + 标注文案）；前后效果对比用 BeforeAfter；
- 长录屏先 mine_highlights 把有效操作段挑出来（等待/摸索/误操作全砍），再按步骤 split_segment 拆段。

#### 步骤段标配
- 每步一段：StepCard 步骤卡（「参数」页步骤序号填第几步跨段连贯，标题 = 步骤名，要点 = 操作动作，操作录屏可选）；或 LowerThird 字幕条标「步骤 N · 名称」+ VideoCut 操作画面；
- 解说字幕逐句烧录（transcribe_segment_captions 识别原声，或按旁白切句 set_segment_captions）；
- 步骤间硬切或 crossfade；有 BGM 时 align_beats 吸附切点（教程节奏稳，tolerance 可给小 0.3-0.4 避免大幅挪切点）。
审片侧重：步骤完整不跳步、重点清晰（该推近的推近）、无冗余等待。`,

  montage: `### 分册剧本 · ${VIDEO_TYPE_LABEL.montage}
节拍驱动：先 set_bgm 选高能量曲（wantMood:"upbeat"/"epic" + wantEnergy:"high"）→ 按情绪曲线搭段 → align_beats 一次把切点吸附到鼓点。先配乐后卡点，顺序别反。

#### 卡点剪辑大脑（首选，代替手工逐段切）
有 BGM + 视频素材时直接调 auto_beat_montage：它读 BGM 结构（段落/能量/重拍）和每个素材的镜头运动强度，自动切成压拍快切段——drop 一拍一刀、安静段长镜、高能量段配高运动镜头、切点全部在节拍上。拿不准结构时先 get_music_map 看段落图、get_footage_map 看素材镜头表（哪个镜头运动强、能量峰在哪）。创意控制用 auto_beat_montage 的 directives：开篇/收尾钉指定镜头定调与落版、firstDropShot 把高光镜钉到首 drop 第一拍（或直接 autoMoneyShot=true 自动选全场能量峰最高的镜头）、excludeShots 禁掉画面差的镜头。剪完 request_render 渲染 → review_render 审片闭环；审片发现某镜头差就 exclude 后重剪。只有素材太少/无 BGM 时才回退下面的手工流程。

#### 情绪曲线
开场建立（1-2 个长镜头 2-3s）→ 渐强（镜头渐短）→ 高潮（0.4-0.8s 快切连发）→ 收尾（定格或大字收束）。

#### 镜头语言
- VideoCut 全屏快切做主体（每段配素材不同裁剪区间，set_segment_trim 切镜头）；
- CardConverge 卡片汇聚做高潮段：stagger/firstHit 调成 BGM 鼓点间隔的整数倍，每张卡压一拍；
- KineticType 一两句大字点题就够，多则乱；
- 转场以硬切 none 为主，flash/whip 只点缀高潮，全片 1-2 种。
素材来源：用户素材（旅拍/相册/产品图）优先，stock 补空镜；长素材先 mine_highlights 挑动态强的段落。
审片侧重：切点是否在拍上、情绪曲线是否起伏、有无空洞镜头。`,
};

/**
 * 组装指定体裁的完整工作流指南：体裁头 + 分册剧本 + 共用工序主干。
 * 体裁只切换「建议口径」，不限制任何工具/模板的实际使用。
 */
export const buildWorkflowGuide = (videoType: VideoType = 'promo'): string =>
  `## 成片工作流指南
当前工程体裁：${VIDEO_TYPE_LABEL[videoType]}（${videoType}）。set_video_type 可切换体裁——切换后本指南分册、系统提示词身份与 get_templates 的模板推荐口径随之变化；体裁只是建议口径，不限制实际可用的模板与工具。

${GENRE_PLAYBOOKS[videoType]}

${WORKFLOW_SPINE}`;

/**
 * 宣传片分册的完整指南（= buildWorkflowGuide('promo')）。
 * 兼容既有引用（单测断言/无体裁上下文的缺省场景）；带体裁的调用方请用 buildWorkflowGuide。
 */
export const AGENT_WORKFLOW_GUIDE: string = buildWorkflowGuide('promo');
