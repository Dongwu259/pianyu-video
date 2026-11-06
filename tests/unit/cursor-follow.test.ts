/**
 * 鼠标轨迹采集（Phase 2）与 CursorFollow 模板（Phase 3）单元测试
 *
 * 覆盖：
 * - sampleTrack：线性插值 / 首尾钳位 / 空轨迹
 * - followCameraPath：滑动平均平滑（窗口外离群点不影响远处帧）、offsetMs（trimStart 对齐）
 * - cameraFrame：cover 缩放、居中点不平移、角落点钳位不露底、zoom=1 不平移、竖版画布
 * - dipToVideoPoint：DIP → 视频像素换算（带屏原点偏移与 scaleFactor）
 * - collectMediaPaths：cursorTrack sidecar 纳入媒体存在性检查
 * - projectStore：serializeProject 剥离 cursorPoints 保留 cursorTrack；
 *   applyLoadedProject 经 captureReadCursorTrack 回填 cursorPoints（读失败静默置 undefined）；
 *   CursorFollow 建段默认 layout（defaultLayout 覆盖）
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/cursor-follow.test.ts
 */

import assert from 'node:assert/strict';
import {sampleTrack, followCameraPath, cameraFrame, tiltCoverFactor, clickZoomEnvelope, spanToZoom, leadFocusY} from '../../src/remotion/utils/followCamera.ts';
import {dipToVideoPoint} from '../../src/shared/capture.ts';
import {generateDemoCursorClicks, generateDemoCursorTrack} from '../../src/shared/demo-cursor-track.ts';
import {collectMediaPaths} from '../../src/main/services/projectFile.ts';
import type {CursorClick, CursorPoint} from '../../src/shared/capture.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== sampleTrack ======

console.log('sampleTrack:');
{
  const pts: CursorPoint[] = [
    {t: 0, x: 100, y: 200},
    {t: 1000, x: 300, y: 400},
    {t: 3000, x: 900, y: 400},
  ];
  // 区间中点线性插值
  assert.deepEqual(sampleTrack(pts, 500), {x: 200, y: 300});
  assert.deepEqual(sampleTrack(pts, 2000), {x: 600, y: 400});
  // 命中采样点原样返回
  assert.deepEqual(sampleTrack(pts, 1000), {x: 300, y: 400});
  // 超出范围钳到首/末点
  assert.deepEqual(sampleTrack(pts, -50), {x: 100, y: 200});
  assert.deepEqual(sampleTrack(pts, 99999), {x: 900, y: 400});
  // 单点轨迹任意时刻返回该点
  assert.deepEqual(sampleTrack([{t: 100, x: 1, y: 2}], 500), {x: 1, y: 2});
  // 空轨迹回 (0,0)（调用方应判空，这里兜底不崩）
  assert.deepEqual(sampleTrack([], 500), {x: 0, y: 0});
  ok('插值 / 命中 / 首尾钳位 / 单点 / 空轨迹');
}

// ====== followCameraPath ======

console.log('followCameraPath:');
{
  // 3s @30fps = 90 帧；t≈1033ms 处有一个 300px 的离群尖峰
  const pts: CursorPoint[] = [
    {t: 0, x: 0, y: 0},
    {t: 1000, x: 0, y: 0},
    {t: 1033, x: 300, y: 0},
    {t: 1067, x: 0, y: 0},
    {t: 3000, x: 0, y: 0},
  ];
  // 不平滑（smoothSec=0 → 窗口 0）：原样按帧采样，尖峰被采到
  const raw = followCameraPath(pts, 90, 30, {smoothSec: 0});
  assert.equal(raw.length, 90);
  assert.ok(raw[31].cx > 250, `帧31应采到尖峰，实际 ${raw[31].cx}`);
  ok('smoothSec=0 时按帧原样采样');

  // 平滑（0.8s → ±12 帧窗口）：尖峰被平均压下去，窗口外远处帧不受影响
  const smooth = followCameraPath(pts, 90, 30, {smoothSec: 0.8});
  assert.ok(smooth[31].cx < 20, `尖峰应被平滑压低，实际 ${smooth[31].cx}`);
  assert.equal(smooth[5].cx, 0, '帧5 的平滑窗口（0..17）不含尖峰，应保持 0');
  assert.equal(smooth[89].cx, 0, '末帧远离尖峰，应保持 0');
  ok('滑动平均压低尖峰且窗口外帧不受影响');

  // offsetMs（trimStart 对齐）：帧 0 从偏移处开始查轨迹
  const pts2: CursorPoint[] = [
    {t: 0, x: 0, y: 0},
    {t: 5000, x: 100, y: 0},
    {t: 6000, x: 200, y: 0},
  ];
  const shifted = followCameraPath(pts2, 90, 30, {smoothSec: 0, offsetMs: 5000});
  assert.equal(shifted[0].cx, 100);  // t=5000
  assert.equal(shifted[30].cx, 200); // t=6000
  assert.equal(shifted[15].cx, 150); // t=5500 中点
  const unshifted = followCameraPath(pts2, 90, 30, {smoothSec: 0});
  assert.equal(unshifted[0].cx, 0, '无偏移时帧0 查 t=0');
  ok('offsetMs 把帧时间对齐到 trimStart 之后的轨迹区间');
}

