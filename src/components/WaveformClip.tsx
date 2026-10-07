import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import type { AudioAsset, AudioClip } from '../types/audio';
import { getSyntheticAssetUrl, isSyntheticAsset } from '../utils/syntheticAudio';
import { audioEngine } from '../utils/audioEngine';
import {
  extractPeaks,
  readWaveformCache,
  waveformKey,
  writeWaveformCache,
} from '../utils/waveformCache';

interface WaveformClipProps {
  asset: AudioAsset;
  clip: AudioClip;
  pixelsPerSecond: number;
  color: string;
}

/**
 * 片段波形：优先用按“take + 片段修订号 + 边界 + 缩放”派生的缓存峰值，
 * 未命中才解码音频。循环区间或片段边界变化会令 clip.revision 自增、缓存失效，
 * 只重算受牵连片段，其余片段直接命中。
 */
export function WaveformClip({ asset, clip, pixelsPerSecond, color }: WaveformClipProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [cacheState, setCacheState] = useState<'loading' | 'cached' | 'rebuilt' | 'error'>('loading');

  const widthPixels = Math.max(20, clip.duration * pixelsPerSecond);

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
    const key = waveformKey(asset, clip, pixelsPerSecond, widthPixels);

    const renderPeaks = (peaks: number[], duration: number) => {
      if (disposed) return;
      wavesurfer.load(sourceUrl, [peaks], duration).catch(() => {
        if (!disposed) {
          container.dataset.error = '波形不可用';
          setCacheState('error');
        }
      });
    };

    const cached = readWaveformCache(key);
    if (cached) {
      setCacheState('cached');
      renderPeaks(cached.peaks, cached.duration || clip.duration);
    } else {
      setCacheState('loading');
      let cancelled = false;
      audioEngine
        .getBuffer(asset)
        .then((buffer) => {
          if (cancelled || disposed) return;
          const { peaks, sampleRate } = extractPeaks(
            buffer,
            clip.offset,
            clip.duration,
            widthPixels,
          );
          writeWaveformCache(key, {
            peaks,
            duration: clip.duration,
            sampleRate,
            savedAt: Date.now(),
          });
          setCacheState('rebuilt');
          renderPeaks(peaks, clip.duration);
        })
        .catch(() => {
          if (!disposed && !cancelled) {
            // 解码失败时退回 wavesurfer 自行加载。
            wavesurfer.load(sourceUrl).catch(() => undefined);
            setCacheState('error');
          }
        });
    }

    return () => {
      disposed = true;
      wavesurfer.destroy();
    };
  }, [
    asset,
    clip,
    clip.offset,
    clip.duration,
    clip.revision,
    clip.activeTakeNo,
    color,
    pixelsPerSecond,
    widthPixels,
  ]);

  return (
    <div className="waveform-clip" aria-label={`${clip.name} 波形`}>
      <div
        className="waveform-canvas"
        ref={containerRef}
        data-waveform={cacheState}
        title={
          cacheState === 'cached'
            ? '波形命中缓存'
            : cacheState === 'rebuilt'
              ? '波形已按当前边界重算'
              : '正在重算波形…'
        }
        style={{
          width: `${widthPixels}px`,
        }}
      />
    </div>
  );
}
