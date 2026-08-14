import { IsNotEmpty, IsString, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDocumentDto {
  @ApiProperty({ format: 'uuid', description: '目標資料夾 ID' })
  @IsUUID()
  folderId!: string;

  @ApiProperty({ example: '年度預算.xlsx', description: '顯示於系統的文件名稱' })
  @IsString()
  @IsNotEmpty()
  name!: string;
}
