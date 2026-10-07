import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type {
  AudioAsset,
  AudioClip,
  AudioProject,
  AudioTrack,
  ClipEffect,
  ClipTake,
  PendingRecording,
  TrackColor,
} from '../types/audio';
import { PROJECT_VERSION } from '../types/audio';
import { SYNTHETIC_ASSETS } from '../utils/syntheticAudio';
import {
  PROJECT_STORAGE_KEY,
  StorageQuotaError,
  assertStorageCapacity,
  formatBytes,
  safeStorageSet,
} from '../utils/storage';
import { activeTakeOf, canonicalizeTakeNumbers, mergeProjects, migrateProject, nextTakeNumber } from '../utils/takes';
import { invalidateWaveformForAssets, invalidateWaveformsForRange } from '../utils/waveformCache';

const TRACK_COLORS: TrackColor[] = ['#2563eb', '#0f9f7a', '#d97706', '#c2413b', '#7c3aed', '#0891b2'];

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const canonicalBuiltinAssets: AudioAsset[] = SYNTHETIC_ASSETS.map((asset) => ({
  id: asset.id,
  name: asset.name,
  source: 'synthetic',
  duration: asset.duration,
  mimeType: asset.mimeType,
  takeSeq: 1,
}));

function take(assetId: string, name: string, no: number, createdAt = 0): ClipTake {
  return { id: assetId, assetId, name, no, createdAt };
}

function initialProject(): AudioProject {
  const tracks: AudioTrack[] = [
    {
      id: 'track-drums',
      name: '节奏 / Drums',
      color: '#2563eb',
      volume: 0.78,
      pan: 0,
      muted: false,
      solo: false,
      height: 112,
      clips: [
        {
          id: 'clip-drums-a',
          assetId: 'synth-drums',
          name: '紧凑鼓组 A',
          start: 0,
          duration: 8,
          offset: 0,
          fadeIn: 0.05,
          fadeOut: 0.3,
          effect: 'none',
          effectAmount: 0,
          takes: [take('synth-drums', '紧凑鼓组 A', 1)],
          activeTakeNo: 1,
          revision: 1,
        },
      ],
    },
    {
      id: 'track-chords',
      name: '和声 / Chords',
      color: '#0f9f7a',
      volume: 0.58,
      pan: -0.08,
      muted: false,
      solo: false,
      height: 112,
      clips: [
        {
          id: 'clip-chords-a',
          assetId: 'synth-chords',
          name: '暖色和弦',
          start: 0,
          duration: 8,
          offset: 0,
          fadeIn: 0.65,
          fadeOut: 0.8,
          effect: 'lowpass',
          effectAmount: 22,
          takes: [take('synth-chords', '暖色和弦', 1)],
          activeTakeNo: 1,
          revision: 1,
        },
      ],
    },
    {
      id: 'track-bass',
      name: '低频 / Bass',
      color: '#d97706',
      volume: 0.68,
      pan: 0,
      muted: false,
      solo: false,
      height: 112,
      clips: [
        {
          id: 'clip-bass-a',
          assetId: 'synth-bass',
          name: '模拟贝斯',
          start: 4,
          duration: 4,
          offset: 0,
          fadeIn: 0.1,
          fadeOut: 0.2,
          effect: 'none',
          effectAmount: 0,
          takes: [take('synth-bass', '模拟贝斯', 1)],
          activeTakeNo: 1,
          revision: 1,
        },
      ],
    },
  ];
  return {
    version: PROJECT_VERSION,
    name: '未命名工程 · Night Drive',
    bpm: 120,
    snap: 0.25,
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 8,
    pixelsPerSecond: 92,
    tracks,
    assets: canonicalBuiltinAssets,
    conflictClipIds: [],
    updatedAt: Date.now(),
  };
}

/** 任何工程进入 store 前：迁移 take 编号（v1→v2）、校验数值、补回内置素材。 */
export function normalizeProject(project: unknown): AudioProject {
  const migrated = migrateProject(project);
  const customAssets = migrated.assets.filter(
    (asset) => !canonicalBuiltinAssets.some((builtin) => builtin.id === asset.id),
  );
  const assets = [...canonicalBuiltinAssets, ...customAssets];
  return migrateProject({ ...migrated, assets });
}

