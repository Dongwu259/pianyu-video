/**
 * edge-router.ts — 双模型分工路由（规则版）。
 *
 * 双模型架构（docs/transition-timeline-roadmap.md §双模型分工 / §v4 编辑模型专训方案）：
 * 创作模型（v2 系）管「从空工程做一支片子」，编辑模型（v4 系）管「在已有工程上改」。
 * 两端训练分布各自收窄是这套架构的前提（v3 实验证明混训两头都坏）。
 *
 * 分错的代价不对称：把编辑需求路由给创作模型，可能触发整板重建清素材（破坏性）；
 * 反向只是做得笨。所以规则向编辑侧兜底。路由器只分大类，不做意图理解——
 * 后续可换成小分类器，接口（输入/输出）不变。
 */
export interface EdgeRouterInput {
  /** 本轮用户消息原文 */
  userText: string;
  /** 当前工程段数（0 = 空工程） */
  segmentCount: number;
  /** 默认模型（设置主模型，通常为创作模型） */
  defaultModel: string;
  /** 编辑模型（双模型第二路；空 = 路由关闭，全部走默认） */
  editModel?: string;
}

export interface EdgeRouteResult {
  model: string;
  intent: 'create' | 'edit';
  reason: string;
}

/** 强创作信号：做一支/来一条/重新做/从头来（含片/版/段变体） */
const CREATE_RE = /(做|来|生成|产出|拍|剪|重)一(支|部|条|段|版|个)|帮我做|新建|重新做|从头|从零/;
/** 编辑信号：改动动词 + 视频要素词（要素词单独出现也算——「转场太快了」没有动词也是在改） */
const EDIT_RE = /[改换调删加裁修]|去掉|删掉|延长|缩短|提速|放慢|压缩|微调|继续|保持|只改|再[改调换加]|把.{1,12}改成|节奏|转场|字幕|旁白|背景乐|背景音|配音|时长|字号|颜色|标题|卖点|取景|素材/;

export const routeEdgeModel = ({userText, segmentCount, defaultModel, editModel}: EdgeRouterInput): EdgeRouteResult => {
  const edit = (editModel ?? '').trim();
  if (!edit) return {model: defaultModel, intent: 'edit', reason: '未配置编辑模型，路由关闭'};
  const text = (userText || '').trim();
  if (segmentCount === 0) return {model: defaultModel, intent: 'create', reason: '空工程，无从编辑'};
  if (CREATE_RE.test(text)) return {model: defaultModel, intent: 'create', reason: '命中创作意图词'};
  if (EDIT_RE.test(text)) return {model: edit, intent: 'edit', reason: '命中编辑意图词'};
  return {model: edit, intent: 'edit', reason: '工程非空且无强信号，向编辑侧兜底（非破坏性）'};
};
