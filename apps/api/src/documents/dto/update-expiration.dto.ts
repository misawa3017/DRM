import { IsDefined, IsISO8601, ValidateIf } from 'class-validator';

export class UpdateExpirationDto {
  @IsDefined()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsISO8601({ strict: true })
  expiresAt!: string | null;
}
