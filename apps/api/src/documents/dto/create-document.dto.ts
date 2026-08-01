import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class CreateDocumentDto {
  @IsUUID()
  folderId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;
}
