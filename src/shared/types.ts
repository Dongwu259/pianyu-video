/**
 * 主进程、渲染进程、Remotion 三端共享的 TypeScript 类型定义
 */

import type {CustomTemplateDef} from './custom-template';
import type {GeneratedTemplateDef} from './generated-template';
import type {EasingCurve} from './easing-curve.ts';
import type {CursorActionEvent, CursorClick, CursorPoint} from './capture.ts';
import type {UiRegionSource} from './ui-regions.ts';
import type {ColorGrade, ColorStats} from './color-grade';
import type {BgmCredit} from './bgm-credits';
import type {FontMoodId} from './font-presets';
export type {FontMoodId} from './font-presets';
import type {ClipCut} from './clipCuts.ts';
import type {ColorCurveId} from './proxy-media.ts';
export type {ColorCurveId};
import type {StabCorrection, StabPoint} from './stabilization.ts';
import type {GroundTrackData} from './groundTrack.ts';
import type {VideoType} from './video-type.ts';
import type {EditPlan} from './edit-plan.ts';
import type {BeatGrid} from './beat-grid.ts';
import type {PlanMaterializableField, TemplatePlanSchema} from './template-plan.ts';

export type {ColorGrade, ColorStats};

// ====== 视频相关 ======

export interface VideoClip {
  id: string;
  src: string;              // 本地视频服务器 HTTP URL（http://127.0.0.1:port/video?path=...）
  name: string;             // 文件名
  width: number;            // 原始宽度
  height: number;           // 原始高度
  duration: number;         // 原始时长（秒）；图片为展示时长
  type: 'video' | 'image' | 'model';  // 媒体类型（图片用 <Img>，视频用 <Video>，model 用 three.js 3D 渲染，仅 .glb）
  thumbnail?: string;       // 缩略图路径（base64 或 file://）
  fit?: FitMode;            // 适配模式（可选，默认用模板设定）
  viewport?: ClipViewport;  // 取景视口（可选，仅对 PiP 画框类模板生效）
  // 剪辑相关（仅视频有意义，图片忽略）
  trimStart?: number;       // 裁剪起始时间（秒，默认 0）
  trimEnd?: number;         // 裁剪结束时间（秒，默认 duration）
  trimmedDuration?: number; // 裁剪后可用时长（秒）= (trimEnd − trimStart) − 挖段总长
  cuts?: ClipCut[];         // 挖段：抠掉中间区间后前后画面无缝拼接（媒体绝对秒，须落在 trim 区间内；纯函数见 shared/clipCuts.ts）
  // 音频控制（仅视频有意义，图片忽略）
  muted?: boolean;          // 静音（默认 false）
  volume?: number;          // 音量 0..1（默认 1）
  // 鼠标轨迹（仅本软件整屏录制的素材有）
  cursorTrack?: string;     // 轨迹 sidecar 文件路径（持久化，随工程落盘/读回）
  cursorPoints?: CursorPoint[]; // 轨迹采样点（内存态，保存工程时剥离，加载时由 cursorTrack 重建）
  cursorClicks?: CursorClick[]; // 点击事件（内存态，与 cursorPoints 同生命周期；CursorFollow 点击运镜消费）
  cursorEvents?: CursorActionEvent[]; // 声明式动作事件（内存态，scroll/type；由 cursorActionScript 重建，不落盘）
  // UI 区域（B6 拆层飞出：面板矩形来源三路 visual/cdp/ax，见 shared/ui-regions.ts）
  uiRegionsTrack?: string;  // 区域 sidecar 文件路径（持久化，<素材名>.regions.json）
  uiRegions?: UiRegionSource[]; // 区域列表（内存态，加载时由 uiRegionsTrack 重建，保存时剥离）
  // 演示轨迹（CursorFollow 无真实轨迹时一键生成，供预览；与真实录制区分）
  cursorDemoSeed?: number;  // 演示轨迹随机种子（持久化；存在即 cursorPoints 为演示轨迹，加载时按种子确定性重建）
  // 声明式动作轨迹（update_segment cursorScript / UI 编辑动作；优先级高于 cursorDemoSeed）
  cursorActionScript?: string; // 动作脚本 DSL（持久化原文；加载时按脚本+种子确定性重建）
  cursorActionSeed?: number;   // 动作轨迹随机种子（弯曲/手抖的确定性来源）
  // 内容确认窗（cue 表内联，媒体绝对秒，来源 .cues.json；导播小景只落窗内——窗外没有已声明的精彩内容，特写易切到空白）
  contentWindows?: Array<{t0: number; t1: number}>;
  // 色彩统计（入库时分析一次；自动曝光匹配消费，见 shared/color-grade.ts）
  colorStats?: ColorStats;
  // Log 色彩曲线（电影机 log 素材标记；导入按 ffprobe 设备元数据猜 + 手动改/AI set_media_colorspace。
  // 代理转码烧入技术转换 LUT 恢复正常色，渲染回源前经带 LUT 一次性转码；见 shared/proxy-media.ts）
  colorCurve?: ColorCurveId;
  // 代理文件绝对路径（mxf/超大/4K 素材后台生成的 960 宽 H.264；抽帧/预览/缩略图读代理，
  // 渲染回源。userData/proxies 下可再生缓存，不随 consolidate 重映射——key 是内容指纹，搬目录仍命中）
  proxyPath?: string;
  // 代理状态（内存态，保存剥离；ready 后由 PROXY_PROGRESS 事件回写 proxyPath）
  proxyStatus?: 'queued' | 'transcoding' | 'ready' | 'failed';
  // 素材来源类型（导入启发式标注 + 手动改；AI 选型规则消费：实拍=live-action 优先 Fullbleed 族）
  sourceKind?: MediaSourceKind;
  // 场景检测清单（scan_media 工具分析一次后落库；时间戳+时长+运动强度，纯文本零 token 供 AI 排片）
  shotList?: Array<{startSec: number; endSec: number; motionScore: number}>;
  // 跟踪稳定（方案 A：分析期产 sidecar 变换表，渲染期按表施加每帧变换，见 shared/stabilization.ts）
  stabilization?: {trackPath: string; points: StabPoint[]; smoothSec: number; enabled: boolean; lostRatio?: number}; // 持久化，随工程落盘/读回（lostRatio = 跟丢帧占比，>0.15 UI 黄灯）
  stabCorrections?: StabCorrection[]; // 每帧校正量表（内存态，保存工程时剥离，加载时由 stabilization.trackPath 重建）
  stabZoom?: number;                  // 全片统一自动缩放（内存态，与 stabCorrections 同生命周期）
  stabSampleFps?: number;             // 校正量表采样率（内存态，同上）
  // 3D 地面追踪（见 shared/groundTrack.ts：分析期产锚点轨迹 sidecar，渲染期逐帧解投影矩阵
  // 驱动 CSS matrix3d 的 preserve-3d 场景，3D 元素钉在地面平面上随镜头运动）
  groundTrack?: {trackPath: string; enabled: boolean; keptAnchors?: number; lostRatio?: number; meanResidualPx?: number}; // 持久化（质量字段供 UI/AI 黄灯）
  groundData?: GroundTrackData;       // 锚点轨迹（内存态 {anchors, samples}，保存剥离，加载时由 groundTrack.trackPath 重建）
}

export type FitMode = 'cover' | 'contain';

/** 素材来源类型（AI 模板选型的关键信号：实拍优先 Fullbleed 满幅族，录屏/图形才配 3D 画中画族） */
export type MediaSourceKind = 'live-action' | 'screen-recording' | 'graphic';

/**
 * 取景视口：在 PiP 画框内对媒体做缩放 + 平移（类似头像裁剪）。
 * 语义与模板/分辨率无关：
 * - scale：在 fit 适配结果上的缩放倍率（1 = 按适配显示）
 * - offsetX/offsetY：平移量，占画框宽/高的比例（0 = 居中，±0.5 = 半个画框）
 *   正值 = 媒体向右/下移（画框窗口看到源素材更靠左/上的部分）
 */
export interface ClipViewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}

// ====== 模板布局参数 ======

