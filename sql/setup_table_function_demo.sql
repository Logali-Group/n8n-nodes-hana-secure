-- LAB TEMPLATE ONLY. Review and execute as the owner of a non-production TRAINING schema.
-- It assumes TRAINING.ORDERS already exists with the columns referenced below.
-- The n8n node itself remains read-only and never executes this DDL.

CREATE OR REPLACE FUNCTION "TRAINING"."GET_OPEN_ORDERS" (
	IN "P_COMPANY_CODE" NVARCHAR(4),
	IN "P_MIN_AMOUNT" DECIMAL(15, 2)
)
RETURNS TABLE (
	"ORDER_ID" NVARCHAR(20),
	"COMPANY_CODE" NVARCHAR(4),
	"CHANGED_AT" TIMESTAMP,
	"AMOUNT" DECIMAL(15, 2),
	"CURRENCY" NVARCHAR(3)
)
LANGUAGE SQLSCRIPT
SQL SECURITY INVOKER
AS
BEGIN
	RETURN
		SELECT
			"ORDER_ID",
			"COMPANY_CODE",
			"CHANGED_AT",
			"AMOUNT",
			"CURRENCY"
		FROM "TRAINING"."ORDERS"
		WHERE "COMPANY_CODE" = :P_COMPANY_CODE
			AND "STATUS" = 'OPEN'
			AND "AMOUNT" >= :P_MIN_AMOUNT;
END;

-- Suggested least-privilege grant, executed by an authorized administrator:
-- GRANT EXECUTE ON "TRAINING"."GET_OPEN_ORDERS" TO "N8N_HANA_READER";
-- Because SQL SECURITY INVOKER is used, grant the reader only the underlying SELECT rights
-- required by the function body as well.
