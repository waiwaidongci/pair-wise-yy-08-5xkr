import {
  CallMerge,
  ContentCopy,
  DeleteOutline,
  GraphicEq,
  Mic,
  Tune,
} from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  RadioGroup,
  Select,
  Slider,
  Stack,
  Typography,
} from '@mui/material';
import { useMemo } from 'react';
import { useStudioStore } from '../stores/studioStore';
import type { AudioAsset, ClipEffect, ClipTake } from '../types/audio';
import { activeTakeOf, clipTakes } from '../utils/takes';

function formatTime(value: number): string {
  return `${value.toFixed(2)}s`;
}

export function ClipInspector() {
  const project = useStudioStore((state) => state.project);
  const selectedClipId = useStudioStore((state) => state.selectedClipId);
  const setClip = useStudioStore((state) => state.setClip);
  const setClipEffect = useStudioStore((state) => state.setClipEffect);
  const duplicateClip = useStudioStore((state) => state.duplicateClip);
  const deleteClip = useStudioStore((state) => state.deleteClip);
  const selectTake = useStudioStore((state) => state.selectTake);
  const resolveConflict = useStudioStore((state) => state.resolveConflict);

  const selection = useMemo(() => {
    for (const track of project.tracks) {
      const clip = track.clips.find((item) => item.id === selectedClipId);
      if (clip) return { track, clip };
    }
    return null;
  }, [project.tracks, selectedClipId]);

  const assetsById = useMemo(
    () => new Map(project.assets.map((asset) => [asset.id, asset])),
    [project.assets],
  );

  if (!selection) {
    return (
      <aside className="inspector-panel">
        <div className="panel-heading">
          <Typography variant="subtitle2">片段检查器</Typography>
        </div>
        <div className="inspector-empty">
          <GraphicEq />
          <strong>选择一个音频片段</strong>
          <span>take 重选、裁剪、淡入淡出、效果器和基础混音参数会显示在这里。</span>
        </div>
      </aside>
    );
  }

  const { track, clip } = selection;
  const takes = clipTakes(clip);
  const activeTake = activeTakeOf(clip);
  const asset = assetsById.get(activeTake.assetId);

  const update = (patch: Parameters<typeof setClip>[2]) => {
    setClip(track.id, clip.id, patch);
  };

  return (
    <aside className="inspector-panel">
      <div className="panel-heading">
        <div>
          <Typography variant="subtitle2">片段检查器</Typography>
          <Typography variant="caption" color="text.secondary">{track.name}</Typography>
        </div>
        <Stack direction="row" spacing={0.5}>
          {clip.conflict && <Chip size="small" color="error" label="冲突" />}
          <Chip size="small" label={`rev ${clip.revision ?? 1}`} variant="outlined" />
          <Chip
            size="small"
            label={clip.effect === 'none' ? '干声' : clip.effect.toUpperCase()}
            color={clip.effect === 'none' ? 'default' : 'primary'}
          />
        </Stack>
      </div>

      {clip.conflict && (
        <Alert severity="error" className="conflict-alert" icon={<CallMerge fontSize="small" />}>
          <Typography variant="caption" display="block">
            两个页签都修改了这个片段，已保留本地版本并记下对方取值。
          </Typography>
          <ConflictDetails clip={clip} assetsById={assetsById} />
          <Stack direction="row" spacing={1} mt={0.5}>
            <Button
              size="small"
              variant="contained"
              color="primary"
              onClick={() => resolveConflict(track.id, clip.id, 'local')}
            >
              保留本地
            </Button>
            <Button
              size="small"
              variant="outlined"
              color="error"
              onClick={() => resolveConflict(track.id, clip.id, 'remote')}
            >
              采用对方
            </Button>
          </Stack>
        </Alert>
      )}

      <Box className="clip-summary" style={{ borderColor: track.color }}>
        <span style={{ background: track.color }} />
        <div>
          <strong>{clip.name}</strong>
          <small>
            {asset?.name ?? '未知素材'} · take {activeTake.no}/{takes.length} · {asset?.duration.toFixed(2) ?? '--'}s
          </small>
        </div>
      </Box>

      <Divider />
      <div className="inspector-section">
        <Stack direction="row" alignItems="center" spacing={1}>
          <Mic fontSize="small" color="error" />
          <Typography className="section-label" variant="caption">Take 叠录（主轨只引用选中段落）</Typography>
        </Stack>
        <RadioGroup
          className="take-list"
          value={activeTake.no}
          onChange={(event) => selectTake(track.id, clip.id, Number(event.target.value))}
        >
          {takes.map((item) => (
            <TakeOption
              key={`${item.no}-${item.assetId}`}
              item={item}
              takeAsset={assetsById.get(item.assetId)}
              selected={item.no === activeTake.no}
            />
          ))}
        </RadioGroup>
        <Typography variant="caption" color="text.secondary">
          原 take 不会被覆盖，随时可重选；新补录会自动成为当前 take。
        </Typography>
      </div>

      <Divider />
      <div className="inspector-section">
        <Typography className="section-label" variant="caption">时间位置</Typography>
        <Stack spacing={1.4}>
          <label>
            <span>开始时间 <b>{clip.start.toFixed(2)}s</b></span>
            <Slider
              size="small"
              min={0}
              max={30}
              step={project.snap}
              value={clip.start}
              onChange={(_, value) => update({ start: Math.max(0, Number(value)) })}
            />
          </label>
          <label>
            <span>片段时长 <b>{clip.duration.toFixed(2)}s</b></span>
            <Slider
              size="small"
              min={project.snap}
              max={asset?.duration ?? 12}
              step={project.snap}
              value={Math.min(clip.duration, asset?.duration ?? clip.duration)}
              onChange={(_, value) => update({ duration: Number(value) })}
            />
          </label>
          <label>
            <span>素材偏移 <b>{clip.offset.toFixed(2)}s</b></span>
            <Slider
              size="small"
              min={0}
              max={Math.max(0, (asset?.duration ?? clip.duration) - clip.duration)}
              step={0.01}
              value={clip.offset}
              onChange={(_, value) => update({ offset: Number(value) })}
            />
          </label>
        </Stack>
      </div>

      <Divider />
      <div className="inspector-section">
        <Typography className="section-label" variant="caption">淡入淡出</Typography>
        <Stack spacing={1.4}>
          <label>
            <span>淡入 <b>{clip.fadeIn.toFixed(2)}s</b></span>
            <Slider
              size="small"
              min={0}
              max={Math.min(3, clip.duration / 2)}
              step={0.01}
              value={clip.fadeIn}
              onChange={(_, value) => update({ fadeIn: Number(value) })}
            />
          </label>
          <label>
            <span>淡出 <b>{clip.fadeOut.toFixed(2)}s</b></span>
            <Slider
              size="small"
              min={0}
              max={Math.min(3, clip.duration / 2)}
              step={0.01}
              value={clip.fadeOut}
              onChange={(_, value) => update({ fadeOut: Number(value) })}
            />
          </label>
        </Stack>
      </div>

      <Divider />
      <div className="inspector-section">
        <Stack direction="row" alignItems="center" spacing={1}>
          <Tune fontSize="small" color="primary" />
          <Typography className="section-label" variant="caption">基础效果器</Typography>
        </Stack>
        <FormControl fullWidth size="small">
          <InputLabel>效果类型</InputLabel>
          <Select
            label="效果类型"
            value={clip.effect}
            onChange={(event) =>
              setClipEffect(track.id, clip.id, event.target.value as ClipEffect, clip.effectAmount || 35)
            }
          >
            <MenuItem value="none">关闭</MenuItem>
            <MenuItem value="lowpass">低通滤波器</MenuItem>
            <MenuItem value="highpass">高通滤波器</MenuItem>
            <MenuItem value="echo">Echo 延迟</MenuItem>
          </Select>
        </FormControl>
        <label>
          <span>效果强度 <b>{clip.effectAmount}%</b></span>
          <Slider
            size="small"
            min={0}
            max={100}
            value={clip.effectAmount}
            disabled={clip.effect === 'none'}
            onChange={(_, value) =>
              setClipEffect(track.id, clip.id, clip.effect, Number(value))
            }
          />
        </label>
      </div>

      <Divider />
      <Stack direction="row" spacing={1} className="inspector-actions">
        <Button
          fullWidth
          variant="outlined"
          startIcon={<ContentCopy />}
          onClick={() => duplicateClip(track.id, clip.id)}
        >
          复制片段
        </Button>
        <Button
          fullWidth
          color="error"
          variant="outlined"
          startIcon={<DeleteOutline />}
          onClick={() => deleteClip(track.id, clip.id)}
        >
          删除
        </Button>
      </Stack>
    </aside>
  );
}

