import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpService } from './http.service';
import { ApiClientService } from './api-client.service';
import { ScraperService } from './scraper.service';

@Module({
  imports: [ConfigModule],
  providers: [HttpService, ApiClientService, ScraperService],
  exports: [ScraperService, HttpService, ApiClientService],
})
export class ScraperModule {}
