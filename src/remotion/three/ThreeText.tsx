/**
 * ThreeText - 真 3D 挤出文字（opentype.js 运行时字形解析 + three ExtrudeGeometry）
 *
 * 与 CSS 挤出（CoverOverlay text-shadow 堆叠 / GroundScene 切片）的本质区别：
 * 字形轮廓真挤出成几何体，有真实倒角、侧面、光照高光，随相机运镜产生正确透视。
 *
 * 字体管线：
 * - 字体文件复用 brandFont.ts 的 asset URL 打包机制（bundle/预览同一份 ttf）
 * - 含 CJK → 霞鹜文楷（LXGWWenKai-Regular.ttf，OFL）；纯拉丁 → Poppins-Bold.ttf
 * - opentype.js 解析 ttf → 逐字 getPath().toPathData() → SVGLoader 转 THREE.Shape
 *   （g transform scale(1,-1) 在 SVG 层完成 y 轴翻转，挤出后法线/绕序天然正确，
 *   且孔洞（口/日/B 等）由 SVGLoader 的绕序检测正确归类）
 * - 字体 promise 与字形 geometry 均模块级缓存；加载经 delayRender 等齐（无首帧空字）
 *
 * 确定性：逐字入场用 useCurrentFrame() 插值（spring 风格 easeOutBack），禁时钟。
 */

import React, {useEffect, useMemo, useState} from 'react';
import * as THREE from 'three';
import {SVGLoader} from 'three/examples/jsm/loaders/SVGLoader.js';
import opentype from 'opentype.js';
import {useCurrentFrame, useDelayRender, interpolate} from 'remotion';
import wenkaiRegularUrl from '../../../resources/fonts/LXGWWenKai-Regular.ttf';
import poppinsBoldUrl from '../../../resources/fonts/Poppins-Bold.ttf';
import huangyouUrl from '../../../resources/fonts/ZCOOLQingKeHuangYou-Regular.ttf';
import xiaoweiUrl from '../../../resources/fonts/ZCOOLXiaoWei-Regular.ttf';
import mashanUrl from '../../../resources/fonts/MaShanZheng-Regular.ttf';
import kuaileUrl from '../../../resources/fonts/ZCOOLKuaiLe-Regular.ttf';

/**
 * 3D 标题字体 url 表（与 title-fonts.ts 的 THREE_TITLE_FONT_LABELS 按下标一一对应；
 * 全部含 CJK，拉丁字符也直接取自该字体）。档位语义见 title-fonts.ts。
 */
const TITLE_FONT_URLS = [
  wenkaiRegularUrl,
  huangyouUrl,
  xiaoweiUrl,
  mashanUrl,
  kuaileUrl,
];

// ====== 字体加载（模块级 promise 缓存） ======
const fontCache = new Map<string, Promise<opentype.Font>>();
const loadOpentypeFont = (url: string): Promise<opentype.Font> => {
  let p = fontCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => opentype.parse(buf));
    fontCache.set(url, p);
  }
  return p;
};

const svgLoader = new SVGLoader();

/** 字形轮廓 → THREE.Shape[]（y 翻转 + 孔洞归类在 SVGLoader 内完成）；xShift 平移笔位原点 */
const glyphShapes = (font: opentype.Font, char: string, fontSize: number, xShift = 0): THREE.Shape[] => {
  const d = font.getPath(char, xShift, 0, fontSize).toPathData(2);
  if (!d || d.indexOf('M') < 0) return []; // 空格等无轮廓字符
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(1 -1)"><path d="${d}"/></g></svg>`;
  const data = svgLoader.parse(svg);
  const shapes: THREE.Shape[] = [];
  for (const p of data.paths) shapes.push(...SVGLoader.createShapes(p));
  return shapes;
};

// ====== 字形 geometry 缓存（同参数字符只挤一次） ======
const geomCache = new Map<string, THREE.ExtrudeGeometry>();
const getCharGeometry = (
  font: opentype.Font,
  char: string,
  fontSize: number,
  depth: number,
): THREE.ExtrudeGeometry | null => {
  const key = `${char}|${fontSize}|${depth}`;
  const hit = geomCache.get(key);
  if (hit) return hit;
  // 关键：字形路径以「笔位原点」起笔（墨迹从原点向右延伸，不对称于步进框），
  // 而布局层把网格放在步进框中心（item.x = 框中心）——不预移 -adv/2 的话
  // 每个字整体右移半个步进宽（大标题偏右 ~5% 画宽、混排字距忽宽忽窄的根因）。
  const adv = font.getAdvanceWidth(char, fontSize);
  const shapes = glyphShapes(font, char, fontSize, -adv / 2);
  if (shapes.length === 0) return null;
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * 0.08,
    bevelSize: fontSize * 0.012,
    bevelSegments: 2,
    curveSegments: 8,
  });
  geomCache.set(key, g);
  return g;
};

