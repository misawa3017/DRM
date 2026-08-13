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
