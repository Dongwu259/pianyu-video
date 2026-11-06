/**
 * 模板自检 checkpoints（程序化断言）——跨会话任务 docs/template-self-check-prompt.md
 *
 * 背景：宣传片装配（smoke_test/promo-*.ts）v1-v9 反复踩同一类坑：参数写错静默回退
 * （CursorFollow stagePalette 键名错→静默深蓝）、数量封顶静默截断（Whiteboard 9 卡
 * 只渲 6）、参数把内容送出画面（PanelFlyout flyAmp 1.6 出画）、布局出界
 * （ChatConversation 早期推挤补偿压出底边）。模板自己最清楚哪里容易坏——本文件把
 * 这些「人脑里的检查」落成纯函数断言，装配/渲染管线渲前自动执行。
 *
 * 纪律：静态检查为主（渲染前、毫秒级、零渲染成本；帧级动态检查属路线图第四层，
 * 见 docs/promo-quality-roadmap.md）；message 写「违反了会看到什么」+ 修法，不写
 * 代码术语；每个检查项的依据写注释（哪轮复盘、什么现象）——没有实战依据的不加。
 */

import type {Segment} from './types';
import {TEMPLATES} from './template-registry';
import {parseWhiteboardCards} from './whiteboard-canvas';
import {parseChatLines} from './chat-conversation';
import {parseTestimonial, parsePricingTier, parseDataPointLine, parseBeforeAfterMetric, parseDiffRows, parsePriceAnchor} from './promo-text-parse';
import {planRowEmbed, ROW_EMBED_MAX_ROWS, ROW_EMBED_MAX_ROW_CHARS, ROW_EMBED_PANEL_MAX_FRAC} from './row-embed-layout';

/** 检查上下文：segment + 与 makeParamReader 同语义的参数读取（用户值 > 规格默认 > 1） */
export interface TemplateCheckContext {
  segment: Segment;
  segmentIndex: number;
  params: Record<string, number>;
  read: (key: string) => number;
  durationSec: number;
  videoCount: number;
}

export interface TemplateCheckpoint {
  id: string;
  /** error=必然坏帧；warn=观感风险 */
  severity: 'error' | 'warn';
  /** 人话说明：违反了会看到什么（给装配者的反馈） */
  message: string;
  /** 返回违规详情（拼进 message）或 null=通过 */
  check?: (ctx: TemplateCheckContext) => string | null;
}

export interface CheckpointIssue {
  segmentIndex: number;
  templateId: string;
  checkpointId: string;
  severity: 'error' | 'warn';
  /** `[checkpoint] 第 N 段 <message>（<详情>）」的完整一句 */
  message: string;
}

/** 逐条入场动画的模板（依据=各模板 description 的「逐条/逐卡/错峰」语言）：
 *  段太短时动画没放完就切——通用 duration 检查只对这些模板报 */
const STAGGERED_TEMPLATES = new Set([
  'ChatConversation', // 逐条弹入（首泡 0.5s 起，最小步长 0.55s）
  'WhiteboardCanvas', // 逐卡推近
  'PanelFlyout',      // 区域卡错峰飞出（flyStagger）
  'AiPromptCard',     // 打字 → 回车 → 结果卡（需要完整节拍）
  'RevealSlide',      // 要点逐条入场
]);

/** 参数值语义读取（用户值 > 规格默认 > 1）——keyframes 时刻规划同源复用 */
export const readParam = (specs: {key: string; default: number}[], params: Record<string, number> | undefined) =>
  (key: string): number => {
    const user = params?.[key];
    if (typeof user === 'number' && Number.isFinite(user)) return user;
    const spec = specs.find((s) => s.key === key);
    return spec ? spec.default : 1;
  };

/** 通用检查（所有模板）：customParams 未定义键——拼写错误静默回退的根（v4 实锤：
 *  stagePalette 键名写错，makeParamReader 回退默认深蓝，画面 silently 不对） */
