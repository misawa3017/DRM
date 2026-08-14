import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateFolderDto {
  @ApiPropertyOptional({ example: '2026 財務資料' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({ format: 'uuid', description: '新的父資料夾 ID' })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}
