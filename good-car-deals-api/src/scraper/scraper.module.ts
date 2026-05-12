import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpService } from './http.service';
import { HtmlParserService } from './html-parser.service';
import { ScraperService } from './scraper.service';

@Module({
  imports: [ConfigModule],
  providers: [HttpService, HtmlParserService, ScraperService],
  exports: [ScraperService, HttpService, HtmlParserService],
})
export class ScraperModule {}
