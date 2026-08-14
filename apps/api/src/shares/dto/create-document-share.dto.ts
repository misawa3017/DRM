import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MaskRuleDto {
  @ApiProperty({ example: '員工資料' })
  @IsString()
  @IsNotEmpty()
  sheetName!: string;

  @ApiProperty({ example: '身分證字號', description: '要遮蔽的欄位標題' })
  @IsString()
  @IsNotEmpty()
  header!: string;

  @ApiProperty({ enum: ['redact', 'partial'], example: 'redact' })
  @IsIn(['redact', 'partial'])
  mode!: 'redact' | 'partial';
}

export class CreateDocumentShareDto {
  @ApiProperty({ format: 'uuid', description: '收件者使用者 ID' })
  @IsString()
  @IsNotEmpty()
  recipientId!: string;

  @ApiProperty({ enum: ['view', 'edit'], example: 'view' })
  @IsIn(['view', 'edit'])
  accessLevel!: 'view' | 'edit';

  @ApiProperty({ minimum: 1, maximum: 720, example: 24, description: '分享有效時數' })
  @IsInt()
  @Min(1)
  @Max(720)
  durationHours!: number;

  @ApiPropertyOptional({
    type: () => MaskRuleDto,
    isArray: true,
    description: 'Excel 欄位遮蔽規則；有遮蔽規則時僅支援唯讀分享',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MaskRuleDto)
  maskRules?: MaskRuleDto[];
}
