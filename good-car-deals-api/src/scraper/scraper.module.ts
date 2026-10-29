import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpService } from './http.service';
import { ApiClientService } from './api-client.service';
import { HtmlParserService } from './html-parser.service';
import { ScraperService } from './scraper.service';

@Module({
  imports: [ConfigModule],
  providers: [HttpService, ApiClientService, HtmlParserService, ScraperService],
  exports: [ScraperService, HttpService, HtmlParserService, ApiClientService],
})
export class ScraperModule {}
