const MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN = 3;
const MAX_RECENT_AUTO_REVIEW_DENIALS_PER_TURN = 10;
const AUTO_REVIEW_DENIAL_WINDOW_SIZE = 50;

export interface GuardianCircuitBreakerInterrupt {
  action: "interrupt";
  consecutiveDenials: number;
  recentDenials: number;
}

export interface GuardianCircuitBreakerContinue {
  action: "continue";
}

export type GuardianCircuitBreakerAction =
  | GuardianCircuitBreakerContinue
  | GuardianCircuitBreakerInterrupt;

export class GuardianDenialCircuitBreaker {
  private consecutiveDenials = 0;
  private recentDenials: boolean[] = [];
  private interrupted = false;

  reset(): void {
    this.consecutiveDenials = 0;
    this.recentDenials = [];
    this.interrupted = false;
  }

  recordDenial(): GuardianCircuitBreakerAction {
    this.consecutiveDenials += 1;
    this.recordRecent(true);
    const recentDenials = this.countRecentDenials();

    if (
      this.interrupted ||
      this.consecutiveDenials >= MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN ||
      recentDenials >= MAX_RECENT_AUTO_REVIEW_DENIALS_PER_TURN
    ) {
      this.interrupted = true;
      return {
        action: "interrupt",
        consecutiveDenials: this.consecutiveDenials,
        recentDenials,
      };
    }

    return { action: "continue" };
  }

  recordNonDenial(): void {
    this.consecutiveDenials = 0;
    this.recordRecent(false);
  }

  isInterrupted(): boolean {
    return this.interrupted;
  }

  interruptMessage(): string {
    const recentDenials = this.countRecentDenials();
    return `Automatic approval review rejected too many requests this turn (${this.consecutiveDenials} consecutive, ${recentDenials} in the last ${AUTO_REVIEW_DENIAL_WINDOW_SIZE} reviews). Stop and ask the user for guidance instead of trying another workaround.`;
  }

  private recordRecent(denied: boolean): void {
    this.recentDenials.push(denied);
    if (this.recentDenials.length > AUTO_REVIEW_DENIAL_WINDOW_SIZE) {
      this.recentDenials.shift();
    }
  }

  private countRecentDenials(): number {
    return this.recentDenials.filter(Boolean).length;
  }
}

export function shouldCountGuardianDenial(reason: string): boolean {
  return !/(timed out|cancelled|aborted|spawn failed|non-json|exited \d+)/i.test(reason);
}