interface TakeUndoEntry {
  trackId: string;
  clipId: string;
  /** 被撤销 take 的稳定身份（= 其声音 asset id）。 */
  addedTakeId: string;
  previousTakeId: string;
}

export type CommitRecordingResult =
  | { ok: true; mode: 'punch' | 'create'; clipId: string; trackId: string }
  | { ok: false; pendingId: string; error: string };

interface StudioState {
  project: AudioProject;
  selectedClipId: string | null;
  selectedTrackId: string;
  isPlaying: boolean;
  playhead: number;
  zoom: number;
  projectSavedAt: number;
  /** 容量不足被拒绝、但录音本体仍保留的未保存项。 */
  pendingRecordings: PendingRecording[];
  /** 最近一次成功叠录，用于“恢复上一个 take”。 */
  lastTakeUndo: TakeUndoEntry | null;
  storageNotice: string | null;
  mergeNotice: string | null;
  setPlaying: (playing: boolean) => void;
  setPlayhead: (time: number) => void;
  setZoom: (zoom: number) => void;
  setProjectName: (name: string) => void;
  addTrack: () => void;
  updateTrack: (trackId: string, patch: Partial<AudioTrack>) => void;
  deleteTrack: (trackId: string) => void;
  addClip: (trackId: string, assetId: string, start?: number) => void;
  setClip: (trackId: string, clipId: string, patch: Partial<AudioClip>) => void;
  setClipEffect: (trackId: string, clipId: string, effect: ClipEffect, amount?: number) => void;
  moveClipToTrack: (fromTrackId: string, clipId: string, toTrackId: string, start: number) => void;
  duplicateClip: (trackId: string, clipId: string) => void;
  deleteClip: (trackId: string, clipId: string) => void;
  selectClip: (clipId: string | null) => void;
  updateTransport: (
    patch: Partial<Pick<AudioProject, 'bpm' | 'snap' | 'loopEnabled' | 'loopStart' | 'loopEnd' | 'pixelsPerSecond'>>,
  ) => void;
  importFile: (file: File) => Promise<void>;
  /** 把录音叠录到选中片段（新 take）或在目标位置新建片段。 */
  commitRecording: (input: {
    blob: Blob;
    duration: number;
    targetTrackId: string;
    clipId?: string;
  }) => Promise<CommitRecordingResult>;
  /** 容量恢复后重试未保存录音。 */
  retryPendingRecording: (pendingId: string) => CommitRecordingResult | { ok: false; error: string };
  discardPendingRecording: (pendingId: string) => void;
  /** 重选历史 take（主轨引用切换，声音不丢）。 */
  selectTake: (trackId: string, clipId: string, takeNo: number) => void;
  /** 撤销最近一次成功叠录，恢复上一个 take。 */
  undoLastTake: () => boolean;
  resolveConflict: (trackId: string, clipId: string, side: 'local' | 'remote') => void;
  replaceProject: (project: AudioProject) => void;
  mergeRemoteProject: (remote: AudioProject) => void;
  markSaved: () => void;
  clearNotices: () => void;
}

function timestamp(project: AudioProject): AudioProject {
  return { ...project, updatedAt: Date.now() };
}

async function readFileAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取音频文件失败'));
    reader.readAsDataURL(file);
  });
}

async function readAudioDuration(dataUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 8;
      resolve(duration);
      audio.src = '';
    };
    audio.onerror = () => reject(new Error('无法读取音频时长或格式不受浏览器支持'));
    audio.src = dataUrl;
  });
}

const GEOMETRY_PATCH: (keyof AudioClip)[] = ['start', 'duration', 'offset'];

/** 片段几何 / take 引用发生变化时自增修订号，驱动波形缓存与导出预案重算。 */
function withRevision(clip: AudioClip, patch: Partial<AudioClip>): AudioClip {
  const geometryChanged = GEOMETRY_PATCH.some(
    (key) => key in patch && patch[key] !== undefined && patch[key] !== clip[key],
  );
  const takeChanged = 'activeTakeNo' in patch || 'takes' in patch;
  if (!geometryChanged && !takeChanged) return { ...clip, ...patch };
  return { ...clip, ...patch, revision: (clip.revision ?? 1) + 1 };
}

