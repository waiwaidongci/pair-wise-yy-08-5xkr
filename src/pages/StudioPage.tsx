import {
  Download,
  FolderOpen,
  GraphicEq,
  Save,
} from '@mui/icons-material';
import { Alert, Button, Chip, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AssetLibrary } from '../components/AssetLibrary';
import { ClipInspector } from '../components/ClipInspector';
import { TrackTimeline } from '../components/TrackTimeline';
import { TransportBar } from '../components/TransportBar';
import { useStudioStore } from '../stores/studioStore';
import type { AudioProject } from '../types/audio';
import { audioEngine } from '../utils/audioEngine';
import { computeExportPlan, describePlan, rangeLabel } from '../utils/exportPlan';

type Notice = { id: number; text: string; severity: 'info' | 'warning' | 'success' };

export function StudioPage() {
  const project = useStudioStore((state) => state.project);
  const isPlaying = useStudioStore((state) => state.isPlaying);
  const playhead = useStudioStore((state) => state.playhead);
  const pendingCount = useStudioStore((state) => state.pendingRecordings.length);
  const conflictCount = useStudioStore((state) => (state.project.conflictClipIds ?? []).length);
  const mergeNotice = useStudioStore((state) => state.mergeNotice);
  const storageNotice = useStudioStore((state) => state.storageNotice);
  const setPlaying = useStudioStore((state) => state.setPlaying);
  const setPlayhead = useStudioStore((state) => state.setPlayhead);
  const setProjectName = useStudioStore((state) => state.setProjectName);
  const replaceProject = useStudioStore((state) => state.replaceProject);
  const clearNotices = useStudioStore((state) => state.clearNotices);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [recordingPulse, setRecordingPulse] = useState(false);
  const [message, setMessage] = useState<Notice | null>(null);
  const noticeId = useRef(0);

  const pushNotice = (text: string, severity: Notice['severity'] = 'info') => {
    noticeId.current += 1;
    setMessage({ id: noticeId.current, text, severity });
  };

  // 导出预案：循环区间 / 片段边界 / take 引用任一变化 → 修订号变 → 签名变 → 自动重算。
  const exportPlan = useMemo(() => computeExportPlan(project), [project]);
  const acknowledgedSig = useRef<string | null>(null);
  const [planRebuiltSig, setPlanRebuiltSig] = useState<string | null>(null);
  useEffect(() => {
    if (acknowledgedSig.current === null) {
      acknowledgedSig.current = exportPlan.signature;
      return;
    }
    if (acknowledgedSig.current !== exportPlan.signature) {
      acknowledgedSig.current = exportPlan.signature;
      setPlanRebuiltSig(exportPlan.signature);
    }
  }, [exportPlan.signature]);

  // 来自 store 的容量 / 跨页签合并提示。
  useEffect(() => {
    if (storageNotice) pushNotice(storageNotice, 'warning');
  }, [storageNotice]);
  useEffect(() => {
    if (mergeNotice) pushNotice(mergeNotice, conflictCount > 0 ? 'warning' : 'info');
  }, [mergeNotice, conflictCount]);

  const mixKey = useMemo(
    () =>
      JSON.stringify(
        project.tracks.map((track) => ({
          id: track.id,
          volume: track.volume,
          pan: track.pan,
          muted: track.muted,
          solo: track.solo,
          clips: track.clips.map((clip) => ({
            id: clip.id,
            assetId: clip.assetId,
            start: clip.start,
            duration: clip.duration,
            offset: clip.offset,
            fadeIn: clip.fadeIn,
            fadeOut: clip.fadeOut,
            effect: clip.effect,
            amount: clip.effectAmount,
          })),
        })),
      ),
    [project.tracks],
  );
  const wasPlayingBeforeMixChange = useRef(false);

  const beginPlayback = async (from: number) => {
    try {
      const latest = useStudioStore.getState();
      await audioEngine.play(latest.project, Math.max(0, from), () => {
        const state = useStudioStore.getState();
        if (state.project.loopEnabled) {
          void beginPlayback(state.project.loopStart);
        } else {
          setPlaying(false);
          setPlayhead(0);
        }
      });
      setPlaying(true);
    } catch (error) {
      pushNotice(error instanceof Error ? error.message : '音频播放初始化失败', 'warning');
      setPlaying(false);
    }
  };

  const pause = () => {
    const next = audioEngine.getPlayhead();
    audioEngine.stop();
    setPlayhead(next);
    setPlaying(false);
  };

  const stop = () => {
    audioEngine.stop();
    setPlayhead(project.loopEnabled ? project.loopStart : 0);
    setPlaying(false);
  };

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    let lastUpdate = 0;
    const tick = (time: number) => {
      const current = audioEngine.getPlayhead();
      const state = useStudioStore.getState();
      if (state.project.loopEnabled && current >= state.project.loopEnd) {
        audioEngine.stop();
        void beginPlayback(state.project.loopStart);
        return;
      }
      if (time - lastUpdate > 33) {
        setPlayhead(current);
        lastUpdate = time;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [isPlaying, setPlayhead]);

  useEffect(() => {
    if (!isPlaying) {
      wasPlayingBeforeMixChange.current = false;
      return;
    }
    if (wasPlayingBeforeMixChange.current) {
      const current = audioEngine.getPlayhead();
      audioEngine.stop();
      void beginPlayback(current);
    }
    wasPlayingBeforeMixChange.current = true;
  }, [mixKey]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        isPlaying ? pause() : void beginPlayback(playhead);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, playhead]);

  useEffect(
    () => () => {
      audioEngine.stop();
    },
    [],
  );

  const saveProject = () => {
    // 导出工程同时附带当前导出预案，方便核对每个 take 段落的边界与修订号。
    const payload: AudioProject & { exportPlan?: unknown } = { ...project };
    payload.exportPlan = exportPlan;
    const content = JSON.stringify(payload, null, 2);
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${project.name.replaceAll('/', '-')}.waveforge.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    useStudioStore.getState().markSaved();
    pushNotice(
      `工程 JSON 已导出（含 ${exportPlan.clips.length} 段、签名 ${exportPlan.signature.slice(0, 8)} 的导出预案）。`,
      'success',
    );
  };

  const downloadPlanText = () => {
    const blob = new Blob([describePlan(exportPlan, project)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${project.name.replaceAll('/', '-')}-export-plan.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importProject = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as AudioProject;
      if (!Array.isArray(parsed.tracks) || !Array.isArray(parsed.assets)) {
        throw new Error('不是有效的 WaveForge 工程文件');
      }
      audioEngine.stop();
      replaceProject(parsed);
      const wasLegacy = Number(parsed.version) < 2;
      pushNotice(
        wasLegacy
          ? `已载入旧版工程「${parsed.name}」：take 编号已补齐（每段补为 take 1），升级到 v2 后才能继续编辑。`
          : `已载入工程：${parsed.name}`,
        wasLegacy ? 'warning' : 'success',
      );
    } catch (error) {
      pushNotice(error instanceof Error ? error.message : '工程导入失败', 'warning');
    }
  };

  return (
    <div className="studio-page">
      <header className="studio-heading">
        <div>
          <Typography className="eyebrow">BROWSER AUDIO WORKSTATION</Typography>
          <TextField
            variant="standard"
            value={project.name}
            onChange={(event) => setProjectName(event.target.value)}
            className="project-name"
            inputProps={{ 'aria-label': '工程名称' }}
          />
          <Stack direction="row" alignItems="center" spacing={1}>
            <span className="autosave-dot" />
            <Typography variant="caption" color="text.secondary">
              take 叠录自动保存到 localStorage
            </Typography>
            {conflictCount > 0 && (
              <Chip size="small" color="error" label={`${conflictCount} 个合并冲突待处理`} />
            )}
            {pendingCount > 0 && (
              <Chip size="small" color="warning" label={`${pendingCount} 份未保存录音`} />
            )}
          </Stack>
        </div>
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            startIcon={<FolderOpen />}
            onClick={() => importInputRef.current?.click()}
          >
            导入工程
          </Button>
          <Button variant="outlined" startIcon={<Download />} onClick={saveProject}>
            导出工程
          </Button>
          <Button variant="contained" startIcon={<Save />} onClick={saveProject}>
            保存
          </Button>
          <input
            ref={importInputRef}
            hidden
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              void importProject(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </Stack>
      </header>

      <TransportBar
        recording={recordingPulse}
        onPlay={() => void beginPlayback(playhead)}
        onPause={pause}
        onStop={stop}
        onRecord={() => {
          setRecordingPulse(true);
          window.setTimeout(() => setRecordingPulse(false), 1200);
          pushNotice('在左侧素材库点红色按钮：选中片段即“叠录新 take”，未选片段则新建。');
        }}
        onSaveProject={saveProject}
      />

      {message && (
        <Alert
          severity={message.severity}
          className="studio-message"
          onClose={() => setMessage(null)}
        >
          {message.text}
        </Alert>
      )}

      <Stack className="export-plan-bar" direction="row" alignItems="center" spacing={1.5}>
        <GraphicEq fontSize="small" color="action" />
        <Typography variant="caption">
          导出预案：区间 <b>{rangeLabel(exportPlan)}</b> · {exportPlan.clips.length} 个 take 段落
        </Typography>
        <Chip
          size="small"
          variant={planRebuiltSig ? 'filled' : 'outlined'}
          color={planRebuiltSig ? 'secondary' : 'default'}
          label={
            planRebuiltSig
              ? `已随边界变化重算 · ${exportPlan.signature.slice(0, 8)}`
              : `签名 ${exportPlan.signature.slice(0, 8)}`
          }
        />
        <Button size="small" variant="text" onClick={downloadPlanText}>下载预案</Button>
        <span className="transport-spacer" />
        {mergeNotice && (
          <Button size="small" color="secondary" onClick={clearNotices}>知道了</Button>
        )}
      </Stack>

      <main className="studio-workspace">
        <AssetLibrary onNotice={pushNotice} />
        <TrackTimeline />
        <ClipInspector />
      </main>
    </div>
  );
}