export interface TemplateLayout {
  /** 视频画框宽度占画布百分比 (0.1 ~ 1.0) */
  videoWidthRatio: number;
  /** 视频画框高度占画布百分比 (0.1 ~ 1.0) */
  videoHeightRatio: number;
  /** 视频水平位置偏移 (-0.5 ~ 0.5, 0 = 居中) */
  videoOffsetX: number;
  /** 视频垂直位置偏移 (-0.5 ~ 0.5, 0 = 居中) */
  videoOffsetY: number;
  /** X 轴旋转角度 */
  rotateX: number;
  /** Y 轴旋转角度 */
  rotateY: number;
  /** Z 轴旋转角度 */
  rotateZ: number;
  /** 3D 透视距离 (px) */
  perspective: number;
  /** 缩放倍率 (0.5 ~ 2.0) */
  scale: number;
  /** 边框圆角 (px) */
  borderRadius: number;
  /** 自定义画布比例（可选） */
  customAspect?: {x: number; y: number};
  /** 自定义分辨率像素（可选） */
  customResolution?: {width: number; height: number};
}

/** 默认布局参数（基于 RevealSlide 的当前值） */
export const DEFAULT_LAYOUT: TemplateLayout = {
  videoWidthRatio: 0.6,
  videoHeightRatio: 0.5,
  videoOffsetX: 0,
  videoOffsetY: 0,
  rotateX: 5,
  rotateY: 0,
  rotateZ: 0,
  perspective: 1200,
  scale: 1,
  borderRadius: 12,
};

// ====== 模板个性化参数（每模板不同的可调滑块）======

/**
 * 模板参数规格：描述一个模板暴露给用户的可调项（渲染为滑块或选项组）。
 * 模板组件内以「倍率」语义消费（1 = 模板内置默认值），通过
 * remotion/utils/params.ts 的 makeParamReader 读取，默认值必须与此处的 default 一致。
 */
export interface TemplateParamOption {
  value: number;      // 档位值（写进 customParams）
  label: string;      // 档位显示名（如「长驻留」「文楷」）
  /** 示意色（主题色/场景类选项渲染为色点；CSS 颜色或渐变） */
  color?: string;
}

export interface TemplateParamSpec {
  key: string;        // 存到 Segment.customParams 的键（模板内读取用同一个键）
  label: string;      // UI 显示名
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;      // 显示单位（'×' / '°' / 's' 等），缺省 '×'
  /** 离散档位选项（给出时参数页渲染为选项组而非滑块；由 shared/param-options.ts 从档位式 label 统一解析，无需手填） */
  options?: TemplateParamOption[];
}

// ====== 片段 (Segment) - 故事板核心 ======

export interface Segment {
  id: string;
  templateId: string;
  videos: VideoClip[];
  text: PromoText;
  style: PromoStyle;         // ★ 每片段独立的视觉样式
  layout: TemplateLayout;    // ★ 每片段独立的布局参数
  customParams?: Record<string, number>; // ★ 模板个性化参数（键见 TemplateMeta.paramSpecs），缺省全走模板默认
  duration: number;          // 该片段的持续时长（秒，默认 5）
  /** 模板内部时间轴起点（秒）：>0 时从模板动画的第 N 秒开始播放（跳过入场），缺省 0 */
  startOffsetSec?: number;
  transition: TransitionType; // 到下一个片段的过渡效果
  transitionParams?: TransitionParams; // 转场参数（时长/运镜焦点/倍率），缺省全走默认
  /** 转场模板 id（shared/transition-template-registry.ts）：存在时优先于 transition 内置特效；
   *  渲染器不认识该 id（合成未上线）时回退 transition。见 docs/transition-timeline-roadmap.md §4.1 */
  transitionTemplateId?: string;
  /** 转场模板个性化参数（键见该模板 paramSpecs，数值已钳制；缺省全走模板默认） */
  transitionTemplateParams?: Record<string, number>;
  /** 本段出场转场的音效覆盖（'off' 静音 / 指定类别；缺省 = 按转场类型自动映射，见 shared/sfx-plan.ts） */
  transitionSfx?: SfxKind | 'off';
  videoEffect?: VideoEffect;  // 视频画布特效（作用于片段内视频框）
  backgroundEffect?: BackgroundEffect;  // 背景特效（作用于片段背景层）
  textAnim?: TextAnimPreset;  // ★ 该段文字入场动效（内置模板消费；缺省 = 模板各自默认）
  exitStyle?: SegmentExitStyle; // ★ 片尾退场预设（sync 同步退场[默认] / fade 整体淡出 / stagger 留白收尾）
  narration?: SegmentNarration; // ★ 该段旁白（可选；TTS 合成或导入音频）
  captions?: CaptionLine[];  // ★ 该段烧录字幕行（可选；相对段起点的时间）
  overlay?: FloatingOverlay | null; // ★ 该段悬浮图片层（可选；如透明截图的输入框浮在场景上）
  groundElements?: GroundElement[]; // ★ 该段 3D 地面元素（可选；钉在素材地面平面上随镜头透视，见 layers/GroundScene.tsx）
  /** ★ M2 回写环：冻结记录（timeline-master-plan §二.3/§四；vtproj 内部数据，不进 agent 面）。
   *  冻结 = 参数快照 + 外置字段：模板引擎照旧渲染（零新渲染器）；已外置字段改由
   *  materialized 覆盖层驱动（渲染端逐模板开放消费）。文案回写永远可反解（写回 text/features），不触发冻结。 */
  frozen?: SegmentFreezeRecord;
  /** ★ M2 回写环：物化覆盖层——冻结后由时间线接管的原语真值；未列字段仍由模板参数推导 */
  materialized?: SegmentMaterialized;
  /** ★ M3 L2 节拍层：段内手放节拍标记（用户/agent 标记的时刻点，timeline-master-plan §四 v1.4）。
   *  合成时与 BGM 拍点并流成该段 beatGrid 下发模板（踩拍/逐拍生长自动消费；无 BGM 也生效）。
   *  与 plan-projection 的推导节拍（模板内部结构只读投影）是两回事——这是输入原语。 */
  beats?: SegmentBeat[];
}

/** M3 L2 节拍标记：t = 段内秒（0.1 步进钳制，[0, 段时长)）；kind 枚举只增不改 */
export interface SegmentBeat {
  t: number;
  /** accent = 重拍/强调点；mark = 普通标记（v1.4 首批两枚举） */
  kind: 'accent' | 'mark';
  /** 节拍主体（人话，如「第三行」「卡 2」；可选） */
  target?: string;
  /** 备注（可选） */
  note?: string;
}

/** M2 回写环：冻结记录。frozenAt 为首要锚；模板注册表暂无版本号，templateVersion
 *  待模板版本化后回填（additive），此前模板默认值变更需人工核对冻结段。 */
export interface SegmentFreezeRecord {
  frozenAt: string; // ISO 时间
  /** 版本锚（冻结时的模板/数据版本；缺省 = 未版本化时期冻结） */
  templateVersion?: string;
  /** 冻结时 customParams 快照：模板升级不回写冻结段的依据（风险红线 §六.4） */
  paramSnapshot?: Record<string, number>;
  /** 已外置到时间线物化层的字段（累积只增不改） */
  detachedFields: PlanMaterializableField[];
}

/** M2 回写环：排版字幕窗（时间线接管真值）。坐标系 = 段内容时间轴（与 plan-projection
 *  的 PlanCaption 同口径）；序 = plan 投影 captions 序（模板文字槽序）。 */
export interface PlanCaptionWindow {
  startSec: number;
  endSec: number;
}

/** M2 回写环：物化覆盖层（冻结段的时间线侧真值；与 Segment.frozen.detachedFields 对应） */
export interface SegmentMaterialized {
  /** captions 外置后的字幕窗列表（存在即「captions 已由时间线接管」） */
  captions?: PlanCaptionWindow[];
}

/** 3D 地面元素：钉在视频地面平面上的文字/形状（AR 贴地效果）。
 *  坐标语义：u/v = 分析参考帧（groundTrack 分析区间首帧）屏幕归一化位置 0..1；
 *  size = 元素宽度占视频宽比例；渲染端按每帧投影矩阵把元素钉在地面。 */