// ====== cameraFrame ======

console.log('cameraFrame:');
{
  // 16:9 视频 + 16:9 画布
  const c = cameraFrame(960, 540, 1920, 1080, 1.4, 1920, 1080);
  assert.equal(c.scale, 1.4, '同比例 cover 基准为 1，zoom 直接相乘');
  assert.equal(c.translateX, 0);
  assert.equal(c.translateY, 0);
  ok('居中注视点：不平移，scale = cover × zoom');

  // 角落注视点：平移被钳到恰好不露底（视频左缘 = 画布左缘）
  const corner = cameraFrame(0, 0, 1920, 1080, 1.4, 1920, 1080);
  const w = 1920 * corner.scale;
  const h = 1080 * corner.scale;
  assert.equal(corner.translateX, (w - 1920) / 2);
  assert.equal(corner.translateY, (h - 1080) / 2);
  // 覆盖验证：视频显示矩形恰好包住画布
  assert.ok(1920 / 2 + corner.translateX - w / 2 <= 0 + 1e-9, '左缘不露底');
  assert.ok(1920 / 2 + corner.translateX + w / 2 >= 1920 - 1e-9, '右缘不露底');
  assert.ok(1080 / 2 + corner.translateY - h / 2 <= 0 + 1e-9, '上缘不露底');
  assert.ok(1080 / 2 + corner.translateY + h / 2 >= 1080 - 1e-9, '下缘不露底');
  ok('角落注视点：钳位到恰好覆盖画布');

  // zoom=1 同比例：任何注视点都不平移（显示尺寸 == 画布尺寸，无可移动余地）
  const z1 = cameraFrame(0, 0, 1920, 1080, 1, 1920, 1080);
  assert.equal(z1.translateX, 0);
  assert.equal(z1.translateY, 0);
  const z1b = cameraFrame(1920, 1080, 1920, 1080, 1, 1920, 1080);
  assert.equal(z1b.translateX, 0);
  assert.equal(z1b.translateY, 0);
  ok('zoom=1 同比例：任意注视点不平移');

  // 横屏视频进竖版画布：cover 按高度放大，水平方向有可移空间，右缘注视点钳到右缘恰好对齐
  const port = cameraFrame(1920, 540, 1920, 1080, 1, 1080, 1920);
  const cover = 1920 / 1080; // max(1080/1920, 1920/1080)
  assert.ok(Math.abs(port.scale - cover) < 1e-9);
  const pw = 1920 * port.scale;
  assert.ok(Math.abs(port.translateX - -(pw - 1080) / 2) < 1e-9, '右缘注视点钳到右缘对齐');
  assert.ok(1080 / 2 + port.translateX + pw / 2 >= 1080 - 1e-9, '右缘不露底');
  assert.equal(port.translateY, 0, '竖直方向显示高 == 画布高，不平移');
  ok('竖版画布：cover 取高度方向，水平钳位不露底');
}

// ====== tiltCoverFactor ======

