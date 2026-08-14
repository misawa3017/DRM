import { IsBoolean, IsDefined, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateWatermarkDto {
  @ApiProperty({
    example: true,
    nullable: true,
    description: '是否啟用浮水印；傳入 null 可清除設定',
  })
  @IsDefined()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsBoolean()
  watermarkEnabled!: boolean | null;

  @ApiPropertyOptional({ example: '機密文件 — {{user.email}}', nullable: true, maxLength: 500 })
  @IsOptional()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @MaxLength(500)
  watermarkTemplate?: string | null;
}
