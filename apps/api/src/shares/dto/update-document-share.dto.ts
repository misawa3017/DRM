import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateDocumentShareDto {
  @ApiPropertyOptional({ enum: ['view', 'edit'], example: 'edit' })
  @IsOptional()
  @IsIn(['view', 'edit'])
  accessLevel?: 'view' | 'edit';

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 720,
    example: 48,
    description: '從現在起重新計算的有效時數',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  durationHours?: number;
}
