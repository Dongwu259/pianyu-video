/**
 * 文生图（OpenAI 兼容 /images/generations）——共享类型。
 * 服务实现在 main/services/imageGen.ts：与 AI 助手共用端点与 Key，仅模型名单独配置。
 */

export interface ImageGenRequest {
  prompt: string;
  /** WxH（如 1792x1024 / 1024x1792），缺省横版；非法值回退缺省 */
  size?: string;
}

export interface ImageGenResult {
  /** 本地文件绝对路径（userData/imagegen/ 哈希缓存） */
  path: string;
  /** 本地媒体服务器 HTTP URL（Remotion <Img> 直接可用） */
  src: string;
}

export interface ImageGenStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
}
