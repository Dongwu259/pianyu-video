/**
 * deviceGeometry - 参数化设备壳（three.js 3D 模板用）
 *
 * 纯代码几何体（drei RoundedBox + plane），无外部模型文件：
 * 分辨率无关、颜色可定制（接品牌色）、bundle 不增体积。
 * 屏幕区域预留 group 锚点，模板把 VideoScreenTexture plane 挂进去。
 *
 * 世界单位：设备高约 3.4（手机）/ 2.55（笔记本屏幕盖），相机 radius 6-8 匹配。
 */
import React from 'react';
import {RoundedBox} from '@react-three/drei';

/** 屏幕平面尺寸（three 世界单位），模板据此给 VideoScreenTexture 的 planeWidth/Height */
export const DEVICE_SCREEN = {
  phone: {w: 1.5, h: 3.2},
  laptop: {w: 3.6, h: 2.25},
} as const;

interface ShellProps {
  /** 壳体颜色（缺省深空灰） */
  color?: string;
  children?: React.ReactNode;
}

export const PhoneShell: React.FC<ShellProps> = ({color = '#17181C', children}) => (
  <group>
    {/* 机身 */}
    <RoundedBox args={[1.66, 3.4, 0.16]} radius={0.2} smoothness={4}>
      <meshStandardMaterial color={color} roughness={0.42} metalness={0.65} />
    </RoundedBox>
    {/* 屏幕黑边（凹槽） */}
    <mesh position={[0, 0, 0.082]}>
      <planeGeometry args={[1.56, 3.3]} />
      <meshStandardMaterial color="#050507" roughness={0.9} metalness={0.1} />
    </mesh>
    {/* 屏幕内容锚点（视频纹理 plane 挂这里） */}
    <group position={[0, 0, 0.087]}>{children}</group>
    {/* 前摄挖孔 */}
    <mesh position={[0, 1.42, 0.084]}>
      <circleGeometry args={[0.035, 24]} />
      <meshStandardMaterial color="#0A0A0D" roughness={0.25} metalness={0.3} />
    </mesh>
    {/* 侧键 */}
    <mesh position={[-0.845, 0.55, 0]}>
      <boxGeometry args={[0.02, 0.28, 0.05]} />
      <meshStandardMaterial color="#3A3A41" roughness={0.5} metalness={0.6} />
    </mesh>
    <mesh position={[-0.845, 0.18, 0]}>
      <boxGeometry args={[0.02, 0.44, 0.05]} />
      <meshStandardMaterial color="#3A3A41" roughness={0.5} metalness={0.6} />
    </mesh>
    <mesh position={[0.845, 0.35, 0]}>
      <boxGeometry args={[0.02, 0.5, 0.05]} />
      <meshStandardMaterial color="#3A3A41" roughness={0.5} metalness={0.6} />
    </mesh>
  </group>
);

export const LaptopShell: React.FC<ShellProps> = ({color = '#1B1C20', children}) => (
  <group>
    {/* 屏幕盖（底边在 y=0，中心 1.275） */}
    <group position={[0, 1.275, 0]}>
      <RoundedBox args={[3.9, 2.55, 0.12]} radius={0.06} smoothness={4}>
        <meshStandardMaterial color={color} roughness={0.45} metalness={0.6} />
      </RoundedBox>
      {/* 屏幕黑边 */}
      <mesh position={[0, 0, 0.062]}>
        <planeGeometry args={[3.78, 2.42]} />
        <meshStandardMaterial color="#050507" roughness={0.9} metalness={0.1} />
      </mesh>
      {/* 屏幕内容锚点 */}
      <group position={[0, 0, 0.067]}>{children}</group>
      {/* 摄像头 */}
      <mesh position={[0, 1.18, 0.064]}>
        <circleGeometry args={[0.03, 24]} />
        <meshStandardMaterial color="#0A0A0D" roughness={0.25} metalness={0.3} />
      </mesh>
    </group>
    {/* 底座（前伸） */}
    <group position={[0, 0.06, 0.86]}>
      <RoundedBox args={[4.15, 0.12, 1.8]} radius={0.05} smoothness={4}>
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.55} />
      </RoundedBox>
      {/* 键盘区 */}
      <mesh position={[0, 0.062, -0.18]}>
        <boxGeometry args={[3.3, 0.012, 0.95]} />
        <meshStandardMaterial color="#23262C" roughness={0.7} metalness={0.3} />
      </mesh>
      {/* 触控板 */}
      <mesh position={[0, 0.062, 0.58]}>
        <boxGeometry args={[1.05, 0.012, 0.52]} />
        <meshStandardMaterial color="#2A2D34" roughness={0.55} metalness={0.35} />
      </mesh>
    </group>
  </group>
);
