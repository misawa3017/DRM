import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { PermissionLevel, PrincipalType } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

export class GrantPermissionDto {
  @ApiProperty({ enum: PrincipalType, example: 'user' })
  @IsEnum(PrincipalType)
  principalType!: PrincipalType;

  @ApiProperty({
    example: 'c9aa5566-4e0c-4a17-9e08-fc4bd92c1bf1',
    description: '使用者 ID 或角色名稱，取決於 principalType',
  })
  @IsString()
  @IsNotEmpty()
  principalId!: string;

  @ApiProperty({ enum: PermissionLevel, example: 'read' })
  @IsEnum(PermissionLevel)
  permissionLevel!: PermissionLevel;
}