function mapClip(
  project: AudioProject,
  trackId: string,
  clipId: string,
  update: (clip: AudioClip) => AudioClip,
): AudioProject {
  return {
    ...project,
    tracks: project.tracks.map((track) =>
      track.id === trackId
        ? {
            ...track,
            clips: track.clips.map((clip) => (clip.id === clipId ? update(clip) : clip)),
          }
        : track,
    ),
  };
}

function makeRecordedAsset(dataUrl: string, blob: Blob, duration: number, takeNo: number): AudioAsset {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return {
    id: uid('record'),
    name: `人声 Take ${takeNo} · ${stamp}`,
    source: 'recorded',
    duration,
    mimeType: blob.type || 'audio/webm',
    dataUrl,
    size: blob.size,
    takeSeq: 1,
  };
}

/** 容量预检：估算写入后的完整工程大小，不够就抛 StorageQuotaError。 */
function ensureProjectFits(project: AudioProject, extraDataUrlLength: number): void {
  const current = JSON.stringify(project).length;
  assertStorageCapacity(current + Math.ceil(extraDataUrlLength * 1.05) + 4096);
}

export const useStudioStore = create<StudioState>()(
  persist(
    (set, get) => {
      const commitAsset = (
        dataUrl: string,
        blob: Blob,
        duration: number,
        targetTrackId: string,
        clipId: string | undefined,
        reusePendingId?: string,
      ): CommitRecordingResult => {
        const state = get();
        const trackId = targetTrackId || state.selectedTrackId || state.project.tracks[0].id;
        const targetClip = clipId
          ? state.project.tracks.find((track) => track.id === trackId)?.clips.find((clip) => clip.id === clipId)
          : undefined;

        // 先做容量预检：不足时拒绝新 take，当前录音进入未保存列表。
        try {
          ensureProjectFits(state.project, dataUrl.length);
        } catch (error) {
          const reason =
            error instanceof StorageQuotaError
              ? error.message
              : '本地存储空间不可用，无法写入新 take。';
          const pending: PendingRecording = {
            id: uid('pending'),
            name: '',
            mimeType: blob.type || 'audio/webm',
            size: blob.size,
            duration,
            dataUrl,
            targetTrackId: trackId,
            punchIn: Boolean(targetClip),
            clipId,
            failedAt: Date.now(),
            reason,
          };
          pending.name = `${targetClip ? `叠录 · ${targetClip.name}` : '新建片段录音'} ${new Date(pending.failedAt).toLocaleTimeString('zh-CN')}`;
          set((current) => ({
            pendingRecordings: reusePendingId
              ? current.pendingRecordings.map((item) =>
                  item.id === reusePendingId ? { ...item, ...pending, id: reusePendingId, failedAt: item.failedAt } : item,
                )
              : [pending, ...current.pendingRecordings],
            storageNotice: reason,
          }));
          return { ok: false, pendingId: pending.id, error: reason };
        }

        if (targetClip) {
          // 叠录：旧 take 原样保留，主轨引用切到新 take 段落。
          const newTakeNo = nextTakeNumber(targetClip);
          const asset = makeRecordedAsset(dataUrl, blob, duration, newTakeNo);
          const previousTake = activeTakeOf(targetClip);
          let nextProject: AudioProject = {
            ...state.project,
            assets: [...state.project.assets, asset],
            lastTakeAssetId: asset.id,
          };
          nextProject = timestamp(
            mapClip(nextProject, trackId, targetClip.id, (clip) => {
              const takes = [...(clip.takes ?? []), take(asset.id, asset.name, newTakeNo, Date.now())];
              return withRevision(clip, {
                takes,
                activeTakeNo: newTakeNo,
                assetId: asset.id,
                name: clip.name,
              });
            }),
          );
          set({
            project: nextProject,
            selectedTrackId: trackId,
            selectedClipId: targetClip.id,
            lastTakeUndo: {
              trackId,
              clipId: targetClip.id,
              addedTakeId: asset.id,
              previousTakeId: previousTake.id,
            },
            storageNotice: null,
          });
          return { ok: true, mode: 'punch', clipId: targetClip.id, trackId };
        }

        // 新建片段：take 1 即本次录音。
        const asset = makeRecordedAsset(dataUrl, blob, duration, 1);
        const start = get().playhead;
        const clip: AudioClip = {
          id: uid('clip'),
          assetId: asset.id,
          name: `录音片段 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
          start: Math.max(0, start),
          duration,
          offset: 0,
          fadeIn: 0.03,
          fadeOut: 0.12,
          effect: 'none',
          effectAmount: 0,
          takes: [take(asset.id, asset.name, 1, Date.now())],
          activeTakeNo: 1,
          revision: 1,
        };
        const project = timestamp({
          ...state.project,
          assets: [...state.project.assets, asset],
          lastTakeAssetId: asset.id,
          tracks: state.project.tracks.map((track) =>
            track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track,
          ),
        });
        set({
          project,
          selectedTrackId: trackId,
          selectedClipId: clip.id,
          storageNotice: null,
        });
        return { ok: true, mode: 'create', clipId: clip.id, trackId };
      };

      return {
        project: initialProject(),
        selectedClipId: 'clip-chords-a',
        selectedTrackId: 'track-drums',
        isPlaying: false,
        playhead: 0,
        zoom: 1,
        projectSavedAt: Date.now(),
        pendingRecordings: [],
        lastTakeUndo: null,
        storageNotice: null,
        mergeNotice: null,

        setPlaying: (isPlaying) => set({ isPlaying }),
        setPlayhead: (playhead) => set({ playhead: Math.max(0, playhead) }),
        setZoom: (zoom) => set({ zoom: Math.max(0.5, Math.min(2.2, zoom)) }),
        setProjectName: (name) =>
          set((s) => ({ project: timestamp({ ...s.project, name: name || '未命名工程' }) })),

        addTrack: () =>
          set((state) => {
            const index = state.project.tracks.length;
            const newTrack: AudioTrack = {
              id: uid('track'),
              name: `音频轨 ${index + 1}`,
              color: TRACK_COLORS[index % TRACK_COLORS.length],
              volume: 0.72,
              pan: 0,
              muted: false,
              solo: false,
              height: 112,
              clips: [],
            };
            return {
              selectedTrackId: newTrack.id,
              project: timestamp({ ...state.project, tracks: [...state.project.tracks, newTrack] }),
            };
          }),

        updateTrack: (trackId, patch) =>
          set((state) => ({
            project: timestamp({
              ...state.project,
              tracks: state.project.tracks.map((track) =>
                track.id === trackId ? { ...track, ...patch } : track,
              ),
            }),
          })),

        deleteTrack: (trackId) =>
          set((state) => {
            if (state.project.tracks.length <= 1) return {};
            const tracks = state.project.tracks.filter((track) => track.id !== trackId);
            return {
              selectedTrackId: tracks[0].id,
              selectedClipId: null,
              project: timestamp({ ...state.project, tracks }),
            };
          }),

        addClip: (trackId, assetId, start) =>
          set((state) => {
            const asset = state.project.assets.find((item) => item.id === assetId);
            if (!asset) return {};
            const clip: AudioClip = {
              id: uid('clip'),
              assetId: asset.id,
              name: asset.name.replace(/^内置 · /, ''),
              start: Math.max(0, start ?? state.playhead),
              duration: asset.duration,
              offset: 0,
              fadeIn: 0.04,
              fadeOut: 0.12,
              effect: 'none',
              effectAmount: 0,
              takes: [take(asset.id, asset.name.replace(/^内置 · /, ''), 1)],
              activeTakeNo: 1,
              revision: 1,
            };
            return {
              project: timestamp({
                ...state.project,
                tracks: state.project.tracks.map((track) =>
                  track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track,
                ),
              }),
              selectedTrackId: trackId,
              selectedClipId: clip.id,
            };
          }),

        setClip: (trackId, clipId, patch) =>
          set((state) => ({
            project: timestamp(
              mapClip(state.project, trackId, clipId, (clip) => withRevision(clip, patch)),
            ),
          })),

        setClipEffect: (trackId, clipId, effect, amount) => {
          get().setClip(trackId, clipId, { effect, effectAmount: amount ?? 35 });
        },

        moveClipToTrack: (fromTrackId, clipId, toTrackId, start) =>
          set((state) => {
            const sourceTrack = state.project.tracks.find((track) => track.id === fromTrackId);
            const clip = sourceTrack?.clips.find((item) => item.id === clipId);
            if (!clip) return {};
            const moved = withRevision(clip, { start: Math.max(0, start) });
            return {
              project: timestamp({
                ...state.project,
                tracks: state.project.tracks.map((track) => {
                  if (track.id === fromTrackId && track.id === toTrackId) {
                    return {
                      ...track,
                      clips: track.clips.map((item) => (item.id === clipId ? moved : item)),
                    };
                  }
                  if (track.id === fromTrackId) {
                    return { ...track, clips: track.clips.filter((item) => item.id !== clipId) };
                  }
                  if (track.id === toTrackId) {
                    return { ...track, clips: [...track.clips, moved] };
                  }
                  return track;
                }),
              }),
              selectedTrackId: toTrackId,
              selectedClipId: clipId,
            };
          }),

        duplicateClip: (trackId, clipId) =>
          set((state) => {
            const track = state.project.tracks.find((item) => item.id === trackId);
            const clip = track?.clips.find((item) => item.id === clipId);
            if (!track || !clip) return {};
            // 复制件共享同一份声音素材，但拥有独立的 take 列表壳与修订号。
            const copy: AudioClip = {
              ...clip,
              id: uid('clip'),
              name: `${clip.name} 副本`,
              start: clip.start + clip.duration,
              revision: 1,
              conflict: false,
              remoteSnapshot: undefined,
              takes: (clip.takes ?? []).map((item) => ({ ...item })),
            };
            return {
              selectedClipId: copy.id,
              project: timestamp({
                ...state.project,
                tracks: state.project.tracks.map((item) =>
                  item.id === trackId ? { ...item, clips: [...item.clips, copy] } : item,
                ),
              }),
            };
          }),

        deleteClip: (trackId, clipId) =>
          set((state) => ({
            selectedClipId: null,
            lastTakeUndo:
              state.lastTakeUndo?.clipId === clipId ? null : state.lastTakeUndo,
            project: timestamp({
              ...state.project,
              conflictClipIds: (state.project.conflictClipIds ?? []).filter((id) => id !== clipId),
              tracks: state.project.tracks.map((track) =>
                track.id === trackId
                  ? { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }
                  : track,
              ),
            }),
          })),

        selectClip: (selectedClipId) => set({ selectedClipId }),

        updateTransport: (patch) =>
          set((state) => {
            const prev = state.project;
            const stamped = timestamp({ ...prev, ...patch });
            // 循环区间变化：受牵连片段（与旧区间或新区间相交）自增修订号，
            // 并作废对应波形缓存；导出预案签名随后自动改变。
            const loopMoved =
              ('loopStart' in patch && patch.loopStart !== prev.loopStart) ||
              ('loopEnd' in patch && patch.loopEnd !== prev.loopEnd) ||
              ('loopEnabled' in patch && patch.loopEnabled !== prev.loopEnabled);
            if (!loopMoved) return { project: stamped };
            const affected = new Set<string>();
            const collect = (start: number, end: number) => {
              prev.tracks.forEach((track) => {
                track.clips.forEach((clip) => {
                  if (clip.start < end && clip.start + clip.duration > start) {
                    affected.add(clip.id);
                  }
                });
              });
            };
            collect(prev.loopStart, prev.loopEnd);
            collect(stamped.loopStart, stamped.loopEnd);
            const invalidatedAssetIds: string[] = [];
            const next: AudioProject = {
              ...stamped,
              tracks:
                affected.size === 0
                  ? stamped.tracks
                  : stamped.tracks.map((track) => ({
                      ...track,
                      clips: track.clips.map((clip) => {
                        if (!affected.has(clip.id)) return clip;
                        invalidatedAssetIds.push(activeTakeOf(clip, stamped.assets).assetId);
                        return { ...clip, revision: (clip.revision ?? 1) + 1 };
                      }),
                    })),
            };
            invalidateWaveformsForRange(prev.loopStart, prev.loopEnd, allClips(next));
            invalidateWaveformsForRange(next.loopStart, next.loopEnd, allClips(next));
            invalidateWaveformForAssets(invalidatedAssetIds);
            return { project: next };
          }),

        importFile: async (file) => {
          if (file.size > 8 * 1024 * 1024) {
            throw new Error('单个音频文件请小于 8 MB，以避免浏览器本地存储超限');
          }
          const dataUrl = await readFileAsDataUrl(file);
          const state = get();
          try {
            ensureProjectFits(state.project, dataUrl.length);
          } catch (error) {
            throw new Error(
              error instanceof StorageQuotaError ? error.message : '本地存储空间不足，已取消导入。',
            );
          }
          const duration = await readAudioDuration(dataUrl);
          const asset: AudioAsset = {
            id: uid('asset'),
            name: file.name.replace(/\.[^.]+$/, ''),
            source: 'imported',
            duration,
            mimeType: file.type || 'audio/mpeg',
            dataUrl,
            size: file.size,
            takeSeq: 1,
          };
          set((current) => {
            const trackId = current.selectedTrackId || current.project.tracks[0].id;
            const clip: AudioClip = {
              id: uid('clip'),
              assetId: asset.id,
              name: asset.name,
              start: Math.max(0, current.playhead),
              duration,
              offset: 0,
              fadeIn: 0.04,
              fadeOut: 0.12,
              effect: 'none',
              effectAmount: 0,
              takes: [take(asset.id, asset.name, 1, Date.now())],
              activeTakeNo: 1,
              revision: 1,
            };
            return {
              project: timestamp({
                ...current.project,
                assets: [...current.project.assets, asset],
                tracks: current.project.tracks.map((track) =>
                  track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track,
                ),
              }),
              selectedTrackId: trackId,
              selectedClipId: clip.id,
            };
          });
        },

        commitRecording: async ({ blob, duration, targetTrackId, clipId }) => {
          const dataUrl = await readFileAsDataUrl(blob);
          return commitAsset(dataUrl, blob, duration, targetTrackId, clipId);
        },

        retryPendingRecording: (pendingId) => {
          const state = get();
          const pending = state.pendingRecordings.find((item) => item.id === pendingId);
          if (!pending) return { ok: false as const, error: '未保存项已不存在' };
          const blob = new Blob([pending.dataUrl], { type: pending.mimeType });
          const result = commitAsset(
            pending.dataUrl,
            blob,
            pending.duration,
            pending.targetTrackId,
            pending.punchIn ? pending.clipId : undefined,
            pending.id,
          );
          if (result.ok) {
            set((current) => ({
              pendingRecordings: current.pendingRecordings.filter((item) => item.id !== pendingId),
            }));
          }
          return result;
        },

        discardPendingRecording: (pendingId) =>
          set((state) => ({
            pendingRecordings: state.pendingRecordings.filter((item) => item.id !== pendingId),
          })),

        selectTake: (trackId, clipId, takeNo) =>
          set((state) => {
            const clip = state.project.tracks
              .find((track) => track.id === trackId)
              ?.clips.find((item) => item.id === clipId);
            if (!clip) return {};
            const chosen = (clip.takes ?? []).find((item) => item.no === takeNo);
            if (!chosen) return {};
            // 重选 take：切换主轨引用；声音切换迫使该片段波形重算。
            invalidateWaveformForAssets([chosen.assetId, activeTakeOf(clip).assetId]);
            return {
              project: timestamp(
                mapClip(state.project, trackId, clipId, (item) =>
                  withRevision(item, {
                    activeTakeNo: chosen.no,
                    assetId: chosen.assetId,
                  }),
                ),
              ),
            };
          }),

        undoLastTake: () => {
          const state = get();
          const undo = state.lastTakeUndo;
          if (!undo) return false;
          const clip = state.project.tracks
            .find((track) => track.id === undo.trackId)
            ?.clips.find((item) => item.id === undo.clipId);
          if (!clip || !clip.takes?.some((item) => item.id === undo.addedTakeId)) return false;
          const remainingTakes = clip.takes.filter((item) => item.id !== undo.addedTakeId);
          if (remainingTakes.length === 0) return false;
          // 编号按剩余身份重新规范化；恢复到叠录前选中的 take（身份匹配）。
          const ordered = canonicalizeTakeNumbers(remainingTakes);
          const restored = ordered.find((item) => item.id === undo.previousTakeId) ?? ordered.at(-1)!;
          const removedAssetId = clip.takes.find((item) => item.id === undo.addedTakeId)?.assetId;
          invalidateWaveformForAssets([removedAssetId ?? '', restored.assetId].filter(Boolean));
          set((current) => ({
            lastTakeUndo: null,
            project: timestamp({
              ...mapClip(current.project, undo.trackId, undo.clipId, (item) =>
                withRevision(
                  { ...item, takes: ordered },
                  { activeTakeNo: restored.no, assetId: restored.assetId },
                ),
              ),
              assets: removedAssetId
                ? removeAssetIfUnused(current.project.assets, removedAssetId, current.project.tracks, undo.clipId)
                : current.project.assets,
            }),
          }));
          return true;
        },

        resolveConflict: (trackId, clipId, side) =>
          set((state) => {
            const clip = state.project.tracks
              .find((track) => track.id === trackId)
              ?.clips.find((item) => item.id === clipId);
            if (!clip?.conflict || !clip.remoteSnapshot) return {};
            let patch: Partial<AudioClip> = {};
            if (side === 'remote') {
              const snapshot = clip.remoteSnapshot;
              patch = {
                start: snapshot.start ?? clip.start,
                duration: snapshot.duration ?? clip.duration,
                offset: snapshot.offset ?? clip.offset,
                fadeIn: snapshot.fadeIn ?? clip.fadeIn,
                fadeOut: snapshot.fadeOut ?? clip.fadeOut,
                effect: snapshot.effect ?? clip.effect,
                effectAmount: snapshot.effectAmount ?? clip.effectAmount,
              };
              if (snapshot.activeTakeId && clip.takes?.some((item) => item.id === snapshot.activeTakeId)) {
                const chosen = clip.takes.find((item) => item.id === snapshot.activeTakeId);
                if (chosen) {
                  patch.activeTakeNo = chosen.no;
                  patch.assetId = chosen.assetId;
                }
              }
            }
            const { remoteSnapshot: _omit, ...base } = clip;
            void _omit;
            const resolvedClip = withRevision({ ...base, conflict: false }, patch);
            return {
              project: timestamp(
                mapClip({ ...state.project, conflictClipIds: (state.project.conflictClipIds ?? []).filter((id) => id !== clipId) }, trackId, clipId, () => resolvedClip),
              ),
            };
          }),

        replaceProject: (project) => {
          const normalized = normalizeProject(project);
          set({
            project: { ...normalized, updatedAt: Date.now() },
            playhead: 0,
            isPlaying: false,
            pendingRecordings: [],
            lastTakeUndo: null,
            selectedClipId: normalized.tracks.flatMap((track) => track.clips)[0]?.id ?? null,
            selectedTrackId: normalized.tracks[0]?.id ?? '',
            storageNotice: null,
            mergeNotice:
              (project.version as number) < PROJECT_VERSION
                ? `旧工程已补齐 take 编号并升级到 v${PROJECT_VERSION}，可以继续编辑。`
                : null,
          });
        },

        mergeRemoteProject: (remote) =>
          set((state) => {
            const { project, conflicts, mergedTakes } = mergeProjects(state.project, remote);
            // 收敛保护：若合并结果与当前工程实质相同（仅 updatedAt 不同），
            // 不再写回，避免两个页签互相触发 storage 事件形成乒乓写入。
            if (projectSignature(project) === projectSignature(state.project)) {
              return {};
            }
            return {
              project,
              mergeNotice:
                conflicts.length > 0
                  ? `检测到另一个页签的修改：${mergedTakes} 个 take 已按编号合并，${conflicts.length} 个双方改动的片段已标记冲突，请在检查器中选择保留版本。`
                  : `已合并另一个页签的改动（${mergedTakes} 个新 take）。`,
            };
          }),

        markSaved: () =>
          set({ projectSavedAt: Date.now(), storageNotice: null }),
        clearNotices: () => set({ storageNotice: null, mergeNotice: null }),
      };
    },
    {
      name: PROJECT_STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(() => {
        const adapter: Storage = {
          get length() {
            return localStorage.length;
          },
          clear: () => localStorage.clear(),
          getItem: (key: string) => localStorage.getItem(key),
          key: (index: number) => localStorage.key(index),
          removeItem: (key: string) => localStorage.removeItem(key),
          setItem: (key: string, value: string) => {
            // 记录本页签自己最后写入的原文，storage 监听器据此忽略回显。
            lastWrittenRaw = value;
            safeStorageSet(key, value);
          },
        };
        return adapter;
      }),
      partialize: (state) => ({
        project: state.project,
        zoom: state.zoom,
        selectedClipId: state.selectedClipId,
        selectedTrackId: state.selectedTrackId,
      }),
      // v0/v1 持久化数据（旧工程）在 rehydrate 时迁移：补齐 take 编号后才能继续。
      migrate: (persisted: unknown) => {
        const data = persisted as Partial<StudioState> | undefined;
        if (data?.project) return { ...data, project: normalizeProject(data.project) };
        return persisted;
      },
      merge: (persisted, current) => {
        const saved = persisted as Partial<StudioState> | undefined;
        return {
          ...current,
          ...saved,
          project: saved?.project ? normalizeProject(saved.project) : current.project,
        };
      },
    },
  ),
);

function allClips(project: AudioProject): { assetId: string; start: number; duration: number }[] {
  return project.tracks.flatMap((track) =>
    track.clips.map((clip) => ({
      assetId: activeTakeOf(clip, project.assets).assetId,
      start: clip.start,
      duration: clip.duration,
    })),
  );
}

function removeAssetIfUnused(
  assets: AudioAsset[],
  assetId: string,
  tracks: AudioTrack[],
  currentClipId: string,
): AudioAsset[] {
  const used = new Set<string>();
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.id === currentClipId) continue;
      for (const takeEntry of clip.takes ?? []) used.add(takeEntry.assetId);
      used.add(clip.assetId);
    }
  }
  if (used.has(assetId)) return assets;
  return assets.filter((asset) => asset.id !== assetId);
}

/** 跨页签监听：另一个页签写入工程后，按 take 编号合并到本页签。 */
let lastWrittenRaw: string | null = null;

if (typeof window !== 'undefined') {
  let lastRemoteRaw: string | null = null;
  window.addEventListener('storage', (event) => {
    if (event.key !== PROJECT_STORAGE_KEY || !event.newValue || event.newValue === lastRemoteRaw) return;
    if (event.newValue === lastWrittenRaw) return; // 本页签写入的回显
    lastRemoteRaw = event.newValue;
    try {
      const parsed = JSON.parse(event.newValue) as { state?: { project?: AudioProject } };
      const remote = parsed.state?.project;
      if (remote) useStudioStore.getState().mergeRemoteProject(remote);
    } catch (error) {
      console.warn('[WaveForge] 跨页签工程合并失败：', error);
    }
  });
}

/** 忽略 updatedAt 的结构签名，用于跨页签合并收敛判断。 */
function projectSignature(project: AudioProject): string {
  const { updatedAt: _updatedAt, projectSavedAt: _saved, ...rest } = project as AudioProject & {
    projectSavedAt?: number;
  };
  void _updatedAt;
  void _saved;
  return JSON.stringify(rest);
}

export { formatBytes };
