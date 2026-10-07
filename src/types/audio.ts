export const PROJECT_VERSION = 2 as const;

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
  /** 该素材上各 take 共用的修订号：声音内容变化（叠录/恢复）时自增，波形缓存随之失效。 */
  takeSeq?: number;
}

/**
 * Take = 一次叠录保留下来的独立声音。clip 只通过 activeTakeNo 引用其中一段，
 * 所有历史 take 保留在 takes 中，可随时重选；恢复上一个 take 也是安全切换。
 */
export interface ClipTake {
  /** 全局唯一身份（= 首次创建时的 asset id）；跨页签合并据此对齐同一 take。 */
  id: string;
  /** 素材库中对应的独立声音 asset id（一般与 id 相同；迁移数据可能不同）。 */
  assetId: string;
  name: string;
  /** 从 1 开始的 take 编号，同一 clip 内唯一，合并时按身份重新规范化。 */
  no: number;
  createdAt: number;
}

export interface ClipRemoteSnapshot {
  start?: number;
  duration?: number;
  offset?: number;
  fadeIn?: number;
  fadeOut?: number;
  effect?: ClipEffect;
  effectAmount?: number;
  /** 对方选中 take 的稳定身份（编号在规范化后可能变化）。 */
  activeTakeId?: string;
}

export interface AudioClip {
  id: string;
  assetId: string;
  name: string;
  start: number;
  duration: number;
  offset: number;
  fadeIn: number;
  fadeOut: number;
  effect: ClipEffect;
  effectAmount: number;
  /** take 列表，按编号升序；旧工程/导入素材只有一个 take 1。 */
  takes?: ClipTake[];
  /** 当前主轨引用的 take 编号，必须存在于 takes 中。 */
  activeTakeNo?: number;
  /**
   * 修订号：几何（start/duration/offset）或 take 引用变化时自增，
   * 触发受牵连片段的波形缓存与导出预案重算。
   */
  revision?: number;
  /** 双页签合并时双方都改过同一字段、暂时无法自动取舍的标记。 */
  conflict?: boolean;
  /** 冲突留档：另一个页签的取值，用户在检查器里对照后解决冲突。 */
  remoteSnapshot?: ClipRemoteSnapshot;
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

export interface WaveformCacheEntry {
  /** 缓存键，由 asset/take、clip 修订、几何与缩放级别派生。 */
  key: string;
  peaks: number[];
  duration: number;
  sampleRate: number;
  savedAt: number;
}

export interface ExportPlanClip {
  trackId: string;
  clipId: string;
  assetId: string;
  activeTakeNo: number;
  start: number;
  duration: number;
  offset: number;
  fadeIn: number;
  fadeOut: number;
  effect: ClipEffect;
  effectAmount: number;
  revision: number;
}

export interface ExportPlan {
  /** 预案签名：循环区间或任何受牵连片段变化时改变，用于提示需要重算。 */
  signature: string;
  rangeStart: number;
  rangeEnd: number;
  clips: ExportPlanClip[];
  computedAt: number;
}

/**
 * 录音通过容量预检、但保存进工程失败时（如 localStorage 写满），
 * 录音本体保留在这里，避免“录音失败后上一个 take 丢失”。
 */
export interface PendingRecording {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  duration: number;
  dataUrl: string;
  targetTrackId: string;
  /** true = 叠录到该片段（append）；false = 在播放头处新建片段。 */
  punchIn: boolean;
  clipId?: string;
  failedAt: number;
  reason: string;
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
  /** 最近一次（按时间）确认写入的 take asset id，供恢复使用。 */
  lastTakeAssetId?: string;
  /** 双页签合并后等待用户处理的冲突片段 id。 */
  conflictClipIds?: string[];
  updatedAt: number;
}
