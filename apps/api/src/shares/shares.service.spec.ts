import { createHmac } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { SharesService } from './shares.service';

function createCallbackToken(payload: object, secret: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`;
}

describe('SharesService OnlyOffice callback verification', () => {
  const secret = 'test-onlyoffice-secret';
  const shareId = 'share-1';
  const verifier = new SharesService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  ) as unknown as {
    createEditorToken: (
      id: string,
      recipientId: string,
      purpose: 'content' | 'callback',
      expiresAt: Date,
    ) => string;
    verifyEditorToken: (
      id: string,
      token: string,
      purpose: 'content' | 'callback',
    ) => string;
    verifyOnlyOfficeCallback: (
      id: string,
      body: { status?: number; url?: string; token?: string },
    ) => void;
  };

  beforeEach(() => {
    process.env.ONLYOFFICE_JWT_SECRET = secret;
  });

  it('接受 OnlyOffice 簽署且與回呼內容相符的 JWT', () => {
    const url = 'https://office.drm.apower.lan/cache/saved.xlsx';
    const token = createCallbackToken(
      { key: `${shareId}-123`, status: 2, url, exp: Math.floor(Date.now() / 1000) + 60 },
      secret,
    );
    expect(() =>
      verifier.verifyOnlyOfficeCallback(shareId, { status: 2, url, token }),
    ).not.toThrow();
  });

  it('拒絕缺少或被竄改的 OnlyOffice JWT', () => {
    expect(() => verifier.verifyOnlyOfficeCallback(shareId, { status: 2 })).toThrow(
      ForbiddenException,
    );
    const token = createCallbackToken(
      { key: `${shareId}-123`, status: 2, url: 'https://office.drm.apower.lan/cache/saved.xlsx' },
      secret,
    );
    expect(() =>
      verifier.verifyOnlyOfficeCallback(shareId, {
        status: 2,
        url: 'https://office.drm.apower.lan/cache/other.xlsx',
        token,
      }),
    ).toThrow(ForbiddenException);
  });

  it('OnlyOffice 回呼權杖有效至分享結束，且不能用於下載文件', () => {
    const shareExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = verifier.createEditorToken(
      shareId,
      'recipient-1',
      'callback',
      shareExpiresAt,
    );

    expect(verifier.verifyEditorToken(shareId, token, 'callback')).toBe('recipient-1');
    expect(() => verifier.verifyEditorToken(shareId, token, 'content')).toThrow(
      ForbiddenException,
    );
  });
});
