/**
 * LLM 工具定义与故事板规格校验 - AI 助手的数据契约。
 *
 * 架构：主进程只转发 HTTP（API key 不出主进程），工具在渲染进程执行（状态在 zustand）。
 *
 * 工具清单：LLM_TOOL_REGISTRY 是唯一事实源——createLlmTools 的工具 schema、
 * llm-prompt 的「你能做什么」逐工具说明、测试/冒烟的清单断言全部从注册表派生。
 * 新增工具 = 注册表加一条 + renderer/ai/toolExecutors 加执行器，无需再同步多处。
 *
 * 设计：本文件不 import 任何运行时依赖（依赖注入 createLlmTools），因此可在 Node 中
 * 直接运行做单元测试（模板/枚举清单由调用方传入）。渲染端在 AIAssistantPanel 里用
 * TEMPLATES / TRANSITION_OPTIONS 等真实清单构建；测试里同样传入真实清单。
 */
import type {TransitionType, VideoEffect, BackgroundEffect, TextAnimPreset, CaptionLine, CaptionStyle, CaptionPosition, CaptionAnim, LogoPosition, FinePrintPosition, TemplateParamSpec, SegmentExitStyle, SfxConfig, TexturePreset} from './types';
import {parseCursorTrackScript} from './demo-cursor-track';
import type {EditPlan} from './edit-plan.ts';
import type {MusicMood, MusicEnergy} from './music-mood';
import type {ClipCut} from './clipCuts';
import type {StabPoint} from './stabilization.ts';
import type {RecordingLayout} from './recordingLayout.ts';
import {RECORDING_LAYOUTS} from './recordingLayout.ts';
import {normalizeBgmVolumeKeys, BGM_VOLUME_KEYS_MAX} from './bgm-track';
import type {BgmVolumeKey} from './types';
import type {VideoType} from './video-type.ts';
import {VIDEO_TYPES} from './video-type.ts';
import {COVER_PRESET_IDS, type CoverPresetId} from './cover-presets.ts';
import {TEMPLATE_SLOTS} from './template-slots.ts';
import {TEMPLATE_STYLES, TEMPLATE_ACTIONS} from './template-catalog.ts';
import {sanitizeTags} from './publish.ts';
import {normalizeBrandColor} from './brand-color';
import {COLOR_CURVE_IDS, type ColorCurveId} from './proxy-media.ts';
import {isFontMoodId, FONT_MOODS, type FontMoodId} from './font-presets';
import {
  GENERATED_DESCRIPTION_MAX,
  GENERATED_NAME_MAX,
  GENERATED_PARAM_MAX,
  GENERATED_SOURCE_MAX,
  GENERATED_TSX_CONTRACT,
  isGeneratedTemplateId,
} from './generated-template.ts';
import {isValidParamSpec, sanitizeTextSlots, TEXT_SLOT_VALUES} from './custom-template.ts';

// ====== 依赖注入 ======

export interface LlmToolsDeps {
  /** 可用模板（id + 默认时长；paramSpecs 用于校验 customParams 的键与取值范围；textSlots 用于文字槽位 notes） */
  templates: {id: string; name: string; description: string; minVideos: number; maxVideos: number; defaultDuration: number; paramSpecs?: TemplateParamSpec[]; textSlots?: string[]}[];
  /** 合法转场值 */
  transitions: string[];
  /** 合法视频画布特效值 */
  videoEffects: string[];
  /** 合法背景特效值 */
  backgroundEffects: string[];
  /** 合法文字入场动效值 */
  textAnims: string[];
}

// ====== OpenAI 兼容工具 schema ======

export interface LlmToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ====== 工具注册表（唯一事实源）======

/**
 * 单条工具注册记录。
 * parameters 一般是静态 JSON Schema；片段规格这类枚举清单依赖 deps 动态拼接的，
 * 写成 (deps) => schema，保持发给模型的文案与此前逐字一致。
 */
export interface LlmToolRegistryEntry {
  /** 工具名（与模型 tool_calls 的 function.name 对应） */
  name: string;
  /** 发给模型的工具描述 */
  description: string;
  /** 参数 JSON Schema；枚举清单依赖注入清单时用 (deps) => schema */
  parameters: Record<string, unknown> | ((deps: LlmToolsDeps) => Record<string, unknown>);
  /** 系统提示词「你能做什么」一节中本工具的说明（name 后文案）；缺省 = 不在该节单列 */
  promptHint?: string;
  /** 提示词中的展示名（缺省 = name）；用于 start/stop 录屏这类成对合并展示 */
  promptName?: string;
  /** 有副作用（执行前需用户确认卡/授权闸门），仅作元数据标注 */
  sideEffect?: boolean;
}

/** 片段规格 JSON Schema（set_storyboard.segments.items 与 update_segment.patch 共用，枚举值来自 deps）。
 * patch 模式（update_segment）下 templateId 可选——缺省沿用该段现有模板。 */
const segmentSpecSchema = (deps: LlmToolsDeps, opts?: {patch?: boolean}): Record<string, unknown> => ({
  type: 'object',
  properties: {
    templateId: {type: 'string', description: opts?.patch ? '模板 id（缺省 = 保留该段现有模板；仅换模板时给出，从 get_templates 获取原样使用）' : '模板 id（从 get_templates 获取，必须原样使用）'},
    duration: {type: 'number', description: '片段时长（秒），0.5-60，缺省用模板默认时长；快切蒙太奇段可用 0.5-1.5'},
    transition: {type: 'string', enum: deps.transitions, description: '到下一个片段的转场，缺省 crossfade'},
    transitionParams: {
      type: 'object',
      description: '转场参数（可选）。运动连续性用法：slide/push/wipe/whip/panChase 带 direction 时，方向应与上下段内容的运动方向一致（如上段内容向右出，转场 direction=4 右，下段 direction 参数=4 从右飞入，运动不间断）',
      properties: {
        durationSec: {type: 'number', description: '转场时长（秒，0.2-2；缺省按类型查表）'},
        direction: {type: 'number', description: '运动朝向（slide/push/wipe/whip/panChase/orbitSwipe/cardSweep：1上 2下 3左 4右；flyThrough：1推近穿过[缺省] 2拉远飞出）；缺省各转场内置方向'},
      },
    },
    videoEffect: {type: 'string', enum: deps.videoEffects, description: '视频画布特效，缺省 none'},
    backgroundEffect: {type: 'string', enum: deps.backgroundEffects, description: '背景特效，缺省 none'},
    textAnim: {type: 'string', enum: deps.textAnims, description: '文字入场动效（内置模板标题/文字的入场风格），缺省用模板默认'},
    exitStyle: {type: 'string', enum: ['sync', 'fade', 'stagger'], description: '片尾退场预设：sync 同步退场[默认] / fade 整体淡出 / stagger 留白收尾'},
    narration: {
      type: 'object',
      description: '旁白文案（仅文字；音频由用户后续在旁白面板 TTS 生成或导入）。空 text = 清除该段旁白',
      properties: {
        text: {type: 'string', description: '旁白文案（≤200 字）'},
      },
    },
    captions: {
      type: 'array',
      description: '烧录字幕行（相对段起点的时间）。建议从旁白文案切句生成，每行 ≤60 字、≤20 行。空数组 = 清除该段字幕',
      items: {
        type: 'object',
        properties: {
          text: {type: 'string', description: '字幕文案（≤60 字）'},
          startSec: {type: 'number', description: '起始时间（秒，相对段起点，≥0）'},
          endSec: {type: 'number', description: '结束时间（秒，相对段起点，>startSec 且 ≤段时长）'},
        },
        required: ['text', 'startSec', 'endSec'],
      },
    },
    text: {
      type: 'object',
      description: '文字内容（按模板文字槽位填——get_templates 返回的 textSlots 列出该模板真正展示的字段；未消费的字段会被保留但不显示，校验时以 notes 提醒）',
      properties: {
        title: {type: 'string', description: '主标题（≤30 字）'},
        subtitle: {type: 'string', description: '副标题（≤60 字；注意部分模板无此槽位）'},
        features: {type: 'array', items: {type: 'string'}, description: '功能要点/CTA 文字行（≤5 条，每条 ≤40 字；注意部分模板无此槽位）'},
        brandName: {type: 'string', description: '品牌名（≤20 字）'},
      },
    },
    customParams: {
      type: 'object',
      description: '模板个性化参数（键与取值范围见 get_templates 返回的 paramSpecs；无 unit 的参数为倍率语义，1 = 模板默认）。应按内容刻意调参，不要全留默认。3D 场景模板可用 focusPanel+focusBoost 让重点素材板驻留更久（如核心产品演示板 1.8 倍），dwellRatio 调整体节奏，themeColor/titleFont/camSpeed/camEase 按内容气质选；sceneStyle 换环境场景（0星空/1银河/2都市/3乡村/4古建/5山水/6水墨/7虚空/8纯净）——运动不变只换世界，按素材气质选（如文旅/古风选山水水墨，科技选星空银河）',
      additionalProperties: {type: 'number'},
    },
      ...(opts?.patch
      ? {
          cursorScript: {
            type: 'string',
            description:
              '鼠标动作脚本（鼠标跟随/录屏演示类模板的运镜驱动；素材无真实轨迹时用它在素材上合成「像真人操作」的鼠标轨迹）。' +
              'DSL：坐标为 0-1 归一化；首令牌「x,y」设起点；「> x,y @秒」滑动（@ 时长可省，按距离推）；「@秒」停顿；' +
              '「click」点击 /「dblclick」双击 /「right」右键 /「drag > x,y @秒」拖拽（按住滑到目标再抬起，点击落在目标处）/ ' +
              '「down」「up」手动按住配对 /「scroll +N @秒」滚轮 N 格（正=向下）/「type "文本" @秒」打字气泡（文本建议引号包裹）；' +
              '「hold」停顿到结尾；令牌用 | 分隔。' +
              '示例："0.2,0.8 > 0.45,0.5 @1.2 | click | type "登录" @1 | drag > 0.75,0.5 @1 | scroll +3 | hold"（滑到输入框→点击→打字→拖走→滚动页面）。' +
              '也接受结构化 JSON 数组 [{"kind":"move","x":0.45,"y":0.5,"sec":1.2},{"kind":"click"},{"kind":"drag","x":0.75,"y":0.5,"sec":1},{"kind":"scroll","ticks":3},{"kind":"type","text":"登录"}]。' +
              '传空串 "" 清除动作轨迹（素材回退真实录制轨迹或无轨迹）。设置后该段预览立即生效（点击运镜/聚焦蒙版/拖尾倾斜全套）。',
          },
          muted: {
            type: 'boolean',
            description: '段内第一段素材的原始声音静音开关（混剪/录屏演示段通常 true 只留 BGM；素材带人声讲解或关键现场声时 false）。只改 muted 时不动音量。',
          },
          volume: {
            type: 'number',
            description: '段内第一段素材的原始声音音量 0-1（1 = 原声全开；常配 muted:false 做「压低原声垫底」如 0.3）。与 muted 独立，可同 patch 一起传。',
          },
        }
      : {}),
  },
  ...(opts?.patch ? {} : {required: ['templateId'] as string[]}),
});

/** Optional shot-level plan accepted by set_storyboard. The schema stays compact so
 * the tool definition remains usable when the project contains many assets. */
const editPlanSchema: Record<string, unknown> = {
  type: 'object',
  description: '可选正式剪辑计划：beat/scene/shot 按时间排序，shot 用 sourcePath + 精确 sourceStartSec/sourceEndSec 指向素材；不传则由素材阶段自动编译。',
  properties: {
    beats: {type: 'array', items: {type: 'object', properties: {id: {type: 'string'}, index: {type: 'integer'}, text: {type: 'string'}, startSec: {type: 'number'}, endSec: {type: 'number'}}, required: ['id', 'index', 'startSec', 'endSec']}},
    scenes: {type: 'array', items: {type: 'object', properties: {id: {type: 'string'}, beatId: {type: 'string'}, index: {type: 'integer'}, startSec: {type: 'number'}, endSec: {type: 'number'}, title: {type: 'string'}}, required: ['id', 'beatId', 'index', 'startSec', 'endSec']}},
    shots: {type: 'array', items: {type: 'object', properties: {id: {type: 'string'}, beatId: {type: 'string'}, sceneId: {type: 'string'}, sourcePath: {type: 'string'}, sourceStartSec: {type: 'number'}, sourceEndSec: {type: 'number'}, timelineStartSec: {type: 'number'}, timelineEndSec: {type: 'number'}, templateId: {type: 'string'}, role: {type: 'string'}, confidence: {type: 'number'}}, required: ['id', 'beatId', 'sourcePath', 'sourceStartSec', 'sourceEndSec', 'timelineStartSec', 'timelineEndSec', 'confidence']}},
    audio: {type: 'array', items: {type: 'object', properties: {id: {type: 'string'}, type: {type: 'string', enum: ['narration', 'music', 'sfx']}, startSec: {type: 'number'}, endSec: {type: 'number'}, text: {type: 'string'}, sourcePath: {type: 'string'}, volume: {type: 'number'}}, required: ['id', 'type', 'startSec', 'endSec']}},
  },
};

/**
 * 全部 LLM 工具的注册表（顺序 = 发给模型的 toolDefs 顺序，勿随意调整）。
 * 新增工具在此加一条记录即可，schema / 系统提示词 / 测试断言自动跟随。
 */
