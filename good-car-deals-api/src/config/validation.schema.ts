import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

export class EnvironmentVariables {
  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  SCRAPER_TARGET_URL!: string;

  @IsString()
  @IsNotEmpty()
  SCRAPER_BRAND!: string;

  @IsString()
  @IsNotEmpty()
  SCRAPER_MODEL!: string;

  @IsString()
  @IsNotEmpty()
  SCRAPER_CRON_SCHEDULE!: string;

  @IsOptional()
  @IsString()
  SCRAPER_PROXY_URL?: string;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });
  if (errors.length > 0) {
    throw new Error(`Environment validation failed: ${errors.toString()}`);
  }
  return validatedConfig;
}
