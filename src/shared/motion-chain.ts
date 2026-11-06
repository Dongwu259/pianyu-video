/**
 * 运动连续性引擎（motion-chain）——转场不再是孤立效果
 *
 * 原理（RESEARCH-AI-EDITING.md 四）：观众视线跟着上段的运动方向走，转场若保持同一
 * 运动矢量，镜头语言就连贯；每个模板在 meta 上标注 enterMotion/exitMotion（入场/段尾
 * 净运动朝向），引擎按段间边界的两侧朝向选转场类型 + 方向，并可为支持 direction 参数
 * 的模板补齐飞入方向，形成「上段向右出 → 转场向右推 → 下段从右进」的不间断运动链。
 *
 * 规则（保守、可预期）：
 * - 两侧运动同向（上下左右一致）：转场 = panChase（虚拟相机横摇追拍，出入段共享同一
 *   相机轨迹、速度曲线处处连续——「运动接运动」的纯合成器实现，RESEARCH-TRANSITIONS.md T1）
 * - 上段 exitMotion 有方向（与下段不同向或下段无方向）：转场 = push（双片同移，方向 = 上段朝向）
 * - 上段无方向、下段 enterMotion 有方向：转场 = slide（方向 = 下段朝向）
 * - 两侧都无方向：crossfade（维持默认）
 * - 下段模板声明了 direction 参数且未显式设置：补 customParams.direction = 来向
 * - 已显式选择非默认转场（非 crossfade）的边界不动（尊重人工/LLM 选择）
 *
 * 纯函数，Node 可直跑单测。
 */

import type {MotionDir, Segment, TemplateMeta, TransitionType} from './types.ts';

/** MotionDir → direction 档位码（1上 2下 3左 4右，与模板/转场参数同口径） */
export const MOTION_TO_DIR_CODE: Record<Exclude<MotionDir, 'none'>, number> = {
  up: 1, down: 2, left: 3, right: 4,
};

/** direction 档位码 → MotionDir（0/非法 → 'none'） */
export const dirCodeToMotion = (code: number | undefined): MotionDir => {
  switch (Math.round(code ?? 0)) {
    case 1: return 'up';
    case 2: return 'down';
    case 3: return 'left';
    case 4: return 'right';
    default: return 'none';
  }
};

/** 段的有效入场朝向：customParams.direction（>0）优先，否则模板 meta 标注，缺省 'none' */
export const segEnterMotion = (seg: Pick<Segment, 'customParams'>, meta?: TemplateMeta): MotionDir => {
  const override = dirCodeToMotion(seg.customParams?.direction);
  return override !== 'none' ? override : (meta?.enterMotion ?? 'none');
};

/** 段的有效出场朝向（exitMotion 不受 direction 参数影响——方向参数只作用于入场） */
export const segExitMotion = (meta?: TemplateMeta): MotionDir => meta?.exitMotion ?? 'none';

export interface ChainPatch {
  /** 边界（第 i 段 → 第 i+1 段） */
  index: number;
  /** 选中的转场类型（未改动时等于原值） */
  transition: TransitionType;
  /** 转场方向档位（无方向转场/未改动时为 undefined） */
  transitionDirection?: number;
  /** 为下一段补齐的 customParams.direction（下段模板支持 direction 且未显式设置时） */
  nextSegmentDirection?: number;
  /** 链规则是否实际改动了这个边界 */
  changed: boolean;
  reason: string;
}

/**
 * 计算整条故事板的运动链补丁（不改对象，返回补丁表）。
 * @param segments 故事板片段
 * @param metas    templateId → TemplateMeta（取运动朝向标注与 direction 参数支持）
 */
export const planMotionChain = (
  segments: Array<Pick<Segment, 'templateId' | 'transition' | 'customParams'>>,
  metas: ReadonlyMap<string, TemplateMeta>,
): ChainPatch[] => {
  const patches: ChainPatch[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const cur = segments[i];
    const next = segments[i + 1];
    const curMeta = metas.get(cur.templateId);
    const nextMeta = metas.get(next.templateId);

    // 尊重显式选择：非默认转场（未设置/crossfade 是默认）的边界不动
    if (cur.transition && cur.transition !== 'crossfade') {
      patches.push({index: i, transition: cur.transition, changed: false, reason: '显式转场，保持不动'});
      continue;
    }

    const exitM = segExitMotion(curMeta);
    const enterM = segEnterMotion(next, nextMeta);
    let transition: TransitionType = 'crossfade';
    let dirCode: number | undefined;
    let reason = '两侧无方向，默认溶解';

    if (exitM !== 'none' && exitM === enterM) {
      // 两侧同向（水平或竖直）：panChase 横摇追拍——相机顺运动方向跟拍，出段加速出画、
      // 入段从前方入画减速到位，方向直接继承（两段速度曲线连续，运动不间断）
      transition = 'panChase';
      dirCode = MOTION_TO_DIR_CODE[exitM];
      reason = `两侧同向向${{up: '上', down: '下', left: '左', right: '右'}[exitM]}运动，panChase 追拍保持运动连续`;
    } else if (exitM !== 'none') {
      // velocityPush（速度匹配）：出段加速离场接住上段运动、切点速度峰值连续——
      // 比 push（easeInOut 对称）更贴合「上段带着动能出画」的衔接语义
      transition = 'velocityPush';
      dirCode = MOTION_TO_DIR_CODE[exitM];
      reason = `上段向${{up: '上', down: '下', left: '左', right: '右'}[exitM]}出，velocityPush 速度匹配保持运动方向`;
    } else if (enterM !== 'none') {
      transition = 'slide';
      dirCode = MOTION_TO_DIR_CODE[enterM];
      reason = `下段向${{up: '上', down: '下', left: '左', right: '右'}[enterM]}入，slide 顺接`;
    }

    // 下段模板支持 direction 参数且未显式设置：沿转场方向补齐飞入方向（运动不间断）
    let nextSegmentDirection: number | undefined;
    if (dirCode !== undefined && nextMeta?.paramSpecs?.some((s) => s.key === 'direction')) {
      const cur2 = next.customParams?.direction;
      if (cur2 === undefined || Math.round(cur2) === 0) nextSegmentDirection = dirCode;
    }

    const changed = transition !== 'crossfade' || nextSegmentDirection !== undefined;
    patches.push({index: i, transition, transitionDirection: dirCode, nextSegmentDirection, changed, reason});
  }
  return patches;
};

/**
 * 把运动链补丁应用到片段数组（返回新数组，不改原对象）。
 * 转场方向写入 transitionParams.direction（保留已有 transitionParams 其他键）。
 */
export const applyMotionChain = <T extends Pick<Segment, 'templateId' | 'transition' | 'customParams'> & {transitionParams?: Segment['transitionParams']}>(
  segments: T[],
  patches: ChainPatch[],
): T[] => {
  const out = segments.map((s) => ({...s}));
  for (const p of patches) {
    if (!p.changed) continue;
    const cur = out[p.index];
    cur.transition = p.transition;
    if (p.transitionDirection !== undefined) {
      cur.transitionParams = {...(cur.transitionParams ?? {}), direction: p.transitionDirection};
    }
    if (p.nextSegmentDirection !== undefined) {
      const next = out[p.index + 1];
      next.customParams = {...(next.customParams ?? {}), direction: p.nextSegmentDirection};
    }
  }
  return out;
};
