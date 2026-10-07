export type AssetSource = 'synthetic' | 'imported' | 'recorded';
export type TrackColor = '#2563eb' | '#0f9f7a' | '#d97706' | '#c2413b' | '#7c3aed' | '#0891b2';
export type ClipEffect = 'none' | 'lowpass' | 'highpass' | 'echo';

export interface AudioAsset {
  id: string;
  name: string;
  source: AssetSource;
  duration: number;
  mimeType: string;
  dataUrl?: string;
  size?: number;
}

/**
 * 一个 take 是同一句录音的一次独立演绎，拥有独立的声音素材与片段区间。
 * 主轨片段只引用当前激活的 take，切换 take 即可重选旧录音。
 */
export interface AudioTake {
  id: string;
  /** take 编号，从 1 开始，多页签合并时按编号对齐 */
  takeNumber: number;
  assetId: string;
  name: string;
  /** 该 take 在素材内的入点偏移（秒） */
  offset: number;
  /** 该 take 引用的素材时长（秒） */
  duration: number;
  recordedAt: number;
}

export interface AudioClip {
  id: string;
  name: string;
  start: number;
  fadeIn: number;
  fadeOut: number;
  effect: ClipEffect;
  effectAmount: number;
  takes: AudioTake[];
  activeTakeId: string;
  /** 多页签合并时双方都改过的片段先标记冲突 */
  conflict?: boolean;
  /** 波形版本号，循环区间或片段边界变化时递增以触发重绘 */
  waveformEpoch: number;
}

export interface AudioTrack {
  id: string;
  name: string;
  color: TrackColor;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  height: number;
  clips: AudioClip[];
}

export interface AudioProject {
  version: 2;
  name: string;
  bpm: number;
  snap: number;
  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
  pixelsPerSecond: number;
  tracks: AudioTrack[];
  assets: AudioAsset[];
  updatedAt: number;
}

/** 素材库容量不足时未能落盘的录音，保留在内存中并列出待处理 */
export interface UnsavedRecording {
  id: string;
  blob: Blob;
  duration: number;
  recordedAt: number;
  reason: string;
  trackId: string;
  clipId: string | null;
}

/** 导出预案中的一项：某个片段当前激活 take 的导出参数 */
export interface ExportPlanItem {
  trackId: string;
  trackName: string;
  clipId: string;
  clipName: string;
  takeId: string;
  takeNumber: number;
  assetId: string;
  source: AssetSource;
  start: number;
  duration: number;
  offset: number;
  fadeIn: number;
  fadeOut: number;
  effect: ClipEffect;
  effectAmount: number;
  conflict: boolean;
}
