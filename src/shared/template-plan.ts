/**
 * 模板制作指导声明 TemplatePlanSchema v0（timeline-master-plan M1 影子对拍首批）
 *
 * 定位（总纲 §一/§二.7）：模板通过声明式 plan 投射成时间线原语；物化投影函数
 * （plan-projection.ts）与渲染端消费同一份推导代码（template-keyframes 三规划器
 * 同款纪律——静态推导、同源注释、单测锚定）。本文件只声明「哪些可物化」（白名单），
 * 实例值（节拍时刻/字幕窗）由投影纯函数按段推导。
 *
 * 白名单纪律（checkpoints 同款）：未声明 `materializable` 的字段被投射 = 报错
 * （projection 层 guard + 单测锚定）。首批三字段：
 * - captions     模板自身排版的文字（标题/卡片字/段落）→ 字幕轨行
 * - mediaWindows 段内素材槽（trim 窗）→ 视频轨段块
 * - beats        段内节拍（点击/卡驻留/段落弹出）→ 段内标记
 * （audioCues/bgmDuck 留 M2+ 开放，届时本枚举只增不改。）
 */

/** 可物化字段（枚举只增不改——agent 契约 §7 同款纪律） */
export type PlanMaterializableField = 'captions' | 'mediaWindows' | 'beats';

/** 节拍推导器键（plan-projection 按模板分发；声明式定位用，非执行句柄） */
export type PlanBeatsDeriver = 'cursorClicks' | 'cardDwell' | 'docTimeline';

export interface TemplatePlanSchema {
  /** 可物化字段白名单（空 = 模板未开放物化，只有 plan 摘要无投影） */
  materializable: PlanMaterializableField[];
  /** beats 推导器（materializable 含 beats 时必填） */
  beatsDeriver?: PlanBeatsDeriver;
  /** 冻结策略（M2 回写环生效；v0 缺省 perEdit=编辑即冻结） */
  freezePolicy?: 'perEdit' | 'never';
}
