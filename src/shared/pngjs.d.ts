/**
 * pngjs 的最小类型声明（仓库未装 @types/pngjs；footage.ts 用 sync.read，
 * contactSheet.ts 用构造器建画布 + bitblt 贴格——对应 pngjs/lib/png.js 真实 API）
 */
declare module 'pngjs' {
  export interface PNGData {
    width: number;
    height: number;
    data: Buffer;
  }
  export interface PNGImage extends PNGData {
    bitblt(dst: PNGImage, srcX: number, srcY: number, width: number, height: number, deltaX: number, deltaY: number): void;
  }
  export const PNG: {
    new (options: {width: number; height: number}): PNGImage;
    bitblt(src: PNGImage, dst: PNGImage, srcX: number, srcY: number, width: number, height: number, deltaX: number, deltaY: number): void;
    sync: {
      read: (buffer: Buffer) => PNGImage;
      write: (png: PNGImage) => Buffer;
    };
  };
}
