/**
 * 端侧档系统提示词（shared/llm-prompt.ts buildSystemPrompt {edge:true}）单测：
 * 精简档不预载模板槽位地图/全量工具说明，保留核心规则；默认档行为不变（回归保护）。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/llm-prompt-edge.test.ts
 */
import {buildSystemPrompt} from '../../src/shared/llm-prompt';
import {EDGE_TOOL_NAMES} from '../../src/shared/llm-tools';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};

const full = buildSystemPrompt('promo');
const edge = buildSystemPrompt('promo', {edge: true});

// ====== 端侧档：砍掉大块预载 ======
ok(!edge.includes('模板槽位地图'), '不预载模板槽位地图（≈最大 token 块，改用 get_templates 现查）');
ok(!edge.includes('TimeTunnel3D'), '不预载模板专有参数说明');
ok(!edge.includes('## 录屏与截屏工作流'), '不预载录屏工作流（录屏工具不在端侧工具面）');
ok(!edge.includes('CursorFollow'), '不预载依赖完整工具面的注释');
ok(edge.length < full.length / 2, `端侧档体积 < 默认档一半（${edge.length} vs ${full.length} 字符）`);

// ====== 端侧档：保留关键内容 ======
ok(edge.includes('本地模型精简模式'), '标注端侧档身份');
ok(edge.includes('## 可用转场') && edge.includes('crossfade'), '转场清单保留（update_segment 枚举依据）');
ok(edge.includes('set_storyboard 是整体重建'), '保留防素材清空的警告');
ok(edge.includes('卖点-素材对位'), '保留卖点-素材对位规则');
ok(edge.includes('view_segment_frame'), '核心看图工具说明保留');
ok(edge.includes('0.5-60 秒'), '时长护栏保留');
ok(edge.includes('不要漏设'), '转场收尾提醒保留（端侧实测 2B 漏设转场）');

// ====== 端侧档：工具说明只列端侧子集 ======
ok(!edge.includes('synthesize_narration：'), '非端侧工具（TTS）不出现在说明里');
ok(!edge.includes('generate_model：'), '非端侧工具（文生 3D）不出现在说明里');
ok(edge.split('\n').filter((l) => l.startsWith('- ')).length >= 10, '端侧工具说明条数合理（17 个中带 promptHint 的子集）');
ok(EDGE_TOOL_NAMES.has('request_render') && EDGE_TOOL_NAMES.has('view_segment_frame'), '端侧清单含看图与渲染');

// ====== 2026-11-03：数据走私收编（26→29 面）======
// 依据：sft-v9 832 窗里 761 窗（91.5%）在调用这三个工具，但它们此前不在 EDGE schema 里
// （教师走 MCP 全量面采集）→ 模型被教成「忽略 schema、用我记得的工具」。
ok(EDGE_TOOL_NAMES.has('get_app_status'), '端侧清单含 get_app_status（渲染轮询唯一正解）');
ok(EDGE_TOOL_NAMES.has('import_segment_media'), '端侧清单含 import_segment_media（建板导入）');
ok(EDGE_TOOL_NAMES.has('set_video_type'), '端侧清单含 set_video_type（体裁切换）');
ok(EDGE_TOOL_NAMES.size === 29, `端侧面数 = 29（实得 ${EDGE_TOOL_NAMES.size}）`);
ok(edge.includes('get_app_status 轮询'), '工作流写明 request_render 后用 get_app_status 轮询');
ok(edge.includes('不要用 get_timeline 当轮询器'), '明确禁止 get_timeline 当轮询器（v8 死签名）');
ok(edge.includes('import_segment_media'), '工作流含素材导入引导');
ok(edge.includes('set_video_type'), '工作流含体裁切换引导');

// ====== 其它体裁的端侧档身份切换 ======
ok(buildSystemPrompt('vlog', {edge: true}).includes('视频剪辑助手'), '端侧档身份随体裁切换');

// ====== P0-3：分体裁制作口径 + sourceKind 铁律（2026-10-25，诊断 docs/real-footage-genre-diagnosis.md）======
const vlogEdge = buildSystemPrompt('vlog', {edge: true});
const talkingEdge = buildSystemPrompt('talkingHead', {edge: true});
const tutorialEdge = buildSystemPrompt('tutorial', {edge: true});
const montageEdge = buildSystemPrompt('montage', {edge: true});
for (const [name, p] of [['promo', edge], ['vlog', vlogEdge], ['talkingHead', talkingEdge], ['tutorial', tutorialEdge], ['montage', montageEdge]] as const) {
  ok(p.includes('素材类型-模板对位（铁律）'), `${name}：sourceKind 铁律进端侧规则`);
  ok(p.includes('needsMedia:true'), `${name}：铁律引导 search_templates needsMedia 检索`);
  ok(p.includes('scan_media') && p.includes('mine_highlights') && p.includes('apply_cut_list'), `${name}：共用工作流含长素材链路（scan→mine→apply）`);
  ok(!p.includes('TimeTunnel3D'), `${name}：不预载模板专有参数说明`);
}
ok(vlogEdge.includes('本体裁制作口径') && vlogEdge.includes('钩子前置') && vlogEdge.includes('每镜头 2-8 秒'), 'vlog 分体裁口径（钩子前置/镜头时长）');
ok(vlogEdge.includes('不要造文字板') && !vlogEdge.includes('老实做成文字板'), 'vlog：无素材支撑禁文字板，promo 文字板兜底不再出现在 vlog');
ok(montageEdge.includes('顺序别反') && montageEdge.includes('60÷BPM'), 'montage 分体裁口径（先配乐/BPM 压拍，端侧面无 align_beats 用时长换算替代）');
ok(talkingEdge.includes('TalkingPoint') && talkingEdge.includes('跳切'), 'talkingHead 分体裁口径（观点卡/跳切挖口误）');
ok(tutorialEdge.includes('StepCard') && tutorialEdge.includes('讲到的就是看到的'), 'tutorial 分体裁口径（步骤卡/操作对齐）');
ok(edge.includes('卖点-素材对位') && edge.includes('老实做成文字板'), 'promo：保留卖点-素材对位与文字板兜底（文字板是 promo 合法形态）');
ok(edge.length < full.length / 2, `分体裁口径后端侧档体积仍 < 默认档一半（${edge.length} vs ${full.length} 字符）`);

// ====== 默认档行为不变（回归保护） ======
ok(full.includes('模板槽位地图'), '默认档仍预载模板槽位地图');
ok(full.includes('## 录屏与截屏工作流'), '默认档仍含录屏工作流');
ok(full === buildSystemPrompt('promo'), '默认调用（无 opts）结果稳定');

console.log(`passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
