import { createAttachmentContentDisposition } from './content-disposition';

describe('createAttachmentContentDisposition', () => {
  it('同時提供 ASCII fallback 與 RFC 5987 UTF-8 檔名', () => {
    expect(createAttachmentContentDisposition('機密報告 2026.pdf')).toBe(
      `attachment; filename="____ 2026.pdf"; filename*=UTF-8''%E6%A9%9F%E5%AF%86%E5%A0%B1%E5%91%8A%202026.pdf`,
    );
  });

  it('移除可能改變 HTTP header 結構的字元', () => {
    expect(createAttachmentContentDisposition('report\r\n".pdf')).toBe(
      `attachment; filename="report___.pdf"; filename*=UTF-8''report___.pdf`,
    );
  });
});
