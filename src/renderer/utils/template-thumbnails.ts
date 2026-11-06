/**
 * 模板缩略图解析（首页 OrientationSelector / 模板选择器 TemplatePickerModal / 模板市场共用）。
 *
 * 内置模板的缩略图是 vite import 的 svg 静态资源，key 对应 template-registry 的
 * thumbnail 字段；市场（云端）模板的 thumbnail 本身是 data-URI，直接透传；
 * 查不到映射时返回 undefined，由调用方用图标（Film/Palette）兜底。
 */

import thumbRevealSlide from '../assets/thumbnails/reveal-slide.svg';
import thumbStackCards from '../assets/thumbnails/stack-cards.svg';
import thumbCinematicPan from '../assets/thumbnails/cinematic-pan.svg';
import thumbSplitShowcase from '../assets/thumbnails/split-showcase.svg';
import thumbMinimalFloat from '../assets/thumbnails/minimal-float.svg';
import thumbKenBurns from '../assets/thumbnails/ken-burns.svg';
import thumbCursorFollow from '../assets/thumbnails/cursor-follow.svg';
import thumbGridMosaic from '../assets/thumbnails/grid-mosaic.svg';
import thumbVerticalScroll from '../assets/thumbnails/vertical-scroll.svg';
import thumbSplitCompare from '../assets/thumbnails/split-compare.svg';
import thumbNeonTech from '../assets/thumbnails/neon-tech.svg';
import thumbTextSlide from '../assets/thumbnails/text-slide.svg';
import thumbBrandIntro from '../assets/thumbnails/brand-intro.svg';
import thumbOutroCta from '../assets/thumbnails/outro-cta.svg';
import thumbDeviceShowcase from '../assets/thumbnails/device-showcase.svg';
import thumbDeviceShowcase3D from '../assets/thumbnails/device-showcase-3d.svg';
import thumbModelTurntable from '../assets/thumbnails/model-turntable.svg';
import thumbHero3DTitle from '../assets/thumbnails/hero-3d-title.svg';
import thumbVideoCut from '../assets/thumbnails/video-cut.svg';
import thumbScreenRecord from '../assets/thumbnails/screen-record.svg';
import thumbScreenDemo from '../assets/thumbnails/screen-demo.svg';
import thumbTutorialStep from '../assets/thumbnails/tutorial-step.svg';
import thumbMontage from '../assets/thumbnails/montage.svg';
import thumbProductFloat from '../assets/thumbnails/product-float.svg';
import thumbAiPromptCard from '../assets/thumbnails/ai-prompt-card.svg';
import thumbLowerThird from '../assets/thumbnails/lower-third.svg';
import thumbCardConverge from '../assets/thumbnails/card-converge.svg';
import thumbStatCounter from '../assets/thumbnails/stat-counter.svg';
import thumbTestimonial from '../assets/thumbnails/testimonial.svg';
import thumbFeatureList from '../assets/thumbnails/feature-list.svg';
import thumbKineticType from '../assets/thumbnails/kinetic-type.svg';
import thumbChapterProgress from '../assets/thumbnails/chapter-progress.svg';
import thumbPriceAnchorPro from '../assets/thumbnails/price-anchor-pro.svg';
import thumbDiffReveal from '../assets/thumbnails/diff-reveal.svg';
import thumbTimelineRoadmap from '../assets/thumbnails/timeline-roadmap.svg';
import thumbPricingTiers from '../assets/thumbnails/pricing-tiers.svg';
import thumbComingSoon from '../assets/thumbnails/coming-soon.svg';
import thumbLogoCloud from '../assets/thumbnails/logo-cloud.svg';
import thumbUICallout from '../assets/thumbnails/ui-callout.svg';
import thumbBeforeAfter from '../assets/thumbnails/before-after.svg';
import thumbCodeTerminal from '../assets/thumbnails/code-terminal.svg';
import thumbGlobePoints from '../assets/thumbnails/globe-points.svg';
import thumbVlogStamp from '../assets/thumbnails/vlog-stamp.svg';
import thumbVlogPolaroid from '../assets/thumbnails/vlog-polaroid.svg';
import thumbTalkingPoint from '../assets/thumbnails/talking-point.svg';
import thumbStepCard from '../assets/thumbnails/step-card.svg';
import thumbRowEmbed from '../assets/thumbnails/row-embed.svg';
import thumbGrowthBars3D from '../assets/thumbnails/growth-bars-3d.svg';
import thumbTrendLine3D from '../assets/thumbnails/trend-line-3d.svg';
import thumbCameraJourney3D from '../assets/thumbnails/camera-journey-3d.svg';
import thumbGalleryHall3D from '../assets/thumbnails/gallery-hall-3d.svg';
import thumbOrbitCarousel3D from '../assets/thumbnails/orbit-carousel-3d.svg';
import thumbTimeTunnel3D from '../assets/thumbnails/time-tunnel-3d.svg';
import thumbCityScape3D from '../assets/thumbnails/city-scape-3d.svg';
import thumbSpiralAtrium3D from '../assets/thumbnails/spiral-atrium-3d.svg';
import thumbStarfield3D from '../assets/thumbnails/starfield-3d.svg';