console.log('tiltCoverFactor:');
{
  // 正面：无需补偿
  assert.equal(tiltCoverFactor(0, 0, 1200, 1920, 1080), 1);
  // 纯 rotateZ：数值解应与解析包围盒解一致（k = max(bboxW/W, bboxH/H)）
  const b = (20 * Math.PI) / 180;
  const analytic = Math.max(
    (1920 * Math.cos(b) + 1080 * Math.sin(b)) / 1920,
    (1920 * Math.sin(b) + 1080 * Math.cos(b)) / 1080,
  );
  const numeric = tiltCoverFactor(0, 20, 1200, 1920, 1080);
  assert.ok(Math.abs(numeric - analytic) < 0.01, `纯 rotateZ 应贴近解析解 ${analytic.toFixed(4)}，实际 ${numeric}`);
  // 镜像对称：符号翻转（单轴或双轴）覆盖倍率相同
  assert.equal(tiltCoverFactor(18, -8, 1200, 1920, 1080), tiltCoverFactor(-18, 8, 1200, 1920, 1080));
  assert.equal(tiltCoverFactor(18, 8, 1200, 1920, 1080), tiltCoverFactor(18, -8, 1200, 1920, 1080));
  assert.equal(tiltCoverFactor(-18, 8, 1200, 1920, 1080), tiltCoverFactor(18, -8, 1200, 1920, 1080));
  // 单调：角度越大补偿越大；组合角 > 单轴
  const f18 = tiltCoverFactor(18, 0, 1200, 1920, 1080);
  const f35 = tiltCoverFactor(35, 0, 1200, 1920, 1080);
  const fCombo = tiltCoverFactor(18, -8, 1200, 1920, 1080);
  assert.ok(f35 > f18 && f18 > 1, `单调性：${f35} 应大于 ${f18}`);
  assert.ok(fCombo > f18 && fCombo > tiltCoverFactor(0, -8, 1200, 1920, 1080));
  // 极端角度（参数上限 35°/20°）返回有限上界值，不发散（透视投影极限附近尽力而为）
  const extreme = tiltCoverFactor(35, 20, 1200, 1920, 1080);
  assert.ok(Number.isFinite(extreme) && extreme > f35 && extreme < 12, `极端角应有限：${extreme}`);
  // 竖版画布同样有限且 >1
  const portrait = tiltCoverFactor(18, -8, 1200, 1080, 1920);
  assert.ok(Number.isFinite(portrait) && portrait > 1 && portrait < 12);
  ok('正面=1 / 纯 rotateZ 贴解析解 / 镜像对称 / 单调 / 极端与竖版有限');
}

// ====== tiltCoverFactor Y 轴（C 项） ======

console.log('tiltCoverFactor·Y 轴:');
{
  // Y 符号镜像：左右侧倾覆盖倍率相同
  assert.equal(tiltCoverFactor(0, 0, 1200, 1920, 1080, 20), tiltCoverFactor(0, 0, 1200, 1920, 1080, -20));
  // Y 单调：侧倾越大补偿越大
  const y10 = tiltCoverFactor(0, 0, 1200, 1920, 1080, 10);
  const y20 = tiltCoverFactor(0, 0, 1200, 1920, 1080, 20);
  const y32 = tiltCoverFactor(0, 0, 1200, 1920, 1080, 32);
  assert.ok(y10 > 1 && y20 > y10 && y32 > y20 && Number.isFinite(y32) && y32 < 12,
    `Y 单调有限：${y10.toFixed(3)} < ${y20.toFixed(3)} < ${y32.toFixed(3)}`);
  // 三轴组合 > 任一双轴（深度系数叠加，近边更近）
  const combo3 = tiltCoverFactor(18, -8, 1200, 1920, 1080, 15);
  const pairXZ = tiltCoverFactor(18, -8, 1200, 1920, 1080);
  const pairXY = tiltCoverFactor(18, 0, 1200, 1920, 1080, 15);
  assert.ok(combo3 > pairXZ && combo3 > pairXY, `三轴组合 ${combo3.toFixed(3)} 应大于双轴 ${pairXZ.toFixed(3)}/${pairXY.toFixed(3)}`);
  // 旧签名兼容：不传 Y 时结果与扩展前完全一致（X/Z 语义不变）
  assert.equal(tiltCoverFactor(18, -8, 1200, 1920, 1080), tiltCoverFactor(18, -8, 1200, 1920, 1080, 0));
  ok('Y 镜像对称 / 单调有限 / 三轴组合最大 / 旧签名零回归');
}

// ====== dipToVideoPoint ======

console.log('dipToVideoPoint:');
{
  // 副屏在原点左侧（DIP x=-1920），150% 缩放：视频像素 = (DIP - 屏原点) × 1.5
  const disp = {x: -1920, y: 0, scaleFactor: 1.5};
  assert.deepEqual(dipToVideoPoint(-100, 50, disp), {x: 2730, y: 75});
  assert.deepEqual(dipToVideoPoint(-1920, 0, disp), {x: 0, y: 0});
  // 主屏无缩放：恒等
  assert.deepEqual(dipToVideoPoint(640, 360, {x: 0, y: 0, scaleFactor: 1}), {x: 640, y: 360});
  ok('带屏原点偏移与 scaleFactor 的 DIP → 视频像素换算');
}

