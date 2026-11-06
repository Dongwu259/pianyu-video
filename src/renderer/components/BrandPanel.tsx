/**
 * BrandPanel - 风格板块（项目级，故事板顶部）
 *
 * 一行紧凑触发按钮：品牌 Logo / 字幕样式 / 画面质感 / BGM 避让，
 * 点击弹出浮层（portal 到 body）调整具体参数，避免顶栏堆满控件。
 *
 * Logo：上传图片（selectImageFile）、位置/大小/透明度/显隐；渲染时顶层常驻四角。
 * 字幕样式：位置/字号/底色/字色（项目级，所有段共用）。
 * 画面质感：全局质感层三档预设（暗角/颗粒/扫光）。
 * BGM 避让：旁白响起时自动压低 BGM（仅有 BGM 时显示）。
 */

import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {useProjectStore} from '../store/projectStore';
import {LOGO_POSITION_OPTIONS, TEXTURE_PRESET_OPTIONS, FINE_PRINT_POSITION_OPTIONS} from '../../shared/types';
import type {LogoPosition, TexturePreset, FinePrintPosition} from '../../shared/types';
import {COLOR_LOOKS, getColorLook} from '../../shared/color-grade';
import {DEFAULT_BRAND_COLOR, normalizeBrandColor} from '../../shared/brand-color';
import {FONT_MOOD_OPTIONS, getFontMood, type FontMoodId} from '../../shared/font-presets';
import {Image as ImageIcon, Trash2, Upload, Captions, Wand2, VolumeX, ChevronDown, MousePointer2, Type, Palette, Droplet, PenTool} from 'lucide-react';
import {CaptionStyleControls} from './CaptionStyleControls';
import './BrandPanel.css';

type PopKey = 'logo' | 'caption' | 'fineprint' | 'texture' | 'color' | 'brandcolor' | 'fontmood' | 'cursor' | 'ducking';

/** 品牌色预设（缺省第一个为默认蓝；自由取色在下方） */
const BRAND_COLOR_PRESETS = [
  {hex: '#2563EB', label: '科技蓝（默认）'},
  {hex: '#F97316', label: '活力橙'},
  {hex: '#E11D48', label: '玫瑰红'},
  {hex: '#16A34A', label: '生长绿'},
  {hex: '#7C3AED', label: '星云紫'},
  {hex: '#0EA5E9', label: '天空青'},
  {hex: '#F59E0B', label: '琥珀金'},
  {hex: '#EC4899', label: '洋红'},
];

/** 浮层：锚定触发按钮下方，点击外部关闭（.se-top overflow:hidden，必须 portal） */
const Popover: React.FC<{
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
}> = ({anchorRef, open, onClose, width = 320, children}) => {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{top: number; left: number}>({top: 0, left: 0});

  useEffect(() => {
    if (!open) return;
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) {
      setPos({
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 16)),
      });
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || popRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="brand-pop" ref={popRef} style={{top: pos.top, left: pos.left, width}}>
      {children}
    </div>,
    document.body,
  );
};

