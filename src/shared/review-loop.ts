/**
 * 审片 agent 闭环（管线路线图 P2-7）——反馈→处方→变体命令的纯函数层
 *
 * 五层基建最后一环「判读→参数」此前靠人：渲完→人看拼条→人写 AESTHETIC_FEEDBACK→词表打印
 * →人改参。本模块把 agent 侧的三件数学定下来：
 * - buildReviewPrompt：中性提问模板（防「顺着说」假阳性——只让报告看到的问题、没问题不提、
 *   禁止推测设计意图；类目清单对齐词表 cue 族但绝不问「是不是有 X 问题」）
 * - buildVariantsCommand：处方 → 第三层 RENDER_SEGMENT_VARIANTS 命令（首变体恒为 {} 基线，
 *   与处方同框对比；上限 4 变体防拼条过密）
 * - splitUnmatched：反馈拆短语、剔除已被命中 cue 覆盖的部分 → 「人工判读建议」（词表未命中的
 *   降级路径，走「渲染对比再入表」流程，不报错——lexicon 只收实战收敛值的纪律不动）
 *
 * 边界（路线图）：不自动改装配源文件；变体永远人挑。多模态通道走既有唯一通道
 * （Read→CDN URL→analyze_image），脚本只产拼条与提示词，VLM 调用由持通道的会话执行。
 */

export interface ReviewSegRef {
  index: number;
  id: string;
  templateId: string;
  startSec: number;
  endSec: number;
}

/** 中性审片提问（贴进 analyze_image 的 prompt；拼条行优先、每格 step 秒） */
export const buildReviewPrompt = (seg: ReviewSegRef, stepSec: number, cols: number): string =>
  `这是产品宣传片第 ${seg.index} 段（模板 ${seg.templateId}，${(seg.endSec - seg.startSec).toFixed(1)}s）的等间隔抽帧拼条：` +
  `${cols} 列行优先，每格 ${stepSec}s，覆盖 ${seg.startSec.toFixed(1)}-${seg.endSec.toFixed(1)}s。` +
  '请只依据画面描述你观察到的问题，每条一行短语并注明大约第几格：画面运动是否让你眩晕或眼花；' +
  '有无元素飞出画面边缘或被裁切；文字是否清晰可读；主体与背景层次是否分明；节奏有无拖沓或过快。' +
  '某方面没有问题就不要提。禁止推测设计意图，只报告看到的画面。';

/** 处方包 → 第三层变体并渲的命令行（{} 基线打头与处方同框对比；上限 4 变体） */
export const buildVariantsCommand = (entryTs: string, segIndex: number, patches: Array<Record<string, number>>): string => {
  const variants = [{}, ...patches.slice(0, 3)];
  const value = variants.map((p) => `${segIndex}:${JSON.stringify(p)}`).join(',');
  const env = `RENDER_SEGMENT_VARIANTS=${value}`;
  const temp = process.platform === 'win32' ? "TEMP='D:\\Videotool\\.tmp-release' TMP='D:\\Videotool\\.tmp-release' " : '';
  return `${temp}${env} node server/node_modules/tsx/dist/cli.mjs ${entryTs}`;
};

/**
 * 未命中降级：反馈拆短语（中英标点/空白），剔除被命中 cue 覆盖（短语包含任一 cue）的部分。
 * 返回值 = 需要「人工判读建议」的新反馈——词表未命中不是错误，是再入表的候选（渲染对比收敛后收）。
 */
export const splitUnmatched = (feedback: string, hitCues: string[]): string[] => {
  const covered = (phrase: string): boolean => hitCues.some((cue) => cue.length > 0 && phrase.includes(cue));
  return feedback
    .split(/[，。！？；、,!?;\s\n]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 1 && !covered(p));
};
