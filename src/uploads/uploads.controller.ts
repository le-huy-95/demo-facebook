import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { resolvePublicAssetUrl } from '../common/public-url.util';

interface UploadedFileResponse {
  url: string;
  filename: string;
  mimeType: string;
  size: number;
}

@Controller('uploads')
export class UploadsController {
  constructor(private readonly configService: ConfigService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      dest: 'uploads',
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Thiếu file upload');
    }

    const publicBaseUrl = this.configService.get<string>(
      'PUBLIC_BASE_URL',
      'http://localhost:3000',
    );
    const relativeUrl = `/uploads/${file.filename}`;
    const absoluteUrl = resolvePublicAssetUrl(relativeUrl, publicBaseUrl);

    const data: UploadedFileResponse = {
      url: absoluteUrl,
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    };

    return { statusCode: 201, data };
  }
}