export const BrandPanel: React.FC = () => {
  const {logo, setLogo, updateLogo, bgm, setBgmDucking, texture, setTexture, cursor, setCursor, finePrint, setFinePrint, colorGrade, setColorGrade, brandColor, setBrandColor, fontMood, setFontMood} = useProjectStore();
  const [uploading, setUploading] = useState(false);
  const [open, setOpen] = useState<PopKey | null>(null);
  const [hexInput, setHexInput] = useState('');
  const logoBtnRef = useRef<HTMLButtonElement>(null);
  const captionBtnRef = useRef<HTMLButtonElement>(null);
  const finePrintBtnRef = useRef<HTMLButtonElement>(null);
  const textureBtnRef = useRef<HTMLButtonElement>(null);
  const colorBtnRef = useRef<HTMLButtonElement>(null);
  const brandColorBtnRef = useRef<HTMLButtonElement>(null);
  const fontMoodBtnRef = useRef<HTMLButtonElement>(null);
  const cursorBtnRef = useRef<HTMLButtonElement>(null);
  const duckingBtnRef = useRef<HTMLButtonElement>(null);

  const toggle = (key: PopKey) => setOpen((o) => (o === key ? null : key));

  const handleUpload = async () => {
    setUploading(true);
    try {
      const file = await window.api.selectImageFile();
      if (!file) return;
      setLogo({
        src: file.src,
        path: file.path,
        name: file.name,
        position: logo?.position || 'topRight',
        size: logo?.size ?? 0.15,
        opacity: logo?.opacity ?? 1,
        visible: true,
      });
    } finally {
      setUploading(false);
    }
  };

  const duckingEnabled = bgm?.ducking?.enabled ?? false;
  const duckingAmount = bgm?.ducking?.amount ?? 0.25;
  const textureLabel = TEXTURE_PRESET_OPTIONS.find((o) => o.value === texture)?.label ?? texture;
  const fontMoodLabel = getFontMood(fontMood).label;

  // 品牌色弹层打开时把 hex 输入框同步为当前值（避免上次输入残留）
  useEffect(() => {
    if (open === 'brandcolor') setHexInput((brandColor ?? DEFAULT_BRAND_COLOR).toUpperCase());
  }, [open, brandColor]);

  const commitHex = (raw: string): void => {
    const norm = normalizeBrandColor(raw);
    if (norm) setBrandColor(norm.toUpperCase());
  };

  return (
    <div className="brand-panel">
      {/* 品牌 Logo */}
      <button
        ref={logoBtnRef}
        className={`pop-trigger ${open === 'logo' ? 'on' : ''}`}
        onClick={() => toggle('logo')}
        title="品牌 Logo：上传图片，调整位置 / 大小 / 透明度"
      >
        <ImageIcon size={13} /> Logo
        <span className="pop-status">{logo ? logo.name : '未设置'}</span>
        <ChevronDown size={12} />
      </button>
      <Popover anchorRef={logoBtnRef} open={open === 'logo'} onClose={() => setOpen(null)}>
        <div className="brand-pop-title">品牌 Logo</div>
        {logo && (
          <div className="brand-pop-row">
            <span className="brand-logo-name" title={logo.path}>{logo.name}</span>
          </div>
        )}
        <div className="brand-pop-row">
          <button className="btn-small" onClick={handleUpload} disabled={uploading}>
            <Upload size={12} /> {uploading ? '加载中…' : logo ? '更换' : '上传 Logo'}
          </button>
          {logo && (
            <button className="btn-small btn-danger" onClick={() => setLogo(null)}>
              <Trash2 size={12} /> 移除
            </button>
          )}
        </div>
        {logo && (
          <>
            <label className="brand-ctrl">
              位置
              <select value={logo.position} onChange={(e) => updateLogo({position: e.target.value as LogoPosition})}>
                {LOGO_POSITION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="brand-ctrl">
              大小 {(logo.size * 100).toFixed(0)}%
              <input type="range" min={0.05} max={0.4} step={0.01} value={logo.size}
                onChange={(e) => updateLogo({size: Number(e.target.value)})} />
            </label>
            <label className="brand-ctrl">
              透明度 {Math.round(logo.opacity * 100)}%
              <input type="range" min={0} max={1} step={0.05} value={logo.opacity}
                onChange={(e) => updateLogo({opacity: Number(e.target.value)})} />
            </label>
            <label className="brand-toggle">
              <input type="checkbox" checked={logo.visible}
                onChange={(e) => updateLogo({visible: e.target.checked})} />
              显示
            </label>
          </>
        )}
      </Popover>

      {/* 字幕样式（与「字幕」Tab 共用同一控件组件） */}
      <button
        ref={captionBtnRef}
        className={`pop-trigger ${open === 'caption' ? 'on' : ''}`}
        onClick={() => toggle('caption')}
        title="字幕样式：位置 / 字号 / 底色 / 字色（项目级，所有段共用）"
      >
        <Captions size={13} /> 字幕样式
        <ChevronDown size={12} />
      </button>
      <Popover anchorRef={captionBtnRef} open={open === 'caption'} onClose={() => setOpen(null)}>
        <div className="brand-pop-title">字幕样式</div>
        <CaptionStyleControls />
      </Popover>

      {/* 边缘小字（免责声明/版权等常驻小字，渲染在画面底部边缘） */}
      <button
        ref={finePrintBtnRef}
        className={`pop-trigger ${open === 'fineprint' ? 'on' : ''}`}
        onClick={() => toggle('fineprint')}
        title="边缘小字：免责声明 / 版权 / 「本片由 AI 生成」等常驻小字（全片底部边缘淡显）"
      >
        <Type size={13} /> 边缘小字
        <span className="pop-status">{finePrint.text.trim() ? '已设置' : '未设置'}</span>
        <ChevronDown size={12} />
      </button>
      <Popover anchorRef={finePrintBtnRef} open={open === 'fineprint'} onClose={() => setOpen(null)} width={340}>
        <div className="brand-pop-title">边缘小字</div>
        <div className="brand-pop-row">
          <textarea
            className="brand-fineprint-input"
            rows={3}
            placeholder="例：本视频由 片语 AI 生成，效果以实际产品为准"
            value={finePrint.text}
            onChange={(e) => setFinePrint({text: e.target.value.slice(0, 200)})}
          />
        </div>
        <label className="brand-ctrl">
          位置
          <select value={finePrint.position} onChange={(e) => setFinePrint({position: e.target.value as FinePrintPosition})}>
            {FINE_PRINT_POSITION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="brand-ctrl">
          字号 {(finePrint.sizeScale * 100).toFixed(0)}%
          <input type="range" min={0.6} max={1.6} step={0.1} value={finePrint.sizeScale}
            onChange={(e) => setFinePrint({sizeScale: Number(e.target.value)})} />
        </label>
        <label className="brand-ctrl">
          透明度 {Math.round(finePrint.opacity * 100)}%
          <input type="range" min={0.2} max={1} step={0.05} value={finePrint.opacity}
            onChange={(e) => setFinePrint({opacity: Number(e.target.value)})} />
        </label>
        <div className="brand-pop-row">
          <span className="brand-hint">留空则不显示；全片常驻，渲染在画面底部边缘</span>
        </div>
      </Popover>

      {/* 画面质感（全局质感层：暗角/颗粒/扫光，三档预设） */}
      <button
        ref={textureBtnRef}
        className={`pop-trigger ${open === 'texture' ? 'on' : ''}`}
        onClick={() => toggle('texture')}
        title="叠加在全片最上层的质感效果：暗角 / 胶片颗粒 / 扫柔光"
      >
        <Wand2 size={13} /> 画面质感
        <span className="pop-status">{textureLabel}</span>
        <ChevronDown size={12} />
      </button>
      <Popover anchorRef={textureBtnRef} open={open === 'texture'} onClose={() => setOpen(null)} width={260}>
        <div className="brand-pop-title">画面质感</div>
        <div className="texture-list">
          {TEXTURE_PRESET_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`texture-item ${texture === o.value ? 'on' : ''}`}
              onClick={() => setTexture(o.value as TexturePreset)}
            >
              <span className="texture-item-label">{o.label}</span>
              <span className="texture-item-desc">{o.desc}</span>
            </button>
          ))}
        </div>
      </Popover>

      {/* 色调统一（全片色调预设 + 自动曝光匹配，消除多源素材的拼凑感） */}
      <button
        ref={colorBtnRef}
        className={`pop-trigger ${open === 'color' ? 'on' : ''}`}
        onClick={() => toggle('color')}
        title="色调统一：全片色调预设 + 素材自动曝光匹配（录屏/截图/本地素材亮度拉齐）"
      >
        <Palette size={13} /> 色调统一
        <span className="pop-status">{getColorLook(colorGrade.look).label}</span>
        <ChevronDown size={12} />
      </button>
      <Popover anchorRef={colorBtnRef} open={open === 'color'} onClose={() => setOpen(null)} width={300}>
        <div className="brand-pop-title">色调统一</div>
        <div className="texture-list">
          {COLOR_LOOKS.map((o) => (
            <button
              key={o.id}
              className={`texture-item ${colorGrade.look === o.id ? 'on' : ''}`}
              onClick={() => setColorGrade({look: o.id})}
            >
              <span className="texture-item-label">{o.label}</span>
              <span className="texture-item-desc">{o.desc}</span>
            </button>
          ))}
        </div>
        <label className="brand-toggle">
          <input
            type="checkbox"
            checked={colorGrade.autoMatch}
            onChange={(e) => setColorGrade({autoMatch: e.target.checked})}
          />
          自动曝光匹配（素材亮度向全片中位数拉齐）
        </label>
        <div className="brand-pop-row">
          <span className="brand-hint">色调套在全片内容上（字幕/Logo 不被染色）；曝光匹配在素材入库时分析，旧素材无统计则跳过</span>
        </div>
      </Popover>

      {/* 品牌色（项目级强调色：模板高亮/渐变/光晕/字幕条全链路取此色） */}
      <button
        ref={brandColorBtnRef}
        className={`pop-trigger ${open === 'brandcolor' ? 'on' : ''}`}
        onClick={() => toggle('brandcolor')}
        title="品牌色：设置全片强调色，模板高亮/按钮/光晕等统一取此色"
      >
        <Droplet size={13} /> 品牌色
        <span className="pop-status brand-color-dot-wrap">
          <span className="brand-color-dot" style={{background: brandColor ?? DEFAULT_BRAND_COLOR}} />
          {brandColor ? brandColor.toUpperCase() : '默认'}
        </span>
        <ChevronDown size={12} />
      </button>
      <Popover anchorRef={brandColorBtnRef} open={open === 'brandcolor'} onClose={() => setOpen(null)} width={300}>
        <div className="brand-pop-title">品牌色</div>
        <div className="brand-swatches">
          {BRAND_COLOR_PRESETS.map((c) => (
            <button
              key={c.hex}
              className={`brand-swatch ${(brandColor ?? DEFAULT_BRAND_COLOR) === c.hex ? 'on' : ''}`}
              style={{background: c.hex}}
              title={c.label}
              onClick={() => setBrandColor(c.hex === DEFAULT_BRAND_COLOR ? null : c.hex)}
            />
          ))}
        </div>
        <div className="brand-color-row">
          <input
            type="color"
            className="brand-color-picker"
            value={brandColor ?? DEFAULT_BRAND_COLOR}
            onChange={(e) => commitHex(e.target.value)}
            title="自由取色"
          />
          <span className="brand-color-hash">#</span>
          <input
            className="brand-hex-input"
            value={hexInput.replace(/^#/, '')}
            maxLength={6}
            spellCheck={false}
            onChange={(e) => {
              const v = e.target.value;
              setHexInput(v);
              if (/^[0-9a-fA-F]{6}$/.test(v)) setBrandColor(v.toUpperCase());
            }}
            placeholder="RRGGBB"
          />
          {brandColor && (
            <button className="btn-small" onClick={() => setBrandColor(null)} title="恢复默认蓝">
              默认
            </button>
          )}
        </div>
        <div className="brand-pop-row">
          <span className="brand-hint">全片模板的强调色/渐变/光晕统一取品牌色；缺省为片语蓝。字幕/模板文字色不跟随，仍按各自设置</span>
        </div>
      </Popover>

      {/* 字体氛围（项目级字体栈：标题/正文/等宽成套切换） */}
      <button
        ref={fontMoodBtnRef}
        className={`pop-trigger ${open === 'fontmood' ? 'on' : ''}`}
        onClick={() => toggle('fontmood')}
        title="字体氛围：成片标题/正文字体成套切换（商业冷峻/温暖手写/科技等宽/英文展示）"
      >
        <PenTool size={13} /> 字体氛围
        <span className="pop-status">{fontMoodLabel}</span>
        <ChevronDown size={12} />
      </button>
      <Popover anchorRef={fontMoodBtnRef} open={open === 'fontmood'} onClose={() => setOpen(null)} width={300}>
        <div className="brand-pop-title">字体氛围</div>
        <div className="texture-list">
          {FONT_MOOD_OPTIONS.map((o) => {
            const mood = getFontMood(o.value);
            return (
              <button
                key={o.value}
                className={`texture-item ${fontMood === o.value ? 'on' : ''}`}
                onClick={() => setFontMood(o.value as FontMoodId)}
              >
                <span className="texture-item-label font-mood-label">
                  {o.label}
                  <span className="font-mood-preview" style={{fontFamily: mood.titleFont}}>标题 Aa 汉</span>
                </span>
                <span className="texture-item-desc">{o.desc}</span>
              </button>
            );
          })}
        </div>
        <div className="brand-pop-row">
          <span className="brand-hint">字体已内置（含中文），设置后全片标题/正文成套切换，随工程保存</span>
        </div>
      </Popover>

      {/* 美化光标（录屏素材上叠加平滑轨迹光标 + 光晕） */}
      <button
        ref={cursorBtnRef}
        className={`pop-trigger ${open === 'cursor' ? 'on' : ''}`}
        onClick={() => toggle('cursor')}
        title="美化光标：录屏素材上叠加平滑移动的鼠标光标（录屏本身不含系统光标）"
      >
        <MousePointer2 size={13} /> 美化光标
        <span className="pop-status">{cursor ? '开' : '关'}</span>
        <ChevronDown size={12} />
      </button>
      <Popover anchorRef={cursorBtnRef} open={open === 'cursor'} onClose={() => setOpen(null)} width={280}>
        <div className="brand-pop-title">美化光标</div>
        <label className="brand-toggle">
          <input type="checkbox" checked={cursor} onChange={(e) => setCursor(e.target.checked)} />
          开启（录屏素材上显示平滑光标 + 光晕）
        </label>
        <div className="brand-pop-row">
          <span className="brand-hint">仅对录制时带鼠标轨迹的录屏素材生效；鼠标跟随运镜模板使用其自带光标</span>
        </div>
      </Popover>

      {/* BGM 避让旁白（仅有 BGM 时显示） */}
      {bgm && (
        <>
          <button
            ref={duckingBtnRef}
            className={`pop-trigger ${open === 'ducking' ? 'on' : ''}`}
            onClick={() => toggle('ducking')}
            title="BGM 避让：旁白响起时自动压低背景音乐"
          >
            <VolumeX size={13} /> BGM 避让
            <span className="pop-status">{duckingEnabled ? '开' : '关'}</span>
            <ChevronDown size={12} />
          </button>
          <Popover anchorRef={duckingBtnRef} open={open === 'ducking'} onClose={() => setOpen(null)} width={280}>
            <div className="brand-pop-title">BGM 避让旁白</div>
            <label className="brand-toggle">
              <input type="checkbox" checked={duckingEnabled}
                onChange={(e) => setBgmDucking(e.target.checked, duckingAmount)} />
              开启（旁白响起时自动压低 BGM）
            </label>
            {duckingEnabled && (
              <label className="brand-ctrl">
                压到 {Math.round(duckingAmount * 100)}%
                <input type="range" min={0.1} max={1} step={0.05} value={duckingAmount}
                  onChange={(e) => setBgmDucking(true, Number(e.target.value))} />
              </label>
            )}
          </Popover>
        </>
      )}
    </div>
  );
};

export default BrandPanel;
