/**
 * 模板观感预设（Preset 层）——「返工结果固化」（2026-10-11 随变临摹 v1-v9 实战收敛）
 *
 * 每个预设 = 一段观感语言的参数包。AI 和用户选预设，而不是面对二十个裸旋钮；
 * 装配侧：`presetParams('WhiteboardCanvas', 'pan-scan')` 得到参数包，可再覆盖单项。
 *
 * 来源标注 source：好值都是「渲染→抽帧→判读→再调」收敛出来的，标明出自哪轮实战，
 * 后续调参者知道这些数不是拍脑袋值、值域有多窄（如 PanelFlyout flyAmp 1.0 悬半空 /
 * 1.6 出画外，只有 1.2 落在「错位悬停」的窄带里）。
 */

export interface TemplatePreset {
  id: string;
  label: string;
  /** 观感描述 + 适用场景——选型的依据 */
  description: string;
  params: Record<string, number>;
  /** 收敛来源（实战轮次），提示这些值是窄带好值不是随手默认 */
  source: string;
}

export const TEMPLATE_PRESETS: Record<string, TemplatePreset[]> = {
  CursorFollow: [
    {
      id: 'glow-stage',
      label: '辉光展台·官方实录',
      description: '官方宣传片实录语言：辉光窗口卡+3D 倾斜入场+聚焦蒙版+满格收框+点击放大 1.8/停留 1.2（正片 REC_BASE 固化）。smoothCursor 关：v8.1 实证重定时拆两套时间基准，真实实录必关。竖屏派生（deriveBoard portrait）会自动叠加 registry portraitParams 四参数，直接写竖屏用 glow-stage-portrait。',
      params: {
        stageBg: 2, stagePalette: 0, stageCard: 2, cardFill: 0.9,
        tiltPersp: 1200, tiltIntro: 1, smoothCursor: 0,
        focusDimOn: 1, focusRecenter: 1,
        clickZoom: 1.8, clickHold: 1.2, showCursor: 1,
      },
      source: 'v9 官方实录全参数 → v11 正片 REC_BASE（781be58→d942ace）',
    },
    {
      id: 'glow-stage-portrait',
      label: '辉光展台·官方竖屏',
      description: '官方实录语言的竖屏直写档 = glow-stage + 竖屏配方：卡宽拉满 0.96、卡内光标居中 55% 裁切窗、舞台=录屏自身 blur 环境虚化（留边与内容永远同色）、色板自动取色。治竖屏「画中画太小/超出鼠标/背景色不一致」三连。',
      params: {
        stageBg: 2, stagePalette: 8, stageCard: 2, cardFill: 0.96,
        viewSpan: 0.55, stageAmbient: 1,
        tiltPersp: 1200, tiltIntro: 1, smoothCursor: 0,
        focusDimOn: 1, focusRecenter: 1,
        clickZoom: 1.8, clickHold: 1.2, showCursor: 1,
      },
      source: 'v9-vertical 验收配方 → v11 竖版（d942ace）＝glow-stage + registry portraitParams',
    },
    {
      id: 'deep-stage',
      label: '深空展台·跟随',
      description: '深空蓝渐变舞台+圆角窗口卡，平面正面运镜（无 3D 倾斜），点击放大 1.6 轻推，垂直引导预留前进空间。宣传片录屏展示的通用底盘。',
      params: {
        stageBg: 2, stagePalette: 0, stageCard: 1, cardFill: 0.9,
        tiltX: 0, tiltY: 0, tiltZ: 0, tiltIntro: 0, cursorLean: 0,
        clickZoomOn: 1, clickZoom: 1.6, clickHold: 1.0, clickRipple: 1,
        focusDimOn: 0, smoothCursor: 0, showCursor: 1, focusLead: 2,
      },
      source: 'v4-v9 深蓝版全部录屏段（SU_REC）',
    },
    {
      id: 'deep-stage-pop',
      label: '深空展台·聚焦浮出',
      description: '在深空展台上点击放大时全屏虚化副本+清晰区上浮为独立卡层（B1），卡片特写镜头。放大 1.8/停留 0.9 为收敛窄带。',
      params: {
        stageBg: 2, stagePalette: 0, stageCard: 1, cardFill: 0.9,
        tiltX: 0, tiltY: 0, tiltZ: 0, tiltIntro: 0, cursorLean: 0,
        clickZoomOn: 1, clickZoom: 1.8, clickHold: 0.9, clickRipple: 1,
        focusDimOn: 1, focusDimBlur: 7, focusDimDark: 0.22, focusDimTarget: 1, focusPop: 1,
        smoothCursor: 0, showCursor: 1, focusLead: 2,
      },
      source: 'v2/v4 seg-8 卡片特写实测',
    },
    {
      id: 'cream-stage',
      label: '奶油展台·跟随',
      description: '奶油浅色舞台档（描边自适应深描边），浅色品牌片用。其余同深空展台。',
      params: {
        stageBg: 2, stagePalette: 8, stageCard: 1, cardFill: 0.9,
        tiltX: 0, tiltY: 0, tiltZ: 0, tiltIntro: 0, cursorLean: 0,
        clickZoomOn: 1, clickZoom: 1.6, clickHold: 1.0, clickRipple: 1,
        focusDimOn: 0, smoothCursor: 0, showCursor: 1, focusLead: 2,
      },
      source: 'v2/v3 浅色临摹版（stagePalette 双参数坑已验）',
    },
  ],

  PanelFlyout: [
    {
      id: 'offset-hover',
      label: '错位悬停',
      description: 'UI 区域卡从主界面剥离错位悬在画内（不飞出画外），主界面只压暗不虚化保持清晰——随变「从后面飞出来」的正解。flyAmp 窄带 1.0-1.4，1.6 全出画=动作消失。',
      params: {flyAt: 0.15, flyStagger: 0.3, flyAmp: 1.2, dim: 0.38, blurBg: 0},
      source: 'v6 复盘（1.0 悬半空）→v7 复盘（1.6 出画+虚化主界面）收敛',
    },
    {
      id: 'deep-reveal',
      label: '沉底揭幕',
      description: '区域卡大幅飞出让位、底层压暗+微虚化聚焦标题条——转场感更强的对比档。',
      params: {flyAt: 0.15, flyStagger: 0.3, flyAmp: 1.6, dim: 0.45, blurBg: 1},
      source: 'v6 中间档（主界面让位更彻底的场景）',
    },
  ],

  WhiteboardCanvas: [
    {
      id: 'pan-scan',
      label: '平面移动扫卡',
      description: '全程恒定 1.3× 展台档纯平移（无往复缩放），仅首卡进场一次推近、尾段拉远收全貌——多卡（6-9）防晕防频闪首选。卡内素材不放大（双重放大过晕）。',
      params: {panMode: 1, zoomIn: 1.3, contentZoom: 0, pullBack: 1, cardPop: 1},
      source: 'v8 复盘（缩放循环晕）→v9 拱形回落→v11 恒定放大纯平移（九卡频闪复盘 1b0fbf1 后再收敛）',
    },
    {
      id: 'zoom-tour',
      label: '缩放巡览',
      description: '移动段平滑缩回全景+驻留推近 1.45 的巡览节奏——卡少（≤4）且卡面文字大时用。',
      params: {panMode: 0, zoomIn: 1.45, contentZoom: 0, pullBack: 1, cardPop: 1},
      source: 'v4/v5 连续性修复后的原版节奏',
    },
  ],

  ChatConversation: [
    {
      id: 'live-chat',
      label: '真实对话·全特性',
      description: '头像对+组首时间戳+✓✓已读+同侧连发分组+侧滑入全开，节奏 1.2 防段间停顿——深色宣传片对话段首选。',
      params: {pace: 1.2, typing: 1, userColor: 0, widthScale: 0.66, badge: 1, bgStyle: 0, avatar: 1, meta: 1, group: 1},
      source: 'v7 节奏收敛 + 气泡升级（dadcaa5）新特性',
    },
    {
      id: 'classic-chat',
      label: '经典气泡',
      description: '升级特性全关≈旧形态：无头像/无时间戳/不分组，纯气泡流。简洁场景用。',
      params: {pace: 1, typing: 1, userColor: 0, widthScale: 0.66, badge: 1, bgStyle: 0, avatar: 0, meta: 0, group: 0},
      source: 'dadcaa5 的兼容档（三参数全关≈旧形态）',
    },
  ],

  DocPanel: [
    {
      id: 'script-doc',
      label: '分镜脚本文档',
      description: 'macOS 窗口条+段落右滑入倾斜+[[选区]]呼吸+img 占位格——文档/脚本展示的实战形态。',
      params: {pace: 1, selectPulse: 1, toolBar: 1},
      source: 'v5 段落动效 + v7 倾斜幅度收敛',
    },
  ],

  KineticType: [
    {
      id: 'chapter-shine',
      label: '章节卡·退场扫光',
      description: '大字章节卡+退场照亮扫光（扫光带颜色按字色亮度自适应）。浅底配深字/深底配浅字均可，深字白带、浅字蓝带自动。',
      params: {typeScale: 1.05, exitFx: 1},
      source: 'v4 退场扫光 + v5 扫光带自适应',
    },
  ],

  AiPromptCard: [
    {
      id: 'prompt-deep',
      label: '深色提示卡',
      description: '纯黑底输入框+打字机+思考三点+回车脉冲。深色宣传片开场钩子。',
      params: {bgStyle: 2, typeSpeed: 13, enterAt: 0.5, glow: 1.2, caret: 1, resultCard: 0, thinking: 1},
      source: 'v4/v7 开场段收敛',
    },
  ],
};

/** 取预设参数包（模板 id 或预设 id 不存在时抛错——装配期就该炸，不要静默空参） */
export const presetParams = (templateId: string, presetId: string): Record<string, number> => {
  const presets = TEMPLATE_PRESETS[templateId];
  if (!presets) throw new Error(`preset: 模板 ${templateId} 无预设`);
  const hit = presets.find((p) => p.id === presetId);
  if (!hit) throw new Error(`preset: 模板 ${templateId} 无预设 ${presetId}（可选：${presets.map((p) => p.id).join('/')}）`);
  return {...hit.params};
};
