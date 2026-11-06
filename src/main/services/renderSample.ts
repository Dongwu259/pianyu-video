/**
 * 脚本化渲染内置示例工程（官网样片 + 打包渲染探测）
 *
 * 用途:
 * - 官网样片：npm run render:sample 把 resources/sample-project 渲染成
 *   server/public/demo/demo.mp4（官网演示区直接引用该文件，随服务端部署同步上线）。
 * - 打包渲染探测：对打包产物（如 dist/win-unpacked/片语.exe）设置同样的
 *   RENDER_SAMPLE 环境变量运行，验证 asar 打包后渲染链路是否可用。
 *
 * 触发方式：主进程启动时 env RENDER_SAMPLE=<输出 mp4 路径>（见 index.ts 顶部分支）。
 * 可选 env RENDER_SAMPLE_PROJECT=<目录>：渲染该目录下第一个 .vtproj（媒体相对路径按
 * 该目录解析），用于宣传素材出片 / LLM 工具链头less渲染；缺省渲染内置示例工程。
 * 该模式下不创建窗口、不做授权恢复/自动更新等 GUI 初始化，渲染完成后以
 * 退出码 0（成功）/ 1（失败）退出。
 *
 * 授权说明：licensed 门禁在 ipc/render.ts 的 RENDER_START 层强制覆写；
 * 本脚本直接调 service 层并传 licensed: true——这是给我们自己官网用的营销素材，
 * 无授权问题。
 */

import {app} from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {startVideoServer, registerMediaPath, filePathToHttpUrl} from './videoServer';
import {
  getSampleSourceCandidates, findSampleSourceDir, ensureSampleCopy, loadSampleProjectCopy,
  rewriteMediaPathsToAbsolute,
} from './sampleProject';
import {readProjectFile, collectMediaPaths} from './projectFile';
import {readCursorTrack} from './capture';
import {parseUiRegionsJson} from '../../shared/ui-regions';
import {parseCursorTrackScript, buildCursorTrack, generateDemoCursorTrack, generateDemoCursorClicks} from '../../shared/demo-cursor-track';
import {lintCheckpoints} from '../../shared/template-checkpoints';
import {segmentPreviewWindow} from '../../shared/render-blocks';
import {keyframeTimetable, type SegmentKeyframeRow} from '../../shared/template-keyframes';
import type {ProjectFilePayload} from './projectFile';
import {executeRender} from './renderer';
import {getSfxLibraryUrls} from './sfxLibrary';
import {getGeneratedTemplates} from './store';
import {validateGeneratedTemplateDef} from '../../shared/generated-template';
import {DEFAULT_RENDER_OPTIONS, DEFAULT_SFX_CONFIG, DEFAULT_TEXTURE_PRESET, DEFAULT_BEAT_PULSE, DEFAULT_CURSOR_ENABLED} from '../../shared/types';
import type {MultiSegmentProps} from '../../shared/types';

/**
 * 渲染内置示例工程到 outputLocation，返回进程退出码（0 成功 / 1 失败）。
 * 前置条件：app 已 ready（需要 userData 路径）。
 */
