/**
 * AboutModal — 关于页面弹窗
 * 商业化展示：产品名、版本、简介、作者/官网链接
 */

import React, {useEffect, useRef, useState} from 'react';
import {ExternalLink, Globe, RefreshCw, X} from 'lucide-react';
import {BrandIcon} from './BrandIcon';
import {LegalModal} from './LegalModal';
import {TERMS_OF_USE, PRIVACY_POLICY, OPEN_SOURCE_NOTICES} from '../legal-content';
import './AboutModal.css';

interface AboutModalProps {
  onClose: () => void;
  /** 「更新日志」入口：由 App 负责先关本弹窗再打开 What's New（可选，不传则不显示入口） */
  onShowWhatsNew?: () => void;
  /** 「重播新手教程」入口：由 App 负责先关本弹窗再启动教程（可选，不传则不显示入口） */
  onReplayTour?: () => void;
}

// 版本号：打开时从主进程 app.getVersion() 取（单一真源，随 package.json 升级自动跟上）
const APP_VERSION_FALLBACK = '1.7.1';
const APP_NAME = '片语';
const APP_AUTHOR = '东吴摄影';
const APP_TAGLINE = 'AI 全自动视频制作 · 一句话出片';
const APP_DESCRIPTION =
  'AI 全自动视频制作器：宣传片 / vlog / 口播 / 教程 / 卡点混剪五种体裁一句话开工。模板成片、录屏与摄像头素材采集、长素材高光挖矿、专业转场、节拍卡点、TTS 配音与 AI 审片修复，几分钟产出可发布的成片。';
/** 作者个人网站 */
const AUTHOR_SITE_URL = 'https://dwphoto.top/';
/** 官方网站（官网与授权 API 共用 /videotool 前缀） */
const OFFICIAL_SITE_URL: string = 'https://studio.dwphoto.top/videotool';