export const LLM_TOOL_REGISTRY: LlmToolRegistryEntry[] = [
  {
    name: 'get_templates',    description: '获取可用视频模板的清单（id、名称、描述、素材数量要求、默认时长、叙事槽位、参数规格）。搭故事板前必须先调用。缺省按当前工程体裁过滤（其他体裁的专属模板不出现），传 videoType 可查指定体裁的清单；传 slot 可按叙事槽位进一步过滤（推荐用法：先定每段的叙事角色，再按槽位拉候选，清单更短更准）。',
    parameters: {
      type: 'object',
      properties: {
        videoType: {type: 'string', enum: VIDEO_TYPES, description: '按指定体裁过滤（缺省 = 当前工程体裁；想看全部营销模板时传 promo）'},
        slot: {type: 'string', enum: [...TEMPLATE_SLOTS], description: '按叙事槽位过滤：hook 开场钩子 / showcase 产品展示 / media 素材演绎 / data 数据数字 / proof 信任背书 / story 流程叙事 / cta 结尾行动'},
      },
    },
    promptHint: '查可用模板（搭故事板前必须先查；可按 slot 叙事槽位过滤，缺省按工程体裁过滤）',
  },
  {
    name: 'get_transition_templates',
    description: '获取转场模板清单：独立合成的衔接效果（吃上下两段的画面，自带音效与运镜），比内置转场更多样。返回 id/效果描述/衔接时长范围/叙事标签/参数规格。按上下段画面内容与叙事节奏选型；选中后在 update_segment 用 transitionTemplateId + transitionTemplateParams（挂在「上一段」上，作用到本段开头）。传 tag 可按叙事标签过滤。',
    parameters: {
      type: 'object',
      properties: {
        tag: {type: 'string', description: '按叙事标签过滤（如 运动连续 / 节奏卡点 / 场景切换 / 揭示）'},
      },
    },
    promptHint: '查转场模板清单（独立合成的衔接效果，比内置转场多样；按上下段内容与叙事选型）',
  },
  {
    name: 'search_templates',
    description: '按风格、画面动作、叙事槽位和主题语义检索模板目录，返回少量候选。模板库很大时必须先确定体裁/叙事职责/风格/动作，再按需调用本工具；不要用 get_templates 拉取全库。可传 needsMedia 筛选是否需要素材。',
    parameters: {
      type: 'object',
      properties: {
        videoType: {type: 'string', enum: VIDEO_TYPES, description: '按体裁过滤，缺省使用当前工程体裁'},
        slot: {type: 'string', enum: [...TEMPLATE_SLOTS], description: '叙事槽位：hook/showcase/media/data/proof/story/cta'},
        style: {type: 'string', enum: [...TEMPLATE_STYLES], description: '视觉风格：minimal/cinematic/editorial/tech/warm/bold/playful/documentary'},
        action: {type: 'string', enum: [...TEMPLATE_ACTIONS], description: '画面动作：static/reveal/slide/zoom/pan/split/compare/list/count/timeline/type/cursor/montage'},
        query: {type: 'string', description: '主题、素材或画面意图关键词（中英文均可）'},
        needsMedia: {type: 'boolean', description: '是否需要视频/图片素材（true 素材优先，false 零素材优先）'},
        limit: {type: 'integer', description: '返回数量，默认 8，最多 20'},
      },
    },
    promptHint: '按风格/动作/叙事槽位检索少量模板（大模板库优先使用）',
  },
  {
    name: 'generate_template',
    description: `现场生成一个个性化模板（AI 生成模板，gen- 前缀 id），解决「内置/市场模板都不满意」的场景——你可以写任意动画逻辑（文字编排/元素运动/媒体画框/背景装饰），生成后即可像内置模板一样被 set_storyboard / update_segment 的 templateId 引用渲染。
${GENERATED_TSX_CONTRACT}
【调用约定】扫描或编译失败会返回具体错误（含命中位置），修正后重新调用；传 templateId 可覆盖迭代同一模板（沿用 id，故事板引用不断）。生成成功后建议切一段到该模板用 preview_storyboard_frame 查看实际效果，不满意继续覆盖迭代。`,
    parameters: {
      type: 'object',
      properties: {
        name: {type: 'string', description: `模板名称（≤${GENERATED_NAME_MAX} 字）`},
        description: {type: 'string', description: `模板描述（≤${GENERATED_DESCRIPTION_MAX} 字）：适用场景/素材需求，给未来的自己和用户看`},
        code: {type: 'string', description: `受限 TSX 源码（≤${GENERATED_SOURCE_MAX} 字符），必须定义 const GeneratedTemplate = (props) => {...}`},
        defaultDuration: {type: 'number', description: '默认时长（秒，1-60，缺省 8）'},
        templateId: {type: 'string', description: '覆盖迭代：传入已有 gen- 模板 id（沿用 id，故事板引用不断）；缺省 = 新建'},
        textSlots: {
          type: 'array',
          description: '文字槽位声明：组件实际消费的 props.text 字段（缺省 = 未标注/覆盖迭代时沿用旧声明；[] = 不展示任何文字）。校验器据此对「文案给了但模板不展示」的字段发提醒',
          items: {type: 'string', enum: [...TEXT_SLOT_VALUES]},
        },
        paramSpecs: {
          type: 'array',
          description: `可选滑块参数（≤${GENERATED_PARAM_MAX} 个；组件内经 props.params.xxx 读取，UI「参数」页出现对应滑块）`,
          items: {
            type: 'object',
            properties: {
              key: {type: 'string', description: '参数键（组件内 params.key 读取）'},
              label: {type: 'string', description: 'UI 显示名'},
              min: {type: 'number'}, max: {type: 'number'}, step: {type: 'number'}, default: {type: 'number'},
              unit: {type: 'string', description: "显示单位（'×'/'°'/'s' 等，缺省 '×'）"},
            },
            required: ['key', 'label', 'min', 'max', 'step', 'default'],
          },
        },
      },
      required: ['name', 'code'],
    },
    promptHint: '现场生成个性化模板（受限 TSX 组件；内置/市场模板都不合适时用，可覆盖迭代）',
  },
  {
    name: 'review_template',
    description: '审查 AI 生成模板的实际渲染效果（generate_template 的配套自修回路）：用演示文案合成单段，渲染 2 个时间点的静帧（入场完成后 + 稳定段），交给多模态模型按模板维度打分（文字可读性/构图布局/品牌一致性/动画节奏/商业质感），返回结构化问题清单。生成或覆盖迭代模板后调用；按 suggestion 用 generate_template 传 templateId 覆盖迭代，再用本工具复审直到 pass。需配置多模态视觉模型。',
    parameters: {
      type: 'object',
      properties: {
        templateId: {type: 'string', description: 'AI 生成模板的 gen- id（generate_template 返回的 templateId）'},
        focus: {type: 'string', description: '审片侧重（可选，如「竖屏适配」「文字层级」「动画节奏」）'},
      },
      required: ['templateId'],
    },
    promptHint: '审查 AI 生成模板效果（生成/迭代后必做；按问题清单覆盖迭代直到 pass）',
  },
  {
    name: 'set_video_type',
    description: '设置工程的视频体裁（决定工作流剧本分册、系统提示词身份与 get_templates 的模板推荐口径，随工程保存）。做非宣传片内容（vlog / 口播 / 教程 / 卡点混剪）时先切换体裁，之后的建议按对应剧本给出；体裁只是推荐口径，不限制任何模板/工具的实际使用。',
    parameters: {
      type: 'object',
      properties: {
        videoType: {type: 'string', enum: VIDEO_TYPES, description: '体裁：promo 产品宣传片 / vlog 生活 vlog 与素材混剪 / talkingHead 口播讲解 / tutorial 教程演示 / montage 卡点混剪'},
      },
      required: ['videoType'],
    },
    promptHint: '设置视频体裁（宣传片/vlog/口播/教程/混剪；剧本与模板推荐随之切换）',
  },
  {
    name: 'get_storyboard',
    description: '获取当前故事板内容（各片段模板/文案/时长/转场/特效）。',
    parameters: {type: 'object', properties: {}},
    promptHint: '查看当前故事板内容（含各段字幕）',
  },
  {
    name: 'get_media_intelligence',
    description: '查询统一素材智能索引（镜头边界、动作发展、ASR/OCR 摘要与置信度）。默认只返回少量匹配素材，避免把数百条素材或全部帧数据塞进上下文；先用 query/role 缩小范围。',
    parameters: {
      type: 'object',
      properties: {
        query: {type: 'string', description: '素材名、描述、动作或场景关键词'},
        role: {type: 'string', enum: ['establish', 'setup', 'action', 'result', 'reveal', 'detail', 'proof', 'reaction', 'transition']},
        limit: {type: 'integer', description: '最多返回条数，默认 8，最多 20'},
      },
    },
    promptHint: '按动作/场景查询素材智能索引（返回紧凑时序摘要）',
  },
  {
    name: 'set_storyboard',
    description: '整体替换故事板。片段素材（录屏）一律留空，由用户后续上传；可选同时提交正式 shot-level editPlan，校验失败会返回错误，需修正后重试。',
    parameters: (deps) => ({
      type: 'object',
      properties: {
        segments: {type: 'array', items: segmentSpecSchema(deps), description: '1-60 个片段'},
        editPlan: editPlanSchema,
      },
      required: ['segments'],
    }),
    promptHint: '整体搭建/重排故事板（1-60 段；叙事性故事板建议 8-12 段，卡点混剪可更多）',
  },
  {
    name: 'update_segment',
    description: '修改故事板中某一个片段的部分字段（下标从 0 开始）。只需给出要修改的字段，未给出的字段保持原值不变；templateId 缺省 = 保留该段现有模板。修改后返回值带 applied 回读（应用后的模板/时长/文案/参数），可直接确认生效。',
    parameters: (deps) => ({
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起）'},
        patch: segmentSpecSchema(deps, {patch: true}),
      },
      required: ['index', 'patch'],
    }),
    promptHint: '微调某一段（模板/文案/时长/转场/特效/文字动效/旁白文案/字幕/模板参数 customParams）',
  },
  {
    name: 'get_segment_media',
    description: '获取某段已上传的素材清单（文件名/类型/时长/分辨率/裁剪区间/视口）。用户上传素材后调用，了解可用素材以决定裁剪与取景。',
    parameters: {
      type: 'object',
      properties: {index: {type: 'integer', description: '片段下标（0 起）'}},
      required: ['index'],
    },
    promptHint: '查看某段已上传素材的元数据（时长/分辨率/裁剪区间）',
  },
  {
    name: 'view_segment_frame',
    description: '抽取某段某视频在指定时间点的一帧画面并查看（需要多模态视觉模型，如 gpt-4o / qwen-vl / glm-4v）。用于判断素材内容、决定裁剪与取景。timeSec 缺省取视频中点。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起）'},
        videoIndex: {type: 'integer', description: '该段内视频下标（0 起，缺省 0）'},
        timeSec: {type: 'number', description: '抽帧时间点（秒，缺省取中点）'},
      },
      required: ['index'],
    },
    promptHint: '抽取某段某视频的一帧画面【看图，需多模态视觉模型】',
  },
  {
    name: 'get_template_slot_windows',
    description: '查询 3D 家族模板（穿越隧道/城市天际线/旋转中庭/环游展台/星域/艺廊/旅程）在给定时长下每块展板的驻留窗口。3D 画中画只在驻留窗口播放——素材精彩时刻必须落在对应槽位开头（素材本地 0 ~ dwellDurSec），否则会「内容还没放完就转场」。编排画中画取窗前必查；可用 focusPanel/focusBoost 给某块板单独加时。',
    parameters: {
      type: 'object',
      properties: {
        templateId: {type: 'string', description: '模板 id（七款 3D 家族之一，如 SpiralAtrium3D / OrbitCarousel3D / TimeTunnel3D）'},
        durationSec: {type: 'number', description: '段时长（秒）'},
        panelCount: {type: 'integer', description: '展板数（通常 = 画中画素材数与文案要点行数的较大者，上限 6）'},
        dwellRatio: {type: 'integer', description: '驻留节奏档 0快/1均衡/2长驻留/3特写驻留（缺省取模板注册表默认）'},
        focusPanel: {type: 'integer', description: '重点展板下标 0-5（给某块板单独加时）'},
        focusBoost: {type: 'number', description: '重点驻留倍率 1-2.5'},
        camSpeed: {type: 'integer', description: '镜头速度 0舒缓/1标准/2迅疾（舒缓档行进长、驻留短）'},
      },
      required: ['templateId', 'durationSec', 'panelCount'],
    },
    promptHint: '查询 3D 模板逐板驻留窗口（画中画取窗对齐用，纯计算无需视觉）',
  },
  {
    name: 'set_segment_trim',
    description: '裁剪某段某视频的可用区间（trimStart/trimEnd，秒），并可用 cuts 挖段——把中间一段抠掉、前后画面无缝拼接（如剪掉口误、加载等待、无关操作）。建议先用 view_segment_frame 看过画面后再选取最佳片段。cuts 给出即整体替换该素材的挖段列表（[] = 清空全部挖段），省略 = 保留现有挖段不变。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起）'},
        videoIndex: {type: 'integer', description: '该段内视频下标（0 起，缺省 0）'},
        trimStart: {type: 'number', description: '裁剪起始时间（秒，≥0）'},
        trimEnd: {type: 'number', description: '裁剪结束时间（秒，>trimStart）'},
        cuts: {
          type: 'array',
          description: '挖段列表（媒体绝对秒，落在 (trimStart, trimEnd) 内，自动钳制合并）：每项 {start, end} 抠掉 [start, end) 的画面。有效时长 = trimEnd−trimStart−Σ挖段长',
          items: {
            type: 'object',
            properties: {
              start: {type: 'number', description: '挖段起点（秒，媒体绝对时间）'},
              end: {type: 'number', description: '挖段终点（秒，需 > start）'},
            },
            required: ['start', 'end'],
          },
        },
      },
      required: ['index', 'trimStart', 'trimEnd'],
    },
    promptHint: '裁剪某段某视频（cuts 可挖掉中段无缝拼接）',
  },
  {
    name: 'mine_highlights',
    description: '从一段长素材（vlog 原片 / 口播录像 / 长录屏）挖出高光片段清单：本地静音检测 + ASR 转写 + 抽帧交给多模态视觉模型评估，返回带理由的保留区间（起止秒 + 内容摘要 + 保留原因），不改动工程。拿到清单后用 apply_cut_list 一次落地浓缩，或 split_segment 拆段分别包装。需多模态视觉模型；ASR 未配置/失败也能跑（缺文字线索，靠画面与语音窗口判断）。素材太短（<20s）请直接 set_segment_trim。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起）'},
        videoIndex: {type: 'integer', description: '该段内视频下标（0 起；缺省取段内时长最长的视频素材）'},
        targetDurationSec: {type: 'number', description: '期望浓缩后总时长（秒，10-180，缺省 60）'},
        maxSegments: {type: 'integer', description: '最多保留几段（2-60，缺省 8）'},
        focus: {type: 'string', description: '挑选侧重（如「只要做菜的部分」「保留有对话的画面」，≤100 字）'},
      },
      required: ['index'],
    },
    promptHint: '长素材挖高光：返回带理由的保留区间清单（先看后剪，不直接改工程）【需多模态】',
  },
  {
    name: 'apply_cut_list',
    description: '把保留区间清单落到某段素材，做「只留这几段」的浓缩剪辑：区间外全部挖掉（挖段无缝拼接、有效时长相应缩短），区间首尾成为新的可用边界，段时长自动对齐。mine_highlights 的落地一步；区间可来自挖矿结果，也可手动给出。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起）'},
        videoIndex: {type: 'integer', description: '该段内视频下标（0 起；缺省取段内时长最长的视频素材）'},
        keepRanges: {
          type: 'array',
          description: '保留区间列表（媒体绝对秒，1-24 段；重叠/近接自动合并，过短段丢弃）',
          items: {
            type: 'object',
            properties: {
              start: {type: 'number', description: '区间起点（秒，媒体绝对时间，≥0）'},
              end: {type: 'number', description: '区间终点（秒，需 > start）'},
            },
            required: ['start', 'end'],
          },
        },
      },
      required: ['index', 'keepRanges'],
    },
    promptHint: '把保留区间落地成浓缩剪辑（区间外挖段无缝拼接，段时长自动对齐）',
  },
  {
    name: 'set_segment_viewport',
    description: '设置某段某视频的取景视口：scale 缩放倍率（1=按适配显示，>1放大）、offsetX/offsetY 平移比例（-0.5~0.5，0=居中）。用于聚焦画面重点区域。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起）'},
        videoIndex: {type: 'integer', description: '该段内视频下标（0 起，缺省 0）'},
        scale: {type: 'number', description: '缩放倍率（0.1~5，缺省 1）'},
        offsetX: {type: 'number', description: '水平平移（-0.5~0.5，缺省 0）'},
        offsetY: {type: 'number', description: '垂直平移（-0.5~0.5，缺省 0）'},
      },
      required: ['index'],
    },
    promptHint: '设置取景视口（缩放/平移聚焦重点）',
  },
  {
    name: 'set_segment_overlay',
    description: '设置/调整某段的悬浮图片层（透明 PNG 浮在模板场景之上，带投影/缓浮，如 capture_element 截的 UI 元素）。x/y 为中心点归一化坐标（0-1，0.5/0.5=正中）；scale 为宽占画布比例；传 remove=true 移除。素材由 capture_element 生成（attachToSegment 可一步贴附）。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起）'},
        x: {type: 'number', description: '中心点 X（0~1，缺省不变）'},
        y: {type: 'number', description: '中心点 Y（0~1，缺省不变）'},
        scale: {type: 'number', description: '宽占画布比例（0.05~1，缺省不变）'},
        floatAmp: {type: 'number', description: '缓浮幅度倍率（0=静止，缺省不变）'},
        tiltX: {type: 'number', description: '3D 透视倾斜角 X（°，-30~30，缺省不变）'},
        tiltY: {type: 'number', description: '3D 透视倾斜角 Y（°，-30~30，缺省不变）'},
        radius: {type: 'number', description: '圆角 px（0~40，0=保持图片原始形状，缺省不变）'},
        shadow: {type: 'number', description: '投影强度倍率（0=无投影，缺省不变）'},
        opacity: {type: 'number', description: '不透明度 0~1（缺省不变）'},
        remove: {type: 'boolean', description: 'true = 移除该段悬浮层'},
      },
      required: ['index'],
    },
    promptHint: '设置/调整/移除某段的悬浮图片层（透明 PNG 悬浮卡片）',
  },
  {
    name: 'synthesize_narration',
    description: '对已填写旁白文案的段触发 TTS 语音合成（生成旁白音频）。index 缺省=全部有文案的段；speed 可调语速（0.5-2），voice 可覆盖音色（缺省用「设置 → TTS」里配置的默认音色）。结果里 overflowSec/overflowNote 标出旁白比段长的段（会溢出重叠到下一段），按提示提速重合成或用 update_segment 延长段。需先在「设置 -> TTS」配置。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起，缺省=全部段）'},
        speed: {type: 'number', description: '语速倍率 0.5-2（缺省沿用各段 narration.speed 或 1；改语速需重新合成）'},
        voice: {type: 'string', description: '音色名（如 alloy / nova / 云杰 等，视服务商而定；缺省用设置里的默认音色）'},
      },
    },
    promptHint: '对已填旁白文案触发 TTS 语音合成（可指定语速/音色）',
    sideEffect: true, // TTS 烧用户额度，执行前弹确认卡
  },
  {
    name: 'get_project_info',
    description: '获取项目整体信息：画幅比例、方向、总时长、片段数、是否有背景音乐、是否有旁白。做整体规划时调用。',
    parameters: {type: 'object', properties: {}},
    promptHint: '查看项目整体信息（画幅/总时长/片段数/BGM/旁白/字幕/Logo/避让）',
  },
  {
    name: 'scratch_pad',
    description: '你的工作草稿本（随工程保存， survives 上下文压缩与重开）：记录已完成的事、待办、关键决策与素材结论。长任务建议每完成一个里程碑就 append 一条；对话历史被自动压缩后，草稿是你找回工作状态的唯一线索。mode=read 读取全文，mode=append 追加一行，mode=replace 整体重写。',
    parameters: {
      type: 'object',
      properties: {
        mode: {type: 'string', enum: ['read', 'append', 'replace'], description: 'read 读 / append 追加 / replace 重写'},
        content: {type: 'string', description: 'append/replace 时的内容（read 时留空）'},
      },
      required: ['mode'],
    },
    promptHint: '读写工作草稿本（已完成/待办/决策，随工程保存，上下文压缩后靠它续接）',
  },
  {
    name: 'set_segment_captions',
    description: '设置某段的烧录字幕行（时间相对段起点）。建议从该段旁白文案切句生成，每行 ≤60 字、≤20 行，endSec 不超过段时长。传空数组清除该段字幕。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起）'},
        captions: {
          type: 'array',
          description: '字幕行数组（空数组 = 清除该段字幕）',
          items: {
            type: 'object',
            properties: {
              text: {type: 'string', description: '字幕文案（≤60 字）'},
              startSec: {type: 'number', description: '起始时间（秒，相对段起点，≥0）'},
              endSec: {type: 'number', description: '结束时间（秒，>startSec 且 ≤段时长）'},
            },
            required: ['text', 'startSec', 'endSec'],
          },
        },
      },
      required: ['index', 'captions'],
    },
    promptHint: '设置某段烧录字幕行（时间相对段起点；建议从旁白切句生成）',
  },
  {
    name: 'transcribe_segment_captions',
    description: '识别指定片段视频素材中的语音，自动生成该段的烧录字幕（自动切句并对齐时间，会覆盖该段已有字幕）。需用户已在「设置 -> 语音识别（ASR）」配置服务；素材无人声时可能返回 0 行。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起）'},
      },
      required: ['index'],
    },
    promptHint: '识别指定片段素材的语音生成字幕（需用户已配置 ASR）',
    sideEffect: true, // ASR 烧用户额度，执行前弹确认卡
  },
  {
    name: 'set_bgm_ducking',
    description: '设置背景音乐自动避让旁白：旁白响起时自动压低 BGM（带平滑过渡）。需先有背景音乐。amount=旁白期间 BGM 音量倍率（0.1~1，0.25=压到 25%，1=不压低）。',
    parameters: {
      type: 'object',
      properties: {
        enabled: {type: 'boolean', description: '是否启用避让'},
        amount: {type: 'number', description: '旁白期间 BGM 音量倍率（0.1~1，缺省 0.25）'},
      },
      required: ['enabled'],
    },
    promptHint: '开启/关闭背景音乐自动避让旁白（旁白响起时压低 BGM）',
  },
  {
    name: 'set_color_grade',
    description: '设置全片色彩统一（项目级）：色调风格预设 + 自动曝光匹配。色调预设把全片内容统一到同一风格（清冷商业/暖调胶片/青橙大片/黑白高对比/复古褪色/原生）；自动曝光匹配把多源素材（录屏/截图/本地文件）的亮度向全片中位数拉齐，消除拼凑感。字幕与 Logo 不被染色。',
    parameters: {
      type: 'object',
      properties: {
        look: {
          type: 'string',
          description: '色调预设 id：none=原生 / cleanCool=清冷商业 / warmFilm=暖调胶片 / tealOrange=青橙大片 / monoContrast=黑白高对比 / fadedRetro=复古褪色',
          enum: ['none', 'cleanCool', 'warmFilm', 'tealOrange', 'monoContrast', 'fadedRetro'],
        },
        autoMatch: {type: 'boolean', description: '自动曝光匹配开关（缺省不变）'},
      },
      required: ['look'],
    },
    promptHint: '设置全片色调预设与自动曝光匹配（色彩统一）',
  },
  {
    name: 'align_beats',
    description: '卡点对齐：把各片段切点与转场时长一起吸附到 BGM 的真实节拍网格上（切点压拍 + 转场时长落半拍，帧级精度带 BPM）。需已添加背景音乐（set_bgm 或用户手动添加均可）。建议在搭好故事板、确定各段顺序后调用一次；快切蒙太奇段（0.5-1.5s/段）用它能让整段节奏严丝合缝。返回移动的切点数、转场数、节拍数与 BPM。',
    parameters: {
      type: 'object',
      properties: {
        tolerance: {type: 'number', description: '吸附容差（秒，0.2~1.2，缺省 0.6）：切点距节拍超过该值则不动，避免大幅改变内容时长'},
      },
    },
    promptHint: '把各片段切点吸附到 BGM 节拍上（卡点；需先有 BGM）',
  },
  {
    name: 'auto_beat_montage',
    description: 'AI 卡点剪辑：读取 BGM 的音乐结构（节拍/重拍/段落/能量）与故事板全部视频素材的镜头运动强度，自动把素材切成压拍快切段并重建故事板——drop 段一拍一刀、build 两拍、安静段长镜头；切点全部落在真实节拍上（不是加闪烁特效，是真剪辑）。高能量段落配高运动镜头、安静段配稳镜头；素材自动轮换不连用。要求：已添加背景音乐 + 故事板已有视频素材。会重建故事板（原片段被替换，素材按剪辑计划重新裁剪分配到新片段）。创意控制：先用 get_footage_map 看素材镜头表，再用 directives 钉镜（开篇/收尾/首 drop 高光镜）或禁镜（画面差的镜头）；autoMoneyShot 一键把全场能量峰最高的镜头钉到首 drop 第一拍。搭好卡点混剪后建议再接 review_render 审片。',
    parameters: {
      type: 'object',
      properties: {
        targetSec: {type: 'number', description: '目标成片时长（秒，缺省 = BGM 全长）'},
        autoMoneyShot: {type: 'boolean', description: 'true = 自动把全场能量峰最高的镜头（高光镜）钉到第一个 drop 段的第一拍，制造「高光压重拍」钩子'},
        directives: {
          type: 'object',
          description: '创意指令（全部可选；镜头用 get_footage_map 返回的 {source 素材序号, shot 镜头下标} 引用）',
          properties: {
            openingShot: {type: 'object', properties: {source: {type: 'number'}, shot: {type: 'number'}}, description: '开篇镜：第一个槽位强制使用（定调）'},
            closingShot: {type: 'object', properties: {source: {type: 'number'}, shot: {type: 'number'}}, description: '收尾镜：最后一个槽位强制使用（落版记忆点）'},
            firstDropShot: {type: 'object', properties: {source: {type: 'number'}, shot: {type: 'number'}}, description: '高光镜：全片第一个 drop 段第一拍强制使用（高光压重拍）'},
            excludeShots: {type: 'array', items: {type: 'object', properties: {source: {type: 'number'}, shot: {type: 'number'}}}, description: '禁用镜头：从素材池剔除（画面差/黑场/内容重复）'},
            slotBeats: {type: 'object', description: '段落切镜密度覆盖（每槽拍数 1~8）：{drop: 1, build: 2, break: 2, intro: 4, outro: 4} 为缺省；调小 = 切更密'},
          },
        },
      },
    },
    promptHint: 'AI 卡点剪辑（按 BGM 结构自动切素材成片；支持钉镜/禁镜创意指令，需先有 BGM 和视频素材）',
  },
  {
    name: 'auto_screen_demo',
    description: '录屏即成品（一键编排）：把一段带鼠标轨迹的录屏（本软件「整屏录制」的素材自动记录轨迹）自动变成完整演示片故事板——标题钩子（节拍大字）+ 导播演示主段（按 M1 导播分析器的镜头计划在段内自动切大/中/小景：点击落小景特写+浮卡、停顿出大景、whoosh 模糊转场）+ 结尾 CTA。会重建故事板（原片段被替换）。缺省自动选 BGM（能量偏好 high）并把切点吸附到节拍。素材来源：传 path（录屏文件绝对路径）或不传（用当前故事板第一个视频素材，优先带轨迹）。注意：只有本软件录制的素材带轨迹；其他来源素材主段会退化为宽景缓推。搭好后建议 request_render 渲染，再 review_render 审片。',
    parameters: {
      type: 'object',
      properties: {
        path: {type: 'string', description: '录屏文件绝对路径（缺省 = 当前故事板第一个视频素材，优先带光标轨迹的）'},
        title: {type: 'string', description: '标题钩子文案（缺省「产品演示」）；建议一句话点出演示主体'},
        subtitle: {type: 'string', description: '标题钩子副文案（缺省空）'},
        ctaTitle: {type: 'string', description: '结尾 CTA 落版标题（缺省同 title）'},
        cta: {type: 'array', items: {type: 'string'}, description: '结尾 CTA 行动要点，每行一条（缺省[「立即下载体验」]）：官网/下载渠道/二维码指引等'},
        withBgm: {type: 'boolean', description: '自动选 BGM 并压拍（缺省 true；false = 不动音乐）'},
        wantMood: {type: 'string', enum: ['epic', 'upbeat', 'calm', 'sad', 'corporate', 'tense'], description: 'BGM 情绪偏好（可选）'},
        wantEnergy: {type: 'string', enum: ['high', 'mid', 'low'], description: 'BGM 能量偏好（缺省 high）'},
      },
    },
    promptHint: '录屏即成品（一段录屏一键变演示片：钩子+导播多镜头主段+CTA，自动 BGM 压拍）',
  },
  {
    name: 'auto_tutorial',
    description: '教程一键编排（auto_screen_demo 的教程变体）：把一段带鼠标轨迹的操作录屏自动变成结构化教程故事板——片头卡 + ([步骤卡「第 N 步」] + 该时间窗的导播演示主段) ×N + 结尾收束卡（教程无 CTA）。步骤切分自点击聚簇（间隔 ≤2.5s 同步、每步 ≥1.2s，过短并入前步，单素材上限 12 步），每步窗口内仍是导播镜头计划（点击特写/高亮描边/停顿大景）。缺省自动选 BGM（能量偏好 mid，教程气质平稳）并压拍。传 path（录屏绝对路径）或不传（用当前故事板第一个视频素材，优先带轨迹）。搭好后逐给每个步骤起标题（stepTitles，如「新建项目」「导入素材」），文案也可渲染前在故事板「文字」页改。',
    parameters: {
      type: 'object',
      properties: {
        path: {type: 'string', description: '操作录屏文件绝对路径（缺省 = 当前故事板第一个视频素材，优先带光标轨迹的）'},
        title: {type: 'string', description: '片头卡标题（缺省「操作教程」），如「三步做出卡点宣传片」'},
        subtitle: {type: 'string', description: '片头卡副文案（缺省空）'},
        stepTitles: {type: 'array', items: {type: 'string'}, description: '每步标题（按步骤序号顺序）：每步用一句动词短语概括这一步做什么（如「新建一个项目」）；只给确定的部分，其余留空由用户补'},
        outroTitle: {type: 'string', description: '结尾收束卡标题（缺省「搞定！」）'},
        withBgm: {type: 'boolean', description: '自动选 BGM 并压拍（缺省 true）'},
        wantMood: {type: 'string', enum: ['epic', 'upbeat', 'calm', 'sad', 'corporate', 'tense'], description: 'BGM 情绪偏好（可选）'},
        wantEnergy: {type: 'string', enum: ['high', 'mid', 'low'], description: 'BGM 能量偏好（缺省 mid）'},
      },
    },
    promptHint: '教程一键编排（操作录屏 → 步骤卡+导播段结构化教程片，自动 BGM）',
  },
  {
    name: 'align_music_structure',
    description: '音乐结构重排：把故事板段落边界吸附到 BGM 的音乐段落边界（intro/build/drop/break/outro，段落边界本就在重拍上），并按目标段能量选转场——drop/高能量边界 whip/flyThrough/cardSweep（轮换），中能量 slide/push/zoomIn，安静段 crossfade。不动模板/文案/素材，只调时长与转场类型。适用于常规模板故事板（卡点混剪请用 auto_beat_montage）。需已添加背景音乐。建议在故事板与素材就绪后、align_beats 之前调用（本工具做段落级粗对齐，align_beats 再做节拍级细吸附）。',
    parameters: {
      type: 'object',
      properties: {
        mode: {type: 'string', enum: ['fill', 'all'], description: '转场选型模式：fill=只补硬切边界、显式设置的转场保留（默认，手动工程安全）；all=全部边界按段能量重选（全自动流水线用）'},
        toleranceSec: {type: 'number', description: '边界吸附段落边界的容差（秒，0.3~5，缺省 1.5）：切点距段落边界超过该值则不动'},
      },
    },
    promptHint: '故事板段落对齐 BGM 音乐结构 + 转场按段能量选型（比 align_beats 更高一层的结构级卡点）',
  },
  {
    name: 'get_footage_map',
    description: '查看故事板全部视频素材的镜头表（剪辑大脑的画面理解层）：每个素材的镜头切分、各镜头的运动强度（0~1）与能量峰位置。做排片/卡点创意决策前先看它——高运动镜头留给 drop 段、稳镜头留给信息段、能量峰最高的镜头是天然的高光镜（可钉到首 drop 第一拍）。返回的素材序号与镜头下标可直接用于 auto_beat_montage 的 directives。',
    parameters: {type: 'object', properties: {}},
    promptHint: '查看素材镜头表（镜头切分/运动强度/能量峰，排片决策依据）',
  },
  {
    name: 'stabilize_clip',
    description: '一键跟踪稳定某段的视频素材（手持/走动拍摄的抖动画面）：自动在画面静止区选纹理最强的跟踪点（也可给 points 手动指定，视频像素坐标；1 个 = 平移稳定，2 个 = 平移+旋转+缩放），逐帧跟踪后施加反向校正，画面自动放大裁掉露出的边缘。只写入稳定数据，不动裁剪/文案/时长；分析耗时数秒到十几秒（30s 内素材）。手持/走动素材先稳定再排片。返回 zoom（>1 的部分即裁边比例）与 lostRatio（跟丢帧占比）——lostRatio>0.15 说明跟踪不稳，建议换跟踪点（放静止背景、纹理强处）用 set_stabilization(points) 重试。',
    parameters: {
      type: 'object',
      properties: {
        segmentIndex: {type: 'integer', description: '段下标（0 起）'},
        clipIndex: {type: 'integer', description: '段内素材下标（缺省 0）'},
        points: {
          type: 'array',
          description: '跟踪点（视频像素，1~2 个；缺省/空数组 = 自动选点做单点平移稳定）',
          items: {
            type: 'object',
            properties: {
              x: {type: 'number', description: '视频像素 x（≥0）'},
              y: {type: 'number', description: '视频像素 y（≥0）'},
            },
            required: ['x', 'y'],
          },
        },
        smoothSec: {type: 'number', description: '平滑强度（秒，0.2~2，缺省 0.8；越大越稳但保留的运镜越少）'},
      },
      required: ['segmentIndex'],
    },
    promptHint: '一键跟踪稳定某段视频素材（手持/走动抖动画面先稳定再排片；可自动选点，返回放大倍率与跟丢率）',
  },
  {
    name: 'set_stabilization',
    description: '调整某段视频素材已有的跟踪稳定：enabled 开关（关闭不清数据，随时开回）、smoothSec 调强度（只重算平滑，毫秒级，不重分析）、points 换跟踪点（给出即重跑跟踪分析，秒级；素材还没有稳定数据时给 points 等价于 stabilize_clip）。三个字段至少给一个。',
    parameters: {
      type: 'object',
      properties: {
        segmentIndex: {type: 'integer', description: '段下标（0 起）'},
        clipIndex: {type: 'integer', description: '段内素材下标（缺省 0）'},
        enabled: {type: 'boolean', description: '开/关稳定（缺省不变；数据保留）'},
        smoothSec: {type: 'number', description: '平滑强度（秒，0.2~2，缺省不变；只重算不重分析）'},
        points: {
          type: 'array',
          description: '换跟踪点（视频像素，1~2 个；给出即重跑分析）',
          items: {
            type: 'object',
            properties: {
              x: {type: 'number', description: '视频像素 x（≥0）'},
              y: {type: 'number', description: '视频像素 y（≥0）'},
            },
            required: ['x', 'y'],
          },
        },
      },
      required: ['segmentIndex'],
    },
  },
  {
    name: 'add_ground_text',
    description: '在某段视频的地面平面上放置 3D 文字（AR 贴地效果，随镜头平移/推近/走动保持钉在地面）：一键全自动——素材还没有地面追踪数据时先自动分析（数秒），再加元素。form 三种形态：flat 躺平大字（贴地投影风）/ billboard 立起面板（广告牌，有真实透视高度）/ extruded 立体厚度字。位置 u/v 为参考帧画面归一化坐标（0~1，y 向下，缺省画面下半中央），size 为宽度占画面比例（缺省 0.13，别贪大——镜头走近时元素按真实透视放大）。返回 applied 回读与追踪质量（残差>4px 或锚点<5 建议换画面纹理更丰富的素材）。',
    parameters: {
      type: 'object',
      properties: {
        segmentIndex: {type: 'integer', description: '段下标（0 起）'},
        text: {type: 'string', description: '文字内容（建议 ≤10 字，躺平大字 ≤6 字）'},
        form: {type: 'string', enum: ['flat', 'billboard', 'extruded'], description: '形态：flat 躺平 / billboard 立起面板 / extruded 立体厚度字'},
        clipIndex: {type: 'integer', description: '段内素材下标（缺省 0）'},
        u: {type: 'number', description: '水平位置 0~1（缺省 0.5）'},
        v: {type: 'number', description: '垂直位置 0~1（缺省 0.6~0.58；地面通常在画面下半）'},
        size: {type: 'number', description: '宽度占画面比例 0.03~0.8（缺省 0.13）'},
        yawDeg: {type: 'number', description: '平面内朝向（度；缺省不设 = 自动面向镜头——立起面板正面/躺平文字正立方向随相机自动转，一般无需填写）'},
        pitchDeg: {type: 'number', description: '立体倾斜（-90~90 度，缺省 0）：躺平/立体文字 ±90 = 竖立面向 yaw 方向；立起面板 = 前倾后仰'},
        rollDeg: {type: 'number', description: '自身平面内旋转（-180~180 度，缺省 0）'},
        depth: {type: 'number', description: '厚度倍率 0.2~3（缺省 1；仅 extruded 立体字 = 挤出厚度）'},
        color: {type: 'string', description: '颜色 #rrggbb（缺省品牌强调色）'},
        entrance: {type: 'string', enum: ['rise', 'fade', 'none'], description: '入场：rise 升起（缺省）/ fade 淡入 / none'},
      },
      required: ['segmentIndex', 'text', 'form'],
    },
    promptHint: '在视频地面放 3D 文字（躺平/立起/立体，随镜头透视钉在地面；无追踪数据自动先分析）',
  },
  {
    name: 'add_ground_shape',
    description: '在某段视频的地面平面上放置 3D 形状（内置几何体，AR 贴地）：一键全自动（无追踪数据先自动分析）。form：plate 立牌 / box 立方体 / cylinder 圆柱 / cone 锥体。参数语义同 add_ground_text（size 缺省 0.1，v 缺省 0.55）。',
    parameters: {
      type: 'object',
      properties: {
        segmentIndex: {type: 'integer', description: '段下标（0 起）'},
        form: {type: 'string', enum: ['plate', 'box', 'cylinder', 'cone'], description: '形状：plate 立牌 / box 立方体 / cylinder 圆柱 / cone 锥体'},
        clipIndex: {type: 'integer', description: '段内素材下标（缺省 0）'},
        u: {type: 'number', description: '水平位置 0~1（缺省 0.5）'},
        v: {type: 'number', description: '垂直位置 0~1（缺省 0.55）'},
        size: {type: 'number', description: '宽度占画面比例 0.03~0.8（缺省 0.1）'},
        yawDeg: {type: 'number', description: '平面内朝向（度；立牌缺省自动面向镜头，一般无需填写）'},
        pitchDeg: {type: 'number', description: '立体倾斜（-90~90 度，缺省 0）：立牌 = 前倾后仰；几何体 = 整体倾倒'},
        rollDeg: {type: 'number', description: '自身平面内旋转（-180~180 度，缺省 0）'},
        depth: {type: 'number', description: '高度倍率 0.2~3（缺省 1；box/cylinder/cone 有效）'},
        color: {type: 'string', description: '颜色 #rrggbb（缺省品牌强调色）'},
        entrance: {type: 'string', enum: ['rise', 'fade', 'none'], description: '入场：rise 升起（缺省）/ fade 淡入 / none'},
      },
      required: ['segmentIndex', 'form'],
    },
    promptHint: '在视频地面放 3D 形状（立牌/立方体/圆柱/锥体，随镜头透视钉在地面）',
  },
  {
    name: 'update_ground_element',
    description: '调整某段已放置的 3D 地面元素（改文案/位置/大小/朝向/倾斜/旋转/厚度/颜色/入场/透明度），或用 remove_ground_element 删除。id 与 add_ground_text/add_ground_shape 返回对应。注：元素默认无 yawDeg = 自动面向镜头；传 yawDeg 数字后固定朝向。',
    parameters: {
      type: 'object',
      properties: {
        segmentIndex: {type: 'integer', description: '段下标（0 起）'},
        id: {type: 'string', description: '元素 id'},
        text: {type: 'string', description: '改文字（仅文字元素）'},
        u: {type: 'number', description: '水平位置 0~1'},
        v: {type: 'number', description: '垂直位置 0~1'},
        size: {type: 'number', description: '宽度占画面比例 0.03~0.8'},
        yawDeg: {type: 'number', description: '平面内朝向（度；传数字则从自动朝向切到固定）'},
        pitchDeg: {type: 'number', description: '立体倾斜（-90~90 度）：躺平/立体文字竖立、立起面板前倾后仰'},
        rollDeg: {type: 'number', description: '自身平面内旋转（-180~180 度）'},
        depth: {type: 'number', description: '厚度倍率 0.2~3（extruded 挤出厚度 / 几何体高度）'},
        color: {type: 'string', description: '颜色 #rrggbb'},
        entrance: {type: 'string', enum: ['rise', 'fade', 'none'], description: '入场方式'},
        opacity: {type: 'number', description: '不透明度 0~1'},
      },
      required: ['segmentIndex', 'id'],
    },
    promptHint: '调整已放置的 3D 地面元素（位置/大小/朝向/倾斜/旋转/厚度/颜色/文案）',
  },
  {
    name: 'remove_ground_element',
    description: '删除某段已放置的 3D 地面元素；id 缺省 = 清空该段全部地面元素。',
    parameters: {
      type: 'object',
      properties: {
        segmentIndex: {type: 'integer', description: '段下标（0 起）'},
        id: {type: 'string', description: '元素 id（缺省 = 清空该段全部地面元素）'},
      },
      required: ['segmentIndex'],
    },
    promptHint: '删除 3D 地面元素（缺省 id = 清空该段全部）',
  },
  {
    name: 'set_ground_tracking',
    description: '调整某段视频素材的 3D 地面追踪：enabled 开关（关闭后该素材上的 3D 地面元素不再渲染，数据保留）、reanalyze 重新分析（换 trim 段落/追踪质量不佳时用，秒级）。与稳定互不冲突（可叠加）。',
    parameters: {
      type: 'object',
      properties: {
        segmentIndex: {type: 'integer', description: '段下标（0 起）'},
        clipIndex: {type: 'integer', description: '段内素材下标（缺省 0）'},
        enabled: {type: 'boolean', description: '开/关地面追踪（缺省不变）'},
        reanalyze: {type: 'boolean', description: 'true = 重新自动分析（秒级）'},
      },
      required: ['segmentIndex'],
    },
    promptHint: '调整地面追踪开关/重新分析',
  },
  {
    name: 'get_music_map',
    description: '查看当前 BGM 的音乐结构图（剪辑大脑的音乐理解层）：BPM、节拍/重拍网格、段落结构（intro/build/drop/break/outro 与各段能量）、逐拍编排数据（beats 拍点时间与逐一对齐的 beatEnergies 能量、beatKicks 底鼓强度、beatSnares 军鼓/镲强度，均 0..1）。卡点/排片决策前先看它——钩子压 drop 第一拍、转场/切镜压 beatKicks 强的重鼓点拍、弱拍保持不硬切、缓段留给信息展示；逐拍数组支持精确到拍的编排（如「每 4 拍一个切点、kick>0.8 的拍放转场」）。需已添加背景音乐。',
    parameters: {type: 'object', properties: {}},
    promptHint: '查看 BGM 音乐结构图（段落/逐拍能量/鼓点强度，卡点决策依据）',
  },
  {
    name: 'set_logo',
    description: '调整已上传 Logo 的位置/大小/透明度/显隐。Logo 图片由用户在「品牌」面板上传，本工具只调整其呈现；若用户尚未上传会返回提示。',
    parameters: {
      type: 'object',
      properties: {
        position: {type: 'string', enum: ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'], description: '位置（缺省不变）'},
        size: {type: 'number', description: '占画布宽度比例（0.05~0.4，缺省不变）'},
        opacity: {type: 'number', description: '不透明度 0~1（缺省不变）'},
        visible: {type: 'boolean', description: '是否显示（缺省不变）'},
      },
    },
    promptHint: '调整已上传 Logo 的位置/大小/透明度/显隐（图片由用户上传）',
  },
  {
    name: 'set_fine_print',
    description: '设置全片常驻的边缘小字（免责声明/版权/「本片由 AI 生成」等），渲染在画面底部边缘，小字淡显。text 传空串 = 清除。',
    parameters: {
      type: 'object',
      properties: {
        text: {type: 'string', description: '小字内容（≤200 字，支持 \\n 多行；空串 = 清除）'},
        position: {type: 'string', enum: ['bottomLeft', 'bottomCenter', 'bottomRight'], description: '位置（缺省不变）'},
        opacity: {type: 'number', description: '不透明度 0.2~1（缺省不变；小字宜淡，建议 0.4~0.6）'},
        sizeScale: {type: 'number', description: '字号倍率 0.6~1.6（缺省不变，1 = 约画布高 1.6%）'},
      },
    },
    promptHint: '设置/清除边缘小字（免责声明等常驻小字）',
  },
  {
    name: 'set_brand_style',
    description: '设置品牌样式（项目级）：品牌色 + 字体氛围。品牌色统一全片模板的强调色/渐变/光晕/字幕条（建议从用户 Logo/网站取色，一个片子只用一个主色）；字体氛围成套切换全片标题/正文字体。两项都可选，至少传一项；预览与渲染即时生效，随工程保存。',
    parameters: {
      type: 'object',
      properties: {
        brandColor: {type: 'string', description: '品牌色 #RRGGBB（如 #F97316 活力橙 / #16A34A 生长绿 / #7C3AED 星云紫）；传 "default" 恢复默认蓝；缺省不变'},
        fontMood: {type: 'string', enum: ['sleek', 'warm', 'tech', 'display'], description: '字体氛围（缺省不变）：sleek=商业冷峻（MiSans，缺省）/ warm=温暖手写（霞鹜文楷，vlog/餐饮/文创）/ tech=科技等宽（开发者工具/代码教程）/ display=英文展示（Poppins 几何感，出海产品）'},
      },
    },
    promptHint: '设置品牌色与字体氛围（全片统一的强调色与字体）',
  },
  {
    name: 'set_project_style',
    description: '设置项目级样式（五项全可选，至少给一项）：字幕样式 captionStyle（位置/字号倍率/字色/底色不透明度/出现动效，浅合并——只改给出的字段）、画面质感 texture（clean 干净无叠加 / film 胶片轻暗角+细颗粒 / cinema 电影重暗角+颗粒+扫柔光）、节拍脉冲 beatPulse（有 BGM 且检出节拍时画面随鼓点微缩放+光效闪动）、音效配置 sfx（enabled 总开关 / volume 音量 / transitionWhoosh 转场音效 / beatImpact 节拍重音 / introRiser 片头揭示音，浅合并）、看图预算 frameBudget（view_media_frames 附图总量上限 0-200，0=不限，缺省 12；多素材工程看不过来时用它放宽，预算紧张时引导模型先 contact-sheet）。品牌色/字体氛围走 set_brand_style，色调/曝光走 set_color_grade，Logo 走 set_logo，边缘小字走 set_fine_print——不要调本工具。',
    parameters: {
      type: 'object',
      properties: {
        captionStyle: {
          type: 'object',
          description: '字幕样式（浅合并，只改给出的字段）',
          properties: {
            position: {type: 'string', enum: ['bottom', 'top', 'center'], description: '字幕位置（bottom 底部最常见）'},
            fontSizeScale: {type: 'number', description: '字号倍率 0.5~2.5（1 = 基准字号）'},
            color: {type: 'string', description: '字色 #RRGGBB（如 #FFFFFF）'},
            bgOpacity: {type: 'number', description: '底色不透明度 0~1（0 = 透明无底色）'},
            anim: {type: 'string', enum: ['line', 'wordPop'], description: '出现动效：line 整行淡入（默认）/ wordPop 逐词弹出（卡拉OK 式）'},
          },
        },
        texture: {type: 'string', enum: ['clean', 'film', 'cinema'], description: '画面质感：clean 干净无叠加 / film 胶片（轻暗角+细颗粒）/ cinema 电影（重暗角+颗粒+扫柔光）'},
        beatPulse: {type: 'boolean', description: '节拍脉冲开关（需有 BGM 且检出节拍才生效；无 BGM 时设置也不出错）'},
        sfx: {
          type: 'object',
          description: '音效配置（浅合并）',
          properties: {
            enabled: {type: 'boolean', description: '音效总开关（false = 完全不放音效）'},
            volume: {type: 'number', description: 'SFX 轨道整体音量 0~1'},
            transitionWhoosh: {type: 'boolean', description: '转场中点自动放匹配音效（硬切不放）'},
            beatImpact: {type: 'boolean', description: '节拍落点自动放 impact（需 BGM 波形数据）'},
            introRiser: {type: 'boolean', description: '片头自动放 riser 品牌揭示音'},
          },
        },
        frameBudget: {type: 'integer', description: '工程看图预算：view_media_frames 附图总量上限 0-200（0=不限，缺省 12）——多素材看不过来时放宽，预算紧时模型会先 contact-sheet 扫全片再定点高清抽帧'},
      },
    },
    promptHint: '设置字幕样式/画面质感/节拍脉冲/音效/看图预算（项目级样式五合一，浅合并）',
  },
  {
    name: 'request_render',
    description: '请求开始渲染视频。MCP 通道直接后台渲染（无确认卡）；界面 AI 助手路径会弹渲染确认。前置条件：已设置「默认输出目录」（未设置时返回引导信息）。渲染中/完成后用 get_app_status 轮询进度与输出路径，lastRender.matchesCurrent 可确认成片内容是否等于当前工程内容。智能块缓存默认开：改过文案/参数/素材的段自动重渲，未变段直接拼接缓存（迭代审片只需几秒）——修改后直接 request_render 即可，无需担心全片重渲成本。',
    parameters: {type: 'object', properties: {}},
    promptHint: '请求渲染（MCP 通道后台直接开始；用 get_app_status 轮询）',
    sideEffect: true, // 渲染占用 CPU 且写输出目录；界面助手路径仍保留确认卡
  },
  {
    name: 'get_app_status',
    description:
      '读取片语应用状态：应用版本、授权状态、当前工程名、是否有未保存更改、是否正在渲染及进度/输出路径，以及最近一次渲染的回读 lastRender（输出路径/耗时/内容指纹/matchesCurrent——指纹与当前工程内容一致即「成片就是当前版本」，dirtySinceRender=true 说明渲染后又改过内容需重渲）。request_render 触发渲染后用它轮询进度；也透出代理转码 proxyJobs 与全自动流水线 autoPipeline 进度。',
    parameters: {type: 'object', properties: {}},
    promptHint: '读应用状态与渲染进度（request_render 后用它轮询 matchesCurrent）',
  },
  {
    name: 'list_capture_sources',
    description: '列出可录制的屏幕与应用窗口（OBS 式源清单，含屏幕分辨率）。录屏/截屏前调用以选择源（返回的 id 原样传给其他录屏工具）。',
    parameters: {type: 'object', properties: {}},
    promptHint: '列出可录制的屏幕/窗口（录屏截屏前先查）',
  },
  {
    name: 'take_screenshot',
    description: '截取某个屏幕/窗口当前画面并查看（需要多模态视觉模型，如 gpt-4o / qwen-vl / glm-4v）。可仅查看画面，也可同时保存为图片素材加入指定片段。窗口需未被最小化。',
    parameters: {
      type: 'object',
      properties: {
        sourceId: {type: 'string', description: 'capture 源 id（从 list_capture_sources 获取），缺省主屏'},
        saveToStoryboard: {type: 'boolean', description: '是否把截图保存为图片素材加入片段（缺省 false = 仅查看画面）'},
        segmentIndex: {type: 'integer', description: '加入素材的目标段下标（0 起，缺省当前选中段）'},
      },
    },
    promptHint: '截取屏幕/窗口画面【看图，需多模态】，可仅查看或保存为图片素材',
    sideEffect: true, // 屏幕内容会发往第三方 AI 端点，执行前弹确认卡
  },
  {
    name: 'capture_element',
    description: '把片语界面中的某个 UI 元素截成透明背景 PNG（CSS 选择器定位，如 AI 助手输入框）——用于做「悬浮 UI」镜头（元素浮在演示画面上，带投影/缓浮）。attachToSegment 给出段下标时一步贴附为该段悬浮层（之后用 set_segment_overlay 调位置/大小）。截取的是应用自身界面，不含外部窗口内容。',
    parameters: {
      type: 'object',
      properties: {
        selector: {type: 'string', description: 'CSS 选择器（如 ".ai-input-box"）。元素必须当前可见'},
        attachToSegment: {type: 'integer', description: '贴附为悬浮层的目标段下标（0 起，缺省 = 仅截图不入段）'},
        scale: {type: 'number', description: '贴附时宽占画布比例（0.05~1，缺省 0.4）'},
      },
      required: ['selector'],
    },
    promptHint: '把界面元素截成透明 PNG（可做悬浮层素材）【看图，需多模态】',
    sideEffect: true, // 界面内容截图会发往第三方 AI 端点（看图回传），执行前弹确认卡
  },
  {
    name: 'import_segment_media',
    description: '把本地视频/图片/3D 模型文件（mp4/webm/mov/png/jpg/glb 等）导入为指定片段的素材，返回元数据（时长/分辨率）。用户已有录好的素材时用它直接导入，比重新录一遍快；导入后可用 view_segment_frame 看图、set_segment_trim 裁剪、set_segment_viewport 取景。.glb 模型素材配 ModelTurntable 等 3D 模板用（仅支持未压缩单文件 glb，勿用 draco 压缩/.gltf 多文件）。mxf/超大(>2GB)/4K+ 素材导入后自动后台生成 960 宽代理（响应带 proxy 字段；编辑/抽帧/预览走代理，渲染自动回源，get_app_status 的 proxyJobs 可查转码进度）。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '目标段下标（0 起）'},
        path: {type: 'string', description: '媒体文件的本地绝对路径'},
      },
      required: ['index', 'path'],
    },
    promptHint: '导入本地视频/图片文件为片段素材（mxf/超大/4K 自动后台代理）',
    sideEffect: true, // 读取用户指定的本地文件，执行前弹确认卡
  },
  {
    name: 'set_media_colorspace',
    description: '设置某视频素材的 Log 色彩曲线（电影机 log 灰片恢复正常色）。设置后：已有代理将按新曲线重新生成（编辑/抽帧/预览即恢复正常色），渲染回源前自动经 Log→709 技术转换 LUT 一次性转码。导入时会按拍摄设备元数据自动猜（Sony/DJI/BMD 自动填；Canon C-Log2/C-Log3 与 ARRI LogC3/LogC4 有机型歧义，导入响应的 colorCurveGuessNote 会提示确认）。传 colorCurve: "none" 清除标记（普通素材勿用本工具）。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '段下标（0 起）'},
        videoIndex: {type: 'integer', description: '段内视频素材下标（0 起，缺省 0）'},
        colorCurve: {type: 'string', enum: ['none', ...COLOR_CURVE_IDS], description: '色彩曲线：slog3=Sony S-Log3 / clog2=Canon C-Log2 / clog3=Canon C-Log3 / logc3=ARRI LogC3(EI800) / logc4=ARRI LogC4(ALEXA 35) / dlog=DJI D-Log / bmdfilm5=BMD Film Gen5 / none=清除（普通素材）'},
      },
      required: ['index', 'colorCurve'],
    },
    promptHint: '设置素材 Log 色彩曲线（灰片恢复正常色；代理与渲染链路自动跟随）',
  },
  {
    name: 'start_screen_recording',
    description: '开始录制屏幕/窗口画面（画面/麦克风无需用户操作；withSystemAudio 需真实用户手势，若返回 needsUserGesture 错误请引导用户在录屏弹窗手动点击开始）。可用 countdownSec 倒计时起录，给用户留出切到目标窗口的时间（调用会阻塞倒计时结束后才起录）。开始后回复用户「请开始操作，完成后说一声」，等用户回复完成后再调用 stop_screen_recording 保存——你无法在单次对话中计时等待。可先用 list_capture_sources 按名称挑源（或直接给 sourceName 模糊匹配）、用 take_screenshot 看一眼画面再定 region 选区；fps/maxHeight 控制画质与输出分辨率（默认 30fps 满分辨率）；layout 让摄像头与屏幕一起烧录成素材（画中画/分屏/仅摄像头，会自动请求摄像头）。',
    parameters: {
      type: 'object',
      properties: {
        sourceId: {type: 'string', description: 'capture 源 id（从 list_capture_sources 获取），缺省主屏；与 sourceName 二选一，同时给出时 sourceId 优先'},
        sourceName: {type: 'string', description: '按源名称/窗口标题模糊匹配（大小写不敏感子串，如 "Chrome"、"设置"）。唯一命中直接用；多命中会报错并列出候选，请改用 sourceId'},
        withMic: {type: 'boolean', description: '是否同时录制麦克风（缺省 false）'},
        withSystemAudio: {type: 'boolean', description: '是否同时录制系统声音（缺省 false；需真实用户手势，可能返回 needsUserGesture 错误）'},
        layout: {
          type: 'string',
          enum: RECORDING_LAYOUTS,
          description: '画面构成（缺省不启用摄像头，纯屏幕）：pip=摄像头圆角画中画叠角落 / side=屏幕与摄像头左右分屏拼接 / stack=上下分屏拼接 / camera=仅摄像头全画幅（口播出镜素材，不录屏幕，region 无效）。给了 layout 会自动开启摄像头（权限被拒会报错）',
        },
        countdownSec: {type: 'integer', description: '起录前倒计时秒数（0-10，缺省 0 立即起录）；给用户切窗口留时间，调用会阻塞 countdownSec 秒后才开始录制'},
        region: {
          type: 'object',
          description: '选区录制（仅屏幕源）：只录屏幕上一块矩形区域，坐标为视频像素（原点左上，x 向右 y 向下；屏幕物理分辨率见 list_capture_sources 的 width/height）。宽高至少 320×180，越界部分自动钳回屏幕内；建议先 take_screenshot 看过画面再选',
          properties: {
            x: {type: 'integer', description: '选区左上角横坐标（≥0）'},
            y: {type: 'integer', description: '选区左上角纵坐标（≥0）'},
            width: {type: 'integer', description: '选区宽度（≥320）'},
            height: {type: 'integer', description: '选区高度（≥180）'},
          },
          required: ['x', 'y', 'width', 'height'],
        },
        fps: {type: 'integer', description: '录制帧率（10-60，缺省 30）。界面演示类 30 足够；有快速运动画面可上 60（文件更大）'},
        maxHeight: {type: 'integer', description: '输出画面高度上限（像素，如 1080/720/480；缺省不缩 = 原始分辨率）。源更高时等比缩小到该高度（宽同比例、偶数取整），源更矮时不放大。录 4K 屏但只出 1080p 素材时用它省体积'},
        bitrateMbps: {type: 'number', description: '视频码率 Mbps（2-40，缺省按分辨率自动：约 1080p30=8）。画面细节多或有运动模糊时调高'},
      },
    },
    promptHint: '录制屏幕/窗口并保存为视频素材（无需用户操作）',
    promptName: 'start_screen_recording / stop_screen_recording', // 提示词里与 stop 合并为一行展示
    sideEffect: true, // 录屏持续采集屏幕内容，执行前弹确认卡
  },
  {
    name: 'stop_screen_recording',
    description: '停止当前录制，保存为 webm 视频素材并加入指定片段。可带 trimStartSec/trimEndSec 在入段时直接掐头去尾（与 set_segment_trim 同语义，省去再次调用）。保存后可用 view_segment_frame 看图、set_segment_trim 裁剪。',
    parameters: {
      type: 'object',
      properties: {
        segmentIndex: {type: 'integer', description: '加入素材的目标段下标（0 起，缺省当前选中段）'},
        trimStartSec: {type: 'number', description: '可用区间起点（秒，相对素材开头，≥0，可选）；入段后直接落裁剪'},
        trimEndSec: {type: 'number', description: '可用区间终点（秒，需 > trimStartSec，可选）；超出素材时长会被钳到时长'},
      },
    },
    // 提示词「你能做什么」一节由 start_screen_recording 的合并行覆盖，不单列
  },
  {
    name: 'get_capture_status',
    description: '查询录屏状态：是否录制中、已录时长（秒）、源名称。',
    parameters: {type: 'object', properties: {}},
    promptHint: '查询录屏状态（是否录制中/已录时长）',
  },
  {
    name: 'view_media_frames',
    description: '一次抽取某素材（视频/图片）多个时间点的画面并查看（需多模态视觉模型，如 gpt-4o / qwen-vl / glm-4v）。最多 8 帧；timesSec 缺省在「实际可用区间」（裁剪+挖段之后）上均匀取点，不会抽到已被剪掉的画面，返回值带段内相对秒，可直接换算 trim/字幕时间。用于快速浏览整段素材内容、决定裁剪区间；传 path 也可查看已渲染成片的画面。长素材先用 mode=contact-sheet（缩略图墙：一张拼图扫全片百帧，配返回的时间表定位）再对锁定时段高清抽 2-3 帧——工程看图预算有限（默认 12 帧，响应带剩余量），别一上来逐帧抽。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起；查看故事板素材时用，取该段第一个视频素材）'},
        path: {type: 'string', description: '媒体文件本地路径（查看已渲染成片等文件时用，与 index 二选一）'},
        timesSec: {type: 'array', items: {type: 'number'}, description: '抽帧时间点（秒，媒体绝对时间，≤8 个；给了就按点抽，缺省在可用区间均匀采样）'},
        count: {type: 'integer', description: '缺省采样数量 2-8（缺省 4）；只影响缺省采样，给了 timesSec 时忽略'},
        mode: {type: 'string', enum: ['frames', 'contact-sheet'], description: 'frames = 普通抽帧（缺省）；contact-sheet = 缩略图墙（一张 cols×rows 拼图 + 每格时间表，扫全片只花 1 帧预算——长素材浏览首选）'},
        cells: {type: 'integer', description: 'contact-sheet 格数 10-144（缺省 100 = 10×10）'},
      },
    },
    promptHint: '一次抽取某素材多帧画面浏览内容（自动跳过裁剪/挖段区间）；长素材先 contact-sheet 一张扫全片【看图，需多模态】',
  },
  {
    name: 'scan_media',
    description: '对某段视频素材跑场景检测（镜头切分）：本地解码分析零 token，产出镜头清单（每个镜头的起止秒/时长/运动强度 0-1）并缓存进素材（随工程保存，重复调用零成本）。多素材排片前先 scan 全部素材——纯文本清单直接定位「哪段素材哪个时间窗在动/在静」，比抽帧看图省几个数量级预算；配合 view_media_frames 的 contact-sheet（视觉确认）与 set_segment_trim（按镜头边界裁剪）使用。运动强度高的镜头适合卡点快切/高光位，低的适合长镜叙事。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起）'},
        videoIndex: {type: 'integer', description: '段内视频素材下标（0 起，缺省 0）'},
      },
      required: ['index'],
    },
    promptHint: '场景检测：镜头切分 + 运动强度清单（纯文本零 token，缓存进素材）',
  },
  {
    name: 'split_segment',
    description: '把某个片段在指定秒数处拆成两段：前半段时长 atSec，后半段接续剩余时长并插在原段之后（后续段下标顺延）。视频素材的裁剪区间自动按拆点划分（前半播到 trimStart+atSec，后半从 trimStart+atSec 起播）；文案/字幕/旁白等两段各自保留一份副本。用于把一段长素材拆成两个镜头，分别配不同模板/文案。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起）'},
        atSec: {type: 'number', description: '拆点（秒，相对段起点；拆分后两半各至少 0.5s）'},
      },
      required: ['index', 'atSec'],
    },
    promptHint: '把某段在指定秒数处拆成两段（视频裁剪区间自动划分）',
  },
  {
    name: 'undo',
    description: '撤销最近一步工程改动（自己刚做的修改、用户或回写产生的改动都可以撤）。返回被撤销的操作名与来源。适用：发现自己上一步改错了（改错段/错值/多余改动）时，先 undo 回退再给出正确修改——不要用反向修改去覆盖错误（多字段错改时反向修补容易留残留）。一次只撤一步；连续 undo 可逐步回退。',
    parameters: {type: 'object', properties: {}},
    promptHint: '撤销最近一步改动（改错先撤再改对，别反向覆盖）',
  },
  {
    name: 'delete_segment',
    description: '删除故事板中的一个片段（整段连同其素材/文案/旁白一起移除，后续段下标前移）。至少保留一段——只剩一段时返回错误，此时可改用 update_segment 换内容替代删除。删除废镜头、压缩片长时用。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '要删除的片段下标（0 起）'},
      },
      required: ['index'],
    },
    promptHint: '删除某个片段（至少保留一段）',
    sideEffect: true,
  },
  {
    name: 'move_segment',
    description: '调整片段在故事板中的顺序：把下标 fromIndex 的段移动到 toIndex 位置（其余段顺次腾位）。先删后加会丢素材关联，重排镜头顺序一律用它。',
    parameters: {
      type: 'object',
      properties: {
        fromIndex: {type: 'integer', description: '要移动的片段当前下标（0 起）'},
        toIndex: {type: 'integer', description: '移动后的目标下标（0 起，按移动前的段序计；即从列表里抽出该段后插入的位置）'},
      },
      required: ['fromIndex', 'toIndex'],
    },
    promptHint: '调整片段顺序（重排镜头）',
    sideEffect: true,
  },
  {
    name: 'remove_segment_media',
    description: '移除某个片段里指定的一个素材（视频/图片），段本身与文案保留。段内只剩这一个素材时不允许移除（请改用 delete_segment 或先补充素材）。录废了一条、导入错了文件时用；重新查看可用 get_segment_media。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '片段下标（0 起）'},
        videoIndex: {type: 'integer', description: '该段内素材下标（0 起，顺序同 get_segment_media 返回）'},
      },
      required: ['index', 'videoIndex'],
    },
    promptHint: '移除某段中的一个素材（保留段落本身）',
    sideEffect: true,
  },
  {
    name: 'preview_storyboard_frame',
    description: '把当前故事板在指定时间点渲染成一帧成片画面并查看（需多模态视觉模型，如 gpt-4o / qwen-vl / glm-4v）。timeSec 为全片时间轴上的秒数（各段时长累加）。用于导出前自检整体效果（文案/字幕/构图/转场），可迭代调参后再次查看。',
    parameters: {
      type: 'object',
      properties: {
        timeSec: {type: 'number', description: '全片时间轴上的时间点（秒，缺省 0）'},
      },
    },
    promptHint: '渲染故事板某时刻的成片画面自检【看图，需多模态】',
  },
  {
    name: 'review_render',
    description: '审片（本地体检 + 视觉评审双半边）：本地可读性体检零成本先跑（13 字/秒停留、行 ≤30 字、要点 ≤5 条、字幕行宽/停留、hook 前 3 秒密度），有成片时再按段自动抽帧交给多模态视觉模型打分（首帧钩子/文字可读性/动效一致性/色调统一/字幕安全区/整体商业感，1-5 分）。返回结构化问题清单与修改建议（问题带 segmentIndex，便于局部改稿后重渲）。暂无成片时只返回本地体检结果（渲染前就能改文案）；视觉评审需先 render 且 LLM 配置为视觉模型。',
    parameters: {
      type: 'object',
      properties: {
        path: {type: 'string', description: '成片文件路径（须为本应用渲染产物或已注册媒体；缺省=最近一次渲染输出）'},
        focus: {type: 'string', description: '审片侧重（如「标题可读性」「节奏」，≤100 字）；缺省全面审查'},
      },
    },
    promptHint: '渲染后审片：抽帧打分拿问题清单，据 segmentIndex 局部改稿再重渲【需多模态】',
  },
  {
    name: 'export_cover',
    description: '生成视频封面：取当前故事板指定时刻的一帧，叠加自由文字图层（字体/字号/描边/3D 挤出/自由拖放位置），导出为封面图（JPG/PNG，存入输出目录，随工程记住封面配置）。文案缺省链：参数 → 已存封面配置 → 发布元数据标题 → 首段标题。add3dText 可追加 3D 立体大字并放到画面主体后面（自动主体遮挡检测）。返回封面图供自查，建议先 review_render 看过全片再选帧。',
    parameters: {
      type: 'object',
      properties: {
        timeSec: {type: 'number', description: '选帧时刻（秒，0~全片时长；缺省用已保存配置）'},
        preset: {type: 'string', description: "版式预设（重排已存图层的文字位置，保留文案）：'bottomLeft' 底部渐变左下标题（默认，最通用）/ 'centerPoster' 居中海报 / 'leftBand' 左侧渐变 / 'topBand' 顶部渐变（主体在画面下半时用）"},
        title: {type: 'string', description: '封面主标题（≤60 字；缺省走文案缺省链）'},
        subtitle: {type: 'string', description: '封面副标题（可选）'},
        tag: {type: 'string', description: '标签角标文案，如「新品上线」（可选，带品牌蓝底色条）'},
        scrim: {type: 'number', description: '背景压暗强度 0~1（默认 0.55；画面本身偏暗可调低）'},
        format: {type: 'string', description: "'jpg'（默认，体积小适合上传）或 'png'（无损）"},
        add3dText: {type: 'object', description: '追加一个 3D 立体文字图层（大字氛围/品牌词，默认放到画面主体后面形成前后遮挡）', properties: {
          text: {type: 'string', description: '文字内容'},
          x: {type: 'number', description: '锚点 x（0-1，默认 0.5）'},
          y: {type: 'number', description: '锚点 y（0-1，默认 0.42）'},
          size: {type: 'number', description: '字号 px（默认 190，范围 40-400）'},
          color: {type: 'string', description: '文字颜色 hex（默认 #FFFFFF）'},
          sideColor: {type: 'string', description: '挤出侧面颜色 hex（默认取文字色加深）'},
          depth: {type: 'number', description: '挤出深度 px（默认 16，0=平面）'},
          angle: {type: 'number', description: '挤出方向 deg（默认 45=右下；0=右 90=下）'},
          behind: {type: 'boolean', description: 'true=渲染到画面主体后面（自动遮挡检测，默认 true）'},
        }, required: ['text']},
      },
    },
    promptHint: '生成封面图（成片衍生品，含 3D 文字与主体遮挡玩法）【返回图片可自查】',
  },
  {
    name: 'set_publish_metadata',
    description: '设置/更新发布元数据（视频标题/简介/话题标签），随工程文件保存，发布时可打开「渲染导出 → 封面与发布信息」按平台（抖音/B站/小红书/视频号/YouTube）一键复制组装好的文案。部分更新：只给要改的字段。标签不带 #，自动清洗去重。返回各平台字数校验（超限给警告，不阻断）。',
    parameters: {
      type: 'object',
      properties: {
        title: {type: 'string', description: '视频标题（各平台上限不同：抖音 55 / B站 80 / 小红书 20 / YouTube 100 字）'},
        description: {type: 'string', description: '视频简介/描述/文案'},
        tags: {type: 'array', items: {type: 'string'}, description: '话题标签数组（不带 #；也接受逗号/空格分隔的字符串）'},
      },
    },
    promptHint: '设置发布元数据（标题/简介/标签，随工程保存）',
  },
  {
    name: 'search_stock_media',
    description: '搜索免费商用免署名的 stock 素材（Pexels/Pixabay 聚合，需在「设置 → Stock 素材搜索」配好至少一家的免费 API Key）。返回候选清单（前几张附缩略图），选中后用 import_stock_media 下载导入片段。搜索词用英文命中更多（如 "city timelapse"）。',
    parameters: {
      type: 'object',
      properties: {
        query: {type: 'string', description: '搜索词（英文命中更多）'},
        type: {type: 'string', enum: ['video', 'photo'], description: '素材类型（缺省 video）'},
        orientation: {type: 'string', enum: ['landscape', 'portrait', 'square'], description: '画面方向（缺省不限；square 仅 Pexels 支持）'},
        perPage: {type: 'integer', description: '每家最多取几条（1-20，缺省 8）'},
      },
      required: ['query'],
    },
    promptHint: '搜索免费商用 stock 素材（视频/图片，返回候选清单）',
  },
  {
    name: 'import_stock_media',
    description: '把 search_stock_media 选中的素材下载并导入为指定片段的素材（域名白名单校验后落本地缓存，免署名可商用）。provider/id/type/downloadUrl 原样传搜索结果里带回的值。',
    parameters: {
      type: 'object',
      properties: {
        index: {type: 'integer', description: '目标段下标（0 起）'},
        provider: {type: 'string', enum: ['pexels', 'pixabay']},
        id: {type: 'string', description: '搜索结果里的素材 id'},
        type: {type: 'string', enum: ['video', 'photo']},
        downloadUrl: {type: 'string', description: '搜索结果返回的下载直链（原样传回，主进程做域名白名单校验）'},
      },
      required: ['index', 'provider', 'id', 'type', 'downloadUrl'],
    },
    promptHint: '下载选中的 stock 素材并导入片段',
    sideEffect: true, // 下载烧流量与磁盘
  },
  {
    name: 'generate_image',
    description: '文生图：生成背景/插画等图像素材（OpenAI 兼容 /images/generations，与 AI 助手共用端点与 Key，模型名在「设置 → 文生图」配置，如 dall-e-3）。给 index 时直接加入该段素材，不给则只生成并返回路径。相同提示词命中本地缓存不重复计费。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {type: 'string', description: '画面描述（英文通常效果更好；写清主体/风格/构图/光影）'},
        index: {type: 'integer', description: '目标段下标（缺省=仅生成不导入）'},
        size: {type: 'string', description: 'WxH（如 1792x1024 横版 / 1024x1792 竖版，各边 256-4096；缺省 1792x1024）'},
      },
      required: ['prompt'],
    },
    promptHint: '文生图生成背景/插画素材（可直接入段）',
    sideEffect: true, // 生图烧额度
  },
  {
    name: 'generate_model',
    description: '文生 3D：文本提示词生成 .glb 3D 模型素材并导入指定段（未指定则当前选中段）。需先在「设置 → 文生 3D」配置 API Key（去 meshy.ai 申请；服务地址/模型名可换成 Meshy 兼容服务）。生成耗时约 1-3 分钟，工具会等待完成；产物为未压缩 .glb（仅未压缩 glb 链路），配 ModelTurntable 等 3D 模板用（裁剪/取景对模型无意义）。相同提示词命中本地缓存不重复计费。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {type: 'string', description: '模型外观描述（英文通常效果更好；写清主体/材质/风格，如 "a low-poly cartoon rocket, glossy red paint"）'},
        index: {type: 'integer', description: '目标段下标（缺省 = 当前选中段）'},
        artStyle: {type: 'string', description: '艺术风格（可选，如 realistic / cartoon，视服务商支持而定）'},
      },
      required: ['prompt'],
    },
    promptHint: '文生 3D 生成 .glb 模型素材（可直接入段，需在设置 → 文生 3D 配 Key）',
    sideEffect: true, // 3D 生成烧额度
  },
  {
    name: 'analyze_media_tags',
    description: '对故事板里已有的视频/图片素材做视觉打标（多模态模型看抽帧）：每条素材产出内容描述、情绪、适配场景，结果随工程记住并在 get_project_info 透出。用途：让 AI 知道每条素材是什么，从而把文案与素材自动对位（写故事板/换素材前先跑一遍）。',
    parameters: {type: 'object', properties: {}},
    promptHint: '视觉打标全部素材（内容/情绪/场景），供文案与素材自动对位【需多模态】',
  },
  {
    name: 'set_bgm',
    description: '设置背景音乐（本地曲库；曲库目录在「声音 → 背景音乐」里指定）。不传 track 时返回曲库清单：含自动推导的情绪/能量档（文件名关键词 + 波形分析）与时长。可按曲名选（部分匹配），也可只给 wantMood/wantEnergy 让工具自动挑最匹配的。传 track="none" 清除 BGM。配完用 set_bgm_ducking 调避让。',
    parameters: {
      type: 'object',
      properties: {
        track: {type: 'string', description: '曲名（部分匹配；"none" = 清除 BGM）'},
        volume: {type: 'number', description: '音量 0-1（缺省 0.35）'},
        volumeKeys: {
          type: 'array', maxItems: 24,
          description: '音量包络关键点（时间轴音量线）：[{sec, volume}]，sec 相对 BGM 起播点（秒）、volume 0-1 为相对倍率，相邻点线性过渡、两端外保持端值。适合叙事性强弱：如开场强 [{sec:0,volume:1},{sec:4,volume:0.35},{sec:12,volume:1}]。传 [] 清除。不传 track 只传它 = 只改现有 BGM 的包络不换曲（需已添加 BGM）。',
          items: {type: 'object', properties: {sec: {type: 'number'}, volume: {type: 'number'}}, required: ['sec', 'volume']},
        },
        wantMood: {type: 'string', enum: ['epic', 'upbeat', 'calm', 'sad', 'corporate', 'tense'], description: '想要的情绪（不指定曲名时按此自动挑）'},
        wantEnergy: {type: 'string', enum: ['high', 'mid', 'low'], description: '想要的能量档（配合 wantMood）'},
      },
    },
    promptHint: '设置/查询背景音乐（曲库清单含情绪/能量推导）',
  },
  {
    name: 'analyze_render_audio',
    description: '成片音频体检（纯本地 ffmpeg 探测）：综合响度（对照 -14 LUFS 投放标准与偏离值）、峰值爆音、中段长静音；可选 ASR 转写与旁白文案比对（漏读/错读关键词清单）。审片的音频半边，与 review_render（视觉）互补——渲完先跑这两个再决定改不改。',
    parameters: {
      type: 'object',
      properties: {
        path: {type: 'string', description: '成片路径（缺省=最近一次渲染输出）'},
        checkTranscript: {type: 'boolean', description: '是否 ASR 转写比对文案（需配置 ASR；缺省 true，未配置自动跳过）'},
      },
    },
    promptHint: '成片音频体检：响度/爆音/静音 + 旁白比对',
  },
  {
    name: 'run_auto_pipeline',
    description: '全自动流水线：一句话需求（brief）进 → 按工程体裁切换编导剧本（产品宣传片/生活 vlog/口播讲解/教程演示/卡点混剪，体裁用 set_video_type 改）→ AI 写脚本并搭建故事板 → 自动配素材（已有素材优先，其次 stock 搜索/文生图，都不可用则改用零素材模板）→ vlog/口播/教程体裁遇 ≥60s 长素材自动挖高光浓缩 → 可选 TTS 旁白 → 渲染 → VLM 审片 → 高危问题自动改稿重渲 → 封面 + 发布元数据。异步启动、立即返回，用 get_app_status 轮询 autoPipeline 字段看逐步进度与产物路径。要用户先过目计划：传 plan_only=true 只出成片计划（不执行不改工程），用户确认或改完后再带 segments（计划原样或修改版）执行。前置：已配置 AI 助手（视觉模型可解锁审片与挖高光）与默认输出目录。',
    parameters: {
      type: 'object',
      properties: {
        brief: {type: 'string', description: '需求描述（产品/受众/卖点/风格/时长偏好，越具体越好，≤500 字）'},
        targetDurationSec: {type: 'number', description: '目标总时长秒（8-90，缺省约 30）'},
        aspectRatioId: {type: 'string', description: '画幅比例 id（缺省用当前工程画幅）'},
        reviewRounds: {type: 'integer', description: '审片后自动改稿重渲的轮数上限 0-2（缺省 1）'},
        narration: {type: 'boolean', description: '是否合成旁白（需配置 TTS；缺省 true，未配置/失败自动跳过不阻断）'},
        materials: {type: 'string', enum: ['auto', 'existing-only', 'stock-first', 'imagegen-first'], description: '配素材策略（缺省 auto）'},
        planOnly: {type: 'boolean', description: 'true = 只生成成片计划并返回（一次 LLM 调用，不执行、不改工程）；与 segments 互斥'},
        segments: {type: 'array', items: {type: 'object'}, description: '已确认/修改过的故事板计划（plan_only 返回的 segments 原样或人工修改版）；给出时跳过脚本生成直接执行，校验失败原样报错不会自动重写（保护人工修改）'},
      },
      required: ['brief'],
    },
    promptHint: '全自动流水线：一句话需求到成片+封面+元数据（异步启动，get_app_status 轮询进度）',
    sideEffect: true, // 会渲染/调 LLM/TTS/生图，烧额度
  },
  {
    name: 'save_project',
    description: '把当前工程保存为 .vtproj 工程文件（含全部片段/素材引用/BGM/样式设置）。不传 path 时保存到当前工程文件（从未保存过则报错）；传 path（以 .vtproj 结尾、父目录需已存在）时保存到指定位置并设为当前工程文件。建完故事板或做完重大修改后建议调用一次，避免依赖 30 秒自动保存。',
    parameters: {
      type: 'object',
      properties: {
        path: {type: 'string', description: '保存路径（绝对路径，.vtproj 结尾；缺省 = 保存到当前工程文件，无则报错）'},
      },
    },
    promptHint: '保存当前工程到 .vtproj 文件（可指定路径；防丢稿）',
  },
  {
    name: 'load_project',
    description: '打开一个 .vtproj 工程文件（绝对路径），替换当前故事板与全部工程内容。当前工程有未保存更改时会弹确认卡请用户放行。返回工程名/片段数/缺失素材清单。',
    parameters: {
      type: 'object',
      properties: {
        path: {type: 'string', description: '工程文件绝对路径（.vtproj）'},
      },
      required: ['path'],
    },
    promptHint: '打开指定路径的工程文件（替换当前工程内容）',
  },
  {
    name: 'consolidate_project',
    description: '收集工程引用的全部本地素材（片段视频/图片、鼠标轨迹与稳定 sidecar、BGM、Logo、悬浮层图片、import 旁白音频）复制到指定目录的 media/ 子目录（同名冲突自动改名、同内容跳过），重写工程内引用指向新位置，并把工程保存为 <dir>/<工程名>.vtproj——得到自包含、可整体搬走/换机/归档的工程包。工程交付或换机前用它；只是保存引用不复制素材时用 save_project。',
    parameters: {
      type: 'object',
      properties: {
        dir: {type: 'string', description: '目标目录绝对路径（不存在会创建；素材进 <dir>/media/，工程存为 <dir>/<工程名>.vtproj）'},
      },
      required: ['dir'],
    },
    promptHint: '收集全部素材到指定目录并保存自包含工程（交付/换机/归档前）',
    sideEffect: true, // 复制素材文件 + 保存工程，写盘操作
  },
  {
    name: 'computer_run_task',
    description: '让电脑执行一个 GUI 操作任务（内置 computer-use 引擎：本地 sidecar 服务循环「截屏 → 多模态模型看图决策 → 操控鼠标键盘」）。任务在后台异步执行，本工具只负责发起并立即返回 taskId——用 computer_status 轮询进度与结果，computer_stop 中途停止。适合「打开示例工程并浏览模板」「在资源管理器里找到某文件」这类需要真实桌面操作的请求；只是改片语故事板内容时不要用它（用故事板系列工具）。执行期间请提醒用户不要同时操作鼠标。屏幕截图会持续发往你配置的 AI 端点。maxSteps 限制最大步数防失控（缺省 30）；filmMode=true 用拟人贝塞尔轨迹移动鼠标（拍宣传片素材时用）。需配置多模态视觉模型。',
    parameters: {
      type: 'object',
      properties: {
        task: {type: 'string', description: '要让电脑做什么的自然语言描述（越具体越好，含完成判据，≤500 字）'},
        maxSteps: {type: 'integer', description: '最大执行步数（1-200，缺省 30；一步 = 一次截屏+决策+动作）'},
        filmMode: {type: 'boolean', description: '拍片模式：拟人贝塞尔轨迹移动鼠标（宣传片素材拍摄用，缺省 false）'},
      },
      required: ['task'],
    },
    promptHint: '让电脑执行 GUI 任务（截屏+操控鼠标键盘，异步；用 computer_status 轮询）【需多模态】',
    sideEffect: true, // 操控用户整机键鼠 + 屏幕截图发往 AI 端点，执行前弹确认卡
  },
  {
    name: 'computer_status',
    description: '查询电脑任务的执行状态（computer_run_task / computer_play_script 返回的 taskId）：running/done/error、success 与结果摘要。任务在后台执行，发起后用本工具轮询直到 done/error。',
    parameters: {
      type: 'object',
      properties: {
        taskId: {type: 'string', description: '任务 id（computer_run_task / computer_play_script 返回的 taskId）'},
      },
      required: ['taskId'],
    },
    promptHint: '查询电脑任务状态（按 taskId 轮询）',
  },
  {
    name: 'computer_stop',
    description: '协作式停止正在执行的电脑任务（当前动作完成后停下，鼠标键盘控制权立即归还用户）。用户说「停下/别动了」或任务明显跑偏时调用。',
    parameters: {
      type: 'object',
      properties: {
        taskId: {type: 'string', description: '要停止的任务 id'},
      },
      required: ['taskId'],
    },
    promptHint: '停止正在执行的电脑任务',
  },
  {
    name: 'computer_play_script',
    description: '确定性回放一段已录制的动作脚本（script.jsonl：鼠标/键盘动作序列，无需模型参与，逐动作重放 + 可选画面校验）——宣传片拍摄的重放链路：先用 computer_run_task 把操作跑通一遍录下脚本，确认无误后用本工具反复确定性重拍（配合录屏工具采集素材）。异步执行，立即返回 taskId，用 computer_status 轮询进度与校验结果。会真实移动鼠标键盘，执行期间请提醒用户不要同时操作鼠标。',
    parameters: {
      type: 'object',
      properties: {
        scriptPath: {type: 'string', description: '动作脚本文件绝对路径（script.jsonl，computer_use 脚手架录制产物）'},
        verify: {type: 'boolean', description: '逐动作画面校验（缺省 true；校验失败会中止并报偏差点）'},
        filmMode: {type: 'boolean', description: '拍片模式：拟人贝塞尔轨迹移动鼠标（缺省 false）'},
      },
      required: ['scriptPath'],
    },
    promptHint: '确定性回放已录制的动作脚本（宣传片重拍用，异步）',
    sideEffect: true, // 真实操控鼠标键盘，执行前弹确认卡
  },
  // ====== agent 面时间线工具（P2.5 阶段三 v3，2026-10-02）：时间语义操作面 ======
  // 时间轴 = 「何时有什么」；模板/文案/特效仍走 update_segment。布局与 UI 时间轴同源
  // （shared/timeline-layout + shared/bgm-track），返回值即所见。v6 蒸馏时按需并入 EDGE 面。
  {
    name: 'get_timeline',
    description: '读取剪辑时间轴的紧凑全景（与用户在时间轴视图看到的一致）：每个片段的起点/时长/素材裁剪窗（=shot 的媒体出入点）/出场转场（类型+时长+音效）/旁白偏移，BGM 的起播点/截取窗/循环窗/淡入淡出/节拍数，全片总时长。做时间语义判断（卡点/节奏/对位/时长预算）或批量改前先读这一份，比逐段 get_storyboard + get_segment_media 省得多。',
    parameters: {
      type: 'object',
      properties: {},
    },
    promptHint: '读时间轴全景（片段起点/时长/素材窗/转场/旁白偏移 + BGM 定位 + 节拍）——时间语义操作前的唯一入口',
  },
  {
    name: 'get_segment_plan',
    description: '读取某片段的「模板制作指导投影」（v1.3 additive）：模板内部结构投射成时间线原语的只读视图——beats 段内节拍标记（点击/卡驻留/段落浮现等，含秒+帧与说明）、captions 模板自身排版的文字行（文本+起止窗）、mediaWindows 素材槽窗（媒体出入点）。按白名单开放（materializable 清单回读；未开放字段不出现）。段内坐标（0=段内容起点），绝对时刻 = get_timeline 的 startSec + 段内秒。首批模板：鼠标跟随运镜/白板画布/文档面板；其余模板 ok:false 并列出已开放清单。',
    parameters: {
      type: 'object',
      properties: {
        segmentIndex: {type: 'integer', description: '片段下标（0 起）'},
      },
      required: ['segmentIndex'],
    },
    promptHint: '定点查某段的节拍/字幕窗/素材窗投影（做节奏判断或改文案/素材前的先验）',
  },
  {
    name: 'set_segment_beats',
    description: '整组设置/清除某片段的「手放节拍标记」（v1.4 additive，L2 节拍层原语）：在段内标记时刻点 [{t 段内秒, kind: accent(重拍/强调)|mark(普通), target?(主体人话), note?(备注)}]。合成时与 BGM 拍点并流成该段节拍网格，踩拍/逐拍生长类模板自动消费（逐词砸入、逐拍生长对齐到标记时刻）——**没有 BGM 也生效**，手工卡点不需要音乐。与 get_segment_plan 返回的推导节拍（模板会怎么动的只读投影）是两回事：这是你放的输入标记。整组替换语义（与 set_segment_captions 同构）；beats 缺省或空数组 = 清除该段全部标记。每段至多 32 个；t 必须 ∈ [0, 段时长)（超界返回错误）。写后 get_timeline 的 clips[i].beats 回读。',
    parameters: {
      type: 'object',
      properties: {
        segmentIndex: {type: 'integer', description: '片段下标（0 起）'},
        beats: {
          type: 'array',
          description: '节拍标记整组（缺省/空 = 清除）',
          items: {
            type: 'object',
            properties: {
              t: {type: 'number', description: '段内秒（0.1 步进钳制）'},
              kind: {type: 'string', enum: ['accent', 'mark'], description: 'accent=重拍/强调点；mark=普通标记'},
              target: {type: 'string', description: '节拍主体（人话，如「第三行」「卡 2」；可选）'},
              note: {type: 'string', description: '备注（可选）'},
            },
            required: ['t', 'kind'],
          },
        },
      },
      required: ['segmentIndex'],
    },
    promptHint: '手工卡点（无音乐也要踩准）/ 强调重点时刻（accent）/ 审片反馈落节拍层（如「这里太赶删个标记」）',
  },
  {
    name: 'set_bgm_position',
    description: '设置 BGM 在成片时间轴上的定位：起播点 startAtSec（>0 = 前段静音，如旁白先进、副歌后起）、截取窗 trimStartSec/trimEndSec（掐前奏/截副歌；循环只铺窗内）、淡入淡出与音量。数值自动钳制（循环窗最短 2s；起播点 ≤ 片长−1）。典型用法：J-cut 声音先行（钩子文字前 BGM 先起 → startAtSec 设小或 0）、掐前奏直接进副歌（trimStartSec 对齐副歌起点）。改完节拍类工具（align_beats 等）自动按新位置对齐。',
    parameters: {
      type: 'object',
      properties: {
        startAtSec: {type: 'number', description: '成片时间轴起播点（秒，≥0；缺省不变）'},
        trimStartSec: {type: 'number', description: '素材截取起点（秒，[0, 素材时长−2]；缺省不变）'},
        trimEndSec: {type: 'number', description: '素材截取终点（秒，[截取起点+2, 素材时长]；缺省不变）'},
        fadeInSec: {type: 'number', description: '淡入时长（秒，0-8，从起播点起算；缺省不变）'},
        fadeOutSec: {type: 'number', description: '淡出时长（秒，0-8，锚定片尾；缺省不变）'},
        volume: {type: 'number', description: '音量 0-1（缺省不变）'},
      },
    },
    promptHint: '调 BGM 时间轴定位（起播点/截取窗/淡入淡出/音量；J-cut 与掐前奏用）',
  },
  {
    name: 'set_narration_timing',
    description: '设置某段旁白的段内时序：offsetSec 偏移（0 = 段起点开口；>0 = 等转场/前奏过去再开口，钳制在本段范围内）与音量。文案与生成仍走 update_segment / synthesize_narration，本工具只管「何时开口、多大声」。',
    parameters: {
      type: 'object',
      properties: {
        segmentIndex: {type: 'integer', description: '片段下标（0 起）'},
        offsetSec: {type: 'number', description: '段内起播偏移（秒，[0, 该段时长]，0.1 步进；缺省不变）'},
        volume: {type: 'number', description: '旁白音量 0-1（缺省不变）'},
      },
      required: ['segmentIndex'],
    },
    promptHint: '调旁白段内偏移/音量（等转场过去再开口）',
  },
  {
    name: 'reorder_segments',
    description: '按新顺序整体重排故事板片段：order 必须是全部下标 0..n-1 的一个排列（如 [2,0,1] = 原第 3 段排最前）。转场归属随片段走（原 A→B 的转场仍是 A 的出场转场）。一次到位，比多次相邻移动省调用；撤销为一步。改完建议 get_timeline 复检新时间轴。',
    parameters: {
      type: 'object',
      properties: {
        order: {type: 'array', items: {type: 'integer'}, description: '新顺序（旧下标数组，长度 = 片段数，必须是 0..n-1 的排列）'},
      },
      required: ['order'],
    },
    promptHint: '整体重排片段顺序（一次到位；转场随片段走）',
  },
  {
    name: 'move_shot',
    description: '把一个素材 shot（段内素材）跨段搬移或段内重排：素材对象整体搬迁，裁剪窗/取景视口/音频设置全部保留。典型用法：把高光镜头挪到 CTA 段压轴、把主素材与辅素材归位同一段做画中画叠层（同段多素材 = layered shot）。position 缺省 = 追加到目标段末尾。shot 的稳定 id 与媒体出入点见 get_timeline 的 shots 字段；改完建议 get_timeline 复检归属。',
    parameters: {
      type: 'object',
      properties: {
        fromSegmentIndex: {type: 'integer', description: '源段下标（0 起）'},
        clipIndex: {type: 'integer', description: '源段内素材下标（0 起，即 shots[].clipIndex）'},
        toSegmentIndex: {type: 'integer', description: '目标段下标（0 起；与源段相同 = 段内重排）'},
        position: {type: 'integer', description: '插入到目标段内的位置（0 起；缺省 = 追加末尾）'},
      },
      required: ['fromSegmentIndex', 'clipIndex', 'toSegmentIndex'],
    },
    promptHint: 'shot 跨段搬移/段内重排（素材设置全保留；画中画归位用）',
  },
];

