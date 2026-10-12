-- C67: a payment method that was never used can be deleted. One that has taken a payment,
-- a refund or a repayment is still protected by those tables' foreign keys (ON DELETE
-- RESTRICT); the "Cash" every business starts with can never be deleted.
DROP TRIGGER `payment_method_no_delete`;
CREATE TRIGGER `payment_method_no_delete` BEFORE DELETE ON `payment_method`
  FOR EACH ROW
  IF OLD.`builtIn` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The built-in Cash payment method cannot be deleted.';
  END IF;