// ====== collectMediaPaths：cursorTrack 纳入存在性检查 ======

console.log('collectMediaPaths:');
{
  const data: any = {
    aspectRatioId: '16:9',
    orientation: 'landscape',
    segments: [
      {
        id: 's1',
        templateId: 'CursorFollow',
        videos: [
          {id: 'c1', src: 'D:\\cap\\rec.webm', name: 'rec.webm', width: 1920, height: 1080, duration: 10, type: 'video', cursorTrack: 'D:\\cap\\rec.cursor.json'},
          {id: 'c2', src: 'D:\\cap\\plain.mp4', name: 'plain.mp4', width: 1920, height: 1080, duration: 5, type: 'video'},
        ],
        text: {title: ''},
        style: {},
        layout: {},
        duration: 8,
        transition: 'none',
      },
    ],
    bgm: null,
    logo: null,
    captionStyle: {},
    renderSettings: {},
    activeSegmentIndex: 0,
  };
  const paths = collectMediaPaths(data);
  assert.ok(paths.includes('D:\\cap\\rec.webm'));
  assert.ok(paths.includes('D:\\cap\\rec.cursor.json'), 'cursorTrack sidecar 应纳入媒体存在性检查');
  assert.ok(paths.includes('D:\\cap\\plain.mp4'));
  assert.equal(paths.length, 3);
  ok('cursorTrack 随 clip.src 一并收集');
}

// ====== clickZoomEnvelope：点击自动运镜包络 ======

console.log('clickZoomEnvelope:');
{
  const clicks: CursorClick[] = [
    {t: 1000, x: 500, y: 400, button: 1},
    {t: 5000, x: 800, y: 600, button: 1},
  ];
  const opts = {clickZoom: 1.8, holdSec: 1, easeSec: 0.5};
  // 首次点击前：恒等（amount 0 / boost 1 / click null）
  assert.deepEqual(clickZoomEnvelope(clicks, 500, opts), {amount: 0, boost: 1, click: null});
  // 空点击数组恒等
  assert.deepEqual(clickZoomEnvelope([], 5000, opts), {amount: 0, boost: 1, click: null});
  // 缓入中点：0 < amount < 1，boost 单调介于 1 与 clickZoom 之间
  const easing = clickZoomEnvelope(clicks, 1250, opts);
  assert.equal(easing.click, clicks[0]);
  assert.ok(easing.amount > 0 && easing.amount < 1, `缓入中点 amount 应在 (0,1)，实际 ${easing.amount}`);
  assert.ok(easing.boost > 1 && easing.boost < 1.8);
  // 保持期：amount = 1，boost = clickZoom
  const holding = clickZoomEnvelope(clicks, 2000, opts);
  assert.equal(holding.amount, 1);
  assert.equal(holding.boost, 1.8);
  // 缓出中点：0 < amount < 1
  const releasing = clickZoomEnvelope(clicks, 2750, opts);
  assert.ok(releasing.amount > 0 && releasing.amount < 1, `缓出中点 amount 应在 (0,1)，实际 ${releasing.amount}`);
  // 包络结束（0.5+1+0.5=2s 后）：归恒等
  assert.deepEqual(clickZoomEnvelope(clicks, 3100, opts), {amount: 0, boost: 1, click: null});
  // 连击接管：第二次点击后 active 切换
  const second = clickZoomEnvelope(clicks, 5100, opts);
  assert.equal(second.click, clicks[1]);
  assert.ok(second.amount > 0);
  // 两次点击之间（第一次包络结束、第二次未开始）：恒等
  assert.deepEqual(clickZoomEnvelope(clicks, 4000, opts), {amount: 0, boost: 1, click: null});
  // clickZoom=1 时 boost 恒 1（amount 仍反映包络，供注视点融合判 0 早退）
  const flat = clickZoomEnvelope(clicks, 2000, {clickZoom: 1, holdSec: 1, easeSec: 0.5});
  assert.equal(flat.boost, 1);
  assert.equal(flat.amount, 1);
  ok('恒等 / 缓入 / 保持 / 缓出 / 连击接管 / clickZoom=1');
}

// ====== generateDemoCursorClicks：演示点击推演 ======

