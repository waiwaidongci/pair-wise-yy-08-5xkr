import {
  AudioFile,
  Download,
  FiberManualRecord,
  FolderOpen,
  GraphicEq,
  HistoryToggleOff,
  Mic,
  StopCircle,
  Waves,
} from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { useStudioStore } from '../stores/studioStore';
import { SYNTHETIC_ASSETS } from '../utils/syntheticAudio';
import { formatBytes } from '../utils/storage';

interface AssetLibraryProps {
  onNotice: (message: string, severity?: 'info' | 'warning' | 'success') => void;
}

export function AssetLibrary({ onNotice }: AssetLibraryProps) {
  const assets = useStudioStore((state) => state.project.assets);
  const tracks = useStudioStore((state) => state.project.tracks);
  const selectedTrackId = useStudioStore((state) => state.selectedTrackId);
  const selectedClipId = useStudioStore((state) => state.selectedClipId);
  const pendingRecordings = useStudioStore((state) => state.pendingRecordings);
  const addClip = useStudioStore((state) => state.addClip);
  const importFile = useStudioStore((state) => state.importFile);
  const commitRecording = useStudioStore((state) => state.commitRecording);
  const retryPendingRecording = useStudioStore((state) => state.retryPendingRecording);
  const discardPendingRecording = useStudioStore((state) => state.discardPendingRecording);
  const undoLastTake = useStudioStore((state) => state.undoLastTake);
  const lastTakeUndo = useStudioStore((state) => state.lastTakeUndo);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordStartedAt = useRef(0);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTrack = tracks.find((track) => track.id === selectedTrackId);
  const selectedClip = selectedTrack?.clips.find((clip) => clip.id === selectedClipId) ?? null;
  const takeCount = selectedClip?.takes?.length ?? 0;
  const usedStorage = assets.reduce((sum, asset) => sum + (asset.size ?? 0), 0);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(
      () => setRecordSeconds((performance.now() - recordStartedAt.current) / 1000),
      100,
    );
    return () => window.clearInterval(timer);
  }, [recording]);

  const handleImport = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await importFile(file);
      onNotice(`已导入 ${file.name} 并放到当前轨道。`, 'success');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '导入音频失败');
    } finally {
      setBusy(false);
    }
  };

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      let recorderFailed = false;
      recorder.onerror = () => {
        // 录音中途失败：已收集的声音块仍走正常提交流程（容量不足会进未保存列表），
        // 避免“录音失败后上一个 take / 当前录音直接丢失”。
        recorderFailed = true;
      };
      recorder.onstop = async () => {
        const duration = Math.max(0.2, (performance.now() - recordStartedAt.current) / 1000);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        setRecordSeconds(0);
        if (chunksRef.current.length === 0) {
          setError(recorderFailed ? '录音设备中断，未捕获到声音；上一个 take 仍然保留。' : '没有录到声音。');
          return;
        }

        // 叠录：选中片段时，新录音作为该片段的下一个 take；否则在播放头新建片段。
        setBusy(true);
        try {
          const result = await commitRecording({
            blob,
            duration,
            targetTrackId: selectedTrackId,
            clipId: selectedClip?.id,
          });
          if (result.ok) {
            if (result.mode === 'punch') {
              onNotice(`已叠录为 take ${takeCount + 1}，旧 take 全部保留，可在检查器重选或撤销。`, 'success');
            } else {
              onNotice('录音已保存为新片段（take 1）。', 'success');
            }
          } else {
            onNotice(
              `素材库容量不足，已拒绝新 take；当前录音已保留在“未保存录音”中，可清理空间后重试。`,
              'warning',
            );
          }
        } catch (commitError) {
          // 录音失败后不丢声音：onerror 路径理论上不会到这里，兜底提示。
          setError(commitError instanceof Error ? commitError.message : '录音保存失败，请重试。');
        } finally {
          setBusy(false);
        }
      };
      recorder.start(250);
      recorderRef.current = recorder;
      streamRef.current = stream;
      recordStartedAt.current = performance.now();
      setRecordSeconds(0);
      setRecording(true);
    } catch {
      setError('未获得麦克风权限，可使用内置合成音频或导入本地文件。');
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
  };

  const downloadPending = (pendingId: string) => {
    const pending = pendingRecordings.find((item) => item.id === pendingId);
    if (!pending) return;
    const anchor = document.createElement('a');
    anchor.href = pending.dataUrl;
    anchor.download = `${pending.name.replaceAll(/[\\/:*?"<>|]/g, '_')}.webm`;
    anchor.click();
  };

  return (
    <aside className="library-panel">
      <div className="panel-heading">
        <div>
          <Typography variant="subtitle2">素材库</Typography>
          <Typography variant="caption" color="text.secondary">
            合成、take 叠录与本地文件
          </Typography>
        </div>
        <Chip size="small" label={`${assets.length} 项 · ${formatBytes(usedStorage)}`} />
      </div>

      <Stack spacing={1} className="record-card">
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <div>
            <Typography variant="body2" fontWeight={700}>
              {selectedClip ? `补录 · 叠到「${selectedClip.name}」` : '录音输入'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {selectedClip
                ? `将新增 take ${takeCount + 1}，旧 take 保留可重选`
                : '未选片段：在播放头处新建片段'}
            </Typography>
          </div>
          <Tooltip title={recording ? '停止并叠录' : selectedClip ? '补录同一句（新 take）' : '开始录音'}>
            <span>
              <IconButton
                className={recording ? 'record-button record-button--active' : 'record-button'}
                disabled={busy && !recording}
                onClick={recording ? stopRecording : () => void startRecording()}
              >
                {recording ? <StopCircle /> : <FiberManualRecord />}
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
        {recording && (
          <div className="recording-status">
            <span />
            <strong>
              正在录音 {recordSeconds.toFixed(1)}s
              {selectedClip ? ` · 叠录 take ${takeCount + 1}` : ''}
            </strong>
            <small>{selectedClip ? `保留 take 1–${takeCount}` : '输出到所选轨道'}</small>
          </div>
        )}
        {lastTakeUndo && !recording && (() => {
          const undoClip = tracks
            .find((track) => track.id === lastTakeUndo.trackId)
            ?.clips.find((clip) => clip.id === lastTakeUndo.clipId);
          const previousNo =
            undoClip?.takes?.find((item) => item.id === lastTakeUndo.previousTakeId)?.no
            ?? undoClip?.takes?.length
            ?? 1;
          return (
            <Button
              size="small"
              color="warning"
              variant="text"
              startIcon={<HistoryToggleOff />}
              onClick={() => {
                if (undoLastTake()) onNotice('已恢复到上一个 take，新叠录已移除。', 'info');
              }}
            >
              撤销最近一次叠录（恢复 take {previousNo}）
            </Button>
          );
        })()}
      </Stack>

      {pendingRecordings.length > 0 && (
        <Box className="pending-card">
          <Typography variant="body2" fontWeight={700} color="warning.dark">
            未保存录音（{pendingRecordings.length}）
          </Typography>
          <Typography variant="caption" color="text.secondary">
            容量不足被拒绝，但录音本体仍保留。清理空间后重试，或先下载到本地。
          </Typography>
          <List dense className="pending-list">
            {pendingRecordings.map((pending) => (
              <ListItem
                key={pending.id}
                secondaryAction={
                  <Stack direction="row" spacing={0}>
                    <Tooltip title="重新尝试保存为 take">
                      <IconButton
                        edge="end"
                        size="small"
                        onClick={() => {
                          const result = retryPendingRecording(pending.id);
                          if ('ok' in result && result.ok) {
                            onNotice('未保存录音已成功写入。', 'success');
                          } else if (!('ok' in result) || !result.ok) {
                            setError('error' in result ? result.error : '仍然空间不足');
                          }
                        }}
                      >
                        <GraphicEq fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="下载录音文件">
                      <IconButton edge="end" size="small" onClick={() => downloadPending(pending.id)}>
                        <Download fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="放弃这份录音">
                      <IconButton
                        edge="end"
                        size="small"
                        color="error"
                        onClick={() => discardPendingRecording(pending.id)}
                      >
                        <StopCircle fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                }
              >
                <ListItemIcon><Mic color="error" fontSize="small" /></ListItemIcon>
                <ListItemText
                  primary={pending.name}
                  secondary={`${pending.duration.toFixed(1)}s · ${formatBytes(pending.size)} · ${pending.punchIn ? '叠录' : '新片段'}`}
                  slotProps={{ secondary: { noWrap: true } }}
                />
              </ListItem>
            ))}
          </List>
        </Box>
      )}

      <Divider />
      <Typography className="library-label" variant="caption">内置合成片段</Typography>
      <List dense className="asset-list">
        {SYNTHETIC_ASSETS.map((asset) => (
          <ListItem
            key={asset.id}
            secondaryAction={
              <Tooltip title="添加到当前轨道">
                <IconButton edge="end" size="small" onClick={() => addClip(selectedTrackId, asset.id)}>
                  <GraphicEq fontSize="small" />
                </IconButton>
              </Tooltip>
            }
          >
            <ListItemIcon><Waves color="primary" /></ListItemIcon>
            <ListItemText
              primary={asset.name}
              secondary={`${asset.duration}s · ${asset.description}`}
              slotProps={{ secondary: { noWrap: true } }}
            />
          </ListItem>
        ))}
      </List>

      <Divider />
      <Typography className="library-label" variant="caption">导入与录音素材（含全部 take）</Typography>
      <List dense className="asset-list asset-list--scroll">
        {assets
          .filter((asset) => asset.source !== 'synthetic')
          .map((asset) => (
            <ListItem key={asset.id}>
              <ListItemIcon>
                {asset.source === 'recorded' ? <Mic color="error" /> : <AudioFile color="success" />}
              </ListItemIcon>
              <ListItemText
                primary={asset.name}
                secondary={`${asset.duration.toFixed(1)}s · ${formatBytes(asset.size ?? 0)} · ${asset.source === 'recorded' ? 'take 录音' : '本地导入'}`}
                slotProps={{ secondary: { noWrap: true } }}
              />
            </ListItem>
          ))}
        {!assets.some((asset) => asset.source !== 'synthetic') && (
          <Box className="asset-empty">尚未导入文件，内置素材已经可以直接编辑。</Box>
        )}
      </List>

      <Button
        fullWidth
        variant="outlined"
        startIcon={busy ? <CircularProgress size={15} /> : <FolderOpen />}
        disabled={busy || recording}
        onClick={() => fileInputRef.current?.click()}
      >
        导入音频文件
      </Button>
      <input
        ref={fileInputRef}
        hidden
        type="file"
        accept="audio/*"
        onChange={(event) => {
          void handleImport(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      {error && <Alert severity="warning" onClose={() => setError(null)}>{error}</Alert>}
    </aside>
  );
}