/** 模板缩略图映射（key 对应 template-registry 的 thumbnail 字段） */
export const TEMPLATE_THUMBNAILS: Record<string, string> = {
  'reveal-slide': thumbRevealSlide,
  'stack-cards': thumbStackCards,
  'cinematic-pan': thumbCinematicPan,
  'split-showcase': thumbSplitShowcase,
  'minimal-float': thumbMinimalFloat,
  'ken-burns': thumbKenBurns,
  'cursor-follow': thumbCursorFollow,
  'grid-mosaic': thumbGridMosaic,
  'vertical-scroll': thumbVerticalScroll,
  'split-compare': thumbSplitCompare,
  'neon-tech': thumbNeonTech,
  'text-slide': thumbTextSlide,
  'brand-intro': thumbBrandIntro,
  'outro-cta': thumbOutroCta,
  'device-showcase': thumbDeviceShowcase,
  'device-showcase-3d': thumbDeviceShowcase3D,
  'model-turntable': thumbModelTurntable,
  'hero-3d-title': thumbHero3DTitle,
  'video-cut': thumbVideoCut,
  'screen-record': thumbScreenRecord,
  'screen-demo': thumbScreenDemo,
  'tutorial-step': thumbTutorialStep,
  'montage': thumbMontage,
  'product-float': thumbProductFloat,
  'ai-prompt-card': thumbAiPromptCard,
  'lower-third': thumbLowerThird,
  'card-converge': thumbCardConverge,
  'vlog-stamp': thumbVlogStamp,
  'vlog-polaroid': thumbVlogPolaroid,
  'talking-point': thumbTalkingPoint,
  'step-card': thumbStepCard,
  'row-embed': thumbRowEmbed,
  'stat-counter': thumbStatCounter,
  'testimonial': thumbTestimonial,
  'feature-list': thumbFeatureList,
  'kinetic-type': thumbKineticType,
  'chapter-progress': thumbChapterProgress,
  'timeline-roadmap': thumbTimelineRoadmap,
  'pricing-tiers': thumbPricingTiers,
  'price-anchor-pro': thumbPriceAnchorPro,
  'coming-soon': thumbComingSoon,
  'logo-cloud': thumbLogoCloud,
  'ui-callout': thumbUICallout,
  'before-after': thumbBeforeAfter,
  'diff-reveal': thumbDiffReveal,
  'code-terminal': thumbCodeTerminal,
  'globe-points': thumbGlobePoints,
  'growth-bars-3d': thumbGrowthBars3D,
  'trend-line-3d': thumbTrendLine3D,
  'camera-journey-3d': thumbCameraJourney3D,
  'gallery-hall-3d': thumbGalleryHall3D,
  'orbit-carousel-3d': thumbOrbitCarousel3D,
  'time-tunnel-3d': thumbTimeTunnel3D,
  'city-scape-3d': thumbCityScape3D,
  'spiral-atrium-3d': thumbSpiralAtrium3D,
  'starfield-3d': thumbStarfield3D,
};

/** 解析模板缩略图：市场模板是 data-URI 直接用，否则查静态映射；查不到返回 undefined（调用方用图标兜底） */
export const resolveTemplateThumbnail = (thumbnail: string): string | undefined =>
  thumbnail.startsWith('data:') ? thumbnail : TEMPLATE_THUMBNAILS[thumbnail];
