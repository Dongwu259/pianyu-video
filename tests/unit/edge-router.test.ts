/**
 * edge-router 单测：双模型分工路由（规则版）。
 * 跑法：npx tsx tests/unit/edge-router.test.ts
 */
import {routeEdgeModel} from '../../src/shared/edge-router';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error('FAIL: ' + label);
  }
};

const CREATE = 'pianyu-2b-v2';
const EDIT = 'pianyu-2b-v4-edit';
const base = {defaultModel: CREATE, editModel: EDIT};

// ====== 路由关闭 ======
{
  const r = routeEdgeModel({userText: '把标题改短', segmentCount: 3, defaultModel: CREATE, editModel: ''});
  ok(r.model === CREATE && r.intent === 'edit', '未配置编辑模型 → 全走主模型');
}

// ====== 空工程 ======
{
  const r = routeEdgeModel({...base, userText: '随便说点什么', segmentCount: 0});
  ok(r.model === CREATE && r.intent === 'create', '空工程 → 创作（无从编辑）');
  ok(routeEdgeModel({...base, userText: '做一支宣传片', segmentCount: 0}).model === CREATE, '空工程 + 创作词 → 创作');
}

// ====== 创作意图（含非空工程时的重建类请求）======
for (const text of ['再做一支 20 秒的竖版预告', '重新做，这版不要了', '帮我做一个产品宣传片', '从头来，换成 vlog 试试', '生成一条 30 秒精华版']) {
  ok(routeEdgeModel({...base, userText: text, segmentCount: 3}).intent === 'create', `创作词命中：${text}`);
}

// ====== 编辑意图 ======
for (const text of ['把标题改短一点', '第二段换成更有科技感的模板', '整体节奏再快一点，压到 18 秒内', '转场太快了', '字幕字号加大',
  '延长最后一段', '去掉背景音乐', '把 subtitle 改成「山里慢下来」', '继续完善文案', '只改第三段的卖点']) {
  ok(routeEdgeModel({...base, userText: text, segmentCount: 3}).model === EDIT, `编辑词命中：${text}`);
}

// ====== 歧义向编辑兜底（分错代价不对称：创作模型可能整板重建清素材）======
for (const text of ['这里不太对', '看起来有点怪', '嗯，然后呢']) {
  const r = routeEdgeModel({...base, userText: text, segmentCount: 3});
  ok(r.model === EDIT && r.intent === 'edit', `歧义兜底 → 编辑：${text}`);
}

// ====== 主模型为空（未配置）时不炸 ======
{
  const r = routeEdgeModel({userText: '改一下', segmentCount: 3, defaultModel: '', editModel: EDIT});
  ok(r.model === EDIT, '主模型为空也正常路由到编辑');
}

console.log(`passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