console.log('generateDemoCursorClicks:');
{
  const pts = generateDemoCursorTrack({durationSec: 10, width: 1920, height: 1080, seed: 42});
  const clicks = generateDemoCursorClicks(pts);
  assert.ok(clicks.length >= 2, `10s 演示轨迹应推演出若干点击，实际 ${clicks.length}`);
  // 确定性：同种子同轨迹 → 同点击
  assert.deepEqual(generateDemoCursorClicks(pts), clicks);
  // 时间有序且在轨迹时长内；坐标在画面内
  for (let i = 0; i < clicks.length; i++) {
    const c = clicks[i];
    assert.ok(c.t >= 0 && c.t <= 10000);
    assert.ok(c.x >= 0 && c.x <= 1920 && c.y >= 0 && c.y <= 1080);
    if (i > 0) assert.ok(c.t > clicks[i - 1].t, '点击时间应严格递增');
  }
  // 点击应落在停顿位置（轨迹在点击时刻附近位置与点击坐标一致）
  for (const c of clicks) {
    const at = sampleTrack(pts, c.t);
    assert.ok(Math.hypot(at.x - c.x, at.y - c.y) < 20, '点击位置应与当时光标位置一致');
  }
  // 空/单点轨迹不产生点击
  assert.deepEqual(generateDemoCursorClicks([]), []);
  assert.deepEqual(generateDemoCursorClicks([{t: 0, x: 1, y: 1}]), []);
  ok('推演数量 / 确定性 / 边界 / 与轨迹一致 / 空输入');
}

// ====== leadFocusY：垂直引导注视点偏置（B3，随变临摹复盘） ======

console.log('leadFocusY:');
{
  // 1080 高视频 / 1080 高平面 / scale 1.25 → 可见高 = 864
  const scale = 1.25;
  // 上半区注视点（y=216，归一 0.2）→ 焦点下移（下方留白大，预留向下运动空间）
  const up = leadFocusY(216, 1080, scale, 1080, 2);
  assert.ok(up > 216, '上半区注视点 → 焦点下移');
  assert.ok(Math.abs(up - (216 + 0.32 * 0.3 * 864)) < 1e-9, '偏置 = k×(0.5−归一)×可见高');
  // 下半区 → 焦点上移（上方留白大）
  const down = leadFocusY(864, 1080, scale, 1080, 2);
  assert.ok(down < 864, '下半区注视点 → 焦点上移');
  // 纵向中线零偏置
  assert.equal(leadFocusY(540, 1080, scale, 1080, 2), 540);
  // 档位 0 = 关
  assert.equal(leadFocusY(216, 1080, scale, 1080, 0), 216);
  // 弱档偏置小于强档
  const weak = leadFocusY(216, 1080, scale, 1080, 1);
  assert.ok(Math.abs(weak - 216) < Math.abs(up - 216), '弱档偏置 < 强档');
  // zoom 越深可见越少 → 偏置越克制
  const deep = leadFocusY(216, 1080, 2.5, 1080, 2);
  assert.ok(Math.abs(deep - 216) < Math.abs(up - 216), '深 zoom 偏置更小');
  // 注视点越出画面按边界归一算（返回值仍是 cy+偏置）
  const beyond = leadFocusY(-500, 1080, scale, 1080, 2);
  assert.ok(Math.abs(beyond - (-500 + 0.32 * 0.5 * 864)) < 1e-9, '越界注视点钳到 0 归一');
  // 非法输入原样返回
  assert.equal(leadFocusY(216, 0, scale, 1080, 2), 216);
  assert.equal(leadFocusY(216, 1080, 0, 1080, 2), 216);
  ok('上/下偏置方向 / 公式精确 / 中线零偏置 / 档位与 zoom 克制 / 越界钳制 / 非法输入');
}

// ====== projectStore：序列化剥离 / 加载回填 / 默认 layout ======


