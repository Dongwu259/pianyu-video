/**
 * 模板注册表 - 集中管理所有可用模板的元数据
 *
 * 新增模板步骤：
 * 1. 在 src/remotion/templates/ 创建模板组件
 * 2. 在本文件中导入并注册（如需个性化参数，先定义 XXX_PARAMS 规格并挂到 paramSpecs，
 *    模板组件内用 remotion/utils/params.ts 的 makeParamReader 读取，默认值以模板现状为准）
 * 3. 添加缩略图到 src/renderer/assets/thumbnails/
 */

import type {TemplateMeta, TemplateParamSpec} from './types';
import type {CustomTemplateDef} from './custom-template';
import type {GeneratedTemplateDef} from './generated-template';
import {generatedTemplateToMeta, isGeneratedTemplateId, findGeneratedDef} from './generated-template';
import type {VideoType} from './video-type';
import {isMarketTemplateId} from './template-pack.ts';
import type {TemplatePack} from './template-pack.ts';
import {NATIVE_SCENE, THREE_SCENES, sceneParamLabel} from './three-scenes';
import {augmentTemplateParamOptions} from './param-options';

/**
 * sceneStyle 场景档位参数（v28 运动模板/场景解耦）：3D 场景族七款模板共用，
 * 档位标签/默认值单一数据源在 three-scenes.ts（档位 → 场景包，渲染端 scene-packs.tsx）。
 * default = 模板原生场景（老工程不带此参数时观感与拆分前一致）。
 */
const sceneStyleSpec = (templateId: string): TemplateParamSpec =>
  ({key: 'sceneStyle', label: sceneParamLabel(), min: 0, max: THREE_SCENES.length - 1, step: 1, default: NATIVE_SCENE[templateId] ?? 0, unit: ''});

/**
 * 各模板的个性化参数规格（故事板「参数」页渲染滑块；模板组件按倍率语义消费）。
 * 语义约定：
 * - 除标明单位（°/s/px）的参数外，全部为「倍率」：1 = 模板内置默认值；
 * - 模板内用 remotion/utils/params.ts 的 makeParamReader(specs, props.params) 读取，
 *   读取不到时回退本规格中的 default（单一数据源，避免两处默认值漂移）。
 */
/** 飞入方向档位（0=自动=模板默认 1=上 2=下 3=左 4=右）——飞入/滑入类模板共用，追加在各模板参数规格末尾；渲染端用 remotion/utils/params.ts 的 directionVector 解读 */
export const DIRECTION_PARAM_SPEC: TemplateParamSpec = {key: 'direction', label: '飞入方向(0自动/1上/2下/3左/4右)', min: 0, max: 4, step: 1, default: 0, unit: ''};

/** 缓动曲线档位（0=默认=模板现状 1=干脆 2=柔和 3=弹性）——线性运动模板共用。
 *  DogSC 命名档位路线：不给自由贝塞尔（customParams 档位符合模型线「连续美学参数 ≤5 档」纪律）；
 *  渲染端用 shared/easings 的 easeTierCurve 解读，同曲线对称管开头结尾 */
export const MOTION_EASE_PARAM_SPEC: TemplateParamSpec = {key: 'motionEase', label: '缓动曲线(0默认/1干脆/2柔和/3弹性)', min: 0, max: 3, step: 1, default: 0, unit: ''};

export const REVEAL_SLIDE_PARAMS: TemplateParamSpec[] = [
  {key: 'pipScale', label: '视频画框大小', min: 0.5, max: 1.6, step: 0.05, default: 1},
  {key: 'tiltX', label: '倾斜角度', min: -20, max: 20, step: 0.5, default: 5, unit: '°'},
  {key: 'swingAngle', label: '摆入角度', min: 0, max: 30, step: 1, default: 8, unit: '°'},
  {key: 'slideDistance', label: '平推距离', min: 0, max: 2, step: 0.05, default: 1},
  {key: 'titleScale', label: '标题大小', min: 0.6, max: 1.8, step: 0.05, default: 1},
  DIRECTION_PARAM_SPEC,
];

export const STACK_CARDS_PARAMS: TemplateParamSpec[] = [
  {key: 'cardScale', label: '卡片大小', min: 0.6, max: 1.5, step: 0.05, default: 1},
  {key: 'cardGap', label: '堆叠间距', min: 0.4, max: 2, step: 0.05, default: 1},
  {key: 'flipSpeed', label: '翻转速度', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'titleScale', label: '标题大小', min: 0.6, max: 1.8, step: 0.05, default: 1},
  DIRECTION_PARAM_SPEC,
];

export const CINEMATIC_PAN_PARAMS: TemplateParamSpec[] = [
  {key: 'videoScale', label: '视频画框大小', min: 0.6, max: 1.5, step: 0.05, default: 1},
  {key: 'floatAmp', label: '漂浮幅度', min: 0, max: 2, step: 0.05, default: 1},
  {key: 'orbitSpeed', label: '运镜速度', min: 0.3, max: 2, step: 0.05, default: 1},
];

export const SPLIT_SHOWCASE_PARAMS: TemplateParamSpec[] = [
  {key: 'videoRatio', label: '视频区占比', min: 0.3, max: 0.7, step: 0.05, default: 0.55, unit: ''},
  {key: 'textScale', label: '文字大小', min: 0.7, max: 1.5, step: 0.05, default: 1},
  {key: 'featureDelay', label: '要点节奏', min: 0.5, max: 2, step: 0.05, default: 1},
];

export const MINIMAL_FLOAT_PARAMS: TemplateParamSpec[] = [
  {key: 'videoScale', label: '视频画框大小', min: 0.6, max: 1.5, step: 0.05, default: 1},
  {key: 'floatAmp', label: '悬浮幅度', min: 0, max: 2, step: 0.05, default: 1},
  {key: 'tiltZ', label: '倾斜角度', min: -15, max: 15, step: 0.5, default: 0, unit: '°'},
  DIRECTION_PARAM_SPEC,
];

export const KEN_BURNS_PARAMS: TemplateParamSpec[] = [
  {key: 'zoomAmount', label: '缩放幅度', min: 1.05, max: 1.6, step: 0.01, default: 1.12, unit: ''},
  {key: 'panAmount', label: '平移幅度', min: 0, max: 2, step: 0.05, default: 1},
  MOTION_EASE_PARAM_SPEC,
];

export const GRID_MOSAIC_PARAMS: TemplateParamSpec[] = [
  {key: 'gap', label: '网格间距', min: 0, max: 40, step: 2, default: 12, unit: 'px'},
  {key: 'radius', label: '卡片圆角', min: 0, max: 32, step: 1, default: 10, unit: 'px'},
  {key: 'stagger', label: '入场节奏', min: 0.5, max: 2, step: 0.05, default: 1},
];

export const VERTICAL_SCROLL_PARAMS: TemplateParamSpec[] = [
  {key: 'cardScale', label: '卡片大小', min: 0.7, max: 1.3, step: 0.05, default: 1},
  {key: 'scrollSpeed', label: '滚动速度', min: 0.5, max: 2, step: 0.05, default: 1},
  DIRECTION_PARAM_SPEC,
  MOTION_EASE_PARAM_SPEC,
];

export const SPLIT_COMPARE_PARAMS: TemplateParamSpec[] = [
  {key: 'dividerPos', label: '分屏线位置', min: 0.25, max: 0.75, step: 0.05, default: 0.5, unit: ''},
  {key: 'sweepSpeed', label: '滑动速度', min: 0.5, max: 2, step: 0.05, default: 1},
  MOTION_EASE_PARAM_SPEC,
];

export const NEON_TECH_PARAMS: TemplateParamSpec[] = [
  {key: 'frameScale', label: '画框大小', min: 0.6, max: 1.4, step: 0.05, default: 1},
  {key: 'glow', label: '辉光强度', min: 0, max: 2, step: 0.1, default: 1},
  {key: 'gridOpacity', label: '网格强度', min: 0, max: 1, step: 0.05, default: 1, unit: ''},
  {key: 'tempo', label: '节奏倍率', min: 0.5, max: 2, step: 0.05, default: 1},
  MOTION_EASE_PARAM_SPEC,
];

export const TEXT_SLIDE_PARAMS: TemplateParamSpec[] = [
  {key: 'titleScale', label: '标题大小', min: 0.6, max: 1.8, step: 0.05, default: 1},
  {key: 'lineGap', label: '行间距', min: 0.6, max: 2, step: 0.05, default: 1},
  {key: 'bulletDelay', label: '要点节奏', min: 0.5, max: 2, step: 0.05, default: 1},
  MOTION_EASE_PARAM_SPEC,
];

export const BRAND_INTRO_PARAMS: TemplateParamSpec[] = [
  {key: 'logoScale', label: '标志/素材大小', min: 0.5, max: 4, step: 0.1, default: 2},
  {key: 'brandScale', label: '品牌名字号', min: 0.6, max: 1.8, step: 0.05, default: 1},
  {key: 'glow', label: '光晕强度', min: 0, max: 2, step: 0.1, default: 1},
  {key: 'sweep', label: '光扫强度', min: 0, max: 1, step: 0.05, default: 1, unit: ''},
  MOTION_EASE_PARAM_SPEC,
];

export const OUTRO_CTA_PARAMS: TemplateParamSpec[] = [
  {key: 'qrScale', label: '素材/二维码大小', min: 0.5, max: 3, step: 0.1, default: 1},
  {key: 'textScale', label: '文字大小', min: 0.6, max: 1.6, step: 0.05, default: 1},
  {key: 'particleDensity', label: '粒子密度', min: 0, max: 2, step: 0.1, default: 1},
];

