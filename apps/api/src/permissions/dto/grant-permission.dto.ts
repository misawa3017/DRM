import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { PermissionLevel, PrincipalType } from '@prisma/client';

export class GrantPermissionDto {
  @IsEnum(PrincipalType)
  principalType!: PrincipalType;

  @IsString()
  @IsNotEmpty()
  principalId!: string;

  @IsEnum(PermissionLevel)
  permissionLevel!: PermissionLevel;
}
