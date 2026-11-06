/**
 * 观感词表→参数映射（质量路线图第五层·产品侧地基）
 *
 * roadmap：v1→v9 每轮「用户反馈 diff→参数 diff」就是标注数据——本文件把十轮实战的
 * 反馈→处方对固成规则表（纯函数），反馈口语命中 cue 即返回参数处方。
 *
 * 与模型线的分工（合流形态）：多模态模型看画面找毛病（review_render / Omni 线），
 * 本表把毛病翻成参数——模型/装配者拿处方可直接改 customParams 或选预设。
 *
 * 纪律（与 checkpoints/keyframes 同）：每条规则的处方值必须来自实战收敛（source 注明
 * 出处轮次），没有收敛依据的观感词不入表（如「更高级→降饱和」——工程无对应参数且
 * 无收敛值，不收）；处方只建议不自动应用（误命中改坏参数的风险由人/模型确认消化）。
 */

export interface AestheticRule {
  id: string;
  /** 触发词：反馈文本包含任一即命中（中文口语，收纳时用当时的原话） */
  cues: string[];
  /** 处方限定模板（观感语言是模板族的，跨模板不通用） */
  templateId: string;
  /** 参数处方（customParams 键值包，与 presetParams 返回同构可直接覆盖） */
  patch: Record<string, number>;
  /** 口头处方（无参数对应的建议，如换转场/掐前奏） */
  advice?: string;
  /** M3 L2：时间线原语操作处方（总纲 M3「观感反馈落到 L2 操作」——「字幕太早」→字幕行移动、
   *  「太晃/太赶」→节拍标记删除）。声明式建议：人/模型经既有 agent 工具面执行，
   *  只建议不自动应用（与 patch 同纪律）。 */
  ops?: AestheticOp[];
  /** 溯源预设（处方与某命名预设同核时标注，选型可走预设入口） */
  presetId?: string;
  /** 收敛出处（哪轮实战/复盘）——词表数据资产的可信度凭证 */
  source: string;
}

/** M3 L2 时间线操作处方：tool = 既有 agent 面工具名（无新工具）；action 含人话动作与
 *  相对量语义（如「整体 +0.3s」「删一半 accent 优先保留」），消费方按段当前状态求值。 */
export interface AestheticOp {
  tool: string;
  action: string;
}