export const CURSOR_FOLLOW_PARAMS: TemplateParamSpec[] = [
  {key: 'zoom', label: '跟随放大', min: 1, max: 2.5, step: 0.05, default: 1.4},
  {key: 'smooth', label: '跟随平滑', min: 0.1, max: 2, step: 0.1, default: 0.8, unit: 's'},
  {key: 'clickZoomOn', label: '点击自动放大', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'clickZoom', label: '点击放大倍率', min: 1, max: 3, step: 0.05, default: 1.6},
  {key: 'clickHold', label: '点击停留', min: 0.3, max: 3, step: 0.1, default: 1.0, unit: 's'},
  {key: 'springTone', label: '弹簧手感(0标准/1轻快/2厚重)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'clickRipple', label: '点击效果(0关/1涟漪/2光晕/3双环/4微闪)', min: 0, max: 4, step: 1, default: 1, unit: ''},
  {key: 'focusAnchorX', label: '放大锚点X(0=点击处)', min: 0, max: 1, step: 0.01, default: 0},
  {key: 'focusAnchorY', label: '放大锚点Y(0=点击处)', min: 0, max: 1, step: 0.01, default: 0},
  {key: 'cursorLean', label: '光标拖尾倾斜(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 0, unit: ''},
  {key: 'focusDimOn', label: '聚焦蒙版(0关/1开)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'focusDimBlur', label: '聚焦虚化', min: 0, max: 16, step: 0.5, default: 6, unit: 'px'},
  {key: 'focusDimSize', label: '清晰区大小', min: 0.15, max: 0.5, step: 0.05, default: 0.38},
  {key: 'focusDimDark', label: '四周压暗', min: 0, max: 0.6, step: 0.05, default: 0.18},
  {key: 'focusDimTarget', label: '蒙版锚点(0点击/1指针)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'focusDimShape', label: '清晰区形状(0椭圆/1条带)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'focusDimAngle', label: '条带角度', min: -90, max: 90, step: 5, default: 0, unit: '°'},
  {key: 'focusRecenter', label: '收框(0关/1开,满格漂向安全区)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'focusLead', label: '垂直引导(0关/1弱/2强,注视点偏侧预留前进空间)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'focusPop', label: '聚焦浮出(0关/1开,清晰区上浮为卡层替代挖洞)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'hoverCard', label: '悬停浮卡(0关/1开)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'hoverCardZoom', label: '浮卡放大', min: 1.4, max: 3, step: 0.1, default: 2.2},
  {key: 'tiltX', label: '3D 倾斜角', min: -35, max: 35, step: 1, default: 0, unit: '°'},
  {key: 'tiltY', label: '3D 侧倾角', min: -32, max: 32, step: 1, default: 0, unit: '°'},
  {key: 'tiltPersp', label: '透视强度', min: 600, max: 2400, step: 50, default: 1200, unit: 'px'},
  {key: 'tiltZ', label: '旋转角', min: -20, max: 20, step: 1, default: 0, unit: '°'},
  {key: 'tiltAuto', label: '倾斜自动定向(0关/1开)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'tiltIntro', label: '倾斜入场(0关/1开)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'tiltIntroSec', label: '入场时长', min: 0.3, max: 1.5, step: 0.1, default: 0.8, unit: 's'},
  {key: 'cursorScale', label: '光标大小', min: 0.5, max: 2.5, step: 0.1, default: 1},
  {key: 'showCursor', label: '显示光标', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'clickHighlight', label: '点击高亮描边(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'smoothCursor', label: '光标轨迹后处理(0关/1开)', min: 0, max: 1, step: 1, default: 0, unit: ''}, // v8.1 实证：重定时拆两套时间基准，真实实录必关
  {key: 'stageBg', label: '舞台底色(0关/1纯色/2渐变)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'stagePalette', label: '舞台色板(8奶油/9浅灰为浅色档,描边自适应)', min: 0, max: 9, step: 1, default: 0, unit: ''},
  {key: 'stageCard', label: '窗口卡(0满幅/1圆角卡/2辉光卡)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'cardFill', label: '窗口卡宽度占比', min: 0.6, max: 1, step: 0.01, default: 0.9},
  {key: 'viewSpan', label: '可视跨度(0=用跟随放大)', min: 0, max: 0.9, step: 0.05, default: 0},
  {key: 'stageAmbient', label: '舞台环境虚化(0关/1开)', min: 0, max: 1, step: 1, default: 0, unit: ''},
];

export const SCREEN_DEMO_PARAMS: TemplateParamSpec[] = [
  {key: 'zoomMed', label: '中景推近', min: 1.3, max: 2.2, step: 0.05, default: 1.7},
  {key: 'zoomClose', label: '小景特写', min: 1.8, max: 3.4, step: 0.05, default: 2.6},
  {key: 'tiltAmp', label: '倾斜循环(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'drift', label: '镜内缓推(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'vignette', label: '点击渐晕(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'floatCard', label: '点击浮卡(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'cardSize', label: '浮卡大小', min: 0.6, max: 1.6, step: 0.05, default: 1},
  {key: 'showCursor', label: '显示光标', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'cursorLean', label: '光标拖尾倾斜(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 0, unit: ''},
  {key: 'cursorScale', label: '光标大小', min: 0.5, max: 2.5, step: 0.1, default: 1},
  {key: 'clickHighlight', label: '点击高亮描边(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'smoothCursor', label: '光标节奏重定时(1开=演示节奏,会与画面动作脱节)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'stageBg', label: '舞台底色(0关/1纯色/2渐变)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'stagePalette', label: '舞台色板(0深空蓝/1紫罗兰/2暖琥珀/3青碧/4玫粉/5墨绿/6石墨/7酒红/8自动取色/9浅灰)', min: 0, max: 9, step: 1, default: 0, unit: ''},
  {key: 'stagePad', label: '舞台卡宽度', min: 0.6, max: 0.95, step: 0.01, default: 0.84},
  {key: 'stageCard', label: '窗口卡(0满幅/1圆角卡/2辉光卡)', min: 0, max: 2, step: 1, default: 0, unit: ''},
];

export const TUTORIAL_STEP_PARAMS: TemplateParamSpec[] = [
  {key: 'stepIndex', label: '步骤号(标题「第N步」优先)', min: 0, max: 99, step: 1, default: 1, unit: ''},
  {key: 'stepTotal', label: '总步数(0不显示进度点)', min: 0, max: 12, step: 1, default: 0, unit: ''},
];

export const MONTAGE_PARAMS: TemplateParamSpec[] = [
  {key: 'cutSec', label: '切换节奏', min: 0.8, max: 4, step: 0.1, default: 1.8, unit: 's'},
  {key: 'punch', label: '变焦冲击', min: 0, max: 2, step: 0.05, default: 1},
  {key: 'whipEvery', label: '甩切间隔(0关)', min: 0, max: 8, step: 1, default: 4, unit: ' 切'},
  {key: 'motion', label: '镜内运动(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'flashOn', label: '切点闪白(0关/1开)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'showCaption', label: '显示标题(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
];

export const PRODUCT_FLOAT_PARAMS: TemplateParamSpec[] = [
  {key: 'bgMode', label: '底色(0白境/1黑底轮廓光/2渐变)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'stagePalette', label: '色板(渐变/辉光用)', min: 0, max: 7, step: 1, default: 0, unit: ''},
  {key: 'cardScale', label: '主体大小', min: 0.5, max: 1.2, step: 0.05, default: 0.86},
  {key: 'floatAmp', label: '缓浮幅度', min: 0, max: 2, step: 0.05, default: 1},
  {key: 'floatSpeed', label: '缓浮速度', min: 0.3, max: 2, step: 0.05, default: 1},
  {key: 'glowRing', label: '轮廓辉光(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'kenBurns', label: '镜内缓推(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
];

export const CHAT_CONVERSATION_PARAMS: TemplateParamSpec[] = [
  {key: 'pace', label: '逐条节奏', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'typing', label: '打字三点(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'userColor', label: '用户气泡色(0品牌/1琥珀/2青碧/3玫红/4翠绿)', min: 0, max: 4, step: 1, default: 0, unit: ''},
  {key: 'widthScale', label: '气泡列宽占比', min: 0.5, max: 0.92, step: 0.01, default: 0.62},
  {key: 'badge', label: '✓N 任务徽章(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'bgStyle', label: '底色(0深/1浅)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'avatar', label: '头像对(0关/1开,AI机器人/用户人形)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'meta', label: '时间戳已读(0关/1开,组首时间+用户✓✓)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'group', label: '连发分组(0关/1开,同侧收紧+圆角阶梯)', min: 0, max: 1, step: 1, default: 1, unit: ''},
];

export const WHITEBOARD_CANVAS_PARAMS: TemplateParamSpec[] = [
  {key: 'zoomIn', label: '逐卡推近', min: 1.1, max: 2, step: 0.05, default: 1.3},
  {key: 'pullBack', label: '结尾拉远收全貌(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'cardPop', label: '开场逐卡弹入(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'panMode', label: '平面移动模式(0缩放循环/1平移为主)', min: 0, max: 1, step: 1, default: 1, unit: ''}, // v8 实战：缩放循环晕，平移为主
  {key: 'contentZoom', label: '卡内素材随推近放大(0关/幅度)', min: 0, max: 1, step: 0.05, default: 0, unit: ''}, // v7 实战：与相机推近双重放大过晕
];

export const DOC_PANEL_PARAMS: TemplateParamSpec[] = [
  {key: 'pace', label: '段落节奏', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'selectPulse', label: '选区高亮呼吸(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'toolBar', label: '窗口条三点+标题(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
];

export const PANEL_FLYOUT_PARAMS: TemplateParamSpec[] = [
  {key: 'flyAt', label: '起飞时刻(占段长比例)', min: 0.02, max: 0.5, step: 0.01, default: 0.15, unit: ''},
  {key: 'flyStagger', label: '错峰间隔', min: 0, max: 1.2, step: 0.05, default: 0.3, unit: 's'},
  {key: 'flyAmp', label: '飞出距离', min: 0, max: 2, step: 0.05, default: 1.2}, // v6/v7 实战：1.0 悬半空 1.6 出画外，窄带 1.0-1.4
  {key: 'dim', label: '底层压暗', min: 0, max: 0.6, step: 0.05, default: 0.38},
  {key: 'blurBg', label: '底层虚化(0关/1开)', min: 0, max: 1, step: 1, default: 0, unit: ''}, // v5 复盘：主界面保持清晰=随变语言
];

export const AI_PROMPT_CARD_PARAMS: TemplateParamSpec[] = [
  {key: 'enterAt', label: '回车时机(占段长比例)', min: 0.2, max: 0.7, step: 0.05, default: 0.45, unit: ''},
  {key: 'typeSpeed', label: '打字速度', min: 5, max: 30, step: 1, default: 12, unit: ' 字/秒'},
  {key: 'glow', label: '辉光强度', min: 0, max: 2, step: 0.05, default: 1},
  {key: 'caret', label: '打字光标(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'resultCard', label: '素材结果卡(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'dragIn', label: '素材拖入(0关/1开,占用素材槽替代结果卡)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'thinking', label: '输入前思考三点(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'bgStyle', label: '底色(0深紫夜/1品牌渐变/2纯黑/3浅奶油)', min: 0, max: 3, step: 1, default: 0, unit: ''},
];

export const DEVICE_SHOWCASE_PARAMS: TemplateParamSpec[] = [
  {key: 'device', label: '设备类型(0自动/1笔记本/2手机)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'deviceScale', label: '设备大小', min: 0.6, max: 1.4, step: 0.05, default: 1},
  {key: 'floatAmp', label: '悬浮幅度', min: 0, max: 2, step: 0.05, default: 1},
  {key: 'tiltX', label: '3D 倾斜角', min: -20, max: 20, step: 1, default: 0, unit: '°'},
];

export const DEVICE_SHOWCASE_3D_PARAMS: TemplateParamSpec[] = [
  {key: 'device', label: '设备类型(0自动/1笔记本/2手机)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'deviceScale', label: '设备大小', min: 0.6, max: 1.4, step: 0.05, default: 1},
  {key: 'cameraRig', label: '运镜(0固定/1环绕/2推轨/3摇臂)', min: 0, max: 3, step: 1, default: 2, unit: ''},
  {key: 'rigSpeed', label: '运镜幅度', min: 0.3, max: 2, step: 0.05, default: 1},
  {key: 'ambience', label: '3D 氛围(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 1, unit: ''},
  {key: 'floatAmp', label: '悬浮幅度', min: 0, max: 2, step: 0.05, default: 1},
  {key: 'ambientFx', label: '动效(0关/1标准/2丰富)', min: 0, max: 2, step: 1, default: 1, unit: ''},
];

export const MODEL_TURNTABLE_PARAMS: TemplateParamSpec[] = [
  {key: 'modelSize', label: '模型大小', min: 0.5, max: 1.6, step: 0.05, default: 1},
  {key: 'cameraRig', label: '运镜(0固定/1环绕/2推轨/3摇臂)', min: 0, max: 3, step: 1, default: 1, unit: ''},
  {key: 'rigSpeed', label: '运镜幅度', min: 0.3, max: 2, step: 0.05, default: 1},
  {key: 'spinSpeed', label: '旋转速度', min: 0, max: 2, step: 0.05, default: 1},
  {key: 'ambience', label: '3D 氛围(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 1, unit: ''},
];

export const HERO_3D_TITLE_PARAMS: TemplateParamSpec[] = [
  {key: 'textSize', label: '字高', min: 0.6, max: 1.8, step: 0.05, default: 1},
  {key: 'depth', label: '立体厚度', min: 0.2, max: 2, step: 0.05, default: 1},
  {key: 'textEnter', label: '标题入场节奏', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'cameraRig', label: '运镜(0固定/1环绕/2推轨/3摇臂)', min: 0, max: 3, step: 1, default: 2, unit: ''},
  {key: 'rigSpeed', label: '运镜幅度', min: 0.3, max: 2, step: 0.05, default: 1},
  {key: 'ambience', label: '3D 氛围(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 2, unit: ''},
  {key: 'themeColor', label: '主题色(0品牌/1青碧/2罗兰紫/3琥珀金/4玫红/5翠绿)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'titleFont', label: '标题字体(0文楷/1黄油体/2小薇/3毛笔楷/4快乐体)', min: 0, max: 4, step: 1, default: 0, unit: ''},
  {key: 'ambientFx', label: '动效(0关/1标准/2丰富)', min: 0, max: 2, step: 1, default: 1, unit: ''},];

export const GROWTH_BARS_3D_PARAMS: TemplateParamSpec[] = [
  {key: 'barHeight', label: '柱高倍率', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'rigSpeed', label: '运镜幅度', min: 0.3, max: 2, step: 0.05, default: 1},
  {key: 'ambience', label: '3D 氛围(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 1, unit: ''},
  {key: 'stagger', label: '错峰节奏', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'ambientFx', label: '动效(0关/1标准/2丰富)', min: 0, max: 2, step: 1, default: 1, unit: ''},
];

/** 章节进度卡（ChapterProgress，2026-10-13 真缺口批）：章节推进语义（KineticType 兼职章节无进度） */
export const CHAPTER_PROGRESS_PARAMS: TemplateParamSpec[] = [
  {key: 'chapter', label: '章节序号', min: 1, max: 99, step: 1, default: 1, unit: ''},
  {key: 'total', label: '总章数', min: 1, max: 12, step: 1, default: 3, unit: ''},
  {key: 'numScale', label: '数字字号', min: 0.6, max: 2, step: 0.05, default: 1},
  MOTION_EASE_PARAM_SPEC,
];

/** 价格锚点复合（PriceAnchorPro，2026-10-13 真缺口批）：大数字+卖点+信赖徽章一屏 */
export const PRICE_ANCHOR_PRO_PARAMS: TemplateParamSpec[] = [
  {key: 'priceScale', label: '价格字号', min: 0.6, max: 1.8, step: 0.05, default: 1},
  {key: 'stagger', label: '逐条节奏', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'pulse', label: '价格脉冲', min: 0, max: 1, step: 1, default: 1, unit: ''},
  MOTION_EASE_PARAM_SPEC,
];

/** AI 改写 diff 段（DiffReveal，2026-10-13 真缺口批）：plan 改动手写行版（v1），plan 直采留扩展 */
export const DIFF_REVEAL_PARAMS: TemplateParamSpec[] = [
  {key: 'codeScale', label: '行字号', min: 0.6, max: 1.6, step: 0.05, default: 1},
  {key: 'stagger', label: '逐行节奏', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'glow', label: '差异呼吸', min: 0, max: 1, step: 1, default: 1, unit: ''},
  MOTION_EASE_PARAM_SPEC,
];

export const TREND_LINE_3D_PARAMS: TemplateParamSpec[] = [
  {key: 'lineWidth', label: '线条粗细', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'drawSpeed', label: '画线速度', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'rigSpeed', label: '运镜幅度', min: 0.3, max: 2, step: 0.05, default: 1},
  {key: 'ambience', label: '3D 氛围(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 1, unit: ''},
  {key: 'ambientFx', label: '动效(0关/1标准/2丰富)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  MOTION_EASE_PARAM_SPEC,
];

export const CAMERA_JOURNEY_3D_PARAMS: TemplateParamSpec[] = [
  {key: 'pathWind', label: '蜿蜒程度(0平缓/1标准/2大摆)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'dwellRatio', label: '驻留节奏(0快/1均衡/2长驻留/3特写驻留)', min: 0, max: 3, step: 1, default: 2, unit: ''},
  {key: 'focusPanel', label: '重点展板序号(0-5)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'focusBoost', label: '重点驻留倍率(1-2.5)', min: 1, max: 2.5, step: 0.1, default: 1, unit: ''},
  {key: 'panelSize', label: '展板大小(0小/1标准/2大)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'captionSize', label: '展板标题字号', min: 0.8, max: 1.4, step: 0.05, default: 1},
  {key: 'ambience', label: '3D 氛围(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 1, unit: ''},
  sceneStyleSpec('CameraJourney3D'),
  {key: 'lineGlow', label: '路径发光(0隐藏/1标准/2醒目)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'linkLines', label: '连接线数量(0-6根)', min: 0, max: 6, step: 1, default: 3, unit: ''},
  {key: 'camSpeed', label: '镜头速度(0舒缓/1标准/2迅疾)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'camEase', label: '速度曲线(0干脆/1标准缓动/2慢起慢停)', min: 0, max: 2, step: 1, default: 2, unit: ''},
  {key: 'themeColor', label: '主题色(0品牌/1青碧/2罗兰紫/3琥珀金/4玫红/5翠绿)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'titleFont', label: '标题字体(0文楷/1黄油体/2小薇/3毛笔楷/4快乐体)', min: 0, max: 4, step: 1, default: 0, unit: ''},
  {key: 'ambientFx', label: '动效(0关/1标准/2丰富)', min: 0, max: 2, step: 1, default: 1, unit: ''},];

export const GALLERY_HALL_3D_PARAMS: TemplateParamSpec[] = [
  {key: 'dwellRatio', label: '驻留节奏(0快/1均衡/2长驻留/3特写驻留)', min: 0, max: 3, step: 1, default: 2, unit: ''},
  {key: 'focusPanel', label: '重点展板序号(0-5)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'focusBoost', label: '重点驻留倍率(1-2.5)', min: 1, max: 2.5, step: 0.1, default: 1, unit: ''},
  {key: 'panelSides', label: '展板分布(0同侧/1左右交替)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'panelSize', label: '展板大小(0小/1标准/2大)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'captionSize', label: '展板标题字号', min: 0.8, max: 1.4, step: 0.05, default: 1},
  {key: 'ambience', label: '3D 氛围(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 1, unit: ''},
  sceneStyleSpec('GalleryHall3D'),
  {key: 'spotGlow', label: '射灯亮度(0关/1标准/2醒目)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'shadowLevel', label: '投影阴影(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'camSpeed', label: '镜头速度(0舒缓/1标准/2迅疾)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'camEase', label: '速度曲线(0干脆/1标准缓动/2慢起慢停)', min: 0, max: 2, step: 1, default: 2, unit: ''},
  {key: 'themeColor', label: '主题色(0品牌/1青碧/2罗兰紫/3琥珀金/4玫红/5翠绿)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'titleFont', label: '标题字体(0文楷/1黄油体/2小薇/3毛笔楷/4快乐体)', min: 0, max: 4, step: 1, default: 0, unit: ''},
  {key: 'ambientFx', label: '动效(0关/1标准/2丰富)', min: 0, max: 2, step: 1, default: 1, unit: ''},];

export const ORBIT_CAROUSEL_3D_PARAMS: TemplateParamSpec[] = [
  {key: 'spinSpeed', label: '展环旋转(0停/1缓旋/2旋转)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'dwellRatio', label: '驻留节奏(0快/1均衡/2长驻留/3特写驻留)', min: 0, max: 3, step: 1, default: 2, unit: ''},
  {key: 'focusPanel', label: '重点展板序号(0-5)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'focusBoost', label: '重点驻留倍率(1-2.5)', min: 1, max: 2.5, step: 0.1, default: 1, unit: ''},
  {key: 'panelSize', label: '展板大小(0小/1标准/2大)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'captionSize', label: '展板标题字号', min: 0.8, max: 1.4, step: 0.05, default: 1},
  {key: 'ambience', label: '3D 氛围(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 1, unit: ''},
  sceneStyleSpec('OrbitCarousel3D'),
  {key: 'coreGlow', label: '光柱亮度(0关/1标准/2醒目)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'shadowLevel', label: '投影阴影(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'camSpeed', label: '镜头速度(0舒缓/1标准/2迅疾)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'camEase', label: '速度曲线(0干脆/1标准缓动/2慢起慢停)', min: 0, max: 2, step: 1, default: 2, unit: ''},
  {key: 'themeColor', label: '主题色(0品牌/1青碧/2罗兰紫/3琥珀金/4玫红/5翠绿)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'titleFont', label: '标题字体(0文楷/1黄油体/2小薇/3毛笔楷/4快乐体)', min: 0, max: 4, step: 1, default: 0, unit: ''},
  {key: 'ambientFx', label: '动效(0关/1标准/2丰富)', min: 0, max: 2, step: 1, default: 1, unit: ''},];

export const TIME_TUNNEL_3D_PARAMS: TemplateParamSpec[] = [
  {key: 'dwellRatio', label: '驻留节奏(0快/1均衡/2长驻留/3特写驻留)', min: 0, max: 3, step: 1, default: 2, unit: ''},
  {key: 'focusPanel', label: '重点展板序号(0-5)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'focusBoost', label: '重点驻留倍率(1-2.5)', min: 1, max: 2.5, step: 0.1, default: 1, unit: ''},
  {key: 'flyThrough', label: '穿越模式(0逐板驻留/1匀速穿越)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'panelStyle', label: '展板样式(0标准展板/1纯立体文字)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'tailHold', label: '结尾留存秒(0=掠过即切，匀速穿越生效)', min: 0, max: 3, step: 0.5, default: 0, unit: 's'},
  {key: 'panelSides', label: '展板分布(0同侧/1左右交替)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'panelSize', label: '展板大小(0小/1标准/2大)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'captionSize', label: '展板标题字号', min: 0.8, max: 1.4, step: 0.05, default: 1},
  {key: 'ambience', label: '3D 氛围(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 1, unit: ''},
  sceneStyleSpec('TimeTunnel3D'),
  {key: 'ringGlow', label: '门框发光(0隐藏/1标准/2醒目)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'ringAnim', label: '门框动画(0静态/1流动/2脉冲/3穿梭)', min: 0, max: 3, step: 1, default: 0, unit: ''},
  {key: 'camSpeed', label: '镜头速度(0舒缓/1标准/2迅疾)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'camEase', label: '速度曲线(0干脆/1标准缓动/2慢起慢停)', min: 0, max: 2, step: 1, default: 2, unit: ''},
  {key: 'themeColor', label: '主题色(0品牌/1青碧/2罗兰紫/3琥珀金/4玫红/5翠绿)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'titleFont', label: '标题字体(0文楷/1黄油体/2小薇/3毛笔楷/4快乐体)', min: 0, max: 4, step: 1, default: 0, unit: ''},
  {key: 'ambientFx', label: '动效(0关/1标准/2丰富)', min: 0, max: 2, step: 1, default: 1, unit: ''},];
export const CITY_SCAPE_3D_PARAMS: TemplateParamSpec[] = [
  {key: 'dwellRatio', label: '驻留节奏(0快/1均衡/2长驻留/3特写驻留)', min: 0, max: 3, step: 1, default: 2, unit: ''},
  {key: 'focusPanel', label: '重点展板序号(0-5)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'focusBoost', label: '重点驻留倍率(1-2.5)', min: 1, max: 2.5, step: 0.1, default: 1, unit: ''},
  {key: 'panelSides', label: '展板分布(0同侧/1左右交替)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'panelSize', label: '展板大小(0小/1标准/2大)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'captionSize', label: '展板标题字号', min: 0.8, max: 1.4, step: 0.05, default: 1},
  {key: 'ambience', label: '3D 氛围(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 1, unit: ''},
  sceneStyleSpec('CityScape3D'),
  {key: 'neonGlow', label: '霓虹亮度(0关/1标准/2醒目)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'linkLines', label: '连接线数量(0-6根)', min: 0, max: 6, step: 1, default: 3, unit: ''},
  {key: 'shadowLevel', label: '投影阴影(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'camSpeed', label: '镜头速度(0舒缓/1标准/2迅疾)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'camEase', label: '速度曲线(0干脆/1标准缓动/2慢起慢停)', min: 0, max: 2, step: 1, default: 2, unit: ''},
  {key: 'themeColor', label: '主题色(0品牌/1青碧/2罗兰紫/3琥珀金/4玫红/5翠绿)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'titleFont', label: '标题字体(0文楷/1黄油体/2小薇/3毛笔楷/4快乐体)', min: 0, max: 4, step: 1, default: 0, unit: ''},
  {key: 'ambientFx', label: '动效(0关/1标准/2丰富)', min: 0, max: 2, step: 1, default: 1, unit: ''},];

export const SPIRAL_ATRIUM_3D_PARAMS: TemplateParamSpec[] = [
  {key: 'dwellRatio', label: '驻留节奏(0快/1均衡/2长驻留/3特写驻留)', min: 0, max: 3, step: 1, default: 2, unit: ''},
  {key: 'focusPanel', label: '重点展板序号(0-5)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'focusBoost', label: '重点驻留倍率(1-2.5)', min: 1, max: 2.5, step: 0.1, default: 1, unit: ''},
  {key: 'panelSize', label: '展板大小(0小/1标准/2大)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'captionSize', label: '展板标题字号', min: 0.8, max: 1.4, step: 0.05, default: 1},
  {key: 'ambience', label: '3D 氛围(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 1, unit: ''},
  sceneStyleSpec('SpiralAtrium3D'),
  {key: 'helixGlow', label: '螺旋发光(0关/1标准/2醒目)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'shadowLevel', label: '投影阴影(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'camSpeed', label: '镜头速度(0舒缓/1标准/2迅疾)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'camEase', label: '速度曲线(0干脆/1标准缓动/2慢起慢停)', min: 0, max: 2, step: 1, default: 2, unit: ''},
  {key: 'themeColor', label: '主题色(0品牌/1青碧/2罗兰紫/3琥珀金/4玫红/5翠绿)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'titleFont', label: '标题字体(0文楷/1黄油体/2小薇/3毛笔楷/4快乐体)', min: 0, max: 4, step: 1, default: 0, unit: ''},
  {key: 'ambientFx', label: '动效(0关/1标准/2丰富)', min: 0, max: 2, step: 1, default: 1, unit: ''},];

export const STARFIELD_3D_PARAMS: TemplateParamSpec[] = [
  {key: 'dwellRatio', label: '驻留节奏(0快/1均衡/2长驻留/3特写驻留)', min: 0, max: 3, step: 1, default: 2, unit: ''},
  {key: 'focusPanel', label: '重点展板序号(0-5)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'focusBoost', label: '重点驻留倍率(1-2.5)', min: 1, max: 2.5, step: 0.1, default: 1, unit: ''},
  {key: 'panelSize', label: '展板大小(0小/1标准/2大)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'captionSize', label: '展板标题字号', min: 0.8, max: 1.4, step: 0.05, default: 1},
  {key: 'ambience', label: '3D 氛围(0关/1弱/2中/3强)', min: 0, max: 3, step: 1, default: 1, unit: ''},
  sceneStyleSpec('Starfield3D'),
  {key: 'starGlow', label: '星空亮度(0关/1标准/2繁星)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'linkLines', label: '连接线数量(0-6根)', min: 0, max: 6, step: 1, default: 3, unit: ''},
  {key: 'camSpeed', label: '镜头速度(0舒缓/1标准/2迅疾)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'camEase', label: '速度曲线(0干脆/1标准缓动/2慢起慢停)', min: 0, max: 2, step: 1, default: 2, unit: ''},
  {key: 'themeColor', label: '主题色(0品牌/1青碧/2罗兰紫/3琥珀金/4玫红/5翠绿)', min: 0, max: 5, step: 1, default: 0, unit: ''},
  {key: 'titleFont', label: '标题字体(0文楷/1黄油体/2小薇/3毛笔楷/4快乐体)', min: 0, max: 4, step: 1, default: 0, unit: ''},
  {key: 'ambientFx', label: '动效(0关/1标准/2丰富)', min: 0, max: 2, step: 1, default: 1, unit: ''},];


export const VIDEO_CUT_PARAMS: TemplateParamSpec[] = [
  {key: 'padStyle', label: '铺排方式(0裁剪/1模糊垫片/2留边)', min: 0, max: 2, step: 1, default: 1, unit: ''},
  {key: 'zoomPulse', label: '微推近', min: 0, max: 2, step: 0.05, default: 0.6},
  {key: 'lowerThird', label: '字幕条', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'cutSec', label: '多镜间隔(秒)', min: 1.2, max: 5, step: 0.1, default: 2.5, unit: 's'},
  {key: 'autoShots', label: '镜头切分(0连续/1按镜头边界)', min: 0, max: 1, step: 1, default: 0, unit: ''},
  MOTION_EASE_PARAM_SPEC,
];

/** Fullbleed 素材主导族（实拍素材满幅、文字浮层；素材零动效，文字入场克制；
 *  P1-5B 起支持段内多镜：≥2 条素材轮转硬切、单素材 autoShots 按镜头边界切） */
export const FULLBLEED_TITLE_PARAMS: TemplateParamSpec[] = [
  {key: 'dim', label: '底部渐变强度', min: 0.4, max: 1, step: 0.05, default: 0.8, unit: ''},
  {key: 'titleScale', label: '标题字号', min: 0.7, max: 1.4, step: 0.05, default: 1},
  {key: 'cutSec', label: '多镜间隔(秒)', min: 1.2, max: 5, step: 0.1, default: 2.5, unit: 's'},
  {key: 'autoShots', label: '镜头切分(0连续/1按镜头边界)', min: 0, max: 1, step: 1, default: 0, unit: ''},
];

export const FULLBLEED_FEATURE_PARAMS: TemplateParamSpec[] = [
  {key: 'dim', label: '底部渐变强度', min: 0.4, max: 1, step: 0.05, default: 0.9, unit: ''},
  {key: 'maxPoints', label: '功能点条数', min: 2, max: 4, step: 1, default: 3, unit: ''},
  {key: 'cutSec', label: '多镜间隔(秒)', min: 1.2, max: 5, step: 0.1, default: 2.5, unit: 's'},
  {key: 'autoShots', label: '镜头切分(0连续/1按镜头边界)', min: 0, max: 1, step: 1, default: 0, unit: ''},
];

export const FULLBLEED_CTA_PARAMS: TemplateParamSpec[] = [
  {key: 'dim', label: '整体暗化', min: 0.3, max: 0.85, step: 0.05, default: 0.55, unit: ''},
  {key: 'titleScale', label: '标题字号', min: 0.7, max: 1.5, step: 0.05, default: 1},
];

export const LOWER_THIRD_PARAMS: TemplateParamSpec[] = [
  {key: 'barOpacity', label: '色块不透明度', min: 0, max: 1, step: 0.05, default: 0.55, unit: ''},
  {key: 'videoScale', label: '素材大小', min: 0.6, max: 1.4, step: 0.05, default: 1},
  MOTION_EASE_PARAM_SPEC,
];

export const STAT_COUNTER_PARAMS: TemplateParamSpec[] = [
  {key: 'valueScale', label: '数字大小', min: 0.6, max: 1.8, step: 0.05, default: 1},
  {key: 'countSpeed', label: '计数速度', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'stagger', label: '卡片错峰', min: 0.5, max: 2, step: 0.05, default: 1},
  MOTION_EASE_PARAM_SPEC,
];

export const TESTIMONIAL_PARAMS: TemplateParamSpec[] = [
  {key: 'quoteScale', label: '引言字号', min: 0.7, max: 1.6, step: 0.05, default: 1},
  {key: 'cardScale', label: '卡片大小', min: 0.7, max: 1.3, step: 0.05, default: 1},
  {key: 'reveal', label: '整体节奏', min: 0.5, max: 2, step: 0.05, default: 1},
  MOTION_EASE_PARAM_SPEC,
];

export const FEATURE_LIST_PARAMS: TemplateParamSpec[] = [
  {key: 'itemScale', label: '条目字号', min: 0.7, max: 1.5, step: 0.05, default: 1},
  {key: 'stagger', label: '逐条节奏', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'mediaScale', label: '素材大小', min: 0.6, max: 1.4, step: 0.05, default: 1},
  DIRECTION_PARAM_SPEC,
  MOTION_EASE_PARAM_SPEC,
];

export const KINETIC_TYPE_PARAMS: TemplateParamSpec[] = [
  {key: 'lineInterval', label: '行间隔', min: 0.3, max: 2, step: 0.05, default: 0.5, unit: 's'},
  {key: 'typeScale', label: '字号', min: 0.6, max: 1.5, step: 0.05, default: 1},
  {key: 'emphasis', label: '末行强调', min: 0, max: 2, step: 0.05, default: 1},
  {key: 'tilt', label: '整体倾角', min: -8, max: 8, step: 0.5, default: 0, unit: '°'},
  {key: 'exitFx', label: '退场特效(0关/1照亮扫光)', min: 0, max: 1, step: 1, default: 0, unit: ''},
];

export const TIMELINE_ROADMAP_PARAMS: TemplateParamSpec[] = [
  {key: 'nodeScale', label: '节点大小', min: 0.7, max: 1.5, step: 0.05, default: 1},
  {key: 'stagger', label: '节点节奏', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'axisSpeed', label: '轴线速度', min: 0.5, max: 2, step: 0.05, default: 1},
  MOTION_EASE_PARAM_SPEC,
];

export const PRICING_TIERS_PARAMS: TemplateParamSpec[] = [
  {key: 'cardScale', label: '卡片大小', min: 0.7, max: 1.3, step: 0.05, default: 1},
  {key: 'stagger', label: '入场节奏', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'highlight', label: '推荐档(0无/1-4序号)', min: 0, max: 4, step: 1, default: 2, unit: ''},
  MOTION_EASE_PARAM_SPEC,
];

export const COMING_SOON_PARAMS: TemplateParamSpec[] = [
  {key: 'dateScale', label: '日期字号', min: 0.6, max: 1.8, step: 0.05, default: 1},
  {key: 'revealSpeed', label: '节奏', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'glow', label: '光斑强度', min: 0, max: 2, step: 0.1, default: 1},
  MOTION_EASE_PARAM_SPEC,
];

export const LOGO_CLOUD_PARAMS: TemplateParamSpec[] = [
  {key: 'cloudScale', label: '网格大小', min: 0.6, max: 1.4, step: 0.05, default: 1},
  {key: 'stagger', label: '错峰节奏', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'cardOpacity', label: '卡片白底', min: 0.4, max: 1, step: 0.05, default: 0.94, unit: ''},
  MOTION_EASE_PARAM_SPEC,
];

export const UI_CALLOUT_PARAMS: TemplateParamSpec[] = [
  {key: 'zoom', label: '推近倍率', min: 1.2, max: 3, step: 0.1, default: 2},
  {key: 'focusX', label: '焦点横坐标', min: 0.05, max: 0.95, step: 0.05, default: 0.5, unit: ''},
  {key: 'focusY', label: '焦点纵坐标', min: 0.05, max: 0.95, step: 0.05, default: 0.4, unit: ''},
  {key: 'circleScale', label: '圆环大小', min: 0.5, max: 2, step: 0.05, default: 1},
  {key: 'zoomOut', label: '结尾拉远(0关/1开)', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'zoomSec', label: '推近时长', min: 0.3, max: 1.5, step: 0.05, default: 0.8, unit: 's'},
  MOTION_EASE_PARAM_SPEC,
];

export const BEFORE_AFTER_PARAMS: TemplateParamSpec[] = [
  {key: 'splitAt', label: '揭示点', min: 0.3, max: 0.7, step: 0.05, default: 0.5, unit: ''},
  {key: 'grayAmount', label: '旧态灰度', min: 0, max: 1, step: 0.05, default: 0.75, unit: ''},
  {key: 'metricScale', label: '指标字号', min: 0.7, max: 1.6, step: 0.05, default: 1},
  {key: 'wipeSec', label: '擦除时长', min: 0.3, max: 1.2, step: 0.05, default: 0.5, unit: 's'},
  MOTION_EASE_PARAM_SPEC,
];

export const CODE_TERMINAL_PARAMS: TemplateParamSpec[] = [
  {key: 'typeSpeed', label: '打字速度', min: 0.5, max: 3, step: 0.1, default: 1},
  {key: 'codeScale', label: '字号', min: 0.6, max: 1.5, step: 0.05, default: 1},
  {key: 'lineDelay', label: '行间隔', min: 0.15, max: 1.5, step: 0.05, default: 0.4, unit: 's'},
];

export const GLOBE_POINTS_PARAMS: TemplateParamSpec[] = [
  {key: 'globeScale', label: '球体大小', min: 0.6, max: 1.5, step: 0.05, default: 1},
  {key: 'rotateSpeed', label: '自转速度', min: 0.3, max: 2, step: 0.05, default: 1},
  {key: 'dotDensity', label: '点密度', min: 0.4, max: 2, step: 0.1, default: 1},
  MOTION_EASE_PARAM_SPEC,
];

export const CARD_CONVERGE_PARAMS: TemplateParamSpec[] = [
  {key: 'stagger', label: '入场间隔', min: 0.15, max: 1.2, step: 0.05, default: 0.4, unit: 's'},
  {key: 'firstHit', label: '首卡落位', min: 0, max: 2, step: 0.05, default: 0.4, unit: 's'},
  {key: 'layoutMode', label: '排列方式(0网格/1扇形/2堆叠)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'dirMode', label: '入场方向(0四边/1四角/2左右)', min: 0, max: 2, step: 1, default: 0, unit: ''},
  {key: 'cardScale', label: '卡片大小', min: 0.6, max: 1.4, step: 0.05, default: 1},
  {key: 'heroZoom', label: '结尾推近', min: 0, max: 2, step: 0.05, default: 1},
  {key: 'tilt', label: '落位倾角', min: 0, max: 15, step: 1, default: 6, unit: '°'},
  DIRECTION_PARAM_SPEC,
  MOTION_EASE_PARAM_SPEC,
];

/** vlog 日期打卡（VlogStamp）：日期字号与标签节奏 */
export const VLOG_STAMP_PARAMS: TemplateParamSpec[] = [
  {key: 'titleScale', label: '日期字号', min: 0.6, max: 1.8, step: 0.05, default: 1},
  {key: 'tagDelay', label: '标签节奏', min: 0.5, max: 2, step: 0.05, default: 1},
];

/** vlog 拍立得照片堆（VlogPolaroid）：入场间隔对齐鼓点即卡点 */
export const VLOG_POLAROID_PARAMS: TemplateParamSpec[] = [
  {key: 'stagger', label: '入场间隔', min: 0.15, max: 1.2, step: 0.05, default: 0.35, unit: 's'},
  {key: 'photoScale', label: '照片大小', min: 0.6, max: 1.4, step: 0.05, default: 1},
  {key: 'scatter', label: '散落倾角', min: 0, max: 2, step: 0.05, default: 1},
];

/** 口播观点卡（TalkingPoint）：出镜画框 + 大字观点 */
export const TALKING_POINT_PARAMS: TemplateParamSpec[] = [
  {key: 'videoScale', label: '出镜画框大小', min: 0.6, max: 1.4, step: 0.05, default: 1},
  {key: 'titleScale', label: '观点字号', min: 0.7, max: 1.6, step: 0.05, default: 1},
  {key: 'featureDelay', label: '要点节奏', min: 0.5, max: 2, step: 0.05, default: 1},
];

/** 教程步骤卡（StepCard）：stepNumber 跨段保持连贯（第 N 步就填 N） */
export const STEP_CARD_PARAMS: TemplateParamSpec[] = [
  {key: 'stepNumber', label: '步骤序号', min: 1, max: 99, step: 1, default: 1, unit: ''},
  {key: 'videoScale', label: '操作画框大小', min: 0.6, max: 1.4, step: 0.05, default: 1},
  {key: 'titleScale', label: '步骤名字号', min: 0.7, max: 1.6, step: 0.05, default: 1},
  DIRECTION_PARAM_SPEC,
];

/**
 * 逐行嵌入（RowEmbed）：设计稿 docs/template-design-row-embed.md §五。
 * 降落类参数的调坏边界：flySpeed 过小行慢吞吞飘、过大砸糊；staggerDecel=0 匀速行雨偏机械；
 * dropDistance 过小读成贴纸；tiltDeg=0 丢「嵌入」读感；seamStrength=0 关掉视觉拟音；
 * camPush 过大面板顶到画框边；rowMedia=0 纯文字行；panelTone=1 深色面板；rowsTextScale 过大会挤行高。
 */
export const ROW_EMBED_PARAMS: TemplateParamSpec[] = [
  {key: 'flySpeed', label: '下落速度', min: 0.6, max: 1.6, step: 0.1, default: 1},
  {key: 'staggerDecel', label: '节拍递减', min: 0, max: 0.4, step: 0.05, default: 0.3, unit: ''},
  {key: 'dropDistance', label: '下落距离', min: 60, max: 240, step: 10, default: 120, unit: 'px'},
  {key: 'tiltDeg', label: '入场仰角', min: 6, max: 24, step: 1, default: 16, unit: '°'},
  {key: 'seamStrength', label: '嵌入闪光', min: 0, max: 1, step: 0.1, default: 1},
  {key: 'camPush', label: '相机推近', min: 0, max: 1, step: 0.1, default: 0.7},
  {key: 'rowMedia', label: '行纹理条带', min: 0, max: 1, step: 1, default: 1, unit: ''},
  {key: 'panelTone', label: '面板色调', min: 0, max: 1, step: 1, default: 0, unit: ''},
  {key: 'rowsTextScale', label: '行文字大小', min: 0.8, max: 1.2, step: 0.05, default: 1},
];


export const TEMPLATES: TemplateMeta[] = [
  {
    id: 'RevealSlide',
    transitionAnchor: {shape: 'rect', w: 0.6, h: 0.5, cx: 0.5, cy: 0.5},  // 媒体画框（frameY=0.25H+off，frameH=0.5H → 中心 0.5H）
    enterMotion: 'right',
    exitMotion: 'right',
    slots: ['showcase'],
    paramSpecs: REVEAL_SLIDE_PARAMS,
    name: '3D 倾斜平推',
    description: '视频片段以 3D 倾斜角度从左到右平推展示，配合底部标题文字，简洁大气',
    usageTip: '多段素材会依次平推切换；画框大小、倾斜角、平推距离在「参数」页调。',
    thumbnail: 'reveal-slide',
    minVideos: 1,
    maxVideos: 5,
    defaultDuration: 8,
    supportsPortrait: true,
  },
  {
    id: 'StackCards',
    videoTypes: ['montage'],
    slots: ['showcase'],
    paramSpecs: STACK_CARDS_PARAMS,
    name: '卡片堆叠翻转',
    description: '视频以 3D 卡片堆叠形式排列，切换时沿 Y 轴翻转，功能要点逐条出现',
    usageTip: '需 2–4 段素材；切换时卡片翻转，功能要点在「文字」页填写。',
    thumbnail: 'stack-cards',
    minVideos: 2,
    maxVideos: 4,
    defaultDuration: 10,
    supportsPortrait: true,
  },
  {
    id: 'CinematicPan',
    slots: ['showcase', 'media'],
    paramSpecs: CINEMATIC_PAN_PARAMS,
    name: '电影感环绕运镜',
    description: '暗色背景中视频缓慢漂浮，模拟相机环绕运镜，配功能描述文字渐显',
    usageTip: '适合 1–3 段素材的叙事感展示；运镜速度、漂浮幅度在「参数」页调。',
    thumbnail: 'cinematic-pan',
    minVideos: 1,
    maxVideos: 3,
    defaultDuration: 10,
    supportsPortrait: true,
  },
  {
    id: 'SplitShowcase',
    transitionAnchor: {shape: 'rect', w: 0.84, h: 0.45, cx: 0.5, cy: 0.275, followLayout: false},  // 横排主媒体窗（固定分屏）
    slots: ['showcase'],
    paramSpecs: SPLIT_SHOWCASE_PARAMS,
    name: '分屏对比展示',
    description: '左侧视频展示、右侧文字排版，边操作边讲解功能亮点',
    usageTip: '左侧依次播素材、右侧列要点；要点在「文字」页填，视频区占比在「参数」页调。',
    thumbnail: 'split-showcase',
    minVideos: 2,
    maxVideos: 4,
    defaultDuration: 10,
    supportsPortrait: true,
  },
  {
    id: 'MinimalFloat',
    slots: ['showcase'],
    paramSpecs: MINIMAL_FLOAT_PARAMS,
    name: '极简悬浮展示',
    description: '纯白背景中视频轻微倾斜悬浮，极简产品标语，高级感十足',
    usageTip: '适合 1–2 段素材 + 一句标语；悬浮幅度、倾斜角在「参数」页调。',
    thumbnail: 'minimal-float',
    minVideos: 1,
    maxVideos: 2,
    defaultDuration: 6,
    supportsPortrait: true,
  },
  {
    id: 'KenBurns',
    transitionAnchor: {shape: 'rect', w: 0.8, h: 0.6, cx: 0.5, cy: 0.52},  // 全幅媒体画框（顶 0.22H + 半高 0.3H）
    slots: ['media', 'story'],
    paramSpecs: KEN_BURNS_PARAMS,
    name: 'Ken Burns 推拉镜头',
    description: '缓慢推拉缩放镜头效果，经典纪录片风格，适合单段视频的叙事感展示',
    usageTip: '仅 1 段素材；在素材卡片上点「裁剪」可控制显示区域，推拉/平移幅度在「参数」页调。',
    thumbnail: 'ken-burns',
    minVideos: 1,
    maxVideos: 1,
    defaultDuration: 6,
    supportsPortrait: true,
  },
  {
    id: 'CursorFollow',
    videoTypes: ['tutorial'],
    slots: ['media'],
    paramSpecs: CURSOR_FOLLOW_PARAMS,
    name: '鼠标跟随运镜',
    description: '跟随录屏鼠标轨迹平移缩放，点击处自动推近，支持 3D 斜视视角；需用本软件录制的素材',
    usageTip:
      '使用步骤：\n' +
      '① 录素材：在本片段「素材」页点右上「录屏 / 截屏」，选「屏幕」或「应用窗口」的源（默认已选主屏），开始录制后正常操作软件即可——鼠标轨迹与点击自动记录，无需勾选；保存后素材自动进入当前片段（选区录制同样记轨迹）。\n' +
      '② 选模板：片段模板切到「鼠标跟随运镜」，画面即按轨迹平移缩放；鼠标点击处会自动推近放大（有点击波纹提示）。\n' +
      '③ 调效果：「参数」页调跟随放大 / 平滑度 / 点击放大倍率与停留时长（点击自动放大、点击波纹可关）；「3D 倾斜角」或「旋转角」≠ 0 即切换为斜看 3D 视角；光标大小与显隐也在此页。\n' +
      '素材没有轨迹时会退化为缓慢推拉：可点「素材」页的「生成演示轨迹」先预览效果。',
    thumbnail: 'cursor-follow',
    minVideos: 1,
    maxVideos: 1,
    defaultDuration: 8,
    supportsPortrait: true,
    // 竖屏配方（v9-vertical 验收 → v11 竖版 d942ace）：卡宽拉满 0.96 + 卡内光标居中 55% 裁切窗 +
    // 舞台=录屏自身 blur 环境虚化（留边与内容永远同色）+ 色板自动取色——治「画中画太小/超出鼠标/背景色不一致」
    portraitParams: {stagePalette: 8, cardFill: 0.96, viewSpan: 0.55, stageAmbient: 1},
    // 全屏画幅：转场（zoomIn/zoomOut）自动焦点按满幅取景，避免焦点错位
    defaultLayout: {videoWidthRatio: 1, videoHeightRatio: 1, rotateX: 0},
    plan: {
      materializable: ['captions', 'mediaWindows', 'beats'],
      beatsDeriver: 'cursorClicks',
    },
  },
  {
    id: 'ScreenDemo',
    videoTypes: ['tutorial'],
    slots: ['media', 'showcase'],
    paramSpecs: SCREEN_DEMO_PARAMS,
    name: '导播演示',
    description:
      '录屏即成品：按导播镜头计划自动切换大/中/小景——点击落小景特写（渐晕+就地放大镜）、停顿出大景、活动段中景跟随，段内 whoosh 模糊转场、倾斜-摆正循环，渲染期从鼠标轨迹确定性生成镜头计划',
    usageTip:
      '使用步骤：\n' +
      '① 录素材：用本软件「整屏录制」的素材（自动记录鼠标轨迹与点击；窗口/选区录制同样记轨迹）。\n' +
      '② 选模板：片段模板切到「导播演示」，渲染时自动按光标活动切镜头——点击处推近特写并从点击点长出就地放大镜（贴边钳制、不透明、只停留 1.6s）、上下文给大景、中间穿插中景，镜头样式不连续重复。\n' +
      '③ 调效果：「参数」页调中景/小景推近倍率；倾斜循环、镜内缓推、点击渐晕、点击浮卡可开关，浮卡大小与光标可调。\n' +
      '没有轨迹的素材退化为单个宽景缓推；想要连续跟随不切镜头用「鼠标跟随运镜」。',
    thumbnail: 'screen-demo',
    minVideos: 1,
    maxVideos: 1,
    defaultDuration: 8,
    supportsPortrait: true,
    // 全屏画幅：转场（zoomIn/zoomOut）自动焦点按满幅取景，避免焦点错位
    defaultLayout: {videoWidthRatio: 1, videoHeightRatio: 1, rotateX: 0},
  },
  {
    id: 'TutorialStep',
    videoTypes: ['tutorial'],
    slots: ['hook'],
    paramSpecs: TUTORIAL_STEP_PARAMS,
    name: '教程步骤卡',
    description: '教程步骤间奏卡：超大步骤号砸入 + 步骤标题 + 全片进度点，背景巨型水印数字；auto_tutorial 自动产出，也可手动插在教程段之间',
    usageTip:
      '无需素材。「文字」页标题写「第 N 步」（模板解析数字做主视觉），副标题写这一步做什么（如「新建一个项目」）。\n' +
      '参数可设总步数，底部进度点标出当前位置。配「导播演示」主段使用（见 auto_tutorial 一键编排）。',
    thumbnail: 'tutorial-step',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 1.6,
    supportsPortrait: true,
  },
  {
    id: 'Montage',
    videoTypes: ['montage', 'promo', 'vlog'],
    slots: ['media', 'showcase'],
    paramSpecs: MONTAGE_PARAMS,
    name: '蒙太奇卡点',
    description: '段内节拍快切蒙太奇：多素材按固定节奏轮切（1.5-2.5s 快闪档对齐业界 1.9-2.4s 平均镜头长），每切带变焦冲击、每 N 切一次方向甩切，镜内缓动防静止',
    usageTip:
      '适合多素材快节奏混剪段：加入 2-6 段素材（或一段素材也行，轮播其可用区间），每 cutSec 秒切下一个素材。\n' +
      '「切换节奏」1.5-2.5s 是广告片黄金档；变焦冲击让每切有落点感；甩切间隔 4 = 每 4 切一次横移甩切。搭 auto_beat_montage 可把段长吸附到节拍。',
    thumbnail: 'montage',
    minVideos: 1,
    maxVideos: 6,
    defaultDuration: 8,
    supportsPortrait: true,
    defaultLayout: {videoWidthRatio: 1, videoHeightRatio: 1, rotateX: 0},
  },
  {
    id: 'ProductFloat',
    videoTypes: ['promo', 'tutorial'],
    slots: ['showcase', 'media'],
    paramSpecs: PRODUCT_FLOAT_PARAMS,
    name: '产品悬浮',
    description: 'Apple hero 派产品悬浮舞台：主体（录屏窗口卡/产品图）悬浮在纯色舞台上缓浮漂移，三种底色——白境（AirPods 语言）/黑底轮廓光（MacBook 语言）/品牌渐变，柔投影 + 可选轮廓辉光 + 镜内缓推',
    usageTip:
      '适合产品的「呼吸感」展示段：视频或图片素材皆可。白境=浅色产品与截图；黑底轮廓光=深色硬件的高级感；渐变=品牌氛围。\n' +
      '缓浮幅度 1 ≈ ±1.5% 位移，配合镜内缓推消静止帧。标题落底部，主体恒居中偏上。',
    thumbnail: 'product-float',
    minVideos: 1,
    maxVideos: 1,
    defaultDuration: 6,
    supportsPortrait: true,
    defaultLayout: {videoWidthRatio: 1, videoHeightRatio: 1, rotateX: 0},
  },
  {
    id: 'AiPromptCard',
    videoTypes: ['promo'],
    slots: ['showcase', 'media'],
    paramSpecs: AI_PROMPT_CARD_PARAMS,
    name: 'AI 提示卡',
    description: '「输入一句话 → 回车 → AI 结果浮出」的开场钩子：中央提示框逐字打出标题文案（打字机+闪烁光标），回车瞬间辉光脉冲、要点行变 AI 建议 chips 逐个弹出、可选素材结果卡从框下生长（framer/descript/Tella 三例确认的行业手法，与「AI 代做」价值同构）',
    usageTip:
      '适合开场钩子段：「文字」页标题写要打字的那句话（如「帮我把这段录屏变成教程」），要点行 1-3 行=回车后弹出的建议 chips，副标题=回车后浮现的说明行。\n' +
      '可放 1 段素材当「AI 生成结果」卡从框下长出（不放则纯文字钩子）；回车时机/打字速度/辉光在「参数」页调；转场建议接「推近」类向前动势。',
    thumbnail: 'ai-prompt-card',
    minVideos: 0,
    maxVideos: 1,
    defaultDuration: 6,
    supportsPortrait: true,
    defaultLayout: {videoWidthRatio: 1, videoHeightRatio: 1, rotateX: 0},
  },
  {
    id: 'DeviceShowcase',
    transitionAnchor: {shape: 'rect', w: 0.47, h: 0.6, cx: 0.5, cy: 0.53, followLayout: false},  // 设备壳（横屏素材=笔记本壳近似；竖屏手机模式壳更窄，cover 偏保守）
    slots: ['showcase', 'media'],
    paramSpecs: DEVICE_SHOWCASE_PARAMS,
    name: '设备悬浮展示',
    description: '把录屏/截图装进笔记本或手机壳悬浮展示，柔和投影+呼吸浮动，轻松做出产品发布级质感',
    usageTip:
      '① 放入一段录屏或截图素材（竖屏素材自动套手机壳，横屏套笔记本壳）；\n' +
      '② 「参数」页可强制设备类型（自动/笔记本/手机）、调设备大小与悬浮幅度、3D 倾斜角；\n' +
      '③ 深色背景最出效果（默认已是深色渐变），配「电影」档画面质感更佳。',
    thumbnail: 'device-showcase',
    minVideos: 1,
    maxVideos: 1,
    defaultDuration: 8,
    supportsPortrait: true,
  },
  {
    id: 'DeviceShowcase3D',
    videoTypes: ['promo', 'tutorial'],
    slots: ['showcase', 'media'],
    paramSpecs: DEVICE_SHOWCASE_3D_PARAMS,
    name: '3D 设备展示',
    description: '真 3D 设备壳（WebGL 实时光照/反射/地面接触影）+ 相机运镜，录屏贴上设备屏幕，发布会级质感',
    usageTip:
      '① 放入一段录屏素材（竖屏自动套手机壳，横屏套笔记本壳）；\n' +
      '② 「参数」页选运镜（固定/环绕/推轨/摇臂）、开 3D 氛围（粒子光锥雾）、调设备大小与悬浮幅度；\n' +
      '③ 深色背景最出效果；注意挖段与取景视口暂不作用于 3D 屏幕（需要时请改用「设备悬浮展示」）。',
    thumbnail: 'device-showcase-3d',
    minVideos: 1,
    maxVideos: 1,
    defaultDuration: 8,
    supportsPortrait: true,
  },
  {
    id: 'ModelTurntable',
    videoTypes: ['promo', 'tutorial'],
    slots: ['showcase'],
    paramSpecs: MODEL_TURNTABLE_PARAMS,
    name: '3D 模型展示台',
    description: '上传 .glb 产品模型自动居中旋转展示，真 3D 光照/反射/地影+相机运镜，实体产品宣传片的核心镜头',
    usageTip:
      '① 上传 .glb 模型素材（未压缩单文件，draco/.gltf 需先转换）；\n' +
      '② 模型自带动画时自动按帧播放，无动画则旋转台自转（速度可调）；\n' +
      '③ 「参数」页选运镜（环绕/推轨/摇臂）、开 3D 氛围、调模型大小。',
    thumbnail: 'model-turntable',
    minVideos: 1,
    maxVideos: 1,
    defaultDuration: 8,
    supportsPortrait: true,
  },
  {
    id: 'Hero3DTitle',
    videoTypes: ['promo', 'tutorial'],
    slots: ['hook'],
    paramSpecs: HERO_3D_TITLE_PARAMS,
    name: '3D 立体文字片头',
    description: '真 3D 挤出文字（真实倒角与金属高光）+ 相机推轨 + 粒子光锥，片头大字/品牌名的发布会级演绎',
    usageTip:
      '① 只填标题即出片（中文霞鹜文楷、英文 Poppins Bold，自动按文种选字体）；\n' +
      '② 「参数」页调字高/厚度/运镜/氛围档位；侧面颜色跟随品牌色；\n' +
      '③ 深色背景+中档氛围最出效果，适合放片头第一段。',
    thumbnail: 'hero-3d-title',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 6,
    supportsPortrait: true,
  },
  {
    id: 'GridMosaic',
    slots: ['media', 'showcase'],
    paramSpecs: GRID_MOSAIC_PARAMS,
    name: '网格拼图',
    description: '多段视频以网格排列同时展示，适合功能对比或照片集锦',
    usageTip: '需 4–6 段素材同时拼格；网格间距、圆角、入场节奏在「参数」页调。',
    thumbnail: 'grid-mosaic',
    minVideos: 4,
    maxVideos: 6,
    defaultDuration: 8,
    supportsPortrait: true,
  },
  {
    id: 'VerticalScroll',
    enterMotion: 'up',
    exitMotion: 'up',
    slots: ['story'],
    paramSpecs: VERTICAL_SCROLL_PARAMS,
    name: '竖屏滚动文字卡',
    description: '带大段说明文字的竖屏卡片向上滚动，抖音/小红书风格',
    usageTip: '1 段素材做背景 + 大段文字（「文字」页填）；卡片大小、滚动速度在「参数」页调。',
    thumbnail: 'vertical-scroll',
    minVideos: 1,
    maxVideos: 1,
    defaultDuration: 8,
    supportsPortrait: true,
  },
  {
    id: 'SplitCompare',
    slots: ['showcase'],
    paramSpecs: SPLIT_COMPARE_PARAMS,
    name: '分屏对比切换',
    description: '左右两段视频动态分屏对比，分屏线可滑动，适合 A/B 展示',
    usageTip: '需 2 段素材左右对比；分屏线位置、扫动速度在「参数」页调。',
    thumbnail: 'split-compare',
    minVideos: 2,
    maxVideos: 2,
    defaultDuration: 8,
    supportsPortrait: true,
  },
  {
    id: 'NeonTech',
    slots: ['hook', 'showcase'],
    paramSpecs: NEON_TECH_PARAMS,
    name: '暗色霓虹',
    description: '近黑蓝底上霓虹画框点亮、网格扫描线衬托，青蓝辉光克制有质感，科技产品宣传首选',
    usageTip: '适合 1–3 段素材；画框大小、辉光、网格强度在「参数」页调。',
    thumbnail: 'neon-tech',
    minVideos: 1,
    maxVideos: 3,
    defaultDuration: 6,
    supportsPortrait: true,
  },
  {
    id: 'TextSlide',
    enterMotion: 'up',
    slots: ['story', 'hook'],
    paramSpecs: TEXT_SLIDE_PARAMS,
    name: '纯文字幻灯片',
    description: 'PPT 式纯文字页：大标题 + 要点列表，适合标题页/卖点页/金句页',
    usageTip: '无需素材；在「文字」页填标题和要点，字号、行距、节奏在「参数」页调。',
    thumbnail: 'text-slide',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 5,
    supportsPortrait: true,
  },
  {
    id: 'VideoCut',
    // 全体裁可用（P1-5B）：裸素材直剪是所有体裁的底层动词，不再只挂 montage
    slots: ['media'],
    paramSpecs: VIDEO_CUT_PARAMS,
    name: '全屏视频快切',
    description:
      '全屏播放原始素材（无画框/阴影/圆角），真实素材直剪的第一动词：段内放多条素材自动轮转硬切（切点优先场景检测镜头边界），或长素材开「镜头切分」按镜头边界切段内切镜；也配合裁剪（trim）建多个短段快切',
    usageTip:
      '实拍/vlog 主体段首选。两种快切法：①一段放 2-6 条素材（间隔秒参数调节奏，多素材不连用同源）；②一条长素材开「镜头切分」自动按场景切镜。建多个本模板片段各 0.5-1.5 秒 + 硬切/闪白转场 = 节奏蒙太奇。',
    thumbnail: 'video-cut',
    minVideos: 1,
    maxVideos: 6,
    defaultDuration: 3,
    supportsPortrait: true,
    // 全屏画幅：转场（zoomIn/zoomOut）自动焦点按满幅取景，避免焦点错位
    defaultLayout: {videoWidthRatio: 1, videoHeightRatio: 1, rotateX: 0},
  },
  {
    id: 'FullbleedTitle',
    slots: ['hook', 'showcase'],
    paramSpecs: FULLBLEED_TITLE_PARAMS,
    name: '全幅大标题',
    description:
      '实拍素材撑满画幅 + 底部渐变上的大标题/副标题——电影感开场/章节页。素材是绝对主角（满幅零动效），文字浮层入场克制（淡入+轻上滑）。支持段内多镜：多条素材轮转、或长素材按镜头边界自动切（参数页）。实拍素材优先本族（FullbleedTitle/Feature/CTA），别把实拍缩成画中画',
    usageTip:
      '实拍/城市/人物空镜开场首选；一段可放多条空镜轮转（间隔秒调节奏），或一条长素材开「镜头切分」自动按场景切镜。底部渐变强度与标题字号在「参数」页调。',
    thumbnail: 'fullbleed-title',
    minVideos: 1,
    maxVideos: 6,
    defaultDuration: 4,
    supportsPortrait: true,
    defaultLayout: {videoWidthRatio: 1, videoHeightRatio: 1, rotateX: 0},
  },
  {
    id: 'FullbleedFeature',
    slots: ['showcase', 'proof'],
    paramSpecs: FULLBLEED_FEATURE_PARAMS,
    name: '全幅功能点',
    description:
      '实拍素材满幅 + 底部渐变上浮层功能点列表（小圆点 + 短句，逐条克制入场）——画面讲主体、文字讲卖点。素材零动效，实拍是主角；支持段内多镜：多条素材轮转、或长素材按镜头边界自动切（参数页）',
    usageTip:
      '实拍产品/场景配 2-4 条卖点的展示段；多场景卖点可一段放多条素材轮转讲。功能点条数、渐变强度与多镜节奏在「参数」页调。',
    thumbnail: 'fullbleed-feature',
    minVideos: 1,
    maxVideos: 6,
    defaultDuration: 5,
    supportsPortrait: true,
    defaultLayout: {videoWidthRatio: 1, videoHeightRatio: 1, rotateX: 0},
  },
  {
    id: 'FullbleedCTA',
    slots: ['cta'],
    paramSpecs: FULLBLEED_CTA_PARAMS,
    name: '全幅收尾 CTA',
    description:
      '结尾段：实拍素材满幅整体暗化，居中大标题/副标题/品牌名——电影感收束。无素材也可用（纯暗底居中 CTA）',
    usageTip: '片尾行动号召：一句主张 + 副标题 + 品牌名。暗化强度在「参数」页调。',
    thumbnail: 'fullbleed-cta',
    minVideos: 0,
    maxVideos: 1,
    defaultDuration: 4,
    supportsPortrait: true,
    defaultLayout: {videoWidthRatio: 1, videoHeightRatio: 1, rotateX: 0},
  },
  {
    id: 'ScreenRecord',
    slots: ['media'],
    name: '屏幕录制',
    description:
      '原样导出录屏：整段只有录屏素材本身，无文字/动效/装饰/淡入淡出，画面完整显示不裁剪；配合「录制素材」构成独立录制成片功能',
    usageTip:
      '录屏直出成片用这个（区别于「全屏视频快切」的蒙太奇快切）：在「素材」页点「录制素材」录好（可选摄像头构图烧录）→ 时长自动对齐素材 → 渲染即得原始录像。掐头去尾/挖掉中段用裁剪；取景视口可裁掉边缘无关区域。',
    thumbnail: 'screen-record',
    minVideos: 1,
    maxVideos: 1,
    defaultDuration: 8,
    supportsPortrait: true,
    // 全屏画幅：转场（zoomIn/zoomOut）自动焦点按满幅取景，避免焦点错位
    defaultLayout: {videoWidthRatio: 1, videoHeightRatio: 1, rotateX: 0},
  },
  {
    id: 'PanelFlyout',
    videoTypes: ['tutorial'],
    slots: ['media'],
    paramSpecs: PANEL_FLYOUT_PARAMS,
    name: 'UI 拆层飞出',
    description: '把录屏里的软件面板（侧栏/属性板/时间轴）拆成独立层从主界面飞出，底层压暗虚化；区域来自 <素材名>.regions.json（视觉检测/CDP/无障碍树三路）',
    usageTip:
      '使用步骤：\n' +
      '① 出区域：对录屏素材跑 scripts/extract-ui-regions.cjs 生成 <素材名>.regions.json（视觉检测，通用）；Electron/web 素材可用 CDP/无障碍树出精确盒（source 字段区分）。\n' +
      '② 入工程：regions.json 与素材同目录同名（或把 uiRegionsTrack 指到该文件），模板读 clip.uiRegions。\n' +
      '③ 调效果：起飞时刻/错峰/飞出距离/底层压暗与虚化；role=main 的区域作为主界面垫底不飞。',
    thumbnail: 'panel-flyout',
    minVideos: 1,
    maxVideos: 1,
    defaultDuration: 6,
    supportsPortrait: true,
    defaultLayout: {videoWidthRatio: 1, videoHeightRatio: 1, rotateX: 0},
  },
  {
    id: 'ChatConversation',
    videoTypes: ['promo'],
    slots: ['story'],
    paramSpecs: CHAT_CONVERSATION_PARAMS,
    name: '对话气泡会话流',
    description: '多轮对话气泡逐条弹入：头像对（AI 机器人/用户人形）、组首时间戳+用户✓✓已读、同侧连发分组收紧——聊天气泡的呼吸节奏；用户气泡=强调色渐变底（品牌色=用户声音），AI 气泡=中性卡带打字三点；✓N 任务徽章；features 行首 u:/a: 编码角色',
    usageTip:
      '使用步骤：\n' +
      '① 写脚本：要点行每行一条气泡，行首 u:=用户台词（强调色底）、a:=AI 回复（中性卡）；无前缀视为 AI。例：u:剧情反转不够强烈，帮我改 / a:✅ 需求解析已完成，我会重写三幕结构。\n' +
      '② 调效果：逐条节奏 / 打字三点 / 用户气泡色（0=品牌色——「品牌色=用户声音」）/ 气泡列宽 / ✓N 徽章 / 深浅底色 / 头像对 / 时间戳已读 / 连发分组。',
    thumbnail: 'chat-conversation',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 8,
    supportsPortrait: true,
    textSlots: ['features', 'brandName'],
  },
  {
    id: 'WhiteboardCanvas',
    videoTypes: ['promo', 'tutorial'],
    slots: ['showcase'],
    paramSpecs: WHITEBOARD_CANVAS_PARAMS,
    name: '白板画布',
    description: '多张卡片散布画布，相机横移+逐卡推近+结尾拉远收全貌；[v]标题|副题=视频卡、[t]/无前缀=文字卡；纯模板零素材可出片；卡间连接线不做（随变产品特点）',
    usageTip:
      '使用步骤：\n' +
      '① 写卡片：要点行每行一张卡，[v]标题|副题=视频卡（按序吃片段素材）、[t]标题|副题 或无前缀=文字卡；建议 3-6 张。\n' +
      '② 调效果：逐卡推近倍率 / 结尾拉远收全貌 / 开场逐卡弹入；浅色舞台用 style.background 浅渐变即可（白纸卡深字两态都成立）。',
    thumbnail: 'whiteboard-canvas',
    minVideos: 0,
    maxVideos: 3,
    defaultDuration: 8,
    supportsPortrait: true,
    textSlots: ['features', 'brandName'],
    plan: {
      materializable: ['captions', 'mediaWindows', 'beats'],
      beatsDeriver: 'cardDwell',
    },
  },
  {
    id: 'DocPanel',
    videoTypes: ['promo'],
    slots: ['story'],
    paramSpecs: DOC_PANEL_PARAMS,
    name: '文档面板',
    description: '纸面文档逐段浮现：行内 [[选区]] 高亮呼吸、img:标签 行=底部虚线配图占位格逐格弹入；窗口条三点+文档标题；白纸卡深字',
    usageTip:
      '使用步骤：\n' +
      '① 写正文：要点行每行一段，行内 [[文本]]=选区高亮（呼吸脉冲），img:标签 行=配图占位格（建议 2-4 格）。\n' +
      '② 调效果：段落节奏 / 选区呼吸开关 / 窗口条开关；title 填文档标题显示在窗口条。',
    thumbnail: 'doc-panel',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 8,
    supportsPortrait: true,
    textSlots: ['title', 'features', 'brandName'],
    plan: {
      materializable: ['captions', 'beats'],
      beatsDeriver: 'docTimeline',
    },
  },
  {
    id: 'LowerThird',
    videoTypes: ['talkingHead'],
    enterMotion: 'up',
    slots: ['media', 'story'],
    paramSpecs: LOWER_THIRD_PARAMS,
    name: '字幕条解说',
    description:
      '下三分之一字幕条为主体的解说段：素材在上半部展示，标题/副标题收进底部信息条；不放素材就是纯字幕信息页',
    usageTip: '素材可选（0–1 段）；标题/副标题在「文字」页填，色块不透明度、素材大小在「参数」页调。',
    thumbnail: 'lower-third',
    minVideos: 0,
    maxVideos: 1,
    defaultDuration: 5,
    supportsPortrait: true,
  },
  {
    id: 'StatCounter',
    slots: ['data'],
    paramSpecs: STAT_COUNTER_PARAMS,
    name: '数据页',
    description: '大数字从 0 滚动到目标值的统计页：后缀单位弹入、标签渐显，说服力场景的核心一环',
    usageTip:
      '无需素材。「文字」页要点每行写一条数据，格式「数值 后缀 标签」：如「99.9% 服务可用率」「3000万+ 累计用户」「1,200,000 次调用」「3x 效率提升」（最多 4 条，非数值开头的行按原文展示）。标题写页面标题（如「用数字说话」）。',
    thumbnail: 'stat-counter',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 5,
    supportsPortrait: true,
    videoTypes: ['promo'],
  },
  {
    id: 'Testimonial',
    slots: ['proof'],
    paramSpecs: TESTIMONIAL_PARAMS,
    name: '客户证言',
    description: '白色证言卡居中：星级逐格弹亮、引言上浮、头像圆徽+姓名/职位淡入，口碑场景标配',
    usageTip:
      '无需素材。「文字」页要点按序填：第 1 行引言、第 2 行署名「姓名，职位」、第 3 行星级 0-5（缺省 5 星，0 隐藏）。标题可作卡内小标签（如「用户声音」）。',
    thumbnail: 'testimonial',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 5,
    supportsPortrait: true,
    videoTypes: ['promo', 'talkingHead'],
  },
  {
    id: 'FeatureList',
    enterMotion: 'up',
    slots: ['showcase', 'story'],
    paramSpecs: FEATURE_LIST_PARAMS,
    name: '功能清单',
    description: '勾选圆环描边生长 + 对勾划出 + 要点逐条入场；可选 1 段素材作侧卡，无素材清单居中',
    usageTip:
      '素材可选（0-1 段，横版放左侧/竖版放顶部）。「文字」页填清单标题和要点（≤6 条，每条一行），副标题可选。',
    thumbnail: 'feature-list',
    minVideos: 0,
    maxVideos: 1,
    defaultDuration: 6,
    supportsPortrait: true,
  },
  {
    id: 'KineticType',
    videoTypes: ['montage'],
    slots: ['hook'],
    paramSpecs: KINETIC_TYPE_PARAMS,
    name: '节拍大字',
    description: '整屏超大字逐行砸入，「」关键词品牌色高亮；画面最多保留 3 行滚动，适合 hook 开场/金句段',
    usageTip:
      '无需素材。「文字」页要点每行一句大字（≤8 行，用「」包住关键词会高亮）。有 BGM 节拍时自动逐行踩拍（一拍一行、每 4 拍下拍行加重）；无 BGM 时可手动把「行间隔」调成鼓点间隔整数倍。',
    thumbnail: 'kinetic-type',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 5,
    supportsPortrait: true,
  },
  {
    id: 'ChapterProgress',
    slots: ['hook', 'story'],
    paramSpecs: CHAPTER_PROGRESS_PARAMS,
    name: '章节进度',
    description: '章节号数字滚动 + 进度点逐个亮起 + 大字标题——「第 X 幕」的推进感，多幕叙事的转折章节卡',
    usageTip:
      '无需素材。标题 = 章节大字（如「自动分镜」）；副标题 = 章节副题（如「素材进来，结构出去」）。「章节序号」「总章数」在「参数」页填（如第 2/4 幕）——进度点亮到当前章。',
    thumbnail: 'chapter-progress',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 5,
    supportsPortrait: true,
    videoTypes: ['promo'],
  },
  {
    id: 'TimelineRoadmap',
    enterMotion: 'right',
    slots: ['story', 'data'],
    paramSpecs: TIMELINE_ROADMAP_PARAMS,
    name: '流程时间线',
    description: '轴线延伸 + 节点逐个爆开 + 标签浮现；横版水平轴上下交错，竖版垂直轴，适合路线图/流程/里程碑',
    usageTip:
      '无需素材。「文字」页要点每行一个节点「标签 描述」（首个空格前是标签，如「v1.0 内测发布」「2024Q3 正式上线」，≤5 节点）；标题/副标题照常填。',
    thumbnail: 'timeline-roadmap',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 6,
    supportsPortrait: true,
    videoTypes: ['promo'],
  },
  {
    id: 'PricingTiers',
    enterMotion: 'up',
    slots: ['data', 'cta'],
    paramSpecs: PRICING_TIERS_PARAMS,
    name: '定价档位',
    description: '档位卡片 stagger 上升入场，推荐档放大 + 品牌色描边脉冲 + 「推荐」徽标；竖版自动纵排',
    usageTip:
      '无需素材。「文字」页要点每行一档「档位名 价格 描述」（前两段不含空格，如「基础版 ¥0 入门协作」，≤4 档）；「推荐档」参数设 1-4 指定高亮档位（0 = 无）。',
    thumbnail: 'pricing-tiers',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 6,
    supportsPortrait: true,
    videoTypes: ['promo'],
  },
  {
    id: 'PriceAnchorPro',
    slots: ['data', 'cta'],
    paramSpecs: PRICE_ANCHOR_PRO_PARAMS,
    name: '价格锚点',
    description: '价格大数字 + 卖点对勾清单 + 信赖徽章一屏——单档锚定式定价页（档位对比用「定价档位」）',
    usageTip:
      '无需素材。标题 = 价格大字（如「¥8/月」）；副标题 = 锚点补充语（如「解锁自有模型」）。要点每行一条卖点（≤4，带对勾）；行前加「!」的变信赖徽章（≤3，如「!30 天可退」「!本地运行」）。',
    thumbnail: 'price-anchor-pro',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 6,
    supportsPortrait: true,
    videoTypes: ['promo'],
  },
  {
    id: 'ComingSoon',
    slots: ['hook', 'cta'],
    paramSpecs: COMING_SOON_PARAMS,
    name: '新品预告',
    description: '深色底 + 漂移光斑，主文案 charPop、日期分段数字滚动（保留前导零）；CapCut 竖版使用量第一的原型',
    usageTip:
      '无需素材。标题 = 主文案（如「全新 2.0 即将上线」）；要点第 1 行 = 日期（如「2026.09.01」，数字会滚动）；副标题 = 行动句（如「预约抢先体验」）。',
    thumbnail: 'coming-soon',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 5,
    supportsPortrait: true,
    videoTypes: ['promo'],
  },
  {
    id: 'LogoCloud',
    slots: ['proof'],
    paramSpecs: LOGO_CLOUD_PARAMS,
    name: '客户云',
    description: 'logo 图白色卡片网格 stagger 弹入（社会证明标配）；没素材时退化为客户名文字芯片网格',
    usageTip:
      '放 1-8 张客户/媒体 logo 图效果最好；无素材时「文字」页要点填客户名列表（≤8 条）。标题如「他们都在用」。',
    thumbnail: 'logo-cloud',
    minVideos: 0,
    maxVideos: 8,
    defaultDuration: 5,
    supportsPortrait: true,
    videoTypes: ['promo'],
  },
  {
    id: 'UICallout',
    slots: ['media'],
    paramSpecs: UI_CALLOUT_PARAMS,
    name: '录屏标注',
    description: '录屏增值器：全屏铺满后向焦点平滑推近，品牌色圆环描边生长 + 脉冲，标题做成标注芯片；结尾自动拉远',
    usageTip:
      '需 1 段录屏。「参数」页调推近倍率与焦点坐标（focusX/focusY 为 0-1 画面比例，指到要讲清的 UI 区域）；标题 = 标注文案、副标题 = 补充说明。',
    thumbnail: 'ui-callout',
    minVideos: 1,
    maxVideos: 1,
    defaultDuration: 6,
    supportsPortrait: true,
  },
  {
    id: 'BeforeAfter',
    videoTypes: ['tutorial'],
    slots: ['proof', 'showcase'],
    paramSpecs: BEFORE_AFTER_PARAMS,
    name: '前后对比',
    description: '时间维度 A/B：前半段旧状态（灰暗滤镜 + 「之前」角标），中点横向擦除揭示新状态；指标行翻牌（旧值划掉新值滑入）',
    usageTip:
      '需 2 段素材：第 1 段旧状态、第 2 段新状态。标题 = 对比结论（中点浮现）；要点 = 指标行「16小时 → 5分钟」（≤3 条）。「揭示点」参数调切换时机。',
    thumbnail: 'before-after',
    minVideos: 2,
    maxVideos: 2,
    defaultDuration: 6,
    supportsPortrait: true,
  },
  {
    id: 'DiffReveal',
    slots: ['proof', 'showcase'],
    paramSpecs: DIFF_REVEAL_PARAMS,
    name: 'AI 改写 diff',
    description: '深色 diff 面板：删除行划线淡出、新增行品牌色高亮呼吸——「模型自由改」的改动清单可视化',
    usageTip:
      '无需素材。标题 = 标题行（如「AI 改了什么」）；副标题 = 改动摘要（如「3 处改动 · 卡点对齐」）。要点每行一条 diff：前缀「-」=删除行、「+」=新增行、无前缀=上下文行（≤10 行），如「-字幕偏晚 0.4s」「+对齐节拍 2.4」。行内容可从时间线 plan 摘要（get_segment_plan）的改动手工转写。',
    thumbnail: 'diff-reveal',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 6,
    supportsPortrait: true,
    videoTypes: ['promo', 'tutorial'],
  },
  {
    id: 'CodeTerminal',
    videoTypes: ['tutorial'],
    transitionAnchor: {shape: 'rect', w: 0.62, h: 0.62, cx: 0.5, cy: 0.47, followLayout: false},  // 终端窗卡片（位置固定，不随 layout 偏移）
    enterMotion: 'up',
    exitMotion: 'up',
    slots: ['showcase', 'media'],
    paramSpecs: CODE_TERMINAL_PARAMS,
    name: '代码滚动',
    description: '深色终端卡 + 窗口点，代码打字机逐行出现（注释/字符串/关键字分色），超行自动上滚，光标闪烁；开发者工具向',
    usageTip:
      '无需素材。「文字」页要点每行一条代码（≤14 行，保留空行）；标题 = 文件名（如「deploy.sh」）。打字速度/行间隔在「参数」页调。',
    thumbnail: 'code-terminal',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 6,
    supportsPortrait: true,
  },
  {
    id: 'GlobePoints',
    slots: ['data'],
    paramSpecs: GLOBE_POINTS_PARAMS,
    name: '环球点阵',
    description: '正交投影点阵地球缓慢自转，数个节点品牌色高亮 + 扩散脉冲；底部数据条数字滚动（「99,000 用户 · 95 国家」式表达）',
    usageTip:
      '无需素材。标题 = 主文案（如「全球在运行」）；要点 = 数据行（同数据页格式「数值 后缀 标签」，≤3 条）。',
    thumbnail: 'globe-points',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 6,
    supportsPortrait: true,
    videoTypes: ['promo', 'montage'],
  },
  {
    id: 'CardConverge',
    videoTypes: ['montage'],
    slots: ['hook', 'media'],
    paramSpecs: CARD_CONVERGE_PARAMS,
    name: '卡片汇聚卡点',
    description:
      '多张卡片随节拍从四边/四角依次飞入汇聚中央，落位带弹性回跳，结尾整体推近——用元素落位表达节奏，不靠画面闪烁',
    usageTip:
      '需 2–8 段素材；把「入场间隔」调到与 BGM 鼓点间隔一致（先用「卡点对齐」吸附片段边界），每张卡恰好压一拍；排列/方向/推近在「参数」页调。',
    thumbnail: 'card-converge',
    minVideos: 2,
    maxVideos: 8,
    defaultDuration: 5,
    supportsPortrait: true,
  },
  {
    id: 'BrandIntro',
    slots: ['hook'],
    paramSpecs: BRAND_INTRO_PARAMS,
    name: '品牌片头',
    description: '深色品牌底上 logo 与品牌名缩放淡入、标语渐入、一道光扫过；无素材时显示品牌首字徽标',
    usageTip: '放 1 张 logo 图或短视频效果最好，也可不放素材（自动用品牌首字徽标）；品牌名/标语在「文字」页填。',
    thumbnail: 'brand-intro',
    minVideos: 0,
    maxVideos: 1,
    defaultDuration: 4,
    supportsPortrait: true,
    videoTypes: ['promo'],
  },
  {
    id: 'OutroCTA',
    slots: ['cta'],
    paramSpecs: OUTRO_CTA_PARAMS,
    name: '结尾行动号召',
    description: '品牌名 + 感谢观看 + 行动指引逐行渐入，可放二维码（白色底卡），背景微光粒子',
    usageTip: '结尾页；要展示二维码就把二维码图片作为该段素材上传（自动垫白色底卡入场，qrScale 调大小），不上传素材则纯文字；行动指引在「文字」页 features 填（每行一条）。',
    thumbnail: 'outro-cta',
    minVideos: 0,
    maxVideos: 1,
    defaultDuration: 5,
    supportsPortrait: true,
    videoTypes: ['promo'],
  },
  {
    id: 'VlogStamp',
    slots: ['story'],
    paramSpecs: VLOG_STAMP_PARAMS,
    name: '日期地点打卡',
    description:
      'vlog 手帐风打卡页：暖纸底 + 大号日期/天数印章式砸落，地点行带琥珀标记，标签胶囊依次弹入，右上角 REC 呼吸红点',
    usageTip: 'vlog 开场/转场页：标题填日期或 DAY N（如「07·21」），副标题填地点，要点每行一枚小标签（自驾/日出/篝火…）。',
    thumbnail: 'vlog-stamp',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 3,
    supportsPortrait: true,
    videoTypes: ['vlog'],
  },
  {
    id: 'VlogPolaroid',
    slots: ['media', 'story'],
    paramSpecs: VLOG_POLAROID_PARAMS,
    name: '拍立得照片堆',
    description:
      '1-8 张照片装进白边拍立得相框散落排布，逐张从右下甩入落位带弹性，第 i 张的要点就是它的手写小注——旅行/日常照片集锦',
    usageTip: '照片集锦页：要点第 i 行 = 第 i 张照片的小注（可留空）；「入场间隔」对齐 BGM 鼓点即卡点；倾角散落感在「参数」页调。',
    thumbnail: 'vlog-polaroid',
    minVideos: 1,
    maxVideos: 8,
    defaultDuration: 5,
    supportsPortrait: true,
    videoTypes: ['vlog'],
  },
  {
    id: 'TalkingPoint',
    slots: ['story'],
    paramSpecs: TALKING_POINT_PARAMS,
    name: '口播观点卡',
    description:
      '出镜画面 + 大字观点一体的成品卡：横版左侧竖构图出镜画框（圆角微倾软阴影）右侧观点大字，竖版上人下字；观点句先给结论，要点作论据逐条入场',
    usageTip: '口播视频每观点一段的标配：标题填观点句（一句话先给结论），副标题补充说明，要点 ≤3 条论据；出镜素材 1 段（口播/画中画皆可）。',
    thumbnail: 'talking-point',
    minVideos: 1,
    maxVideos: 1,
    defaultDuration: 5,
    supportsPortrait: true,
    videoTypes: ['talkingHead'],
  },
  {
    id: 'StepCard',
    slots: ['story'],
    paramSpecs: STEP_CARD_PARAMS,
    name: '教程步骤卡',
    description:
      '「步骤 N · 名称」成品卡：大号序号弹簧砸落 + STEP 标签 + 步骤名大字 + 操作要点带序号圆标，可选 1 段操作画面画框（无素材 = 纯文字步骤页）',
    usageTip: '教程每步一段的标配：「参数」页的步骤序号填第几步（跨段连贯），标题填步骤名，副标题填这步达成什么，要点 ≤4 条操作动作；操作录屏 1 段可选。',
    thumbnail: 'step-card',
    minVideos: 0,
    maxVideos: 1,
    defaultDuration: 5,
    supportsPortrait: true,
    videoTypes: ['tutorial'],
  },
  {
    id: 'GrowthBars3D',
    slots: ['data'],
    paramSpecs: GROWTH_BARS_3D_PARAMS,
    name: '3D 增长柱状图',
    description: '深色舞台上的真 3D 柱状图：柱体错峰弹起、柱顶 3D 数值随生长浮出，相机环绕+氛围粒子，经营月报/增长战报的报表镜头',
    usageTip:
      '无需素材。「文字」页要点每行一条数据：「标签 数值」（如「一月 120」「月活用户 120万」）或「数值 标签」（如「120万 月活用户」），3-8 条；万/亿/千/百/K/M 后缀自动折算柱高，有效行不足 3 条时回退示例数据。标题写图表主题；柱高/运镜/氛围/错峰在「参数」页调。',
    thumbnail: 'growth-bars-3d',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 7,
    supportsPortrait: true,
    videoTypes: ['promo', 'tutorial'],
  },
  {
    id: 'TrendLine3D',
    slots: ['data'],
    paramSpecs: TREND_LINE_3D_PARAMS,
    name: '3D 趋势曲线',
    description: '真 3D 管状折线沿样条逐段绘制生长，节点球随进度弹亮，末端脉冲高亮+3D 终值标注，增长率/走势/战报的趋势镜头',
    usageTip:
      '无需素材。「文字」页要点每行一个数据点：「标签 数值」（如「1月 32」「月活用户 120万」）或「数值 标签」，3-10 条；有效行不足 3 条时回退示例数据。标题写图表主题；线条粗细/运镜/氛围在「参数」页调。',
    thumbnail: 'trend-line-3d',
    minVideos: 0,
    maxVideos: 0,
    defaultDuration: 7,
    supportsPortrait: true,
    videoTypes: ['promo', 'tutorial'],
  },
  {
    id: 'CameraJourney3D',
    videoTypes: ['promo', 'tutorial'],
    slots: ['media', 'showcase'],
    paramSpecs: CAMERA_JOURNEY_3D_PARAMS,
    name: '3D 旅程',
    description: '一镜到底 3D 空间巡览：发光蜿蜒路径串起 2-6 块媒体/文字展板，相机远景开场后逐站驻留推近（视频在展板上实时播放），收尾拉远回收全景',
    usageTip:
      '单段建议 15-30s。素材 0-6 段（视频/图片；.glb 模型不支持会跳过）；要点第 i 行 = 第 i 块展板标题（无素材的行做成纯文字展板，素材多于要点则多余素材无标题）；标题 = 开场远景大字、副标题 = 收尾浮现。路径蜿蜒/驻留节奏/展板大小/路径发光在「参数」页调。挖段与取景不作用于 3D 屏幕纹理。',
    thumbnail: 'camera-journey-3d',
    minVideos: 0,
    maxVideos: 6,
    defaultDuration: 20,
    supportsPortrait: true,
  },
  {
    id: 'GalleryHall3D',
    videoTypes: ['promo', 'tutorial'],
    slots: ['media', 'showcase'],
    paramSpecs: GALLERY_HALL_3D_PARAMS,
    name: '3D 艺廊',
    description: '美术馆长廊一镜到底：展板交替挂在左右墙面，头顶射灯光锥 + 地面光池 + 倒影，相机沿中轴逐幅走近侧身细品，收尾到尽头转身回望整廊',
    usageTip:
      '单段建议 15-25s。素材 0-6 段（视频/图片；.glb 模型不支持会跳过）；要点第 i 行 = 第 i 块展板标题（无素材的行做成纯文字展板）；标题 = 开场洞口大字、副标题 = 回望浮现。驻留节奏/展板大小/射灯亮度在「参数」页调。挖段与取景不作用于 3D 屏幕纹理。',
    thumbnail: 'gallery-hall-3d',
    minVideos: 0,
    maxVideos: 6,
    defaultDuration: 20,
    supportsPortrait: true,
  },
  {
    id: 'OrbitCarousel3D',
    videoTypes: ['promo', 'tutorial'],
    slots: ['media', 'showcase'],
    paramSpecs: ORBIT_CAROUSEL_3D_PARAMS,
    name: '3D 环游展台',
    description: '媒体展板围成旋转圆环（面朝环外），中央品牌光柱定轴，相机高空俯瞰开场后逐板追踪特写（驻留时随环共旋、背景粒子掠过），收尾拉升高空回看整环',
    usageTip:
      '单段建议 15-25s。素材 0-6 段（视频/图片；.glb 模型不支持会跳过）；要点第 i 行 = 第 i 块展板标题（无素材的行做成纯文字展板）；标题/副标题悬浮环心上方。展环旋转/驻留节奏/展板大小/光柱亮度在「参数」页调。挖段与取景不作用于 3D 屏幕纹理。',
    thumbnail: 'orbit-carousel-3d',
    minVideos: 0,
    maxVideos: 6,
    defaultDuration: 20,
    supportsPortrait: true,
  },
  {
    id: 'TimeTunnel3D',
    videoTypes: ['promo', 'tutorial'],
    slots: ['media', 'showcase'],
    paramSpecs: TIME_TUNNEL_3D_PARAMS,
    name: '3D 穿越隧道',
    description: '发光门框排成纵深隧道，媒体展板交替挂在框侧，相机沿中轴逐框穿越（穿框掠过的强透视），驻留贴板细品，收尾穿出升高回望整条隧道；穿越模式可选「匀速穿越」（全程无静止帧：开场即有初速、结尾在运动中切走）、展板样式可选「纯立体文字」去底板（无素材的要点行变成迎头驶来的 3D 挤出字）',
    usageTip:
      '单段建议 15-25s。素材 0-6 段（视频/图片；.glb 模型不支持会跳过）；要点第 i 行 = 第 i 块展板标题（无素材的行做成纯文字展板）；标题 = 开场洞口大字、副标题 = 回望浮现（匀速穿越时副标题垫后作最后一站）。穿越模式选「匀速穿越」时镜头正视前方匀速直飞、开场即有初速、全程无静止帧（适合开场钩子/纯文字标语），时长 ≈ 2.1s×(要点行数+1) + 结尾留存 tailHold（默认 0 = 最后一块字掠过立即切下一段，>0 镜头保持同速前滑不刹车），转场建议「穿越/快速甩镜」等向前动势衔接；展板样式选「纯立体文字」时无素材的展板去底板、只留 3D 挤出字（穿越模式走头顶航道，可读窗口内全程完整在画）。驻留节奏/展板大小/门框发光在「参数」页调。挖段与取景不作用于 3D 屏幕纹理。',
    thumbnail: 'time-tunnel-3d',
    minVideos: 0,
    maxVideos: 6,
    defaultDuration: 20,
    supportsPortrait: true,
  },
  {
    id: 'CityScape3D',
    videoTypes: ['promo', 'tutorial'],
    slots: ['media', 'showcase'],
    paramSpecs: CITY_SCAPE_3D_PARAMS,
    name: '3D 城市天际线',
    description: '夜景街道峡谷一镜到底：媒体展板做成楼体立面上的霓虹巨幕（挂高错落），相机低空沿街飞行逐楼驻留仰望，收尾升空回望整条亮灯的街谷与天际线剪影',
    usageTip:
      '单段建议 15-25s。素材 0-6 段（视频/图片；.glb 模型不支持会跳过）；要点第 i 行 = 第 i 块巨幕标题（无素材的行做成纯文字展板）；标题 = 开场街口大字、副标题 = 回望浮现。驻留节奏/展板大小/霓虹亮度在「参数」页调。挖段与取景不作用于 3D 屏幕纹理。',
    thumbnail: 'city-scape-3d',
    minVideos: 0,
    maxVideos: 6,
    defaultDuration: 20,
    supportsPortrait: true,
  },
  {
    id: 'SpiralAtrium3D',
    videoTypes: ['promo', 'tutorial'],
    slots: ['media', 'showcase'],
    paramSpecs: SPIRAL_ATRIUM_3D_PARAMS,
    name: '3D 旋转中庭',
    description: '垂直螺旋一镜到底（3D 家族唯一纵向模板）：展板沿螺旋线绕中央光柱盘旋而上，相机从底层仰视开场、沿螺旋外侧逐板驻留攀升，收尾升到顶上俯瞰整条螺旋与地面光环',
    usageTip:
      '单段建议 15-25s。素材 0-6 段（视频/图片；.glb 模型不支持会跳过）；要点第 i 行 = 第 i 块展板标题（无素材的行做成纯文字展板）；标题 = 开场仰视大字、副标题 = 俯瞰时地面圆心浮现。驻留节奏/展板大小/螺旋发光在「参数」页调。挖段与取景不作用于 3D 屏幕纹理。',
    thumbnail: 'spiral-atrium-3d',
    minVideos: 0,
    maxVideos: 6,
    defaultDuration: 20,
    supportsPortrait: true,
  },
  {
    id: 'Starfield3D',
    videoTypes: ['promo', 'tutorial'],
    slots: ['media', 'showcase'],
    paramSpecs: STARFIELD_3D_PARAMS,
    name: '3D 深空星域',
    description: '开放星空一镜到底：媒体展板像空间站一样散布漂浮，星座连线把它们串成星图，相机漂移巡航逐板驻留，收尾后拉升高回看整张星图（星点 + 品牌色星云柔光）',
    usageTip:
      '单段建议 15-25s。素材 0-6 段（视频/图片；.glb 模型不支持会跳过）；要点第 i 行 = 第 i 块展板标题（无素材的行做成纯文字展板）；标题 = 开场星图大字、副标题 = 收尾中央浮现。驻留节奏/展板大小/星空亮度在「参数」页调。挖段与取景不作用于 3D 屏幕纹理。',
    thumbnail: 'starfield-3d',
    minVideos: 0,
    maxVideos: 6,
    defaultDuration: 20,
    supportsPortrait: true,
  },
  {
    // 单卡试点（docs/template-design-row-embed.md）：教程/录屏体裁的「结构化内容逐条长进画面」。
    // 追加在数组尾部——get_templates 既有条目顺序零变化（§十二 门控口径）。
    id: 'RowEmbed',
    videoTypes: ['tutorial', 'promo'],
    slots: ['showcase', 'story'],
    paramSpecs: ROW_EMBED_PARAMS,
    name: '逐行嵌入',
    description: '内容行从空中落下嵌入面板，落地亮强调色缝（≤4 行）',
    usageTip:
      '教程/演示的功能逐条呈现：标题=面板主标题，副标题=一行说明，要点=行列表（16:9/9:16 取前 4 条、21:9/1:1 只放 3 行，每条 ≤24 字），1 段素材可选（铺底 + 行右侧条带，无素材退为纯文字行）。下落速度/节拍递减/嵌入闪光在「参数」页调。',
    thumbnail: 'row-embed',
    minVideos: 0,
    maxVideos: 1,
    defaultDuration: 5,
    supportsPortrait: true,
    textSlots: ['title', 'subtitle', 'features', 'brandName'],
  },
];

// 档位式参数（主题色/驻留节奏/运镜…label 里编码的 `0甲/1乙` 档位）统一解析成结构化
// options：参数页渲染为选项组（色板/字体 chips/场景卡）而非数字滑块（shared/param-options.ts）
augmentTemplateParamOptions(TEMPLATES);

// 辅助函数
export const getTemplateById = (id: string): TemplateMeta | undefined => {
  return TEMPLATES.find((t) => t.id === id);
};

/**
 * 模板是否适用于某体裁：未标注 videoTypes = 通用模板（任何体裁可见），
 * 标注了则只列出过的体裁可见。只影响 AI 的推荐口径，不限制实际选用。
 */
/**
 * 各体裁的首页推荐策展（OrientationSelector 推荐横排按此顺序取真实存在的模板）。
 * 体裁向明确的模板才进列表——vlog 不推 3D 发布会系，promo 主推 3D 场景族；
 * 列表里的 id 找不到（改名/删除）会被静默跳过，缺额由 templateFitsVideoType 兜底补齐。
 */
export const GENRE_RECOMMENDED_IDS: Record<VideoType, string[]> = {
  // 实拍位进入策展（2026-10-05 拍板）：Fullbleed 族进 promo/vlog/montage 前部——
  // 推荐位决定「AI/新段默认会选什么」（nextSegmentTemplateId 轮选 + 首页策展），
  // 且下次蒸馏采痕教师按推荐位选模板，Fullbleed 示范随批自带；talkingHead/tutorial
  // 是录屏演示体裁不进（实拍铁律的反面：录屏素材的正解是画中画/字幕条族）。
  promo: ['CityScape3D', 'FullbleedTitle', 'FullbleedFeature', 'GalleryHall3D', 'Starfield3D', 'DeviceShowcase3D', 'Hero3DTitle', 'SpiralAtrium3D', 'CameraJourney3D', 'NeonTech', 'BrandIntro', 'TrendLine3D', 'ChapterProgress', 'PriceAnchorPro', 'DiffReveal', 'FullbleedCTA'],
  vlog: ['VlogStamp', 'FullbleedTitle', 'FullbleedFeature', 'VlogPolaroid', 'KenBurns', 'VerticalScroll', 'CinematicPan', 'GridMosaic', 'MinimalFloat', 'RevealSlide', 'CardConverge', 'SplitShowcase', 'FullbleedCTA'],
  talkingHead: ['TalkingPoint', 'LowerThird', 'UICallout', 'TextSlide', 'FeatureList', 'StatCounter', 'Testimonial', 'SplitCompare', 'TimelineRoadmap', 'MinimalFloat'],
  tutorial: ['StepCard', 'RowEmbed', 'ScreenRecord', 'UICallout', 'BeforeAfter', 'CodeTerminal', 'FeatureList', 'TimelineRoadmap', 'SplitShowcase', 'LowerThird', 'CursorFollow'],
  montage: ['VideoCut', 'FullbleedTitle', 'KineticType', 'CardConverge', 'StackCards', 'NeonTech', 'GridMosaic', 'GlobePoints', 'LogoCloud', 'RevealSlide', 'CinematicPan', 'FullbleedCTA'],
};

export const templateFitsVideoType = (
  t: Pick<TemplateMeta, 'videoTypes'>,
  videoType: VideoType,
): boolean => !t.videoTypes || t.videoTypes.length === 0 || t.videoTypes.includes(videoType);

/**
 * 「整段原样输出」模板（无任何装饰元素，成片 = 素材本身）。
 * 末段为该类模板时全片不做收尾淡黑（MultiSegmentPromo 与渲染/预览帧数计算同步判断），
 * 否则原始录像导出会被强加 0.5s 渐黑结尾。
 */
const RAW_OUTPUT_TEMPLATE_IDS = ['ScreenRecord'];
export const isRawOutputTemplate = (id: string | undefined): boolean =>
  !!id && RAW_OUTPUT_TEMPLATE_IDS.includes(id);

export const getTemplateMap = (): Record<string, TemplateMeta> => {
  return Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));
};

/** 自定义模板转 TemplateMeta（用于在选择器/下拉中与内置模板合并展示） */
export const customTemplateToMeta = (def: CustomTemplateDef): TemplateMeta => ({
  id: def.id,
  name: `🎨 ${def.name}`,
  description: def.description || '自定义模板',
  thumbnail: 'custom',
  minVideos: 1,
  maxVideos: 6,
  defaultDuration: def.duration,
  supportsPortrait: true,
  paramSpecs: def.paramSpecs,
  ...(def.textSlots ? {textSlots: def.textSlots} : {}),
  searchTags: [def.name, ...(def.description ? [def.description] : [])],
});

/** 市场模板包转 TemplateMeta；缩略图直接用包内 data-URI（消费处识别 data: 前缀） */
export const marketPackToMeta = (pack: TemplatePack): TemplateMeta => ({
  id: pack.id,
  name: `☁️ ${pack.name}`,
  description: pack.description || '云端模板',
  thumbnail: pack.thumbnail || 'custom',
  minVideos: 1,
  maxVideos: 6,
  defaultDuration: pack.def.duration,
  supportsPortrait: true,
  paramSpecs: pack.def.paramSpecs,
  ...(pack.def.textSlots ? {textSlots: pack.def.textSlots} : {}),
  searchTags: [...(pack.tags ?? []), pack.name, ...(pack.description ? [pack.description] : [])],
});

/** 判断 templateId 是否为自定义模板 */
export const isCustomTemplateId = (id: string): boolean => id.startsWith('custom-');

/** 判断 templateId 是否为市场模板（数据驱动，与自定义模板共用渲染链路） */
export const isDataDrivenTemplateId = (id: string): boolean => isCustomTemplateId(id) || isMarketTemplateId(id);

export {isMarketTemplateId};
export {isGeneratedTemplateId, findGeneratedDef};

/**
 * 合并全部可用模板的 meta：内置 + 自定义 + 市场 + AI 生成（统一收口，替代各处散写）。
 * AI 生成模板排最后（🤖 前缀），槽位未标注不在槽位过滤清单内（与市场模板同口径）。
 */
export const mergeTemplateMetas = (
  customTemplates: CustomTemplateDef[],
  marketTemplates: TemplatePack[] = [],
  generatedTemplates: GeneratedTemplateDef[] = [],
): TemplateMeta[] => [
  ...TEMPLATES.map((m) => (TEXT_SLOTS_BUILTIN[m.id] ? {...m, textSlots: TEXT_SLOTS_BUILTIN[m.id]} : m)),
  ...customTemplates.map(customTemplateToMeta),
  ...marketTemplates.map(marketPackToMeta),
  ...generatedTemplates.map(generatedTemplateToMeta),
];

/**
 * 内置模板的文字槽位表：每个模板真正会渲染的 text.* 字段（对 templates/*.tsx 逐一扫描
 * text.title/subtitle/brandName/features 的实际消费点得出；新增/修改模板时在此同步登记）。
 * 用途：mergeTemplateMetas 注入 meta.textSlots → get_templates 回传 + llm-tools 校验器对
 * 「设置了不会显示的字段」发 notes——解决 BrandIntro 等模板静默忽略未消费字段（如 subtitle）
 * 导致文案不上的坑。
 * 非内置模板的槽位来源：自定义/市场模板由 def.textSlots 携带（编辑器勾选或 detectTextSlots
 * 静态检测），AI 生成模板由 generate_template 的 textSlots 参数写入 def；三类经
 * customTemplateToMeta/marketPackToMeta/generatedTemplateToMeta 透出。仍无 textSlots 的 = 未知，不做提示。
 */
export const TEXT_SLOTS_BUILTIN: Record<string, string[]> = {
  RevealSlide: ['title', 'subtitle', 'brandName'],
  StackCards: ['title', 'features', 'brandName'],
  CinematicPan: ['title', 'features', 'brandName'],
  SplitShowcase: ['title', 'subtitle', 'features', 'brandName'],
  MinimalFloat: ['title', 'subtitle', 'brandName'],
  KenBurns: ['title', 'subtitle'],
  CursorFollow: ['title', 'subtitle'],
  DeviceShowcase: ['title', 'subtitle'],
  DeviceShowcase3D: ['title', 'subtitle'],
  ModelTurntable: ['title', 'subtitle'],
  Hero3DTitle: ['title', 'subtitle'],
  GridMosaic: ['title', 'features'],
  VerticalScroll: ['title', 'subtitle', 'features', 'brandName'],
  SplitCompare: ['title', 'features'],
  NeonTech: ['title', 'subtitle', 'features', 'brandName'],
  TextSlide: ['title', 'subtitle', 'features', 'brandName'],
  VideoCut: ['title', 'subtitle'],
  FullbleedTitle: ['title', 'subtitle', 'brandName'],
  FullbleedFeature: ['title', 'features'],
  FullbleedCTA: ['title', 'subtitle', 'brandName'],
  ScreenRecord: [],
  LowerThird: ['title', 'subtitle'],
  StatCounter: ['title', 'features', 'brandName'],
  Testimonial: ['title', 'subtitle', 'features', 'brandName'],
  FeatureList: ['title', 'subtitle', 'features', 'brandName'],
  KineticType: ['title', 'features', 'brandName'],
  ChapterProgress: ['title', 'subtitle', 'brandName'],
  PriceAnchorPro: ['title', 'subtitle', 'features', 'brandName'],
  DiffReveal: ['title', 'subtitle', 'features', 'brandName'],
  TimelineRoadmap: ['title', 'subtitle', 'features', 'brandName'],
  PricingTiers: ['title', 'subtitle', 'features', 'brandName'],
  ComingSoon: ['title', 'subtitle', 'features', 'brandName'],
  LogoCloud: ['title', 'subtitle', 'features', 'brandName'],
  UICallout: ['title', 'subtitle', 'brandName'],
  BeforeAfter: ['title', 'features', 'brandName'],
  CodeTerminal: ['title', 'features', 'brandName'],
  GlobePoints: ['title', 'features', 'brandName'],
  CardConverge: ['title'],
  BrandIntro: ['brandName', 'title'],
  OutroCTA: ['brandName', 'title', 'features'],
  VlogStamp: ['title', 'subtitle', 'features', 'brandName'],
  VlogPolaroid: ['title', 'features'],
  TalkingPoint: ['title', 'subtitle', 'features', 'brandName'],
  StepCard: ['title', 'subtitle', 'features'],
  GrowthBars3D: ['title', 'features'],
  TrendLine3D: ['title', 'features'],
  CameraJourney3D: ['title', 'subtitle', 'features'],
};

/** 按 id 查数据驱动模板的 def：先本地自定义，后市场模板 */
export const findDataDrivenDef = (
  id: string,
  customTemplates: CustomTemplateDef[],
  marketTemplates: TemplatePack[] = [],
): CustomTemplateDef | undefined =>
  customTemplates.find((t) => t.id === id) ?? marketTemplates.find((t) => t.id === id)?.def;

/** 市场模板的 def 列表（供渲染 inputProps 并入 customTemplates 通道） */
export const marketTemplateDefs = (marketTemplates: TemplatePack[]): CustomTemplateDef[] =>
  marketTemplates.map((t) => t.def);

/** 模板竖屏缺省覆盖（P0-1「竖屏一等公民」单一入口）：故事板派生 deriveBoard(portrait) 叠加在段参数之上。
 *  值域出处与竖屏形态说明见 docs/template-portrait-spec.md；无 portraitParams = 该模板竖屏无需覆盖。 */
export const portraitParamsFor = (templateId: string): Record<string, number> => {
  const meta = TEMPLATES.find((t) => t.id === templateId);
  return {...(meta?.portraitParams ?? {})};
};