// ====== 故事板规格类型 ======

/** LLM 提交的片段规格（宽松输入，经校验+补默认值后应用） */
export interface SegmentSpec {
  templateId: string;
  duration?: number;
  transition?: TransitionType;
  videoEffect?: VideoEffect;
  backgroundEffect?: BackgroundEffect;
  textAnim?: TextAnimPreset;
  /** 片尾退场预设（sync 同步退场[默认] / fade 整体淡出 / stagger 留白收尾） */
  exitStyle?: SegmentExitStyle;
  /** 旁白文案（仅 text；音频由用户在旁白面板 TTS/导入生成） */
  narration?: {text?: string};
  /** 烧录字幕行（相对段起点的时间；空数组 = 清除该段字幕） */
  captions?: CaptionLine[];
  text?: {
    title?: string;
    subtitle?: string;
    features?: string[];
    brandName?: string;
  };
  /** 模板个性化参数（键须属于该模板 paramSpecs；数值会钳制到 [min,max]） */
  customParams?: Record<string, number>;
  /** 鼠标动作脚本（update_segment patch 专属）：DSL 字符串或结构化步骤数组；空串 = 清除 */
  cursorScript?: string | unknown[];
  /** 段内第一段素材原声静音（update_segment patch 专属） */
  muted?: boolean;
  /** 段内第一段素材原声音量 0-1（update_segment patch 专属） */
  volume?: number;
  /** 转场参数（durationSec 0.2-2 / direction 1上2下3左4右，仅 slide/push/wipe/whip 消费 direction） */
  transitionParams?: {durationSec?: number; direction?: number};
}

