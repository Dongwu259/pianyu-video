/**
 * 观感词表→参数映射（shared/aesthetic-lexicon.ts，质量路线图第五层产品侧）单测：
 * 每条规则口语命中+处方值+出处非空、模板过滤、全局条目、无命中、多 cue 多命中、
 * 词表纪律自检（source 必须含实战出处标记——无据条目不得混入）。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/aesthetic-lexicon.test.ts
 */
import {AESTHETIC_RULES, lookupAestheticPatch} from '../../src/shared/aesthetic-lexicon';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};
const hitIds = (text: string, tid?: string) => lookupAestheticPatch(text, tid).map((r) => r.id);

// Whiteboard 晕 → panMode 1 + contentZoom 0（roadmap 原文示例的实锚）
{
  const hits = lookupAestheticPatch('看着有点晕，眼睛花');
  ok(hits.some((h) => h.id === 'whiteboard-dizzy'), '「晕/眼花」命中 whiteboard-dizzy');
  const rule = hits.find((h) => h.id === 'whiteboard-dizzy')!;
  ok(rule.patch.panMode === 1 && rule.patch.contentZoom === 0, '处方 panMode=1 + contentZoom=0');
}

// PanelFlyout 窄带双向（出画/悬半空 同窄带处方）
{
  ok(hitIds('区域卡飞出画外了').includes('flyout-amp-band'), '「飞出画外」命中');
  ok(hitIds('卡悬半空拆层感弱').includes('flyout-amp-band'), '「悬半空/拆层感弱」命中');
  const rule = AESTHETIC_RULES.find((r) => r.id === 'flyout-amp-band')!;
  ok(rule.patch.flyAmp === 1.2 && rule.presetId === 'offset-hover', '处方 flyAmp=1.2 且溯源预设 offset-hover');
  ok(hitIds('主界面看不清').includes('flyout-blur-bg'), '「主界面看不清」→ blurBg=0');
  ok(hitIds('分层看不出来').includes('flyout-layers-flat'), '「分层看不出来」→ dim=0.45');
}

// CursorFollow 四条（v8/v9 竖版与 v8.1 实测）
{
  ok(hitIds('画中画太小').includes('cursor-card-small'), '「画中画太小」→ cardFill=0.96');
  ok(hitIds('背景色不一致').includes('cursor-bg-mismatch'), '「背景色不一致」→ stageAmbient=1');
  ok(hitIds('放大到一部分方框跟着鼠标').includes('cursor-partial-zoom'), '「局部放大」→ viewSpan=0.5');
  ok(hitIds('光标和动作对不上').includes('cursor-timing-desync'), '「光标脱节」→ smoothCursor=0');
}

// ChatConversation 过宽
{
  ok(hitIds('气泡太宽不像对话').includes('chat-too-wide'), '「气泡太宽」→ widthScale=0.62');
}

// 全局口头处方（无参数 patch，advice 非空）
{
  const hits = lookupAestheticPatch('BGM 进得慢，转场切得硬');
  ok(hits.some((h) => h.id === 'bgm-intro-slow' && !!h.advice), '「BGM 进得慢」→ 口头处方');
  ok(hits.some((h) => h.id === 'transition-hard-cut' && !!h.advice), '「切得硬」→ velocityPush 口头处方');
}

// 模板过滤：templateId 给定时只返回该模板+全局条目
{
  const hits = lookupAestheticPatch('有点晕，画中画太小', 'CursorFollow');
  ok(!hits.some((h) => h.id === 'whiteboard-dizzy'), '晕条目在 CursorFollow 过滤下不返回');
  ok(hits.some((h) => h.id === 'cursor-card-small'), '画中画条目返回');
  const global = lookupAestheticPatch('切得硬', 'ChatConversation');
  ok(global.some((h) => h.id === 'transition-hard-cut'), '全局条目（*）不受模板过滤');
}

// 无命中 / 空输入
{
  ok(lookupAestheticPatch('随便说说的一句话').length === 0, '无关文本零命中');
  ok(lookupAestheticPatch('').length === 0, '空输入零命中');
}

// 多 cue 文本多命中（真实反馈一句话带多个毛病）
{
  const hits = lookupAestheticPatch('有点晕，区域卡飞出画外，主界面看不清');
  ok(hits.length >= 3, `一句多毛病 → ≥3 处方（实际 ${hits.length}）`);
}

// ====== 词表纪律自检：每条必须有实战出处（防无据条目混入） ======
{
  // M3 起「timeline-master-plan 定稿映射」与实战收敛同级（总纲即设计定稿出处）
  const noSource = AESTHETIC_RULES.filter((r) => !/(v\d|复盘|实测|W\d|checkpoints|master-plan)/.test(r.source));
  ok(noSource.length === 0, `全部条目 source 含实战出处标记（违规 ${noSource.length} 条）`);
  const noCue = AESTHETIC_RULES.filter((r) => r.cues.length === 0 || r.cues.every((c) => !c.trim()));
  ok(noCue.length === 0, '全部条目有触发词');
  const emptyRx = AESTHETIC_RULES.filter((r) => Object.keys(r.patch).length === 0 && !r.advice && !(r.ops && r.ops.length > 0));
  ok(emptyRx.length === 0, '全部条目有参数/口头/L2 操作处方');
  // M3 L2 ops 纪律：tool 必须是既有 agent 面工具名（无新工具；处方只是声明式建议）
  {
    const KNOWN = ['set_segment_captions', 'set_segment_beats', 'set_narration_timing', 'set_bgm_position', 'set_segment_trim', 'reorder_segments', 'move_shot', 'align_beats'];
    const badTool = AESTHETIC_RULES.flatMap((r) => r.ops ?? []).filter((op) => !KNOWN.includes(op.tool));
    ok(badTool.length === 0, `L2 ops 工具名都在既有面（违规 ${badTool.length} 条）`);
  }
}

// ====== M3 L2 操作处方命中（总纲 M3：「字幕太早」→字幕行移动、「太赶」→节拍标记删除） ======
{
  const early = lookupAestheticPatch('字幕太早了，跟不上画面');
  ok(early.some((h) => h.ops?.some((op) => op.tool === 'set_segment_captions' && op.action.includes('+0.3s'))), '「字幕太早」→ set_segment_captions 整体后移');
  const late = lookupAestheticPatch('字幕出得慢');
  ok(late.some((h) => h.ops?.some((op) => op.action.includes('−0.3s'))), '「字幕太晚」对偶');
  const dense = lookupAestheticPatch('节奏太赶');
  ok(dense.some((h) => h.ops?.some((op) => op.tool === 'set_segment_beats')), '「节奏太赶」→ set_segment_beats 删标记');
  const sparse = lookupAestheticPatch('太平了，不踩拍');
  ok(sparse.some((h) => h.ops?.some((op) => op.tool === 'set_segment_beats' && op.action.includes('mark'))), '「太平」→ 补 mark');
}

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\naesthetic-lexicon: ${passed}/${passed} 全部通过`);