export const runRenderSample = async (outputLocation: string): Promise<number> => {
  try {
    // Remotion headless Chromium 拒绝 file:// 媒体，先起本地视频 HTTP 服务器
    await startVideoServer();

    // 工程加载：默认渲染内置示例工程；设 RENDER_SAMPLE_PROJECT=<目录> 时渲染该目录下
    // 第一个 .vtproj（相对媒体路径按该目录解析，直接读源文件、不复制到 userData）。
    // 该入口同时供宣传素材批量出片与 LLM 工具链的头less渲染调用。
    let payload: ProjectFilePayload;
    let mediaPaths: string[];
    let projectDir: string | null = null;
    const customProjectDir = process.env.RENDER_SAMPLE_PROJECT;
    if (customProjectDir) {
      const dir = path.resolve(customProjectDir);
      const projFile = fs.readdirSync(dir).find((f) => f.endsWith('.vtproj'));
      if (!projFile) throw new Error(`RENDER_SAMPLE_PROJECT 目录下未找到 .vtproj: ${dir}`);
      const raw = readProjectFile(path.join(dir, projFile));
      payload = {...raw, data: rewriteMediaPathsToAbsolute(raw.data, dir)};
      mediaPaths = collectMediaPaths(payload.data);
      projectDir = dir;
      console.log(`[RenderSample] 使用自定义工程: ${path.join(dir, projFile)}`);
    } else {
      // 示例工程复制到 userData（幂等），相对媒体路径重写为副本目录下的绝对路径
      const srcDir = findSampleSourceDir(getSampleSourceCandidates(__dirname));
      if (!srcDir) throw new Error('未找到内置示例工程资源（resources/sample-project）');
      const destDir = path.join(app.getPath('userData'), 'sample-project');
      ensureSampleCopy(srcDir, destDir);
      const loaded = loadSampleProjectCopy(destDir);
      payload = loaded.payload;
      mediaPaths = loaded.mediaPaths;
    }
    // 预览/渲染白名单：媒体路径逐一注册（与 sample:open 一致）
    for (const p of mediaPaths) registerMediaPath(p);

    // 组装 MultiSegmentPromo props：媒体 src 换成视频服务器会话 URL（等价于渲染端
    // applyLoadedProject 的 pathToClipSrc）；customTemplates 空、bgm 无、licensed: true、
    // orientation 从工程读（与 useStartRender 的组装方式一致）。
    // 鼠标轨迹 sidecar：应用内加载会由 projectStore 读回 cursorPoints，无头渲染路径在此补齐
    // 同款逻辑（相对路径按工程目录解析），否则美化光标在宣传素材/LLM 工具链出片中静默缺失。
    const data = payload.data;
    // 模板自检（渲前纯函数检查，零渲染成本）：error 直接阻止渲染（坏参数在渲前被拦下），
    // warn 打日志——与装配脚本共用 shared/template-checkpoints 同一份检查
    const checkpointIssues = lintCheckpoints(data.segments);
    const checkpointErrors = checkpointIssues.filter((i) => i.severity === 'error');
    for (const i of checkpointIssues) console.log(`${i.severity === 'error' ? '✗' : '⚠'} ${i.message}`);
    if (checkpointErrors.length > 0) {
      throw new Error(`模板自检 ${checkpointErrors.length} 条 error，已阻止渲染（详见上方 [checkpoint] 日志）`);
    }
    const inputProps: MultiSegmentProps = {
      segments: data.segments.map((seg) => ({
        ...seg,
        videos: seg.videos.map((clip) => {
          const out = {...clip, src: filePathToHttpUrl(clip.src)};
          if (clip.cursorTrack) {
            const trackPath = path.isAbsolute(clip.cursorTrack)
              ? clip.cursorTrack
              : path.join(projectDir ?? '.', clip.cursorTrack);
            const track = readCursorTrack(trackPath);
            if (track) {
              out.cursorPoints = track.points;
              out.cursorClicks = track.clicks;
            }
          }
          // UI 区域 sidecar（拆层飞出）：无头渲染路径同款补齐（相对路径按工程目录解析）
          if (clip.uiRegionsTrack) {
            const regionsPath = path.isAbsolute(clip.uiRegionsTrack)
              ? clip.uiRegionsTrack
              : path.join(projectDir ?? '.', clip.uiRegionsTrack);
            try {
              const regions = parseUiRegionsJson(fs.readFileSync(regionsPath, 'utf8'));
              if (regions) out.uiRegions = regions.regions;
            } catch {}
          }
          // 声明式动作轨迹（cursorScript）与随机演示轨迹：无头渲染路径同款重建
          //（applyLoadedProject 有同分支；不补齐则 cursorScript 出片静默丢失轨迹）
          if (!out.cursorPoints && clip.cursorActionScript) {
            const parsed = parseCursorTrackScript(clip.cursorActionScript);
            if (parsed.steps.length > 0) {
              const built = buildCursorTrack(parsed, {
                durationSec: clip.duration, width: clip.width, height: clip.height, seed: clip.cursorActionSeed,
              });
              out.cursorPoints = built.points;
              out.cursorClicks = built.clicks;
              if (built.events.length > 0) out.cursorEvents = built.events;
            }
          }
          if (!out.cursorPoints && clip.cursorDemoSeed !== undefined) {
            const demoPoints = generateDemoCursorTrack({
              durationSec: clip.duration, width: clip.width, height: clip.height, seed: clip.cursorDemoSeed,
            });
            out.cursorPoints = demoPoints;
            out.cursorClicks = generateDemoCursorClicks(demoPoints);
          }
          return out;
        }),
        narration:
          seg.narration?.source === 'import' && seg.narration.path
            ? {...seg.narration, src: filePathToHttpUrl(seg.narration.path)}
            : seg.narration,
      })),
      orientation: data.orientation,
      editPlan: data.editPlan,
      customTemplates: [],
      // AI 生成模板：工程内嵌副本优先（头less渲染/工程分享场景），缺省回退应用级模板库；
      // 结构校验过滤坏数据，避免坏模板进渲染（坏 def 的片段按未知模板剔除，不会炸渲染）
      generatedTemplates: (data.generatedTemplates ?? getGeneratedTemplates()).filter(
        (def) => validateGeneratedTemplateDef(def).length === 0,
      ),
      bgm: data.bgm ? {...data.bgm, src: data.bgm.path ? filePathToHttpUrl(data.bgm.path) : ''} : null,
      // 音效：工程无此字段时按默认配置（新增可选字段不升格式版本）；源表来自内置库
      sfx: {...DEFAULT_SFX_CONFIG, ...(data.sfx || {})},
      sfxSources: getSfxLibraryUrls(__dirname),
      // 质感预设：旧工程无此字段时用默认（胶片）
      texture: data.texture ?? DEFAULT_TEXTURE_PRESET,
      // 节拍脉冲：旧工程无此字段时用默认（开）
      beatPulse: data.beatPulse ?? DEFAULT_BEAT_PULSE,
      // 美化光标：旧工程无此字段时用默认（开）
      cursor: data.cursor ?? DEFAULT_CURSOR_ENABLED,
      logo: data.logo ? {...data.logo, src: data.logo.path ? filePathToHttpUrl(data.logo.path) : ''} : null,
      captionStyle: data.captionStyle,
      // 品牌主题：旧工程无此字段时用默认（默认蓝 + 商业冷峻）
      brandColor: data.brandColor ?? null,
      fontMood: data.fontMood,
      licensed: true,
    };

    const out = path.resolve(outputLocation);
    fs.mkdirSync(path.dirname(out), {recursive: true});

    let lastLogged = -10; // 进度日志按 10% 步进（全片/段预览/各变体共用）

    // ====== 段预览模式（RENDER_SEGMENT / RENDER_SEGMENT_VARIANTS）======
    // 单段试渲/变体并渲（promo-quality-roadmap 第三层）：渲前检查已由上方 checkpoints
    // 负责（变体注入不回流检查——试验参数可能正是要观察 warn/error 项的效果）。
    // 帧窗=segmentPreviewWindow（含转场垫帧，segments 不裁剪）；响度归一化跳过
    // （观感对比不需要）；segmentCache 关（预览恒整片单渲路径渲子窗）。
    const renderOneSegmentJob = async (
      segIndex: number,
      variantParams: Record<string, number> | null,
      variantTag: string | null,
    ): Promise<string> => {
      const win = segmentPreviewWindow(
        inputProps.segments,
        (inputProps.generatedTemplates ?? []).map((t) => t.id),
        30,
        segIndex,
      );
      if (!win) {
        throw new Error(
          `段 ${segIndex} 不存在或不可渲染（有效段号 0..${inputProps.segments.length - 1}，且段模板须可渲染）`,
        );
      }
      const segOut = variantTag
        ? path.join(path.dirname(out), `pianyu-preview-seg${segIndex}-${variantTag}.mp4`)
        : path.join(path.dirname(out), `pianyu-preview-seg${segIndex}.mp4`);
      console.log(
        `[RenderSample] 段预览 seg${segIndex}${variantTag ? `/${variantTag}` : ''}：帧 ${win.from}-${win.to}（${win.frames} 帧 ≈ ${(win.frames / 30).toFixed(1)}s，含转场垫帧）→ ${segOut}`,
      );
      const variantSegments = inputProps.segments.map((seg, i) =>
        i === segIndex && variantParams ? {...seg, customParams: {...(seg.customParams ?? {}), ...variantParams}} : seg,
      );
      const t0 = Date.now();
      await executeRender(
        {
          compositionId: `MultiSegment-${data.aspectRatioId}`,
          inputProps: variantParams ? {...inputProps, segments: variantSegments} : inputProps,
          outputLocation: segOut,
          renderOptions: {
            ...DEFAULT_RENDER_OPTIONS,
            ...data.renderSettings,
            overwrite: true,
            muted: true,
            loudnorm: false,
            segmentCache: false,
            previewFrameRange: [win.from, win.to],
          },
        },
        (progress) => {
          if (progress >= lastLogged + 10 || progress === 100) {
            lastLogged = progress;
            console.log(`[RenderSample] 渲染进度: ${progress}%`);
          }
        },
      );
      console.log(`[RenderSample] 段预览完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      // 特性帧自动拼条（第四层）：渲完自动抽该段关键帧出对照图；RENDER_KEYFRAMES=0 关
      if (process.env.RENDER_KEYFRAMES !== '0') {
        // timetable 必须用全片 segments（absFrame 是整片绝对帧，与 win.from 同坐标系）；
        // 传单段切片会把段内容当 0 点 → 平移出负数全钳 0（seg5 实弹踩过）
        const row = keyframeTimetable(inputProps.segments, 30).find((r) => r.segmentIndex === segIndex);
        if (row) {
          // 段预览 mp4 的 0 点 = win.from（seqFrom）——段内时刻平移到预览产物时间轴
          const shifted = row.absFrames.map((af) => (af - win.from) / 30);
          await buildKeyframeSheet(
            segOut,
            [{times: shifted}],
            segOut.replace(/\.mp4$/, '-keyframes.jpg'),
          ).catch((e) => console.warn(`[RenderSample] 关键帧拼条失败（不阻塞）: ${e}`));
        }
      }
      return segOut;
    };

    // RENDER_SEGMENT_VARIANTS=5:{json},5:{json}（json=customParams 覆盖包，flat 数字表无
    // 嵌套花括号 → 正则全局提取，顶层逗号分隔符与 json 内逗号互不干扰）
    const variantsRaw = process.env.RENDER_SEGMENT_VARIANTS;
    if (variantsRaw) {
      const pairs: {seg: number; params: Record<string, number>; raw: string}[] = [];
      const re = /(\d+)\s*:\s*\{([^{}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(variantsRaw)) !== null) {
        let params: Record<string, number>;
        try {
          // 捕获组是花括号内内容，补回外层 {}；裸键容错（bash/PowerShell 传 env 会剥内层
          // 双引号——P2-7 审片闭环生成的命令在各类 shell 里要都能直接跑，修键名引号再 parse）
          try {
            params = JSON.parse(`{${m[2]}}`) as Record<string, number>;
          } catch {
            const repaired = m[2].replace(/(^|[{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
            params = JSON.parse(`{${repaired}}`) as Record<string, number>;
          }
        } catch (e) {
          throw new Error(`RENDER_SEGMENT_VARIANTS 第 ${pairs.length + 1} 个变体 json 解析失败「${m[2]}」: ${e}`);
        }
        const badKeys = Object.entries(params).filter(([, v]) => typeof v !== 'number' || !Number.isFinite(v));
        if (badKeys.length > 0) throw new Error(`RENDER_SEGMENT_VARIANTS 变体只接受数字值，发现非数字：${badKeys.map(([k]) => k).join('、')}`);
        pairs.push({seg: Number(m[1]), params, raw: m[2]});
      }
      if (pairs.length === 0) throw new Error(`RENDER_SEGMENT_VARIANTS 格式无法解析「${variantsRaw}」（期望形如 5:{"flyAmp":1.2},5:{"flyAmp":1.4}）`);
      console.log(`[RenderSample] 变体并渲：${pairs.length} 个变体（同进程串行，bundle 只打包一次）`);
      const outputs: string[] = [];
      for (let k = 0; k < pairs.length; k++) {
        outputs.push(await renderOneSegmentJob(pairs[k].seg, pairs[k].params, `v${k + 1}`));
      }
      await buildVariantContactSheet(outputs, path.dirname(out), pairs[0].seg).catch((e) =>
        console.warn(`[RenderSample] 拼条生成失败（不阻塞主流程）: ${e}`),
      );
      return 0;
    }

    // RENDER_SEGMENT=5 或 5,8,12：每段一个预览 mp4（pianyu-preview-segN.mp4）
    const segListRaw = process.env.RENDER_SEGMENT;
    if (segListRaw) {
      const segs = segListRaw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
      if (segs.length === 0) throw new Error(`RENDER_SEGMENT 无法解析「${segListRaw}」（期望段号如 5 或 5,8,12）`);
      for (const segIndex of segs) await renderOneSegmentJob(segIndex, null, null);
      return 0;
    }

    console.log(`[RenderSample] 开始渲染示例工程 → ${out}`);
    const {outputPath, encoderUsed, cacheInfo} = await executeRender(
      {
        compositionId: `MultiSegment-${data.aspectRatioId}`,
        inputProps,
        outputLocation: out,
        // CRF/格式等用工程渲染设置（缺省回退 DEFAULT_RENDER_OPTIONS），强制覆盖已有产物
        renderOptions: {...DEFAULT_RENDER_OPTIONS, ...data.renderSettings, overwrite: true},
      },
      (progress) => {
        // 进度日志按 10% 步进输出，避免刷屏
        if (progress >= lastLogged + 10 || progress === 100) {
          lastLogged = progress;
          console.log(`[RenderSample] 渲染进度: ${progress}%`);
        }
      }
    );
    console.log(`[RenderSample] 渲染完成: ${outputPath}（编码器: ${encoderUsed}）`);
    if (cacheInfo) console.log(`[RenderSample] 块缓存: 命中 ${cacheInfo.hit}/${cacheInfo.total} 块`);
    // 特性帧自动拼条（第四层）：全片关键帧总览（每段一行，段内帧=模板声明时刻）；
    // RENDER_KEYFRAMES=0 关。时刻表同步打日志（拼条图无字——ffmpeg drawtext 中文字体
    // 在裁剪版/系统版间行为不一致，规避）
    if (process.env.RENDER_KEYFRAMES !== '0') {
      const table = keyframeTimetable(inputProps.segments, 30);
      for (const row of table) {
        console.log(
          `[keyframe] 段${row.segmentIndex + 1} ${row.templateId}: ` +
            row.marks.map((k, j) => `${(row.absFrames[j] / 30).toFixed(2)}s ${k.label}`).join(' | '),
        );
      }
      if (table.length > 0) {
        await buildKeyframeSheet(
          out,
          table.map((row) => ({times: row.absFrames.map((af) => af / 30)})),
          out.replace(/\.mp4$/, '') + '-keyframes.jpg',
        ).catch((e) => console.warn(`[RenderSample] 关键帧拼条失败（不阻塞）: ${e}`));
      }
    }
    return 0;
  } catch (err) {
    console.error('[RenderSample] 渲染失败:', err);
    return 1;
  }
};

/**
 * 变体对比拼条：每变体一行、时间列对齐（每行同一组时刻的 K 帧微步进抽帧，hstack 成行、
 * vstack 叠行）。Windows 无 glob → 显式路径逐帧 -ss 抽取（v1-v9 拼条经验）；失败由
 * 调用方 catch（拼条是锦上添花，不阻塞主流程）。
 */
const buildVariantContactSheet = async (variantMp4s: string[], outDir: string, segIndex: number): Promise<void> => {
  const {spawnSync} = await import('node:child_process');
  const ffmpeg = await pickContactSheetFfmpeg();
  const K = 8; // 每变体抽帧数（时间列数）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pianyu-variants-'));
  const files: string[] = [];
  for (let v = 0; v < variantMp4s.length; v++) {
    // 段时长从产物探测（ffprobe 免费，避免把窗数学再传进来）
    const probe = spawnSync(ffmpeg, ['-i', variantMp4s[v]], {encoding: 'utf8'});
    const durMatch = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(probe.stderr ?? '');
    const dur = durMatch ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]) : 4;
    for (let k = 0; k < K; k++) {
      const t = ((k + 0.5) / K) * dur;
      const f = path.join(tmp, `v${v}_k${k}.png`);
      const r = spawnSync(ffmpeg, ['-y', '-ss', t.toFixed(2), '-i', variantMp4s[v], '-frames:v', '1', f], {stdio: 'ignore'});
      if (r.status === 0 && fs.existsSync(f)) files.push(f);
      else files.push(''); // 抽帧失败占位（filter_complex 里跳过）
    }
  }
  const usable = files.filter((f) => f);
  if (usable.length < variantMp4s.length * 2) throw new Error(`抽帧可用帧过少（${usable.length}/${files.length}）`);
  // 简化：按「每行实际可用帧」过滤掉坏列太复杂——直接要求全部成功（失败帧极少见；半成品拼条误导性更强）
  if (usable.length !== files.length) throw new Error(`部分帧抽取失败（${files.length - usable.length} 帧）`);
  const inputs: string[] = [];
  files.forEach((f) => inputs.push('-i', f));
  const rows = variantMp4s
    .map((_, v) => files.slice(v * K, (v + 1) * K).map((_, i) => `[${v * K + i}:v]scale=320:180[r${v}_${i}]`).join(';'))
    .join(';');
  const hstack = variantMp4s.map((_, v) => `[${files.slice(v * K, (v + 1) * K).map((_, i) => `r${v}_${i}`).join('][')}]hstack=inputs=${K}[row${v}]`).join(';');
  const vstackIn = variantMp4s.map((_, v) => `[row${v}]`).join('');
  const filter = `${rows};${hstack};${vstackIn}vstack=inputs=${variantMp4s.length}`;
  const jpg = path.join(outDir, `pianyu-preview-seg${segIndex}-variants.jpg`);
  const r = spawnSync(ffmpeg, [...inputs, '-filter_complex', filter, '-frames:v', '1', '-q:v', '3', '-y', jpg], {encoding: 'utf8'});
  if (r.status !== 0) throw new Error(`拼条合成失败: ${(r.stderr ?? '').slice(-300)}`);
  fs.rmSync(tmp, {recursive: true, force: true});
  console.log(`[RenderSample] 变体拼条 → ${jpg}`);
};

/**
 * 拼条用 ffmpeg 探测：需要 hstack/vstack filter——Remotion compositor 版 ffmpeg 没有
 * 这些 filter（实测 -filters 清单为空），优先 PATH 上的系统 ffmpeg（装配脚本同口径）；
 * 都不行时返回 'ffmpeg' 由调用方 catch（拼条失败不阻塞主流程）。
 */
const pickContactSheetFfmpeg = async (): Promise<string> => {
  const {spawnSync} = await import('node:child_process');
  const {getFfmpegPath} = await import('./audio');
  for (const c of ['ffmpeg', getFfmpegPath()]) {
    try {
      const r = spawnSync(c, ['-hide_banner', '-filters'], {encoding: 'utf8', timeout: 15000});
      if (r.status === 0 && `${r.stderr ?? ''}${r.stdout ?? ''}`.includes('hstack')) return c;
    } catch {}
  }
  return 'ffmpeg';
};

/**
 * 特性帧拼条（第四层）：每段一行（行内帧数=该段关键帧数，短行右侧补黑到等宽），
 * vstack 叠行。时刻表与标签已由调用方打日志（图上不写字——drawtext 中文字体在
 * 系统/裁剪 ffmpeg 间行为不一致，规避）。
 */
const buildKeyframeSheet = async (
  mp4: string,
  rows: {times: number[]}[],
  outJpg: string,
): Promise<void> => {
  const {spawnSync} = await import('node:child_process');
  const ffmpeg = await pickContactSheetFfmpeg();
  const CW = 320;
  const CH = 180;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pianyu-kf-'));
  // 抽帧：每时刻一帧（时刻是产物时间轴秒——全片=绝对帧/30、段预览=平移后）
  const rowImgs: string[][] = [];
  let gi = 0;
  for (const row of rows) {
    const imgs: string[] = [];
    for (const t of row.times) {
      const f = path.join(tmp, `f${gi++}.png`);
      const r = spawnSync(ffmpeg, ['-y', '-ss', Math.max(0, t).toFixed(3), '-i', mp4, '-frames:v', '1', f], {stdio: 'ignore'});
      if (r.status === 0 && fs.existsSync(f)) imgs.push(f);
    }
    if (imgs.length > 0) rowImgs.push(imgs);
  }
  if (rowImgs.length === 0) throw new Error('关键帧一帧都没抽到（时刻表或产物异常）');
  const maxCols = Math.max(...rowImgs.map((r) => r.length));
  const inputs: string[] = [];
  rowImgs.flat().forEach((f) => inputs.push('-i', f));
  // 逐帧 scale → 行 hstack → pad 等宽（右侧补黑）→ vstack 叠行
  let idx = 0;
  const scales: string[] = [];
  const stacks: string[] = [];
  rowImgs.forEach((imgs, ri) => {
    const pads: string[] = [];
    imgs.forEach(() => {
      scales.push(`[${idx}:v]scale=${CW}:${CH}[s${idx}]`);
      pads.push(`[s${idx}]`);
      idx++;
    });
    // 单帧行不做 hstack（inputs=1 非法——ffmpeg 报 "Result too large"）：scale 后直接 pad 等宽
    stacks.push(
      imgs.length === 1
        ? `${pads[0]}pad=${maxCols * CW}:${CH}:0:0:color=black[row${ri}]`
        : `${pads.join('')}hstack=inputs=${imgs.length},pad=${maxCols * CW}:${CH}:0:0:color=black[row${ri}]`,
    );
  });
  // 单行（vstack inputs=1 非法——ffmpeg stack 族最少 2 输入）：hstack+pad 的输出直接作末级
  const filter =
    rowImgs.length === 1
      ? [...scales, stacks[0].replace(/\[row\d+\]$/, '')].join(';')
      : [
          ...scales,
          ...stacks,
          `${rowImgs.map((_, ri) => `[row${ri}]`).join('')}vstack=inputs=${rowImgs.length}`,
        ].join(';');
  const r = spawnSync(ffmpeg, [...inputs, '-filter_complex', filter, '-frames:v', '1', '-q:v', '3', '-y', outJpg], {encoding: 'utf8'});
  fs.rmSync(tmp, {recursive: true, force: true});
  if (r.status !== 0) throw new Error(`关键帧拼条合成失败: ${(r.stderr ?? '').slice(-300)}`);
  console.log(`[RenderSample] 关键帧拼条 → ${outJpg}（${rowImgs.length} 段行 × 最多 ${maxCols} 帧）`);
};
