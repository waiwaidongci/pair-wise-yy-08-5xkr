import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AudioAsset,
  AudioClip,
  AudioProject,
  AudioTrack,
  ClipEffect,
  TrackColor,
  UnsavedRecording,
} from '../types/audio';
import { SYNTHETIC_ASSETS } from '../utils/syntheticAudio';
import {
  STORAGE_LIMIT,
  createTake,
  estimateProjectSize,
  getActiveTake,
  isLegacyClip,
  mergeProjects,
  migrateProject,
  nextTakeNumber,
  uid,
} from '../utils/takes';

const TRACK_COLORS: TrackColor[] = ['#2563eb', '#0f9f7a', '#d97706', '#c2413b', '#7c3aed', '#0891b2'];

/** setClip 的补丁类型：片段字段 + 激活 take 的 duration/offset */
type ClipPatch = Partial<AudioClip> & { duration?: number; offset?: number };

const builtinAssets: AudioAsset[] = SYNTHETIC_ASSETS.map((asset) => ({
  id: asset.id,
  name: asset.name,
  source: 'synthetic',
  duration: asset.duration,
  mimeType: asset.mimeType,
}));

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
          name: '紧凑鼓组 A',
          start: 0,
          fadeIn: 0.05,
          fadeOut: 0.3,
          effect: 'none',
          effectAmount: 0,
          takes: [
            {
              id: 'take-drums-a',
              takeNumber: 1,
              assetId: 'synth-drums',
              name: '紧凑鼓组 A',
              duration: 8,
              offset: 0,
              recordedAt: 0,
            },
          ],
          activeTakeId: 'take-drums-a',
          waveformEpoch: 0,
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
          name: '暖色和弦',
          start: 0,
          fadeIn: 0.65,
          fadeOut: 0.8,
          effect: 'lowpass',
          effectAmount: 22,
          takes: [
            {
              id: 'take-chords-a',
              takeNumber: 1,
              assetId: 'synth-chords',
              name: '暖色和弦',
              duration: 8,
              offset: 0,
              recordedAt: 0,
            },
          ],
          activeTakeId: 'take-chords-a',
          waveformEpoch: 0,
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
          name: '模拟贝斯',
          start: 4,
          fadeIn: 0.1,
          fadeOut: 0.2,
          effect: 'none',
          effectAmount: 0,
          takes: [
            {
              id: 'take-bass-a',
              takeNumber: 1,
              assetId: 'synth-bass',
              name: '模拟贝斯',
              duration: 4,
              offset: 0,
              recordedAt: 0,
            },
          ],
          activeTakeId: 'take-bass-a',
          waveformEpoch: 0,
        },
      ],
    },
  ];
  return {
    version: 2,
    name: '未命名工程 · Night Drive',
    bpm: 120,
    snap: 0.25,
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 8,
    pixelsPerSecond: 92,
    tracks,
    assets: builtinAssets,
    updatedAt: Date.now(),
  };
}

interface StudioState {
  project: AudioProject;
  selectedClipId: string | null;
  selectedTrackId: string;
  isPlaying: boolean;
  playhead: number;
  zoom: number;
  projectSavedAt: number;
  /** 素材库容量不足时未能落盘的录音 */
  unsavedRecordings: UnsavedRecording[];
  setPlaying: (playing: boolean) => void;
  setPlayhead: (time: number) => void;
  setZoom: (zoom: number) => void;
  setProjectName: (name: string) => void;
  addTrack: () => void;
  updateTrack: (trackId: string, patch: Partial<AudioTrack>) => void;
  deleteTrack: (trackId: string) => void;
  addClip: (trackId: string, assetId: string, start?: number) => void;
  setClip: (trackId: string, clipId: string, patch: ClipPatch) => void;
  setClipEffect: (trackId: string, clipId: string, effect: ClipEffect, amount?: number) => void;
  moveClipToTrack: (fromTrackId: string, clipId: string, toTrackId: string, start: number) => void;
  duplicateClip: (trackId: string, clipId: string) => void;
  deleteClip: (trackId: string, clipId: string) => void;
  selectClip: (clipId: string | null) => void;
  updateTransport: (patch: Partial<Pick<AudioProject, 'bpm' | 'snap' | 'loopEnabled' | 'loopStart' | 'loopEnd' | 'pixelsPerSecond'>>) => void;
  importFile: (file: File) => Promise<void>;
  addRecordedBlob: (blob: Blob, duration: number, trackId?: string, clipId?: string | null) => Promise<{ ok: boolean; error?: string }>;
  setActiveTake: (trackId: string, clipId: string, takeId: string) => void;
  deleteTake: (trackId: string, clipId: string, takeId: string) => void;
  restoreTake: (trackId: string, clipId: string, takeId: string) => void;
  retryUnsavedRecording: (id: string) => Promise<void>;
  discardUnsavedRecording: (id: string) => void;
  resolveConflict: (trackId: string, clipId: string, keepTakeId: string) => void;
  replaceProject: (project: AudioProject) => void;
  markSaved: () => void;
}

