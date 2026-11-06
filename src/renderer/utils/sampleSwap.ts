/**
 * 示例工程「一键换成你的素材」共享工具（故事板提示条 / 新手教程共用）
 *
 * 弹系统媒体选择框（多选，主进程已探测宽高/时长/缩略图）→ replaceSampleMedia
 * 按段替换 → 状态栏提示结果。编码白名单警告口径与 VideoUploader 一致。
 */
import {useProjectStore} from '../store/projectStore';
import {useUIStore} from '../store/uiStore';

export const pickAndReplaceSampleMedia = async (): Promise<number> => {
  const selected = await window.api.selectVideos();
  if (!selected || selected.length === 0) return 0;
  const replaced = useProjectStore.getState().replaceSampleMedia(selected);
  useUIStore.getState().setStatusText(
    replaced > 0
      ? `已把 ${replaced} 个片段换成你的素材（Ctrl+Z 可撤销）`
      : '示例工程没有带素材位的片段，无需替换',
  );
  const codecWarnings = selected.filter((v) => v.codecWarning).map((v) => v.codecWarning as string);
  if (codecWarnings.length > 0) window.alert(codecWarnings.join('\n'));
  return replaced;
};
