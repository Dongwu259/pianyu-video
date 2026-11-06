/**
 * 模板个性化参数读取工具
 *
 * 模板组件用法：
 *   import {makeParamReader} from '../utils/params';
 *   import {BRAND_INTRO_PARAMS} from '../../shared/template-registry';
 *
 *   const p = makeParamReader(BRAND_INTRO_PARAMS, props.params);
 *   const logoScale = p('logoScale'); // 用户未调时回退规格中的 default
 *
 * 约定：除规格中标明单位（°/s/px）的参数外，其余全部为「倍率」语义（1 = 模板内置默认）。
 */

import type {TemplateParamSpec} from '../../shared/types';

/**
 * 键名打字机：已警告过的 (参数表, 键) 组合只 warn 一次——Remotion 逐帧重建组件，
 * 不去重会刷屏（v4 实锤：stagePalette 键名错静默回退深蓝，这里补上回退的根因提示）
 */
const warnedKeys = new WeakMap<TemplateParamSpec[], Set<string>>();

/**
 * 生成参数读取函数。p(key) 返回用户设定值，未设定时返回规格默认值；
 * key 不在规格中时返回 1（倍率恒等），避免模板写错键名时画面崩坏，
 * 同时 console.warn 一次提示（模板自检的通用检查也会拦装配侧，见 shared/template-checkpoints）
 */
export const makeParamReader =
  (specs: TemplateParamSpec[], params?: Record<string, number>) =>
  (key: string): number => {
    const user = params?.[key];
    if (typeof user === 'number' && Number.isFinite(user)) return user;
    const spec = specs.find((s) => s.key === key);
    if (!spec) {
      let seen = warnedKeys.get(specs);
      if (!seen) {
        seen = new Set();
        warnedKeys.set(specs, seen);
      }
      if (!seen.has(key)) {
        seen.add(key);
        console.warn(`[params] 模板读取了参数表未定义的键「${key}」，按 1 处理（键名拼写错误会静默回退）`);
      }
    }
    return spec ? spec.default : 1;
  };

/**
 * direction 飞入方向档位（DIRECTION_PARAM_SPEC：0=自动=模板默认 1=上 2=下 3=左 4=右）
 * → 入场初始位移向量（元素从该方向飞入画位，dist 为位移幅度 px）。
 * 返回 null 表示「自动」——模板走自己内置的入场方式（零回归）。
 * 用法：entry ∈[0,1] 为入场进度时，translate = (1-entry) * vec。
 */
export const directionVector = (dir: number, dist: number): {x: number; y: number} | null => {
  switch (Math.round(dir)) {
    case 1: return {x: 0, y: -dist}; // 从上飞入（起点在画位上方）
    case 2: return {x: 0, y: dist};  // 从下
    case 3: return {x: -dist, y: 0}; // 从左
    case 4: return {x: dist, y: 0};  // 从右
    default: return null;
  }
};
