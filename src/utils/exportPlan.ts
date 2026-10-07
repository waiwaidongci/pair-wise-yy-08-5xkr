import type { AudioClip, AudioProject, ExportPlan, ExportPlanClip } from '../types/audio';
import { activeTakeOf } from './takes';

/**
 * 导出预案：把“当前要导出什么”固化成可核对的快照。循环区间或片段边界一变，
 * 受牵连片段 revision 自增，签名即改变；界面据此提示重新计算导出预案。
 */
export function computeExportPlan(project: AudioProject): ExportPlan {
  const rangeStart = project.loopEnabled ? project.loopStart : 0;
  const rangeEnd = project.loopEnabled
    ? project.loopEnd
    : Math.max(
        ...project.tracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.duration)),
        1,
      );
  const clips: ExportPlanClip[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.start >= rangeEnd || clip.start + clip.duration <= rangeStart) continue;
      const take = activeTakeOf(clip, project.assets);
      clips.push({
        trackId: track.id,
        clipId: clip.id,
        assetId: take.assetId,
        activeTakeNo: take.no,
        start: Number(clip.start.toFixed(4)),
        duration: Number(clip.duration.toFixed(4)),
        offset: Number(clip.offset.toFixed(4)),
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
        effect: clip.effect,
        effectAmount: clip.effectAmount,
        revision: clip.revision ?? 0,
      });
    }
  }
  clips.sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId));
  return {
    signature: signatureFor(rangeStart, rangeEnd, project.tracks.map((t) => t.id).join(','), clips),
    rangeStart,
    rangeEnd,
    clips,
    computedAt: Date.now(),
  };
}

export function rangeLabel(plan: Pick<ExportPlan, 'rangeStart' | 'rangeEnd'>): string {
  return `${plan.rangeStart.toFixed(2)}s – ${plan.rangeEnd.toFixed(2)}s`;
}

function signatureFor(
  rangeStart: number,
  rangeEnd: number,
  trackIds: string,
  clips: ExportPlanClip[],
): string {
  const body = JSON.stringify({
    range: [rangeStart.toFixed(3), rangeEnd.toFixed(3)],
    tracks: trackIds,
    clips: clips.map((clip) => [
      clip.clipId,
      clip.assetId,
      clip.activeTakeNo,
      clip.revision,
      clip.start,
      clip.duration,
      clip.offset,
      clip.effect,
      clip.effectAmount,
    ]),
  });
  return cyrb53(body).toString(16);
}

function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ char, 2654435761);
    h2 = Math.imul(h2 ^ char, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)) >>> 0;
}

/** 供导出 JSON 使用：当前选中 take 的实际声音列表（未选中的 take 也仍在 assets 里）。 */
export function describePlan(plan: ExportPlan, project: AudioProject): string {
  const lines = plan.clips.map((entry) => {
    const clip = findClip(project, entry.clipId);
    return `  · ${clip?.name ?? entry.clipId} take ${entry.activeTakeNo} @ ${entry.start.toFixed(2)}s (${entry.duration.toFixed(2)}s, rev ${entry.revision})`;
  });
  return [
    `WaveForge 导出预案`,
    `区间：${rangeLabel(plan)}`,
    `片段数：${plan.clips.length}`,
    `签名：${plan.signature}`,
    ...lines,
  ].join('\n');
}

function findClip(project: AudioProject, clipId: string): AudioClip | undefined {
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip) return clip;
  }
  return undefined;
}