export interface GroundElement {
  id: string;
  kind: 'text' | 'shape';
  /** kind=text 的文案（shape 忽略） */
  text?: string;
  form: 'flat' | 'billboard' | 'extruded' | 'box' | 'cylinder' | 'cone' | 'plate';
  /** 参考帧屏幕归一化位置（0..1，y 向下） */
  u: number;
  v: number;
  /** 宽度占视频宽比例（0.03~0.8） */
  size: number;
  /** 地面平面内朝向（度；0 = 沿地面 x 轴；立起面板 = 正面朝向） */
  yawDeg?: number;
  /** 立体倾斜（度，-90~90，缺省 0）：绕地面水平轴抬头/低头——
      躺平/立体文字 0 = 贴地、±90 = 竖立面向 yaw 方向；立起面板/立牌 = 前倾后仰 */
  pitchDeg?: number;
  /** 自身平面内旋转（度，-180~180，缺省 0）：文字/面板内容在自身平面里打转 */
  rollDeg?: number;
  /** 厚度倍率（0.2~3，缺省 1）：extruded 文字挤出厚度；box/cylinder/cone 的高度倍率 */
  depth?: number;
  /** 颜色（缺省品牌强调色） */
  color?: string;
  /** 立体元素离地抬升（占视频宽比例的 z 单位；flat/extruded 浮空用） */
  lift?: number;
  entrance?: 'rise' | 'fade' | 'none'; // 入场（rise 从地面升起/fade 淡入/none）
  opacity?: number;                    // 0..1（缺省 1）
}

/** 悬浮图片层（片段级）：透明 PNG（如 capture_element 截的 UI 元素）浮在模板场景之上，
 *  带投影/缓浮/可选 3D 透视。渲染时随片段一起进出场与转场。 */
export interface FloatingOverlay {
  src: string;          // 会话 URL（不持久化，由 path 重建）
  path: string;         // 原始图片路径（持久化 + 媒体存在性检查）
  name: string;         // 文件名
  width: number;        // 源图像素宽
  height: number;       // 源图像素高
  /** 中心点归一化坐标（0-1，相对画布；0.5/0.5 = 正中） */
  x: number;
  y: number;
  /** 宽占画布比例（0.05~1，0.4 = 占 40% 画宽） */
  scale: number;
  /** 缓浮幅度倍率（0 = 静止，1 = 默认 ±8px 上下缓浮） */
  floatAmp?: number;
  /** 3D 透视倾斜角（°，0 = 不倾斜） */
  tiltX?: number;
  tiltY?: number;
  /** 圆角 px（默认 16；透明 PNG 本身有形状时可设 0） */
  radius?: number;
  /** 投影强度倍率（0 = 无投影，1 = 默认柔和投影） */
  shadow?: number;
  /** 不透明度 0~1（默认 1） */
  opacity?: number;
}

/** 片尾退场预设：sync = 素材播到转场前一刻，所有元素随转场一次性消失；
 * fade = 元素同步停留，段尾整帧渐隐；stagger = 旧行为（素材提前退场留白，文字收尾） */
export type SegmentExitStyle = 'sync' | 'fade' | 'stagger';

/** 片尾退场预设 UI 选项 */
export const EXIT_STYLE_OPTIONS: {value: SegmentExitStyle; label: string; desc: string}[] = [
  {value: 'sync', label: '同步退场', desc: '所有元素随转场一次性消失（推荐）'},
  {value: 'fade', label: '整体淡出', desc: '段尾 0.4 秒整帧渐隐'},
  {value: 'stagger', label: '留白收尾', desc: '素材提前退场，文字多留 2-3 秒收尾'},
];

export type TransitionType =
  | 'none'
  | 'crossfade'
  | 'slide'
  | 'wipe'
  | 'iris'
  | 'push'
  | 'velocityPush'
  | 'zoom'
  | 'rotate'
  | 'blur'
  | 'flash'
  | 'zoomIn'
  | 'zoomOut'
  | 'whip'
  | 'flyThrough'
  | 'panChase'
  | 'orbitSwipe'
  | 'cardSweep'
  | 'shapeBloom';

/** 转场参数（挂在 Segment.transitionParams，全部可选，缺省走默认值） */
export interface TransitionParams {
  /** 转场时长（秒），0.2-2，缺省 0.5 */
  durationSec?: number;
  /** 运镜焦点（zoomIn/zoomOut）/ 形状绽放圆心（shapeBloom）：「到下一个片段」时下一片段画面的归一化 X（0-1）。缺省 = 下一片段视频画框中心 */
  focusX?: number;
  /** 同 focusX 的 Y 坐标 */
  focusY?: number;
  /** 推进/拉远倍率，1.2-4，缺省 2（仅 zoomIn/zoomOut 使用） */
  zoom?: number;
  /** 缓动曲线（多点 AE 风格）；设置后替换该转场默认的硬编码缓动 */
  curve?: EasingCurve;
  /**
   * 运动朝向档位：slide/push/velocityPush/wipe/whip/panChase/orbitSwipe/cardSweep 用 1=上 2=下 3=左 4=右；
   * flyThrough 用 1=推近穿过（缺省）/2=拉远飞出。与模板 direction 参数同口径；
   * 缺省 = 各转场内置方向（slide/push/whip/panChase/orbitSwipe/cardSweep 左、wipe 右、flyThrough 推近，零回归）。
   * 运动连续性引擎（shared/motion-chain.ts）按相邻模板运动方向自动填入。
   */
  direction?: number;
}

/** 模板内容的净运动朝向（运动连续性元数据，见 TemplateMeta.enterMotion/exitMotion） */
export type MotionDir = 'up' | 'down' | 'left' | 'right' | 'none';

/** 转场 UI 选项（分组）。transition 字段表示「从本片段到下一个片段」的过渡。 */
export const TRANSITION_OPTIONS: {group: string; value: TransitionType; label: string; desc: string}[] = [
  {group: '基础', value: 'none', label: '硬切', desc: '直接切换，无过渡'},
  {group: '基础', value: 'crossfade', label: '交叉淡化', desc: '前段淡出、后段淡入'},
  {group: '基础', value: 'slide', label: '滑动', desc: '后段从右侧滑入覆盖'},
  {group: '遮罩', value: 'wipe', label: '擦除', desc: '后段从左擦开显出'},
  {group: '遮罩', value: 'iris', label: '圆形展开', desc: '后段由中心圆形展开'},
  {group: '运动', value: 'push', label: '推拉', desc: '前段左移、后段右推'},
  {group: '运动', value: 'velocityPush', label: '速度匹配', desc: 'velocity-matched：出段全程加速、入段全程减速，切点速度峰值连续（目光无回摆），中点强拖影掩护——蒙太奇读成连续运镜（direction 1-4）'},
  {group: '运动', value: 'zoom', label: '缩放', desc: '前段放大淡出、后段缩放淡入'},
  {group: '运动', value: 'rotate', label: '翻转', desc: '3D 翻转切换'},
  {group: '特效', value: 'blur', label: '模糊溶解', desc: '经模糊溶解过渡'},
  {group: '特效', value: 'flash', label: '闪白', desc: '白光闪过后切换'},
  {group: '运镜', value: 'zoomIn', label: '镜头推进', desc: '镜头扎进下一片段的焦点区域（可编辑焦点/倍率）'},
  {group: '运镜', value: 'zoomOut', label: '镜头拉远', desc: '镜头从焦点区域拉远显出下一片段（可编辑焦点/倍率）'},
  {group: '运镜', value: 'whip', label: '快速甩镜', desc: '横向快速甩动切换，动态模糊遮接缝'},
  {group: '运镜', value: 'flyThrough', label: '穿越', desc: '镜头穿过前段画面、从纵深飞入下一片段（3D 空间感）'},
  {group: '运镜', value: 'panChase', label: '横摇追拍', desc: '相机顺前段运动方向追拍，后段从前方入画减速到位（运动接运动，direction 1-4 四向）'},
  {group: '运镜', value: 'orbitSwipe', label: '轨道环绕', desc: '相机绕轴摆过中段遮挡时刻，前段甩出视野边缘、后段从另一侧旋入（3D 空间感）'},
  {group: '遮挡', value: 'cardSweep', label: '卡片扫场', desc: '品牌色圆角卡片扫入盖住画面完成切换（direction 1-4 四向扫入）'},
  {group: '遮挡', value: 'shapeBloom', label: '形状绽放', desc: '品牌色圆形从焦点绽放盖满全屏再收拢显出下一片段（可编辑焦点）'},
];

// ====== 视频画布特效（作用于视频框本身，非背景）======

/**
 * 视频画布特效预设。作用于片段内所有视频框（filter/transform + 覆盖层），
 * 通过 VideoEffectContext 注入，Video3D / CustomTemplateRender 消费。
 */
