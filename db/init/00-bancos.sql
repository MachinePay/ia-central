-- Bancos extras no mesmo Postgres (roda so na primeira subida; idempotente)
SELECT 'CREATE DATABASE evolution' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'evolution') \gexec