export interface ValidatedSegmentSpec {
  templateId: string;
  duration: number;
  transition: TransitionType;
  videoEffect: VideoEffect;
  backgroundEffect: BackgroundEffect;
  /** 文字入场动效；undefined = 未指定（patch 时保留原值，storyboard 时回退模板默认） */
  textAnim: TextAnimPreset | undefined;
  /** 片尾退场预设；undefined = 未指定（patch 时保留原值，storyboard 时回退 sync） */
  exitStyle: SegmentExitStyle | undefined;
  /** 旁白；undefined = 未指定（patch 时保留原值）；text 空串 = 清除旁白 */
  narration: {text: string} | undefined;
  /** 字幕行；undefined = 未指定（patch 时保留原值）；空数组 = 清除字幕 */
  captions: CaptionLine[] | undefined;
  text: {title: string; subtitle: string; features: string[]; brandName: string};
  /** 模板个性化参数；undefined = 未指定（全部走模板默认） */
  customParams: Record<string, number> | undefined;
  /** 转场参数；undefined = 未指定（patch 时保留原值） */
  transitionParams: {durationSec?: number; direction?: number} | undefined;
}

/**
 * 校验通过时除数据外还可带 notes（非致命提示：customParams 未知键被丢弃、数值被钳制等），
 * 由执行器拼进工具结果告知模型，不影响应用。
 */
export type ValidateResult =
  | {ok: true; segments: ValidatedSegmentSpec[]; notes: string[]; editPlan?: Partial<EditPlan>}
  | {ok: false; errors: string[]};

/**
 * update_segment 的校验结果（部分更新语义）：缺省字段一律 undefined = 调用方保留原值，
 * 与 textAnim/narration/captions 的既有语义一致——模型只想改一个字段时不会清空其余字段。
 */
export interface ValidatedSegmentPatch {
  /** 已解析的模板 id：update_segment 显式给出或沿用原模板；仅在调用方未提供 fallback 的防御性场景为 undefined */
  templateId: string | undefined;
  duration: number | undefined;
  transition: TransitionType | undefined;
  videoEffect: VideoEffect | undefined;
  backgroundEffect: BackgroundEffect | undefined;
  textAnim: TextAnimPreset | undefined;
  exitStyle: SegmentExitStyle | undefined;
  narration: {text: string} | undefined;
  captions: CaptionLine[] | undefined;
  text: {title?: string; subtitle?: string; features?: string[]; brandName?: string} | undefined;
  /** 模板个性化参数；undefined = 未指定（patch 时保留原值）。应用时与现有 customParams 合并（给出的键覆盖，其余保留） */
  customParams: Record<string, number> | undefined;
  /** 转场参数；undefined = 未指定（patch 时保留原值）。应用时与现有 transitionParams 合并（给出的键覆盖） */
  transitionParams: {durationSec?: number; direction?: number} | undefined;
  /** 鼠标动作脚本（DSL 字符串；undefined = 未指定；空串 = 清除）。应用时对段内第一段素材合成演示轨迹 */
  cursorScript: string | undefined;
  /** 段内第一段素材原声静音（undefined = 未指定） */
  muted: boolean | undefined;
  /** 段内第一段素材原声音量 0-1（undefined = 未指定；应用时钳制值生效） */
  volume: number | undefined;
}

export type PatchResult = {ok: true; patch: ValidatedSegmentPatch; notes: string[]} | {ok: false; errors: string[]};

export interface LlmTools {
  toolDefs: LlmToolDef[];
  validateStoryboardSpec: (raw: unknown) => ValidateResult;
  /** fallbackTemplateId：update_segment 用——patch 缺 templateId 时沿用该段现有模板 */
  validateSegmentPatch: (raw: unknown, index: number, fallbackTemplateId?: string) => PatchResult;
}

/**
 * 本地模型（端侧档）核心工具面。动机（2026-09 端侧实验）：全量 60+ 工具 schema +
 * 完整系统提示词 ≈30k token 固定开销，32k 上下文的端侧小模型塞不下（加 3 张帧即爆）；
 * 精简到 17 个核心工具后固定开销降到 ≈7.6k，agent 循环可完整跑通。
 * panel 在检测到 loopback 端点（isLlmLoopback）时自动启用；MCP 通道面向外部 agent 不裁剪。
 */
export const EDGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'get_project_info', 'scratch_pad', 'get_storyboard', 'get_templates', 'search_templates',
  'get_transition_templates',
  'get_segment_media', 'view_segment_frame', 'view_media_frames',
  'set_segment_trim', 'set_segment_viewport', 'update_segment', 'set_storyboard',
  'split_segment', 'delete_segment', 'get_template_slot_windows',
  'mine_highlights', 'apply_cut_list', 'request_render',
  // v6 翻面（docs/agent-timeline-schema.md §5，模型线拍板）：时间轴四工具；
  // set_narration_timing 随旁白族（synthesize_narration 不在 EDGE 面）后置
  'get_timeline', 'move_shot', 'reorder_segments', 'set_bgm_position',
  'set_bgm',  // BGM 选曲是 set_bgm_position 的前置（无曲可位 = 死路），创作族核心表达
  // v7 翻面（2026-10-06 模型线拍板）：真实素材工作流双件——场景检测（零 token 镜头清单，
  // 多素材排片前置）与色彩空间标记（log 灰片恢复前置）；mine_highlights 已在面内（阶段四起真实现）
  'scan_media', 'set_media_colorspace',
  // 2026-11-03 数据走私收编（用户拍板 26→29 面）：这三个工具被 91.5% 的训练窗调用，
  // 但此前不在 EDGE schema 里（教师走 MCP 全量面采集）——模型被教成「忽略 schema、用我记得的工具」。
  // get_app_status：渲染轮询的唯一正解（p25 轮询纪律批整批依赖它）；
  // import_segment_media：p9/p13/p14 建板必需（追加语义，换素材用 trim 等效）；
  // set_video_type：p11/p13/p14 体裁切换必需（P0-1 自动路由之外的人工修正口）。
  'get_app_status', 'import_segment_media', 'set_video_type',
]);

/** 按端侧档裁剪工具 schema 清单（保持注册表顺序 = 发给模型的顺序） */
export const filterToolDefsForEdge = <T extends {function: {name: string}}>(defs: T[]): T[] =>
  defs.filter((d) => EDGE_TOOL_NAMES.has(d.function.name));