export type VideoEffect =
  | 'none'
  | 'glitch'
  | 'inkDrip'
  | 'vintage'
  | 'shake'
  | 'scanlines'
  | 'blurPulse'
  | 'clickRipple';

/** 视频特效 UI 选项（分组） */
export const VIDEO_EFFECT_OPTIONS: {group: string; value: VideoEffect; label: string; desc: string}[] = [
  {group: '无', value: 'none', label: '无', desc: '不添加特效'},
  {group: '故障', value: 'glitch', label: '电磁干扰', desc: '色相/对比度跳变 + 抖动 + 扫描撕裂'},
  {group: '故障', value: 'scanlines', label: '扫描线', desc: 'CRT 风格水平扫描线 + 闪烁'},
  {group: '流动', value: 'inkDrip', label: '墨汁滴落', desc: '墨汁从视频顶部向下流淌'},
  {group: '氛围', value: 'vintage', label: '老电影', desc: '褪色 + 颗粒 + 划痕 + 暗角'},
  {group: '氛围', value: 'blurPulse', label: '模糊脉冲', desc: '呼吸式模糊起伏'},
  {group: '运动', value: 'shake', label: '画面抖动', desc: '持续轻微位移与旋转抖动'},
  {group: '交互', value: 'clickRipple', label: '点击水波', desc: '录屏点击位置扩散水波圆环（素材需录屏时记录点击轨迹）'},
];

// ====== 背景特效（作用于片段背景层，与视频画布特效独立调整）======

/**
 * 背景特效预设。作用于片段背景层（在基础背景之上、视频/文字之下）。
 * 通过 BackgroundEffectContext 注入，各模板在背景块后渲染 <BackgroundEffectLayer/> 消费。
 */
export type BackgroundEffect =
  | 'none'
  | 'inkDrip'
  | 'inkSplash'
  | 'inkWash'
  | 'mistDrift'
  | 'bokeh'
  | 'lightRays'
  | 'gradientFlow'
  | 'particles';

/** 背景特效 UI 选项（分组：国风 / 商业） */
export const BACKGROUND_EFFECT_OPTIONS: {group: string; value: BackgroundEffect; label: string; desc: string}[] = [
  {group: '无', value: 'none', label: '无', desc: '不添加背景特效'},
  {group: '国风', value: 'inkDrip', label: '墨汁滴落', desc: '宣纸底 + 墨汁自上而下流淌'},
  {group: '国风', value: 'inkSplash', label: '墨汁喷溅', desc: '宣纸底 + 墨点喷溅散开'},
  {group: '国风', value: 'inkWash', label: '水墨山水', desc: '远山近岭 + 月 + 云雾，水墨写意'},
  {group: '国风', value: 'mistDrift', label: '云雾飘动', desc: '云雾在背景横向漂移'},
  {group: '商业', value: 'bokeh', label: '光斑散景', desc: '彩色光斑上浮，商务汇报常用'},
  {group: '商业', value: 'lightRays', label: '光线投射', desc: '顶部光束扇形投射'},
  {group: '商业', value: 'gradientFlow', label: '流光渐变', desc: '多色渐变流动（极光感）'},
  {group: '商业', value: 'particles', label: '粒子上升', desc: '粒子向上飘升并闪烁'},
];

// ====== 文字入场动效（内置模板每段可选；与自定义模板 EntranceAnim 对齐 + 文字专属扩展）======

/**
 * 文字入场动效预设。内置模板经 TemplateProps.textAnim 传入，由 AnimatedText 消费。
 * 与自定义模板的 EntranceAnim 基本同口径（none、fadeIn、fadeUp、slide 系列、scaleIn、popIn、bounce、blurIn、rotateIn、typewriter），
 * 另含文字专属扩展（charPop 逐字弹入、wordReveal 逐字上浮、maskWipe 遮罩擦出、glowPulse 光晕呼吸）。
 */
export type TextAnimPreset =
  | 'none'
  | 'fadeIn'
  | 'fadeUp'
  | 'slideUp'
  | 'slideDown'
  | 'slideLeft'
  | 'slideRight'
  | 'scaleIn'
  | 'popIn'
  | 'bounce'
  | 'blurIn'
  | 'rotateIn'
  | 'typewriter'
  | 'charPop'
  | 'wordReveal'
  | 'maskWipe'
  | 'glowPulse';

/** 文字动效 UI 选项（分组） */
export const TEXT_ANIM_OPTIONS: {group: string; value: TextAnimPreset; label: string; desc: string}[] = [
  {group: '基础', value: 'none', label: '无', desc: '直接显示，无入场动画'},
  {group: '基础', value: 'fadeIn', label: '淡入', desc: '透明度渐显'},
  {group: '基础', value: 'fadeUp', label: '上浮淡入', desc: '从下方上浮并淡入'},
  {group: '滑入', value: 'slideUp', label: '从下滑入', desc: '从下方滑入'},
  {group: '滑入', value: 'slideDown', label: '从上滑入', desc: '从上方滑入'},
  {group: '滑入', value: 'slideLeft', label: '从右滑入', desc: '从右侧滑入'},
  {group: '滑入', value: 'slideRight', label: '从左滑入', desc: '从左侧滑入'},
  {group: '缩放', value: 'scaleIn', label: '缩放淡入', desc: '从小到大缩放淡入'},
  {group: '缩放', value: 'popIn', label: '弹出', desc: '弹性放大入场'},
  {group: '缩放', value: 'bounce', label: '弹跳', desc: '弹跳入场'},
  {group: '特效', value: 'blurIn', label: '模糊聚焦', desc: '由模糊到清晰'},
  {group: '特效', value: 'rotateIn', label: '旋转入场', desc: '旋转着淡入'},
  {group: '特效', value: 'typewriter', label: '打字机', desc: '逐字显示'},
  {group: '进阶', value: 'charPop', label: '逐字弹入', desc: '动力学文字：逐字弹性弹入（英文按词不断行）'},
  {group: '进阶', value: 'wordReveal', label: '逐字上浮', desc: '每个字依次上浮淡入'},
  {group: '进阶', value: 'maskWipe', label: '遮罩擦出', desc: '遮罩从左向右擦出文字'},
  {group: '进阶', value: 'glowPulse', label: '光晕呼吸', desc: '带光晕淡入并轻微呼吸'},
];

// ====== 旁白轨（每段一条，对齐片段；渲染时从段起点播放）======

/**
 * 片段旁白。可由 TTS 从 text 合成，或导入现成音频。
 * - src 为会话 URL，不持久化（import 由 path 重建，tts 由 text 重生成/查缓存）。
 * - 仅 source='import' 时 path 才参与工程文件媒体存在性检查；tts 文件在 userData 缓存，跨机不迁移。
 */
export interface SegmentNarration {
  text: string;            // 旁白文案（空 = 无旁白）
  src?: string;            // 音频会话 URL（不持久化）
  path?: string;           // import: 原始音频路径；tts: 生成的缓存文件路径
  duration?: number;       // 音频时长（秒）
  volume?: number;         // 0..1，缺省 1
  /** 段内起播偏移（秒，缺省 0 = 段起点起播；时间轴上可拖动旁白块调整，如等转场过去再开口） */
  offsetSec?: number;
  /** TTS 语速 0.5-2，缺省 1（仅 source='tts' 生效；改后需重新合成） */
  speed?: number;
  /** TTS 音色覆盖（缺省用「设置 → TTS」默认音色；仅 source='tts' 生效） */
  voice?: string;
  source?: 'tts' | 'import';
}

// ====== 烧录字幕（每段若干行，相对段起点；渲染时顶层拼成连续字幕轨）======

/**
 * 单条字幕行。startSec/endSec 相对所在片段的内容起点（秒）。
 * 渲染时由 CaptionLayer 在 [startSec, endSec] 窗口内淡入淡出显示。
 */
export interface CaptionLine {
  text: string;        // 字幕文案（≤60 字）
  startSec: number;    // 起始时间（秒，相对段起点，≥0）
  endSec: number;      // 结束时间（秒，相对段起点，>startSec）
}

/** 字幕位置（项目级，所有段共用） */
export type CaptionPosition = 'bottom' | 'top' | 'center';

