import type { AudioAsset, AudioClip } from '../types/audio';
import { WAVEFORM_STORAGE_KEY, safeStorageSet } from './storage';

/**
 * 波形缓存。循环区间或片段边界一变，clip.revision 自增，
 * 缓存键随之失效 → 受牵连片段按新边界重算波形，其余片段命中缓存不重解码。
 */
export interface CachedPeaks {
  peaks: number[];
  duration: number;
  sampleRate: number;
  savedAt: number;
}

interface WaveformCacheFile {
  version: 1;
  entries: Record<string, CachedPeaks>;
}

const MAX_ENTRIES = 140;
const MAX_STORAGE_CHARS = 1_100_000;

let store: Record<string, CachedPeaks> | null = null;

function load(): Record<string, CachedPeaks> {
  if (store) return store;
  try {
    const raw = localStorage.getItem(WAVEFORM_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<WaveformCacheFile>) : null;
    store = parsed && parsed.version === 1 && parsed.entries ? parsed.entries : {};
  } catch {
    store = {};
  }
  return store;
}

export function waveformKey(
  asset: AudioAsset,
  clip: AudioClip,
  pixelsPerSecond: number,
  widthPixels: number,
): string {
  const takeSeq = asset.takeSeq ?? 0;
  const zoomBucket = Math.round(pixelsPerSecond * 10) / 10;
  return [
    asset.id,
    `seq${takeSeq}`,
    `rev${clip.revision ?? 0}`,
    `off${Math.round(clip.offset * 100)}`,
    `dur${Math.round(clip.duration * 100)}`,
    `w${Math.round(widthPixels / 4)}`,
    `z${zoomBucket}`,
  ].join('|');
}

export function readWaveformCache(key: string): CachedPeaks | null {
  const hit = load()[key];
  return hit && Array.isArray(hit.peaks) && hit.peaks.length > 0 ? hit : null;
}

export function writeWaveformCache(key: string, value: CachedPeaks): void {
  const entries = load();
  entries[key] = value;
  prune(entries);
  const file: WaveformCacheFile = { version: 1, entries };
  safeStorageSet(WAVEFORM_STORAGE_KEY, JSON.stringify(file));
}

/** 删除与某个 take 声音（asset）相关的所有缓存；take 重选/恢复后强制重算。 */
export function invalidateWaveformForAssets(assetIds: Iterable<string>): void {
  const entries = load();
  const ids = new Set(assetIds);
  let changed = false;
  for (const key of Object.keys(entries)) {
    const assetId = key.slice(0, key.indexOf('|'));
    if (ids.has(assetId)) {
      delete entries[key];
      changed = true;
    }
  }
  if (changed) {
    safeStorageSet(WAVEFORM_STORAGE_KEY, JSON.stringify({ version: 1, entries } satisfies WaveformCacheFile));
  }
}

/** 循环区间变化时调用：只有与 [start,end] 有交集的片段需要重算。 */
export function invalidateWaveformsForRange(
  rangeStart: number,
  rangeEnd: number,
  clips: { assetId: string; start: number; duration: number }[],
): void {
  const assetIds = clips
    .filter((clip) => clip.start < rangeEnd && clip.start + clip.duration > rangeStart)
    .map((clip) => clip.assetId);
  if (assetIds.length) invalidateWaveformForAssets(assetIds);
}

function prune(entries: Record<string, CachedPeaks>): void {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_ENTRIES) return;
  keys
    .sort((a, b) => entries[a].savedAt - entries[b].savedAt)
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach((key) => delete entries[key]);
  // 极端情况下仍超大则继续按最旧淘汰。
  while (
    Object.keys(entries).length > 1 &&
    JSON.stringify(entries).length > MAX_STORAGE_CHARS
  ) {
    const oldest = Object.keys(entries).sort((a, b) => entries[a].savedAt - entries[b].savedAt)[0];
    delete entries[oldest];
  }
}

/** 从 AudioBuffer 抽取可视片段（offset 起、duration 长）的峰值数据。 */
export function extractPeaks(
  buffer: AudioBuffer,
  offset: number,
  duration: number,
  targetWidthPx: number,
): { peaks: number[]; sampleRate: number } {
  const safeOffset = Math.max(0, Math.min(buffer.duration, offset));
  const safeDuration = Math.max(0.01, Math.min(duration, buffer.duration - safeOffset));
  const barWidth = 2;
  const peaksCount = Math.max(48, Math.ceil(targetWidthPx / barWidth));
  const startSample = Math.floor(safeOffset * buffer.sampleRate);
  const sampleCount = Math.max(1, Math.floor(safeDuration * buffer.sampleRate));
  const windowSize = Math.max(1, Math.floor(sampleCount / peaksCount));
  const channelMono = buffer.numberOfChannels === 1
    ? buffer.getChannelData(0)
    : mixToMono(buffer);
  const peaks: number[] = [];
  for (let index = 0; index < peaksCount; index += 1) {
    const from = startSample + index * windowSize;
    const to = Math.min(channelMono.length, from + windowSize);
    let peak = 0;
    for (let sample = from; sample < to; sample += 1) {
      const value = Math.abs(channelMono[sample] ?? 0);
      if (value > peak) peak = value;
    }
    peaks.push(Number(peak.toFixed(4)));
  }
  return { peaks, sampleRate: buffer.sampleRate };
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      mono[index] += data[index] / buffer.numberOfChannels;
    }
  }
  return mono;
}
