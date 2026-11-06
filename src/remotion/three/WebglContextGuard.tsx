/**
 * WebglContextGuard - WebGL 上下文丢失防护（挂在 ThreeCanvas 子树内）
 *
 * 产品级根因（8GB 低显存机器实测）：GPU 显存压力 → Chromium 重置 GPU 进程 →
 * three canvas 的 WebGL 上下文丢失 → 场景全黑但渲染循环照常跑 = 「渲染静默死亡」
 * （预览黑屏 / 导出整段黑帧，无任何报错）。Mac 移植后低端集显设备同类。
 *
 * 防护两条腿：
 * 1. webglcontextlost 上 **preventDefault**——不拦下这个事件，浏览器就永远不会尝试
 *    恢复上下文（webglcontextrestored 永不触发）。three 0.180 的 WebGLRenderer 自带
 *    同款防护；这里显式再来一份 = 对 three 版本行为变化 / 裸 canvas 的双保险。
 * 2. **上下文恢复重试**：恢复事件到了、或丢失后迟迟不恢复（GPU 进程没回来），
 *    都回调 onContextRebuild —— 上层用 key 重挂 ThreeCanvas 子树，换新上下文
 *    从零重建（three 恢复时只重置 GL 状态，PMREM 环境反射这类「只渲染一次」的
 *    资源不会重建，恢复后仍是黑屏——整树重挂是唯一可靠重建方式）。
 *
 * 上层（ThreeStage）带重试上限，防 GPU 彻底死亡时的无限重挂循环。
 */
import React, {useEffect, useRef} from 'react';
import {useThree} from '@react-three/fiber';

export interface WebglContextGuardProps {
  /** 需要重建上下文时回调（恢复事件或丢失超时）；上层 bump key 重挂 ThreeCanvas */
  onContextRebuild?: (reason: 'restored' | 'lost-timeout') => void;
  /** 丢失后等多久仍未恢复就强制换新上下文（毫秒；<=0 关闭超时通道，只走恢复事件） */
  lostTimeoutMs?: number;
}

export const WebglContextGuard: React.FC<WebglContextGuardProps> = ({onContextRebuild, lostTimeoutMs = 3000}) => {
  const {gl} = useThree();
  // 回调走 ref：上层 setState 引起重建时监听器不用反复解绑重挂
  const rebuildRef = useRef(onContextRebuild);
  rebuildRef.current = onContextRebuild;
  useEffect(() => {
    const canvas = gl.domElement;
    let timer: number | undefined;
    const onLost = (e: Event) => {
      // 必须拦下：否则浏览器认为应用不打算恢复，context 永久失效
      e.preventDefault();
      console.warn('[ThreeStage] WebGL 上下文丢失（低显存/GPU 重置常见）——已 preventDefault，等待恢复或超时重建');
      if (lostTimeoutMs > 0) {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = undefined;
          console.warn(`[ThreeStage] 上下文 ${lostTimeoutMs}ms 未恢复——废弃旧 canvas，换新上下文重建`);
          rebuildRef.current?.('lost-timeout');
        }, lostTimeoutMs);
      }
    };
    const onRestored = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      console.warn('[ThreeStage] WebGL 上下文已恢复——重挂子树重建一次性 GL 资源（PMREM 环境反射等）');
      rebuildRef.current?.('restored');
    };
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      canvas.removeEventListener('webglcontextlost', onLost, false);
      canvas.removeEventListener('webglcontextrestored', onRestored, false);
    };
  }, [gl, lostTimeoutMs]);
  return null;
};