/** 字幕样式（项目级） */
/** 字幕出现动效：line = 整行淡入（默认）；wordPop = 逐词弹出（卡拉OK 式，竖版社交流标配） */
export type CaptionAnim = 'line' | 'wordPop';

export interface CaptionStyle {
  position: CaptionPosition;
  /** 字号缩放倍率（1 = 基准字号，即副标题档 1080p 下 40px；0.5~2.5） */
  fontSizeScale: number;
  color: string;        // 字色（十六进制）
  /** 底色不透明度（0 = 透明无底色，1 = 全黑底；0~1） */
  bgOpacity: number;
  /** 出现动效（缺省 line，旧工程合并默认值保持原观感） */
  anim?: CaptionAnim;
}

export const CAPTION_POSITION_OPTIONS: {value: CaptionPosition; label: string; desc: string}[] = [
  {value: 'bottom', label: '底部', desc: '画面底部（默认，最常见）'},
  {value: 'top', label: '顶部', desc: '画面顶部'},
  {value: 'center', label: '居中', desc: '画面正中（强调句）'},
];

/** 默认字幕样式（白字 + 半透黑底，底部） */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  position: 'bottom',
  fontSizeScale: 1,
  color: '#FFFFFF',
  bgOpacity: 0.45,
};

// ====== 文字内容 ======

export interface PromoText {
  title: string;            // 主标题
  subtitle?: string;        // 副标题
  features?: string[];      // 功能要点列表
  brandName?: string;       // 品牌/产品名（片尾展示）
}

// ====== 文字/背景样式 ======

export interface TextStyle {
  fontSize?: number;        // px（undefined = 模板默认）
  color?: string;           // 十六进制 / CSS 颜色
  fontWeight?: number;      // 300 | 400 | 600 | 700 | 800
  textDecoration?: 'none' | 'underline';
  fontStyle?: 'normal' | 'italic';
  strokeColor?: string;     // 描边颜色（十六进制/CSS 颜色；缺省 = 无描边）
  strokeWidth?: number;     // 描边宽度 px（0/缺省 = 无描边）
}

export interface PromoStyle {
  background?: string;       // 背景色 / 渐变（undefined = 模板默认）
  title?: TextStyle;        // 主标题样式
  subtitle?: TextStyle;     // 副标题样式
  feature?: TextStyle;      // 功能要点样式
  brand?: TextStyle;        // 品牌名样式
}

// ====== 模板 Props（Remotion 合成器接收的参数）=====

export interface TemplateProps {
  videos: VideoClip[];
  text: PromoText;
  orientation: Orientation;
  brandColor?: string;
  /** 片段实际持续时长（秒），由 MultiSegmentPromo 传入。模板应据此缩放内部动画 */
  segmentDuration?: number;
  /** 用户自定义样式（每片段独立） */
  style?: PromoStyle;
  /** 用户自定义布局参数（每片段独立） */
  layout?: TemplateLayout;
  /** 模板个性化参数（每片段独立；键与默认值见 TemplateMeta.paramSpecs，模板按倍率语义消费） */
  params?: Record<string, number>;
  /** 视频画布特效（预览时由 wrapper 注入 Context） */
  videoEffect?: VideoEffect;
  /** 背景特效（预览时由 wrapper 注入 Context） */
  backgroundEffect?: BackgroundEffect;
  /** 该段文字入场动效（内置模板消费；缺省 = 模板默认） */
  textAnim?: TextAnimPreset;
  /** 片尾退场预设（内置模板消费；缺省 sync = 素材播到转场前一刻） */
  exitStyle?: SegmentExitStyle;
  /** 段内节拍网格（B2：BGM 拍点按段窗口切片下发；模板自愿消费——逐词踩拍/逐拍生长/入场落拍，
   *  不消费零影响。无 BGM / 未检出 beats 时为 undefined。见 shared/beat-grid.ts） */
  beatGrid?: BeatGrid;
  /** M2 回写环：物化排版字幕窗（冻结接管段的时间线侧真值；序 = plan 投影 captions 序
   *  = 模板文字槽序，CursorFollow 例 [title?, subtitle?]）。undefined = 未接管，模板走默认
   *  全程窗（零漂移）。消费逐模板开放（首批 CursorFollow）；模板对缺失槽位条目回退默认窗。 */
  planCaptionWindows?: PlanCaptionWindow[];
}

export type Orientation = 'landscape' | 'portrait';

// ====== 多段合成 Props（新的多段渲染器参数）=====

/** BGM 自动避让旁白（ducking）：旁白响起时自动压低 BGM 音量 */
export interface DuckingConfig {
  enabled: boolean;
  /** 旁白期间 BGM 音量倍率（0.1~1，0.25 = 压到 25%；1 = 不压低） */
  amount: number;
}

/** BGM 音量包络关键点（时间轴 NLE「音量线」）：sec 相对 BGM 起播点（startAtSec 锚定，
 *  拖动 BGM 块时包络随块走），volume 0..1 为相对倍率（乘在基础音量/淡入淡出/ducking 之上） */
export interface BgmVolumeKey {
  sec: number;
  volume: number;
}

/** 背景音乐音轨（项目级，贯穿整段视频） */
export interface BgmTrack {
  name: string;
  src: string;        // 本地服务器 HTTP URL
  path: string;       // 原始文件路径（用于波形分析）
  duration: number;   // 秒
  volume: number;     // 0..1
  fadeIn: number;     // 秒
  fadeOut: number;    // 秒
  peaks?: number[];   // 波形峰值 0..1（UI 画波形）
  /** 节拍时间（秒，升序；音频分析产出，卡点对齐/节拍脉冲/节拍音效共用）。旧工程无此字段时回退 detectBeats(peaks) */
  beats?: number[];
  /** 每分钟节拍数（beats 的中位间隔换算；0 = 未检出） */
  bpm?: number;
  /** 自动避让旁白配置（缺省 = 不避让） */
  ducking?: DuckingConfig;
  /** 音量包络关键点（缺省/空 = 恒 1，行为与 v1.5 前逐帧一致；时间轴 UI 拖拽编辑/AI set_bgm 可写） */
  volumeKeys?: BgmVolumeKey[];
  /** 配乐署名（内置 CC BY 曲库带出；有署名义务时渲染端自动烧录片尾署名，见 bgm-credits.ts）。本地上传/用户曲库无此字段 */
  credit?: BgmCredit;
  // ====== 时间轴定位（P2.5 阶段二 v1.5；全部可选，旧工程缺省 = 从头播到尾，行为逐帧不变）======
  /** 成片时间轴上的起播点（秒，缺省 0）：>0 时前段无音乐（如旁白先进、副歌后起）。
   *  淡入包络锚定在起播点；节拍消费方经 shared/bgm-track.ts 的映射取时间轴坐标。 */
  startAtSec?: number;
  /** 媒体截取起点（秒，缺省 0）：从素材第 N 秒开始用（掐掉前奏直接进副歌等） */
  trimStartSec?: number;
  /** 媒体截取终点（秒，缺省 = duration）：循环窗只铺 [trimStartSec, trimEndSec)，
   *  缩短循环窗让副歌段循环而不带前奏 */
  trimEndSec?: number;
}

// ====== 音效设计（SFX，项目级）======

/**
 * 音效类别：
 * whoosh 经典转场风声（擦除/圆形展开） / swish 短促滑音（滑动/推拉/甩镜） /
 * sweep 轻柔气息（淡化/模糊溶解） / drop 低频下坠（缩放/运镜/翻转，电影感） /
 * impact 节拍重音（兼闪白转场） / riser 片头品牌揭示音 / click 短促点击（库保留）
 */
export type SfxKind = 'whoosh' | 'swish' | 'sweep' | 'drop' | 'impact' | 'riser' | 'click' | 'pop' | 'ding';

/**
 * 手放音效片段（时间轴音效轨 v4）：用户在时间轴任意位置摆的音效，
 * 多个 clip 时间重叠时自动多轨混音叠加（渲染端各自独立 <Audio>）。
 */
export interface SfxClip {
  /** 稳定 id（渲染变体选择按 id 确定性哈希，导出可复现） */
  id: string;
  kind: SfxKind;
  /** 全片时间轴位置（秒，0.1 步进，钳制在 [0, 片长]） */
  atSec: number;
  /** 独立音量 0..1（再乘 SFX 轨总音量与类别响度） */
  volume: number;
}