function normalizeProject(project: AudioProject): AudioProject {
  const migrated = migrateProject(project);
  const customAssets = migrated.assets.filter(
    (asset) => !builtinAssets.some((builtin) => builtin.id === asset.id),
  );
  return {
    ...migrated,
    version: 2,
    tracks: migrated.tracks.map((track) => ({
      ...track,
      volume: Math.max(0, Math.min(1, track.volume)),
      pan: Math.max(-1, Math.min(1, track.pan)),
      clips: track.clips.map((clip) => {
        const take = getActiveTake(clip);
        return {
          ...clip,
          conflict: clip.conflict ?? false,
          waveformEpoch: clip.waveformEpoch ?? 0,
          takes: clip.takes.map((item) => ({
            ...item,
            duration: Math.max(0.02, item.duration),
            offset: Math.max(0, item.offset),
          })),
          activeTakeId: take?.id ?? clip.takes[0]?.id ?? '',
          fadeIn: Math.max(0, clip.fadeIn),
          fadeOut: Math.max(0, clip.fadeOut),
          effectAmount: Math.max(0, Math.min(100, clip.effectAmount)),
        };
      }),
    })),
    assets: [...builtinAssets, ...customAssets],
  };
}

function timestamp(project: AudioProject): AudioProject {
  return { ...project, updatedAt: Date.now() };
}

/** 循环区间变化时，受牵连片段的波形版本号递增 */
function bumpWaveformEpochForLoop(project: AudioProject, prevLoopStart: number, prevLoopEnd: number): AudioProject {
  const loopChanged = project.loopStart !== prevLoopStart || project.loopEnd !== prevLoopEnd;
  if (!loopChanged) return project;
  return {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        const take = getActiveTake(clip);
        const clipEnd = clip.start + (take?.duration ?? 0);
        const overlaps = clip.start < project.loopEnd && clipEnd > project.loopStart;
        return overlaps ? { ...clip, waveformEpoch: clip.waveformEpoch + 1 } : clip;
      }),
    })),
  };
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

function addAssetClip(project: AudioProject, trackId: string, asset: AudioAsset, start: number) {
  const take = createTake(asset, 1, asset.duration, 0);
  const clip: AudioClip = {
    id: uid('clip'),
    name: asset.name.replace(/^内置 · /, ''),
    start: Math.max(0, start),
    fadeIn: 0.04,
    fadeOut: 0.12,
    effect: 'none',
    effectAmount: 0,
    takes: [take],
    activeTakeId: take.id,
    waveformEpoch: 0,
  };
  return {
    ...project,
    assets: project.assets.some((item) => item.id === asset.id)
      ? project.assets
      : [...project.assets, asset],
    tracks: project.tracks.map((track) =>
      track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track,
    ),
    updatedAt: Date.now(),
  };
}

