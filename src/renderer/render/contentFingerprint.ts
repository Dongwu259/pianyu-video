/**
 * 当前工程内容指纹的组装：shared/content-fingerprint 的纯函数 + store 快照取字段。
 * startRender（发起渲染那一刻算）与 mcpBridge（get_app_status 比对当前内容）共用同一口径。
 */

import {fingerprintRenderContent} from '../../shared/content-fingerprint';
import type {useProjectStore} from '../store/projectStore';

type StoreSnapshot = ReturnType<typeof useProjectStore.getState>;

/** 当前工程内容指纹（segments + 项目级样式 + 画幅 + 渲染设置；素材会话 URL 已归一为原始路径） */
export const currentContentFingerprint = (state: StoreSnapshot): string =>
  fingerprintRenderContent({
    aspectRatioId: state.aspectRatioId,
    orientation: state.orientation,
    segments: state.segments,
    bgm: state.bgm,
    logo: state.logo,
    captionStyle: state.captionStyle,
    finePrint: state.finePrint,
    colorGrade: state.colorGrade,
    brandColor: state.brandColor,
    fontMood: state.fontMood,
    sfx: state.sfx,
    texture: state.texture,
    beatPulse: state.beatPulse,
    cursor: state.cursor,
    renderSettings: state.renderSettings,
  });