const hasCJK = (text: string): boolean => /[⺀-鿿豈-﫿　-〿＀-￯]/u.test(text);

// ====== 正面/侧面材质缓存（帧驱动重渲染频繁，不能每帧新建） ======
const matCache = new Map<string, [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial]>();
const getTextMaterials = (color: string, side: string): [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] => {
  const key = `${color}|${side}`;
  const hit = matCache.get(key);
  if (hit) return hit;
  const mats: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] = [
    new THREE.MeshStandardMaterial({color, roughness: 0.28, metalness: 0.35}),
    new THREE.MeshStandardMaterial({color: side, roughness: 0.45, metalness: 0.5}),
  ];
  matCache.set(key, mats);
  return mats;
};

export interface ThreeTextProps {
  text: string;
  /** 字高（three 世界单位，约等于大写字母高） */
  size?: number;
  /** 挤出深度（three 世界单位） */
  depth?: number;
  /** 正面颜色 */
  color?: string;
  /** 侧面颜色（缺省 = 正面加深） */
  sideColor?: string;
  /** 字间距（字高倍率） */
  letterSpacing?: number;
  /** 整行宽度上限（three 世界单位，超出整体缩放） */
  maxWidth?: number;
  /** 逐字入场：起始帧与间隔帧（0 = 全部立即出现） */
  startFrame?: number;
  stagger?: number;
  /** 整体位置 */
  position?: [number, number, number];
  /** 3D 字体档位（THREE_TITLE_FONTS 下标；0 = 自动：含 CJK 用文楷、纯拉丁用 Poppins） */
  fontIndex?: number;
}

/** 加深颜色（侧面缺省色用，hex #RRGGBB 按 factor 压暗） */
const darken = (hex: string, factor: number): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
};

export const ThreeText: React.FC<ThreeTextProps> = ({
  text,
  size = 1.1,
  depth = 0.34,
  color = '#F5F8FF',
  sideColor,
  letterSpacing = 0.06,
  maxWidth = 11,
  startFrame = 8,
  stagger = 3,
  position = [0, 0, 0],
  fontIndex = 0,
}) => {
  const frame = useCurrentFrame();
  const {delayRender, continueRender} = useDelayRender();
  const fontUrl =
    fontIndex > 0 && TITLE_FONT_URLS[fontIndex]
      ? TITLE_FONT_URLS[fontIndex]
      : hasCJK(text)
        ? wenkaiRegularUrl
        : poppinsBoldUrl;
  const [font, setFont] = useState<opentype.Font | null>(null);

  useEffect(() => {
    const handle = delayRender('ThreeText: 加载字形字体');
    let alive = true;
    loadOpentypeFont(fontUrl)
      .then((f) => {
        if (alive) setFont(f);
      })
      .catch(() => {})
      .finally(() => continueRender(handle));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontUrl]);

  // 逐字布局：x 累计排版（opentype advance width），整体居中
  const layout = useMemo(() => {
    if (!font) return null;
    const fontSize = 100; // 固定排版字号，世界尺寸由 group scale 归一
    const chars = [...text];
    const advances = chars.map((c) => font.getAdvanceWidth(c, fontSize) + fontSize * letterSpacing);
    const total = advances.reduce((a, b) => a + b, 0) - fontSize * letterSpacing;
    let x = -total / 2;
    const items = chars.map((c, i) => {
      const item = {char: c, x: x + advances[i] / 2, index: i};
      x += advances[i];
      return item;
    });
    const worldScale = Math.min(size / fontSize, maxWidth / total);
    return {items, worldScale, fontSize};
  }, [font, text, size, maxWidth, letterSpacing]);

  if (!font || !layout) return null;

  const side = sideColor ?? darken(color, 0.45);
  // 材质按颜色 memo（帧驱动重渲染频繁，避免每帧新建 GPU 材质）
  const mats = getTextMaterials(color, side);

  return (
    <group position={position} scale={layout.worldScale}>
      {layout.items.map((item) => {
        const geom = getCharGeometry(font, item.char, layout.fontSize, depth / layout.worldScale);
        if (!geom) return null; // 空格等
        // 逐字入场：从后方弹入（帧驱动确定性）
        const enter = interpolate(frame, [startFrame + item.index * stagger, startFrame + item.index * stagger + 12], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2), // easeOutBack
        });
        return (
          <mesh
            key={item.index}
            geometry={geom}
            material={mats}
            position={[item.x, 0, (1 - enter) * -260]}
            scale={[Math.max(0.001, 0.4 + 0.6 * enter), Math.max(0.001, 0.4 + 0.6 * enter), 1]}
          />
        );
      })}
    </group>
  );
};
