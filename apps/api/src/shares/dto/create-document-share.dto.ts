import { IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class MaskRuleDto {
  @IsString()
  @IsNotEmpty()
  sheetName!: string;

  @IsString()
  @IsNotEmpty()
  header!: string;

  @IsIn(['redact', 'partial'])
  mode!: 'redact' | 'partial';
}

export class CreateDocumentShareDto {
  @IsString()
  @IsNotEmpty()
  recipientId!: string;

  @IsIn(['view', 'edit'])
  accessLevel!: 'view' | 'edit';

  @IsInt()
  @Min(1)
  @Max(720)
  durationHours!: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MaskRuleDto)
  maskRules?: MaskRuleDto[];
}
