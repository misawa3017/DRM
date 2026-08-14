/**
 * 觸發瀏覽器 Blob 下載，並延後釋放 URL，避免 Firefox/Safari 尚未開始下載
 * 時物件 URL 已失效。
 */
export function triggerBlobDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

interface FileSystemFileHandleLike {
  createWritable: () => Promise<WritableStream<Uint8Array>>;
}

type SaveFilePicker = (options: { suggestedName: string }) => Promise<FileSystemFileHandleLike>;

function getSaveFilePicker(): SaveFilePicker | undefined {
  return (window as typeof window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
}

function isUserCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * 在支援 File System Access API 的瀏覽器中直接將 HTTP response 串流寫入磁碟，
 * 避免大型文件完整保留在 JS Blob 記憶體。Firefox/Safari 則安全地退回 Blob 下載。
 * 回傳 false 表示使用者取消選擇儲存位置。
 */
export async function downloadResponseToFile(
  getResponse: () => Promise<Response>,
  fileName: string,
): Promise<boolean> {
  const picker = getSaveFilePicker();
  if (!picker) {
    const response = await getResponse();
    triggerBlobDownload(await response.blob(), fileName);
    return true;
  }

  let writable: WritableStream<Uint8Array> | undefined;
  try {
    // 必須在按鈕 click 的使用者手勢仍有效時先開啟選檔視窗；之後才開始網路下載。
    const handle = await picker({ suggestedName: fileName });
    writable = await handle.createWritable();
    const response = await getResponse();
    if (!response.body) throw new Error('Download response has no body');
    await response.body.pipeTo(writable);
    return true;
  } catch (error) {
    await writable?.abort(error).catch(() => undefined);
    if (isUserCancelled(error)) return false;
    throw error;
  }
}
