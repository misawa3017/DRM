import { IsBoolean, IsDefined, ValidateIf } from 'class-validator';

export class UpdateWatermarkDto {
  @IsDefined()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsBoolean()
  watermarkEnabled!: boolean | null;
}
