import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class FacebookOAuthCallbackDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  code?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  state?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  error?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  error_description?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  error_reason?: string;

  /** Facebook gửi kèm khi user từ chối / hủy OAuth (vd. error_code=200). */
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  error_code?: string;

  /** Facebook gửi kèm khi user đóng popup (vd. action=cancel). */
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  action?: string;
}
