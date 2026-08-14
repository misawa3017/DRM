import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateDocumentDto {
  @ApiPropertyOptional({ example: '修訂後的年度預算.xlsx' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({ format: 'uuid', description: '新的上層資料夾 ID' })
  @IsOptional()
  @IsUUID()
  folderId?: string;
}
