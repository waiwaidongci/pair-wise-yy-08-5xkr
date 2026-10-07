import { useEffect, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';
import type { AudioAsset, AudioClip } from '../types/audio';
import { getActiveTake } from '../utils/takes';
import { getSyntheticAssetUrl, isSyntheticAsset } from '../utils/syntheticAudio';

interface WaveformClipProps {
  asset: AudioAsset;
  clip: AudioClip;
  pixelsPerSecond: number;
  color: string;
}

export function WaveformClip({ asset, clip, pixelsPerSecond, color }: WaveformClipProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const take = getActiveTake(clip);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    const sourceUrl =
      isSyntheticAsset(asset.id) || !asset.dataUrl
        ? getSyntheticAssetUrl(asset.id)
        : asset.dataUrl;
    const wavesurfer = WaveSurfer.create({
      container,
      height: 58,
      waveColor: `${color}7a`,
      progressColor: color,
      cursorColor: 'transparent',
      cursorWidth: 0,
      barWidth: Math.max(1, Math.min(3, pixelsPerSecond / 42)),
      barGap: 1,
      barRadius: 1,
      normalize: true,
      interact: false,
      fillParent: false,
      minPxPerSec: pixelsPerSecond,
      hideScrollbar: true,
      autoScroll: false,
      dragToSeek: false,
      backend: 'MediaElement',
    });
    let disposed = false;
    wavesurfer.load(sourceUrl).catch(() => {
      if (!disposed) container.dataset.error = '波形不可用';
    });
    return () => {
      disposed = true;
      wavesurfer.destroy();
    };
    // waveformEpoch 变化时强制重绘，覆盖循环区间或片段边界受牵连的波形
  }, [asset.dataUrl, asset.id, take.offset, color, pixelsPerSecond, clip.waveformEpoch]);

  return (
    <div className="waveform-clip" aria-label={`${clip.name} 波形`}>
      <div
        className="waveform-canvas"
        ref={containerRef}
        style={{
          width: `${Math.max(20, asset.duration * pixelsPerSecond)}px`,
          transform: `translateX(${-take.offset * pixelsPerSecond}px)`,
        }}
      />
    </div>
  );
}
