/**
 * 片语本地模型（pianyu-v1-2b 端侧）——付费版专属的权重下载功能契约层
 *
 * 商业口径（2026-10-07 拍板）：8 元解锁付费版后本地使用不限 token；
 * 硬件门槛 8GB 及以上显存的独立显卡；首次激活弹窗询问是否下载权重
 * （先检测用户电脑状态：显存 / 磁盘）。
 *
 * 推理框架（2026-10-06 换代）：Ollama → llama.cpp（llama-server）。
 * 原因：Ollama 安装器与模型库在国内下载困难；llama.cpp 官方开源发布件
 * 由我们裁剪后（只留 llama-server + 运行所需 DLL）放自家 ECS 分发，
 * 下载链路与权重同源（gating token），客户端全自动拉起服务，用户零终端操作。
 * 权重直接被 llama-server 读取——不再有 Ollama 导入副本，磁盘占用省 4.3GB。
 *
 * 权重分发件与官网 models.html 同源（ECS + nginx 静态）；
 * sha256 内嵌清单做下载完整性校验（与线上 SHA256SUMS 一致）。
 */

/** 模型对外全称（与官网 models.html、推理服务 --alias 一致；类似 Qwen3-VL-2B 的厂商命名） */
export const LOCAL_MODEL_NAME = 'pianyu-v1-2b';

/** 基座模型（微调来源，官网/弹窗介绍共用） */
export const LOCAL_MODEL_BASE = 'Qwen3-VL-2B-Instruct';

/** 旧 Ollama 方案的导入名（迁移识别：AI 设置里仍是旧名/旧端点时自动改写到新本地端点） */
export const LEGACY_MODEL_ID = 'pianyu-2b';

/** 最低显存门槛（MB）。
 *  取 8000 而非 8192：8GB 卡 nvidia-smi 实标 8188MiB（RTX 4060/4060 Laptop 实测），
 *  按 8192 判会把真 8GB 卡误杀成「显存不足 8.0GB」的红灯矛盾。 */
export const LOCAL_MODEL_MIN_VRAM_MB = 8000;

/** 下载后落盘 + 运行时引擎的磁盘余量门槛（权重 4.3GB + llama.cpp 运行时约 0.5GB + 余量；
 *  llama-server 直接读权重文件，没有 Ollama 导入副本） */
export const LOCAL_MODEL_MIN_DISK_BYTES = 6 * 1024 * 1024 * 1024;

/** 本地推理服务端口起点（避开 Ollama 的 11434；被占自动顺延） */
export const LOCAL_MODEL_PORT_BASE = 11435;

/** 上下文长度（与旧 Modelfile num_ctx 一致：编辑工作流长轨迹需要） */
export const LOCAL_MODEL_CTX = 40960;

/** 分发链（2026-10-08 迁移）：权重大头挂 ModelScope 公开仓库 dwphoto/pianyu-v1-2b（免费流量，
 *  一次 ~5GB 下载若走 ECS 按流量计费 0.8 元/GB 会击穿 8 元月付）。unlock 接口按订阅校验后
 *  返回 ModelScope 直链（resolve 会 302 到 CDN，客户端下载器已支持跟随）。
 *  本常量仅作冷备直链兜底（unlock 不可用时退此直链；ECS 副本保留不外露）。 */
export const LOCAL_MODEL_BASE_URL = 'https://studio.dwphoto.top/videotool/downloads/models/';

/** 权重两件套（llama-server 用 -m + --mmproj 直读，必须同目录落地） */
export interface LocalModelFile {
  name: string;
  /** 预期字节数（HEAD 实测 Content-Length，2026-10-07 校准；下载校验以 sha256 为准） */
  sizeBytes: number;
  sha256: string;
}

export const LOCAL_MODEL_FILES: readonly LocalModelFile[] = [
  {name: 'pianyu-2b-v6b-f16.gguf', sizeBytes: 3447350336, sha256: 'e765986ee68c49c1b8b0214adecf7121557ea4a2292423e253bcb6a1029d28a9'},
  {name: 'pianyu-2b-mmproj-f16.gguf', sizeBytes: 819394880, sha256: '486dee15ea6e4d332f57042a4c3796c9c998214f194ed3b79e09499b23d6f52a'},
];

/** llama.cpp 运行时分发件（官方 b11429 Windows CUDA 12.4 x64 裁剪版：只留 llama-server
 *  及其运行依赖 28 个文件，从全量 ~1.2GB 裁到 665MB；sha256/sizeBytes 为裁剪包实测） */
export const RUNTIME_FILE: LocalModelFile = {
  name: 'llamacpp-runtime-b11429-win64-cuda12.4.zip',
  sizeBytes: 665442205,
  sha256: '46c019bf35d950db1b5d121a31ea504bed3759accfb3f3125010a4ca59f65e2c',
};

/** 权重两件套 + 运行时 = 下载清单（运行时已装则跳过） */
export const LOCAL_MODEL_ALL_FILES: readonly LocalModelFile[] = [...LOCAL_MODEL_FILES, RUNTIME_FILE];

/** 展示用总量 */
export const LOCAL_MODEL_TOTAL_GB = '4.3';

/** 商业文案（弹窗/设置页共用，改价只动这里） */
export const LOCAL_MODEL_COMMERCIAL = {
  priceNote: '专有模型，订阅 ¥6/月 后可下载',
  benefit: '本地使用不限 token、数据不出本机',
  hardwareNote: '需要 8GB 及以上显存的独立显卡',
} as const;

/** 显存判定（红绿灯文案） */
export const vramVerdict = (vramMb: number): {ok: boolean; label: string; detail: string} => {
  if (vramMb >= LOCAL_MODEL_MIN_VRAM_MB) {
    return {ok: true, label: '显存满足', detail: `${(vramMb / 1024).toFixed(1)}GB ≥ 8GB`};
  }
  if (vramMb > 0) {
    return {ok: false, label: '显存不足', detail: `${(vramMb / 1024).toFixed(1)}GB，需要 8GB 及以上显存的独立显卡`};
  }
  return {ok: false, label: '未检测到显卡', detail: '无法读取显存信息，请确认装有独立显卡'};
};

/** 磁盘判定 */
export const diskVerdict = (freeBytes: number): {ok: boolean; label: string; detail: string} => {
  const gb = freeBytes / 1024 / 1024 / 1024;
  if (freeBytes >= LOCAL_MODEL_MIN_DISK_BYTES) return {ok: true, label: '磁盘充足', detail: `剩余 ${gb.toFixed(0)}GB（需约 6GB）`};
  return {ok: false, label: '磁盘不足', detail: `剩余 ${gb.toFixed(1)}GB，需约 6GB（权重 ${LOCAL_MODEL_TOTAL_GB}GB + 推理运行时）`};
};

/** 「不再自动弹」决策标记的 localStorage 键 */
export const LOCAL_MODEL_DECISION_KEY = 'pianyu-local-model-decision';
