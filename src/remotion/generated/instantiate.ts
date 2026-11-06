/**
 * AI 生成模板实例化器：编译产物（JS 字符串）→ React 组件。
 *
 * 安全模型（与 shared/generated-template.ts 的静态扫描配套）：
 * - 源码阶段：黑名单扫描 + 禁止 import —— 编译产物里不存在任何模块引用；
 * - 实例化阶段：new Function 的参数列表就是组件能看到的全部世界——
 *   React、remotion 渲染钩子、设计令牌、AnimatedText 原语、运动 token、
 *   three.js 3D 原语（ThreeStage/ThreeText/TurntableModel 等，动画内部已帧驱动），
 *   不传 document/window/fetch 等任何宿主能力（严格模式下函数内 this=undefined）；
 * - 运行阶段：GeneratedErrorBoundary 捕获渲染异常回退占位；
 *   Remotion delayRender 超时熔断兜住失控渲染。
 *
 * 预览（Electron 渲染进程）与整片渲染（Remotion headless Chrome）走同一入口，
 * 两处都需要 CSP 允许 eval（index.html script-src 已加 'unsafe-eval'）。
 *
 * 结果按编译产物字符串缓存：同一模板反复渲染只实例化一次（Map 上限 64 条 FIFO）。
 */

import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  Video,
  interpolate,
  random,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {VIDEO_DESIGN, getBrandPalette, getScaledTokens} from '../config/designTokens';
import {SPRINGS, STAGGER, easeOutQuint} from '../animations/motion';
import {ThreeStage} from '../three/ThreeStage';
import {ThreeAmbience} from '../three/ThreeAmbience';
import {TurntableModel} from '../three/TurntableModel';
import {ThreeText} from '../three/ThreeText';
import {PhoneShell, LaptopShell, DEVICE_SCREEN} from '../three/deviceGeometry';

/** 注入作用域（名字与值一一对应；新增能力时两侧同步加，并更新 GENERATED_TSX_CONTRACT） */
const SCOPE_NAMES = [
  'React',
  'useCurrentFrame',
  'useVideoConfig',
  'spring',
  'interpolate',
  'Sequence',
  'AbsoluteFill',
  'Img',
  'Video',
  'OffthreadVideo',
  'Audio',
  'Easing',
  'random',
  'AnimatedText',
  'VIDEO_DESIGN',
  'getScaledTokens',
  'getBrandPalette',
  'SPRINGS',
  'STAGGER',
  'easeOutQuint',
  'ThreeStage',
  'ThreeAmbience',
  'TurntableModel',
  'ThreeText',
  'PhoneShell',
  'LaptopShell',
  'DEVICE_SCREEN',
] as const;

const SCOPE_VALUES: unknown[] = [
  React,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Sequence,
  AbsoluteFill,
  Img,
  Video,
  OffthreadVideo,
  Audio,
  Easing,
  random,
  AnimatedText,
  VIDEO_DESIGN,
  getScaledTokens,
  getBrandPalette,
  SPRINGS,
  STAGGER,
  easeOutQuint,
  ThreeStage,
  ThreeAmbience,
  TurntableModel,
  ThreeText,
  PhoneShell,
  LaptopShell,
  DEVICE_SCREEN,
];

const CACHE_MAX = 64;
const cache = new Map<string, React.ComponentType<Record<string, unknown>> | null>();

/**
 * 编译产物 → 组件；失败（语法/顶层抛错/未定义 GeneratedTemplate）返回 null。
 * 注意：这里只能捕获顶层错误，组件体内错误由渲染时的错误边界兜底。
 */
export const instantiateGenerated = (
  compiled: string,
): React.ComponentType<Record<string, unknown>> | null => {
  const hit = cache.get(compiled);
  if (hit !== undefined) return hit;
  let comp: React.ComponentType<Record<string, unknown>> | null = null;
  try {
    const factory = new Function(
      ...SCOPE_NAMES,
      `"use strict";\n${compiled}\n;return typeof GeneratedTemplate === 'function' ? GeneratedTemplate : null;`,
    );
    const result = factory(...SCOPE_VALUES);
    comp = typeof result === 'function' ? (result as React.ComponentType<Record<string, unknown>>) : null;
  } catch (err) {
    console.warn('[gen-template] 实例化失败:', err);
    comp = null;
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(compiled, comp);
  return comp;
};