export const useStudioStore = create<StudioState>()(
  persist(
    (set, get) => ({
      project: initialProject(),
      selectedClipId: 'clip-chords-a',
      selectedTrackId: 'track-drums',
      isPlaying: false,
      playhead: 0,
      zoom: 1,
      projectSavedAt: Date.now(),
      unsavedRecordings: [],
      setPlaying: (isPlaying) => set({ isPlaying }),
      setPlayhead: (playhead) => set({ playhead: Math.max(0, playhead) }),
      setZoom: (zoom) => set({ zoom: Math.max(0.5, Math.min(2.2, zoom)) }),
      setProjectName: (name) =>
        set((state) => ({
          project: timestamp({ ...state.project, name: name || '未命名工程' }),
        })),
      addTrack: () =>
        set((state) => {
          const index = state.project.tracks.length;
          const track: AudioTrack = {
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
            selectedTrackId: track.id,
            project: timestamp({ ...state.project, tracks: [...state.project.tracks, track] }),
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
          const next = addAssetClip(state.project, trackId, asset, start ?? state.playhead);
          const track = next.tracks.find((item) => item.id === trackId);
          const clip = track?.clips.at(-1);
          return { project: next, selectedTrackId: trackId, selectedClipId: clip?.id ?? null };
        }),
      setClip: (trackId, clipId, patch) =>
        set((state) => {
          const project = state.project;
          let nextProject = { ...project };
          let waveformBumped = false;

          // duration / offset 属于激活 take，其余字段属于片段本身
          const takePatch: Partial<AudioClip['takes'][number]> = {};
          if (patch.duration !== undefined) {
            takePatch.duration = Math.max(0.02, patch.duration);
            waveformBumped = true;
          }
          if (patch.offset !== undefined) {
            takePatch.offset = Math.max(0, patch.offset);
            waveformBumped = true;
          }
          const clipPatch: ClipPatch = { ...patch };
          delete clipPatch.duration;
          delete clipPatch.offset;

          nextProject = {
            ...nextProject,
            tracks: nextProject.tracks.map((track) => {
              if (track.id !== trackId) return track;
              return {
                ...track,
                clips: track.clips.map((clip) => {
                  if (clip.id !== clipId) return clip;
                  const activeTake = getActiveTake(clip);
                  return {
                    ...clip,
                    ...clipPatch,
                    waveformEpoch: waveformBumped ? clip.waveformEpoch + 1 : clip.waveformEpoch,
                    takes: clip.takes.map((take) =>
                      take.id === activeTake.id ? { ...take, ...takePatch } : take,
                    ),
                  };
                }),
              };
            }),
          };

          return { project: timestamp(nextProject) };
        }),
      setClipEffect: (trackId, clipId, effect, amount) =>
        get().setClip(trackId, clipId, {
          effect,
          effectAmount: amount ?? 35,
        }),
      moveClipToTrack: (fromTrackId, clipId, toTrackId, start) =>
        set((state) => {
          const sourceTrack = state.project.tracks.find((track) => track.id === fromTrackId);
          const clip = sourceTrack?.clips.find((item) => item.id === clipId);
          if (!clip) return {};
          const moved = { ...clip, start: Math.max(0, start), waveformEpoch: clip.waveformEpoch + 1 };
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
          const copy = {
            ...clip,
            id: uid('clip'),
            name: `${clip.name} 副本`,
            start: clip.start + (getActiveTake(clip)?.duration ?? 1),
            takes: clip.takes.map((take) => ({ ...take, id: uid('take') })),
            activeTakeId: '',
            waveformEpoch: 0,
          };
          copy.activeTakeId = copy.takes[0]?.id ?? '';
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
          project: timestamp({
            ...state.project,
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
          const merged = { ...prev, ...patch };
          const bumped = bumpWaveformEpochForLoop(merged, prev.loopStart, prev.loopEnd);
          return { project: timestamp(bumped) };
        }),
      importFile: async (file) => {
        if (file.size > 8 * 1024 * 1024) {
          throw new Error('单个音频文件请小于 8 MB，以避免浏览器本地存储超限');
        }
        const dataUrl = await readFileAsDataUrl(file);
        const duration = await readAudioDuration(dataUrl);
        const asset: AudioAsset = {
          id: uid('asset'),
          name: file.name.replace(/\.[^.]+$/, ''),
          source: 'imported',
          duration,
          mimeType: file.type || 'audio/mpeg',
          dataUrl,
          size: file.size,
        };
        set((state) => {
          const trackId = state.selectedTrackId || state.project.tracks[0].id;
          const project = addAssetClip(state.project, trackId, asset, state.playhead);
          const track = project.tracks.find((item) => item.id === trackId);
          return {
            project,
            selectedTrackId: trackId,
            selectedClipId: track?.clips.at(-1)?.id ?? null,
          };
        });
      },
      addRecordedBlob: async (blob, duration, trackId, clipId) => {
        const dataUrl = await readFileAsDataUrl(blob);
        const asset: AudioAsset = {
          id: uid('record'),
          name: `录音 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
          source: 'recorded',
          duration,
          mimeType: blob.type || 'audio/webm',
          dataUrl,
          size: blob.size,
        };

        const state = get();
        const targetTrackId = trackId || state.selectedTrackId || state.project.tracks[0].id;
        const targetTrack = state.project.tracks.find((track) => track.id === targetTrackId);
        const targetClip = clipId
          ? targetTrack?.clips.find((clip) => clip.id === clipId)
          : targetTrack?.clips.find((clip) => clip.id === state.selectedClipId) ?? null;

        // 先在内存中构造新工程，做容量校验
        let nextProject: AudioProject;
        let nextClipId: string;
        if (targetClip) {
          const take = createTake(asset, nextTakeNumber(targetClip), duration, 0);
          nextClipId = targetClip.id;
          nextProject = {
            ...state.project,
            assets: [...state.project.assets, asset],
            tracks: state.project.tracks.map((track) =>
              track.id === targetTrackId
                ? {
                    ...track,
                    clips: track.clips.map((clip) =>
                      clip.id === targetClip.id
                        ? {
                            ...clip,
                            takes: [...clip.takes, take],
                            activeTakeId: take.id,
                            waveformEpoch: clip.waveformEpoch + 1,
                          }
                        : clip,
                    ),
                  }
                : track,
            ),
          };
        } else {
          const take = createTake(asset, 1, duration, 0);
          const newClip: AudioClip = {
            id: uid('clip'),
            name: asset.name,
            start: Math.max(0, state.playhead),
            fadeIn: 0.04,
            fadeOut: 0.12,
            effect: 'none',
            effectAmount: 0,
            takes: [take],
            activeTakeId: take.id,
            waveformEpoch: 0,
          };
          nextClipId = newClip.id;
          nextProject = {
            ...state.project,
            assets: [...state.project.assets, asset],
            tracks: state.project.tracks.map((track) =>
              track.id === targetTrackId ? { ...track, clips: [...track.clips, newClip] } : track,
            ),
          };
        }

        // 素材库容量不足：拒绝新 take，保留当前录音到未保存列表
        if (estimateProjectSize(nextProject) > STORAGE_LIMIT) {
          const unsaved: UnsavedRecording = {
            id: uid('unsaved'),
            blob,
            duration,
            recordedAt: Date.now(),
            reason: '素材库容量不足，新 take 已拒绝。可删除其他素材后重试。',
            trackId: targetTrackId,
            clipId: targetClip?.id ?? null,
          };
          set((s) => ({ unsavedRecordings: [...s.unsavedRecordings, unsaved] }));
          return { ok: false, error: unsaved.reason };
        }

        set({
          project: timestamp(nextProject),
          selectedTrackId: targetTrackId,
          selectedClipId: nextClipId,
        });
        return { ok: true };
      },
      setActiveTake: (trackId, clipId, takeId) =>
        set((state) => ({
          project: timestamp({
            ...state.project,
            tracks: state.project.tracks.map((track) =>
              track.id === trackId
                ? {
                    ...track,
                    clips: track.clips.map((clip) =>
                      clip.id === clipId
                        ? {
                            ...clip,
                            activeTakeId: takeId,
                            conflict: false,
                            waveformEpoch: clip.waveformEpoch + 1,
                          }
                        : clip,
                    ),
                  }
                : track,
            ),
          }),
        })),
      deleteTake: (trackId, clipId, takeId) =>
        set((state) => {
          const project = state.project;
          const next = {
            ...project,
            tracks: project.tracks.map((track) => {
              if (track.id !== trackId) return track;
              return {
                ...track,
                clips: track.clips.map((clip) => {
                  if (clip.id !== clipId) return clip;
                  const remaining = clip.takes.filter((take) => take.id !== takeId);
                  if (remaining.length === 0) return clip;
                  const activeTakeId =
                    clip.activeTakeId === takeId ? remaining[0].id : clip.activeTakeId;
                  return {
                    ...clip,
                    takes: remaining,
                    activeTakeId,
                    waveformEpoch: clip.waveformEpoch + 1,
                  };
                }),
              };
            }),
          };
          return { project: timestamp(next) };
        }),
      restoreTake: (trackId, clipId, takeId) =>
        set((state) => ({
          project: timestamp({
            ...state.project,
            tracks: state.project.tracks.map((track) =>
              track.id === trackId
                ? {
                    ...track,
                    clips: track.clips.map((clip) =>
                      clip.id === clipId && clip.takes.some((take) => take.id === takeId)
                        ? { ...clip, activeTakeId: takeId, waveformEpoch: clip.waveformEpoch + 1 }
                        : clip,
                    ),
                  }
                : track,
            ),
          }),
        })),
      retryUnsavedRecording: async (id) => {
        const recording = get().unsavedRecordings.find((item) => item.id === id);
        if (!recording) return;
        const result = await get().addRecordedBlob(
          recording.blob,
          recording.duration,
          recording.trackId,
          recording.clipId,
        );
        if (result.ok) {
          set((state) => ({
            unsavedRecordings: state.unsavedRecordings.filter((item) => item.id !== id),
          }));
        }
      },
      discardUnsavedRecording: (id) =>
        set((state) => ({
          unsavedRecordings: state.unsavedRecordings.filter((item) => item.id !== id),
        })),
      resolveConflict: (trackId, clipId, keepTakeId) =>
        set((state) => ({
          project: timestamp({
            ...state.project,
            tracks: state.project.tracks.map((track) =>
              track.id === trackId
                ? {
                    ...track,
                    clips: track.clips.map((clip) =>
                      clip.id === clipId
                        ? {
                            ...clip,
                            activeTakeId: keepTakeId,
                            conflict: false,
                            waveformEpoch: clip.waveformEpoch + 1,
                          }
                        : clip,
                    ),
                  }
                : track,
            ),
          }),
        })),
      replaceProject: (project) =>
        set({
          project: normalizeProject(project),
          playhead: 0,
          isPlaying: false,
          selectedClipId: project.tracks.flatMap((track) => track.clips)[0]?.id ?? null,
          selectedTrackId: project.tracks[0]?.id ?? '',
        }),
      markSaved: () => set({ projectSavedAt: Date.now() }),
    }),
    {
      name: 'pair-wise-yy-08-studio',
      partialize: (state) => ({
        project: state.project,
        zoom: state.zoom,
        selectedClipId: state.selectedClipId,
        selectedTrackId: state.selectedTrackId,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<StudioState> | undefined;
        return {
          ...current,
          ...saved,
          project: normalizeProject(saved?.project ?? current.project),
        };
      },
    },
  ),
);

// 多页签协同：监听其他页签的 localStorage 写入，按 take 编号合并
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== 'pair-wise-yy-08-studio' || !event.newValue) return;
    try {
      const incoming = JSON.parse(event.newValue)?.state?.project as AudioProject | undefined;
      if (!incoming) return;
      const current = useStudioStore.getState().project;
      const merged = normalizeProject(mergeProjects(current, migrateProject(incoming)));
      // 仅在合并结果与当前不同时更新，避免多页签回环写入
      if (JSON.stringify(merged) !== JSON.stringify(current)) {
        useStudioStore.setState({ project: merged });
      }
    } catch {
      // 忽略解析失败的写入
    }
  });
}
