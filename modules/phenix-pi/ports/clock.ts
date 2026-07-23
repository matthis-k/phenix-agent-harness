export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};
