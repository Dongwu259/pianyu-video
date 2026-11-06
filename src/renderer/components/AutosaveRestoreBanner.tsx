/**
 * AutosaveRestoreBanner — 自动保存恢复横幅（非阻塞）。
 *
 * 启动时若检测到上次异常退出留下的 autosave.vtproj，在右下角浮出横幅：
 * 「恢复」重载该工程并立即回写 autosave（见 handleRestore 注释），「忽略」丢弃并清除。
 *
 * 为什么不用 window.confirm：同步弹窗会冻结渲染进程主线程——MCP 桥的工具
 * 执行（mcp:execute）也在渲染进程里跑，弹窗不点掉 agent 的调用就一直挂到
 * 超时（实测踩坑）。改成非阻塞横幅后，MCP 会话启动即完全可用，无需 GUI 参与；
 * 桌面用户也只是从模态弹窗换成不打断操作的角标横幅。
 *
 * 用户或 agent 已开始编辑（isDirty 置真）时横幅自动放弃：此时恢复会覆盖
 * 已进行的工作，不打扰比恢复更重要。
 */

import React, {useEffect, useRef, useState} from 'react';
import {History} from 'lucide-react';
import {useProjectStore, DEFAULT_PROJECT_NAME} from '../store/projectStore';
import type {OpenProjectResult} from '../../main/services/projectFile';
import './AutosaveRestoreBanner.css';

export const AutosaveRestoreBanner: React.FC = () => {
  const [offer, setOffer] = useState<OpenProjectResult | null>(null);
  // StrictMode 下 effect 执行两次，用 ref 保证每会话只检测一次
  const checkedRef = useRef(false);
  const isDirty = useProjectStore((s) => s.isDirty);

  // 启动检测（一次）：读到 autosave 就挂横幅，不再弹任何模态
  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    (async () => {
      try {
        const res = await window.api.loadAutosave();
        if (res && res.data) setOffer(res);
      } catch {
        // 检测失败不影响启动
      }
    })();
  }, []);

  // 已开始编辑（用户操作或 agent 工具改动）→ 自动放弃恢复并清除 autosave
  useEffect(() => {
    if (offer && isDirty) {
      setOffer(null);
      void window.api.clearAutosave();
    }
  }, [offer, isDirty]);

  if (!offer) return null;

  const handleRestore = async () => {
    setOffer(null);
    try {
      await useProjectStore
        .getState()
        .applyLoadedProject(offer.name || DEFAULT_PROJECT_NAME, offer.data!, null, offer.missingMedia || []);
      // 空窗事故修复（真实踩坑）：旧逻辑在这里 clearAutosave——恢复后用户若无新改动就
      // 强杀进程，autosave 已删、工程又从未显式保存，工作全丢。改为恢复成功立即把
      // 刚恢复的工程回写一次 autosave，直到用户显式保存（保存/打开/新建会清除）为止。
      // applyLoadedProject 是 async（重建素材 src/旁白/稳定表后才整体 set），必须等它
      // resolve 再 serialize，否则写到 autosave 的是恢复前的旧内存态。
      try {
        const s = useProjectStore.getState();
        // 设置里关掉了自动保存则不写（边界：用户明确 opt-out，文件保留不删，
        // 下次启动横幅仍可恢复/忽略，由用户自己处置）
        if (s.appSettings.autoSave) {
          await window.api.autosaveProject(s.projectName, s.serializeProject());
        }
      } catch {
        // 回写失败不打扰用户：30s 周期自动保存与退出 flush 还会兜底
      }
    } catch {
      // 恢复失败：清掉这份 autosave，避免每次启动都弹出无法成功恢复的横幅
      await window.api.clearAutosave().catch(() => {});
    }
  };

  const handleDiscard = async () => {
    setOffer(null);
    await window.api.clearAutosave();
  };

  return (
    <div className="autosave-banner" role="status">
      <History size={15} className="autosave-banner-icon" />
      <div className="autosave-banner-text">
        <div className="autosave-banner-title">检测到未保存的自动保存工程</div>
        <div className="autosave-banner-sub">「{offer.name || DEFAULT_PROJECT_NAME}」可恢复；开始新编辑后本次恢复将自动放弃</div>
      </div>
      <button className="autosave-banner-btn autosave-banner-btn-primary" onClick={() => void handleRestore()}>
        恢复
      </button>
      <button className="autosave-banner-btn" onClick={() => void handleDiscard()}>
        忽略
      </button>
    </div>
  );
};
