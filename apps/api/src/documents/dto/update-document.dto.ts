import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class UpdateDocumentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsUUID()
  folderId?: string;
}
