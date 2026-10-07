import { PROJECT_VERSION } from '../types/audio';
import type {
  AudioAsset,
  AudioClip,
  AudioProject,
  AudioTrack,
  ClipRemoteSnapshot,
  ClipTake,
  TrackColor,
} from '../types/audio';

const TRACK_COLORS: TrackColor[] = ['#2563eb', '#0f9f7a', '#d97706', '#c2413b', '#7c3aed', '#0891b2'];

/**
 * 旧工程（v1）没有 take 编号：打开时把每个片段补成“take 1 → 原 asset”，
 * 工程升级到 v2 后才允许继续编辑。导入文件与 localStorage 恢复都走这里。
 */
export function migrateProject(input: unknown): AudioProject {
  if (!input || typeof input !== 'object') {
    throw new Error('工程文件为空或格式损坏');
  }
  const raw = input as Partial<AudioProject> & { version?: number };
  if (!Array.isArray(raw.tracks) || !Array.isArray(raw.assets)) {
    throw new Error('不是有效的 WaveForge 工程文件');
  }
  const assets: AudioAsset[] = raw.assets.map((asset) => ({
    ...asset,
    takeSeq: typeof asset.takeSeq === 'number' ? asset.takeSeq : 0,
  }));
  const tracks: AudioTrack[] = raw.tracks.map((track, trackIndex) => ({
    id: track.id,
    name: track.name ?? `音频轨 ${trackIndex + 1}`,
    color: (track.color as TrackColor) ?? TRACK_COLORS[trackIndex % TRACK_COLORS.length],
    volume: clamp(Number(track.volume ?? 0.72), 0, 1),
    pan: clamp(Number(track.pan ?? 0), -1, 1),
    muted: Boolean(track.muted),
    solo: Boolean(track.solo),
    height: Number(track.height ?? 112),
    clips: track.clips.map((clip) => migrateClip(clip, assets)),
  }));
  return {
    version: PROJECT_VERSION,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : '未命名工程',
    bpm: clamp(Number(raw.bpm ?? 120), 40, 240),
    snap: Number(raw.snap ?? 0.25),
    loopEnabled: Boolean(raw.loopEnabled),
    loopStart: Math.max(0, Number(raw.loopStart ?? 0)),
    loopEnd: Math.max(Number(raw.loopEnd ?? 8), 0.25),
    pixelsPerSecond: Number(raw.pixelsPerSecond ?? 92),
    tracks,
    assets,
    lastTakeAssetId: raw.lastTakeAssetId,
    conflictClipIds: Array.isArray(raw.conflictClipIds) ? raw.conflictClipIds : [],
    updatedAt: Number(raw.updatedAt ?? Date.now()),
  };
}

function migrateClip(clip: AudioClip, assets: AudioAsset[]): AudioClip {
  const revision = typeof clip.revision === 'number' ? clip.revision : 1;
  let takes = Array.isArray(clip.takes) ? clip.takes.filter(isTake) : [];
  let activeTakeNo = typeof clip.activeTakeNo === 'number' ? clip.activeTakeNo : null;
  if (takes.length === 0) {
    // v1：原 assetId 即 take 1 的独立声音。
    takes = [
      {
        id: `take1:${clip.id}:${clip.assetId}`,
        assetId: clip.assetId,
        name: clip.name,
        no: 1,
        createdAt: 0,
      },
    ];
  }
  // 身份补齐：旧数据没有 take.id 时，用“片段+asset”生成稳定身份。
  takes = takes.map((take) => ({
    ...take,
    id: take.id ?? `take:${clip.id}:${take.assetId}`,
  }));
  const assetIds = new Set(assets.map((asset) => asset.id));
  // 同身份去重（保留编号较小者），再规范化编号。
  const byId = new Map<string, ClipTake>();
  for (const take of takes) {
    const existing = byId.get(take.id);
    if (!existing || take.no < existing.no) byId.set(take.id, assetIds.has(take.assetId) ? take : take);
  }
  takes = canonicalizeTakeNumbers([...byId.values()]);
  // 声音丢失的 take（迁移自损坏数据）：指回 clip.assetId。
  const fallbackAssetId = assetIds.has(clip.assetId) ? clip.assetId : assets[0]?.id ?? clip.assetId;
  takes = takes.map((take) =>
    assetIds.has(take.assetId) ? take : { ...take, assetId: fallbackAssetId },
  );
  if (takes.length === 0) {
    takes = canonicalizeTakeNumbers([
      { id: `take1:${clip.id}:${fallbackAssetId}`, assetId: fallbackAssetId, name: clip.name, no: 1, createdAt: 0 },
    ]);
  }
  const chosenActive =
    activeTakeNo !== null
      ? // 编号可能在规范化后变化，因此先找原编号、否则退化为最后一条。
        [...takes].sort((a, b) => b.no - a.no).find((take) => take.no === activeTakeNo) ??
        takes[takes.length - 1]
      : takes[takes.length - 1];
  const active = chosenActive ?? takes[takes.length - 1];
  return {
    ...clip,
    assetId: active.assetId,
    takes,
    activeTakeNo: active.no,
    revision,
    conflict: Boolean(clip.conflict),
    duration: Math.max(0.02, Number(clip.duration)),
    offset: Math.max(0, Number(clip.offset)),
    fadeIn: Math.max(0, Number(clip.fadeIn ?? 0)),
    fadeOut: Math.max(0, Number(clip.fadeOut ?? 0)),
    effectAmount: clamp(Number(clip.effectAmount ?? 0), 0, 100),
  };
}

