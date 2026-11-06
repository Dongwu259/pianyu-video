/**
 * 画幅适配布局原语（docs/template-aspect-spec.md P0/P1 处方落地的公共层）
 *
 * 基准口径：模板家族按 16:9（1920×1080）调校。更宽画幅（21:9）上「按画布宽度
 * 等比」的字号/尺寸会撑坏竖向版式（拉稀/贴底）；几何投影类在画幅偏离素材画幅时
 * cover 裁切会吃掉大块内容；底部锚定流在画幅变化时上方留大空腔。三件原语分别
 * 对应：宽画幅封顶 / cover 裁切度量 / 内容盒垂直重心提升。
 *
 * 纪律：所有原语在 16:9 及更窄画幅上恒为「无操作」（现役行为零漂移）——
 * 只有画幅真正偏离 16:9 时才改变输出。
 */

/** 16:9 基准宽高比（模板家族的调校基准） */
export const REF_ASPECT = 16 / 9;

/**
 * 宽画幅字号/尺寸封顶系数：比 16:9 更宽的画布上，把「按 canvasW 等比」的值压回
 * 16:9 等效值（视觉密度与 16:9 一致）；16:9 及更窄画幅恒 1。
 * 用法：size = canvasW * k * wideAspectCap(canvasW, canvasH)
 * （+1px 余量保证 16:9 整数尺寸走原值，浮点噪声不触顶）
 */
export const wideAspectCap = (canvasW: number, canvasH: number): number =>
  Math.min(1, (canvasH * REF_ASPECT + 1) / canvasW);

/**
 * cover 满幅铺装的裁切率（0=画幅同素材画幅无裁切；画幅更宽→裁上下，更窄→裁左右）。
 * 用于「裁切超阈值即降级窗口卡模式」的画幅感知分支（ScreenDemo 满幅取景）。
 */
export const coverCropFrac = (canvasW: number, canvasH: number, videoW: number, videoH: number): number => {
  const ca = canvasW / canvasH;
  const va = videoW / videoH;
  return 1 - Math.min(ca / va, va / ca);
};

/**
 * 内容盒垂直重心提升量（底部锚定流的「上方空腔」处方）：内容终态高度不足可用区
 * 的 fireBelow 比例时，把锚点上抬空腔的一半×0.9（仍略偏下，保留「往上长」的观感）；
 * 足够满则 0（现役行为零漂移）。
 */
export const cavityLift = (zoneH: number, contentH: number, fireBelow = 0.5): number =>
  contentH < zoneH * fireBelow ? ((zoneH - contentH) / 2) * 0.9 : 0;