/**
 * 音效轨道配置（项目级，随工程文件持久化；纯数据无媒体引用）。
 * 自动放置规则见 shared/sfx-plan.ts：转场中点按转场类型放匹配音效、节拍落点 impact、片头 riser。
 * clips（v4 additive）：手放音效，与自动放置互不影响、同时生效。
 */
export interface SfxConfig {
  /** 总开关（false = 完全不放音效，含 clips） */
  enabled: boolean;
  /** SFX 轨道整体音量 0..1（独立于 BGM 音量，不受旁白 ducking 影响） */
  volume: number;
  /** 转场中点自动放匹配音效（类别按转场类型映射，见 sfx-plan.TRANSITION_SFX_KIND；硬切不放） */
  transitionWhoosh: boolean;
  /** 节拍落点自动放 impact（需要 bgm.peaks 波形数据） */
  beatImpact: boolean;
  /** 片头放 riser 上升音 */
  introRiser: boolean;
  /** UI 元素音效（P6）：对话气泡 pop/打字轻点/勾选 ding 等，随模板内部时间线自动放置（缺省 = 开） */
  uiCues?: boolean;
  /** 手放音效片段（多轨叠加；时间轴「+ 音效」添加，可拖动/改类别/调音量/删除） */
  clips?: SfxClip[];
}

export const DEFAULT_SFX_CONFIG: SfxConfig = {
  enabled: true,
  volume: 0.8,
  transitionWhoosh: true,
  beatImpact: true,
  introRiser: true,
};

// ====== 全局质感层（项目级）======

/** 画面质感预设：干净 = 无叠加 / 胶片 = 轻暗角+细颗粒 / 电影 = 重暗角+颗粒+扫柔光 */
export type TexturePreset = 'clean' | 'film' | 'cinema';

/** 默认质感：胶片（轻量提升观感，可在品牌面板切回「干净」） */
export const DEFAULT_TEXTURE_PRESET: TexturePreset = 'film';

/** 节拍脉冲默认开关：有 BGM 且检出节拍时画面随鼓点微缩放/光闪。
 *  缺省关——实测观感是「画面跟着节拍抽搐/白闪」（v5 与 v1.3 样片两次实拍反馈），
 *  需要时由声音面板显式打开；长期的真卡点是剪辑层面的压拍（align_beats/剪辑大脑），不是靠画面脉冲 */
export const DEFAULT_BEAT_PULSE = false;

/** 美化光标默认开关：录屏素材带轨迹时合成平滑光标（录屏本身不含系统光标） */
export const DEFAULT_CURSOR_ENABLED = true;

export const TEXTURE_PRESET_OPTIONS: {value: TexturePreset; label: string; desc: string}[] = [
  {value: 'clean', label: '干净', desc: '无叠加，保持原始画面'},
  {value: 'film', label: '胶片', desc: '轻暗角 + 细颗粒'},
  {value: 'cinema', label: '电影', desc: '重暗角 + 颗粒 + 扫柔光'},
];

/** 渲染时传给合成器的音效源表：类别 → 各变体的可播放 URL（http 或 local-video） */
export type SfxSources = Record<SfxKind, string[]>;

// ====== 用户品牌 Logo（项目级，顶层常驻）======

export type LogoPosition = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

/** 用户 Logo 配置（项目级）。src 为会话 URL 不持久化，由 path 重建 */
export interface LogoConfig {
  src: string;          // 本地服务器 HTTP URL（不持久化）
  path: string;         // 原始图片路径（持久化 + 媒体存在性检查）
  name: string;         // 文件名
  position: LogoPosition;
  /** 尺寸：占画布宽度的比例（0.05~0.4，0.15 = 占 15% 画宽） */
  size: number;
  /** 不透明度（0~1） */
  opacity: number;
  visible: boolean;
}

export const LOGO_POSITION_OPTIONS: {value: LogoPosition; label: string; desc: string}[] = [
  {value: 'topLeft', label: '左上', desc: '画面左上角'},
  {value: 'topRight', label: '右上', desc: '画面右上角（常见）'},
  {value: 'bottomLeft', label: '左下', desc: '画面左下角'},
  {value: 'bottomRight', label: '右下', desc: '画面右下角'},
];

// ====== 边缘小字 / 免责声明（项目级，顶层常驻）======

export type FinePrintPosition = 'bottomLeft' | 'bottomCenter' | 'bottomRight';

/** 边缘小字配置（项目级）：免责声明/版权/「本片由 AI 生成」之类的常驻小字。text 空串 = 不显示 */
export interface FinePrintConfig {
  text: string;             // 支持 \n 多行
  position: FinePrintPosition;
  /** 不透明度（0~1，小字宜淡，默认 0.55） */
  opacity: number;
  /** 字号倍率（1 = 基准约画布高 1.6%） */
  sizeScale: number;
}

export const DEFAULT_FINE_PRINT: FinePrintConfig = {
  text: '',
  position: 'bottomCenter',
  opacity: 0.55,
  sizeScale: 1,
};

export const FINE_PRINT_POSITION_OPTIONS: {value: FinePrintPosition; label: string}[] = [
  {value: 'bottomLeft', label: '左下'},
  {value: 'bottomCenter', label: '底部居中'},
  {value: 'bottomRight', label: '右下'},
];

// ====== 发布准备（项目级）：封面设计 + 发布元数据 =====

/** 封面文字图层字体（值见 shared/cover-presets.ts 的 COVER_FONTS） */
export type CoverFontId = 'heavy' | 'sans' | 'serif' | 'kai' | 'mono';

/** 封面文字图层对齐方式（x 坐标是该对齐的锚点：left=左边缘 center=中心 right=右边缘） */
export type CoverTextAlign = 'left' | 'center' | 'right';

/** 封面遮罩样式（压暗所选帧的方向；none = 不压暗） */
export type CoverScrimStyle = 'bottom' | 'full' | 'left' | 'top' | 'none';

/**
 * 封面文字图层：自由拖放/缩放的独立文字块。
 * 所有坐标归一化到画布（0-1）；size/strokeWidth/depth 以 1920 宽画布为基准等比缩放。
 */
export interface CoverTextLayer {
  id: string;
  /** 预设生成的角色层（title/subtitle/tag 可被 AI 工具按名更新）；自由添加的层为 undefined */
  role?: 'title' | 'subtitle' | 'tag';
  text: string;
  font: CoverFontId;
  /** 锚点 x（按 align 语义） */
  x: number;
  /** 锚点 y（文字块垂直中心） */
  y: number;
  align: CoverTextAlign;
  /** 字号（px @1920 基准） */
  size: number;
  /** 文字颜色 */
  color: string;
  /** 描边/文字边缘颜色（'' = 无描边） */
  strokeColor: string;
  /** 描边粗细（px @1920 基准，0 = 无描边） */
  strokeWidth: number;
  /** 旋转角度（deg） */
  rotation: number;
  /** 3D 挤出深度（px @1920 基准，0 = 平面文字） */
  depth: number;
  /** 3D 挤出方向（deg，屏幕坐标 0=向右 90=向下） */
  angle: number;
  /** 3D 挤出侧面颜色 */
  sideColor: string;
  /** 被画面主体遮挡（true = 用主体 mask 挖空，文字「放」到主体后面） */
  behind: boolean;
  /** 底色条颜色（如标签 chip；'' = 无底色） */
  chipColor: string;
}

/** 封面配置（随工程保存，可反复调整后重出图） */
export interface CoverConfig {
  /** 选帧时刻（秒） */
  timeSec: number;
  /** 遮罩强度 0~1（压暗所选帧保证文字可读，默认 0.55） */
  scrim: number;
  scrimStyle: CoverScrimStyle;
  /** 导出格式（jpg 体积小适合上传；png 无损） */
  format: 'jpg' | 'png';
  /** 文字图层（≤6 层） */
  layers: CoverTextLayer[];
}

/** 发布元数据（随工程保存；发布时按平台组装文案一键复制） */
export interface PublishMetadata {
  title: string;
  description: string;
  /** 话题标签（不带 #；组装文案时按平台加 # 或逗号拼接） */
  tags: string[];
}

/** 发布准备配置（工程文件可选字段 publish） */
export interface PublishKit {
  cover: CoverConfig;
  metadata: PublishMetadata;
}

