export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    let message = `Request to ${path} failed with status ${response.status}`;
    const contentType = response.headers?.get('content-type');
    if (contentType?.includes('application/json')) {
      const body = await response.json().catch(() => null) as { message?: string | string[] } | null;
      if (typeof body?.message === 'string') message = body.message;
      if (Array.isArray(body?.message)) message = body.message.join('、');
    }
    throw new ApiError(response.status, message);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json() as Promise<T>;
  }
  return undefined as T;
}

export function friendlyErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return '請求內容有誤，請檢查後再試';
    if (error.status === 403) return '你沒有存取這個項目的權限';
    if (error.status === 404) return '找不到這個項目';
    if (error.status === 409) return '這個名稱已經被使用了';
    if (error.status === 410) return '這份文件已到期，請聯絡管理者延長期限';
    if (error.status === 425) return '文件預覽仍在處理中，請稍後再試';
  }
  return '發生錯誤，請稍後再試';
}

export function moveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    return '無法移動到這個位置';
  }
  return friendlyErrorMessage(error);
}