const checkUnknownKeys = (ctx: TemplateCheckContext, knownKeys: Set<string>): string | null => {
  const unknown = Object.keys(ctx.params).filter((k) => !knownKeys.has(k));
  return unknown.length > 0 ? `参数「${unknown.join('」「')}」不在本模板参数表（疑似拼写错误），渲染会静默按默认值——请改成参数页里的合法键名` : null;
};

/** 通用检查（逐条入场模板）：段太短动画没放完就切 */
const checkStaggerDuration = (ctx: TemplateCheckContext): string | null => {
  if (ctx.durationSec >= 2.5) return null;
  return `段长只有 ${ctx.durationSec.toFixed(1)}s，逐条入场动画还没放完就会被切走（条目从 0.5s 起以最小 0.55s 间隔进场）——加长到 ≥2.5s，或换无逐条动画的模板`;
};

export const TEMPLATE_CHECKPOINTS: Record<string, TemplateCheckpoint[]> = {
  PanelFlyout: [
    {
      // v6/v7 实战：flyAmp 1.6 区域卡全出画外，「飞出」动作本身不可见；窄带 1.0-1.4
      id: 'flyout-amp-too-far',
      severity: 'error',
      message: '飞出距离过大，区域卡会完全飞出画外，「飞出」动作本身看不见——收窄到 1.0-1.4',
      check: (c) => (c.read('flyAmp') > 1.45 ? `flyAmp=${c.read('flyAmp')}` : null),
    },
    {
      // v6 实战：1.0 卡悬半空，拆层感弱
      id: 'flyout-amp-too-weak',
      severity: 'warn',
      message: '飞出距离偏小，卡只飞一半悬在画内中央，拆层感弱——建议 ≥1.1',
      check: (c) => (c.read('flyAmp') < 1.0 ? `flyAmp=${c.read('flyAmp')}` : null),
    },
    {
      // 无 regions sidecar 时模板退化整幅静帧不拆层（模板设计如此，装配者易当 bug 报）
      id: 'flyout-no-regions',
      severity: 'error',
      message: '素材缺少 UI 区域数据（.regions.json），模板会退化成整幅画面不拆层——先做 UI 区域检测，或换其它模板',
      check: (c) => (!c.segment.videos[0]?.uiRegionsTrack && !c.segment.videos[0]?.uiRegions ? 'videos[0] 无 regions' : null),
    },
    {
      // v5 复盘：主界面清晰是随变语言，但 dim 过小且不模糊=底层与前景卡明暗不分
      id: 'flyout-dim-blur-flat',
      severity: 'warn',
      message: '底层压暗很弱且没开底层虚化，底层画面和飞出的卡明暗不分、分层看不出来——建议压暗 ≥0.3 或开启底层虚化',
      check: (c) => (c.read('dim') < 0.3 && c.read('blurBg') < 0.5 ? `dim=${c.read('dim')} blurBg=0` : null),
    },
  ],
  ChatConversation: [
    {
      // bubbleEnterFrame step 下限 0.55s：行数×0.55 超出可用窗（首 0.5s+尾 0.6s）→ 连发轰炸
      id: 'chat-too-many-lines',
      severity: 'error',
      message: '对话行数太多，气泡会被压到最小间隔连发、节奏读不过来——删减行数、加长段，或调快逐条节奏',
      check: (c) => {
        const n = parseChatLines(c.segment.text?.features ?? []).length;
        return n * 0.55 > c.durationSec - 1.1 ? `${n} 行 × 0.55s > 段长 ${c.durationSec.toFixed(1)}s - 1.1s` : null;
      },
    },
    {
      // widthScale>0.8 气泡过宽失去左右往复的对话感
      id: 'chat-too-wide',
      severity: 'warn',
      message: '气泡列过宽，几乎横贯画面，失去对话一来一回的感觉——建议 ≤0.8',
      check: (c) => (c.read('widthScale') > 0.8 ? `widthScale=${c.read('widthScale')}` : null),
    },
    {
      // estimateChatRows 行数估算是 0.55/1 字宽启发式：>40 字超出可靠域，固定盒高度失准
      // （泡高预固定=换文零跳机制的前提，见 chat-conversation.ts）
      id: 'chat-line-too-long',
      severity: 'error',
      message: '有对话行超过 40 字，气泡高度按字数估算会失准（文本可能溢出或留大空隙）——拆成两行短句，单行 ≤40 字',
      check: (c) => {
        const lines = parseChatLines(c.segment.text?.features ?? []);
        const idx = lines.findIndex((l) => Array.from(l.text).length > 40);
        return idx >= 0 ? `第 ${idx + 1} 行 ${Array.from(lines[idx].text).length} 字` : null;
      },
    },
  ],
  WhiteboardCanvas: [
    {
      // SLOTS 三行三列 9 槽（v6 扩容）；>9 卡 layout 循环复用槽位叠卡。
      // maxCards 传 99 全量解析——parseWhiteboardCards 缺省 6 会先截断掩盖此问题（v6-v8 实锤）
      id: 'whiteboard-over-slots',
      severity: 'error',
      message: '卡片行数超过 9 个槽位，第 10 张起会叠在别人的位置上——删到 ≤9 张卡',
      check: (c) => {
        const n = parseWhiteboardCards(c.segment.text?.features ?? [], 99).length;
        return n > 9 ? `${n} 张卡 > 9 槽` : null;
      },
    },
    {
      // 卡多（7-9）时卡尺寸小，zoomIn>1.6 推近后小卡内容越界
      id: 'whiteboard-many-cards-zoom',
      severity: 'warn',
      message: '卡片较多还开了高倍推近，小卡内容放大后容易越出卡面——建议推近 ≤1.6 或减卡',
      check: (c) => {
        const n = parseWhiteboardCards(c.segment.text?.features ?? [], 99).length;
        return n >= 7 && n <= 9 && c.read('zoomIn') > 1.6 ? `${n} 卡 zoomIn=${c.read('zoomIn')}` : null;
      },
    },
    {
      // [v] 视频卡按序消费 videos，超出的退化文字卡（装配者预期是视频）
      id: 'whiteboard-video-cards-short',
      severity: 'error',
      message: '视频卡行数比素材多，后面的视频卡会退化成文字卡——补素材，或把多出的 [v] 改成 [t] 文字卡',
      check: (c) => {
        const cards = parseWhiteboardCards(c.segment.text?.features ?? [], 99);
        const vCards = cards.filter((k) => k.type === 'video').length;
        return vCards > c.videoCount ? `${vCards} 张 [v] 卡 > ${c.videoCount} 个素材` : null;
      },
    },
    {
      // v7 实证：相机推近+卡内放大双重叠加晕
      id: 'whiteboard-double-zoom',
      severity: 'warn',
      message: '相机推近和卡内放大同时开高档，双重叠加观看发晕（v7 实证）——两个里调低一个',
      check: (c) => (c.read('contentZoom') > 0 && c.read('zoomIn') > 1.6 ? `contentZoom=${c.read('contentZoom')} zoomIn=${c.read('zoomIn')}` : null),
    },
  ],
  CursorFollow: [
    {
      // v4 实锤：stagePalette 键名拼错静默回退深蓝。此处查值域（键名错由通用未定义键
      // 检查拦）——stagePalette 0-9，越界档在 stageBackgroundCss 静默落到深蓝
      id: 'cursor-palette-range',
      severity: 'error',
      message: '舞台色板档位超出 0-9，舞台底色会静默落回默认深蓝——改成 0-9 的档位',
      check: (c) => (c.read('stageBg') >= 1 && c.read('stagePalette') > 9 ? `stagePalette=${c.read('stagePalette')}` : null),
    },
    {
      // 第九十二轮新参数：focusAnchor 激活（任一 >0）但聚焦蒙版关着——锚点钉了放大
      // 中心却不要清晰区引导，常是「想要蒙版跟锚」的误用
      id: 'cursor-anchor-without-dim',
      severity: 'warn',
      message: '设置了放大锚点但聚焦蒙版是关的——如果想要「锚点处清晰、四周虚化」的效果，把聚焦蒙版打开；确认不需要就忽略本条',
      check: (c) => ((c.read('focusAnchorX') > 0 || c.read('focusAnchorY') > 0) && c.read('focusDimOn') < 0.5 ? `focusAnchor=(${c.read('focusAnchorX')},${c.read('focusAnchorY')}) focusDimOn=0` : null),
    },
    {
      // 悬停浮卡需要驻留采样（≥550ms 聚类）：clickHold 过短浮卡来不及生长
      id: 'cursor-hovercard-short-hold',
      severity: 'warn',
      message: '点击停留太短又开了悬停浮卡，浮卡来不及长出来就被收走——建议停留 ≥0.6s，或关掉悬停浮卡',
      check: (c) => (c.read('clickHold') < 0.6 && c.read('hoverCard') >= 0.5 ? `clickHold=${c.read('clickHold')} hoverCard=1` : null),
    },
  ],
  // ====== 批 1 data/proof 六形态（2026-10-13 验收批，依据 smoke_test/batch2-probe.ts 四画幅探针） ======
  BeforeAfter: [
    {
      // 批1验收：核心机制=旧态素材→中点擦除→新态素材，缺一段「对比」无从谈起
      id: 'beforeafter-needs-two-videos',
      severity: 'error',
      message: '前后对比需要 2 段素材（第 1 段旧状态、第 2 段新状态），缺段就没有对比——补齐两段素材或换模板',
      check: (c) => (c.videoCount < 2 ? `素材 ${c.videoCount}/2` : null),
    },
    {
      // 批1验收：无「→」的指标行按原文静态展示（无翻牌）——装配者预期翻牌会说「坏了」
      id: 'beforeafter-metric-no-arrow',
      severity: 'warn',
      message: '有指标行没有「→」箭头（如「16小时 → 5分钟」），该行会按原文静态展示、没有旧值划掉新值滑入的效果——补箭头或删掉该行',
      check: (c) => {
        const bad = (c.segment.text?.features ?? []).filter((f) => (f ?? '').trim() && parseBeforeAfterMetric(f) === null);
        return bad.length > 0 ? `${bad.length} 行无箭头（如「${bad[0].slice(0, 12)}」）` : null;
      },
    },
  ],
  Testimonial: [
    {
      // 批1验收：引言是卡片主体（subtitle/title 只是兜底标签），全空=只有星空和署名的空卡
      id: 'testimonial-empty-quote',
      severity: 'error',
      message: '证言引言是空的（要点第 1 行），卡片里将没有正文——在第 1 行填一句用户原话',
      check: (c) => {
        const content = parseTestimonial(c.segment.text?.features, c.segment.text?.subtitle || c.segment.text?.title);
        return content.quote.trim() ? null : '引言为空';
      },
    },
    {
      // 批1验收：星级行非 0-5 整数时 parseTestimonial 静默按 5 星
      id: 'testimonial-bad-rating',
      severity: 'warn',
      message: '要点第 3 行星级不是 0-5 的整数，会静默按 5 星显示——改成数字 0-5（0 = 隐藏星级）',
      check: (c) => {
        const list = (c.segment.text?.features ?? []).map((f) => (f ?? '').trim());
        if (list.length < 3 || list[2] === '') return null;
        const n = Number(list[2]);
        return Number.isInteger(n) && n >= 0 && n <= 5 ? null : `第 3 行「${list[2]}」不是 0-5 整数`;
      },
    },
  ],
  PricingTiers: [
    {
      // 批1验收：行缺价格段 → 卡片缺价格（parsePricingTier 空串静默展示）
      id: 'pricing-tier-missing-fields',
      severity: 'warn',
      message: '有档位行不是「档位名 价格 描述」格式（空格分隔、前两段不能缺），该卡会缺价格——按格式补全（如「专业版 ¥8 自有模型」）',
      check: (c) => {
        const bad = (c.segment.text?.features ?? []).filter((f) => (f ?? '').trim() && parsePricingTier(f).price === '');
        return bad.length > 0 ? `${bad.length} 行缺价格段（如「${bad[0].slice(0, 12)}」）` : null;
      },
    },
    {
      // 批1验收：highlight 序号超出档数 → 脉冲/徽标没有落点，静默无高亮
      id: 'pricing-highlight-out-of-range',
      severity: 'warn',
      message: '推荐档序号超出档位行数，将没有任何卡片被高亮——把「推荐档」改到 1-档数，或 0 关闭',
      check: (c) => {
        const rows = (c.segment.text?.features ?? []).filter((f) => (f ?? '').trim()).length;
        const h = Math.round(c.read('highlight'));
        return h > rows && rows > 0 ? `推荐档 ${h} > ${rows} 档` : null;
      },
    },
  ],
  GrowthBars3D: [
    {
      // 批1验收：有效行 <3 时 parseDataSeries 回退示例数据——画面有内容但不是装配者填的
      id: 'growth-fallback-series',
      severity: 'warn',
      message: '能解析的数据行不足 3 条，柱状图会回退成示例数据（不是你填的内容）——每行按「标签 数值」写（如「1月 12000」），凑满 3 条',
      check: (c) => {
        const rows = (c.segment.text?.features ?? []).filter((f) => (f ?? '').trim());
        const valid = rows.map(parseDataPointLine).filter((x) => x !== null).length;
        return rows.length > 0 && valid < 3 ? `有效 ${valid}/3 行` : null;
      },
    },
    {
      // 批1验收：>8 条有效行静默截断（parseDataSeries max）
      id: 'growth-too-many-rows',
      severity: 'warn',
      message: '有效数据行超过 8 条，第 9 条起被静默丢弃——删到 ≤8 条',
      check: (c) => {
        const valid = (c.segment.text?.features ?? []).map(parseDataPointLine).filter((x) => x !== null).length;
        return valid > 8 ? `${valid} 行 > 8` : null;
      },
    },
  ],
  FeatureList: [
    {
      // 批1验收：template slice(0,6) 静默截断（空行也占名额）
      id: 'featurelist-too-many-rows',
      severity: 'warn',
      message: '清单条目（含空行）超过 6 条，第 7 条起被静默丢弃——删到 ≤6 条',
      check: (c) => {
        const n = (c.segment.text?.features ?? []).length;
        return n > 6 ? `${n} 条` : null;
      },
    },
  ],
  LogoCloud: [
    {
      // 批1验收：items = logos.length ? logos : names——两边都空=只有标题的空云
      id: 'logocloud-empty',
      severity: 'error',
      message: '客户云既没有 logo 图也没有客户名列表，画面里将只有一个标题——放 1-8 张 logo 图，或在要点里填客户名（≤8 条）',
      check: (c) =>
        c.videoCount === 0 && (c.segment.text?.features ?? []).every((f) => !(f ?? '').trim())
          ? 'logos 与客户名均空'
          : null,
    },
    {
      // 批1验收：logos/names 各自 slice(0,8) 静默截断；有 logo 图时客户名整列不渲染（优先级）
      id: 'logocloud-truncate',
      severity: 'warn',
      message: '客户名或 logo 图超过 8 项会被静默截断到 8——删到 ≤8',
      check: (c) => {
        const n = Math.max(c.videoCount, (c.segment.text?.features ?? []).length);
        return n > 8 ? `${n} 项 > 8` : null;
      },
    },
  ],
  // ====== 批 2 真缺口三形态（2026-10-13，依据 smoke_test/batch2b-probe.ts 四画幅探针） ======
  ChapterProgress: [
    {
      // 真缺口批：序号大于总章数=进度点全亮但数字越界（第 3/2 幕逻辑矛盾）
      id: 'chapter-exceeds-total',
      severity: 'error',
      message: '章节序号大于总章数（「第 3/2 幕」），进度点全部点亮且没有推进感——核对「章节序号」和「总章数」',
      check: (c) => (c.read('chapter') > c.read('total') ? `第 ${c.read('chapter')}/${c.read('total')} 幕` : null),
    },
  ],
  PriceAnchorPro: [
    {
      // 真缺口批：卖点与徽章全空 → 价格孤零零一屏（模板核心是「锚点+支撑」复合）
      id: 'priceanchor-empty-perks',
      severity: 'warn',
      message: '没有卖点行也没有信赖徽章，价格孤零零占一屏缺少支撑——要点每行一条卖点（≤4），行前加「!」变徽章（≤3）',
      check: (c) => {
        const {perks, badges} = parsePriceAnchor(c.segment.text?.features);
        return perks.length === 0 && badges.length === 0 ? '卖点与徽章均空' : null;
      },
    },
    {
      // 真缺口批：parsePriceAnchor 静默截断（perks>4 / badges>3）
      id: 'priceanchor-truncate',
      severity: 'warn',
      message: '卖点超过 4 条或徽章超过 3 枚，多出的被静默丢弃——删到卖点 ≤4、徽章 ≤3',
      check: (c) => {
        const rows = (c.segment.text?.features ?? []).filter((f) => (f ?? '').trim());
        const perks = rows.filter((r) => !r.trim().startsWith('!')).length;
        const badges = rows.filter((r) => r.trim().startsWith('!')).length;
        return perks > 4 || badges > 3 ? `卖点 ${perks} 徽章 ${badges}` : null;
      },
    },
  ],
  DiffReveal: [
    {
      // 真缺口批：diff 面板没有行=只有标题的空面板
      id: 'diff-empty-rows',
      severity: 'error',
      message: 'diff 行全空，面板里将只有标题——要点每行一条：「-旧内容」「+新内容」或无前缀的上下文行',
      check: (c) => (parseDiffRows(c.segment.text?.features).length === 0 ? '无有效行' : null),
    },
    {
      // 真缺口批：全上下文行=没有 diff 语义（清单该用功能清单模板）
      id: 'diff-no-change-rows',
      severity: 'warn',
      message: '没有任何「-」或「+」行，面板只是普通清单没有改动语义——差异行用「-」「+」前缀，或改用功能清单模板',
      check: (c) => {
        const rows = parseDiffRows(c.segment.text?.features);
        return rows.length > 0 && !rows.some((r) => r.kind !== 'ctx') ? `${rows.length} 行全是上下文行` : null;
      },
    },
    {
      // 真缺口批：>10 行 parseDiffRows 静默截断
      id: 'diff-truncate-rows',
      severity: 'warn',
      message: 'diff 行超过 10 条，第 11 条起被静默丢弃——删到 ≤10 行',
      check: (c) => {
        const raw = (c.segment.text?.features ?? []).filter((f) => (f ?? '').trim()).length;
        return raw > 10 ? `${raw} 行 > 10` : null;
      },
    },
    {
      // 真缺口批：只有前缀没有内容的行（如单独一个「-」）被静默丢弃
      id: 'diff-malformed-rows',
      severity: 'warn',
      message: '有行只有「-」或「+」前缀没有内容，整行被静默丢弃——补上内容或删掉该行',
      check: (c) => {
        const dropped = (c.segment.text?.features ?? []).filter((f) => {
          const t = (f ?? '').trim();
          return t === '-' || t === '+';
        }).length;
        return dropped > 0 ? `${dropped} 行空前缀` : null;
      },
    },
  ],
  // ====== 批 2 hook/story 六形态（2026-10-13，依据 smoke_test/batch2c-probe.ts 四画幅探针） ======
  StepCard: [
    {
      // 批2验收：template slice(0,4) 静默截断
      id: 'stepcard-too-many-rows',
      severity: 'warn',
      message: '操作要点超过 4 条，第 5 条起被静默丢弃——删到 ≤4 条',
      check: (c) => ((c.segment.text?.features ?? []).length > 4 ? `${c.segment.text!.features!.length} 条` : null),
    },
  ],
  // ====== RowEmbed 单卡试点（docs/template-design-row-embed.md §九.7 / §十一） ======
  RowEmbed: [
    {
      // §十一「段长过短行数过多」的对偶：行数封顶 4，第 5 行起静默不显示
      id: 'rowembed-too-many-rows',
      severity: 'warn',
      message: `要点超过 ${ROW_EMBED_MAX_ROWS} 条，第 ${ROW_EMBED_MAX_ROWS + 1} 条起不会显示——删到 ≤${ROW_EMBED_MAX_ROWS} 条，或拆成两段`,
      check: (c) => {
        const n = (c.segment.text?.features ?? []).length;
        return n > ROW_EMBED_MAX_ROWS ? `${n} 条` : null;
      },
    },
    {
      // §十一「行纹理条带多视频实例」的退化路径：无素材时条带静默关闭
      id: 'rowembed-band-without-media',
      severity: 'warn',
      message: '行纹理条带需要 1 段素材；本段没有素材，条带会自动退化为纯文字行（观感更素）——加一段录屏素材，或把「行纹理条带」关掉',
      check: (c) => (c.read('rowMedia') >= 0.5 && c.videoCount === 0 ? '无素材' : null),
    },
    {
      // §九.7 ③：面板高 > 画框 86%（规划器会压行高兜底；压不下去/文字会挤时报错拦渲染）
      id: 'rowembed-panel-overflow',
      severity: 'error',
      message: '面板内容高超过画框 86%，行高被压到文字拥挤——减少行数、缩短文案，或调小「行文字大小」',
      check: (c) => {
        const features = (c.segment.text?.features ?? []).filter((f) => (f ?? '').trim()).length;
        if (features === 0) return null;
        const params = {
          flySpeed: c.read('flySpeed'),
          staggerDecel: c.read('staggerDecel'),
          camPush: c.read('camPush'),
          rowMedia: c.read('rowMedia'),
          rowsTextScale: c.read('rowsTextScale'),
        };
        // 两个基准画布的最坏占比（16:9 与 9:16；body token 取 getScaledTokens 的基准值）
        const ratioOf = (canvasW: number, canvasH: number, bodyPx: number) =>
          planRowEmbed({
            canvasW,
            canvasH,
            totalFrames: Math.round(c.durationSec * 30),
            featureCount: features,
            hasMedia: c.videoCount > 0,
            bodyFontPx: bodyPx,
            params,
          }).panelNaturalH / canvasH;
        const worst = Math.max(ratioOf(1920, 1080, 28), ratioOf(1080, 1920, 21.3));
        return worst > ROW_EMBED_PANEL_MAX_FRAC ? `${Math.round(worst * 100)}%` : null;
      },
    },
    {
      // §十一「文案超长溢出」：行内单行 + ellipsis，超长会被截断（不是折行）
      id: 'rowembed-row-text-too-long',
      severity: 'warn',
      message: `单行文案超过 ${ROW_EMBED_MAX_ROW_CHARS} 字，行内单行显示会截断——压到 ≤${ROW_EMBED_MAX_ROW_CHARS} 字`,
      check: (c) => {
        const lens = (c.segment.text?.features ?? []).map((f) => Array.from(f ?? '').length);
        const long = lens.filter((n) => n > ROW_EMBED_MAX_ROW_CHARS);
        return long.length > 0 ? `${long.length} 行超长（最长 ${Math.max(...long)} 字）` : null;
      },
    },
  ],
  TimelineRoadmap: [
    {
      // 批2验收：template slice(0,5) 静默截断
      id: 'roadmap-too-many-nodes',
      severity: 'warn',
      message: '时间线节点超过 5 个，第 6 个起被静默丢弃——删到 ≤5 节点',
      check: (c) => ((c.segment.text?.features ?? []).filter((f) => (f ?? '').trim()).length > 5 ? '超过 5 节点' : null),
    },
  ],
  TextSlide: [
    {
      // 批2验收：template slice(0,5) 静默截断
      id: 'textslide-too-many-rows',
      severity: 'warn',
      message: '要点超过 5 条，第 6 条起被静默丢弃——删到 ≤5 条',
      check: (c) => ((c.segment.text?.features ?? []).length > 5 ? `${c.segment.text!.features!.length} 条` : null),
    },
  ],
  CodeTerminal: [
    {
      // 批2验收：template slice(0,14) 静默截断（保留空行口径与要点一致）
      id: 'codeterminal-too-many-lines',
      severity: 'warn',
      message: '代码行（含空行）超过 14 行，第 15 行起被静默丢弃——删到 ≤14 行',
      check: (c) => ((c.segment.text?.features ?? []).length > 14 ? `${c.segment.text!.features!.length} 行` : null),
    },
  ],
  NeonTech: [
    {
      // 批2验收：零素材走占位形态（暗色面板+呼吸光环）——设计兜底但霓虹语言不完整
      id: 'neontech-no-media',
      severity: 'warn',
      message: '没有素材，霓虹模板会退化成暗色占位面板（呼吸光环）——放 1-3 段素材，或换纯文字模板',
      check: (c) => (c.videoCount === 0 ? 'videos 为空' : null),
    },
  ],
};

