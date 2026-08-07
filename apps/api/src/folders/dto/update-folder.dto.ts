import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class UpdateFolderDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}