const openLink = (url: string) => {
  if (!url) return;
  if (window.api?.openExternal) {
    void window.api.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
};

export const AboutModal: React.FC<AboutModalProps> = ({onClose, onShowWhatsNew, onReplayTour}) => {
  /** 当前打开的法律文本（null = 不显示） */
  const [legal, setLegal] = useState<{title: string; content: string} | null>(null);
  /** 运行时版本号（主进程 app.getVersion()；获取失败用与 package.json 同步的回退值） */
  const [appVersion, setAppVersion] = useState(APP_VERSION_FALLBACK);
  useEffect(() => {
    if (!window.api?.getAppInfo) return;
    let mounted = true;
    void window.api
      .getAppInfo()
      .then((info) => {
        if (mounted && info.version) setAppVersion(info.version);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);
  /** 是否显示更新入口（打包版显示：NSIS 直链版全自动更新；商店版为版本检查+跳转商店） */
  const [updateEnabled, setUpdateEnabled] = useState(false);
  /** 商店渠道标记（store 渠道无后台下载，「发现新版本」提示跳转商店更新）；ref 供事件回调读取 */
  const storeModeRef = useRef(false);
  const [storeMode, setStoreMode] = useState(false);
  /** 检查更新结果区状态 */
  const [update, setUpdate] = useState<{
    phase: 'idle' | 'checking' | 'none' | 'downloading' | 'downloaded' | 'store' | 'error';
    version?: string;
    percent?: number;
    message?: string;
  }>({phase: 'idle'});

  // 打包版显示更新入口；订阅主进程更新事件（静默下载进度/商店版新版提示也同步到结果区）
  useEffect(() => {
    if (!window.api) return;
    let mounted = true;
    void window.api.getAppInfo().then((info) => {
      if (!mounted) return;
      setUpdateEnabled(info.isPackaged);
      storeModeRef.current = info.windowsStore;
      setStoreMode(info.windowsStore);
    });
    const off = window.api.onUpdateStatus((e) => {
      if (e.status === 'available') {
        // 商店渠道：available 即终态（提示跳转商店）；NSIS：随后自动后台下载
        if (storeModeRef.current) {
          setUpdate({phase: 'store', version: e.version});
        } else {
          setUpdate((prev) => ({...prev, phase: 'downloading', version: e.version, percent: undefined}));
        }
      } else if (e.status === 'downloading') {
        setUpdate((prev) => ({...prev, phase: 'downloading', percent: e.percent}));
      } else if (e.status === 'downloaded') {
        setUpdate({phase: 'downloaded', version: e.version});
      } else if (e.status === 'error') {
        // 静默检查的错误不打扰：只在用户主动检查/下载期间展示失败
        setUpdate((prev) =>
          prev.phase === 'checking' || prev.phase === 'downloading'
            ? {phase: 'error', message: e.message}
            : prev
        );
      }
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  /** 手动检查更新：结果直接渲染；NSIS 发现新版本后由主进程事件继续推进 */
  const checkUpdate = async () => {
    if (!window.api?.checkUpdate || update.phase === 'checking') return;
    setUpdate({phase: 'checking'});
    const result = await window.api.checkUpdate();
    if (result.status === 'none') setUpdate({phase: 'none'});
    else if (result.status === 'available')
      setUpdate(storeModeRef.current
        ? {phase: 'store', version: result.version}
        : {phase: 'downloading', version: result.version});
    else if (result.status === 'downloaded') setUpdate({phase: 'downloaded', version: result.version});
    else setUpdate({phase: 'error', message: result.message});
  };

  /** 结果区文案（idle 时不显示） */
  const updateStatusText = (): string | null => {
    switch (update.phase) {
      case 'checking':
        return '正在检查更新…';
      case 'none':
        return '已是最新版本';
      case 'downloading': {
        const pct = typeof update.percent === 'number' ? `（${Math.floor(update.percent)}%）` : '';
        return `发现新版本${update.version ? ` v${update.version}` : ''}，正在后台下载${pct}…`;
      }
      case 'downloaded':
        return `新版本${update.version ? ` v${update.version}` : ''}已下载完成，重启后生效`;
      case 'store':
        return `发现新版本${update.version ? ` v${update.version}` : ''}，请前往 Microsoft Store 更新`;
      case 'error':
        return `检查更新失败${update.message ? `：${update.message}` : ''}`;
      default:
        return null;
    }
  };
  const statusText = updateStatusText();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content about-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>

        <div className="about-hero">
          <div className="about-logo"><BrandIcon size={60} /></div>
          <h2 className="about-title">
            {APP_NAME}
            <span className="about-version-pill">v{appVersion}</span>
          </h2>
          <p className="about-tagline">{APP_TAGLINE}</p>
        </div>

        <p className="about-description">{APP_DESCRIPTION}</p>

        <div className="about-divider" />

        <div className="about-info">
          <div className="about-row">
            <span className="about-label">作者</span>
            <span className="about-value">{APP_AUTHOR}</span>
          </div>
          <div className="about-row">
            <span className="about-label">个人网站</span>
            <button
              type="button"
              className="about-link"
              onClick={() => openLink(AUTHOR_SITE_URL)}
            >
              <Globe size={13} />
              dwphoto.top
              <ExternalLink size={12} className="about-link-ext" />
            </button>
          </div>
          <div className="about-row">
            <span className="about-label">官方网站</span>
            {OFFICIAL_SITE_URL ? (
              <button
                type="button"
                className="about-link"
                onClick={() => openLink(OFFICIAL_SITE_URL)}
              >
                <Globe size={13} />
                {OFFICIAL_SITE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                <ExternalLink size={12} className="about-link-ext" />
              </button>
            ) : (
              <span className="about-value about-coming-soon">敬请期待</span>
            )}
          </div>
        </div>

        {updateEnabled && (
          <div className="about-update">
            <div className="about-update-actions">
              <button
                type="button"
                className="about-update-btn"
                onClick={() => void checkUpdate()}
                disabled={update.phase === 'checking'}
              >
                <RefreshCw size={13} className={update.phase === 'checking' ? 'about-spin' : undefined} />
                检查更新
              </button>
              {update.phase === 'downloaded' && !storeMode && (
                <button
                  type="button"
                  className="about-update-btn about-update-btn-primary"
                  onClick={() => void window.api.installUpdate()}
                >
                  重启安装
                </button>
              )}
              {update.phase === 'store' && (
                <button
                  type="button"
                  className="about-update-btn about-update-btn-primary"
                  onClick={() => void window.api.installUpdate()}
                >
                  前往商店更新
                </button>
              )}
            </div>
            {statusText && <p className="about-update-status">{statusText}</p>}
          </div>
        )}

        <div className="about-legal-links">
          {onReplayTour && (
            <>
              <button type="button" onClick={onReplayTour} title="从头再看一遍新手引导：三步流程、故事板编辑、AI 助手与渲染导出">
                重播新手教程
              </button>
              <span className="about-legal-sep" />
            </>
          )}
          {onShowWhatsNew && (
            <>
              <button type="button" onClick={onShowWhatsNew}>
                更新日志
              </button>
              <span className="about-legal-sep" />
            </>
          )}
          <button type="button" onClick={() => setLegal({title: '使用协议', content: TERMS_OF_USE})}>
            使用协议
          </button>
          <span className="about-legal-sep" />
          <button type="button" onClick={() => setLegal({title: '隐私政策', content: PRIVACY_POLICY})}>
            隐私政策
          </button>
          <span className="about-legal-sep" />
          <button type="button" onClick={() => setLegal({title: '第三方开源项目致谢', content: OPEN_SOURCE_NOTICES})}>
            开源致谢
          </button>
        </div>

        <div className="about-footer">
          <p>© 2026 {APP_AUTHOR} · 保留所有权利</p>
        </div>
      </div>

      {legal && (
        <LegalModal title={legal.title} content={legal.content} onClose={() => setLegal(null)} />
      )}
    </div>
  );
};

export default AboutModal;
