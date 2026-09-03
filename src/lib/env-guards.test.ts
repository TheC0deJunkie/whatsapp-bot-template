import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isProduction,
  webhookValidationSkipped,
  debugRoutesEnabled,
} from './env-guards.js';

const KEYS = ['NODE_ENV', 'TWILIO_SKIP_WEBHOOK_VALIDATION', 'ENABLE_DEBUG_ROUTES'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('env-guards', () => {
  it('isProduction only for the literal "production"', () => {
    process.env.NODE_ENV = 'production';
    expect(isProduction()).toBe(true);
    process.env.NODE_ENV = 'development';
    expect(isProduction()).toBe(false);
    delete process.env.NODE_ENV;
    expect(isProduction()).toBe(false);
  });

  describe('webhookValidationSkipped', () => {
    it('false by default — even with NODE_ENV unset (fail-safe)', () => {
      delete process.env.NODE_ENV;
      delete process.env.TWILIO_SKIP_WEBHOOK_VALIDATION;
      expect(webhookValidationSkipped()).toBe(false);
    });

    it('false in development without the explicit opt-in', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.TWILIO_SKIP_WEBHOOK_VALIDATION;
      expect(webhookValidationSkipped()).toBe(false);
    });

    it('true only with TWILIO_SKIP_WEBHOOK_VALIDATION=true AND non-production', () => {
      process.env.NODE_ENV = 'development';
      process.env.TWILIO_SKIP_WEBHOOK_VALIDATION = 'true';
      expect(webhookValidationSkipped()).toBe(true);
    });

    it('never true in production, even with the flag set', () => {
      process.env.NODE_ENV = 'production';
      process.env.TWILIO_SKIP_WEBHOOK_VALIDATION = 'true';
      expect(webhookValidationSkipped()).toBe(false);
    });

    it('requires the literal "true" (not "1")', () => {
      process.env.NODE_ENV = 'development';
      process.env.TWILIO_SKIP_WEBHOOK_VALIDATION = '1';
      expect(webhookValidationSkipped()).toBe(false);
    });
  });

  describe('debugRoutesEnabled', () => {
    it('false by default in development', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.ENABLE_DEBUG_ROUTES;
      expect(debugRoutesEnabled()).toBe(false);
    });

    it('true with ENABLE_DEBUG_ROUTES=true in non-production', () => {
      process.env.NODE_ENV = 'development';
      process.env.ENABLE_DEBUG_ROUTES = 'true';
      expect(debugRoutesEnabled()).toBe(true);
    });

    it('never true in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.ENABLE_DEBUG_ROUTES = 'true';
      expect(debugRoutesEnabled()).toBe(false);
    });
  });
});
