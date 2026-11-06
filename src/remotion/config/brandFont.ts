/**
 * 内置品牌字体加载（全部许可允许随软件分发）
 *
 * 字体清单（resources/fonts/，许可证文本见 resources/fonts/licenses/）：
 * - MiSans Regular/Bold（小米免费商用字体）—— 缺省「商业冷峻」氛围，中英文混排
 * - 霞鹜文楷 LXGW WenKai Regular/Medium（SIL OFL 1.1）—— 「温暖手写」氛围
 *   （官方字重只有 Light/Regular/Medium；700 的粗体请求按 CSS 字重匹配落到 Medium）
 * - Poppins Regular/SemiBold/Bold（SIL OFL 1.1）—— 「英文展示」氛围（几何无衬线）
 * - JetBrains Mono Regular/Bold（SIL OFL 1.1）—— 等宽栈首选（代码终端/科技等宽氛围）
 *
 * 字体文件以资源 URL 形式打包进 bundle（Remotion webpack asset/resource、vite asset），
 * headless 渲染与 Player 预览加载同一份字体文件，保证两边文字渲染一致。
 * 加载失败时静默回退系统字体栈（见 designTokens.ts 各氛围的字体栈后备）。
 */

import {loadFont} from '@remotion/fonts';
import {BRAND_FONT_FAMILY} from './designTokens';
import misansRegularUrl from '../../../resources/fonts/MiSans-Regular.woff2';
import misansBoldUrl from '../../../resources/fonts/MiSans-Bold.woff2';
import wenkaiRegularUrl from '../../../resources/fonts/LXGWWenKai-Regular.ttf';
import wenkaiMediumUrl from '../../../resources/fonts/LXGWWenKai-Medium.ttf';
import poppinsRegularUrl from '../../../resources/fonts/Poppins-Regular.ttf';
import poppinsSemiBoldUrl from '../../../resources/fonts/Poppins-SemiBold.ttf';
import poppinsBoldUrl from '../../../resources/fonts/Poppins-Bold.ttf';
import jbMonoRegularUrl from '../../../resources/fonts/JetBrainsMono-Regular.ttf';
import jbMonoBoldUrl from '../../../resources/fonts/JetBrainsMono-Bold.ttf';

interface FontEntry {
  family: string;
  url: string;
  weight: '400' | '500' | '600' | '700';
  format: 'woff2' | 'truetype';
}

const FONT_ENTRIES: readonly FontEntry[] = [
  {family: BRAND_FONT_FAMILY, url: misansRegularUrl, weight: '400', format: 'woff2'},
  {family: BRAND_FONT_FAMILY, url: misansBoldUrl, weight: '700', format: 'woff2'},
  {family: 'LXGW WenKai', url: wenkaiRegularUrl, weight: '400', format: 'truetype'},
  {family: 'LXGW WenKai', url: wenkaiMediumUrl, weight: '500', format: 'truetype'},
  {family: 'Poppins', url: poppinsRegularUrl, weight: '400', format: 'truetype'},
  {family: 'Poppins', url: poppinsSemiBoldUrl, weight: '600', format: 'truetype'},
  {family: 'Poppins', url: poppinsBoldUrl, weight: '700', format: 'truetype'},
  {family: 'JetBrains Mono', url: jbMonoRegularUrl, weight: '400', format: 'truetype'},
  {family: 'JetBrains Mono', url: jbMonoBoldUrl, weight: '700', format: 'truetype'},
];

let started = false;

/**
 * 在 Remotion bundle 入口加载全部内置字体（root.tsx 调用）
 * 走 @remotion/fonts 的 loadFont → delayRender，确保渲染首帧前字体就绪
 */
export const loadBrandFontForBundle = (): void => {
  if (started) return;
  started = true;
  FONT_ENTRIES.forEach((f) => {
    loadFont({family: f.family, url: f.url, weight: f.weight, format: f.format});
  });
};

/**
 * 在 Electron 渲染进程加载全部内置字体（Player 预览用，index.tsx 调用）
 * 直接用 FontFace，不占用 delayRender 句柄；失败静默回退系统字体栈
 */
export const loadBrandFontForPreview = (): void => {
  if (started || typeof document === 'undefined') return;
  started = true;
  FONT_ENTRIES.forEach((f) => {
    const face = new FontFace(f.family, `url('${f.url}') format('${f.format}')`, {weight: f.weight});
    face
      .load()
      .then((loaded) => document.fonts.add(loaded))
      .catch(() => {
        // 字体加载失败：回退系统字体栈（氛围预设栈里有完整后备）
      });
  });
};
