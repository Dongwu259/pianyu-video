/**
 * Splitter - 可拖拽分隔条（可复用）。
 *
 * - orientation='vertical'：竖条，夹在左右两区之间，左右拖（col-resize）。
 * - orientation='horizontal'：横条，夹在上下两区之间，上下拖（row-resize）。
 * 拖拽以 pointer 事件实现，按增量 delta 回调（每次 move 报自上一位置的位移），
 * 调用方据此增减尺寸并自行钳制范围。拖拽时 body 设 none-select 防选中文字。
 */

import React, {useCallback, useEffect, useRef} from 'react';
import './Splitter.css';

interface Props {
  orientation: 'vertical' | 'horizontal';
  onDelta: (dx: number, dy: number) => void;
}

export const Splitter: React.FC<Props> = ({orientation, onDelta}) => {
  // 进行中拖拽的清理函数；组件卸载时兜底执行，防止 window 监听和 userSelect 残留
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const onDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // 拖拽期间禁用全局文字选中（避免拖到帧数/标签上选中文字）
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = 'none';

      let lastX = e.clientX;
      let lastY = e.clientY;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - lastX;
        const dy = ev.clientY - lastY;
        lastX = ev.clientX;
        lastY = ev.clientY;
        if (dx !== 0 || dy !== 0) onDelta(dx, dy);
      };
      // pointerup 与 pointercancel（系统中断触控/笔输入）都走同一收尾
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        document.body.style.userSelect = prevUserSelect;
        cleanupRef.current = null;
      };
      cleanupRef.current = onUp;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [onDelta],
  );

  return (
    <div
      className={`splitter ${orientation}`}
      onPointerDown={onDown}
      role="separator"
      aria-orientation={orientation}
    />
  );
};

export default Splitter;
