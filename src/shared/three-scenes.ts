/**
 * three-scenes - 3D 场景包注册表（运动/场景解耦的「场景」轴单一数据源）
 *
 * 设计（v28）：七款 3D 场景模板 = 纯「运动模板」（相机 + 展板动线是模板身份），
 * 环境场景抽成可独立选择的场景包（scene-packs.tsx 渲染端）。
 * - 模板新增 sceneStyle 参数（数值档位滑块，与 camSpeed/camEase 同机制），
 *   档位 → 本表下标；每款模板的 default = 它拆分前的原生场景（老工程零回归）。
 * - 新增场景 = 本表加一行 + scene-packs.tsx 加一个组件，七款模板自动可用。
 * - css：DOM 背景渐变（three canvas 透明，DOM 背景透出）；null = 用模板原默认背景。
 * - light：亮色场景（水墨纸底）——模板据此把悬浮 3D 标题从白字换成墨色字。
 */

export interface ThreeSceneMeta {
  /** 场景包 id（渲染端 dispatch 用，全小写英文） */
  id: string;
  /** 场景名（参数滑块档位标签） */
  label: string;
  /** DOM 背景渐变 CSS；null = 模板保持原默认背景（gradient-dark + 主题色晕染） */
  css: string | null;
  /** 亮色场景：模板的悬浮 3D 标题/副标题改用深色字（白字在纸底会隐形） */
  light?: boolean;
}

export const THREE_SCENES: ThreeSceneMeta[] = [
  {id: 'star', label: '星空', css: null},
  {id: 'galaxy', label: '银河', css: 'linear-gradient(160deg, #0B0716 0%, #150B2E 46%, #241245 78%, #0E0A20 100%)'},
  {id: 'city', label: '都市', css: null},
  {id: 'countryside', label: '乡村', css: 'linear-gradient(180deg, #241C33 0%, #3A2738 52%, #6B3A3C 82%, #8A5138 100%)'},
  {id: 'ancient', label: '古建', css: 'linear-gradient(180deg, #0B1026 0%, #141938 58%, #26203F 100%)'},
  {id: 'landscape', label: '山水', css: 'linear-gradient(180deg, #10222E 0%, #17333F 55%, #245262 86%, #2E6478 100%)'},
  {id: 'inkwash', label: '水墨', css: 'linear-gradient(180deg, #F4F0E5 0%, #EDE7D8 62%, #E3DBC7 100%)', light: true},
  {id: 'journey', label: '虚空', css: null},
  {id: 'plain', label: '纯净', css: null},
  // 棱镜：竖向三色光幕条带（青/品红/紫罗兰，半透明叠深紫夜底）——高能量发布会舞台。
  // 只许追加在末尾：sceneStyle 是数值档位持久化在用户工程里，插入中间会移位老工程档位含义。
  {id: 'prism', label: '棱镜', css: [
    'repeating-linear-gradient(90deg,',
    'rgba(45,212,191,0.26) 0%, rgba(45,212,191,0.52) 1.3%, rgba(45,212,191,0.26) 2.6%, rgba(10,7,20,0) 2.6%, rgba(10,7,20,0) 3.4%,',
    'rgba(232,121,249,0.26) 3.4%, rgba(232,121,249,0.52) 4.7%, rgba(232,121,249,0.26) 6.0%, rgba(10,7,20,0) 6.0%, rgba(10,7,20,0) 6.8%,',
    'rgba(167,139,250,0.26) 6.8%, rgba(167,139,250,0.52) 8.1%, rgba(167,139,250,0.26) 9.4%, rgba(10,7,20,0) 9.4%, rgba(10,7,20,0) 10.2%)',
    ', linear-gradient(180deg, #0E0A1E 0%, #160D2C 52%, #0B0716 100%)',
  ].join('')},
];

/** sceneStyle 参数的档位标签（从注册表拼：'场景(0星空/1银河/…)'，单一数据源） */
export const sceneParamLabel = (): string =>
  `场景(${THREE_SCENES.map((s, i) => `${i}${s.label}`).join('/')})`;

/** sceneStyle 档位钳制（越界回 0 星空；非有限值回 0） */
export const clampSceneIndex = (v: number): number => {
  const i = Math.round(Number.isFinite(v) ? v : 0);
  return i >= 0 && i < THREE_SCENES.length ? i : 0;
};

/** 场景是否亮色底（模板悬浮标题换墨色字） */
export const sceneIsLight = (scene: number): boolean => !!THREE_SCENES[clampSceneIndex(scene)]?.light;

/**
 * 每款模板的原生场景下标（= sceneStyle 参数 default）：
 * 旅程=虚空 / 星域=星空 / 城市=都市；艺廊/环台/隧道/中庭是封闭或自带地板的
 * 结构签名场景，原生 = 纯净（不加环境件，观感与拆分前一致）。
 */
export const NATIVE_SCENE: Record<string, number> = {
  CameraJourney3D: THREE_SCENES.findIndex((s) => s.id === 'journey'),
  Starfield3D: THREE_SCENES.findIndex((s) => s.id === 'star'),
  CityScape3D: THREE_SCENES.findIndex((s) => s.id === 'city'),
  GalleryHall3D: THREE_SCENES.findIndex((s) => s.id === 'plain'),
  OrbitCarousel3D: THREE_SCENES.findIndex((s) => s.id === 'plain'),
  TimeTunnel3D: THREE_SCENES.findIndex((s) => s.id === 'plain'),
  SpiralAtrium3D: THREE_SCENES.findIndex((s) => s.id === 'plain'),
};

/**
 * 场景 → 封闭结构（艺廊壳/隧道门框内里）的装潢色（画廊墙面/地板换装用）。
 * 只给非原生（用户主动换场景）时可见的差异；纯净 = 现状色。
 */
export const sceneHallSurfaces = (
  scene: number,
): {floor: string; wall: string; ceiling: string; endWall: string} => {
  switch (THREE_SCENES[clampSceneIndex(scene)]?.id) {
    case 'inkwash':
      return {floor: '#B8AE97', wall: '#E8E2D0', ceiling: '#DDD5C0', endWall: '#E0D9C5'};
    case 'landscape':
      return {floor: '#12333C', wall: '#173F4A', ceiling: '#0F2A33', endWall: '#153944'};
    case 'ancient':
      return {floor: '#221826', wall: '#3A2030', ceiling: '#1C1420', endWall: '#33202C'};
    case 'countryside':
      return {floor: '#2E2418', wall: '#3C2F1E', ceiling: '#241C12', endWall: '#362A1A'};
    case 'galaxy':
      return {floor: '#120B26', wall: '#1D1240', ceiling: '#0E0820', endWall: '#191038'};
    case 'prism':
      return {floor: '#140E26', wall: '#1A1233', ceiling: '#0E0A1C', endWall: '#171030'};
    default:
      return {floor: '#0A0F18', wall: '#0D1320', ceiling: '#070B12', endWall: '#0B101B'};
  }
};
