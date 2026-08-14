import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateFolderDto {
  @ApiProperty({ example: '財務部' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ format: 'uuid', description: '父資料夾 ID；省略時建立根資料夾' })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}
