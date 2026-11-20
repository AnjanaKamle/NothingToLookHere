-- Runs once, only when the data volume is first created.
-- A separate database for automated tests, so tests never touch development data.
CREATE DATABASE capstone_test;
