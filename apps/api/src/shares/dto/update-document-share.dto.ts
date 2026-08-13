import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateDocumentShareDto {
  @IsOptional()
  @IsIn(['view', 'edit'])
  accessLevel?: 'view' | 'edit';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  durationHours?: number;
}