/** 用模板/枚举清单构建工具 schema + 校验器。 */
export const createLlmTools = (deps: LlmToolsDeps): LlmTools => {
  const TRANSITION_VALUES = new Set(deps.transitions);
  const VIDEO_EFFECT_VALUES = new Set(deps.videoEffects);
  const BG_EFFECT_VALUES = new Set(deps.backgroundEffects);
  const TEXT_ANIM_VALUES = new Set(deps.textAnims);
  const EXIT_STYLE_VALUES = new Set(['sync', 'fade', 'stagger']);
  const TEMPLATE_MAP = new Map(deps.templates.map((t) => [t.id, t]));

  // 工具 schema 从注册表派生（parameters 为函数的用 deps 求值）
  const toolDefs: LlmToolDef[] = LLM_TOOL_REGISTRY.map((e) => ({
    type: 'function',
    function: {
      name: e.name,
      description: e.description,
      parameters: typeof e.parameters === 'function' ? e.parameters(deps) : e.parameters,
    },
  }));

  const isStr = (v: unknown): v is string => typeof v === 'string';

  /**
   * 校验单个片段规格（index 用于错误定位）。错误全部收集，一次返回。
   * 返回的是「部分」结构：模型未给出的字段一律 undefined（保留原值语义），
   * 完整故事板所需的默认值由 validateStoryboardSpec 在 toFullSpec 里补齐。
   * notes 收集非致命提示（customParams 未知键丢弃/数值钳制），供执行器回告模型。
   */
  const validateOne = (raw: unknown, index: number, errors: string[], notes: string[], fallbackTemplateId?: string): ValidatedSegmentPatch | null => {
    const at = `第 ${index + 1} 段`;
    if (typeof raw !== 'object' || raw === null) {
      errors.push(`${at}：片段必须是对象`);
      return null;
    }
    const spec = raw as SegmentSpec;
    // 模板解析：显式给出（非 null）必须存在，否则判死；缺省时 patch 沿用原模板（fallbackTemplateId），
    // set_storyboard 无 fallback → 报「必须给出 templateId」
    let templateId: string | undefined;
    if (spec.templateId === undefined || spec.templateId === null) {
      templateId = fallbackTemplateId;
    } else if (isStr(spec.templateId)) {
      templateId = spec.templateId;
    }
    const meta = templateId !== undefined ? TEMPLATE_MAP.get(templateId) : undefined;
    if (!meta) {
      errors.push(
        spec.templateId === undefined || spec.templateId === null
          ? `${at}：必须给出 templateId（从 get_templates 选择）`
          : `${at}：模板 id「${String(spec.templateId)}」不存在，请从 get_templates 选择`,
      );
      return null; // 模板无效则默认值无从谈起，直接判死
    }
    // 时长：缺省 undefined（未指定 = 保留原值/回退默认）；指定时校验 0.5-60（0.5 起步支持快切蒙太奇）
    let duration: number | undefined;
    if (spec.duration !== undefined) {
      if (typeof spec.duration !== 'number' || !Number.isFinite(spec.duration) || spec.duration < 0.5 || spec.duration > 60) {
        errors.push(`${at}：时长必须是 0.5-60 秒的数字`);
      } else {
        duration = spec.duration;
      }
    }
    // 枚举字段：缺省 undefined（未指定）；指定时校验合法性
    const checkEnum = (v: unknown, values: ReadonlySet<string>, label: string): string | undefined => {
      if (v === undefined) return undefined;
      const s = v as string;
      if (!values.has(s)) {
        errors.push(`${at}：${label}「${s}」不存在`);
        return undefined;
      }
      return s;
    };
    const transition = checkEnum(spec.transition, TRANSITION_VALUES, '转场') as TransitionType | undefined;
    const videoEffect = checkEnum(spec.videoEffect, VIDEO_EFFECT_VALUES, '视频特效') as VideoEffect | undefined;
    const backgroundEffect = checkEnum(spec.backgroundEffect, BG_EFFECT_VALUES, '背景特效') as BackgroundEffect | undefined;
    // 文字入场动效：缺省 undefined（未指定）；指定时校验枚举
    let textAnim: TextAnimPreset | undefined;
    if (spec.textAnim !== undefined) {
      const ta = spec.textAnim as string;
      if (!TEXT_ANIM_VALUES.has(ta)) {
        errors.push(`${at}：文字动效「${ta}」不存在`);
      } else {
        textAnim = ta as TextAnimPreset;
      }
    }
    // 片尾退场预设：缺省 undefined（未指定 = sync）；指定时校验枚举
    const exitStyle = checkEnum(spec.exitStyle, EXIT_STYLE_VALUES, '退场预设') as SegmentExitStyle | undefined;
    // 旁白：缺省 undefined（未指定）；指定时取 text（≤200 字），空串表示清除
    let narration: {text: string} | undefined;
    if (spec.narration !== undefined) {
      if (typeof spec.narration !== 'object' || spec.narration === null) {
        errors.push(`${at}：narration 必须是对象`);
      } else {
        const rawText = (spec.narration as {text?: unknown}).text;
        if (rawText !== undefined && typeof rawText !== 'string') {
          errors.push(`${at}：旁白文案必须是文字`);
        }
        const narrText = typeof rawText === 'string' ? rawText.slice(0, 200) : '';
        narration = {text: narrText};
      }
    }

    // 字幕：缺省 undefined（未指定）；指定时校验每行（≤20 行，时间相对段起点）
    // endSec 上限用「指定时长 ?? 模板默认时长」（patch 时无法得知现有段时长，与既有行为一致）
    const durationBound = duration ?? meta.defaultDuration;
    let captions: CaptionLine[] | undefined;
    if (spec.captions !== undefined) {
      if (!Array.isArray(spec.captions)) {
        errors.push(`${at}：captions 必须是数组`);
      } else {
        const lines: CaptionLine[] = [];
        const rawLines = spec.captions.slice(0, 20);
        if (spec.captions.length > 20) errors.push(`${at}：字幕超过 20 行，已截断`);
        for (let ci = 0; ci < rawLines.length; ci++) {
          const line = rawLines[ci] as {text?: unknown; startSec?: unknown; endSec?: unknown};
          if (!line || typeof line !== 'object') {
            errors.push(`${at}：字幕 ${ci + 1} 必须是对象`);
            continue;
          }
          if (line.text !== undefined && typeof line.text !== 'string') {
            errors.push(`${at}：字幕 ${ci + 1} 文案必须是文字`);
          }
          const lt = typeof line.text === 'string' ? line.text.slice(0, 60) : '';
          const ls = line.startSec;
          const le = line.endSec;
          if (typeof ls !== 'number' || !Number.isFinite(ls) || ls < 0) {
            errors.push(`${at}：字幕 ${ci + 1} startSec 必须是 ≥0 的数字`);
            continue;
          }
          if (typeof le !== 'number' || !Number.isFinite(le) || le <= ls) {
            errors.push(`${at}：字幕 ${ci + 1} endSec 必须大于 startSec`);
            continue;
          }
          if (le > durationBound) {
            errors.push(`${at}：字幕 ${ci + 1} endSec(${le}s) 超过段时长 ${durationBound}s`);
            continue;
          }
          lines.push({text: lt, startSec: ls, endSec: le});
        }
        captions = lines; // 空数组保留（表示清除该段字幕）
      }
    }

    // 文案：缺省 undefined（未指定 = 保留原值）；指定对象时只校验并带出显式给出的子字段
    const cutOpt = (v: unknown, max: number, label: string): string | undefined => {
      if (v === undefined || v === null) return undefined;
      if (!isStr(v)) {
        errors.push(`${at}：${label}必须是文字`);
        return undefined;
      }
      if (v.length > max) errors.push(`${at}：${label}超过 ${max} 字`);
      return v.slice(0, max);
    };
    let text: ValidatedSegmentPatch['text'];
    if (spec.text !== undefined) {
      if (typeof spec.text !== 'object' || spec.text === null) {
        errors.push(`${at}：text 必须是对象`);
      } else {
        const t = spec.text;
        let features: string[] | undefined;
        if (t.features !== undefined && t.features !== null) {
          if (!Array.isArray(t.features)) {
            errors.push(`${at}：features 必须是文字数组`);
          } else {
            features = t.features.slice(0, 5).map((f, i) => cutOpt(f, 40, `要点 ${i + 1}`) ?? '');
          }
        }
        text = {
          title: cutOpt(t.title, 30, '主标题'),
          subtitle: cutOpt(t.subtitle, 60, '副标题'),
          features,
          brandName: cutOpt(t.brandName, 20, '品牌名'),
        };
        // 文字槽位提示：模板 meta 带textSlots 时，对「给了内容但模板不展示」的字段发 note
        //（数据照常保留，只是不会出现在画面里——把静默忽略变成显式提醒）
        const slots = meta.textSlots;
        if (slots) {
          const given: string[] = [];
          if (text.title) given.push('title');
          if (text.subtitle) given.push('subtitle');
          if (text.brandName) given.push('brandName');
          if (text.features && text.features.length > 0) given.push('features');
          const unused = given.filter((k) => !slots.includes(k));
          if (unused.length > 0) {
            notes.push(
              slots.length === 0
                ? `${at}：模板「${meta.name}」不展示任何文字字段，text.${unused.join('/text.')} 不会出现在画面里`
                : `${at}：模板「${meta.name}」不使用 text.${unused.join('/text.')}（文字槽位仅 ${slots.map((k) => `text.${k}`).join('、')}），这些字段不会出现在画面里`,
            );
          }
        }
      }
    }

    // 模板个性化参数：缺省 undefined（未指定）；指定对象时按该模板 paramSpecs 校验——
    // 未知键丢弃并记 note（不判死，保证一键成片流程不被单个坏键打断），数值钳到 [min,max]
    let customParams: Record<string, number> | undefined;
    if (spec.customParams !== undefined) {
      if (typeof spec.customParams !== 'object' || spec.customParams === null || Array.isArray(spec.customParams)) {
        errors.push(`${at}：customParams 必须是 {参数键: 数值} 对象`);
      } else {
        const specs = meta.paramSpecs ?? [];
        const entries = Object.entries(spec.customParams);
        if (specs.length === 0 && entries.length > 0) {
          notes.push(`${at}：模板「${meta.name}」无可调参数，已忽略 customParams`);
        } else {
          const specMap = new Map(specs.map((p) => [p.key, p]));
          const cleaned: Record<string, number> = {};
          for (const [key, val] of entries) {
            const ps = specMap.get(key);
            if (!ps) {
              notes.push(`${at}：忽略未知参数「${key}」（模板「${meta.name}」无此参数，可用键见 get_templates 的 paramSpecs）`);
              continue;
            }
            if (typeof val !== 'number' || !Number.isFinite(val)) {
              notes.push(`${at}：参数「${key}」的值必须是数字，已忽略`);
              continue;
            }
            const clamped = Math.max(ps.min, Math.min(ps.max, val));
            if (clamped !== val) {
              notes.push(`${at}：参数「${key}」${val} 超出范围，已钳制到 ${clamped}（${ps.min}~${ps.max}）`);
            }
            cleaned[key] = clamped;
          }
          customParams = Object.keys(cleaned).length > 0 ? cleaned : undefined;
        }
      }
    }

    // 转场参数：缺省 undefined（未指定）；指定对象时校验 durationSec（0.2-2 钳制）与 direction（0-4 取整钳制）
    let transitionParams: {durationSec?: number; direction?: number} | undefined;
    if (spec.transitionParams !== undefined) {
      if (typeof spec.transitionParams !== 'object' || spec.transitionParams === null || Array.isArray(spec.transitionParams)) {
        errors.push(`${at}：transitionParams 必须是对象`);
      } else {
        const tp = spec.transitionParams as {durationSec?: unknown; direction?: unknown};
        const cleaned: {durationSec?: number; direction?: number} = {};
        if (tp.durationSec !== undefined) {
          if (typeof tp.durationSec !== 'number' || !Number.isFinite(tp.durationSec)) {
            notes.push(`${at}：transitionParams.durationSec 必须是数字，已忽略`);
          } else {
            const c = Math.max(0.2, Math.min(2, tp.durationSec));
            if (c !== tp.durationSec) notes.push(`${at}：transitionParams.durationSec ${tp.durationSec} 超出范围，已钳制到 ${c}`);
            cleaned.durationSec = c;
          }
        }
        if (tp.direction !== undefined) {
          if (typeof tp.direction !== 'number' || !Number.isFinite(tp.direction)) {
            notes.push(`${at}：transitionParams.direction 必须是数字，已忽略`);
          } else {
            const c = Math.max(0, Math.min(4, Math.round(tp.direction)));
            if (c !== tp.direction) notes.push(`${at}：transitionParams.direction ${tp.direction} 超出范围，已钳制到 ${c}（0-4）`);
            cleaned.direction = c;
          }
        }
        transitionParams = Object.keys(cleaned).length > 0 ? cleaned : undefined;
      }
    }

    // 鼠标动作脚本（patch 专属；update_segment schema 才暴露）：字符串 DSL 或结构化数组，
    // 试解析校验（warnings 进 notes 回告模型），规范化为字符串透传；空串 = 清除动作轨迹
    let cursorScript: string | undefined;
    if (spec.cursorScript !== undefined) {
      if (typeof spec.cursorScript === 'string') {
        cursorScript = spec.cursorScript.trim();
        if (cursorScript !== '') {
          const parsed = parseCursorTrackScript(cursorScript);
          if (parsed.steps.length === 0) {
            notes.push(`${at}：cursorScript 未解析出任何动作步骤（DSL：「x,y」起点 /「>x,y @秒」滑动 /「@秒」停顿 / click / dblclick / right / drag / scroll / type / down / up / hold，| 分隔），已忽略`);
            cursorScript = undefined;
          } else if (parsed.warnings.length > 0) {
            notes.push(`${at}：cursorScript ${parsed.warnings[0]}`);
          }
        }
      } else if (Array.isArray(spec.cursorScript)) {
        const parsed = parseCursorTrackScript(spec.cursorScript);
        if (parsed.steps.length === 0) {
          notes.push(`${at}：cursorScript 数组无有效步骤，已忽略`);
        } else {
          // 结构化数组规范化为 DSL 字符串（持久化/读回单一形态；时长两位小数防浮点尾）
          const sec2 = (v: number) => (v > 0 ? `@${Math.round(v * 100) / 100}` : '');
          cursorScript = parsed.steps
            .map((s) => {
              if (s.kind === 'click') return 'click';
              if (s.kind === 'dblclick') return 'dblclick';
              if (s.kind === 'right') return 'right';
              if (s.kind === 'down') return 'down';
              if (s.kind === 'up') return 'up';
              if (s.kind === 'pause') return `@${s.sec}`;
              if (s.kind === 'drag') return `drag > ${s.x},${s.y}${sec2(s.sec)}`;
              if (s.kind === 'scroll') return `scroll ${s.ticks > 0 ? '+' : ''}${s.ticks}${sec2(s.sec)}`;
              if (s.kind === 'type') return `type "${s.text}"${sec2(s.sec)}`;
              return `>${s.x},${s.y}${sec2(s.sec)}`;
            })
            .join(' | ');
          if (parsed.warnings.length > 0) notes.push(`${at}：cursorScript ${parsed.warnings[0]}`);
        }
      } else {
        notes.push(`${at}：cursorScript 必须是字符串或步骤数组，已忽略`);
      }
    }

    // 素材原声控制（patch 专属）：muted 布尔直通；volume 钳 0-1（越界告警不拒收）
    let muted: boolean | undefined;
    if (spec.muted !== undefined) {
      if (typeof spec.muted === 'boolean') muted = spec.muted;
      else notes.push(`${at}：muted 必须是布尔值，已忽略`);
    }
    let clipVolume: number | undefined;
    if (spec.volume !== undefined && spec.volume !== null) {
      const v = Number(spec.volume);
      if (Number.isFinite(v)) {
        clipVolume = Math.min(1, Math.max(0, v));
        if (clipVolume !== v) notes.push(`${at}：volume ${v} 超出 0-1，已钳制到 ${clipVolume}`);
      } else {
        notes.push(`${at}：volume 必须是数值，已忽略`);
      }
    }

    return {
      templateId, // 已解析：显式给出或 patch 沿用原模板（此处必有对应 meta）
      duration,
      transition,
      videoEffect,
      backgroundEffect,
      textAnim,
      exitStyle,
      narration,
      captions,
      text,
      customParams,
      transitionParams,
      cursorScript,
      muted,
      volume: clipVolume,
    };
  };

  /** 部分校验结果 → 完整片段规格（set_storyboard 用：缺省字段补模板默认/空文案） */
  const toFullSpec = (p: ValidatedSegmentPatch): ValidatedSegmentSpec => {
    // storyboard 路径无 fallback，validateOne 已保证 templateId 存在
    const meta = TEMPLATE_MAP.get(p.templateId!)!;
    return {
      templateId: p.templateId!,
      duration: p.duration ?? meta.defaultDuration,
      transition: p.transition ?? ('crossfade' as TransitionType),
      videoEffect: p.videoEffect ?? ('none' as VideoEffect),
      backgroundEffect: p.backgroundEffect ?? ('none' as BackgroundEffect),
      textAnim: p.textAnim,
      exitStyle: p.exitStyle,
      narration: p.narration,
      captions: p.captions,
      text: {
        title: p.text?.title ?? '',
        subtitle: p.text?.subtitle ?? '',
        features: p.text?.features ?? [],
        brandName: p.text?.brandName ?? '',
      },
      customParams: p.customParams,
      transitionParams: p.transitionParams,
    };
  };

  const validateStoryboardSpec = (raw: unknown): ValidateResult => {
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as {segments?: unknown}).segments)) {
      return {ok: false, errors: ['参数必须是 {segments: [...]} 形式']};
    }
    const list = (raw as {segments: unknown[]}).segments;
    if (list.length < 1 || list.length > 60) {
      return {ok: false, errors: [`片段数量 ${list.length} 超出范围（1-60 个）`]};
    }
    const errors: string[] = [];
    const notes: string[] = [];
    const partials = list.map((s, i) => validateOne(s, i, errors, notes));
    if (errors.length > 0 || partials.some((s) => s === null)) {
      return {ok: false, errors: errors.length > 0 ? errors : ['片段校验失败']};
    }
    const candidatePlan = (raw as {editPlan?: unknown}).editPlan;
    return {
      ok: true,
      segments: (partials as ValidatedSegmentPatch[]).map(toFullSpec),
      notes,
      ...(candidatePlan && typeof candidatePlan === 'object' && !Array.isArray(candidatePlan)
        ? {editPlan: candidatePlan as Partial<EditPlan>}
        : {}),
    };
  };

  const validateSegmentPatch = (raw: unknown, index: number, fallbackTemplateId?: string): PatchResult => {
    const errors: string[] = [];
    const notes: string[] = [];
    const patch = validateOne(raw, index, errors, notes, fallbackTemplateId);
    if (errors.length > 0 || !patch) return {ok: false, errors: errors.length > 0 ? errors : ['片段校验失败']};
    return {ok: true, patch, notes};
  };

  return {toolDefs, validateStoryboardSpec, validateSegmentPatch};
};

// ====== 阶段二新工具的参数校验（纯函数，可单测）======

/** 解析段下标（0 起非负整数） */
export const parseIndexArg = (raw: unknown): {ok: true; index: number} | {ok: false; errors: string[]} => {
  const a = raw as {index?: unknown} | null;
  const idx = a?.index;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
    return {ok: false, errors: ['index 必须是非负整数（段下标，0 起）']};
  }
  return {ok: true, index: idx};
};

export interface ViewFrameArgs {
  index: number;
  videoIndex: number;
  timeSec: number;
}

/** view_segment_frame 参数：index 必填；videoIndex 缺省 0；timeSec 缺省 0（调用方再取中点） */
export const validateViewFrameArgs = (
  raw: unknown,
): {ok: true; args: ViewFrameArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const idx = a.index;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
    return {ok: false, errors: ['index 必须是非负整数（段下标，0 起）']};
  }
  const vi = a.videoIndex ?? 0;
  if (typeof vi !== 'number' || !Number.isInteger(vi) || vi < 0) {
    return {ok: false, errors: ['videoIndex 必须是非负整数']};
  }
  const t = a.timeSec ?? 0;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
    return {ok: false, errors: ['timeSec 必须是 ≥0 的数字']};
  }
  return {ok: true, args: {index: idx, videoIndex: vi, timeSec: t}};
};

export interface SetTrimArgs {
  index: number;
  videoIndex: number;
  trimStart: number;
  trimEnd: number;
  /** 挖段列表（媒体绝对秒）：给出即整体替换（[] 清空），省略 = 保留现有 */
  cuts?: ClipCut[];
}

/** set_segment_trim 参数：trimStart/trimEnd 非负且 start<end；cuts 可选挖段列表（start<end 的正数区间） */
export const validateSetTrimArgs = (
  raw: unknown,
): {ok: true; args: SetTrimArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const idx = a.index;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
    return {ok: false, errors: ['index 必须是非负整数（段下标，0 起）']};
  }
  const vi = a.videoIndex ?? 0;
  if (typeof vi !== 'number' || !Number.isInteger(vi) || vi < 0) {
    return {ok: false, errors: ['videoIndex 必须是非负整数']};
  }
  const ts = a.trimStart ?? 0;
  const te = a.trimEnd;
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) {
    return {ok: false, errors: ['trimStart 必须是 ≥0 的数字']};
  }
  if (typeof te !== 'number' || !Number.isFinite(te) || te < 0) {
    return {ok: false, errors: ['trimEnd 必须是 ≥0 的数字']};
  }
  if (ts >= te) {
    return {ok: false, errors: ['trimEnd 必须大于 trimStart']};
  }
  let cuts: ClipCut[] | undefined;
  if (a.cuts !== undefined && a.cuts !== null) {
    if (!Array.isArray(a.cuts)) {
      return {ok: false, errors: ['cuts 必须是 {start, end} 数组（媒体绝对秒）']};
    }
    cuts = [];
    for (const c of a.cuts) {
      const r = (c || {}) as Record<string, unknown>;
      if (typeof r.start !== 'number' || typeof r.end !== 'number' || !Number.isFinite(r.start) || !Number.isFinite(r.end)) {
        return {ok: false, errors: ['cuts 每项的 start/end 必须是数字（媒体绝对秒）']};
      }
      if (r.start < 0 || r.end <= r.start) {
        return {ok: false, errors: ['cuts 每项需满足 0 ≤ start < end']};
      }
      cuts.push({start: r.start, end: r.end});
    }
  }
  return {ok: true, args: {index: idx, videoIndex: vi, trimStart: ts, trimEnd: te, ...(cuts !== undefined ? {cuts} : {})}};
};

export interface SetViewportArgs {
  index: number;
  videoIndex: number;
  scale?: number;
  offsetX?: number;
  offsetY?: number;
}

