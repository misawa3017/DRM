import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { downloadResponseToFile, triggerBlobDownload } from '../../src/lib/download';

describe('triggerBlobDownload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:download'), revokeObjectURL: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('下載開始後才延後釋放 Blob URL', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    triggerBlobDownload(new Blob(['內容']), '測試.xlsx');

    expect(click).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download');
    click.mockRestore();
  });

  it('支援時將 response 串流直接寫入使用者選擇的檔案', async () => {
    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({ write: (chunk) => { chunks.push(chunk); } });
    const picker = vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(writable) });
    vi.stubGlobal('showSaveFilePicker', picker);
    const getResponse = vi.fn().mockResolvedValue(new Response('streamed-content'));

    await expect(downloadResponseToFile(getResponse, 'large.xlsx')).resolves.toBe(true);

    expect(picker).toHaveBeenCalledWith({ suggestedName: 'large.xlsx' });
    expect(getResponse).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(chunks[0])).toBe('streamed-content');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('使用者取消選擇檔案時不會開始下載', async () => {
    vi.stubGlobal('showSaveFilePicker', vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')));
    const getResponse = vi.fn();

    await expect(downloadResponseToFile(getResponse, 'cancel.xlsx')).resolves.toBe(false);
    expect(getResponse).not.toHaveBeenCalled();
  });
});
