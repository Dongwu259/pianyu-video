/**
 * editor-policy.ts — 编辑器版权的单一开关（2026-11-06 开源转型）
 *
 * 背景：片语改为「应用本体开源免费、只对专有模型权重与模板包收费」。
 * 客户端画质/水印限制在开源构建里本就不可强制（任何人可去掉重编译），
 * 留着只会推走用户、招致 fork——付费点收缩到「模型下载 + 模板包」两处。
 *
 * EDITOR_UNRESTRICTED = false 可一键回退到旧策略（免费版 720p + 水印），
 * 回退点散布在三处：render:start 的 scale 钳制、render:still / render:cover 的
 * licensed 注入、renderer.ts 的后处理目标尺寸钳制（后者读 licensed，自动跟随）。
 */
export const EDITOR_UNRESTRICTED = true;

/** 输出是否按「已授权」处理（水印 / 分辨率钳制随之关闭） */
export const outputLicensed = (entitlement: 'free' | 'licensed'): boolean =>
  EDITOR_UNRESTRICTED || entitlement === 'licensed';