console.log('projectStore:');
{
  // window stub：pathToClipSrc（getVideoHttpUrl）与 captureReadCursorTrack 用到
  const PTS = [
    {t: 0, x: 10, y: 20},
    {t: 33, x: 40, y: 60},
  ];
  const CLKS = [{t: 500, x: 40, y: 60, button: 1}];
  (globalThis as any).window = {
    api: {
      getVideoHttpUrl: async (p: string) => `http://127.0.0.1:1/video?path=${encodeURIComponent(p)}`,
      captureReadCursorTrack: async (filePath: string) =>
        filePath === 'D:\\cap\\rec.cursor.json'
          ? {version: 2, displayId: 1, videoWidth: 1920, videoHeight: 1080, points: PTS, clicks: CLKS}
          : null,
      getStore: async () => [],
      setStore: async () => true,
    },
    confirm: () => true,
  };
  const {useProjectStore, createEmptySegment} = await import('../../src/renderer/store/projectStore.ts');
  const S = useProjectStore.getState;

  // CursorFollow 建段默认 layout：全屏画幅（defaultLayout 覆盖 DEFAULT_LAYOUT）
  const seg = createEmptySegment('CursorFollow');
  assert.equal(seg.layout.videoWidthRatio, 1);
  assert.equal(seg.layout.videoHeightRatio, 1);
  assert.equal(seg.layout.rotateX, 0);
  // 无 defaultLayout 的模板不受影响
  const segK = createEmptySegment('KenBurns');
  assert.equal(segK.layout.videoWidthRatio, 0.6);
  assert.equal(segK.layout.rotateX, 5);
  ok('createEmptySegment 按模板 defaultLayout 覆盖建段 layout');

  // 首个模板选择同样重置 layout（建段入口之一）
  S().selectFirstTemplate('CursorFollow');
  assert.equal(S().layout.videoWidthRatio, 1);
  assert.equal(S().segments[0].layout.rotateX, 0);
  S().selectFirstTemplate('KenBurns');
  assert.equal(S().layout.videoWidthRatio, 0.6, '切回普通模板恢复 DEFAULT_LAYOUT');
  ok('selectFirstTemplate 同步重置工作副本与第 1 段 layout');

  // 序列化：cursorPoints（内存态大数组）剥离，cursorTrack（sidecar 路径）保留
  const segWithTrack = {
    ...createEmptySegment('CursorFollow'),
    videos: [
      {
        id: 'c1',
        src: 'http://127.0.0.1:1/video?path=' + encodeURIComponent('D:\\cap\\rec.webm'),
        name: 'rec.webm',
        width: 1920,
        height: 1080,
        duration: 10,
        type: 'video' as const,
        cursorTrack: 'D:\\cap\\rec.cursor.json',
        cursorPoints: PTS,
        cursorClicks: CLKS,
      },
    ],
  };
  useProjectStore.setState({segments: [segWithTrack], activeSegmentIndex: 0});
  const data = S().serializeProject();
  const savedClip = data.segments[0].videos[0] as any;
  assert.equal(savedClip.cursorTrack, 'D:\\cap\\rec.cursor.json', 'cursorTrack 应随工程落盘');
  assert.equal(savedClip.cursorPoints, undefined, 'cursorPoints 不应持久化');
  assert.equal(savedClip.cursorClicks, undefined, 'cursorClicks 不应持久化');
  assert.equal(savedClip.src, 'D:\\cap\\rec.webm', 'src 应还原为原始路径');
  assert.equal('cursorPoints' in savedClip, false, '序列化结果不含 cursorPoints 键');
  assert.equal('cursorClicks' in savedClip, false, '序列化结果不含 cursorClicks 键');
  ok('serializeProject 剥离 cursorPoints/cursorClicks、保留 cursorTrack');

  // 加载：经 captureReadCursorTrack 读 sidecar 回填 cursorPoints/cursorClicks（v2 文件）
  await S().applyLoadedProject('测试', data as any, null, []);
  const loadedClip = S().segments[0].videos[0] as any;
  assert.equal(loadedClip.cursorTrack, 'D:\\cap\\rec.cursor.json');
  assert.deepEqual(loadedClip.cursorPoints, PTS, 'cursorPoints 应由 sidecar 重建');
  assert.deepEqual(loadedClip.cursorClicks, CLKS, 'cursorClicks 应由 sidecar 重建');
  ok('applyLoadedProject 读 sidecar 回填 cursorPoints/cursorClicks');

  // 加载：sidecar 读失败（返回 null）静默置 undefined，不阻断
  const dataBroken = JSON.parse(JSON.stringify(data));
  dataBroken.segments[0].videos[0].cursorTrack = 'D:\\cap\\missing.cursor.json';
  await S().applyLoadedProject('测试', dataBroken as any, null, []);
  const brokenClip = S().segments[0].videos[0] as any;
  assert.equal(brokenClip.cursorTrack, 'D:\\cap\\missing.cursor.json', '路径字段保留');
  assert.equal(brokenClip.cursorPoints, undefined, '读失败静默置 undefined');
  ok('sidecar 缺失不阻断工程加载');
}

console.log(`\n共 ${passed} 项全部通过`);
