import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { SharesEditorController } from './shares-editor.controller';

describe('SharesEditorController', () => {
  it('OnlyOffice 回呼成功時回傳 200，避免文件服務將成功誤判為儲存失敗', () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, SharesEditorController.prototype.callback),
    ).toBe(HttpStatus.OK);
  });
});
