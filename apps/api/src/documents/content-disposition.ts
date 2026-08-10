function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function createAttachmentContentDisposition(fileName: string): string {
  // 避免檔名中的控制字元或引號改變 HTTP header 結構。
  const safeFileName = fileName.replace(/[\r\n"]/g, '_');
  const asciiFallback = safeFileName.replace(/[^\x20-\x7E]/g, '_');

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987Value(safeFileName)}`;
}