export interface MultiSegmentProps {
  segments: Segment[];
  /** 可选正式 EditPlan；渲染器可按 shot 窗口消费，缺省回退 segments。 */
  editPlan?: EditPlan;
  orientation: Orientation;
  /** 自定义模板定义列表（供 custom- 前缀的片段查表渲染） */
  customTemplates?: CustomTemplateDef[];
  /** AI 生成模板定义列表（供 gen- 前缀的片段查表渲染；受限 TSX 编译产物，见 shared/generated-template.ts） */
  generatedTemplates?: GeneratedTemplateDef[];
  /** 背景音乐 */
  bgm?: BgmTrack | null;
  /** 音效轨道配置（缺省 = 不放音效；自动放置规则见 shared/sfx-plan.ts） */
  sfx?: SfxConfig | null;
  /** 音效源表（类别 → 变体 URL 列表），由渲染端/主进程按内置库解析 */
  sfxSources?: SfxSources;
  /** 全局质感预设（缺省 = clean 不叠加；参数表见 shared/texture-presets.ts） */
  texture?: TexturePreset;
  /** 节拍脉冲：BGM 鼓点上画面微缩放 + 光效闪动（缺省 = DEFAULT_BEAT_PULSE；无 BGM/无节拍时自动不生效） */
  beatPulse?: boolean;
  /** 美化光标：录屏素材上叠加平滑轨迹光标 + 光晕（缺省 = DEFAULT_CURSOR_ENABLED；素材无轨迹时自动不渲染） */
  cursor?: boolean;
  /** 用户品牌 Logo（项目级，顶层常驻） */
  logo?: LogoConfig | null;
  /** 字幕样式（项目级，所有段共用） */
  captionStyle?: CaptionStyle;
  /** 边缘小字/免责声明（项目级，顶层常驻；text 空串 = 不显示） */
  finePrint?: FinePrintConfig | null;
  /** 色彩统一（项目级）：色调风格预设 + 自动曝光匹配（见 shared/color-grade.ts） */
  colorGrade?: ColorGrade | null;
  /** 品牌色（项目级，#rrggbb；null/缺省 = 默认蓝）。模板强调色经 designTokens 主题取此色 */
  brandColor?: string | null;
  /** 字体氛围预设（项目级；缺省 = sleek 商业冷峻）。标题/正文/等宽字体栈随之切换 */
  fontMood?: FontMoodId;
  /** 预览轻量硬切：仅整片预览（Player）传 true——转场窗口内上下段不做转场样式、出段直接不渲染，
   *  同一时刻只有一段视频在解码，消除双解码卡顿。渲染导出路径不传该字段，成片转场完全不受影响。 */
  previewLiteCut?: boolean;
  /**
   * 授权标记：false 时整片叠加水印（免费版）。缺省视为 true（不加水印）。
   * 渲染时由主进程 RENDER_START 门禁强制覆写，渲染进程传入的值不生效。
   */
  licensed?: boolean;
}

// ====== 模板注册表 ======

/**
 * 叙事槽位（模板在成片叙事结构中的角色）：
 * AI 选模板按槽位分层检索（系统提示词只放槽位地图，完整候选用 get_templates(slot=…) 查），
 * 避免长模板清单撑爆上下文、选择质量下降。见 shared/template-slots.ts。
 */
export type TemplateSlot = 'hook' | 'showcase' | 'media' | 'data' | 'proof' | 'story' | 'cta';

/**
 * 模板目录的视觉风格标签。标签是推荐/检索元数据，不限制模板实际使用。
 */
export type TemplateStyle =
  | 'minimal' | 'cinematic' | 'editorial' | 'tech'
  | 'warm' | 'bold' | 'playful' | 'documentary';

/** 模板的主要画面动作标签，用于按镜头意图检索少量候选。 */
export type TemplateAction =
  | 'static' | 'reveal' | 'slide' | 'zoom' | 'pan'
  | 'split' | 'compare' | 'list' | 'count'
  | 'timeline' | 'type' | 'cursor' | 'montage';

// ====== T3 转场锚点（形状接形状）======

/**
 * 模板画面中的转场锚点形状（屏幕画框/设备壳/终端窗等天然矩形元素）。
 * zoomIn/zoomOut 出入段时镜头精确飞到锚点包围盒盖满画布（cover 拟合，
 * 数学在 shared/transition-anchor.ts）；两段锚点形状匹配时观感 = 无缝穿越。
 * 坐标全部归一化（0-1 相对画布）；声明基于模板默认 layout/参数，用户大改
 * layout 后为近似值（与运镜自动焦点同精度）。
 */
export interface TransitionAnchor {
  /** 锚点形状：rect 圆角矩形（屏幕画框/终端窗）/ circle 圆（logo 等）——v1 拟合按包围盒 */
  shape: 'rect' | 'circle';
  /** 包围盒宽/高（归一化：占画布宽/高的比例；circle 用 w=h=直径比例） */
  w: number;
  h: number;
  /** 基准中心（归一化；followLayout 时运行时叠加该段 layout.videoOffsetX/Y） */
  cx: number;
  cy: number;
  /** 是否跟随 layout 偏移（缺省 true；画框位置固定的模板设 false） */
  followLayout?: boolean;
}

export interface TemplateMeta {
  id: string;
  name: string;
  description: string;
  thumbnail: string;
  minVideos: number;
  maxVideos: number;
  defaultDuration: number;  // 默认时长（秒）
  supportsPortrait: boolean;
  /** 模板个性化参数规格（故事板「参数」页据此渲染滑块；缺省 = 该模板无可调参数） */
  paramSpecs?: TemplateParamSpec[];
  /** 竖屏缺省参数覆盖（管线路线图 P0-1「竖屏一等公民」）：横版调好的参数到竖画布会坏，
   *  每模板把验收过的竖屏配方收在这里，故事板派生 deriveBoard(portrait) 时叠加在段参数之上。
   *  只收有渲染验收出处的值（见 docs/template-portrait-spec.md），没有 = 该模板竖屏无需覆盖。 */
  portraitParams?: Record<string, number>;
  /** 模板真正会渲染的 text.* 字段（title/subtitle/features/brandName 子集；缺省 = 自定义/生成模板未标注，不做提示）。
   *  由 llm-tools 校验器给「设置了不会显示的字段」的调用方发 notes，避免文案静默不显示的坑。 */
  textSlots?: string[];
  /** 模板制作指导声明（timeline-master-plan M1 首批；src/shared/template-plan.ts）：
   *  声明本模板哪些内部结构可物化为时间线原语（白名单——未声明被投射=报错）。
   *  缺省 = 未入 M1 影子对拍批次（无 plan 投影，get_timeline 无 plan 摘要键）。 */
  plan?: TemplatePlanSchema;
  /** 叙事槽位（1-2 个，首个为主槽位；缺省 = 未分槽，只出现在 get_templates 无槽位过滤的全量清单里） */
  slots?: TemplateSlot[];
  /** 视觉风格标签（用于模板目录检索；缺省时由目录 taxonomy 推断）。 */
  styles?: TemplateStyle[];
  /** 主要画面动作标签（用于按镜头动作检索；缺省时由目录 taxonomy 推断）。 */
  actions?: TemplateAction[];
  /** 主题/素材/画面意图检索词。 */
  searchTags?: string[];
  /**
   * 入场净运动朝向（运动连续性元数据）：内容入场/驻留期间的主要运动方向；
   * 'none' = 原地/无方向（缩放、淡入、汇聚等）。被 customParams.direction（>0）覆盖——
   * 显式设了飞入方向时以参数为准（见 shared/motion-chain.ts）。
   */
  enterMotion?: MotionDir;
  /** 出场/段尾净运动朝向（链式转场按它保持运动方向不间断；缺省 'none'） */
  exitMotion?: MotionDir;
  /** 建段时的默认 layout 覆盖（缺省 = DEFAULT_LAYOUT；全屏画幅类模板用来避免转场焦点错位） */
  defaultLayout?: Partial<TemplateLayout>;
  /** T3 转场锚点：画面中天然的屏幕画框/设备壳（zoomIn/zoomOut 镜头精确飞到锚点形状，
   *  两段锚点匹配 = 形状接形状的无缝穿越；缺省 = 无锚点，走 layout 自动焦点） */
  transitionAnchor?: TransitionAnchor;
  /** 使用说明（故事板模板选择器旁的 ⓘ 提示与「参数」页展示；写 description 没讲清的用法/前提） */
  usageTip?: string;
  /**
   * 专属体裁（缺省 = 通用模板，任何体裁都推荐）：仅列出的体裁在 get_templates
   * 体裁过滤时可见（如定价档位/客户证言只出现在 promo）。只影响 AI 推荐口径，
   * 不限制实际选用。见 shared/video-type.ts。
   */
  videoTypes?: VideoType[];
  component?: React.ComponentType<TemplateProps>;  // 运行时由注册表填充
}

