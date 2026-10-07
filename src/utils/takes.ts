import type {
  AssetSource,
  AudioAsset,
  AudioClip,
  AudioProject,
  AudioTake,
  ExportPlanItem,
} from '../types/audio';

/** 本地工程容量上限（字节），留出余量避免触发 localStorage 配额错误 */
export const STORAGE_LIMIT = 4 * 1024 * 1024;

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 判断片段是否为旧版无 take 结构 */
export function isLegacyClip(clip: AudioClip): boolean {
  return !Array.isArray(clip.takes) || clip.takes.length === 0;
}

/**
 * 将旧版片段迁移为 take 结构。
 * 旧工程没有 take 编号，打开时补齐为单个 take 后才能继续编辑。
 */
export function migrateClipToTakes(clip: AudioClip): AudioClip {
  if (!isLegacyClip(clip)) return clip;
  const legacy = clip as AudioClip & { assetId?: string; duration?: number; offset?: number };
  const take: AudioTake = {
    id: uid('take'),
    takeNumber: 1,
    assetId: legacy.assetId ?? '',
    name: clip.name,
    duration: legacy.duration ?? 1,
    offset: legacy.offset ?? 0,
    recordedAt: 0,
  };
  return {
    ...clip,
    takes: [take],
    activeTakeId: take.id,
    conflict: false,
    waveformEpoch: 0,
  };
}

/** 批量迁移工程中的所有片段 */
export function migrateProject(project: AudioProject): AudioProject {
  let changed = false;
  const tracks = project.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      if (isLegacyClip(clip)) {
        changed = true;
        return migrateClipToTakes(clip);
      }
      return clip;
    }),
  }));
  return changed ? { ...project, version: 2, tracks } : project;
}

/** 获取片段当前激活的 take */
export function getActiveTake(clip: AudioClip): AudioTake {
  const active = clip.takes.find((take) => take.id === clip.activeTakeId);
  return active ?? clip.takes[0];
}

/** 获取片段当前激活 take 引用的素材 */
export function getActiveAsset(clip: AudioClip, assets: AudioAsset[]): AudioAsset | undefined {
  const take = getActiveTake(clip);
  return assets.find((asset) => asset.id === take.assetId);
}

/** 片段的有效时长（取自激活 take） */
export function getClipDuration(clip: AudioClip): number {
  return getActiveTake(clip)?.duration ?? 1;
}

/** 片段的有效偏移（取自激活 take） */
export function getClipOffset(clip: AudioClip): number {
  return getActiveTake(clip)?.offset ?? 0;
}

/** 构造一个新 take */
export function createTake(
  asset: AudioAsset,
  takeNumber: number,
  duration: number,
  offset = 0,
): AudioTake {
  return {
    id: uid('take'),
    takeNumber,
    assetId: asset.id,
    name: asset.name,
    duration,
    offset,
    recordedAt: Date.now(),
  };
}

/** 计算片段下一个 take 编号 */
export function nextTakeNumber(clip: AudioClip): number {
  return clip.takes.reduce((max, take) => Math.max(max, take.takeNumber), 0) + 1;
}

/**
 * 派生导出预案：遍历所有轨道的所有片段，取当前激活 take 的导出参数。
 * 循环区间或片段边界变化后此预案随之重算。
 */
export function selectExportPlan(project: AudioProject): ExportPlanItem[] {
  const items: ExportPlanItem[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const take = getActiveTake(clip);
      if (!take) continue;
      const asset = project.assets.find((item) => item.id === take.assetId);
      items.push({
        trackId: track.id,
        trackName: track.name,
        clipId: clip.id,
        clipName: clip.name,
        takeId: take.id,
        takeNumber: take.takeNumber,
        assetId: take.assetId,
        source: (asset?.source ?? 'recorded') as AssetSource,
        start: clip.start,
        duration: take.duration,
        offset: take.offset,
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
        effect: clip.effect,
        effectAmount: clip.effectAmount,
        conflict: clip.conflict ?? false,
      });
    }
  }
  return items.sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId));
}