const findMeta = (templateId: string) => TEMPLATES.find((t) => t.id === templateId);

/**
 * 对故事板 segments 跑全部模板自检（纯函数，装配/渲染/单测共用）。
 * 输出 message 已含段号与模板名前缀，可直接打印；severity 'error' 由调用方决定
 * 阻断（装配脚本 process.exit(1)、renderSample 阻止渲染）。
 */
export const lintCheckpoints = (segments: Segment[]): CheckpointIssue[] => {
  const issues: CheckpointIssue[] = [];
  segments.forEach((seg, i) => {
    const meta = findMeta(seg.templateId);
    if (!meta) return; // 未知模板（自定义模板另有校验层）——不在本检查域
    const params = (seg.customParams ?? {}) as Record<string, number>;
    const specs = meta.paramSpecs ?? [];
    const knownKeys = new Set(specs.map((s) => s.key));
    const ctx: TemplateCheckContext = {
      segment: seg,
      segmentIndex: i,
      params,
      read: readParam(specs, params),
      durationSec: seg.duration ?? 8,
      videoCount: seg.videos?.length ?? 0,
    };
    const fire = (cp: {id: string; severity: 'error' | 'warn'; message: string}, detail: string | null) => {
      if (detail === null) return;
      issues.push({
        segmentIndex: i,
        templateId: seg.templateId,
        checkpointId: cp.id,
        severity: cp.severity,
        message: `[checkpoint] 第 ${i + 1} 段（${meta.name}）${cp.message}（${detail}）`,
      });
    };
    // 模板专属检查
    for (const cp of TEMPLATE_CHECKPOINTS[seg.templateId] ?? []) {
      fire(cp, cp.check ? cp.check(ctx) : null);
    }
    // 通用检查
    fire({id: 'common-unknown-param-keys', severity: 'error', message: ''}, checkUnknownKeys(ctx, knownKeys));
    if (STAGGERED_TEMPLATES.has(seg.templateId)) {
      fire({id: 'common-stagger-too-short', severity: 'warn', message: ''}, checkStaggerDuration(ctx));
    }
  });
  return issues;
};