export const AESTHETIC_RULES: AestheticRule[] = [
  // ====== WhiteboardCanvas ======
  {
    id: 'whiteboard-dizzy',
    cues: ['晕', '眼花', '头晕', '晃得', '眩晕'],
    templateId: 'WhiteboardCanvas',
    patch: {panMode: 1, contentZoom: 0},
    source: 'v8 复盘（缩放循环晕→平移为主）+ v7 复盘（相机推近×卡内放大双重叠加晕）',
  },
  // ====== PanelFlyout ======
  {
    id: 'flyout-amp-band',
    cues: ['飞出画外', '飞没了', '看不到飞', '动作消失', '悬半空', '飞一半', '拆层感弱'],
    templateId: 'PanelFlyout',
    patch: {flyAmp: 1.2},
    presetId: 'offset-hover',
    source: 'v6 复盘（1.0 悬半空）→ v7 复盘（1.6 出画=动作不可见）收敛窄带 1.0-1.4',
  },
  {
    id: 'flyout-blur-bg',
    cues: ['主界面看不清', '底层太糊', '界面糊了', '主画面糊'],
    templateId: 'PanelFlyout',
    patch: {blurBg: 0},
    presetId: 'offset-hover',
    source: 'v5 复盘（主界面保持清晰=随变语言）+ v7（虚化主界面丢可读性）',
  },
  {
    id: 'flyout-layers-flat',
    cues: ['分层看不出来', '层次不清', '分不清层', '分不开'],
    templateId: 'PanelFlyout',
    patch: {dim: 0.45},
    source: 'checkpoints flyout-dim-blur-flat 姊妹（dim<0.3 且不模糊=明暗不分）',
  },
  // ====== CursorFollow ======
  {
    id: 'cursor-card-small',
    cues: ['画中画太小', '卡太小', '窗口太小', '画面太小'],
    templateId: 'CursorFollow',
    patch: {cardFill: 0.96},
    source: 'v8 竖版反馈「画中画太小」→ cardFill 竖版拉到 0.96',
  },
  {
    id: 'cursor-bg-mismatch',
    cues: ['背景色不一致', '背景突兀', '底色不搭', '背景割裂'],
    templateId: 'CursorFollow',
    patch: {stageAmbient: 1},
    source: 'v8 竖版反馈「背景色不一致」→ 舞台环境虚化（背景=录屏自身 blur 永远同色）',
  },
  {
    id: 'cursor-partial-zoom',
    cues: ['只放大一块', '方框跟着鼠标', '局部放大奇怪', '放大到一部分'],
    templateId: 'CursorFollow',
    patch: {viewSpan: 0.5},
    source: 'v9 竖版反馈「放大到一部分、方框跟随鼠标」→ 可视跨度（跟随裁切窗）',
  },
  {
    id: 'cursor-timing-desync',
    cues: ['光标和动作对不上', '光标时快时慢', '光标节奏怪', '光标超前', '光标滞后'],
    templateId: 'CursorFollow',
    patch: {smoothCursor: 0},
    source: 'v8.1/v9 三大实证之一：smoothCursor 重定时拆两套时间基准，真实实录必关',
  },
  // ====== ChatConversation ======
  {
    id: 'chat-too-wide',
    cues: ['气泡太宽', '占太满', '不像对话', '没有对话感'],
    templateId: 'ChatConversation',
    patch: {widthScale: 0.62},
    source: 'checkpoints chat-too-wide 姊妹 + P1 设计（对话感=左右往复的窄列）',
  },
  // ====== 全局口头处方（无参数对应的建议） ======
  {
    id: 'bgm-intro-slow',
    cues: ['前奏长', 'BGM 进得慢', '音乐开头拖'],
    templateId: '*',
    patch: {},
    advice: 'BGM 掐前奏直进主体（流水线已默认 suggestBgmTrimStartSec；旧工程手动设 bgm.trimStartSec）',
    source: 'W3 J-cut 默认化（波形能量进点掐前奏）',
  },
  {
    id: 'transition-hard-cut',
    cues: ['切得硬', '转场跳', '衔接生硬'],
    templateId: '*',
    patch: {},
    advice: '把该段转场换成 velocityPush（同向运动接同向运动，切点速度连续）；无运动源的两段用 crossfade',
    source: 'W2 velocity-matched 转场（scene 检测实证：硬切 0.463 → velocityPush 0.021）',
  },
  // ====== M3 L2 时间线操作处方（timeline-master-plan M3 定稿映射首批；总纲即出处） ======
  {
    id: 'l2-caption-early',
    cues: ['字幕太早', '字幕出得早', '字幕出现早了', '字出早了'],
    templateId: '*',
    patch: {},
    ops: [{tool: 'set_segment_captions', action: '该段全部字幕行 startSec/endSec 各 +0.3s（先 get_timeline 读现值再整体平移写回；钳制不出段）'}],
    source: 'timeline-master-plan M3 定稿映射（「字幕太早」→字幕行移动）',
  },
  {
    id: 'l2-caption-late',
    cues: ['字幕太晚', '字幕出得慢', '字幕跟不上'],
    templateId: '*',
    patch: {},
    ops: [{tool: 'set_segment_captions', action: '该段全部字幕行 startSec/endSec 各 −0.3s（钳制不早于 0、不晚于段长）'}],
    source: 'timeline-master-plan M3 定稿映射（早晚对偶）',
  },
  {
    id: 'l2-beat-dense',
    cues: ['节奏太赶', '太赶了', '踩拍太密', '节拍太密', '晃得慌'],
    templateId: '*',
    patch: {},
    ops: [{tool: 'set_segment_beats', action: '删掉约一半节拍标记（间隔加倍；accent 重拍优先保留）——踩拍类模板的逐行/逐拍动效密度随标记数下降'}],
    advice: '若毛病在模板运镜（非踩拍密度），另见对应模板的参数处方（如 whiteboard-dizzy）',
    source: 'timeline-master-plan M3 定稿映射（「太晃」→节拍标记删除）',
  },
  {
    id: 'l2-beat-sparse',
    cues: ['节奏太平', '太平了', '没有节奏感', '不踩拍', '节奏感弱'],
    templateId: '*',
    patch: {},
    ops: [{tool: 'set_segment_beats', action: '每 ~1s 补一个 mark（有 BGM 时优先对齐拍点：get_timeline.bgm + align_beats 自动对齐；重点时刻用 accent）'}],
    source: 'timeline-master-plan M3 定稿映射（v1.4 节拍层对偶）',
  },
];

/**
 * 反馈文本 → 命中处方。templateId 给定时只返回该模板与全局（'*'）条目——
 * 装配者/模型按段模板过滤后再消化；不给时返回全部命中（全片反馈场景）。
 */
export const lookupAestheticPatch = (feedback: string, templateId?: string): AestheticRule[] => {
  const text = feedback ?? '';
  if (!text.trim()) return [];
  return AESTHETIC_RULES.filter(
    (r) => (!templateId || r.templateId === templateId || r.templateId === '*') &&
      r.cues.some((cue) => text.includes(cue)),
  );
};