function TakeOption({
  item,
  takeAsset,
  selected,
}: {
  item: ClipTake;
  takeAsset?: AudioAsset;
  selected: boolean;
}) {
  return (
    <label className={`take-option ${selected ? 'take-option--active' : ''}`}>
      <input type="radio" name={`take-${item.assetId}`} checked={selected} readOnly />
      <span className="take-option__no">T{item.no}</span>
      <span className="take-option__meta">
        <strong>{takeAsset?.name ?? item.name}</strong>
        <small>{takeAsset ? `${takeAsset.duration.toFixed(2)}s` : '声音缺失'}</small>
      </span>
      {selected && <Chip size="small" color="primary" label="主轨引用" />}
    </label>
  );
}

function ConflictDetails({
  clip,
  assetsById,
}: {
  clip: import('../types/audio').AudioClip;
  assetsById: Map<string, AudioAsset>;
}) {
  const snapshot = clip.remoteSnapshot;
  if (!snapshot) return null;
  const remoteTake = clip.takes?.find((take) => take.id === snapshot.activeTakeId);
  const rows: Array<[string, string, string]> = [];
  if (snapshot.start !== undefined) rows.push(['开始', formatTime(clip.start), formatTime(snapshot.start)]);
  if (snapshot.duration !== undefined) rows.push(['时长', formatTime(clip.duration), formatTime(snapshot.duration)]);
  if (snapshot.offset !== undefined) rows.push(['偏移', formatTime(clip.offset), formatTime(snapshot.offset)]);
  if (snapshot.fadeIn !== undefined) rows.push(['淡入', formatTime(clip.fadeIn), formatTime(snapshot.fadeIn)]);
  if (snapshot.fadeOut !== undefined) rows.push(['淡出', formatTime(clip.fadeOut), formatTime(snapshot.fadeOut)]);
  if (snapshot.effect !== undefined) rows.push(['效果', clip.effect, snapshot.effect]);
  if (snapshot.effectAmount !== undefined) rows.push(['强度', `${clip.effectAmount}%`, `${snapshot.effectAmount}%`]);
  return (
    <Box className="conflict-table">
      <div className="conflict-row conflict-row--head"><span>字段</span><span>本地</span><span>对方</span></div>
      {rows.map(([label, local, remote]) => (
        <div className="conflict-row" key={label}><span>{label}</span><span>{local}</span><span>{remote}</span></div>
      ))}
      {remoteTake && (
        <Typography variant="caption" display="block" mt={0.5}>
          对方选中 take {remoteTake.no}（{assetsById.get(remoteTake.assetId)?.name ?? '未知声音'}）
        </Typography>
      )}
    </Box>
  );
}
