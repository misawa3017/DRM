import { PDFDocument } from 'pdf-lib';
import { Readable } from 'stream';
import { WatermarkService } from './watermark.service';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe('WatermarkService', () => {
  it('在記憶體中為每一頁加入浮水印，並回傳有效 PDF', async () => {
    const source = await PDFDocument.create();
    source.addPage([400, 600]);
    source.addPage([400, 600]);
    const original = Buffer.from(await source.save());

    const result = await readAll(
      await new WatermarkService().apply(
        Readable.from(original),
        'testuser@example.com | 2026-08-10T00:00:00.000Z | 127.0.0.1',
      ),
    );

    expect(result.equals(original)).toBe(false);
    const parsed = await PDFDocument.load(result);
    expect(parsed.getPageCount()).toBe(2);
  });

  it('支援繁體中文自訂浮水印', async () => {
    const source = await PDFDocument.create();
    source.addPage([400, 600]);

    const result = await readAll(
      await new WatermarkService().apply(
        Readable.from(Buffer.from(await source.save())),
        '機密文件｜user@example.com｜報告.pdf',
      ),
    );

    await expect(PDFDocument.load(result)).resolves.toBeDefined();
  });
});
