import { Module } from '@nestjs/common';
import { DealClassifierService } from './deal-classifier.service';

@Module({
  providers: [DealClassifierService],
  exports: [DealClassifierService],
})
export class AnalysisModule {}
