-- AlterTable
ALTER TABLE "business" ADD COLUMN     "idleSignOutMinutes" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "lastActiveAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The automatic sign-out time must stay between 5 minutes and 8 hours.
ALTER TABLE "business"
  ADD CONSTRAINT "business_idle_sign_out_minutes_check"
  CHECK ("idleSignOutMinutes" BETWEEN 5 AND 480);
