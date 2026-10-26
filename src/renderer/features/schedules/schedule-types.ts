/** The not-yet-confirmed intent the page is parked on, with its resolution actions. */
export interface SchedulePendingNotice {
  /** What the parked operation was called. */
  context: string;
  reason: string;
  checking: boolean;
  onVerify: () => void;
  onResend: () => void;
}