/** set_segment_viewport 参数：scale 0.1~5，offsetX/offsetY -0.5~0.5（均可选） */
export const validateSetViewportArgs = (
  raw: unknown,
): {ok: true; args: SetViewportArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const idx = a.index;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
    return {ok: false, errors: ['index 必须是非负整数（段下标，0 起）']};
  }
  const vi = a.videoIndex ?? 0;
  if (typeof vi !== 'number' || !Number.isInteger(vi) || vi < 0) {
    return {ok: false, errors: ['videoIndex 必须是非负整数']};
  }
  const clampOpt = (v: unknown, min: number, max: number, label: string): number | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${label} 必须是数字`);
    }
    return Math.max(min, Math.min(max, v));
  };
  try {
    const scale = clampOpt(a.scale, 0.1, 5, 'scale');
    const offsetX = clampOpt(a.offsetX, -0.5, 0.5, 'offsetX');
    const offsetY = clampOpt(a.offsetY, -0.5, 0.5, 'offsetY');
    return {ok: true, args: {index: idx, videoIndex: vi, scale, offsetX, offsetY}};
  } catch (err) {
    return {ok: false, errors: [err instanceof Error ? err.message : String(err)]};
  }
};

/** 跟踪点数组校验（stabilize_clip / set_stabilization 共用）：1~2 个 {x,y} ≥0 有限数字；undefined 原样透传（未给出） */
const parseStabPointsArg = (raw: unknown): {ok: true; points?: StabPoint[]} | {ok: false; errors: string[]} => {
  if (raw === undefined || raw === null) return {ok: true};
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) {
    return {ok: false, errors: ['points 需为 1~2 个跟踪点（省略 = 自动选点）']};
  }
  const points: StabPoint[] = [];
  for (const p of raw) {
    const x = (p as StabPoint)?.x;
    const y = (p as StabPoint)?.y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      return {ok: false, errors: ['points 每项的 x/y 必须是 ≥0 的数字（视频像素坐标）']};
    }
    points.push({x, y});
  }
  return {ok: true, points};
};

/** smoothSec 校验：0.2~2 秒，越界钳制；undefined 原样透传 */
const parseSmoothSecArg = (raw: unknown): {ok: true; smoothSec?: number} | {ok: false; errors: string[]} => {
  if (raw === undefined || raw === null) return {ok: true};
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return {ok: false, errors: ['smoothSec 必须是数字（秒）']};
  }
  return {ok: true, smoothSec: Math.max(0.2, Math.min(2, raw))};
};

export interface StabilizeClipArgs {
  segmentIndex: number;
  clipIndex: number;
  /** 跟踪点（视频像素 1~2 个）；undefined = 自动选点 */
  points?: StabPoint[];
  smoothSec: number;
}

/** stabilize_clip 参数：segmentIndex 必填；clipIndex 缺省 0；points 缺省 = 自动选点；smoothSec 缺省 0.8（钳 0.2~2） */
export const validateStabilizeClipArgs = (
  raw: unknown,
): {ok: true; args: StabilizeClipArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const si = a.segmentIndex;
  if (typeof si !== 'number' || !Number.isInteger(si) || si < 0) {
    return {ok: false, errors: ['segmentIndex 必须是非负整数（段下标，0 起）']};
  }
  const ci = a.clipIndex ?? 0;
  if (typeof ci !== 'number' || !Number.isInteger(ci) || ci < 0) {
    return {ok: false, errors: ['clipIndex 必须是非负整数']};
  }
  const pts = parseStabPointsArg(a.points);
  if (!pts.ok) return pts;
  const ss = parseSmoothSecArg(a.smoothSec);
  if (!ss.ok) return ss;
  return {ok: true, args: {segmentIndex: si, clipIndex: ci, ...(pts.points ? {points: pts.points} : {}), smoothSec: ss.smoothSec ?? 0.8}};
};

export interface SetStabilizationArgs {
  segmentIndex: number;
  clipIndex: number;
  enabled?: boolean;
  smoothSec?: number;
  /** 换跟踪点（给出即重跑分析）；undefined = 不换点 */
  points?: StabPoint[];
}

/** set_stabilization 参数：segmentIndex 必填；enabled/smoothSec/points 至少给一个 */
export const validateSetStabilizationArgs = (
  raw: unknown,
): {ok: true; args: SetStabilizationArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const si = a.segmentIndex;
  if (typeof si !== 'number' || !Number.isInteger(si) || si < 0) {
    return {ok: false, errors: ['segmentIndex 必须是非负整数（段下标，0 起）']};
  }
  const ci = a.clipIndex ?? 0;
  if (typeof ci !== 'number' || !Number.isInteger(ci) || ci < 0) {
    return {ok: false, errors: ['clipIndex 必须是非负整数']};
  }
  let enabled: boolean | undefined;
  if (a.enabled !== undefined && a.enabled !== null) {
    if (typeof a.enabled !== 'boolean') return {ok: false, errors: ['enabled 必须是布尔值']};
    enabled = a.enabled;
  }
  const ss = parseSmoothSecArg(a.smoothSec);
  if (!ss.ok) return ss;
  const pts = parseStabPointsArg(a.points);
  if (!pts.ok) return pts;
  if (enabled === undefined && ss.smoothSec === undefined && !pts.points) {
    return {ok: false, errors: ['至少提供一个字段：enabled/smoothSec/points']};
  }
  return {
    ok: true,
    args: {
      segmentIndex: si,
      clipIndex: ci,
      ...(enabled !== undefined ? {enabled} : {}),
      ...(ss.smoothSec !== undefined ? {smoothSec: ss.smoothSec} : {}),
      ...(pts.points ? {points: pts.points} : {}),
    },
  };
};

// ====== 3D 地面追踪工具的参数校验 ======

export interface GroundElementPatchArgs {
  text?: string;
  u?: number;
  v?: number;
  size?: number;
  yawDeg?: number;
  pitchDeg?: number;
  rollDeg?: number;
  depth?: number;
  color?: string;
  entrance?: 'rise' | 'fade' | 'none';
  opacity?: number;
}

/** 地面元素公共可选参数校验（u/v 0~1 钳制；size 0.03~0.8 钳制；color #rrggbb） */
const parseGroundElementCommon = (a: Record<string, unknown>): {ok: true; args: GroundElementPatchArgs} | {ok: false; errors: string[]} => {
  const out: GroundElementPatchArgs = {};
  const errors: string[] = [];
  if (a.text !== undefined && a.text !== null) {
    if (typeof a.text !== 'string' || a.text.trim().length === 0) errors.push('text 必须是非空字符串');
    else out.text = a.text.trim().slice(0, 40);
  }
  for (const k of ['u', 'v'] as const) {
    const v = a[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {errors.push(`${k} 必须是数字（0~1）`); continue;}
    out[k] = Math.max(0.01, Math.min(0.99, v));
  }
  if (a.size !== undefined && a.size !== null) {
    if (typeof a.size !== 'number' || !Number.isFinite(a.size)) errors.push('size 必须是数字（0.03~0.8）');
    else out.size = Math.max(0.03, Math.min(0.8, a.size));
  }
  if (a.yawDeg !== undefined && a.yawDeg !== null) {
    if (typeof a.yawDeg !== 'number' || !Number.isFinite(a.yawDeg)) errors.push('yawDeg 必须是数字（-180~180）');
    else out.yawDeg = Math.max(-180, Math.min(180, a.yawDeg));
  }
  if (a.pitchDeg !== undefined && a.pitchDeg !== null) {
    if (typeof a.pitchDeg !== 'number' || !Number.isFinite(a.pitchDeg)) errors.push('pitchDeg 必须是数字（-90~90）');
    else out.pitchDeg = Math.max(-90, Math.min(90, a.pitchDeg));
  }
  if (a.rollDeg !== undefined && a.rollDeg !== null) {
    if (typeof a.rollDeg !== 'number' || !Number.isFinite(a.rollDeg)) errors.push('rollDeg 必须是数字（-180~180）');
    else out.rollDeg = Math.max(-180, Math.min(180, a.rollDeg));
  }
  if (a.depth !== undefined && a.depth !== null) {
    if (typeof a.depth !== 'number' || !Number.isFinite(a.depth)) errors.push('depth 必须是数字（0.2~3）');
    else out.depth = Math.max(0.2, Math.min(3, a.depth));
  }
  if (a.color !== undefined && a.color !== null) {
    if (typeof a.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(a.color)) errors.push('color 必须是 #rrggbb 格式');
    else out.color = a.color.toLowerCase();
  }
  if (a.entrance !== undefined && a.entrance !== null) {
    if (a.entrance !== 'rise' && a.entrance !== 'fade' && a.entrance !== 'none') errors.push('entrance 必须是 rise/fade/none');
    else out.entrance = a.entrance;
  }
  if (a.opacity !== undefined && a.opacity !== null) {
    if (typeof a.opacity !== 'number' || !Number.isFinite(a.opacity)) errors.push('opacity 必须是数字（0~1）');
    else out.opacity = Math.max(0, Math.min(1, a.opacity));
  }
  return errors.length > 0 ? {ok: false, errors} : {ok: true, args: out};
};

const parseSegmentClipIndex = (a: Record<string, unknown>): {ok: true; segmentIndex: number; clipIndex: number} | {ok: false; errors: string[]} => {
  const si = a.segmentIndex;
  if (typeof si !== 'number' || !Number.isInteger(si) || si < 0) {
    return {ok: false, errors: ['segmentIndex 必须是非负整数（段下标，0 起）']};
  }
  const ci = a.clipIndex ?? 0;
  if (typeof ci !== 'number' || !Number.isInteger(ci) || ci < 0) {
    return {ok: false, errors: ['clipIndex 必须是非负整数']};
  }
  return {ok: true, segmentIndex: si, clipIndex: ci};
};

export interface AddGroundTextArgs extends GroundElementPatchArgs {
  segmentIndex: number;
  clipIndex: number;
  text: string;
  form: 'flat' | 'billboard' | 'extruded';
}

export const validateAddGroundTextArgs = (
  raw: unknown,
): {ok: true; args: AddGroundTextArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const sci = parseSegmentClipIndex(a);
  if (!sci.ok) return sci;
  const common = parseGroundElementCommon(a);
  if (!common.ok) return common;
  if (typeof a.text !== 'string' || a.text.trim().length === 0) {
    return {ok: false, errors: ['text 必须是非空字符串']};
  }
  if (a.form !== 'flat' && a.form !== 'billboard' && a.form !== 'extruded') {
    return {ok: false, errors: ['form 必须是 flat/billboard/extruded']};
  }
  return {ok: true, args: {segmentIndex: sci.segmentIndex, clipIndex: sci.clipIndex, ...common.args, text: a.text.trim().slice(0, 40), form: a.form}};
};

export interface AddGroundShapeArgs extends GroundElementPatchArgs {
  segmentIndex: number;
  clipIndex: number;
  form: 'plate' | 'box' | 'cylinder' | 'cone';
}

export const validateAddGroundShapeArgs = (
  raw: unknown,
): {ok: true; args: AddGroundShapeArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const sci = parseSegmentClipIndex(a);
  if (!sci.ok) return sci;
  const common = parseGroundElementCommon(a);
  if (!common.ok) return common;
  if (a.form !== 'plate' && a.form !== 'box' && a.form !== 'cylinder' && a.form !== 'cone') {
    return {ok: false, errors: ['form 必须是 plate/box/cylinder/cone']};
  }
  return {ok: true, args: {segmentIndex: sci.segmentIndex, clipIndex: sci.clipIndex, ...common.args, form: a.form}};
};

export interface UpdateGroundElementArgs extends GroundElementPatchArgs {
  segmentIndex: number;
  id: string;
}

export const validateUpdateGroundElementArgs = (
  raw: unknown,
): {ok: true; args: UpdateGroundElementArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const si = a.segmentIndex;
  if (typeof si !== 'number' || !Number.isInteger(si) || si < 0) {
    return {ok: false, errors: ['segmentIndex 必须是非负整数（段下标，0 起）']};
  }
  if (typeof a.id !== 'string' || a.id.length === 0) {
    return {ok: false, errors: ['id 必须是非空字符串（add_ground_* 返回的元素 id）']};
  }
  const common = parseGroundElementCommon(a);
  if (!common.ok) return common;
  const hasPatch = Object.keys(common.args).length > 0;
  if (!hasPatch) return {ok: false, errors: ['至少提供一个要修改的字段（text/u/v/size/yawDeg/pitchDeg/rollDeg/depth/color/entrance/opacity）']};
  return {ok: true, args: {segmentIndex: si, id: a.id, ...common.args}};
};

export interface RemoveGroundElementArgs {
  segmentIndex: number;
  id?: string;
}

export const validateRemoveGroundElementArgs = (
  raw: unknown,
): {ok: true; args: RemoveGroundElementArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const si = a.segmentIndex;
  if (typeof si !== 'number' || !Number.isInteger(si) || si < 0) {
    return {ok: false, errors: ['segmentIndex 必须是非负整数（段下标，0 起）']};
  }
  let id: string | undefined;
  if (a.id !== undefined && a.id !== null) {
    if (typeof a.id !== 'string' || a.id.length === 0) return {ok: false, errors: ['id 必须是非空字符串']};
    id = a.id;
  }
  return {ok: true, args: {segmentIndex: si, ...(id ? {id} : {})}};
};

export interface SetGroundTrackingArgs {
  segmentIndex: number;
  clipIndex: number;
  enabled?: boolean;
  reanalyze?: boolean;
}

export const validateSetGroundTrackingArgs = (
  raw: unknown,
): {ok: true; args: SetGroundTrackingArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const sci = parseSegmentClipIndex(a);
  if (!sci.ok) return sci;
  let enabled: boolean | undefined;
  if (a.enabled !== undefined && a.enabled !== null) {
    if (typeof a.enabled !== 'boolean') return {ok: false, errors: ['enabled 必须是布尔值']};
    enabled = a.enabled;
  }
  let reanalyze: boolean | undefined;
  if (a.reanalyze !== undefined && a.reanalyze !== null) {
    if (typeof a.reanalyze !== 'boolean') return {ok: false, errors: ['reanalyze 必须是布尔值']};
    reanalyze = a.reanalyze;
  }
  if (enabled === undefined && reanalyze === undefined) {
    return {ok: false, errors: ['至少提供一个字段：enabled/reanalyze']};
  }
  return {ok: true, args: {segmentIndex: sci.segmentIndex, clipIndex: sci.clipIndex, ...(enabled !== undefined ? {enabled} : {}), ...(reanalyze !== undefined ? {reanalyze} : {})}};
};

// ====== 阶段三新工具的参数校验（字幕 / BGM 避让 / Logo）======

export interface SetCaptionsArgs {
  index: number;
  captions: CaptionLine[];
}

/**
 * set_segment_captions 参数：index 非负整数；captions 数组（≤20 行），
 * 每行 text 文字、startSec≥0、endSec>startSec。
 * 注：endSec 是否超过段时长由 executeTool 结合具体段时长再校验（纯函数不知段时长）。
 */
export const validateSetCaptionsArgs = (
  raw: unknown,
): {ok: true; args: SetCaptionsArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const idx = a.index;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
    return {ok: false, errors: ['index 必须是非负整数（段下标，0 起）']};
  }
  if (!Array.isArray(a.captions)) {
    return {ok: false, errors: ['captions 必须是数组']};
  }
  if (a.captions.length > 20) {
    return {ok: false, errors: ['字幕超过 20 行']};
  }
  const lines: CaptionLine[] = [];
  for (let i = 0; i < a.captions.length; i++) {
    const line = a.captions[i] as {text?: unknown; startSec?: unknown; endSec?: unknown};
    if (!line || typeof line !== 'object') {
      return {ok: false, errors: [`字幕 ${i + 1} 必须是对象`]};
    }
    if (line.text !== undefined && typeof line.text !== 'string') {
      return {ok: false, errors: [`字幕 ${i + 1} 文案必须是文字`]};
    }
    const ls = line.startSec;
    const le = line.endSec;
    if (typeof ls !== 'number' || !Number.isFinite(ls) || ls < 0) {
      return {ok: false, errors: [`字幕 ${i + 1} startSec 必须是 ≥0 的数字`]};
    }
    if (typeof le !== 'number' || !Number.isFinite(le) || le <= ls) {
      return {ok: false, errors: [`字幕 ${i + 1} endSec 必须大于 startSec`]};
    }
    lines.push({text: (typeof line.text === 'string' ? line.text : '').slice(0, 60), startSec: ls, endSec: le});
  }
  return {ok: true, args: {index: idx, captions: lines}};
};

export interface DuckingArgs {
  enabled: boolean;
  amount: number;
}

/** set_bgm_ducking 参数：enabled 必填布尔；amount 可选 0.1~1，缺省 0.25 */
export const validateDuckingArgs = (
  raw: unknown,
): {ok: true; args: DuckingArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.enabled !== 'boolean') {
    return {ok: false, errors: ['enabled 必须是布尔值']};
  }
  let amount = 0.25;
  if (a.amount !== undefined && a.amount !== null) {
    if (typeof a.amount !== 'number' || !Number.isFinite(a.amount)) {
      return {ok: false, errors: ['amount 必须是数字']};
    }
    amount = Math.max(0.1, Math.min(1, a.amount));
  }
  return {ok: true, args: {enabled: a.enabled, amount}};
};

// ====== agent 面时间线工具参数校验（P2.5 阶段三 v3）======
// 类型/非负/至少一字段在入口校；依赖工程上下文的钳制（循环窗/起播点 vs 素材时长与片长）
// 在执行器里用 shared/bgm-track 与 timeline-layout 的钳制函数做，返回值回读生效值。

export interface SetBgmPositionArgs {
  startAtSec?: number;
  trimStartSec?: number;
  trimEndSec?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  volume?: number;
}

export const validateSetBgmPositionArgs = (
  raw: unknown,
): {ok: true; args: SetBgmPositionArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: SetBgmPositionArgs = {};
  let given = 0;
  for (const k of ['startAtSec', 'trimStartSec', 'trimEndSec', 'fadeInSec', 'fadeOutSec', 'volume'] as const) {
    const v = a[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return {ok: false, errors: [`${k} 必须是数字`]};
    }
    if (v < 0) {
      return {ok: false, errors: [`${k} 不能为负数`]};
    }
    args[k] = v;
    given++;
  }
  if (given === 0) {
    return {ok: false, errors: ['至少给出一个要设置的字段（startAtSec / trimStartSec / trimEndSec / fadeInSec / fadeOutSec / volume）']};
  }
  return {ok: true, args};
};

export interface SetNarrationTimingArgs {
  segmentIndex: number;
  offsetSec?: number;
  volume?: number;
}

export const validateSetNarrationTimingArgs = (
  raw: unknown,
): {ok: true; args: SetNarrationTimingArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (!Number.isInteger(a.segmentIndex) || (a.segmentIndex as number) < 0) {
    return {ok: false, errors: ['segmentIndex 必须是非负整数']};
  }
  const args: SetNarrationTimingArgs = {segmentIndex: a.segmentIndex as number};
  let given = 0;
  for (const k of ['offsetSec', 'volume'] as const) {
    const v = a[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return {ok: false, errors: [`${k} 必须是数字`]};
    }
    if (v < 0) {
      return {ok: false, errors: [`${k} 不能为负数`]};
    }
    args[k] = v;
    given++;
  }
  if (given === 0) {
    return {ok: false, errors: ['至少给出 offsetSec 或 volume 之一']};
  }
  return {ok: true, args};
};

export const validateGetSegmentPlanArgs = (
  raw: unknown,
): {ok: true; args: {segmentIndex: number}} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (!Number.isInteger(a.segmentIndex) || (a.segmentIndex as number) < 0) {
    return {ok: false, errors: ['segmentIndex 必须是非负整数']};
  }
  return {ok: true, args: {segmentIndex: a.segmentIndex as number}};
};

/** v1.4：手放节拍标记参数（每段 ≤32；kind 白名单；t 由执行器按段时长校验——此处只验形态） */
export interface SegmentBeatArgs {
  t: number;
  kind: 'accent' | 'mark';
  target?: string;
  note?: string;
}

export const validateSetSegmentBeatsArgs = (
  raw: unknown,
): {ok: true; args: {segmentIndex: number; beats?: SegmentBeatArgs[]}} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (!Number.isInteger(a.segmentIndex) || (a.segmentIndex as number) < 0) {
    return {ok: false, errors: ['segmentIndex 必须是非负整数']};
  }
  if (a.beats === undefined) return {ok: true, args: {segmentIndex: a.segmentIndex as number}};
  if (!Array.isArray(a.beats)) {
    return {ok: false, errors: ['beats 必须是数组（缺省 = 清除）']};
  }
  if (a.beats.length > 32) {
    return {ok: false, errors: [`节拍标记每段至多 32 个（收到 ${a.beats.length} 个）——节拍是重点提示不是逐帧网格`]};
  }
  const beats: SegmentBeatArgs[] = [];
  for (let i = 0; i < a.beats.length; i++) {
    const b = (a.beats[i] ?? {}) as Record<string, unknown>;
    const t = Number(b.t);
    if (!Number.isFinite(t) || t < 0) {
      return {ok: false, errors: [`beats[${i}].t 必须是非负数（段内秒）`]};
    }
    if (b.kind !== 'accent' && b.kind !== 'mark') {
      return {ok: false, errors: [`beats[${i}].kind 必须是 accent|mark（收到 ${String(b.kind)}）`]};
    }
    beats.push({
      t: Math.round(t * 10) / 10,
      kind: b.kind,
      ...(typeof b.target === 'string' && b.target.trim() ? {target: b.target.trim().slice(0, 40)} : {}),
      ...(typeof b.note === 'string' && b.note.trim() ? {note: b.note.trim().slice(0, 80)} : {}),
    });
  }
  return {ok: true, args: {segmentIndex: a.segmentIndex as number, beats}};
};

export const validateReorderSegmentsArgs = (
  raw: unknown,
): {ok: true; args: {order: number[]}} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const order = a.order;
  if (!Array.isArray(order) || order.length === 0) {
    return {ok: false, errors: ['order 必须是非空整数数组（旧下标的新顺序）']};
  }
  if (!order.every((i) => Number.isInteger(i) && (i as number) >= 0)) {
    return {ok: false, errors: ['order 的每一项必须是非负整数']};
  }
  if (new Set(order).size !== order.length) {
    return {ok: false, errors: ['order 不能有重复下标（必须是 0..n-1 的排列）']};
  }
  return {ok: true, args: {order}};
};

export interface MoveShotArgs {
  fromSegmentIndex: number;
  clipIndex: number;
  toSegmentIndex: number;
  position?: number;
}

export const validateMoveShotArgs = (
  raw: unknown,
): {ok: true; args: MoveShotArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  for (const k of ['fromSegmentIndex', 'clipIndex', 'toSegmentIndex'] as const) {
    if (!Number.isInteger(a[k]) || (a[k] as number) < 0) {
      return {ok: false, errors: [`${k} 必须是非负整数`]};
    }
  }
  const args: MoveShotArgs = {
    fromSegmentIndex: a.fromSegmentIndex as number,
    clipIndex: a.clipIndex as number,
    toSegmentIndex: a.toSegmentIndex as number,
  };
  if (a.position !== undefined && a.position !== null) {
    if (!Number.isInteger(a.position) || (a.position as number) < 0) {
      return {ok: false, errors: ['position 必须是非负整数']};
    }
    args.position = a.position as number;
  }
  return {ok: true, args};
};

export interface ColorGradeArgs {
  look: string;
  autoMatch?: boolean;
}

export const COLOR_GRADE_LOOK_IDS = ['none', 'cleanCool', 'warmFilm', 'tealOrange', 'monoContrast', 'fadedRetro'];

/** set_color_grade 参数：look 必须是合法预设 id；autoMatch 可选布尔 */
export const validateColorGradeArgs = (
  raw: unknown,
): {ok: true; args: ColorGradeArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.look !== 'string' || !COLOR_GRADE_LOOK_IDS.includes(a.look)) {
    return {ok: false, errors: [`look 必须是以下预设 id 之一：${COLOR_GRADE_LOOK_IDS.join(' / ')}`]};
  }
  const args: ColorGradeArgs = {look: a.look};
  if (a.autoMatch !== undefined && a.autoMatch !== null) {
    if (typeof a.autoMatch !== 'boolean') {
      return {ok: false, errors: ['autoMatch 必须是布尔值']};
    }
    args.autoMatch = a.autoMatch;
  }
  return {ok: true, args};
};

export interface BrandStyleArgs {
  /** null = 恢复默认蓝 */
  brandColor?: string | null;
  fontMood?: FontMoodId;
}

export const FONT_MOOD_IDS = FONT_MOODS.map((m) => m.id);

/** set_brand_style 参数：brandColor/fontMood 均可选但至少一项；色值 #rgb/#rrggbb，"default" 恢复默认 */
export const validateBrandStyleArgs = (
  raw: unknown,
): {ok: true; args: BrandStyleArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const hasColor = a.brandColor !== undefined && a.brandColor !== null && a.brandColor !== '';
  const hasMood = a.fontMood !== undefined && a.fontMood !== null && a.fontMood !== '';
  if (!hasColor && !hasMood) {
    return {ok: false, errors: ['至少提供 brandColor 或 fontMood 之一']};
  }
  const args: BrandStyleArgs = {};
  if (hasColor) {
    if (typeof a.brandColor !== 'string') {
      return {ok: false, errors: ['brandColor 必须是字符串（#RRGGBB 或 "default"）']};
    }
    if (a.brandColor.trim().toLowerCase() === 'default') {
      args.brandColor = null;
    } else {
      const norm = normalizeBrandColor(a.brandColor);
      if (!norm) {
        return {ok: false, errors: ['brandColor 必须是合法色值（#RRGGBB，如 #F97316）或 "default" 恢复默认']};
      }
      args.brandColor = norm.toUpperCase();
    }
  }
  if (hasMood) {
    if (typeof a.fontMood !== 'string' || !isFontMoodId(a.fontMood)) {
      return {ok: false, errors: [`fontMood 必须是以下之一：${FONT_MOOD_IDS.join(' / ')}`]};
    }
    args.fontMood = a.fontMood;
  }
  return {ok: true, args};
};

export interface AlignBeatsArgs {
  tolerance: number;
}/** align_beats 参数：tolerance 可选（0.2~1.2，缺省 0.6），越界钳制 */
export const validateAlignBeatsArgs = (
  raw: unknown,
): {ok: true; args: AlignBeatsArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  let tolerance = 0.6;
  if (a.tolerance !== undefined && a.tolerance !== null) {
    if (typeof a.tolerance !== 'number' || !Number.isFinite(a.tolerance)) {
      return {ok: false, errors: ['tolerance 必须是数字']};
    }
    tolerance = Math.max(0.2, Math.min(1.2, a.tolerance));
  }
  return {ok: true, args: {tolerance}};
};

// ====== auto_beat_montage（卡点剪辑）参数 ======

/** 镜头引用：source = get_footage_map 返回的素材序号，shot = 该素材的镜头下标 */
export interface MontageShotRefArg {
  source: number;
  shot: number;
}

/** LLM 创意指令（全部可选；语义见 shared/edit-brain 的 MontageDirectives） */
export interface MontageDirectivesArgs {
  openingShot?: MontageShotRefArg;
  closingShot?: MontageShotRefArg;
  firstDropShot?: MontageShotRefArg;
  excludeShots?: MontageShotRefArg[];
  /** 段落槽位拍数覆盖（1~8，键限 intro/build/break/drop/outro） */
  slotBeats?: Record<string, number>;
}

export interface AutoBeatMontageArgs {
  targetSec?: number;
  /** 自动把全场能量峰最高的镜头钉到第一个 drop 第一拍（高光钩子） */
  autoMoneyShot: boolean;
  directives?: MontageDirectivesArgs;
}

const MONTAGE_SECTION_KEYS = new Set(['intro', 'build', 'break', 'drop', 'outro']);

const parseShotRefArg = (raw: unknown, label: string): {ok: true; ref: MontageShotRefArg} | {ok: false; errors: string[]} => {
  const r = (raw || {}) as Record<string, unknown>;
  if (!Number.isInteger(r.source) || (r.source as number) < 0 || !Number.isInteger(r.shot) || (r.shot as number) < 0) {
    return {ok: false, errors: [`directives.${label} 需要非负整数 source/shot（用 get_footage_map 查素材镜头表）`]};
  }
  return {ok: true, ref: {source: r.source as number, shot: r.shot as number}};
};

export const validateAutoBeatMontageArgs = (
  raw: unknown,
): {ok: true; args: AutoBeatMontageArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const errors: string[] = [];
  let targetSec: number | undefined;
  if (a.targetSec !== undefined && a.targetSec !== null) {
    if (typeof a.targetSec !== 'number' || !Number.isFinite(a.targetSec) || a.targetSec <= 0) {
      return {ok: false, errors: ['targetSec 必须是正数（秒）']};
    }
    targetSec = a.targetSec;
  }
  const autoMoneyShot = a.autoMoneyShot === true;

  let directives: MontageDirectivesArgs | undefined;
  if (a.directives !== undefined && a.directives !== null) {
    if (typeof a.directives !== 'object' || Array.isArray(a.directives)) {
      return {ok: false, errors: ['directives 必须是对象（openingShot/closingShot/firstDropShot/excludeShots/slotBeats）']};
    }
    const d = (a.directives || {}) as Record<string, unknown>;
    directives = {};
    for (const key of ['openingShot', 'closingShot', 'firstDropShot'] as const) {
      if (d[key] === undefined || d[key] === null) continue;
      const r = parseShotRefArg(d[key], key);
      if (!r.ok) errors.push(...r.errors);
      else directives[key] = r.ref;
    }
    if (d.excludeShots !== undefined && d.excludeShots !== null) {
      if (!Array.isArray(d.excludeShots)) {
        errors.push('directives.excludeShots 必须是数组（[{source, shot}…]）');
      } else {
        const refs: MontageShotRefArg[] = [];
        d.excludeShots.forEach((item, i) => {
          const r = parseShotRefArg(item, `excludeShots[${i}]`);
          if (!r.ok) errors.push(...r.errors);
          else refs.push(r.ref);
        });
        if (refs.length > 0) directives.excludeShots = refs;
      }
    }
    if (d.slotBeats !== undefined && d.slotBeats !== null) {
      if (typeof d.slotBeats !== 'object' || Array.isArray(d.slotBeats)) {
        errors.push('directives.slotBeats 必须是对象（{drop: 1, build: 2…}，键限 intro/build/break/drop/outro）');
      } else {
        const sb: Record<string, number> = {};
        for (const [k, v] of Object.entries(d.slotBeats as Record<string, unknown>)) {
          if (!MONTAGE_SECTION_KEYS.has(k)) continue; // 未知段落键宽容忽略
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            errors.push(`directives.slotBeats.${k} 必须是数字（1~8 拍）`);
            continue;
          }
          sb[k] = Math.max(1, Math.min(8, Math.round(v)));
        }
        if (Object.keys(sb).length > 0) directives.slotBeats = sb;
      }
    }
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args: {targetSec, autoMoneyShot, directives}};
};

// ====== generate_template 参数校验 ======

export interface GenerateTemplateArgs {
  name: string;
  description: string;
  code: string;
  defaultDuration: number;
  templateId?: string;
  paramSpecs?: TemplateParamSpec[];
  /** 文字槽位声明（已清洗）：组件实际消费的 props.text 字段 */
  textSlots?: string[];
}

export const validateGenerateTemplateArgs = (
  raw: unknown,
): {ok: true; args: GenerateTemplateArgs; notes?: string[]} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof a.name !== 'string' || !a.name.trim()) {
    errors.push('name 必填（模板名称）');
  } else if (a.name.trim().length > GENERATED_NAME_MAX) {
    errors.push(`name 超长（≤${GENERATED_NAME_MAX} 字）`);
  }

  let description = '';
  if (a.description !== undefined && a.description !== null) {
    if (typeof a.description !== 'string') {
      errors.push('description 必须是字符串');
    } else if (a.description.length > GENERATED_DESCRIPTION_MAX) {
      errors.push(`description 超长（≤${GENERATED_DESCRIPTION_MAX} 字）`);
    } else {
      description = a.description;
    }
  }

  if (typeof a.code !== 'string' || !a.code.trim()) {
    errors.push('code 必填（受限 TSX 源码，必须定义 const GeneratedTemplate = (props) => {...}）');
  } else if (a.code.length > GENERATED_SOURCE_MAX) {
    errors.push(`code 超长（≤${GENERATED_SOURCE_MAX} 字符，当前 ${a.code.length}）`);
  }

  let defaultDuration = 8;
  if (a.defaultDuration !== undefined && a.defaultDuration !== null) {
    if (typeof a.defaultDuration !== 'number' || !Number.isFinite(a.defaultDuration) || a.defaultDuration < 1 || a.defaultDuration > 60) {
      errors.push('defaultDuration 必须是 1-60 的数字（秒）');
    } else {
      defaultDuration = a.defaultDuration;
    }
  }

  let templateId: string | undefined;
  if (a.templateId !== undefined && a.templateId !== null) {
    if (typeof a.templateId !== 'string' || !isGeneratedTemplateId(a.templateId)) {
      errors.push('templateId 必须是已有 gen- 前缀的模板 id（留空表示新建）');
    } else {
      templateId = a.templateId;
    }
  }

  let paramSpecs: TemplateParamSpec[] | undefined;
  if (a.paramSpecs !== undefined && a.paramSpecs !== null) {
    if (!Array.isArray(a.paramSpecs)) {
      errors.push('paramSpecs 必须是数组（[{key,label,min,max,step,default}…]）');
    } else if (a.paramSpecs.length > GENERATED_PARAM_MAX) {
      errors.push(`paramSpecs 超过 ${GENERATED_PARAM_MAX} 个参数`);
    } else {
      const specs: TemplateParamSpec[] = [];
      const keys = new Set<string>();
      a.paramSpecs.forEach((s, i) => {
        if (!isValidParamSpec(s)) {
          errors.push(`paramSpecs[${i}] 结构非法（需要 key/label/min/max/step/default，且 min≤max、step>0）`);
          return;
        }
        const spec = s as TemplateParamSpec;
        if (keys.has(spec.key)) {
          errors.push(`paramSpecs[${i}] key「${spec.key}」重复`);
          return;
        }
        keys.add(spec.key);
        specs.push(spec);
      });
      if (specs.length > 0) paramSpecs = specs;
    }
  }

  // 文字槽位：给出时必须是数组；非法值剔除并以 notes 回告（服务层落库会再清洗一遍兜底）
  let textSlots: string[] | undefined;
  const notes: string[] = [];
  if (a.textSlots !== undefined && a.textSlots !== null) {
    if (!Array.isArray(a.textSlots)) {
      errors.push('textSlots 必须是字符串数组（合法值：title/subtitle/features/brandName）');
    } else {
      const s = sanitizeTextSlots(a.textSlots);
      textSlots = s.slots;
      if (s.dropped.length > 0) {
        notes.push(`textSlots 含非法槽位 ${s.dropped.map((d) => `「${d}」`).join('')}，已剔除（合法值：title/subtitle/features/brandName）`);
      }
    }
  }

  if (errors.length > 0) return {ok: false, errors};
  return {
    ok: true,
    args: {
      name: (a.name as string).trim(),
      description,
      code: a.code as string,
      defaultDuration,
      ...(templateId ? {templateId} : {}),
      ...(paramSpecs ? {paramSpecs} : {}),
      ...(textSlots ? {textSlots} : {}),
    },
    ...(notes.length > 0 ? {notes} : {}),
  };
};

// ====== review_template 参数校验 ======

export interface ReviewTemplateArgs {
  templateId: string;
  focus?: string;
}

export const validateReviewTemplateArgs = (
  raw: unknown,
): {ok: true; args: ReviewTemplateArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.templateId !== 'string' || !a.templateId.trim()) {
    return {ok: false, errors: ['templateId 必填（AI 生成模板的 gen- id，generate_template 返回的 templateId）']};
  }
  if (!isGeneratedTemplateId(a.templateId)) {
    return {ok: false, errors: ['templateId 必须是 gen- 前缀的 AI 生成模板 id（内置/市场模板不需要本工具，用 preview_storyboard_frame 查看即可）']};
  }
  const focus = typeof a.focus === 'string' && a.focus.trim() ? a.focus.trim().slice(0, 200) : undefined;
  return {ok: true, args: {templateId: a.templateId.trim(), ...(focus ? {focus} : {})}};
};

export interface FinePrintArgs {
  text?: string;
  position?: FinePrintPosition;
  opacity?: number;
  sizeScale?: number;
}

const FINE_PRINT_POSITION_VALUES: ReadonlySet<string> = new Set(['bottomLeft', 'bottomCenter', 'bottomRight']);

/** set_fine_print 参数：全部可选；text 截到 200 字，数值越界钳制 */
export const validateFinePrintArgs = (
  raw: unknown,
): {ok: true; args: FinePrintArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: FinePrintArgs = {};
  if (a.text !== undefined && a.text !== null) {
    if (typeof a.text !== 'string') {
      return {ok: false, errors: ['text 必须是文字']};
    }
    args.text = a.text.slice(0, 200);
  }
  if (a.position !== undefined && a.position !== null) {
    if (typeof a.position !== 'string' || !FINE_PRINT_POSITION_VALUES.has(a.position)) {
      return {ok: false, errors: ['position 必须是 bottomLeft/bottomCenter/bottomRight 之一']};
    }
    args.position = a.position as FinePrintPosition;
  }
  if (a.opacity !== undefined && a.opacity !== null) {
    if (typeof a.opacity !== 'number' || !Number.isFinite(a.opacity)) {
      return {ok: false, errors: ['opacity 必须是数字']};
    }
    args.opacity = Math.max(0.2, Math.min(1, a.opacity));
  }
  if (a.sizeScale !== undefined && a.sizeScale !== null) {
    if (typeof a.sizeScale !== 'number' || !Number.isFinite(a.sizeScale)) {
      return {ok: false, errors: ['sizeScale 必须是数字']};
    }
    args.sizeScale = Math.max(0.6, Math.min(1.6, a.sizeScale));
  }
  return {ok: true, args};
};

export interface CaptureElementArgs {
  selector: string;
  attachToSegment?: number;
  scale: number;
}

/** capture_element 参数：selector 必填；attachToSegment 可选段下标；scale 钳到 0.05~1 */
export const validateCaptureElementArgs = (
  raw: unknown,
): {ok: true; args: CaptureElementArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.selector !== 'string' || !a.selector.trim()) {
    return {ok: false, errors: ['selector 必须是非空文字（CSS 选择器）']};
  }
  const args: CaptureElementArgs = {selector: a.selector.trim(), scale: 0.4};
  if (a.attachToSegment !== undefined && a.attachToSegment !== null) {
    if (typeof a.attachToSegment !== 'number' || !Number.isInteger(a.attachToSegment) || a.attachToSegment < 0) {
      return {ok: false, errors: ['attachToSegment 必须是 ≥0 的整数（段下标）']};
    }
    args.attachToSegment = a.attachToSegment;
  }
  if (a.scale !== undefined && a.scale !== null) {
    if (typeof a.scale !== 'number' || !Number.isFinite(a.scale)) {
      return {ok: false, errors: ['scale 必须是数字']};
    }
    args.scale = Math.max(0.05, Math.min(1, a.scale));
  }
  return {ok: true, args};
};

export interface SetOverlayArgs {
  index: number;
  remove: boolean;
  patch: {
    x?: number; y?: number; scale?: number; floatAmp?: number;
    tiltX?: number; tiltY?: number; radius?: number; shadow?: number; opacity?: number;
  };
}

/** set_segment_overlay 参数：index 必填；各字段可选并按取值范围钳制；remove=true 移除 */
export const validateSetOverlayArgs = (
  raw: unknown,
): {ok: true; args: SetOverlayArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.index !== 'number' || !Number.isInteger(a.index) || a.index < 0) {
    return {ok: false, errors: ['index 必须是 ≥0 的整数（段下标）']};
  }
  const args: SetOverlayArgs = {index: a.index, remove: a.remove === true, patch: {}};
  const num = (key: keyof SetOverlayArgs['patch'], min: number, max: number): boolean => {
    const v = a[key as string];
    if (v === undefined || v === null) return true;
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    args.patch[key] = Math.max(min, Math.min(max, v));
    return true;
  };
  if (!num('x', 0, 1)) return {ok: false, errors: ['x 必须是数字（0~1）']};
  if (!num('y', 0, 1)) return {ok: false, errors: ['y 必须是数字（0~1）']};
  if (!num('scale', 0.05, 1)) return {ok: false, errors: ['scale 必须是数字（0.05~1）']};
  if (!num('floatAmp', 0, 2)) return {ok: false, errors: ['floatAmp 必须是数字（0~2）']};
  if (!num('tiltX', -30, 30)) return {ok: false, errors: ['tiltX 必须是数字（-30~30）']};
  if (!num('tiltY', -30, 30)) return {ok: false, errors: ['tiltY 必须是数字（-30~30）']};
  if (!num('radius', 0, 40)) return {ok: false, errors: ['radius 必须是数字（0~40）']};
  if (!num('shadow', 0, 2)) return {ok: false, errors: ['shadow 必须是数字（0~2）']};
  if (!num('opacity', 0, 1)) return {ok: false, errors: ['opacity 必须是数字（0~1）']};
  return {ok: true, args};
};

export interface LogoArgs {
  position?: LogoPosition;
  size?: number;
  opacity?: number;
  visible?: boolean;
}

const LOGO_POSITION_VALUES: ReadonlySet<string> = new Set(['topLeft', 'topRight', 'bottomLeft', 'bottomRight']);

/** set_logo 参数：position/size/opacity/visible 均可选；至少应有一个 */
export const validateLogoArgs = (
  raw: unknown,
): {ok: true; args: LogoArgs} | {ok: false, errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: LogoArgs = {};
  if (a.position !== undefined && a.position !== null) {
    if (typeof a.position !== 'string' || !LOGO_POSITION_VALUES.has(a.position)) {
      return {ok: false, errors: ['position 必须是 topLeft/topRight/bottomLeft/bottomRight 之一']};
    }
    args.position = a.position as LogoPosition;
  }
  if (a.size !== undefined && a.size !== null) {
    if (typeof a.size !== 'number' || !Number.isFinite(a.size)) {
      return {ok: false, errors: ['size 必须是数字']};
    }
    args.size = Math.max(0.05, Math.min(0.4, a.size));
  }
  if (a.opacity !== undefined && a.opacity !== null) {
    if (typeof a.opacity !== 'number' || !Number.isFinite(a.opacity)) {
      return {ok: false, errors: ['opacity 必须是数字']};
    }
    args.opacity = Math.max(0, Math.min(1, a.opacity));
  }
  if (a.visible !== undefined && a.visible !== null) {
    if (typeof a.visible !== 'boolean') {
      return {ok: false, errors: ['visible 必须是布尔值']};
    }
    args.visible = a.visible;
  }
  if (Object.keys(args).length === 0) {
    return {ok: false, errors: ['至少需要提供 position/size/opacity/visible 之一']};
  }
  return {ok: true, args};
};

// ====== 阶段四新工具的参数校验（屏幕录制 / 截屏）======

export interface ScreenshotArgs {
  sourceId?: string;
  saveToStoryboard: boolean;
  segmentIndex?: number;
}

/** take_screenshot 参数：sourceId/segmentIndex 可选；saveToStoryboard 可选布尔缺省 false */
export const validateScreenshotArgs = (
  raw: unknown,
): {ok: true; args: ScreenshotArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: ScreenshotArgs = {saveToStoryboard: false};
  if (a.sourceId !== undefined && a.sourceId !== null) {
    if (typeof a.sourceId !== 'string' || !a.sourceId) {
      return {ok: false, errors: ['sourceId 必须是非空字符串（从 list_capture_sources 获取）']};
    }
    args.sourceId = a.sourceId;
  }
  if (a.saveToStoryboard !== undefined && a.saveToStoryboard !== null) {
    if (typeof a.saveToStoryboard !== 'boolean') {
      return {ok: false, errors: ['saveToStoryboard 必须是布尔值']};
    }
    args.saveToStoryboard = a.saveToStoryboard;
  }
  if (a.segmentIndex !== undefined && a.segmentIndex !== null) {
    if (typeof a.segmentIndex !== 'number' || !Number.isInteger(a.segmentIndex) || a.segmentIndex < 0) {
      return {ok: false, errors: ['segmentIndex 必须是非负整数（段下标，0 起）']};
    }
    args.segmentIndex = a.segmentIndex;
  }
  return {ok: true, args};
};

/** start_screen_recording 的选区参数（视频像素矩形；仅屏幕源可用） */
export interface RecordingRegionArgs {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StartRecordingArgs {
  sourceId?: string;
  /** 按源名称/窗口标题模糊匹配（执行器解析成具体源；与 sourceId 二选一） */
  sourceName?: string;
  withMic: boolean;
  withSystemAudio: boolean;
  /** 起录前倒计时秒数（0-10，缺省 0/undefined 立即起录） */
  countdownSec?: number;
  /** 画面构成（启用摄像头烧录）：pip 画中画 / side 左右分屏 / stack 上下分屏 / camera 仅摄像头 */
  layout?: RecordingLayout;
  /** 选区录制（仅屏幕源；camera 构图无效）：视频像素矩形 */
  region?: RecordingRegionArgs;
  /** 帧率 10-60，缺省 30 */
  fps?: number;
  /** 输出高度上限（像素），源更高时等比缩小 */
  maxHeight?: number;
  /** 视频码率 Mbps 2-40 */
  bitrateMbps?: number;
}

/** start_screen_recording 参数：sourceId/sourceName 可选二选一；withMic/withSystemAudio 可选布尔缺省 false；
 *  countdownSec 可选 0-10 整数；layout 可选构图枚举（pip/side/stack/camera）；region 可选视频像素矩形（≥320×180）；
 *  fps 可选 10-60；maxHeight 可选 ≥240；bitrateMbps 可选 2-40 */
export const validateStartRecordingArgs = (
  raw: unknown,
): {ok: true; args: StartRecordingArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: StartRecordingArgs = {withMic: false, withSystemAudio: false};
  if (a.sourceId !== undefined && a.sourceId !== null) {
    if (typeof a.sourceId !== 'string' || !a.sourceId) {
      return {ok: false, errors: ['sourceId 必须是非空字符串（从 list_capture_sources 获取）']};
    }
    args.sourceId = a.sourceId;
  }
  if (a.sourceName !== undefined && a.sourceName !== null) {
    if (typeof a.sourceName !== 'string' || !a.sourceName.trim()) {
      return {ok: false, errors: ['sourceName 必须是非空字符串（源名称/窗口标题的关键词，如 "Chrome"）']};
    }
    if (a.sourceId !== undefined && a.sourceId !== null) {
      return {ok: false, errors: ['sourceId 与 sourceName 只能二选一（同时给出时请只留 sourceId）']};
    }
    args.sourceName = a.sourceName.trim();
  }
  if (a.withMic !== undefined && a.withMic !== null) {
    if (typeof a.withMic !== 'boolean') {
      return {ok: false, errors: ['withMic 必须是布尔值']};
    }
    args.withMic = a.withMic;
  }
  if (a.withSystemAudio !== undefined && a.withSystemAudio !== null) {
    if (typeof a.withSystemAudio !== 'boolean') {
      return {ok: false, errors: ['withSystemAudio 必须是布尔值']};
    }
    args.withSystemAudio = a.withSystemAudio;
  }
  if (a.countdownSec !== undefined && a.countdownSec !== null) {
    if (typeof a.countdownSec !== 'number' || !Number.isInteger(a.countdownSec) || a.countdownSec < 0 || a.countdownSec > 10) {
      return {ok: false, errors: ['countdownSec 必须是 0-10 的整数（秒）']};
    }
    args.countdownSec = a.countdownSec;
  }
  if (a.layout !== undefined && a.layout !== null) {
    if (typeof a.layout !== 'string' || !RECORDING_LAYOUTS.includes(a.layout as RecordingLayout)) {
      return {ok: false, errors: [`layout 必须是 ${RECORDING_LAYOUTS.join(' / ')} 之一（画面构成）`]};
    }
    args.layout = a.layout as RecordingLayout;
  }
  if (a.region !== undefined && a.region !== null) {
    const r = a.region as Record<string, unknown>;
    const nums = ['x', 'y', 'width', 'height'].map((k) => r[k]);
    if (nums.some((v) => typeof v !== 'number' || !Number.isInteger(v))) {
      return {ok: false, errors: ['region 的 x/y/width/height 必须都是整数（视频像素）']};
    }
    const [x, y, width, height] = nums as number[];
    if (x < 0 || y < 0) return {ok: false, errors: ['region 的 x/y 必须 ≥0（原点在屏幕左上角）']};
    if (width < 320 || height < 180) {
      return {ok: false, errors: [`region 至少 320×180（收到 ${width}×${height}）`]};
    }
    args.region = {x, y, width, height};
  }
  if (a.fps !== undefined && a.fps !== null) {
    if (typeof a.fps !== 'number' || !Number.isInteger(a.fps) || a.fps < 10 || a.fps > 60) {
      return {ok: false, errors: ['fps 必须是 10-60 的整数（缺省 30）']};
    }
    args.fps = a.fps;
  }
  if (a.maxHeight !== undefined && a.maxHeight !== null) {
    if (typeof a.maxHeight !== 'number' || !Number.isInteger(a.maxHeight) || a.maxHeight < 240 || a.maxHeight > 4320) {
      return {ok: false, errors: ['maxHeight 必须是 240-4320 的整数（像素，常用 1080/720/480）']};
    }
    args.maxHeight = a.maxHeight;
  }
  if (a.bitrateMbps !== undefined && a.bitrateMbps !== null) {
    if (typeof a.bitrateMbps !== 'number' || !Number.isFinite(a.bitrateMbps) || a.bitrateMbps < 2 || a.bitrateMbps > 40) {
      return {ok: false, errors: ['bitrateMbps 必须是 2-40 的数字（Mbps，缺省按分辨率自动约 8）']};
    }
    args.bitrateMbps = a.bitrateMbps;
  }
  return {ok: true, args};
};

export interface ImportMediaArgs {
  index: number;
  path: string;
}

/** import_segment_media 参数：index 必填非负整数；path 必填非空字符串 */
export const validateImportMediaArgs = (
  raw: unknown,
): {ok: true; args: ImportMediaArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.index !== 'number' || !Number.isInteger(a.index) || a.index < 0) {
    return {ok: false, errors: ['index 必须是非负整数（段下标，0 起）']};
  }
  if (typeof a.path !== 'string' || !a.path) {
    return {ok: false, errors: ['path 必须是非空字符串（媒体文件本地绝对路径）']};
  }
  return {ok: true, args: {index: a.index, path: a.path}};
};

// ====== set_media_colorspace（素材 Log 色彩曲线）参数 ======

export interface SetColorspaceArgs {
  index: number;
  videoIndex: number;
  colorCurve: ColorCurveId | 'none';
}

export const validateSetColorspaceArgs = (
  raw: unknown,
): {ok: true; args: SetColorspaceArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.index !== 'number' || !Number.isInteger(a.index) || a.index < 0) {
    return {ok: false, errors: ['index 必须是非负整数（段下标，0 起）']};
  }
  if (a.videoIndex !== undefined && a.videoIndex !== null &&
      (typeof a.videoIndex !== 'number' || !Number.isInteger(a.videoIndex) || a.videoIndex < 0)) {
    return {ok: false, errors: ['videoIndex 必须是非负整数（段内素材下标，0 起）']};
  }
  if (typeof a.colorCurve !== 'string' || !['none', ...COLOR_CURVE_IDS].includes(a.colorCurve)) {
    return {ok: false, errors: [`colorCurve 必须是 ${['none', ...COLOR_CURVE_IDS].join(' / ')} 之一`]};
  }
  return {ok: true, args: {index: a.index, videoIndex: a.videoIndex ?? 0, colorCurve: a.colorCurve as ColorCurveId | 'none'}};
};

export interface StopRecordingArgs {
  segmentIndex?: number;
  /** 入段时直接落裁剪的可用区间起点（秒，≥0） */
  trimStartSec?: number;
  /** 入段时直接落裁剪的可用区间终点（秒，需 > trimStartSec；超时长被钳制） */
  trimEndSec?: number;
}

/** stop_screen_recording 参数：segmentIndex 可选非负整数；trimStartSec/trimEndSec 可选裁剪区间 */
export const validateStopRecordingArgs = (
  raw: unknown,
): {ok: true; args: StopRecordingArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: StopRecordingArgs = {};
  if (a.segmentIndex !== undefined && a.segmentIndex !== null) {
    if (typeof a.segmentIndex !== 'number' || !Number.isInteger(a.segmentIndex) || a.segmentIndex < 0) {
      return {ok: false, errors: ['segmentIndex 必须是非负整数（段下标，0 起）']};
    }
    args.segmentIndex = a.segmentIndex;
  }
  if (a.trimStartSec !== undefined && a.trimStartSec !== null) {
    if (typeof a.trimStartSec !== 'number' || !Number.isFinite(a.trimStartSec) || a.trimStartSec < 0) {
      return {ok: false, errors: ['trimStartSec 必须是 ≥0 的数字（秒）']};
    }
    args.trimStartSec = a.trimStartSec;
  }
  if (a.trimEndSec !== undefined && a.trimEndSec !== null) {
    if (typeof a.trimEndSec !== 'number' || !Number.isFinite(a.trimEndSec) || a.trimEndSec <= 0) {
      return {ok: false, errors: ['trimEndSec 必须是 >0 的数字（秒）']};
    }
    args.trimEndSec = a.trimEndSec;
  }
  if (args.trimStartSec !== undefined && args.trimEndSec !== undefined && args.trimEndSec <= args.trimStartSec) {
    return {ok: false, errors: ['trimEndSec 必须大于 trimStartSec']};
  }
  return {ok: true, args};
};


// ====== 阶段五新工具的参数校验（一键成片流水线：多帧看图 / 拆段）======

export interface ViewMediaFramesArgs {
  /** 段下标（path 缺省时必填） */
  index?: number;
  /** 媒体文件本地路径（与 index 二选一，用于查看已渲染成片） */
  path?: string;
  /** 抽帧时间点（秒，≤8 个）；undefined = 缺省在可用区间均匀采样 */
  timesSec?: number[];
  /** 缺省采样数量 2-8（缺省 4）；给了 timesSec 时忽略 */
  count?: number;
  /** contact-sheet = 缩略图墙（一张拼图扫全片，预算友好）；缺省 frames = 普通抽帧 */
  mode?: 'frames' | 'contact-sheet';
  /** contact-sheet 格数 10-144（缺省 100 = 10×10） */
  cells?: number;
}

/** view_media_frames 参数：index/path 至少其一；timesSec 可选 1-8 个 ≥0 秒数；count 可选 2-8；
 *  mode=contact-sheet 时 cells 可选 10-144 */
export const validateViewMediaFramesArgs = (
  raw: unknown,
): {ok: true; args: ViewMediaFramesArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: ViewMediaFramesArgs = {};
  if (a.path !== undefined && a.path !== null) {
    if (typeof a.path !== 'string' || !a.path) {
      return {ok: false, errors: ['path 必须是非空字符串']};
    }
    args.path = a.path;
  }
  if (a.index !== undefined && a.index !== null) {
    if (typeof a.index !== 'number' || !Number.isInteger(a.index) || a.index < 0) {
      return {ok: false, errors: ['index 必须是非负整数（段下标，0 起）']};
    }
    args.index = a.index;
  }
  if (args.path === undefined && args.index === undefined) {
    return {ok: false, errors: ['需给出 index（段下标）或 path（文件路径）之一']};
  }
  if (a.timesSec !== undefined && a.timesSec !== null) {
    if (!Array.isArray(a.timesSec) || a.timesSec.length < 1 || a.timesSec.length > 8) {
      return {ok: false, errors: ['timesSec 需为 1-8 个秒数的数组']};
    }
    for (const t of a.timesSec) {
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
        return {ok: false, errors: ['timesSec 必须是 ≥0 的数字']};
      }
    }
    args.timesSec = a.timesSec as number[];
  }
  if (a.count !== undefined && a.count !== null) {
    if (typeof a.count !== 'number' || !Number.isInteger(a.count) || a.count < 2 || a.count > 8) {
      return {ok: false, errors: ['count 必须是 2-8 的整数']};
    }
    args.count = a.count;
  }
  if (a.mode !== undefined && a.mode !== null) {
    if (a.mode !== 'frames' && a.mode !== 'contact-sheet') {
      return {ok: false, errors: ['mode 必须是 frames（普通抽帧，缺省）或 contact-sheet（缩略图墙）']};
    }
    args.mode = a.mode;
  }
  if (a.cells !== undefined && a.cells !== null) {
    if (typeof a.cells !== 'number' || !Number.isInteger(a.cells) || a.cells < 10 || a.cells > 144) {
      return {ok: false, errors: ['cells 必须是 10-144 的整数（contact sheet 格数）']};
    }
    args.cells = a.cells;
  }
  return {ok: true, args};
};

export interface ScanMediaArgs {
  index: number;
  /** 段内视频素材下标（缺省 0） */
  videoIndex?: number;
}

/** scan_media 参数：index 必填非负整数；videoIndex 可选非负整数 */
export const validateScanMediaArgs = (
  raw: unknown,
): {ok: true; args: ScanMediaArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.index !== 'number' || !Number.isInteger(a.index) || a.index < 0) {
    return {ok: false, errors: ['index 必须是非负整数（段下标，0 起）']};
  }
  if (a.videoIndex !== undefined && a.videoIndex !== null &&
      (typeof a.videoIndex !== 'number' || !Number.isInteger(a.videoIndex) || a.videoIndex < 0)) {
    return {ok: false, errors: ['videoIndex 必须是非负整数（段内素材下标，0 起）']};
  }
  return {ok: true, args: {index: a.index, videoIndex: a.videoIndex ?? 0}};
};

export interface SplitSegmentArgs {
  index: number;
  atSec: number;
}

/** split_segment 参数：index 非负整数；atSec 为 >0 的有限数（段时长边界由 store 校验） */
export const validateSplitSegmentArgs = (
  raw: unknown,
): {ok: true; args: SplitSegmentArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const idx = a.index;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
    return {ok: false, errors: ['index 必须是非负整数（段下标，0 起）']};
  }
  const at = a.atSec;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
    return {ok: false, errors: ['atSec 必须是 >0 的数字（拆点秒数，相对段起点）']};
  }
  return {ok: true, args: {index: idx, atSec: at}};
};

export interface DeleteSegmentArgs {
  index: number;
}

/** delete_segment 参数：index 必填非负整数 */
export const validateDeleteSegmentArgs = (
  raw: unknown,
): {ok: true; args: DeleteSegmentArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.index !== 'number' || !Number.isInteger(a.index) || a.index < 0) {
    return {ok: false, errors: ['index 必须是非负整数（段下标，0 起）']};
  }
  return {ok: true, args: {index: a.index}};
};

export interface MoveSegmentArgs {
  fromIndex: number;
  toIndex: number;
}

/** move_segment 参数：fromIndex/toIndex 必填非负整数（相等视为无操作，由执行器放行） */
export const validateMoveSegmentArgs = (
  raw: unknown,
): {ok: true; args: MoveSegmentArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof a.fromIndex !== 'number' || !Number.isInteger(a.fromIndex) || a.fromIndex < 0) {
    errors.push('fromIndex 必须是非负整数（段下标，0 起）');
  }
  if (typeof a.toIndex !== 'number' || !Number.isInteger(a.toIndex) || a.toIndex < 0) {
    errors.push('toIndex 必须是非负整数（段下标，0 起）');
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args: {fromIndex: a.fromIndex as number, toIndex: a.toIndex as number}};
};

export interface RemoveSegmentMediaArgs {
  index: number;
  videoIndex: number;
}

/** remove_segment_media 参数：index/videoIndex 必填非负整数 */
export const validateRemoveSegmentMediaArgs = (
  raw: unknown,
): {ok: true; args: RemoveSegmentMediaArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.index !== 'number' || !Number.isInteger(a.index) || a.index < 0) {
    return {ok: false, errors: ['index 必须是非负整数（段下标，0 起）']};
  }
  if (typeof a.videoIndex !== 'number' || !Number.isInteger(a.videoIndex) || a.videoIndex < 0) {
    return {ok: false, errors: ['videoIndex 必须是非负整数（段内素材下标，0 起，顺序同 get_segment_media 返回）']};
  }
  return {ok: true, args: {index: a.index, videoIndex: a.videoIndex}};
};

export interface ReviewRenderArgs {
  /** 成片文件路径（缺省=最近一次渲染输出） */
  path?: string;
  /** 审片侧重 */
  focus?: string;
}

/** review_render 参数：path/focus 均可选；path 非空字符串，focus ≤100 字 */
export const validateReviewRenderArgs = (
  raw: unknown,
): {ok: true; args: ReviewRenderArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: ReviewRenderArgs = {};
  if (a.path !== undefined && a.path !== null) {
    if (typeof a.path !== 'string' || !a.path.trim()) {
      return {ok: false, errors: ['path 必须是非空字符串（成片文件路径）']};
    }
    args.path = a.path.trim();
  }
  if (a.focus !== undefined && a.focus !== null) {
    if (typeof a.focus !== 'string' || !a.focus.trim()) {
      return {ok: false, errors: ['focus 必须是非空字符串（审片侧重）']};
    }
    if (a.focus.length > 100) {
      return {ok: false, errors: ['focus 过长（≤100 字）']};
    }
    args.focus = a.focus.trim();
  }
  return {ok: true, args};
};

export interface ExportCover3dText {
  text: string;
  x?: number;
  y?: number;
  size?: number;
  color?: string;
  sideColor?: string;
  depth?: number;
  angle?: number;
  behind?: boolean;
}

export interface ExportCoverArgs {
  timeSec?: number;
  preset?: CoverPresetId;
  title?: string;
  subtitle?: string;
  tag?: string;
  scrim?: number;
  format?: 'jpg' | 'png';
  add3dText?: ExportCover3dText;
}

const HEX_STR_RE = /^#[0-9a-fA-F]{6}$/;

/** export_cover 参数：全部可选；数值/枚举非法直接报错（让 agent 明确知道传错了） */
export const validateExportCoverArgs = (
  raw: unknown,
): {ok: true; args: ExportCoverArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: ExportCoverArgs = {};
  const errors: string[] = [];
  if (a.timeSec !== undefined && a.timeSec !== null) {
    if (typeof a.timeSec !== 'number' || !Number.isFinite(a.timeSec) || a.timeSec < 0) {
      errors.push('timeSec 必须是 ≥0 的数字（选帧秒数）');
    } else {
      args.timeSec = a.timeSec;
    }
  }
  if (a.preset !== undefined && a.preset !== null) {
    if (!COVER_PRESET_IDS.includes(a.preset as CoverPresetId)) {
      errors.push(`preset 必须是 ${COVER_PRESET_IDS.map((p) => `'${p}'`).join(' / ')} 之一`);
    } else {
      args.preset = a.preset as CoverPresetId;
    }
  }
  for (const key of ['title', 'subtitle', 'tag'] as const) {
    const v = a[key];
    if (v !== undefined && v !== null) {
      if (typeof v !== 'string') {
        errors.push(`${key} 必须是字符串`);
      } else {
        args[key] = v.trim();
      }
    }
  }
  if (a.scrim !== undefined && a.scrim !== null) {
    if (typeof a.scrim !== 'number' || !Number.isFinite(a.scrim) || a.scrim < 0 || a.scrim > 1) {
      errors.push('scrim 必须是 0~1 的数字（背景压暗强度）');
    } else {
      args.scrim = a.scrim;
    }
  }
  if (a.format !== undefined && a.format !== null) {
    if (a.format !== 'jpg' && a.format !== 'png') {
      errors.push("format 必须是 'jpg' 或 'png'");
    } else {
      args.format = a.format;
    }
  }
  if (a.add3dText !== undefined && a.add3dText !== null) {
    const t = a.add3dText as Record<string, unknown>;
    if (typeof t !== 'object' || typeof t.text !== 'string' || !t.text.trim()) {
      errors.push('add3dText 必须是对象且 text 为非空字符串');
    } else {
      const three: ExportCover3dText = {text: t.text.trim().slice(0, 60)};
      let bad = false;
      for (const k of ['x', 'y', 'size', 'depth', 'angle'] as const) {
        const v = t[k];
        if (v !== undefined && v !== null) {
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            errors.push(`add3dText.${k} 必须是数字`);
            bad = true;
          } else {
            (three as unknown as Record<string, unknown>)[k] = v;
          }
        }
      }
      for (const k of ['color', 'sideColor'] as const) {
        const v = t[k];
        if (v !== undefined && v !== null) {
          if (typeof v !== 'string' || !HEX_STR_RE.test(v)) {
            errors.push(`add3dText.${k} 必须是 6 位 hex 颜色（如 #2563EB）`);
            bad = true;
          } else {
            (three as unknown as Record<string, unknown>)[k] = v;
          }
        }
      }
      if (t.behind !== undefined && t.behind !== null) {
        (three as unknown as Record<string, unknown>).behind = t.behind === true;
      }
      if (!bad) args.add3dText = three;
    }
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args};
};