// ====== 渲染导出设置 ======

/** H.264 编码器预设（速度越快质量越低、文件越大） */
export type X264Preset =
  | 'ultrafast'
  | 'superfast'
  | 'veryfast'
  | 'faster'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'slower'
  | 'veryslow';

/**
 * H.264 编码器选择（仅 MP4 输出生效；mov/webm 始终软件编码）
 * auto = 自动探测（NVENC → QSV → 软件 x264）；硬件编码经 ffmpegOverride 改写
 * Remotion stitcher 参数实现（见 services/encoderOverride.ts）
 */
export type RenderEncoder = 'auto' | 'nvenc' | 'qsv' | 'software';

/** 实际用于渲染的编码器（auto 已解析） */
export type RenderEncoderUsed = Exclude<RenderEncoder, 'auto'>;

/**
 * 输出格式（映射到 Remotion codec + 容器组合，见 services/renderer.ts FORMAT_MAP）
 * - mp4：H.264/AAC（兼容性最好）
 * - mp4-hevc：H.265(HEVC)/AAC（同质量约一半体积，老设备/老播放器兼容性差）
 * - mov：ProRes/PCM（剪辑软件中间格式，体积大）
 * - webm：VP9（网页开源格式）
 * - gif：GIF 动图（无音频、不支持 CRF，体积大，适合短片段预览）
 */
export type RenderFormat = 'mp4' | 'mp4-hevc' | 'mov' | 'webm' | 'gif';

/** 完整的渲染导出选项 */
export interface RenderOptions {
  format: RenderFormat;               // 输出格式
  crf: number;                         // 质量 18-30（越低越好）
  scale: number;                       // 分辨率缩放 0.5 | 1 | 1.5 | 2（1080 基准下 2 = 4K 2160p）
  muted: boolean;                      // 不包含音频
  filename: string;                    // 输出文件名（不含扩展名）
  x264Preset: X264Preset;             // H.264 编码速度
  encoder: RenderEncoder;             // 编码器（仅 MP4/H.264 生效）
  overwrite: boolean;                  // 覆盖已存在文件
  /** 响度归一化到 -14 LUFS（社交/流媒体投放标准；GIF/静音导出自动跳过） */
  loudnorm: boolean;
  /**
   * 段级渲染缓存（局部重渲）：≥3 段的故事板按段分块渲染并缓存到磁盘，
   * 改一段只重渲该段及邻段，其余块直接拼接（审片迭代提速数倍）。
   * GIF/WebM 不适用（GIF 无拼接收益，WebM/Opus 块边界样本语义未实证）；
   * 块渲染失败自动回退整片单渲。
   */
  segmentCache: boolean;
  /**
   * 强制重渲段（一次性参数，不持久化）：这些段及其相邻段的缓存块跳过命中直接重渲
   * （「重渲此段」右键入口用——怀疑缓存脏/模板代码热更未 bump 版本时精确失效）。
   * 不在 DEFAULT_RENDER_OPTIONS 里：仅经渲染 overrides 传入。
   */
  forceSegments?: number[];
  /**
   * 段预览帧范围（一次性参数，不持久化）：只渲该绝对帧窗（含段转场垫帧），
   * 用于单段试渲/变体并渲（RENDER_SEGMENT / RENDER_SEGMENT_VARIANTS）。
   * Remotion renderMedia frameRange=[start,end] 闭区间；segments 不裁剪
   * （转场骑跨切点，裁段丢上下文）。与 segmentCache 互斥：预览恒走整片单渲路径。
   * 不在 DEFAULT_RENDER_OPTIONS 里：仅经渲染 overrides 传入。
   */
  previewFrameRange?: [number, number];
}

/** 默认渲染设置 */
export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  format: 'mp4',
  crf: 23,
  scale: 1,
  muted: false,
  filename: '',  // 空 = 渲染时自动生成 promo-<时间戳>，避免多次渲染互相覆盖
  x264Preset: 'medium',
  encoder: 'auto',
  overwrite: true,
  loudnorm: true,
  segmentCache: true,
};

/**
 * 最近一次渲染的结果回读（渲染进程内存态，不随工程持久化）。
 * fingerprint = 发起渲染那一刻的内容指纹（见 shared/content-fingerprint.ts），
 * 与当前内容指纹比对即可知道「成片是不是刚改完的版本」。
 */
export interface LastRenderInfo {
  outputPath: string;
  /** 完成时刻（ISO 字符串） */
  finishedAt: string;
  /** 渲染耗时（秒，发起 → 完成的墙钟） */
  durationSec: number;
  segmentCount: number;
  /** 发起渲染那一刻的内容指纹（确认卡流程 = 用户点确认那一刻） */
  fingerprint: string;
  /** 段级渲染缓存命中（渲染管线有块缓存统计时才有） */
  cacheStats?: {hit: number; total: number};
}

// ====== 渲染任务 ======

/** 多段渲染任务 */
export interface MultiSegmentRenderJob {
  compositionId: string;
  inputProps: MultiSegmentProps;
  outputLocation: string;
  renderOptions: RenderOptions;
}

/** 渲染任务 */
export type RenderJob = MultiSegmentRenderJob;

/** 渲染进度 */
export interface RenderProgress {
  progress: number;         // 0-100
  frame: number;
  totalFrames: number;
}

// ====== 应用配置 ======

export interface AppConfig {
  outputDir: string;        // 默认输出目录
}

// ====== 授权 / 订阅 ======

/** 授权权益等级：licensed=已授权（无水印、不限分辨率），free=免费版（水印 + 分辨率受限） */
export type LicenseEntitlement = 'licensed' | 'free';

/** 授权状态（主进程 getLicenseStatus 返回，供渲染进程 UI 展示） */
export interface LicenseStatus {
  entitlement: LicenseEntitlement;
  /** 套餐标识（monthly/yearly/lifetime，未激活为 null） */
  plan: string | null;
  /** 到期时间（epoch ms，未激活为 null） */
  expiresAt: number | null;
  /** 剩余天数（未激活为 null） */
  daysLeft: number | null;
  /** 离线宽限剩余天数（超过后降级为免费版；未激活为 null） */
  offlineDaysLeft: number | null;
  /** 该授权码已激活的机器数（激活时由服务器返回，可能为 null） */
  machinesUsed: number | null;
  /** 该授权码的机位上限（激活时由服务器返回；老本地记录/老服务端可能缺省为 null） */
  maxMachines: number | null;
  /** 掩码后的授权码（形如 XXXX-****-****-XXXX，未激活为 null） */
  code: string | null;
}

/** 激活结果（错误码与服务器约定一致：INVALID_CODE / MACHINE_LIMIT / REVOKED / EXPIRED 等） */
export interface LicenseActivateResult {
  success: boolean;
  plan?: string;
  expiresAt?: number;
  error?: string;
  message?: string;
}

// ====== 自动更新（NSIS 直链版走 electron-updater 全自动；商店版仅版本检查+跳转商店）======

/** 手动检查更新结果（update:check 返回） */
export interface UpdateCheckResult {
  /** none=已是最新；available=发现新版本（NSIS 已开始后台下载；商店版待用户跳转商店更新）；downloaded=已下载待重启安装；error=检查失败 */
  status: 'none' | 'available' | 'downloaded' | 'error';
  /** 新版本号（status 为 available/downloaded 时给出） */
  version?: string;
  /** 附加说明（主要是 error 时的失败原因） */
  message?: string;
}

/** 更新状态推送事件（update:status，主进程 -> 渲染进程） */
export interface UpdateStatusEvent {
  status: 'available' | 'downloading' | 'downloaded' | 'error';
  /** 新版本号（available/downloaded 时给出） */
  version?: string;
  /** 下载进度百分比（downloading 时给出，0~100） */
  percent?: number;
  /** error 时的失败原因 */
  message?: string;
}
