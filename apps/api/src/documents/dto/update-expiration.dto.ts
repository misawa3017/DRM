import { IsDefined, IsISO8601, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateExpirationDto {
  @ApiProperty({
    example: '2026-12-31T23:59:59.000Z',
    nullable: true,
    description: '到期時間；傳入 null 可取消到期限制',
  })
  @IsDefined()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsISO8601({ strict: true })
  expiresAt!: string | null;
}
