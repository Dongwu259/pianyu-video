/**
 * 字体氛围预设（项目级品牌设置）
 *
 * 决定全片标题/正文/等宽的字体栈。字体文件全部内置且许可允许随软件分发：
 * - MiSans（小米，可商用）—— 商业冷峻（缺省，与历史版本一致）
 * - 霞鹜文楷 LXGW WenKai（SIL OFL 1.1）—— 温暖手写
 * - JetBrains Mono（SIL OFL 1.1）—— 科技等宽（英文/数字等宽 + 中文黑体回退）
 * - Poppins（SIL OFL 1.1）—— 英文展示（几何无衬线，英文大字报）
 *
 * 字体栈把内置字体放最前，加载失败自动回退系统字体（渲染不中断）。
 * 消费方：remotion/config/designTokens.ts（模块主题）；UI：BrandPanel 字体氛围弹层。
 */

export type FontMoodId = 'sleek' | 'warm' | 'tech' | 'display';

/** 中文回退栈（内置字体缺字或加载失败时兜底，各预设共用） */
const CJK_FALLBACK = '"PingFang SC", "Microsoft YaHei", -apple-system, sans-serif';

export interface FontMood {
  id: FontMoodId;
  label: string;
  desc: string;
  /** 标题字体栈 */
  titleFont: string;
  /** 正文字体栈 */
  bodyFont: string;
  /** 等宽字体栈（代码/数据数字；JetBrains Mono 已内置，替代纯系统回退） */
  monoFont: string;
}

const MI_SANS = '"MiSans"';
const WENKAI = '"LXGW WenKai"';
const JB_MONO = '"JetBrains Mono"';
const POPPINS = '"Poppins"';

export const FONT_MOODS: readonly FontMood[] = [
  {
    id: 'sleek',
    label: '商业冷峻',
    desc: 'MiSans 黑体，干净现代（缺省，适合产品/商业片）',
    titleFont: `${MI_SANS}, "SF Pro Display", ${CJK_FALLBACK}`,
    bodyFont: `${MI_SANS}, "SF Pro Text", ${CJK_FALLBACK}`,
    monoFont: `${JB_MONO}, "SF Mono", "Fira Code", "Consolas", monospace`,
  },
  {
    id: 'warm',
    label: '温暖手写',
    desc: '霞鹜文楷楷体，亲切有人情味（vlog/餐饮/文创）',
    titleFont: `${WENKAI}, ${MI_SANS}, ${CJK_FALLBACK}`,
    bodyFont: `${WENKAI}, ${MI_SANS}, ${CJK_FALLBACK}`,
    monoFont: `${JB_MONO}, "SF Mono", "Fira Code", "Consolas", monospace`,
  },
  {
    id: 'tech',
    label: '科技等宽',
    desc: '标题走等宽体（数字/英文代码感）+ 中文黑体（开发者工具/教程）',
    titleFont: `${JB_MONO}, ${MI_SANS}, ${CJK_FALLBACK}`,
    bodyFont: `${MI_SANS}, "SF Pro Text", ${CJK_FALLBACK}`,
    monoFont: `${JB_MONO}, "SF Mono", "Fira Code", "Consolas", monospace`,
  },
  {
    id: 'display',
    label: '英文展示',
    desc: 'Poppins 几何无衬线（英文/数字）+ 中文黑体（出海产品/英文大字报）',
    titleFont: `${POPPINS}, ${MI_SANS}, ${CJK_FALLBACK}`,
    bodyFont: `${POPPINS}, ${MI_SANS}, ${CJK_FALLBACK}`,
    monoFont: `${JB_MONO}, "SF Mono", "Fira Code", "Consolas", monospace`,
  },
] as const;

export const DEFAULT_FONT_MOOD_ID: FontMoodId = 'sleek';

export const isFontMoodId = (v: unknown): v is FontMoodId =>
  typeof v === 'string' && FONT_MOODS.some((m) => m.id === v);

/** 取预设；非法/缺省回退默认（旧工程无此字段时与历史版本渲染一致） */
export const getFontMood = (id: string | null | undefined): FontMood =>
  FONT_MOODS.find((m) => m.id === id) ?? FONT_MOODS[0];

/** UI 选项（BrandPanel 字体氛围弹层） */
export const FONT_MOOD_OPTIONS: ReadonlyArray<{value: FontMoodId; label: string; desc: string}> =
  FONT_MOODS.map((m) => ({value: m.id, label: m.label, desc: m.desc}));
