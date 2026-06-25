import { Injectable, Logger, LoggerService, LogLevel } from '@nestjs/common';

@Injectable()
export class AppLogger implements LoggerService {
  private readonly logger = new Logger();
  private contextName = 'App';

  setContext(context: string): void {
    this.contextName = context;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.log(message, this.formatContext(optionalParams));
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.error(message, this.formatContext(optionalParams));
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.warn(message, this.formatContext(optionalParams));
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.debug(message, this.formatContext(optionalParams));
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.verbose(message, this.formatContext(optionalParams));
  }

  setLogLevels?(levels: LogLevel[]): void {
    this.logger.localInstance?.setLogLevels?.(levels);
  }

  private formatContext(optionalParams: unknown[]): string | undefined {
    if (optionalParams.length === 0) {
      return this.contextName;
    }
    const last = optionalParams[optionalParams.length - 1];
    return typeof last === 'string' ? last : this.contextName;
  }
}
