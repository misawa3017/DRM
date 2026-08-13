import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { triggerBlobDownload } from '../../src/lib/download';

describe('triggerBlobDownload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:download'), revokeObjectURL: vi.fn() });
  });

  afterEach(() => vi.useRealTimers());

  it('下載開始後才延後釋放 Blob URL', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    triggerBlobDownload(new Blob(['內容']), '測試.xlsx');

    expect(click).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download');
    click.mockRestore();
  });
});
