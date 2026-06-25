import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class InitiateFacebookOAuthDto {
  @ApiProperty({ description: 'Tên gợi nhớ cho credential Facebook' })
  @IsNotEmpty()
  @IsString()
  friendlyName: string;

  @ApiPropertyOptional({ description: 'Mục đích sử dụng' })
  @IsOptional()
  @IsString()
  purpose?: string;

  @ApiPropertyOptional({ description: 'Ghi chú thêm' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'ID Credential (dùng cho re-auth/sync)' })
  @IsUUID()
  @IsOptional()
  credentialId?: string;
}