export interface SetPublishMetadataArgs {
  title?: string;
  description?: string;
  tags?: string[];
}

/** set_publish_metadata 参数：全部可选；至少给一个字段；tags 走 sanitizeTags 清洗 */
export const validateSetPublishMetadataArgs = (
  raw: unknown,
): {ok: true; args: SetPublishMetadataArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: SetPublishMetadataArgs = {};
  const errors: string[] = [];
  let given = 0;
  if (a.title !== undefined && a.title !== null) {
    if (typeof a.title !== 'string') {
      errors.push('title 必须是字符串');
    } else {
      args.title = a.title.trim().slice(0, 200);
      given++;
    }
  }
  if (a.description !== undefined && a.description !== null) {
    if (typeof a.description !== 'string') {
      errors.push('description 必须是字符串');
    } else {
      args.description = a.description.trim().slice(0, 2000);
      given++;
    }
  }
  if (a.tags !== undefined && a.tags !== null) {
    if (!Array.isArray(a.tags) && typeof a.tags !== 'string') {
      errors.push('tags 必须是字符串数组（也接受逗号/空格分隔的字符串）');
    } else {
      args.tags = sanitizeTags(a.tags);
      given++;
    }
  }
  if (errors.length > 0) return {ok: false, errors};
  if (given === 0) return {ok: false, errors: ['至少给出 title / description / tags 中的一个字段']};
  return {ok: true, args};
};

// ====== 素材供给 / 音频方向 / 自动流水线 工具参数 ======

export interface SearchStockArgs {
  query: string;
  type?: 'video' | 'photo';
  orientation?: 'landscape' | 'portrait' | 'square';
  perPage?: number;
}

