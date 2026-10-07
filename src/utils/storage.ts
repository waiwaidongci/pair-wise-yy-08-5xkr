/**
 * localStorage 容量预检。录音素材以 base64 dataURL 存进工程，叠加几个 take
 * 很容易撞上浏览器 5MB 配额；因此在接受新 take 之前先用真实大小探测一次，
 * 拒绝时由调用方保留录音本体并列入“未保存项”，而不是让持久化静默失败。
 */

export const PROJECT_STORAGE_KEY = 'pair-wise-yy-08-studio';
export const WAVEFORM_STORAGE_KEY = 'pair-wise-yy-08-waveforms-v1';
/** 预留：波形缓存、其他页签数据等，工程本体不允许吃满整个配额。 */
const SAFETY_HEADROOM = 250_000;
/** 主流浏览器 localStorage 单源约 5MB；保守按 4.6MB 作为本工程可用上限。 */
const LOCAL_STORAGE_LIMIT = 4_600_000;

export class StorageQuotaError extends Error {
  constructor(
    message: string,
    readonly required: number,
    readonly limit: number,
  ) {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22)
  );
}

export { isQuotaError };

function measureLocalStorage(): { total: number; projectEntry: number } {
  let total = 0;
  let projectEntry = 0;
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      const length = key.length + (localStorage.getItem(key)?.length ?? 0);
      total += length;
      if (key === PROJECT_STORAGE_KEY) projectEntry = length;
    }
  } catch {
    // 隐私模式等场景下 localStorage 可能不可读，交由实际写入探测判断。
  }
  return { total, projectEntry };
}

/**
 * 容量预检。工程键是覆盖写入而非新增，因此：
 * 写入后总占用 = 现有总占用 − 旧工程条目 + 新工程大小，必须低于安全上限。
 * @param requiredBytes 写入新工程后预计占用的 UTF-16 字符数
 */
export function assertStorageCapacity(requiredBytes: number): void {
  const { total, projectEntry } = measureLocalStorage();
  const projectedTotal = total - projectEntry + Math.ceil(requiredBytes * 1.02);
  if (projectedTotal + SAFETY_HEADROOM <= LOCAL_STORAGE_LIMIT) return;
  const shortage = projectedTotal + SAFETY_HEADROOM - LOCAL_STORAGE_LIMIT;
  throw new StorageQuotaError(
    `素材库剩余空间不足：本次至少还需要 ${formatBytes(shortage)} 空闲空间，请先导出工程并清理旧 take 后重试。`,
    requiredBytes,
    LOCAL_STORAGE_LIMIT,
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** 工程写入 localStorage 时吞掉配额异常，避免整页状态更新崩溃。 */
export function safeStorageSet(name: string, value: string): void {
  try {
    localStorage.setItem(name, value);
  } catch (error) {
    if (isQuotaError(error)) {
      console.warn('[WaveForge] localStorage 写入失败（配额不足），未保存录音已在界面列出。');
      return;
    }
    console.warn('[WaveForge] localStorage 写入失败：', error);
  }
}
