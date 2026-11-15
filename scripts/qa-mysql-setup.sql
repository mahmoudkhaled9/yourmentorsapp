-- One-time setup of the two QA accounts used by `npm run test:mysql`. Run it yourself as a MySQL administrator:
--     mysql -u root -p < scripts/qa-mysql-setup.sql
-- BEFORE running: replace both <...> placeholders with two DIFFERENT strong passwords (e.g. `npm run gen-secret`), then
-- put the same values in yourmentorsapp/.env.test (copy .env.test.example). Never commit .env.test.
--
-- Nothing here touches the production database `mentors_crm` or the production account `mentors_user`:
--   mentors_qa_admin  may only CREATE / DROP databases named mentors_crm_test_<...>. Used by the runner, never by tests.
--   mentors_qa        may only work INSIDE databases named mentors_crm_test_<...>. The only account the tests receive.
-- The underscores are escaped (\_) so the pattern cannot match other names; `%` is the wildcard. This relies on
-- partial_revokes = OFF (checked on this server: OFF). MySQL 9 reports database wildcards in GRANT as deprecated but
-- still applies them; if that changes, the runner's isolation check fails loudly instead of running unprotected.

CREATE USER IF NOT EXISTS 'mentors_qa_admin'@'127.0.0.1' IDENTIFIED BY '<qa-admin-password>';
GRANT CREATE, DROP ON `mentors\_crm\_test\_%`.* TO 'mentors_qa_admin'@'127.0.0.1';

CREATE USER IF NOT EXISTS 'mentors_qa'@'127.0.0.1' IDENTIFIED BY '<qa-test-password>';
-- what the app's migrations and the tests need inside the temporary database (tables, indexes, data)
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES
  ON `mentors\_crm\_test\_%`.* TO 'mentors_qa'@'127.0.0.1';

-- Check (expect only the lines above, nothing on *.* except USAGE, nothing on `mentors_crm`):
SHOW GRANTS FOR 'mentors_qa_admin'@'127.0.0.1';
SHOW GRANTS FOR 'mentors_qa'@'127.0.0.1';

-- To undo:  DROP USER 'mentors_qa_admin'@'127.0.0.1', 'mentors_qa'@'127.0.0.1';