export const validateSearchStockArgs = (
  raw: unknown,
): {ok: true; args: SearchStockArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: SearchStockArgs = {} as SearchStockArgs;
  const errors: string[] = [];
  if (typeof a.query !== 'string' || !a.query.trim()) {
    errors.push('query 必须是非空字符串（搜索词）');
  } else {
    args.query = a.query.trim().slice(0, 100);
  }
  if (a.type !== undefined && a.type !== null) {
    if (a.type !== 'video' && a.type !== 'photo') errors.push('type 只能是 video 或 photo');
    else args.type = a.type;
  }
  if (a.orientation !== undefined && a.orientation !== null) {
    if (!['landscape', 'portrait', 'square'].includes(a.orientation as string)) {
      errors.push('orientation 只能是 landscape / portrait / square');
    } else {
      args.orientation = a.orientation as SearchStockArgs['orientation'];
    }
  }
  if (a.perPage !== undefined && a.perPage !== null) {
    const n = Number(a.perPage);
    if (!Number.isFinite(n) || n < 1 || n > 20) errors.push('perPage 必须是 1-20 的整数');
    else args.perPage = Math.round(n);
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args};
};

export interface ImportStockArgs {
  index: number;
  provider: 'pexels' | 'pixabay';
  id: string;
  type: 'video' | 'photo';
  downloadUrl: string;
}

export const validateImportStockArgs = (
  raw: unknown,
): {ok: true; args: ImportStockArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: ImportStockArgs = {} as ImportStockArgs;
  const errors: string[] = [];
  if (!Number.isInteger(a.index) || (a.index as number) < 0) errors.push('index 必须是 ≥0 的整数');
  else args.index = a.index as number;
  if (a.provider !== 'pexels' && a.provider !== 'pixabay') errors.push('provider 只能是 pexels 或 pixabay');
  else args.provider = a.provider;
  if (typeof a.id !== 'string' || !a.id.trim()) errors.push('id 必须是非空字符串（搜索结果里的素材 id）');
  else args.id = a.id.trim();
  if (a.type !== 'video' && a.type !== 'photo') errors.push('type 只能是 video 或 photo');
  else args.type = a.type;
  if (typeof a.downloadUrl !== 'string' || !/^https:\/\//.test(a.downloadUrl)) {
    errors.push('downloadUrl 必须是搜索结果原样返回的 https 直链');
  } else {
    args.downloadUrl = a.downloadUrl;
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args};
};

export interface GenerateImageArgs {
  prompt: string;
  index?: number;
  size?: string;
}

export const validateGenerateImageArgs = (
  raw: unknown,
): {ok: true; args: GenerateImageArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: GenerateImageArgs = {} as GenerateImageArgs;
  const errors: string[] = [];
  if (typeof a.prompt !== 'string' || !a.prompt.trim()) {
    errors.push('prompt 必须是非空字符串（画面描述）');
  } else {
    args.prompt = a.prompt.trim().slice(0, 1000);
  }
  if (a.index !== undefined && a.index !== null) {
    if (!Number.isInteger(a.index) || (a.index as number) < 0) errors.push('index 必须是 ≥0 的整数');
    else args.index = a.index as number;
  }
  if (a.size !== undefined && a.size !== null) {
    if (typeof a.size !== 'string' || !/^\d{3,4}x\d{3,4}$/.test(a.size)) {
      errors.push('size 格式为 WxH（如 1792x1024，各边 256-4096）');
    } else {
      args.size = a.size;
    }
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args};
};

export interface GenerateModelArgs {
  prompt: string;
  index?: number;
  artStyle?: string;
}

export const validateGenerateModelArgs = (
  raw: unknown,
): {ok: true; args: GenerateModelArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: GenerateModelArgs = {} as GenerateModelArgs;
  const errors: string[] = [];
  if (typeof a.prompt !== 'string' || !a.prompt.trim()) {
    errors.push('prompt 必须是非空字符串（模型外观描述）');
  } else {
    args.prompt = a.prompt.trim().slice(0, 600);
  }
  if (a.index !== undefined && a.index !== null) {
    if (!Number.isInteger(a.index) || (a.index as number) < 0) errors.push('index 必须是 ≥0 的整数');
    else args.index = a.index as number;
  }
  if (a.artStyle !== undefined && a.artStyle !== null) {
    if (typeof a.artStyle !== 'string' || !a.artStyle.trim()) errors.push('artStyle 必须是非空字符串（如 realistic / cartoon）');
    else args.artStyle = a.artStyle.trim().slice(0, 60);
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args};
};

export interface SetBgmArgs {
  track?: string;
  volume?: number;
  wantMood?: 'epic' | 'upbeat' | 'calm' | 'sad' | 'corporate' | 'tense';
  wantEnergy?: 'high' | 'mid' | 'low';
  /** 音量包络关键点（时间轴音量线；传 [] 清除）；单独传时只改现有 BGM 的包络不换曲 */
  volumeKeys?: BgmVolumeKey[];
  /** volumeKeys 校验附注（清洗丢弃项回告模型） */
  volumeKeysNotes?: string[];
}

const MOODS = ['epic', 'upbeat', 'calm', 'sad', 'corporate', 'tense'] as const;
const ENERGIES = ['high', 'mid', 'low'] as const;

export const validateSetBgmArgs = (
  raw: unknown,
): {ok: true; args: SetBgmArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: SetBgmArgs = {};
  const errors: string[] = [];
  if (a.track !== undefined && a.track !== null) {
    if (typeof a.track !== 'string' || !a.track.trim()) errors.push('track 必须是非空字符串（曲名部分匹配）');
    else args.track = a.track.trim().slice(0, 200);
  }
  if (a.volume !== undefined && a.volume !== null) {
    const v = Number(a.volume);
    if (!Number.isFinite(v) || v < 0 || v > 1) errors.push('volume 必须在 0-1 之间');
    else args.volume = v;
  }
  if (a.wantMood !== undefined && a.wantMood !== null) {
    if (!(MOODS as readonly string[]).includes(a.wantMood as string)) {
      errors.push(`wantMood 只能是 ${MOODS.join(' / ')}`);
    } else {
      args.wantMood = a.wantMood as SetBgmArgs['wantMood'];
    }
  }
  if (a.wantEnergy !== undefined && a.wantEnergy !== null) {
    if (!(ENERGIES as readonly string[]).includes(a.wantEnergy as string)) {
      errors.push(`wantEnergy 只能是 ${ENERGIES.join(' / ')}`);
    } else {
      args.wantEnergy = a.wantEnergy as SetBgmArgs['wantEnergy'];
    }
  }
  // 音量包络：数组清洗（sec/volume 钳制、排序、去重、上限截断）；非法项丢弃并记附注
  if (a.volumeKeys !== undefined && a.volumeKeys !== null) {
    const notes: string[] = [];
    const raw = a.volumeKeys;
    if (!Array.isArray(raw)) {
      errors.push('volumeKeys 必须是 [{sec, volume}] 数组（空数组 = 清除包络）');
    } else if (raw.length === 0) {
      args.volumeKeys = [];
    } else {
      const dropped = raw.filter(
        (k) => typeof k !== 'object' || k === null || !Number.isFinite(Number((k as Record<string, unknown>).sec)) || !Number.isFinite(Number((k as Record<string, unknown>).volume)),
      ).length;
      if (dropped === raw.length) errors.push('volumeKeys 没有合法关键点（每点需数值 sec 与 volume）');
      else {
        const cleaned = normalizeBgmVolumeKeys(raw, 3600);
        if (!cleaned) errors.push('volumeKeys 没有合法关键点');
        else {
          if (dropped > 0) notes.push(`volumeKeys 丢弃非法点 ${dropped} 个`);
          if (raw.length > BGM_VOLUME_KEYS_MAX) notes.push(`volumeKeys 超过 ${BGM_VOLUME_KEYS_MAX} 点上限，已截断`);
          args.volumeKeys = cleaned;
          args.volumeKeysNotes = notes;
        }
      }
    }
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args};
};

export interface AnalyzeAudioArgs {
  path?: string;
  checkTranscript?: boolean;
}

export const validateAnalyzeAudioArgs = (
  raw: unknown,
): {ok: true; args: AnalyzeAudioArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: AnalyzeAudioArgs = {};
  const errors: string[] = [];
  if (a.path !== undefined && a.path !== null) {
    if (typeof a.path !== 'string' || !a.path.trim()) errors.push('path 必须是非空字符串（成片路径）');
    else args.path = a.path.trim();
  }
  if (a.checkTranscript !== undefined && a.checkTranscript !== null) {
    if (typeof a.checkTranscript !== 'boolean') errors.push('checkTranscript 必须是布尔值');
    else args.checkTranscript = a.checkTranscript;
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args};
};

export type PipelineMaterials = 'auto' | 'existing-only' | 'stock-first' | 'imagegen-first';

export interface RunPipelineArgs {
  brief: string;
  targetDurationSec?: number;
  aspectRatioId?: string;
  reviewRounds?: number;
  narration?: boolean;
  materials?: PipelineMaterials;
  /** 只出成片计划不执行（一次 LLM 调用，不改工程）；与 segments 互斥 */
  planOnly?: boolean;
  /** 带已确认/修改过的计划直接执行（plan_only 的产物或其人工修改版）；给出时跳过脚本生成 */
  segments?: Array<Record<string, unknown>>;
}

export const validateRunPipelineArgs = (
  raw: unknown,
): {ok: true; args: RunPipelineArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const args: RunPipelineArgs = {} as RunPipelineArgs;
  const errors: string[] = [];
  if (typeof a.brief !== 'string' || !a.brief.trim()) {
    errors.push('brief 必须是非空字符串（一句话需求描述）');
  } else {
    args.brief = a.brief.trim().slice(0, 500);
  }
  if (a.targetDurationSec !== undefined && a.targetDurationSec !== null) {
    const n = Number(a.targetDurationSec);
    if (!Number.isFinite(n) || n < 8 || n > 90) errors.push('targetDurationSec 必须在 8-90 秒之间');
    else args.targetDurationSec = n;
  }
  if (a.aspectRatioId !== undefined && a.aspectRatioId !== null) {
    if (typeof a.aspectRatioId !== 'string' || !a.aspectRatioId.trim()) errors.push('aspectRatioId 必须是非空字符串');
    else args.aspectRatioId = a.aspectRatioId.trim();
  }
  if (a.reviewRounds !== undefined && a.reviewRounds !== null) {
    const n = Number(a.reviewRounds);
    if (!Number.isInteger(n) || n < 0 || n > 2) errors.push('reviewRounds 必须是 0-2 的整数');
    else args.reviewRounds = n;
  }
  if (a.narration !== undefined && a.narration !== null) {
    if (typeof a.narration !== 'boolean') errors.push('narration 必须是布尔值');
    else args.narration = a.narration;
  }
  if (a.materials !== undefined && a.materials !== null) {
    if (!['auto', 'existing-only', 'stock-first', 'imagegen-first'].includes(a.materials as string)) {
      errors.push('materials 只能是 auto / existing-only / stock-first / imagegen-first');
    } else {
      args.materials = a.materials as PipelineMaterials;
    }
  }
  if (a.planOnly !== undefined && a.planOnly !== null) {
    if (typeof a.planOnly !== 'boolean') errors.push('planOnly 必须是布尔值');
    else args.planOnly = a.planOnly;
  }
  if (a.segments !== undefined && a.segments !== null) {
    if (!Array.isArray(a.segments) || a.segments.length === 0 || a.segments.length > 60) {
      errors.push('segments 必须是 1-60 个片段的数组（plan_only 返回的计划或其修改版）');
    } else if (!a.segments.every((s) => s && typeof s === 'object' && !Array.isArray(s) && typeof (s as Record<string, unknown>).templateId === 'string')) {
      errors.push('segments 每项必须是含 templateId 字符串的对象（详细校验在应用故事板时进行）');
    } else if (a.planOnly === true) {
      errors.push('planOnly 与 segments 互斥：出计划不执行，执行不带 planOnly');
    } else {
      args.segments = a.segments as Array<Record<string, unknown>>;
    }
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args};
};

// ====== 体裁切换 / 高光挖矿 工具参数 ======

export interface SetVideoTypeArgs {
  videoType: VideoType;
}

/** set_video_type 参数：videoType 必须是合法体裁枚举 */
export const validateSetVideoTypeArgs = (
  raw: unknown,
): {ok: true; args: SetVideoTypeArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.videoType !== 'string' || !(VIDEO_TYPES as string[]).includes(a.videoType)) {
    return {ok: false, errors: [`videoType 必须是 ${VIDEO_TYPES.join(' / ')} 之一（体裁）`]};
  }
  return {ok: true, args: {videoType: a.videoType as VideoType}};
};

export interface MineHighlightsArgs {
  index: number;
  /** 段内视频下标；缺省由执行器取时长最长的视频素材 */
  videoIndex?: number;
  /** 期望浓缩后总时长（10-180，缺省 60） */
  targetDurationSec: number;
  /** 最多保留几段（2-60，缺省 8） */
  maxSegments: number;
  /** 挑选侧重（≤100 字） */
  focus?: string;
}

/** mine_highlights 参数：index 必填；videoIndex/targetDurationSec/maxSegments/focus 可选并按范围钳制 */
export const validateMineHighlightsArgs = (
  raw: unknown,
): {ok: true; args: MineHighlightsArgs} | {ok: false, errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof a.index !== 'number' || !Number.isInteger(a.index) || a.index < 0) {
    errors.push('index 必须是非负整数（段下标，0 起）');
  }
  const args = {index: a.index as number, targetDurationSec: 60, maxSegments: 8} as MineHighlightsArgs;
  if (a.videoIndex !== undefined && a.videoIndex !== null) {
    if (typeof a.videoIndex !== 'number' || !Number.isInteger(a.videoIndex) || a.videoIndex < 0) {
      errors.push('videoIndex 必须是非负整数');
    } else {
      args.videoIndex = a.videoIndex;
    }
  }
  if (a.targetDurationSec !== undefined && a.targetDurationSec !== null) {
    const n = Number(a.targetDurationSec);
    if (!Number.isFinite(n) || n < 10 || n > 180) errors.push('targetDurationSec 必须在 10-180 秒之间');
    else args.targetDurationSec = n;
  }
  if (a.maxSegments !== undefined && a.maxSegments !== null) {
    const n = Number(a.maxSegments);
    if (!Number.isInteger(n) || n < 2 || n > 60) errors.push('maxSegments 必须是 2-60 的整数');
    else args.maxSegments = n;
  }
  if (a.focus !== undefined && a.focus !== null) {
    if (typeof a.focus !== 'string' || !a.focus.trim()) errors.push('focus 必须是非空字符串（挑选侧重）');
    else if (a.focus.length > 100) errors.push('focus 过长（≤100 字）');
    else args.focus = a.focus.trim();
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args};
};

export interface ApplyCutListArgs {
  index: number;
  /** 段内视频下标；缺省由执行器取时长最长的视频素材 */
  videoIndex?: number;
  /** 保留区间（媒体绝对秒；归一合并由 shared/highlight-mining 的纯函数做） */
  keepRanges: {start: number; end: number}[];
}

/** apply_cut_list 参数：index/keepRanges 必填；keepRanges 1-24 项、每项 0 ≤ start < end */
export const validateApplyCutListArgs = (
  raw: unknown,
): {ok: true; args: ApplyCutListArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof a.index !== 'number' || !Number.isInteger(a.index) || a.index < 0) {
    errors.push('index 必须是非负整数（段下标，0 起）');
  }
  if (!Array.isArray(a.keepRanges) || a.keepRanges.length < 1 || a.keepRanges.length > 24) {
    errors.push('keepRanges 必须是 1-24 个 {start, end} 区间的数组（媒体绝对秒）');
  }
  const ranges: {start: number; end: number}[] = [];
  if (Array.isArray(a.keepRanges)) {
    for (let i = 0; i < Math.min(a.keepRanges.length, 24); i++) {
      const r = (a.keepRanges[i] || {}) as Record<string, unknown>;
      if (typeof r.start !== 'number' || typeof r.end !== 'number' || !Number.isFinite(r.start) || !Number.isFinite(r.end)) {
        errors.push(`keepRanges 第 ${i + 1} 项的 start/end 必须是数字（媒体绝对秒）`);
        break;
      }
      if (r.start < 0 || r.end <= r.start) {
        errors.push(`keepRanges 第 ${i + 1} 项需满足 0 ≤ start < end`);
        break;
      }
      ranges.push({start: r.start, end: r.end});
    }
  }
  const args = {index: a.index as number, keepRanges: ranges} as ApplyCutListArgs;
  if (a.videoIndex !== undefined && a.videoIndex !== null) {
    if (typeof a.videoIndex !== 'number' || !Number.isInteger(a.videoIndex) || a.videoIndex < 0) {
      errors.push('videoIndex 必须是非负整数');
    } else {
      args.videoIndex = a.videoIndex;
    }
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args};
};

// ====== set_project_style（项目级样式四合一）参数 ======

export interface SetProjectStyleArgs {
  captionStyle?: Partial<CaptionStyle>;
  texture?: TexturePreset;
  beatPulse?: boolean;
  sfx?: Partial<SfxConfig>;
  /** 工程看图预算（view_media_frames 附图总量上限；0 = 不限，缺省 12） */
  frameBudget?: number;
}

const PROJECT_STYLE_TOP_KEYS: ReadonlySet<string> = new Set(['captionStyle', 'texture', 'beatPulse', 'sfx', 'frameBudget']);
const CAPTION_STYLE_KEYS: ReadonlySet<string> = new Set(['position', 'fontSizeScale', 'color', 'bgOpacity', 'anim']);
const CAPTION_POSITION_VALUES: ReadonlySet<string> = new Set(['bottom', 'top', 'center']);
const CAPTION_ANIM_VALUES: ReadonlySet<string> = new Set(['line', 'wordPop']);
const TEXTURE_PRESET_VALUES: ReadonlySet<string> = new Set(['clean', 'film', 'cinema']);
const SFX_BOOL_KEYS = ['enabled', 'transitionWhoosh', 'beatImpact', 'introRiser'] as const;
const SFX_KEYS: ReadonlySet<string> = new Set([...SFX_BOOL_KEYS, 'volume']);

/** set_project_style 参数：四项全可选但至少一项；拒绝未知字段/非法枚举/越界数值 */
export const validateSetProjectStyleArgs = (
  raw: unknown,
): {ok: true; args: SetProjectStyleArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const unknownTop = Object.keys(a).filter((k) => !PROJECT_STYLE_TOP_KEYS.has(k));
  if (unknownTop.length > 0) {
    return {ok: false, errors: [`未知字段：${unknownTop.join('、')}（仅支持 captionStyle/texture/beatPulse/sfx；品牌色/字体走 set_brand_style，色调走 set_color_grade，Logo 走 set_logo，边缘小字走 set_fine_print）`]};
  }
  const args: SetProjectStyleArgs = {};

  if (a.captionStyle !== undefined && a.captionStyle !== null) {
    if (typeof a.captionStyle !== 'object' || Array.isArray(a.captionStyle)) {
      return {ok: false, errors: ['captionStyle 必须是对象']};
    }
    const cs = a.captionStyle as Record<string, unknown>;
    const bad = Object.keys(cs).filter((k) => !CAPTION_STYLE_KEYS.has(k));
    if (bad.length > 0) {
      return {ok: false, errors: [`captionStyle 未知字段：${bad.join('、')}（仅支持 position/fontSizeScale/color/bgOpacity/anim）`]};
    }
    const out: Partial<CaptionStyle> = {};
    if (cs.position !== undefined) {
      if (typeof cs.position !== 'string' || !CAPTION_POSITION_VALUES.has(cs.position)) {
        return {ok: false, errors: ['captionStyle.position 必须是 bottom/top/center 之一']};
      }
      out.position = cs.position as CaptionPosition;
    }
    if (cs.fontSizeScale !== undefined) {
      if (typeof cs.fontSizeScale !== 'number' || !Number.isFinite(cs.fontSizeScale) || cs.fontSizeScale < 0.5 || cs.fontSizeScale > 2.5) {
        return {ok: false, errors: ['captionStyle.fontSizeScale 必须是 0.5~2.5 的数字']};
      }
      out.fontSizeScale = cs.fontSizeScale;
    }
    if (cs.color !== undefined) {
      const norm = typeof cs.color === 'string' ? normalizeBrandColor(cs.color) : null;
      if (!norm) {
        return {ok: false, errors: ['captionStyle.color 必须是合法色值（#RRGGBB，如 #FFFFFF）']};
      }
      out.color = norm.toUpperCase();
    }
    if (cs.bgOpacity !== undefined) {
      if (typeof cs.bgOpacity !== 'number' || !Number.isFinite(cs.bgOpacity) || cs.bgOpacity < 0 || cs.bgOpacity > 1) {
        return {ok: false, errors: ['captionStyle.bgOpacity 必须是 0~1 的数字']};
      }
      out.bgOpacity = cs.bgOpacity;
    }
    if (cs.anim !== undefined) {
      if (typeof cs.anim !== 'string' || !CAPTION_ANIM_VALUES.has(cs.anim)) {
        return {ok: false, errors: ['captionStyle.anim 必须是 line/wordPop 之一']};
      }
      out.anim = cs.anim as CaptionAnim;
    }
    if (Object.keys(out).length === 0) {
      return {ok: false, errors: ['captionStyle 至少要给一个有效字段（position/fontSizeScale/color/bgOpacity/anim）']};
    }
    args.captionStyle = out;
  }

  if (a.texture !== undefined && a.texture !== null) {
    if (typeof a.texture !== 'string' || !TEXTURE_PRESET_VALUES.has(a.texture)) {
      return {ok: false, errors: [`texture 必须是以下之一：${[...TEXTURE_PRESET_VALUES].join(' / ')}`]};
    }
    args.texture = a.texture as TexturePreset;
  }

  if (a.beatPulse !== undefined && a.beatPulse !== null) {
    if (typeof a.beatPulse !== 'boolean') {
      return {ok: false, errors: ['beatPulse 必须是布尔值']};
    }
    args.beatPulse = a.beatPulse;
  }

  if (a.sfx !== undefined && a.sfx !== null) {
    if (typeof a.sfx !== 'object' || Array.isArray(a.sfx)) {
      return {ok: false, errors: ['sfx 必须是对象']};
    }
    const s = a.sfx as Record<string, unknown>;
    const bad = Object.keys(s).filter((k) => !SFX_KEYS.has(k));
    if (bad.length > 0) {
      return {ok: false, errors: [`sfx 未知字段：${bad.join('、')}（仅支持 enabled/volume/transitionWhoosh/beatImpact/introRiser）`]};
    }
    const out: Partial<SfxConfig> = {};
    for (const k of SFX_BOOL_KEYS) {
      if (s[k] !== undefined) {
        if (typeof s[k] !== 'boolean') {
          return {ok: false, errors: [`sfx.${k} 必须是布尔值`]};
        }
        out[k] = s[k] as boolean;
      }
    }
    if (s.volume !== undefined) {
      if (typeof s.volume !== 'number' || !Number.isFinite(s.volume) || s.volume < 0 || s.volume > 1) {
        return {ok: false, errors: ['sfx.volume 必须是 0~1 的数字']};
      }
      out.volume = s.volume;
    }
    if (Object.keys(out).length === 0) {
      return {ok: false, errors: ['sfx 至少要给一个有效字段（enabled/volume/transitionWhoosh/beatImpact/introRiser）']};
    }
    args.sfx = out;
  }

  if (a.frameBudget !== undefined && a.frameBudget !== null) {
    if (typeof a.frameBudget !== 'number' || !Number.isInteger(a.frameBudget) || a.frameBudget < 0 || a.frameBudget > 200) {
      return {ok: false, errors: ['frameBudget 必须是 0-200 的整数（工程看图预算，0 = 不限）']};
    }
    args.frameBudget = a.frameBudget;
  }

  if (!args.captionStyle && args.texture === undefined && args.beatPulse === undefined && !args.sfx && args.frameBudget === undefined) {
    return {ok: false, errors: ['至少提供 captionStyle/texture/beatPulse/sfx/frameBudget 之一']};
  }
  return {ok: true, args};
};

// ====== auto_screen_demo（录屏即成品）参数 ======

export interface ScreenDemoArgs {
  path?: string;
  title?: string;
  subtitle?: string;
  ctaTitle?: string;
  cta?: string[];
  withBgm?: boolean;
  wantMood?: MusicMood;
  wantEnergy?: MusicEnergy;
}

/** auto_screen_demo 参数：全部可选，只做类型收敛（path 合法性由 runner 探测时兜底） */
export const validateScreenDemoArgs = (
  raw: unknown,
): {ok: true; args: ScreenDemoArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const errors: string[] = [];
  const args: ScreenDemoArgs = {};
  if (a.path !== undefined && a.path !== null) {
    if (typeof a.path !== 'string' || !a.path.trim()) {
      errors.push('path 必须是非空字符串（录屏文件绝对路径）');
    } else {
      args.path = a.path.trim();
    }
  }
  for (const key of ['title', 'subtitle', 'ctaTitle'] as const) {
    if (a[key] !== undefined && a[key] !== null) {
      if (typeof a[key] !== 'string') {
        errors.push(`${key} 必须是字符串`);
      } else {
        args[key] = a[key];
      }
    }
  }
  if (a.cta !== undefined && a.cta !== null) {
    if (!Array.isArray(a.cta) || a.cta.some((x) => typeof x !== 'string')) {
      errors.push('cta 必须是字符串数组（每行一条行动要点）');
    } else {
      args.cta = a.cta as string[];
    }
  }
  if (a.withBgm !== undefined && a.withBgm !== null) {
    if (typeof a.withBgm !== 'boolean') {
      errors.push('withBgm 必须是布尔值');
    } else {
      args.withBgm = a.withBgm;
    }
  }
  if (a.wantMood !== undefined && a.wantMood !== null) {
    const moods: MusicMood[] = ['epic', 'upbeat', 'calm', 'sad', 'corporate', 'tense'];
    if (typeof a.wantMood !== 'string' || !moods.includes(a.wantMood as MusicMood)) {
      errors.push(`wantMood 必须是 ${moods.join('/')} 之一`);
    } else {
      args.wantMood = a.wantMood as MusicMood;
    }
  }
  if (a.wantEnergy !== undefined && a.wantEnergy !== null) {
    const energies: MusicEnergy[] = ['high', 'mid', 'low'];
    if (typeof a.wantEnergy !== 'string' || !energies.includes(a.wantEnergy as MusicEnergy)) {
      errors.push(`wantEnergy 必须是 ${energies.join('/')} 之一`);
    } else {
      args.wantEnergy = a.wantEnergy as MusicEnergy;
    }
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args};
};

// ====== auto_tutorial（教程一键编排）参数 ======

export interface TutorialArgs {
  path?: string;
  title?: string;
  subtitle?: string;
  stepTitles?: string[];
  outroTitle?: string;
  withBgm?: boolean;
  wantMood?: MusicMood;
  wantEnergy?: MusicEnergy;
}

/** auto_tutorial 参数：全部可选，只做类型收敛（素材合法性由 runner 探测时兜底） */
export const validateTutorialArgs = (
  raw: unknown,
): {ok: true; args: TutorialArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  const errors: string[] = [];
  const args: TutorialArgs = {};
  if (a.path !== undefined && a.path !== null) {
    if (typeof a.path !== 'string' || !a.path.trim()) {
      errors.push('path 必须是非空字符串（录屏文件绝对路径）');
    } else {
      args.path = a.path.trim();
    }
  }
  for (const key of ['title', 'subtitle', 'outroTitle'] as const) {
    if (a[key] !== undefined && a[key] !== null) {
      if (typeof a[key] !== 'string') {
        errors.push(`${key} 必须是字符串`);
      } else {
        args[key] = a[key];
      }
    }
  }
  if (a.stepTitles !== undefined && a.stepTitles !== null) {
    if (!Array.isArray(a.stepTitles) || a.stepTitles.some((x) => typeof x !== 'string')) {
      errors.push('stepTitles 必须是字符串数组（每步一个标题）');
    } else {
      args.stepTitles = a.stepTitles as string[];
    }
  }
  if (a.withBgm !== undefined && a.withBgm !== null) {
    if (typeof a.withBgm !== 'boolean') {
      errors.push('withBgm 必须是布尔值');
    } else {
      args.withBgm = a.withBgm;
    }
  }
  if (a.wantMood !== undefined && a.wantMood !== null) {
    const moods: MusicMood[] = ['epic', 'upbeat', 'calm', 'sad', 'corporate', 'tense'];
    if (typeof a.wantMood !== 'string' || !moods.includes(a.wantMood as MusicMood)) {
      errors.push(`wantMood 必须是 ${moods.join('/')} 之一`);
    } else {
      args.wantMood = a.wantMood as MusicMood;
    }
  }
  if (a.wantEnergy !== undefined && a.wantEnergy !== null) {
    const energies: MusicEnergy[] = ['high', 'mid', 'low'];
    if (typeof a.wantEnergy !== 'string' || !energies.includes(a.wantEnergy as MusicEnergy)) {
      errors.push(`wantEnergy 必须是 ${energies.join('/')} 之一`);
    } else {
      args.wantEnergy = a.wantEnergy as MusicEnergy;
    }
  }
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, args};
};

// ====== consolidate_project（收集工程素材）参数 ======

export interface ConsolidateProjectArgs {
  dir: string;
}

/** consolidate_project 参数：dir 必须是非空字符串（是否绝对路径由主进程 handler 再校验） */
export const validateConsolidateProjectArgs = (
  raw: unknown,
): {ok: true; args: ConsolidateProjectArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.dir !== 'string' || !a.dir.trim()) {
    return {ok: false, errors: ['需要目标目录的绝对路径（dir 参数）']};
  }
  return {ok: true, args: {dir: a.dir.trim()}};
};