/** 估算工程序列化后的字节数，用于素材库容量校验 */
export function estimateProjectSize(project: AudioProject): number {
  try {
    return new Blob([JSON.stringify(project)]).size;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 多页签合并：按 take 编号对齐合并双方工程。
 * - 仅一方改过的片段直接采用该方版本；
 * - 双方都改过的片段先标记 conflict，并保留双方 take；
 * - 素材按 id 合并，不丢弃任何一方的录音。
 */
export function mergeProjects(current: AudioProject, incoming: AudioProject): AudioProject {
  const incomingTracks = new Map(incoming.tracks.map((track) => [track.id, track]));
  const mergedTracks = current.tracks.map((curTrack) => {
    const incTrack = incomingTracks.get(curTrack.id);
    if (!incTrack) return curTrack;
    return { ...curTrack, clips: mergeClips(curTrack.clips, incTrack.clips) };
  });
  for (const incTrack of incoming.tracks) {
    if (!current.tracks.some((track) => track.id === incTrack.id)) {
      mergedTracks.push(incTrack);
    }
  }

  const mergedAssets = mergeAssets(current.assets, incoming.assets);

  return {
    ...current,
    tracks: mergedTracks,
    assets: mergedAssets,
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
  };
}

function mergeAssets(current: AudioAsset[], incoming: AudioAsset[]): AudioAsset[] {
  const byId = new Map<string, AudioAsset>();
  for (const asset of current) byId.set(asset.id, asset);
  for (const asset of incoming) {
    const existing = byId.get(asset.id);
    if (!existing || (asset.dataUrl && !existing.dataUrl)) {
      byId.set(asset.id, asset);
    }
  }
  return [...byId.values()];
}

function mergeClips(currentClips: AudioClip[], incomingClips: AudioClip[]): AudioClip[] {
  const incomingById = new Map(incomingClips.map((clip) => [clip.id, clip]));
  const result: AudioClip[] = [];

  for (const curClip of currentClips) {
    const incClip = incomingById.get(curClip.id);
    if (!incClip) {
      result.push(curClip);
      continue;
    }
    result.push(mergeClipPair(curClip, incClip));
  }

  for (const incClip of incomingClips) {
    if (!currentClips.some((clip) => clip.id === incClip.id)) {
      result.push(incClip);
    }
  }

  return result;
}

function mergeClipPair(current: AudioClip, incoming: AudioClip): AudioClip {
  const { takes, conflict } = mergeTakes(current.takes, incoming.takes);
  const bothModified =
    current.activeTakeId !== incoming.activeTakeId ||
    current.start !== incoming.start ||
    current.fadeIn !== incoming.fadeIn ||
    current.fadeOut !== incoming.fadeOut ||
    current.effect !== incoming.effect ||
    current.effectAmount !== incoming.effectAmount;

  // 确定性选择激活 take：按 take 录制时间，避免多页签合并时来回跳变
  const currentTake = getActiveTake(current);
  const incomingTake = getActiveTake(incoming);
  const activeTakeId =
    (incomingTake?.recordedAt ?? 0) > (currentTake?.recordedAt ?? 0)
      ? incoming.activeTakeId
      : current.activeTakeId;

  return {
    ...current,
    takes,
    activeTakeId,
    conflict: conflict || bothModified || current.conflict || incoming.conflict,
  };
}

/** 按 take 编号合并 take 列表，编号相同但内容不同则标记冲突 */
function mergeTakes(
  currentTakes: AudioTake[],
  incomingTakes: AudioTake[],
): { takes: AudioTake[]; conflict: boolean } {
  const byNumber = new Map<number, AudioTake>();
  let conflict = false;

  for (const take of currentTakes) byNumber.set(take.takeNumber, take);
  for (const incTake of incomingTakes) {
    const curTake = byNumber.get(incTake.takeNumber);
    if (!curTake) {
      byNumber.set(incTake.takeNumber, incTake);
      continue;
    }
    if (
      curTake.assetId !== incTake.assetId ||
      curTake.duration !== incTake.duration ||
      curTake.offset !== incTake.offset
    ) {
      conflict = true;
      // 同编号 take 内容冲突：保留当前版本，冲突留给用户裁决
    }
  }

  return {
    takes: [...byNumber.values()].sort((a, b) => a.takeNumber - b.takeNumber),
    conflict,
  };
}
