/**
 * appStatus.ts — get_app_status 的唯一实现（MCP 桥与内置模型执行器共用）
 *
 * 2026-11-03 EDGE 面 26→29：get_app_status 此前只是 MCP 扩展工具（EXTRA_MCP_TOOLS），
 * 内置模型即使调它也会落「未知工具」。收编时把实现抽到这里，两处共用同一份状态组装，
 * 避免 MCP 通道与内置模型回执分叉。
 */
import {useProjectStore} from '../store/projectStore';
import {currentContentFingerprint} from '../render/contentFingerprint';
import type {ToolExecResult} from './toolExecutors';

export const getAppStatus = async (): Promise<ToolExecResult> => {
  const st = useProjectStore.getState();
  const info = await window.api.getAppInfo().catch(() => null);
  // 渲染结果回读：上次渲染的内容指纹 vs 当前内容指纹（即算即比），确认「成片是不是刚改完的版本」
  const last = st.lastRenderInfo;
  const matchesCurrent = last ? last.fingerprint === currentContentFingerprint(st) : false;
  // 代理转码 job（mxf/超大/4K 素材；进行中/失败优先展示，ready 带代理路径）
  const proxyJobs = await window.api.proxyStatus().catch(() => [] as Array<{sourcePath: string; status: string; percent?: number}>);
  const activeProxy = proxyJobs.filter((j) => j.status !== 'ready');
  return {
    result: {
      appVersion: info?.version ?? null,
      license: st.licenseStatus
        ? {
            entitlement: st.licenseStatus.entitlement,
            plan: st.licenseStatus.plan,
            daysLeft: st.licenseStatus.daysLeft,
          }
        : null,
      projectName: st.projectName,
      isDirty: st.isDirty,
      segmentCount: st.segments.length,
      isRendering: st.isRendering,
      renderProgress: st.renderProgress,
      renderOutputPath: st.renderOutputPath || null,
      lastRender: last
        ? {...last, matchesCurrent, dirtySinceRender: !matchesCurrent}
        : null,
      // 代理转码进度（import_segment_media 响应提示轮询此字段；全部 ready 时给计数即可）
      ...(proxyJobs.length > 0 ? {proxyJobs: activeProxy.length > 0
        ? activeProxy.map((j) => ({sourcePath: j.sourcePath, status: j.status, ...(j.percent !== undefined ? {percent: j.percent} : {}), ...(j.status === 'failed' && (j as {error?: string}).error ? {error: (j as {error?: string}).error} : {})}))
        : `全部就绪（${proxyJobs.length} 个素材代理 ready）`} : {}),
      // 全自动流水线进度（run_auto_pipeline 启动后轮询此字段）
      ...(st.autoPipeline ? {autoPipeline: {
        status: st.autoPipeline.status,
        steps: st.autoPipeline.steps.map((s) => ({key: s.key, label: s.label, status: s.status, ...(s.note ? {note: s.note} : {})})),
        log: st.autoPipeline.log.slice(0, 12),
        outputs: st.autoPipeline.outputs || null,
        ...(st.autoPipeline.error ? {error: st.autoPipeline.error} : {}),
      }} : {}),
    },
  };
};