function isTake(value: unknown): value is ClipTake {
  if (!value || typeof value !== 'object') return false;
  const take = value as Partial<ClipTake>;
  return typeof take.assetId === 'string' && typeof take.no === 'number';
}

/** 按 (createdAt, 原 no, id) 稳定排序后把编号规范化为 1..N，合并结果因此与方向无关。 */
export function canonicalizeTakeNumbers(takes: ClipTake[]): ClipTake[] {
  return [...takes]
    .sort(
      (a, b) =>
        (a.createdAt || 0) - (b.createdAt || 0) ||
        a.no - b.no ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((take, index) => ({ ...take, no: index + 1 }));
}

/** 按身份去重，后写的元数据不覆盖先写的声音。 */
function dedupeTakeById(takes: ClipTake[]): ClipTake[] {
  const byId = new Map<string, ClipTake>();
  for (const take of takes) {
    if (!byId.has(take.id)) byId.set(take.id, take);
  }
  return [...byId.values()];
}

export function clipTakes(clip: AudioClip): ClipTake[] {
  return clip.takes && clip.takes.length > 0 ? clip.takes : fallbackTakes(clip);
}

export function activeTakeOf(clip: AudioClip, _assets?: AudioAsset[]): ClipTake {
  const takes = clipTakes(clip);
  return takes.find((take) => take.no === clip.activeTakeNo) ?? takes[takes.length - 1];
}

export function nextTakeNumber(clip: AudioClip): number {
  return clipTakes(clip).reduce((max, take) => Math.max(max, take.no), 0) + 1;
}

function fallbackTakes(clip: AudioClip): ClipTake[] {
  return [{ id: clip.assetId, assetId: clip.assetId, name: clip.name, no: clip.activeTakeNo ?? 1, createdAt: 0 }];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// 双页签合并：两个页签各自修改同一工程，再在一个页签里读到对方的持久化结果。
// 规则：take 按编号合并（双方的声音都保留）；双方都改过的同一片段先标冲突，
// 几何/效果以本地为准，对方的取值放进 snapshot 供检查器对照后解决。
// ---------------------------------------------------------------------------

export interface MergeResult {
  project: AudioProject;
  conflicts: string[];
  /** 本地新增、合并后被吸收的 take 数量。 */
  mergedTakes: number;
}

const GEOMETRY_KEYS = ['start', 'duration', 'offset'] as const;
const SETTING_KEYS = ['fadeIn', 'fadeOut', 'effect', 'effectAmount'] as const;

interface ClipContext {
  clip: AudioClip;
  track: AudioTrack;
}

export function mergeProjects(local: AudioProject, remote: AudioProject): MergeResult {
  const localBase = migrateProject(local);
  const remoteBase = migrateProject(remote);
  const conflicts = new Set<string>();
  let mergedTakes = 0;

  // 素材：以 id 为键并集；takeSeq 取较大值，声音本身不会在合并中被覆盖。
  const assetMap = new Map<string, AudioAsset>();
  for (const asset of localBase.assets) assetMap.set(asset.id, asset);
  for (const asset of remoteBase.assets) {
    const existing = assetMap.get(asset.id);
    if (!existing) {
      assetMap.set(asset.id, asset);
    } else {
      assetMap.set(asset.id, {
        ...existing,
        ...asset,
        // 同名 id 内容冲突时保留本地声音，仅吸收元数据；seq 取大。
        dataUrl: existing.dataUrl ?? asset.dataUrl,
        duration: Math.max(existing.duration, asset.duration),
        takeSeq: Math.max(existing.takeSeq ?? 0, asset.takeSeq ?? 0),
      });
    }
  }

  const localIndex = indexClips(localBase);
  const remoteIndex = indexClips(remoteBase);
  const clipIds = new Set<string>([...localIndex.keys(), ...remoteIndex.keys()]);

  const mergedClips = new Map<string, AudioClip>();
  for (const id of clipIds) {
    const localCtx = localIndex.get(id);
    const remoteCtx = remoteIndex.get(id);
    if (localCtx && remoteCtx) {
      const merged = mergeClip(localCtx.clip, remoteCtx.clip, {
        onConflict: () => conflicts.add(id),
        onTakeMerged: () => {
          mergedTakes += 1;
        },
      });
      mergedClips.set(id, merged);
    } else if (localCtx) {
      mergedClips.set(id, localCtx.clip);
    } else if (remoteCtx) {
      mergedClips.set(id, remoteCtx.clip);
    }
  }

  // 轨道并集：本地在前，远程多出的追加在后；片段按合并结果回填。
  const trackIds: string[] = [];
  for (const track of localBase.tracks) if (!trackIds.includes(track.id)) trackIds.push(track.id);
  for (const track of remoteBase.tracks) if (!trackIds.includes(track.id)) trackIds.push(track.id);
  const localTracks = new Map(localBase.tracks.map((track) => [track.id, track]));
  const remoteTracks = new Map(remoteBase.tracks.map((track) => [track.id, track]));
  const tracks: AudioTrack[] = trackIds.map((trackId) => {
    const localTrack = localTracks.get(trackId);
    const remoteTrack = remoteTracks.get(trackId);
    const base = localTrack ?? remoteTrack;
    if (!base) throw new Error('轨道合并异常');
    // 片段位置以远程最终所在轨道为准（跟随移动），但本地独有的留本地轨。
    const orderedIds: string[] = [];
    const remoteClipIds = remoteTrack?.clips.map((clip) => clip.id) ?? [];
    const localClipIds = localTrack?.clips.map((clip) => clip.id) ?? [];
    if (remoteTrack) {
      for (const cid of remoteClipIds) {
        if (mergedClips.has(cid) && !orderedIds.includes(cid)) orderedIds.push(cid);
      }
    }
    for (const cid of localClipIds) {
      if (!orderedIds.includes(cid) && mergedClips.has(cid)) orderedIds.push(cid);
    }
    // 远程独有的片段也要出现在它原本的远程轨道上。
    if (remoteTrack) {
      for (const cid of remoteClipIds) {
        if (!orderedIds.includes(cid) && mergedClips.has(cid)) orderedIds.push(cid);
      }
    }
    const clips = orderedIds
      .map((cid) => mergedClips.get(cid))
      .filter((clip): clip is AudioClip => Boolean(clip));
    return {
      ...base,
      // 混音参数：双方都动过也算冲突范畴的一部分，但这里取较新值，不阻塞片段操作。
      volume: pickNewer(localTrack?.volume, remoteTrack?.volume, localBase.updatedAt, remoteBase.updatedAt) ?? base.volume,
      pan: pickNewer(localTrack?.pan, remoteTrack?.pan, localBase.updatedAt, remoteBase.updatedAt) ?? base.pan,
      muted: (remoteBase.updatedAt > localBase.updatedAt ? remoteTrack?.muted : localTrack?.muted) ?? base.muted,
      solo: (remoteBase.updatedAt > localBase.updatedAt ? remoteTrack?.solo : localTrack?.solo) ?? base.solo,
      name: (remoteBase.updatedAt > localBase.updatedAt ? remoteTrack?.name : localTrack?.name) ?? base.name,
      clips,
    };
  });

  const assetsResolved = dedupeAssets([...assetMap.values()]);
  const project: AudioProject = {
    ...localBase,
    tracks,
    assets: assetsResolved,
    conflictClipIds: [...conflicts],
    updatedAt: Date.now(),
  };
  // 最终再 migrate 一遍，补齐合并中引用到的声音并修正 assetId。
  const resolved = migrateProject(project);
  return { project: resolved, conflicts: [...conflicts], mergedTakes };
}

function mergeClip(
  local: AudioClip,
  remote: AudioClip,
  hooks: { onConflict: () => void; onTakeMerged: () => void },
): AudioClip {
  // 1) take 按“身份”合并（而非编号）：双方各自的声音都保留，编号按统一规则
  //    重新规范化为 1..N。这样无论先收到谁的更新，合并结果都相同，不会在
  //    页签间来回传播时把同一声音重复编号。
  const localTakes = clipTakes(local);
  const remoteTakes = clipTakes(remote);
  const localIds = new Set(localTakes.map((take) => take.id));
  const beforeCount = localTakes.length;
  const unionTakes = canonicalizeTakeNumbers(dedupeTakeById([...localTakes, ...remoteTakes]));
  const addedCount = unionTakes.length - beforeCount;
  for (let index = 0; index < addedCount; index += 1) hooks.onTakeMerged();

  const mapActive = (clipTakesList: ClipTake[], no: number | undefined): ClipTake | undefined =>
    clipTakesList.find((take) => take.no === no);
  const localActiveOld = mapActive(localTakes, local.activeTakeNo) ?? localTakes.at(-1);
  const remoteActiveOld = mapActive(remoteTakes, remote.activeTakeNo) ?? remoteTakes.at(-1);
  // 激活选择按身份平移到新编号。
  const localActive = localActiveOld
    ? unionTakes.find((take) => take.id === localActiveOld.id)
    : undefined;
  const remoteActive = remoteActiveOld
    ? unionTakes.find((take) => take.id === remoteActiveOld.id)
    : undefined;
  const active = localActive ?? unionTakes.at(-1)!;

  // 已在上一轮合并中留过冲突：结果必须对双方输入幂等，否则两个页签会互相覆写。
  if (local.conflict && remote.conflict) {
    hooks.onConflict();
    return {
      ...local,
      takes: unionTakes,
      activeTakeNo: active.no,
      assetId: active.assetId,
      conflict: true,
      remoteSnapshot: local.remoteSnapshot ?? remote.remoteSnapshot,
      revision: Math.max(local.revision ?? 1, remote.revision ?? 1),
    };
  }

  // 2) 字段级冲突检测：双方几何/设置/引用都可能改过。
  const changedKeys = new Set<string>();
  for (const key of [...GEOMETRY_KEYS, ...SETTING_KEYS]) {
    if (local[key] !== remote[key]) changedKeys.add(key);
  }
  const activeTakeChanged = Boolean(
    localActive && remoteActive && localActive.id !== remoteActive.id,
  );
  const hasConflict = changedKeys.size > 0 || activeTakeChanged;
  if (hasConflict) hooks.onConflict();

  // 3) 本地值胜出；对方选中的 take 用新编号记入快照，供检查器“先留冲突”后解决。
  const snapshot: ClipRemoteSnapshot = {};
  for (const key of changedKeys) {
    (snapshot as Record<string, unknown>)[key] = remote[key as keyof AudioClip];
  }
  if (activeTakeChanged && remoteActive) snapshot.activeTakeId = remoteActive.id;

  return {
    ...local,
    takes: unionTakes,
    activeTakeNo: active.no,
    assetId: active.assetId,
    revision: Math.max(local.revision ?? 1, remote.revision ?? 1) + (hasConflict ? 1 : 0),
    conflict: hasConflict,
    ...(hasConflict ? { remoteSnapshot: snapshot } : { remoteSnapshot: undefined }),
  };
}

function pickNewer<T>(
  localValue: T | undefined,
  remoteValue: T | undefined,
  localTime: number,
  remoteTime: number,
): T | undefined {
  if (localValue === undefined) return remoteValue;
  if (remoteValue === undefined) return localValue;
  return remoteTime > localTime ? remoteValue : localValue;
}

function indexClips(project: AudioProject): Map<string, ClipContext> {
  const index = new Map<string, ClipContext>();
  for (const track of project.tracks) {
    for (const clip of track.clips) index.set(clip.id, { clip, track });
  }
  return index;
}

function dedupeAssets(assets: AudioAsset[]): AudioAsset[] {
  const map = new Map<string, AudioAsset>();
  for (const asset of assets) {
    if (!map.has(asset.id)) map.set(asset.id, asset);
  }
  return [...map.values()];
}
