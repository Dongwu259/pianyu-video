/**
 * 新手引导教程的步骤表（GuidedTour 消费）
 *
 * 设计原则：带做，不是带看。第一步就让用户打开示例工程看到完整成片，
 * 每步的「主行动」按钮真的去执行（打开工程 / 换素材 / 开 AI 面板），
 * 讲解文字只做最小陪衬。跳过动作点「下一步」也成立（动作都是可选的捷径）。
 *
 * 每步指定：所在应用页面 appStep（教程推进时自动切换页面）、目标元素选择器 target
 * （用于定位指引卡与箭头，找不到时居中无箭头）、标题与正文、可选主行动 action。
 * 选择器尽量用语义 class（.genre-section 等）；没有稳定 class 的关键元素
 * 由组件挂 data-tour 属性（如 [data-tour="ai-btn"]）。
 */
import {useProjectStore} from '../store/projectStore';
import {pickAndReplaceSampleMedia} from '../utils/sampleSwap';

export interface TourAction {
  /** 按钮文案 */
  label: string;
  /** 执行动作；返回 false = 不推进（动作未完成，如用户取消）；缺省/true = 完成后进下一步 */
  run: () => Promise<boolean | void>;
}

export interface TourStep {
  /** 该步所在的应用页面：1 方向&模板 / 2 故事板编辑 / 3 渲染导出 */
  appStep: 1 | 2 | 3;
  /** 目标元素选择器（缺省 = 居中卡片无箭头） */
  target?: string;
  title: string;
  body: string;
  /** 主行动按钮（带做）：真的去执行一件事 */
  action?: TourAction;
}

export interface TourActions {
  /** 打开 AI 助手抽屉（App 持有面板显隐状态） */
  openAiPanel: () => void;
  /** 结束教程并写「已看」标记（动作内收尾时调用） */
  closeTour: () => void;
}

export const buildTourSteps = (actions: TourActions): TourStep[] => [
  {
    appStep: 1,
    title: '3 分钟出第一条片子',
    body: '别从零开始——点下面按钮打开内置示例工程：一条模板、文案、配乐都配好的完整片子。先看到结果，再把它改成你的。',
    action: {
      label: '打开示例工程',
      run: async () => {
        // 失败（资源缺失/用户留在当前工程）返回 false 停在本步；成功后工程自动跳到故事板页
        return useProjectStore.getState().openSampleProject();
      },
    },
  },
  {
    appStep: 2,
    target: '.se-top',
    title: '这就是完整的故事板',
    body: '每张卡片是一个片段：模板、文案、素材都在里面，点选后可在下方编辑。现在就把示例素材换成你自己的——视频、图片都行。',
    action: {
      label: '一键换成你的素材',
      run: async () => {
        await pickAndReplaceSampleMedia();
        // 换没换都推进：取消选择也不困住用户
      },
    },
  },
  {
    appStep: 2,
    target: '[data-tour="ai-btn"]',
    title: 'AI 一句话成片',
    body: '配置 AI 助手后，一句话就能让它选模板、写文案、配乐、渲染一条龙。还没配置也没关系——面板里有「演示编排」，不用 Key 先看效果。',
    action: {
      label: '打开 AI 助手看看',
      run: async () => {
        actions.openAiPanel();
        actions.closeTour();
        return false; // 面板已打开，教程到此收尾
      },
    },
  },
  {
    appStep: 3,
    target: '[data-tour="presets"]',
    title: '几秒出样片，满意再出正片',
    body: '「快速预览」540p 几秒出片确认节奏；「分享优化」小体积直发微信抖音；都满意了点「开始渲染」出 1080p 正片。不碰任何选项直接渲染也可以。',
  },
  {
    appStep: 3,
    title: '上手完成！',
    body: '示例工程已经在故事板里等着你：改文案、换素材、调模板，然后渲染导出——第一条片子就是你的了。教程可在「关于 → 重播新手教程」再看。',
    action: {
      label: '回故事板开始编辑',
      run: async () => {
        useProjectStore.getState().setStep(2);
        actions.closeTour();
        return false;
      },
    },
  },
];
