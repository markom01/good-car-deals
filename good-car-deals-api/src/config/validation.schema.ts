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

  /** Optional comma-separated CORS allowlist (unset = allow all). */
  @IsOptional()
  @IsString()
  CORS_ORIGIN?: string;

  /** VAPID public key for web push (optional — push disabled if unset). */
  @IsOptional()
  @IsString()
  VAPID_PUBLIC_KEY?: string;

  /** VAPID private key for web push (optional — push disabled if unset). */
  @IsOptional()
  @IsString()
  VAPID_PRIVATE_KEY?: string;

  /** mailto: address for VAPID identification (optional — push disabled if unset). */
  @IsOptional()
  @IsString()
  VAPID_EMAIL?: string;

  /** Enable push delivery (optional — defaults false). */
  @IsOptional()
  @IsString()
  PUSH_ENABLED?: string;
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
