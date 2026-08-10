import {
  IsBoolean,
  IsDefined,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdateWatermarkDto {
  @IsDefined()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsBoolean()
  watermarkEnabled!: boolean | null;

  @IsOptional()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @MaxLength(500)
  watermarkTemplate?: string | null;
}
