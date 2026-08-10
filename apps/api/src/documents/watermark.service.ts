import { Injectable } from '@nestjs/common';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { Readable } from 'stream';

@Injectable()
export class WatermarkService {
  async apply(stream: Readable, text: string): Promise<Readable> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }

    const pdf = await PDFDocument.load(Buffer.concat(chunks), { updateMetadata: false });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();
      const fontSize = Math.max(12, Math.min(22, width / 28));
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      page.drawText(text, {
        x: Math.max(12, (width - textWidth) / 2),
        y: height / 2,
        size: fontSize,
        font,
        color: rgb(0.45, 0.45, 0.45),
        opacity: 0.28,
        rotate: degrees(35),
      });
    }

    return Readable.from(Buffer.from(await pdf.save()));
  }
}
